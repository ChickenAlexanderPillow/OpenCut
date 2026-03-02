"use client";

import { useTimelineStore } from "@/stores/timeline-store";
import { useActionHandler } from "@/hooks/actions/use-action-handler";
import { useEditor } from "../use-editor";
import { useElementSelection } from "../timeline/element/use-element-selection";
import { getElementsAtTime } from "@/lib/timeline";
import { toast } from "sonner";
import { TracksSnapshotCommand } from "@/lib/commands/timeline";
import {
	applySmartCutsToTracks,
	computeSmartCutFromTranscriptForElement,
} from "@/lib/editing/smart-cut";
import {
	buildTranscriptionFingerprint,
	findLatestValidTranscriptionCacheEntry,
	getTranscriptionCacheKey,
} from "@/lib/transcription/cache";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	TRANSCRIPT_CACHE_VERSION,
} from "@/constants/transcription-constants";
import { extractTimelineAudio } from "@/lib/media/mediabunny";
import { decodeAudioToFloat32 } from "@/lib/media/audio";
import { transcriptionService } from "@/services/transcription/service";
import type { TimelineTrack, TextElement } from "@/types/timeline";
import { useTranscriptionStatusStore } from "@/stores/transcription-status-store";
import { useProjectProcessStore } from "@/stores/project-process-store";
import { useClipGenerationStore } from "@/stores/clip-generation-store";
import { buildClipCandidatesFromTranscript } from "@/lib/clips/candidate-builder";
import { selectTopCandidatesWithQualityGate } from "@/lib/clips/scoring";
import {
	clipTranscriptSegmentsForWindow,
	getOrCreateClipTranscriptForAsset,
} from "@/lib/clips/transcript";
import { buildCaptionChunks } from "@/lib/transcription/caption";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { getMainTrack } from "@/lib/timeline/track-utils";
import type { MediaAsset } from "@/types/assets";
import { DEFAULT_BLEND_MODE, DEFAULT_OPACITY, DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { DEFAULT_CANVAS_SIZE, DEFAULT_FPS } from "@/constants/project-constants";
import { getVideoInfo } from "@/lib/media/mediabunny";

const MIN_VIRAL_CLIP_SCORE = 60;
const MAX_VIRAL_CLIP_COUNT = 5;
const CLIP_SCORING_TRANSCRIPT_MAX_CHARS = 20000;
const CLIP_SCORING_TIMEOUT_MS = 60000;

function truncateTranscriptForScoring({
	transcript,
}: {
	transcript: string;
}): string {
	if (transcript.length <= CLIP_SCORING_TRANSCRIPT_MAX_CHARS) {
		return transcript;
	}
	return `${transcript.slice(0, CLIP_SCORING_TRANSCRIPT_MAX_CHARS)}\n[Transcript truncated for scoring request]`;
}

function resolveClipScoringApiCandidates(): string[] {
	const fallbackBase = process.env.NEXT_PUBLIC_SITE_URL?.trim();
	const candidates: string[] = [];

	if (typeof window !== "undefined") {
		const origin = window.location.origin;
		if (origin.startsWith("http://") || origin.startsWith("https://")) {
			candidates.push(`${origin}/api/clips/score`);
			candidates.push("/api/clips/score");
		} else {
			candidates.push("/api/clips/score");
			if (fallbackBase) {
				candidates.push(`${fallbackBase.replace(/\/$/, "")}/api/clips/score`);
			}
		}
	} else {
		candidates.push("/api/clips/score");
		if (fallbackBase) {
			candidates.push(`${fallbackBase.replace(/\/$/, "")}/api/clips/score`);
		}
	}

	return Array.from(new Set(candidates));
}

async function fetchScoredCandidates({
	transcript,
	candidates,
}: {
	transcript: string;
	candidates: Array<{
		id: string;
		startTime: number;
		endTime: number;
		duration: number;
		transcriptSnippet: string;
		localScore: number;
	}>;
}): Promise<Response> {
	const endpoints = resolveClipScoringApiCandidates();
	let lastNetworkError: Error | null = null;

	for (const endpoint of endpoints) {
		const controller = new AbortController();
		const timeoutId = window.setTimeout(() => {
			controller.abort("Clip scoring request timed out");
		}, CLIP_SCORING_TIMEOUT_MS);

		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					transcript: truncateTranscriptForScoring({ transcript }),
					candidates,
				}),
				signal: controller.signal,
			});
			window.clearTimeout(timeoutId);
			return response;
		} catch (error) {
			window.clearTimeout(timeoutId);
			lastNetworkError =
				error instanceof Error ? error : new Error("Failed to reach clip scoring API");
		}
	}

	throw lastNetworkError ?? new Error("Failed to reach clip scoring API");
}

function buildClipElement({
	asset,
	startTime,
	endTime,
	canvasSize,
	scaleOverride,
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
	canvasSize: { width: number; height: number };
	scaleOverride?: number;
}) {
	const duration = Math.max(0.1, endTime - startTime);
	const sourceDuration = Math.max(endTime, asset.duration ?? endTime);
	const trimEnd = Math.max(0, sourceDuration - endTime);
	const sourceWidth = asset.width ?? 0;
	const sourceHeight = asset.height ?? 0;
	const shouldCoverScale =
		asset.type === "video" &&
		sourceWidth > 0 &&
		sourceHeight > 0 &&
		canvasSize.width > 0 &&
		canvasSize.height > 0;
	const coverScale = shouldCoverScale
		? Math.max(canvasSize.width / sourceWidth, canvasSize.height / sourceHeight) /
			Math.min(canvasSize.width / sourceWidth, canvasSize.height / sourceHeight)
		: 1;
	const effectiveScale =
		typeof scaleOverride === "number" && Number.isFinite(scaleOverride) && scaleOverride > 0
			? scaleOverride
			: coverScale;

	if (asset.type === "video") {
		return {
			type: "video" as const,
			mediaId: asset.id,
			name: asset.name,
			duration,
			startTime: 0,
			trimStart: startTime,
			trimEnd,
			muted: false,
			hidden: false,
			transform: {
				...DEFAULT_TRANSFORM,
				scale: Number.isFinite(effectiveScale)
					? Math.max(1, effectiveScale)
					: 1,
			},
			opacity: DEFAULT_OPACITY,
			blendMode: DEFAULT_BLEND_MODE,
		};
	}

	return {
		type: "audio" as const,
		sourceType: "upload" as const,
		mediaId: asset.id,
		name: asset.name,
		duration,
		startTime: 0,
		trimStart: startTime,
		trimEnd,
		volume: 1,
		muted: false,
	};
}

function mergeTimeRanges(
	ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
	const sorted = [...ranges]
		.filter((range) => range.end - range.start > 0)
		.sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (!previous || range.start > previous.end) {
			merged.push({ ...range });
			continue;
		}
		previous.end = Math.max(previous.end, range.end);
	}
	return merged;
}

function remapTimeWithRemovedRanges({
	time,
	removedRanges,
}: {
	time: number;
	removedRanges: Array<{ start: number; end: number }>;
}): number | null {
	let shift = 0;
	for (const range of removedRanges) {
		if (time < range.start) break;
		if (time <= range.end) return null;
		shift += range.end - range.start;
	}
	return time - shift;
}

function isGeneratedCaption(element: TextElement): boolean {
	return (
		element.name.startsWith("Caption ") &&
		(element.captionWordTimings?.length ?? 0) > 0
	);
}

function retimeGeneratedCaptions({
	tracks,
	removedRanges,
}: {
	tracks: TimelineTrack[];
	removedRanges: Array<{ start: number; end: number }>;
}): TimelineTrack[] {
	if (removedRanges.length === 0) return tracks;

	return tracks.map((track) => {
		if (track.type !== "text") return track;

		const nextElements = track.elements
			.map((element) => {
				if (element.type !== "text" || !isGeneratedCaption(element)) {
					return element;
				}

				const nextWordTimings = (element.captionWordTimings ?? [])
					.map((timing) => {
						const nextStart = remapTimeWithRemovedRanges({
							time: timing.startTime,
							removedRanges,
						});
						const nextEnd = remapTimeWithRemovedRanges({
							time: timing.endTime,
							removedRanges,
						});
						if (nextStart == null || nextEnd == null || nextEnd <= nextStart) {
							return null;
						}
						return {
							word: timing.word,
							startTime: nextStart,
							endTime: nextEnd,
						};
					})
					.filter((word): word is NonNullable<typeof word> => word !== null);

				if (nextWordTimings.length === 0) return null;
				const startTime = nextWordTimings[0].startTime;
				const endTime = nextWordTimings[nextWordTimings.length - 1].endTime;
				return {
					...element,
					content: nextWordTimings.map((word) => word.word).join(" "),
					startTime,
					duration: Math.max(0.04, endTime - startTime),
					captionWordTimings: nextWordTimings,
				};
			})
			.filter((element): element is typeof track.elements[number] => element !== null)
			.sort((a, b) => a.startTime - b.startTime);

		return {
			...track,
			elements: nextElements,
		};
	});
}

function computeRemovedTimelineRangesFromTranscriptCuts({
	processable,
	resultsByElementKey,
}: {
	processable: Array<{
		track: TimelineTrack;
		element: { id: string; startTime: number; duration: number; trimStart: number };
	}>;
	resultsByElementKey: Map<string, { segments: Array<{ start: number; end: number }> }>;
}): Array<{ start: number; end: number }> {
	const removed: Array<{ start: number; end: number }> = [];

	for (const { track, element } of processable) {
		const result = resultsByElementKey.get(`${track.id}:${element.id}`);
		if (!result) continue;

		const visibleStart = element.trimStart;
		const visibleEnd = element.trimStart + element.duration;
		const keeps = [...result.segments].sort((a, b) => a.start - b.start);
		let cursor = visibleStart;
		for (const keep of keeps) {
			if (keep.start > cursor) {
				removed.push({
					start: element.startTime + (cursor - visibleStart),
					end: element.startTime + (keep.start - visibleStart),
				});
			}
			cursor = Math.max(cursor, keep.end);
		}
		if (cursor < visibleEnd) {
			removed.push({
				start: element.startTime + (cursor - visibleStart),
				end: element.startTime + (visibleEnd - visibleStart),
			});
		}
	}

	return mergeTimeRanges(removed);
}

export function useEditorActions() {
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const transcriptionStatus = useTranscriptionStatusStore();
	const { registerProcess, updateProcessLabel, removeProcess } =
		useProjectProcessStore();
	const { selectedElements, setElementSelection } = useElementSelection();
	const { clipboard, setClipboard, toggleSnapping, rippleEditingEnabled } =
		useTimelineStore();
	const { setStatus, setError, setCandidates, reset } = useClipGenerationStore();

	async function resolveVideoCoverScale({
		asset,
		canvasSize,
	}: {
		asset: MediaAsset;
		canvasSize: { width: number; height: number };
	}): Promise<number> {
		let width = asset.width ?? 0;
		let height = asset.height ?? 0;

		if ((width <= 0 || height <= 0) && asset.type === "video") {
			try {
				const videoInfo = await getVideoInfo({ videoFile: asset.file });
				if (Number.isFinite(videoInfo.width) && videoInfo.width > 0) {
					width = videoInfo.width;
				}
				if (Number.isFinite(videoInfo.height) && videoInfo.height > 0) {
					height = videoInfo.height;
				}
			} catch (error) {
				console.warn("Failed to resolve source video dimensions for cover-fit:", error);
			}
		}

		if (width <= 0 || height <= 0) {
			// Conservative portrait fallback that still ensures visible cover for typical 16:9 sources.
			return canvasSize.height > canvasSize.width ? 3.2 : 1;
		}

		const widthRatio = canvasSize.width / width;
		const heightRatio = canvasSize.height / height;
		if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio)) {
			return 1;
		}
		const containScale = Math.min(widthRatio, heightRatio);
		const coverScale = Math.max(widthRatio, heightRatio);
		if (containScale <= 0) return 1;
		return Math.max(1, coverScale / containScale);
	}

	useActionHandler(
		"toggle-play",
		() => {
			editor.playback.toggle();
		},
		undefined,
	);

	useActionHandler(
		"stop-playback",
		() => {
			if (editor.playback.getIsPlaying()) {
				editor.playback.toggle();
			}
			editor.playback.seek({ time: 0 });
		},
		undefined,
	);

	useActionHandler(
		"seek-forward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			editor.playback.seek({
				time: Math.min(
					editor.timeline.getTotalDuration(),
					editor.playback.getCurrentTime() + seconds,
				),
			});
		},
		undefined,
	);

	useActionHandler(
		"seek-backward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			editor.playback.seek({
				time: Math.max(0, editor.playback.getCurrentTime() - seconds),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-forward",
		() => {
			const fps = activeProject.settings.fps;
			editor.playback.seek({
				time: Math.min(
					editor.timeline.getTotalDuration(),
					editor.playback.getCurrentTime() + 1 / fps,
				),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-backward",
		() => {
			const fps = activeProject.settings.fps;
			editor.playback.seek({
				time: Math.max(0, editor.playback.getCurrentTime() - 1 / fps),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-forward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			editor.playback.seek({
				time: Math.min(
					editor.timeline.getTotalDuration(),
					editor.playback.getCurrentTime() + seconds,
				),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-backward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			editor.playback.seek({
				time: Math.max(0, editor.playback.getCurrentTime() - seconds),
			});
		},
		undefined,
	);

	useActionHandler(
		"goto-start",
		() => {
			editor.playback.seek({ time: 0 });
		},
		undefined,
	);

	useActionHandler(
		"goto-end",
		() => {
			editor.playback.seek({ time: editor.timeline.getTotalDuration() });
		},
		undefined,
	);

	useActionHandler(
		"split",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const elementsToSplit =
				selectedElements.length > 0
					? selectedElements
					: getElementsAtTime({
							tracks: editor.timeline.getTracks(),
							time: currentTime,
						});

			if (elementsToSplit.length === 0) return;

			editor.timeline.splitElements({
				elements: elementsToSplit,
				splitTime: currentTime,
			});
		},
		undefined,
	);

	useActionHandler(
		"split-left",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const elementsToSplit =
				selectedElements.length > 0
					? selectedElements
					: getElementsAtTime({
							tracks: editor.timeline.getTracks(),
							time: currentTime,
						});

			if (elementsToSplit.length === 0) return;

			editor.timeline.splitElements({
				elements: elementsToSplit,
				splitTime: currentTime,
				retainSide: "right",
			});
		},
		undefined,
	);

	useActionHandler(
		"split-right",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const elementsToSplit =
				selectedElements.length > 0
					? selectedElements
					: getElementsAtTime({
							tracks: editor.timeline.getTracks(),
							time: currentTime,
						});

			if (elementsToSplit.length === 0) return;

			editor.timeline.splitElements({
				elements: elementsToSplit,
				splitTime: currentTime,
				retainSide: "left",
			});
		},
		undefined,
	);

	useActionHandler(
		"smart-cut-selected",
		() => {
			void (async () => {
				if (selectedElements.length === 0) {
					toast.error("Select one or more media clips first");
					return;
				}

				const tracks = editor.timeline.getTracks();
				const mediaAssets = editor.media.getAssets();
				const currentProject = editor.project.getActive();
				const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
				let transcriptionCache = findLatestValidTranscriptionCacheEntry({
					project: currentProject,
					tracks,
					mediaAssets,
				});

				if (!transcriptionCache) {
					let transcriptionOperationId: string | undefined;
					let projectProcessId: string | undefined;
					try {
						toast.info("No transcript cache found. Generating transcript...");
						transcriptionOperationId = transcriptionStatus.start(
							"Extracting audio...",
						);
						projectProcessId = registerProcess({
							projectId: currentProject.metadata.id,
							kind: "transcription",
							label: "Generating transcript...",
							cancel: () => transcriptionService.cancel(),
						});
						const audioBlob = await extractTimelineAudio({
							tracks,
							mediaAssets,
							totalDuration: editor.timeline.getTotalDuration(),
						});
						const { samples, sampleRate } = await decodeAudioToFloat32({
							audioBlob,
						});
						transcriptionStatus.update({
							operationId: transcriptionOperationId,
							message: "Transcribing...",
							progress: null,
						});
						const result = await transcriptionService.transcribe({
							audioData: samples,
							sampleRate,
							language: undefined,
							modelId: DEFAULT_TRANSCRIPTION_MODEL,
							onProgress: (progress) => {
								if (projectProcessId) {
									updateProcessLabel({
										id: projectProcessId,
										label:
											progress.message ??
											`Transcription ${Math.round(progress.progress)}%`,
									});
								}
								transcriptionStatus.update({
									operationId: transcriptionOperationId,
									message: progress.message ?? "Generating transcript...",
									progress: progress.progress,
								});
							},
						});

						const language = "auto";
						const fingerprint = buildTranscriptionFingerprint({
							tracks,
							mediaAssets,
							modelId: DEFAULT_TRANSCRIPTION_MODEL,
							language,
						});
						const cacheKey = getTranscriptionCacheKey({
							modelId: DEFAULT_TRANSCRIPTION_MODEL,
							language,
						});
						const updatedProject = {
							...currentProject,
							transcriptionCache: {
								...(currentProject.transcriptionCache ?? {}),
								[cacheKey]: {
									cacheVersion: TRANSCRIPT_CACHE_VERSION,
									fingerprint,
									language,
									modelId: DEFAULT_TRANSCRIPTION_MODEL,
									text: result.text,
									segments: result.segments,
									updatedAt: new Date().toISOString(),
								},
							},
						};
						editor.project.setActiveProject({ project: updatedProject });
						editor.save.markDirty();
						transcriptionCache = updatedProject.transcriptionCache?.[cacheKey] ?? null;
					} catch (error) {
						console.error("Auto transcript generation failed:", error);
						toast.error(
							"Smart Cut needs a transcript. Auto-generation failed; generate transcript from Captions panel and retry.",
						);
						return;
					} finally {
						transcriptionStatus.stop(transcriptionOperationId);
						if (projectProcessId) {
							removeProcess({ id: projectProcessId });
						}
					}
				}

				if (!transcriptionCache) {
					toast.error("Smart Cut needs transcript data but none is available.");
					return;
				}
				const selectedWithElements = editor.timeline.getElementsWithTracks({
					elements: selectedElements,
				});

				const processable = selectedWithElements.filter(({ element }) => {
					if (element.type !== "video" && element.type !== "audio") return false;
					if (element.type === "video") return mediaById.has(element.mediaId);
					if (element.sourceType === "upload") return mediaById.has(element.mediaId);
					return false;
				});

				if (processable.length === 0) {
					toast.error("No selected clips support Smart Cut");
					return;
				}

				toast.info("Applying transcript-driven Smart Cut...");

				const resultsByElementKey = new Map<
					string,
					ReturnType<typeof computeSmartCutFromTranscriptForElement>
				>();

				for (const { track, element } of processable) {
					const result = computeSmartCutFromTranscriptForElement({
						element,
						segments: transcriptionCache.segments,
					});
					resultsByElementKey.set(`${track.id}:${element.id}`, result);
				}

				if (resultsByElementKey.size === 0) {
					toast.error("Smart Cut could not derive cuts from transcript");
					return;
				}

				const { tracks: updatedTracks, changedElements, totalRemovedDuration } =
					applySmartCutsToTracks({
						tracks,
						selectedElements,
						resultsByElementKey,
						ripple: rippleEditingEnabled,
					});

				let nextTracks = updatedTracks;
				if (rippleEditingEnabled) {
					const removedRanges = computeRemovedTimelineRangesFromTranscriptCuts({
						processable: processable.map(({ track, element }) => ({
							track,
							element: {
								id: element.id,
								startTime: element.startTime,
								duration: element.duration,
								trimStart: element.trimStart,
							},
						})),
						resultsByElementKey: resultsByElementKey as Map<
							string,
							{ segments: Array<{ start: number; end: number }> }
						>,
					});
					nextTracks = retimeGeneratedCaptions({
						tracks: updatedTracks,
						removedRanges,
					});
				}

				if (changedElements === 0) {
					toast.info("No significant silence detected");
					return;
				}

				editor.command.execute({
					command: new TracksSnapshotCommand(tracks, nextTracks),
				});
				toast.success(
					`Smart Cut updated ${changedElements} clip${changedElements > 1 ? "s" : ""} (${totalRemovedDuration.toFixed(1)}s removed)`,
				);
				if (!rippleEditingEnabled) {
					toast.info(
						"Enable Ripple Editing to keep generated captions automatically retimed with Smart Cut.",
					);
				}
			})();
		},
		undefined,
	);

	useActionHandler(
		"generate-viral-clips",
		(args) => {
			void (async () => {
				const candidateSourceAssets = editor
					.media
					.getAssets()
					.filter(
						(asset) =>
							!asset.ephemeral && (asset.type === "video" || asset.type === "audio"),
					);
				const resolvedSourceMediaId =
					args?.sourceMediaId && args.sourceMediaId.length > 0
						? args.sourceMediaId
						: candidateSourceAssets[0]?.id;

				if (!resolvedSourceMediaId) {
					toast.error("Add a video or audio media file first");
					return;
				}

				const mediaAsset = candidateSourceAssets.find(
					(asset) => asset.id === resolvedSourceMediaId,
				);
				if (!mediaAsset || (mediaAsset.type !== "video" && mediaAsset.type !== "audio")) {
					setError({ error: "Selected media does not support clip generation" });
					toast.error("Select a video or audio asset to generate clips");
					return;
				}

				const currentProject = editor.project.getActive();
				let transcriptionOperationId: string | undefined;
				let projectProcessId: string | undefined;

				try {
					setStatus({
						status: "extracting",
						sourceMediaId: mediaAsset.id,
					});
					transcriptionOperationId = transcriptionStatus.start("Preparing transcript...");
					projectProcessId = registerProcess({
						projectId: currentProject.metadata.id,
						kind: "clip-generation",
						label: "Generating clips...",
					});

					const transcriptResult = await getOrCreateClipTranscriptForAsset({
						project: currentProject,
						asset: mediaAsset,
						modelId: "whisper-tiny",
						onProgress: (progress) => {
							setStatus({
								status: "transcribing",
								sourceMediaId: mediaAsset.id,
							});
							transcriptionStatus.update({
								operationId: transcriptionOperationId,
								message: progress.message ?? "Transcribing source media...",
								progress: progress.progress,
							});
							if (projectProcessId) {
								updateProcessLabel({
									id: projectProcessId,
									label:
										progress.message ??
										`Transcription ${Math.round(progress.progress)}%`,
								});
							}
						},
					});

					if (!transcriptResult.fromCache) {
						const nextProject = {
							...currentProject,
							clipTranscriptCache: {
								...(currentProject.clipTranscriptCache ?? {}),
								[transcriptResult.cacheKey]: transcriptResult.transcript,
							},
						};
						editor.project.setActiveProject({ project: nextProject });
						editor.save.markDirty();
					}

					const mediaDuration =
						mediaAsset.duration ??
						transcriptResult.transcript.segments[
							transcriptResult.transcript.segments.length - 1
						]?.end ??
						0;
					const candidateDrafts = buildClipCandidatesFromTranscript({
						segments: transcriptResult.transcript.segments,
						mediaDuration,
					});

					if (candidateDrafts.length === 0) {
						setError({ error: "No candidate windows found for this transcript" });
						toast.error("Could not derive clip candidates from transcript");
						return;
					}

					setStatus({
						status: "scoring",
						sourceMediaId: mediaAsset.id,
					});
					if (projectProcessId) {
						updateProcessLabel({
							id: projectProcessId,
							label: "Scoring clip virality...",
						});
					}

					const scoringResponse = await fetchScoredCandidates({
						transcript: transcriptResult.transcript.text,
						candidates: candidateDrafts,
					});

					if (!scoringResponse.ok) {
						const errorText = await scoringResponse.text();
						throw new Error(errorText || "Clip scoring failed");
					}

					const scoringJson = (await scoringResponse.json()) as {
						candidates?: Array<{
							id: string;
							startTime: number;
							endTime: number;
							duration: number;
							title: string;
							rationale: string;
							transcriptSnippet: string;
							scoreOverall: number;
							scoreBreakdown: {
								hook: number;
								emotion: number;
								shareability: number;
								clarity: number;
								momentum: number;
							};
						}>;
					};
					const scoredCandidates = scoringJson.candidates ?? [];
					const selectedCandidates = selectTopCandidatesWithQualityGate({
						candidates: scoredCandidates,
						minScore: MIN_VIRAL_CLIP_SCORE,
						maxCount: MAX_VIRAL_CLIP_COUNT,
					});

					if (selectedCandidates.length === 0) {
						setError({
							error:
								"No clips passed the quality gate. Try another source or longer material.",
						});
						toast.error("No clips passed the virality quality gate");
						return;
					}

					setCandidates({
						sourceMediaId: mediaAsset.id,
						candidates: selectedCandidates,
						transcriptRef: transcriptResult.transcriptRef,
					});
					toast.success(`Generated ${selectedCandidates.length} clip candidate(s)`);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Clip generation failed";
					setError({ error: message });
					toast.error(message);
				} finally {
					transcriptionStatus.stop(transcriptionOperationId);
					if (projectProcessId) {
						removeProcess({ id: projectProcessId });
					}
				}
			})();
		},
		undefined,
	);

	useActionHandler(
		"import-selected-viral-clips",
		(args) => {
			void (async () => {
				const clipStoreState = useClipGenerationStore.getState();
				const sourceMediaId = clipStoreState.sourceMediaId;
				if (!sourceMediaId) {
					toast.error("Generate clips first");
					return;
				}

				const mediaAsset = editor
					.media
					.getAssets()
					.find((asset) => asset.id === sourceMediaId);
				if (!mediaAsset || (mediaAsset.type !== "video" && mediaAsset.type !== "audio")) {
					toast.error("Source media for clips was not found");
					return;
				}

				const candidateIds =
					args?.candidateIds?.length
						? args.candidateIds
						: clipStoreState.selectedCandidateIds;
				if (candidateIds.length === 0) {
					toast.error("Select one or more clip candidates to import");
					return;
				}

				const candidates = candidateIds
					.map((id) => clipStoreState.candidates.find((candidate) => candidate.id === id))
					.filter(
						(candidate): candidate is NonNullable<typeof candidate> =>
							candidate != null,
					);

				if (candidates.length === 0) {
					toast.error("No valid selected clip candidates found");
					return;
				}

				const project = editor.project.getActive();
				if (
					project.settings.canvasSize.width !== DEFAULT_CANVAS_SIZE.width ||
					project.settings.canvasSize.height !== DEFAULT_CANVAS_SIZE.height ||
					project.settings.fps !== DEFAULT_FPS
				) {
					await editor.project.updateSettings({
						settings: {
							canvasSize: {
								width: DEFAULT_CANVAS_SIZE.width,
								height: DEFAULT_CANVAS_SIZE.height,
							},
							fps: DEFAULT_FPS,
							originalCanvasSize:
								project.settings.originalCanvasSize ??
								project.settings.canvasSize,
						},
					});
				}
				const refreshedProject = editor.project.getActive();
				const projectCanvas = refreshedProject.settings.canvasSize;
				const transcriptKey = clipStoreState.transcriptRef?.cacheKey ?? null;
				const transcriptEntry =
					(transcriptKey &&
						refreshedProject.clipTranscriptCache?.[transcriptKey]) ||
					null;
				const createdSceneIds: string[] = [];
				const resolvedVideoScale =
					mediaAsset.type === "video"
						? await resolveVideoCoverScale({
								asset: mediaAsset,
								canvasSize: projectCanvas,
							})
						: 1;

				for (let i = 0; i < candidates.length; i++) {
					const candidate = candidates[i];
					const sceneName = `Clip ${i + 1} (${Math.round(candidate.duration)}s)`;
					const sceneId = await editor.scenes.createScene({
						name: sceneName,
						isMain: false,
					});
					createdSceneIds.push(sceneId);
					await editor.scenes.switchToScene({ sceneId });

					const tracks = editor.timeline.getTracks();
					if (mediaAsset.type === "video") {
						const mainTrack = getMainTrack({ tracks });
						if (!mainTrack) {
							toast.error("No main video track found in the new scene");
							continue;
						}
						editor.timeline.insertElement({
							placement: {
								mode: "explicit",
								trackId: mainTrack.id,
							},
							element: buildClipElement({
								asset: mediaAsset,
								startTime: candidate.startTime,
								endTime: candidate.endTime,
								canvasSize: projectCanvas,
								scaleOverride: resolvedVideoScale,
							}),
						});
					} else {
						const audioTrackId = editor.timeline.addTrack({
							type: "audio",
						});
						editor.timeline.insertElement({
							placement: {
								mode: "explicit",
								trackId: audioTrackId,
							},
							element: buildClipElement({
								asset: mediaAsset,
								startTime: candidate.startTime,
								endTime: candidate.endTime,
								canvasSize: projectCanvas,
								scaleOverride: resolvedVideoScale,
							}),
						});
					}

					if (transcriptEntry) {
						const clippedSegments = clipTranscriptSegmentsForWindow({
							segments: transcriptEntry.segments,
							startTime: candidate.startTime,
							endTime: candidate.endTime,
						});
						if (clippedSegments.length > 0) {
							const captionTrackId = editor.timeline.addTrack({
								type: "text",
								index: 0,
							});
							const captionChunks = buildCaptionChunks({
								segments: clippedSegments,
								mode: "segment",
							});
							for (let captionIndex = 0; captionIndex < captionChunks.length; captionIndex++) {
								const caption = captionChunks[captionIndex];
								editor.timeline.insertElement({
									placement: {
										mode: "explicit",
										trackId: captionTrackId,
									},
									element: {
										...DEFAULT_TEXT_ELEMENT,
										name: `Caption ${captionIndex + 1}`,
										content: caption.text,
										duration: caption.duration,
										startTime: caption.startTime,
										captionWordTimings: caption.wordTimings,
										fontSize: 65,
										fontWeight: "bold",
										captionStyle: {
											fitInCanvas: true,
											karaokeWordHighlight: true,
											karaokeHighlightMode: "block",
											karaokeHighlightEaseInOnly: false,
											karaokeScaleHighlightedWord: false,
											karaokeUnderlineThickness: 3,
											karaokeHighlightColor: "#FDE047",
											karaokeHighlightTextColor: "#111111",
											karaokeHighlightOpacity: 1,
											karaokeHighlightRoundness: 4,
											backgroundFitMode: "block",
											neverShrinkFont: false,
											wordsOnScreen: 3,
											maxLinesOnScreen: 2,
											wordDisplayPreset: "balanced",
											linkedToCaptionGroup: true,
											anchorToSafeAreaBottom: true,
											safeAreaBottomOffset: 0,
										},
									},
								});
							}
						}
					}
				}

				if (createdSceneIds[0]) {
					await editor.scenes.switchToScene({ sceneId: createdSceneIds[0] });
				}
				useClipGenerationStore.getState().setSelectedCandidateIds({
					candidateIds: [],
				});
				toast.success(`Imported ${createdSceneIds.length} clip scene(s)`);
			})();
		},
		undefined,
	);

	useActionHandler(
		"clear-viral-clips-session",
		() => {
			reset();
		},
		undefined,
	);

	useActionHandler(
		"delete-selected",
		() => {
			if (selectedElements.length === 0) {
				return;
			}
			editor.timeline.deleteElements({
				elements: selectedElements,
			});
			editor.selection.clearSelection();
		},
		undefined,
	);

	useActionHandler(
		"select-all",
		() => {
			const allElements = editor.timeline.getTracks().flatMap((track) =>
				track.elements.map((element) => ({
					trackId: track.id,
					elementId: element.id,
				})),
			);
			setElementSelection({ elements: allElements });
		},
		undefined,
	);

	useActionHandler(
		"duplicate-selected",
		() => {
			editor.timeline.duplicateElements({
				elements: selectedElements,
			});
		},
		undefined,
	);

	useActionHandler(
		"toggle-elements-muted-selected",
		() => {
			editor.timeline.toggleElementsMuted({ elements: selectedElements });
		},
		undefined,
	);

	useActionHandler(
		"toggle-elements-visibility-selected",
		() => {
			editor.timeline.toggleElementsVisibility({ elements: selectedElements });
		},
		undefined,
	);

	useActionHandler(
		"toggle-bookmark",
		() => {
			editor.scenes.toggleBookmark({ time: editor.playback.getCurrentTime() });
		},
		undefined,
	);

	useActionHandler(
		"copy-selected",
		() => {
			if (selectedElements.length === 0) return;

			const results = editor.timeline.getElementsWithTracks({
				elements: selectedElements,
			});
			const items = results.map(({ track, element }) => {
				const { ...elementWithoutId } = element;
				return {
					trackId: track.id,
					trackType: track.type,
					element: elementWithoutId,
				};
			});

			setClipboard({ items });
		},
		undefined,
	);

	useActionHandler(
		"paste-copied",
		() => {
			if (!clipboard?.items.length) return;

			editor.timeline.pasteAtTime({
				time: editor.playback.getCurrentTime(),
				clipboardItems: clipboard.items,
			});
		},
		undefined,
	);

	useActionHandler(
		"toggle-snapping",
		() => {
			toggleSnapping();
		},
		undefined,
	);

	useActionHandler(
		"undo",
		() => {
			editor.command.undo();
		},
		undefined,
	);

	useActionHandler(
		"redo",
		() => {
			editor.command.redo();
		},
		undefined,
	);
}
