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
