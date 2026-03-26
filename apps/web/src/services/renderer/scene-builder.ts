import type {
	AudioElement,
	ImageElement,
	TextElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { SplitScreenNode } from "./nodes/split-screen-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import type { TBackground, TCanvasSize, TBrandOverlays } from "@/types/project";
import { DEFAULT_BLUR_INTENSITY } from "@/constants/project-constants";
import { isMainTrack } from "@/lib/timeline";
import { DEFAULT_BRAND_OVERLAYS } from "@/constants/brand-overlay-constants";
import { resolveLogoOverlayTransform } from "@/lib/branding/logo-overlay";
import type { VideoCache } from "@/services/video-cache/service";
import { buildTranscriptTimelineSnapshot } from "@/lib/transcript-editor/snapshot";
import {
	getTranscriptApplied,
	getTranscriptDraft,
} from "@/lib/transcript-editor/state";
import { normalizeTimelineElementForInvariants } from "@/lib/timeline/element-timing";

type VisualMediaElement = VideoElement | ImageElement;

const PREVIEW_MAX_IMAGE_SIZE = 2048;

function isEditableMediaElement(
	element: unknown,
): element is VideoElement | AudioElement {
	if (!element || typeof element !== "object") return false;
	const candidate = element as { type?: string };
	return candidate.type === "video" || candidate.type === "audio";
}

function getEditableMediaSourceId(
	element: VideoElement | AudioElement,
): string | null {
	if (element.type === "video") return element.mediaId;
	if (element.sourceType === "upload") return element.mediaId;
	return null;
}

function isAlignedTranscriptCompanion({
	target,
	candidate,
}: {
	target: VideoElement | AudioElement;
	candidate: VideoElement | AudioElement;
}): boolean {
	const startAligned = Math.abs(candidate.startTime - target.startTime) < 0.02;
	const trimAligned = Math.abs(candidate.trimStart - target.trimStart) < 0.05;
	const endAligned =
		Math.abs(
			candidate.trimStart +
				candidate.duration -
				(target.trimStart + target.duration),
		) < 0.05;
	if (startAligned && trimAligned && endAligned) return true;

	const targetTimelineEnd = target.startTime + target.duration;
	const candidateTimelineEnd = candidate.startTime + candidate.duration;
	const targetSourceEnd = target.trimStart + target.duration;
	const candidateSourceEnd = candidate.trimStart + candidate.duration;
	const timelineOverlap = Math.max(
		0,
		Math.min(targetTimelineEnd, candidateTimelineEnd) -
			Math.max(target.startTime, candidate.startTime),
	);
	const sourceOverlap = Math.max(
		0,
		Math.min(targetSourceEnd, candidateSourceEnd) -
			Math.max(target.trimStart, candidate.trimStart),
	);
	const minDuration = Math.max(
		0.001,
		Math.min(target.duration, candidate.duration),
	);
	return (
		timelineOverlap / minDuration >= 0.8 && sourceOverlap / minDuration >= 0.8
	);
}

function resolveTranscriptCompanionForCaptionSource({
	sourceMedia,
	candidates,
}: {
	sourceMedia: VideoElement | AudioElement;
	candidates: Array<VideoElement | AudioElement>;
}): VideoElement | AudioElement | null {
	const targetSourceId = getEditableMediaSourceId(sourceMedia);
	if (!targetSourceId) return null;
	for (const candidate of candidates) {
		if (candidate.id === sourceMedia.id) continue;
		if (getEditableMediaSourceId(candidate) !== targetSourceId) continue;
		if ((getTranscriptDraft(candidate)?.words.length ?? 0) === 0) continue;
		if (!isAlignedTranscriptCompanion({ target: sourceMedia, candidate }))
			continue;
		return candidate;
	}
	return null;
}

function resolveCaptionPlacementVideoCompanion({
	sourceMedia,
	candidates,
}: {
	sourceMedia: VideoElement | AudioElement;
	candidates: Array<VideoElement | AudioElement>;
}): VideoElement | null {
	if (sourceMedia.type === "video") return sourceMedia;
	let best: VideoElement | null = null;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const candidate of candidates) {
		if (candidate.id === sourceMedia.id || candidate.type !== "video") continue;
		const startDistance = Math.abs(candidate.startTime - sourceMedia.startTime);
		const trimDistance = Math.abs(candidate.trimStart - sourceMedia.trimStart);
		const endDistance = Math.abs(
			candidate.trimStart +
				candidate.duration -
				(sourceMedia.trimStart + sourceMedia.duration),
		);
		const overlap = Math.max(
			0,
			Math.min(
				candidate.startTime + candidate.duration,
				sourceMedia.startTime + sourceMedia.duration,
			) - Math.max(candidate.startTime, sourceMedia.startTime),
		);
		const score =
			overlap - startDistance * 4 - trimDistance * 3 - endDistance * 3;
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return best;
}

function resolveCaptionSourceMediaHeuristically({
	element,
	candidates,
}: {
	element: TextElement;
	candidates: Array<VideoElement | AudioElement>;
}): VideoElement | AudioElement | null {
	if ((element.captionWordTimings?.length ?? 0) === 0) return null;
	if (element.captionStyle?.linkedToCaptionGroup === false) return null;
	if (candidates.length === 0) return null;

	const elementEnd = element.startTime + element.duration;
	let best: VideoElement | AudioElement | null = null;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const candidate of candidates) {
		const candidateEnd = candidate.startTime + candidate.duration;
		const overlap = Math.max(
			0,
			Math.min(elementEnd, candidateEnd) -
				Math.max(element.startTime, candidate.startTime),
		);
		const overlapScore = overlap;
		const startDistance = Math.abs(element.startTime - candidate.startTime);
		const durationDistance = Math.abs(element.duration - candidate.duration);
		const score = overlapScore - startDistance * 0.25 - durationDistance * 0.1;
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return best;
}

function hasExternalSplitSource({
	element,
}: {
	element: VideoElement;
}): boolean {
	const splitScreen = element.splitScreen;
	if (!splitScreen) return false;
	const slots = [
		...(splitScreen.slots ?? []),
		...(splitScreen.sections ?? []).flatMap((section) => section.slots ?? []),
	];
	return slots.some(
		(slot) =>
			typeof slot.sourceElementId === "string" &&
			slot.sourceElementId.trim().length > 0 &&
			slot.sourceElementId !== element.id,
	);
}

function appendSuppressionRange({
	map,
	elementId,
	startTime,
	endTime,
}: {
	map: Map<string, Array<{ startTime: number; endTime: number }>>;
	elementId: string;
	startTime: number;
	endTime: number;
}): void {
	if (endTime - startTime <= 0.001) return;
	const existing = map.get(elementId) ?? [];
	existing.push({ startTime, endTime });
	map.set(elementId, existing);
}

function buildConsumedRangesByElementId({
	visualElements,
}: {
	visualElements: VisualMediaElement[];
}): Map<string, Array<{ startTime: number; endTime: number }>> {
	const consumedRangesByElementId = new Map<
		string,
		Array<{ startTime: number; endTime: number }>
	>();
	for (const element of visualElements) {
		if (element.type !== "video" || !element.splitScreen) continue;
		const referencedElementIds = new Set(
			[
				...(element.splitScreen.slots ?? []),
				...(element.splitScreen.sections ?? []).flatMap(
					(section) => section.slots ?? [],
				),
			]
				.map((slot) => slot.sourceElementId?.trim() ?? "")
				.filter(
					(sourceElementId) =>
						sourceElementId.length > 0 && sourceElementId !== element.id,
				),
		);
		for (const sourceElementId of referencedElementIds) {
			appendSuppressionRange({
				map: consumedRangesByElementId,
				elementId: sourceElementId,
				startTime: element.startTime,
				endTime: element.startTime + element.duration,
			});
		}
	}
	return consumedRangesByElementId;
}

export function resolveLiveCaptionElementFromTranscriptSource({
	element,
	sourceMedia,
}: {
	element: TextElement;
	sourceMedia: VideoElement | AudioElement;
}): TextElement | null {
	const transcriptDraft = getTranscriptDraft(sourceMedia);
	const transcriptApplied = getTranscriptApplied(sourceMedia);
	if (
		!transcriptDraft ||
		transcriptDraft.words.length === 0 ||
		!transcriptApplied
	) {
		return null;
	}
	// Salt snapshot revision with media timing so preview caption timing cannot
	// reuse a stale cache entry after move/trim while transcript words are unchanged.
	const timingRevisionSalt = [
		transcriptDraft.updatedAt,
		sourceMedia.startTime.toFixed(4),
		sourceMedia.duration.toFixed(4),
		sourceMedia.trimStart.toFixed(4),
		sourceMedia.trimEnd.toFixed(4),
	].join("|");
	const snapshot = buildTranscriptTimelineSnapshot({
		mediaElementId: sourceMedia.id,
		transcriptVersion: transcriptDraft.version,
		updatedAt: timingRevisionSalt,
		words: transcriptDraft.words,
		cuts: transcriptApplied.removedRanges,
		gapEdits: transcriptDraft.gapEdits,
		mediaStartTime: sourceMedia.startTime,
		mediaDuration: sourceMedia.duration,
	});
	if (!snapshot.captionPayload) {
		return null;
	}
	const startTime = snapshot.captionPayload.startTime;
	const timings = snapshot.captionPayload.wordTimings;
	const clipStartTime = sourceMedia.startTime;
	const clipEndTime = sourceMedia.startTime + sourceMedia.duration;
	const rawVisibilityWindows = transcriptApplied.keptSegments
		.map((segment) => ({
			startTime: Math.max(
				clipStartTime,
				sourceMedia.startTime + snapshot.timeMap.toCompressedTime(segment.start),
			),
			endTime: Math.min(
				clipEndTime,
				sourceMedia.startTime + snapshot.timeMap.toCompressedTime(segment.end),
			),
		}))
		.filter((segment) => segment.endTime - segment.startTime > 0.001);
	const visibilityWindows = rawVisibilityWindows.reduce<
		Array<{ startTime: number; endTime: number }>
	>((merged, segment) => {
		const previous = merged[merged.length - 1];
		if (
			previous &&
			Math.abs(previous.endTime - segment.startTime) <= 0.01
		) {
			previous.endTime = Math.max(previous.endTime, segment.endTime);
			return merged;
		}
		merged.push({ ...segment });
		return merged;
	}, []);

	return {
		...element,
		content: snapshot.captionPayload.content,
		startTime,
		duration: snapshot.captionPayload.duration,
		captionWordTimings: timings,
		captionVisibilityWindows: visibilityWindows,
		captionSourceRef: {
			mediaElementId: sourceMedia.id,
			transcriptVersion: transcriptDraft.version,
		},
	};
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	backgroundReferenceCanvasSize?: TCanvasSize;
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	brandOverlays?: TBrandOverlays;
	isPreview?: boolean;
	previewFrameRateCap?: number;
	previewProxyScale?: number;
	videoCache?: VideoCache;
};

export function buildScene(params: BuildSceneParams) {
	const { mediaAssets, duration, canvasSize, background } = params;
	const tracks = params.tracks;

	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));

	const visibleTracks = tracks.filter(
		(track) => !("hidden" in track && track.hidden),
	);

	const orderedTracksTopToBottom = [
		...visibleTracks.filter((track) => !isMainTrack(track)),
		...visibleTracks.filter((track) => isMainTrack(track)),
	];

	const orderedTracksBottomToTop = orderedTracksTopToBottom.slice().reverse();

	const contentNodes = [];
	const mediaElementById = new Map<string, VideoElement | AudioElement>();
	const visualElementById = new Map<string, VisualMediaElement>();
	const transcriptMediaCandidates: Array<VideoElement | AudioElement> = [];
	const visualElements: VisualMediaElement[] = [];
	for (const track of tracks) {
		for (const element of track.elements) {
			if (element.type === "video" || element.type === "image") {
				const normalizedVisualElement =
					normalizeTimelineElementForInvariants({
						element,
					}) as VisualMediaElement;
				visualElementById.set(normalizedVisualElement.id, normalizedVisualElement);
				visualElements.push(normalizedVisualElement);
			}
			if (!isEditableMediaElement(element)) continue;
			const normalizedElement = normalizeTimelineElementForInvariants({
				element,
			});
			mediaElementById.set(normalizedElement.id, normalizedElement);
			if ((getTranscriptDraft(normalizedElement)?.words.length ?? 0) > 0) {
				transcriptMediaCandidates.push(normalizedElement);
			}
		}
	}
	const consumedRangesByElementId = buildConsumedRangesByElementId({
		visualElements,
	});
	const getSuppressDuringRanges = ({
		elementId,
	}: {
		elementId: string;
	}) => consumedRangesByElementId.get(elementId);
	const buildVisualNodeForElement = ({
		element,
		suppressDuringRanges,
		forceIgnoreSplitScreen = false,
	}: {
		element: VisualMediaElement;
		suppressDuringRanges?: Array<{ startTime: number; endTime: number }>;
		forceIgnoreSplitScreen?: boolean;
	}) => {
		const mediaAsset = mediaMap.get(element.mediaId);
		if (!mediaAsset) return null;
		const resolvedFile = mediaAsset.file;
		const resolvedUrl = mediaAsset.url;
		if (!resolvedFile || !resolvedUrl) {
			return null;
		}
		if (mediaAsset.type === "video") {
			if (element.type !== "video") return null;
			if (!forceIgnoreSplitScreen && hasExternalSplitSource({ element })) {
				const externalSlotNodesByElementId = new Map<string, ImageNode | VideoNode>();
				const referencedElementIds = new Set(
					[
						...(element.splitScreen?.slots ?? []),
						...(element.splitScreen?.sections ?? []).flatMap(
							(section) => section.slots ?? [],
						),
					]
						.map((slot) => slot.sourceElementId?.trim() ?? "")
						.filter(
							(sourceElementId) =>
								sourceElementId.length > 0 && sourceElementId !== element.id,
						),
				);
				for (const sourceElementId of referencedElementIds) {
					const sourceElement = visualElementById.get(sourceElementId);
					if (!sourceElement) continue;
					const sourceNode = buildVisualNodeForElement({
						element: sourceElement,
						forceIgnoreSplitScreen: true,
					});
					if (
						sourceNode instanceof VideoNode ||
						sourceNode instanceof ImageNode
					) {
						externalSlotNodesByElementId.set(sourceElementId, sourceNode);
					}
				}
				return new SplitScreenNode({
					mediaId: mediaAsset.id,
					url: resolvedUrl,
					file: resolvedFile,
					videoCache: params.videoCache,
					duration: element.duration,
					timeOffset: element.startTime,
					trimStart: element.trimStart,
					trimEnd: element.trimEnd,
					transcriptCuts: getTranscriptApplied(element)?.removedRanges ?? [],
					transform: element.transform,
					reframePresets: element.reframePresets,
					reframeSwitches: element.reframeSwitches,
					defaultReframePresetId: element.defaultReframePresetId,
					splitScreen: element.splitScreen,
					opacity: element.opacity,
					blendMode: element.blendMode,
					animations: element.animations,
					transitions: element.transitions,
					suppressDuringRanges,
					frameRateCap: params.previewFrameRateCap,
					...(params.isPreview && {
						previewProxyScale: params.previewProxyScale,
					}),
					externalSlotNodesByElementId,
				});
			}
			return new VideoNode({
				mediaId: mediaAsset.id,
				url: resolvedUrl,
				file: resolvedFile,
				videoCache: params.videoCache,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				transcriptCuts: getTranscriptApplied(element)?.removedRanges ?? [],
				transform: element.transform,
				reframePresets: element.reframePresets,
				reframeSwitches: element.reframeSwitches,
				defaultReframePresetId: element.defaultReframePresetId,
				splitScreen: forceIgnoreSplitScreen ? undefined : element.splitScreen,
				opacity: element.opacity,
				blendMode: element.blendMode,
				animations: element.animations,
				transitions: element.transitions,
				suppressDuringRanges,
				frameRateCap: params.previewFrameRateCap,
				...(params.isPreview && {
					previewProxyScale: params.previewProxyScale,
				}),
			});
		}
		if (mediaAsset.type !== "image") return null;
		return new ImageNode({
			url: resolvedUrl,
			duration: element.duration,
			timeOffset: element.startTime,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			transform: element.transform,
			opacity: element.opacity,
			blendMode: element.blendMode,
			animations: element.animations,
			transitions: element.transitions,
			suppressDuringRanges,
			...(params.isPreview && {
				maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
			}),
		});
	};

	for (const track of orderedTracksBottomToTop) {
		const elements = track.elements
			.filter((element) => !("hidden" in element && element.hidden))
			.slice()
			.sort((a, b) => {
				if (a.startTime !== b.startTime) return a.startTime - b.startTime;
				return a.id.localeCompare(b.id);
			});

		for (const element of elements) {
			const stableElement = normalizeTimelineElementForInvariants({ element });
			if (stableElement.type === "video" || stableElement.type === "image") {
				const visualNode = buildVisualNodeForElement({
					element: stableElement,
					suppressDuringRanges: getSuppressDuringRanges({
						elementId: stableElement.id,
					}),
				});
				if (visualNode) {
					contentNodes.push(visualNode);
				}
			}

			if (stableElement.type === "text") {
				const sourceMediaId = stableElement.captionSourceRef?.mediaElementId;
				const sourceMediaFromRef = sourceMediaId
					? mediaElementById.get(sourceMediaId)
					: null;
				const sourceMediaFromRefOrCompanion =
					sourceMediaFromRef && isEditableMediaElement(sourceMediaFromRef)
						? (getTranscriptDraft(sourceMediaFromRef)?.words.length ?? 0) > 0
							? sourceMediaFromRef
							: resolveTranscriptCompanionForCaptionSource({
									sourceMedia: sourceMediaFromRef,
									candidates: transcriptMediaCandidates,
								})
						: null;
				const sourceMedia =
					sourceMediaFromRefOrCompanion ??
					// Heuristic source resolution is only for legacy/unbound caption elements.
					// If a caption has an explicit source ref that no longer exists, treat it as stale.
					(!sourceMediaId
						? resolveCaptionSourceMediaHeuristically({
								element: stableElement,
								candidates: transcriptMediaCandidates,
							})
						: null);
				const captionSourceVideo =
					(sourceMediaFromRef?.type === "video" ? sourceMediaFromRef : null) ??
					(sourceMedia && isEditableMediaElement(sourceMedia)
						? resolveCaptionPlacementVideoCompanion({
								sourceMedia,
								candidates: Array.from(mediaElementById.values()),
							})
						: null);
				const resolvedTextElement =
					sourceMedia && isEditableMediaElement(sourceMedia)
						? resolveLiveCaptionElementFromTranscriptSource({
								element: stableElement,
								sourceMedia,
							})
						: stableElement;
				if (!resolvedTextElement) {
					continue;
				}
				contentNodes.push(
					new TextNode({
						...resolvedTextElement,
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasWidth: canvasSize.width,
						canvasHeight: canvasSize.height,
						...(captionSourceVideo
							? {
									captionSourceVideo: {
										startTime: captionSourceVideo.startTime,
										duration: captionSourceVideo.duration,
										trimStart: captionSourceVideo.trimStart,
										reframePresets: captionSourceVideo.reframePresets,
										reframeSwitches: captionSourceVideo.reframeSwitches,
										defaultReframePresetId:
											captionSourceVideo.defaultReframePresetId,
										splitScreen: captionSourceVideo.splitScreen,
									},
								}
							: {}),
						backgroundReferenceCanvasHeight:
							params.backgroundReferenceCanvasSize?.height ?? canvasSize.height,
						textBaseline: "middle",
					}),
				);
			}

			if (stableElement.type === "sticker") {
				contentNodes.push(
					new StickerNode({
						stickerId: stableElement.stickerId,
						duration: stableElement.duration,
						timeOffset: stableElement.startTime,
						trimStart: stableElement.trimStart,
						trimEnd: stableElement.trimEnd,
						transform: stableElement.transform,
						opacity: stableElement.opacity,
						blendMode: stableElement.blendMode,
						animations: stableElement.animations,
						transitions: stableElement.transitions,
					}),
				);
			}
		}
	}

	const overlayNodes = [];
	const logoOverlay = params.brandOverlays?.logo ?? DEFAULT_BRAND_OVERLAYS.logo;
	if (logoOverlay.enabled) {
		const legacyMediaId =
			(logoOverlay as unknown as { mediaId?: string | null }).mediaId ?? null;
		const legacyAsset = legacyMediaId ? mediaMap.get(legacyMediaId) : null;
		const logoUrl = logoOverlay.sourceUrl ?? legacyAsset?.url ?? null;
		if (logoUrl) {
			overlayNodes.push(
				new ImageNode({
					url: logoUrl,
					duration,
					timeOffset: 0,
					trimStart: 0,
					trimEnd: 0,
					transform: resolveLogoOverlayTransform({
						preset: logoOverlay.preset,
						scaleMultiplier: logoOverlay.scale ?? 1,
						canvasSize,
						mediaWidth: logoOverlay.sourceWidth ?? legacyAsset?.width,
						mediaHeight: logoOverlay.sourceHeight ?? legacyAsset?.height,
					}),
					opacity: 1,
					blendMode: "normal",
					...(params.isPreview && {
						maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
					}),
				}),
			);
		}
	}

	if (background.type === "blur") {
		rootNode.add(
			new BlurBackgroundNode({
				blurIntensity: background.blurIntensity ?? DEFAULT_BLUR_INTENSITY,
				blurScale: background.blurScale,
				contentNodes,
			}),
		);
		for (const node of contentNodes) {
			rootNode.add(node);
		}
		for (const node of overlayNodes) {
			rootNode.add(node);
		}
	} else {
		if (background.type === "color" && background.color !== "transparent") {
			rootNode.add(new ColorNode({ color: background.color }));
		}
		for (const node of contentNodes) {
			rootNode.add(node);
		}
		for (const node of overlayNodes) {
			rootNode.add(node);
		}
	}

	return rootNode;
}
