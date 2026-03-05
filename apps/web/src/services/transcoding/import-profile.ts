export const IMPORT_TRANSCODE_PROFILE = "chrome-h264-aac-1080p30" as const;
export const IMPORT_VIDEO_MAX_DIMENSION = 1080;
export const IMPORT_VIDEO_MAX_FPS = 30;
export const IMPORT_AUDIO_BITRATE = 128_000;

export interface VideoSourceInfo {
	width?: number;
	height?: number;
	fps?: number;
}

export interface ResolvedImportVideoProfile {
	profile: typeof IMPORT_TRANSCODE_PROFILE;
	outputWidth?: number;
	outputHeight?: number;
	targetFps: number;
	videoBitrate: number;
	audioBitrate: number;
}

export function computeCappedEvenDimensions({
	width,
	height,
	maxDimension = IMPORT_VIDEO_MAX_DIMENSION,
}: {
	width?: number;
	height?: number;
	maxDimension?: number;
}): { width?: number; height?: number } {
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return {};
	}

	const scale = Math.min(1, maxDimension / Math.max(width, height));
	const scaledWidth = Math.max(2, Math.floor((width * scale) / 2) * 2);
	const scaledHeight = Math.max(2, Math.floor((height * scale) / 2) * 2);

	return {
		width: scaledWidth,
		height: scaledHeight,
	};
}

export function selectVideoBitrate({
	width,
	height,
}: {
	width?: number;
	height?: number;
}): number {
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return 5_000_000;
	}

	const longEdge = Math.max(width, height);
	if (longEdge <= 854) return 1_800_000;
	if (longEdge <= 1280) return 3_000_000;
	return 5_000_000;
}

function selectVideoBitrateFromSource({
	sourceWidth,
	sourceHeight,
	fallbackWidth,
	fallbackHeight,
}: {
	sourceWidth?: number;
	sourceHeight?: number;
	fallbackWidth?: number;
	fallbackHeight?: number;
}): number {
	if (
		typeof sourceWidth === "number" &&
		typeof sourceHeight === "number" &&
		Number.isFinite(sourceWidth) &&
		Number.isFinite(sourceHeight) &&
		sourceWidth > 0 &&
		sourceHeight > 0
	) {
		const sourceLongEdge = Math.max(sourceWidth, sourceHeight);
		if (sourceLongEdge <= 854) return 1_800_000;
		if (sourceLongEdge <= 1280) return 3_000_000;
		return 5_000_000;
	}

	return selectVideoBitrate({ width: fallbackWidth, height: fallbackHeight });
}

export function normalizeTargetFps({
	fps,
	maxFps = IMPORT_VIDEO_MAX_FPS,
}: {
	fps?: number;
	maxFps?: number;
}): number {
	if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
		return maxFps;
	}
	return Math.max(1, Math.min(maxFps, Math.round(fps)));
}

export function resolveImportVideoProfile({
	sourceInfo,
}: {
	sourceInfo?: VideoSourceInfo;
}): ResolvedImportVideoProfile {
	const { width, height } = computeCappedEvenDimensions({
		width: sourceInfo?.width,
		height: sourceInfo?.height,
	});
	const videoBitrate = selectVideoBitrateFromSource({
		sourceWidth: sourceInfo?.width,
		sourceHeight: sourceInfo?.height,
		fallbackWidth: width,
		fallbackHeight: height,
	});
	const targetFps = normalizeTargetFps({ fps: sourceInfo?.fps });

	return {
		profile: IMPORT_TRANSCODE_PROFILE,
		outputWidth: width,
		outputHeight: height,
		targetFps,
		videoBitrate,
		audioBitrate: IMPORT_AUDIO_BITRATE,
	};
}
