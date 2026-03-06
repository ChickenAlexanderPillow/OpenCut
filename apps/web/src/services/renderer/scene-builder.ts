import type {
	AudioElement,
	TextElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
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
import {
	buildTranscriptTimelineSnapshot,
	getEffectiveTranscriptCutsFromTranscriptEdit,
} from "@/lib/transcript-editor/snapshot";

const PREVIEW_MAX_IMAGE_SIZE = 2048;

function isEditableMediaElement(
	element: unknown,
): element is VideoElement | AudioElement {
	if (!element || typeof element !== "object") return false;
	const candidate = element as { type?: string };
	return candidate.type === "video" || candidate.type === "audio";
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
			Math.min(elementEnd, candidateEnd) - Math.max(element.startTime, candidate.startTime),
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

export function resolveLiveCaptionElementFromTranscriptSource({
	element,
	sourceMedia,
}: {
	element: TextElement;
	sourceMedia: VideoElement | AudioElement;
}): TextElement | null {
	const transcriptEdit = sourceMedia.transcriptEdit;
	if (!transcriptEdit || transcriptEdit.words.length === 0) {
		return null;
	}
	const snapshot = buildTranscriptTimelineSnapshot({
		mediaElementId: sourceMedia.id,
		transcriptVersion: transcriptEdit.version,
		updatedAt: transcriptEdit.updatedAt,
		words: transcriptEdit.words,
		cuts: transcriptEdit.cuts,
		mediaStartTime: sourceMedia.startTime,
		mediaDuration: sourceMedia.duration,
	});
	if (!snapshot.captionPayload) {
		return null;
	}
	const startTime = snapshot.captionPayload.startTime;
	const timings = snapshot.captionPayload.wordTimings;

	return {
		...element,
		content: snapshot.captionPayload.content,
		startTime,
		duration: snapshot.captionPayload.duration,
		captionWordTimings: timings,
		captionSourceRef: {
			mediaElementId: sourceMedia.id,
			transcriptVersion: transcriptEdit.version,
		},
	};
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
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
	const { tracks, mediaAssets, duration, canvasSize, background } = params;

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
	const transcriptMediaCandidates: Array<VideoElement | AudioElement> = [];
	for (const track of tracks) {
		for (const element of track.elements) {
			if (!isEditableMediaElement(element)) continue;
			mediaElementById.set(element.id, element);
			if ((element.transcriptEdit?.words.length ?? 0) > 0) {
				transcriptMediaCandidates.push(element);
			}
		}
	}

	for (const track of orderedTracksBottomToTop) {
		const elements = track.elements
			.filter((element) => !("hidden" in element && element.hidden))
			.slice()
			.sort((a, b) => {
				if (a.startTime !== b.startTime) return a.startTime - b.startTime;
				return a.id.localeCompare(b.id);
			});

		for (const element of elements) {
			if (element.type === "video" || element.type === "image") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset) {
					continue;
				}
				const resolvedFile =
					// Preview decode path uses original media with runtime downscale in video-cache.
					// Some generated proxy encodes decode slower than source on certain systems.
					mediaAsset.file;
				const resolvedUrl =
					mediaAsset.url;
				if (!resolvedFile || !resolvedUrl) {
					continue;
				}

				if (mediaAsset.type === "video") {
					if (element.type !== "video") {
						continue;
					}
					contentNodes.push(
						new VideoNode({
							mediaId: mediaAsset.id,
							url: resolvedUrl,
							file: resolvedFile,
							videoCache: params.videoCache,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transcriptCuts: getEffectiveTranscriptCutsFromTranscriptEdit({
								transcriptEdit: element.transcriptEdit,
							}),
							transform: element.transform,
							opacity: element.opacity,
							blendMode: element.blendMode,
							animations: element.animations,
							frameRateCap: params.previewFrameRateCap,
							...(params.isPreview && {
								previewProxyScale: params.previewProxyScale,
							}),
						}),
					);
				}
				if (mediaAsset.type === "image") {
					contentNodes.push(
						new ImageNode({
							url: resolvedUrl,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transform: element.transform,
							opacity: element.opacity,
							blendMode: element.blendMode,
							animations: element.animations,
							...(params.isPreview && {
								maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
							}),
						}),
					);
				}
			}

			if (element.type === "text") {
				const sourceMediaId = element.captionSourceRef?.mediaElementId;
				const sourceMediaFromRef = sourceMediaId
					? mediaElementById.get(sourceMediaId)
					: null;
				const sourceMedia =
					(sourceMediaFromRef &&
					isEditableMediaElement(sourceMediaFromRef) &&
					(sourceMediaFromRef.transcriptEdit?.words.length ?? 0) > 0
						? sourceMediaFromRef
						: null) ??
					// Heuristic source resolution is only for legacy/unbound caption elements.
					// If a caption has an explicit source ref that no longer exists, treat it as stale.
					(!sourceMediaId
						? resolveCaptionSourceMediaHeuristically({
								element,
								candidates: transcriptMediaCandidates,
						  })
						: null);
				const resolvedTextElement =
					sourceMedia && isEditableMediaElement(sourceMedia)
						? resolveLiveCaptionElementFromTranscriptSource({
								element,
								sourceMedia,
							})
						: element;
				if (!resolvedTextElement) {
					continue;
				}
				contentNodes.push(
					new TextNode({
						...resolvedTextElement,
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasWidth: canvasSize.width,
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
					}),
				);
			}

			if (element.type === "sticker") {
				contentNodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: element.transform,
						opacity: element.opacity,
						blendMode: element.blendMode,
						animations: element.animations,
					}),
				);
			}
		}
	}

	const overlayNodes = [];
	const logoOverlay =
		params.brandOverlays?.logo ?? DEFAULT_BRAND_OVERLAYS.logo;
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
						mediaWidth:
							logoOverlay.sourceWidth ?? legacyAsset?.width,
						mediaHeight:
							logoOverlay.sourceHeight ?? legacyAsset?.height,
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
