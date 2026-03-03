export interface SafeAreaPreset {
	id: "youtube-shorts-9x16" | "linkedin-1x1";
	label: string;
	description: string;
	inset: {
		top: number;
		right: number;
		bottom: number;
		left: number;
	};
}

interface RectLike {
	top: number;
	height: number;
}

export const SAFE_AREA_PRESETS: Record<SafeAreaPreset["id"], SafeAreaPreset> = {
	"youtube-shorts-9x16": {
		id: "youtube-shorts-9x16",
		label: "YouTube Shorts safe area (9:16)",
		description:
			"Creator-safe guide: 60px left, 120px right, 240px top, 380px bottom on 1080x1920.",
		inset: {
			top: 240 / 1920,
			right: 120 / 1080,
			bottom: 380 / 1920,
			left: 60 / 1080,
		},
	},
	"linkedin-1x1": {
		id: "linkedin-1x1",
		label: "LinkedIn safe area (1:1)",
		description:
			"LinkedIn does not publish a 1:1 overlay template; uses a conservative 5% inset.",
		inset: {
			top: 0.05,
			right: 0.05,
			bottom: 0.05,
			left: 0.05,
		},
	},
};

function isRatioClose({
	width,
	height,
	target,
	tolerance = 0.015,
}: {
	width: number;
	height: number;
	target: number;
	tolerance?: number;
}): boolean {
	if (width <= 0 || height <= 0) return false;
	return Math.abs(width / height - target) <= tolerance;
}

export function resolveSafeAreaPreset({
	width,
	height,
}: {
	width: number;
	height: number;
}): SafeAreaPreset | null {
	if (isRatioClose({ width, height, target: 9 / 16 })) {
		return SAFE_AREA_PRESETS["youtube-shorts-9x16"];
	}
	if (isRatioClose({ width, height, target: 1 })) {
		return SAFE_AREA_PRESETS["linkedin-1x1"];
	}
	return null;
}

export function resolveSafeAreaAnchoredPositionY({
	canvasWidth,
	canvasHeight,
	transformPositionY,
	scale,
	visualRect,
	anchorToSafeAreaBottom,
	safeAreaBottomOffset = 0,
	anchorToSafeAreaTop,
	safeAreaTopOffset = 0,
}: {
	canvasWidth: number;
	canvasHeight: number;
	transformPositionY: number;
	scale: number;
	visualRect: RectLike;
	anchorToSafeAreaBottom?: boolean;
	safeAreaBottomOffset?: number;
	anchorToSafeAreaTop?: boolean;
	safeAreaTopOffset?: number;
}): number {
	const defaultPositionY = canvasHeight / 2 + transformPositionY;
	if (!anchorToSafeAreaBottom && !anchorToSafeAreaTop) return defaultPositionY;

	const safeArea = resolveSafeAreaPreset({ width: canvasWidth, height: canvasHeight }) ?? {
		id: "linkedin-1x1" as const,
		label: "Generic safe area",
		description: "Fallback 5% inset safe area",
		inset: {
			top: 0.05,
			right: 0.05,
			bottom: 0.05,
			left: 0.05,
		},
	};

	if (anchorToSafeAreaTop) {
		const safeTopY = canvasHeight * safeArea.inset.top;
		return safeTopY - visualRect.top * scale + safeAreaTopOffset;
	}

	const visualBottom = visualRect.top + visualRect.height;
	const safeBottomY = canvasHeight * (1 - safeArea.inset.bottom);

	return safeBottomY - visualBottom * scale - safeAreaBottomOffset;
}
