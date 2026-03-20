import { invokeAction } from "@/lib/actions";
import {
	buildClipTranscriptCacheEntryForAsset,
	buildProjectMediaTranscriptLinkKey,
	clipTranscriptSegmentsForWindow,
	clipTranscriptWordsForWindow,
	getOrCreateClipTranscriptForAsset,
	PROJECT_MEDIA_TRANSCRIPT_LANGUAGE,
	PROJECT_MEDIA_TRANSCRIPT_MODEL,
	transcribeClipTranscriptLocallyForAsset,
} from "@/lib/clips/transcript";
import {
	buildTranscriptCutsFromWords,
	normalizeTranscriptWords,
} from "@/lib/transcript-editor/core";
import { compileTranscriptDraft } from "@/lib/transcript-editor/state";
import { storageService } from "@/services/storage/service";
import type { MediaAsset } from "@/types/assets";
import type { TProject } from "@/types/project";
import type {
	AudioElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";
import type {
	TranscriptEditWord,
	TranscriptionSegment,
	TranscriptionWord,
} from "@/types/transcription";

function isEditableMediaElement(
	element: unknown,
): element is VideoElement | AudioElement {
	if (!element || typeof element !== "object") return false;
	const candidate = element as { type?: string };
	return candidate.type === "video" || candidate.type === "audio";
}

function resolveMediaIdFromElement({
	element,
}: {
	element: VideoElement | AudioElement;
}): string | null {
	if (element.type === "video") return element.mediaId;
	return element.sourceType === "upload" ? element.mediaId : null;
}

export function buildTranscriptWordsFromSegments({
	mediaElementId,
	segments,
}: {
	mediaElementId: string;
	segments: TranscriptionSegment[];
}): TranscriptEditWord[] {
	let wordIndex = 0;
	const words = segments.flatMap((segment) => {
		const tokens = segment.text.match(/\S+/g) ?? [];
		if (tokens.length === 0) return [];
		const segmentStart = Math.max(0, segment.start);
		const segmentEnd = Math.max(segmentStart + 0.01, segment.end);
		const duration = Math.max(0.01, segmentEnd - segmentStart);
		const weights = tokens.map((token) => Math.max(1, token.length));
		const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
		let consumed = 0;
		return tokens.map((token, tokenIndex) => {
			const startWeight = consumed;
			consumed += weights[tokenIndex] ?? 1;
			const endWeight = consumed;
			const startTime = segmentStart + (duration * startWeight) / totalWeight;
			const endTime = Math.max(
				startTime + 0.01,
				segmentStart + (duration * endWeight) / totalWeight,
			);
			const id = `${mediaElementId}:word:${wordIndex}:${startTime.toFixed(3)}`;
			wordIndex += 1;
			return {
				id,
				text: token,
				startTime,
				endTime,
				removed: false,
			};
		});
	});
	return normalizeTranscriptWords({ words });
}

export function buildTranscriptWordsFromTimedWords({
	mediaElementId,
	words,
}: {
	mediaElementId: string;
	words: TranscriptionWord[];
}): TranscriptEditWord[] {
	return normalizeTranscriptWords({
		words: words.map((word, index) => ({
			id: `${mediaElementId}:word:${index}:${word.start.toFixed(3)}`,
			text: word.word,
			startTime: word.start,
			endTime: word.end,
			speakerId: word.speakerId,
			removed: false,
		})),
	});
}

type EditorForTranscriptImport = {
	project: {
		getActive: () => TProject;
		setActiveProject: ({ project }: { project: TProject }) => void;
	};
	media: {
		getAssets: () => MediaAsset[];
		setAssets: ({ assets }: { assets: MediaAsset[] }) => void;
	};
	timeline: {
		getTracks: () => TimelineTrack[];
		updateElements: (args: {
			updates: Array<{
				trackId: string;
				elementId: string;
				updates: Partial<Record<string, unknown>>;
			}>;
			pushHistory?: boolean;
		}) => void;
	};
	save: {
		markDirty: () => void;
	};
};

export async function prepareImportedAssetWithTranscript({
	project,
	asset,
	assetId,
	onProgress,
}: {
	project: TProject;
	asset: Omit<MediaAsset, "id">;
	assetId: string;
	onProgress?: (progress: {
		progress: number;
		step?: string;
		stepProgress?: number;
	}) => void;
}): Promise<{ project: TProject; asset: Omit<MediaAsset, "id"> }> {
	// Only precompute transcript metadata for video imports.
	// Audio imports should not trigger transcription during ingest.
	if (asset.type !== "video") {
		return { project, asset };
	}

	const linkKey = buildProjectMediaTranscriptLinkKey({ asset });
	const linkedTranscript = project.mediaTranscriptLinks?.[linkKey];
	let text = linkedTranscript?.text ?? "";
	let segments = linkedTranscript?.segments ?? [];
	let words = linkedTranscript?.words ?? [];
	let updatedAt = linkedTranscript?.updatedAt ?? new Date().toISOString();

	if (!linkedTranscript) {
		onProgress?.({
			progress: 75,
			step: "Transcribing...",
			stepProgress: 0,
		});
		const localResult = await transcribeClipTranscriptLocallyForAsset({
			asset: {
				...asset,
				id: assetId,
			},
			modelId: PROJECT_MEDIA_TRANSCRIPT_MODEL,
			language: PROJECT_MEDIA_TRANSCRIPT_LANGUAGE,
			onProgress: (transcriptionProgress) => {
				const mappedProgress = Math.max(
					75,
					Math.min(
						99,
						75 + Math.round((transcriptionProgress.progress / 100) * 24),
					),
				);
				onProgress?.({
					progress: mappedProgress,
					step: transcriptionProgress.message ?? "Transcribing...",
					stepProgress: transcriptionProgress.progress,
				});
			},
		});
		text = localResult.text;
		segments = localResult.segments;
		words = localResult.words;
		updatedAt = new Date().toISOString();
		onProgress?.({
			progress: 99,
			step: "Transcript ready",
			stepProgress: 100,
		});
	} else {
		onProgress?.({
			progress: 95,
			step: "Using cached transcript",
			stepProgress: 100,
		});
	}

	const cacheEntry = buildClipTranscriptCacheEntryForAsset({
		asset: {
			...asset,
			id: assetId,
		},
		modelId: PROJECT_MEDIA_TRANSCRIPT_MODEL,
		language: PROJECT_MEDIA_TRANSCRIPT_LANGUAGE,
		text,
		segments,
		words,
		updatedAt,
	});

	return {
		asset: {
			...asset,
			transcriptLinkKey: linkKey,
			transcriptCacheKey: cacheEntry.cacheKey,
		},
		project: {
			...project,
			mediaTranscriptLinks: {
				...(project.mediaTranscriptLinks ?? {}),
				[linkKey]: {
					modelId: PROJECT_MEDIA_TRANSCRIPT_MODEL,
					language: PROJECT_MEDIA_TRANSCRIPT_LANGUAGE,
					text,
					segments,
					words,
					updatedAt,
				},
			},
			clipTranscriptCache: {
				...(project.clipTranscriptCache ?? {}),
				[cacheEntry.cacheKey]: cacheEntry.transcript,
			},
		},
	};
}

export async function autoLinkTranscriptAndCaptionsForMediaElement({
	editor,
	trackId,
	elementId,
}: {
	editor: EditorForTranscriptImport;
	trackId: string;
	elementId: string;
}): Promise<void> {
	const tracks = editor.timeline.getTracks();
	const track = tracks.find((item) => item.id === trackId);
	const element = track?.elements.find((item) => item.id === elementId);
	if (!isEditableMediaElement(element)) return;

	const mediaId = resolveMediaIdFromElement({ element });
	if (!mediaId) return;

	const mediaAsset = editor.media
		.getAssets()
		.find((item) => item.id === mediaId);
	if (!mediaAsset || mediaAsset.type !== "video") {
		return;
	}

	const activeProject = editor.project.getActive();
	const transcriptResult = await getOrCreateClipTranscriptForAsset({
		project: activeProject,
		asset: mediaAsset,
		modelId: PROJECT_MEDIA_TRANSCRIPT_MODEL,
		language: PROJECT_MEDIA_TRANSCRIPT_LANGUAGE,
	});

	const linkKey =
		mediaAsset.transcriptLinkKey ??
		buildProjectMediaTranscriptLinkKey({ asset: mediaAsset });
	const nextProject: TProject = {
		...activeProject,
		mediaTranscriptLinks: {
			...(activeProject.mediaTranscriptLinks ?? {}),
			[linkKey]: {
				modelId: PROJECT_MEDIA_TRANSCRIPT_MODEL,
				language: PROJECT_MEDIA_TRANSCRIPT_LANGUAGE,
				text: transcriptResult.transcript.text,
				segments: transcriptResult.transcript.segments,
				words: transcriptResult.transcript.words,
				updatedAt: transcriptResult.transcript.updatedAt,
			},
		},
		clipTranscriptCache: {
			...(activeProject.clipTranscriptCache ?? {}),
			[transcriptResult.cacheKey]: transcriptResult.transcript,
		},
	};
	editor.project.setActiveProject({ project: nextProject });

	const updatedAssets = editor.media.getAssets().map((asset) =>
		asset.id === mediaAsset.id
			? {
					...asset,
					transcriptLinkKey: linkKey,
					transcriptCacheKey: transcriptResult.cacheKey,
				}
			: asset,
	);
	editor.media.setAssets({ assets: updatedAssets });
	const updatedMediaAsset = updatedAssets.find(
		(asset) => asset.id === mediaAsset.id,
	);
	if (updatedMediaAsset) {
		void storageService.saveMediaAsset({
			projectId: activeProject.metadata.id,
			mediaAsset: updatedMediaAsset,
		});
	}

	const sourceWindowWords = clipTranscriptWordsForWindow({
		words: transcriptResult.transcript.words ?? [],
		startTime: element.trimStart,
		endTime: element.trimStart + element.duration,
	});
	const sourceWindowSegments =
		sourceWindowWords.length === 0
			? clipTranscriptSegmentsForWindow({
					segments: transcriptResult.transcript.segments,
					startTime: element.trimStart,
					endTime: element.trimStart + element.duration,
				})
			: [];
	if (sourceWindowWords.length === 0 && sourceWindowSegments.length === 0)
		return;

	const wordsForEdit =
		sourceWindowWords.length > 0
			? buildTranscriptWordsFromTimedWords({
					mediaElementId: element.id,
					words: sourceWindowWords,
				})
			: buildTranscriptWordsFromSegments({
					mediaElementId: element.id,
					segments: sourceWindowSegments,
				});
	const transcriptDraft = {
		version: 1 as const,
		source: "word-level" as const,
		words: wordsForEdit,
		cuts: buildTranscriptCutsFromWords({ words: wordsForEdit }),
		cutTimeDomain: "clip-local-source" as const,
		updatedAt: new Date().toISOString(),
	};
	editor.timeline.updateElements({
		updates: [
			{
				trackId,
				elementId,
				updates: {
					transcriptDraft,
					transcriptEdit: transcriptDraft,
					transcriptApplied: compileTranscriptDraft({
						mediaElementId: element.id,
						draft: transcriptDraft,
						mediaStartTime: element.startTime,
						mediaDuration: element.duration,
					}),
					transcriptCompileState: {
						status: "idle",
						updatedAt: transcriptDraft.updatedAt,
					},
				},
			},
		],
		pushHistory: false,
	});

	invokeAction("rebuild-captions-for-clip", { trackId, elementId });
	editor.save.markDirty();
}
