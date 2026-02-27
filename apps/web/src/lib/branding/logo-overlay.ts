import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { LOGO_OVERLAY_PRESET_CONFIG } from "@/constants/brand-overlay-constants";
import type { TBrandLogoOverlayPreset, TCanvasSize } from "@/types/project";
import type { Transform } from "@/types/timeline";

export function resolveLogoOverlayTransform({
	preset,
	scaleMultiplier = 1,
	canvasSize,
	mediaWidth,
	mediaHeight,
}: {
	preset: TBrandLogoOverlayPreset;
	scaleMultiplier?: number;
	canvasSize: TCanvasSize;
	mediaWidth?: number;
	mediaHeight?: number;
}): Transform {
	const presetConfig = LOGO_OVERLAY_PRESET_CONFIG[preset];
	const sourceWidth = Math.max(1, mediaWidth ?? 1);
	const sourceHeight = Math.max(1, mediaHeight ?? 1);
	const containScale = Math.min(
		canvasSize.width / sourceWidth,
		canvasSize.height / sourceHeight,
	);
	const clampedScale = Math.max(0.2, Math.min(3, scaleMultiplier));
	const targetWidth = canvasSize.width * presetConfig.widthRatio * clampedScale;
	const scale = Math.max(0.01, targetWidth / (sourceWidth * containScale));
	const renderedWidth = sourceWidth * containScale * scale;
	const renderedHeight = sourceHeight * containScale * scale;
	const marginX = canvasSize.width * presetConfig.marginXRatio;
	const marginY = canvasSize.height * presetConfig.marginYRatio;

	const positionX =
		presetConfig.horizontal === "center"
			? 0
			: presetConfig.horizontal === "right"
				? canvasSize.width / 2 - marginX - renderedWidth / 2
				: -canvasSize.width / 2 + marginX + renderedWidth / 2;
	const positionY =
		presetConfig.vertical === "bottom"
			? canvasSize.height / 2 - marginY - renderedHeight / 2
			: -canvasSize.height / 2 + marginY + renderedHeight / 2;

	return {
		...DEFAULT_TRANSFORM,
		scale,
		position: { x: positionX, y: positionY },
	};
}
