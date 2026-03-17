import type { MediaAsset } from "@/types/assets";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

const DEFAULT_PORTRAIT_FALLBACK_SCALE = 3.2;
const SCALE_EPSILON = 0.0001;

export function getVideoCoverScaleMultiplier({
	canvasSize,
	sourceWidth,
	sourceHeight,
}: {
	canvasSize: { width: number; height: number };
	sourceWidth?: number;
	sourceHeight?: number;
}): number {
	if (
		!Number.isFinite(sourceWidth) ||
		!Number.isFinite(sourceHeight) ||
		(sourceWidth ?? 0) <= 0 ||
		(sourceHeight ?? 0) <= 0
	) {
		return canvasSize.height > canvasSize.width
			? DEFAULT_PORTRAIT_FALLBACK_SCALE
			: 1;
	}
	const resolvedSourceWidth = sourceWidth ?? 0;
	const resolvedSourceHeight = sourceHeight ?? 0;
	const widthRatio = canvasSize.width / resolvedSourceWidth;
	const heightRatio = canvasSize.height / resolvedSourceHeight;
	if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio)) {
		return 1;
	}
	const containScale = Math.min(widthRatio, heightRatio);
	const coverScale = Math.max(widthRatio, heightRatio);
	if (containScale <= 0) return 1;
	return Math.max(1, coverScale / containScale);
}

function shouldHealLegacyPortraitVideo({
	element,
	mediaAsset,
	canvasSize,
}: {
	element: VideoElement;
	mediaAsset: MediaAsset | undefined;
	canvasSize: { width: number; height: number };
}): boolean {
	if (canvasSize.height <= canvasSize.width) return false;
	if (element.transform.rotate !== 0) return false;
	if (
		Math.abs(element.transform.position.x) > SCALE_EPSILON ||
		Math.abs(element.transform.position.y) > SCALE_EPSILON
	) {
		return false;
	}
	if (Math.abs(element.transform.scale - 1) > SCALE_EPSILON) return false;
	if (mediaAsset?.type !== "video") return false;
	const sourceWidth = mediaAsset.width ?? 0;
	const sourceHeight = mediaAsset.height ?? 0;
	if (sourceWidth > 0 && sourceHeight > 0 && sourceWidth <= sourceHeight) {
		return false;
	}
	const presets = element.reframePresets ?? [];
	if (presets.length === 0) return true;
	return (
		element.reframeSeededBy === "subject-aware-v1" ||
		presets.every((preset) => preset.autoSeeded)
	);
}

export function applyLegacyPortraitVideoCoverFit({
	element,
	mediaAsset,
	canvasSize,
}: {
	element: VideoElement;
	mediaAsset: MediaAsset | undefined;
	canvasSize: { width: number; height: number };
}): VideoElement {
	if (!shouldHealLegacyPortraitVideo({ element, mediaAsset, canvasSize })) {
		return element;
	}
	const scaleMultiplier = getVideoCoverScaleMultiplier({
		canvasSize,
		sourceWidth: mediaAsset?.width,
		sourceHeight: mediaAsset?.height,
	});
	if (scaleMultiplier <= 1 + SCALE_EPSILON) {
		return element;
	}
	return {
		...element,
		transform: {
			...element.transform,
			scale: element.transform.scale * scaleMultiplier,
		},
		reframePresets: element.reframePresets?.map((preset) => ({
			...preset,
			transform: {
				position: {
					x: preset.transform.position.x * scaleMultiplier,
					y: preset.transform.position.y * scaleMultiplier,
				},
				scale: preset.transform.scale * scaleMultiplier,
			},
		})),
	};
}

export function healLegacyPortraitVideoCoverFitInTracks({
	tracks,
	mediaAssets,
	canvasSize,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	canvasSize: { width: number; height: number };
}): {
	changed: boolean;
	tracks: TimelineTrack[];
} {
	const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	let changed = false;
	const nextTracks = tracks.map((track) => {
		if (track.type !== "video") return track;
		let trackChanged = false;
		const elements = track.elements.map((element) => {
			if (element.type !== "video") return element;
			const nextElement = applyLegacyPortraitVideoCoverFit({
				element,
				mediaAsset: mediaById.get(element.mediaId),
				canvasSize,
			});
			if (nextElement !== element) {
				trackChanged = true;
				changed = true;
			}
			return nextElement;
		});
		if (!trackChanged) return track;
		return {
			...track,
			elements,
		};
	});
	return {
		changed,
		tracks: nextTracks,
	};
}
