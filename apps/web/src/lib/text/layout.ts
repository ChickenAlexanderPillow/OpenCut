import { DEFAULT_TEXT_BACKGROUND } from "@/constants/text-constants";
import type { TextElement } from "@/types/timeline";

type TextRect = {
	left: number;
	top: number;
	width: number;
	height: number;
};

export type TextBackgroundMode = "block" | "line-fit";

export interface TextBlockMeasurement {
	visualCenterOffset: number;
	height: number;
	maxWidth: number;
}

export function getMetricAscent({
	metrics,
	fallbackFontSize,
}: {
	metrics: TextMetrics;
	fallbackFontSize: number;
}): number {
	return metrics.actualBoundingBoxAscent ?? fallbackFontSize * 0.8;
}

export function getMetricDescent({
	metrics,
	fallbackFontSize,
}: {
	metrics: TextMetrics;
	fallbackFontSize: number;
}): number {
	return metrics.actualBoundingBoxDescent ?? fallbackFontSize * 0.2;
}

export function measureTextBlock({
	lineMetrics,
	lineHeightPx,
	fallbackFontSize,
}: {
	lineMetrics: TextMetrics[];
	lineHeightPx: number;
	fallbackFontSize: number;
}): TextBlockMeasurement {
	let top = Number.POSITIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	let maxWidth = 0;

	for (let index = 0; index < lineMetrics.length; index++) {
		const metrics = lineMetrics[index];
		const lineY = index * lineHeightPx;
		top = Math.min(top, lineY - getMetricAscent({ metrics, fallbackFontSize }));
		bottom = Math.max(
			bottom,
			lineY + getMetricDescent({ metrics, fallbackFontSize }),
		);
		maxWidth = Math.max(maxWidth, metrics.width);
	}

	const height = bottom - top;
	const visualCenterOffset = (top + bottom) / 2;

	return { visualCenterOffset, height, maxWidth };
}

function getTextRect({
	textAlign,
	block,
}: {
	textAlign: TextElement["textAlign"];
	block: TextBlockMeasurement;
}): TextRect {
	const left =
		textAlign === "left"
			? 0
			: textAlign === "right"
				? -block.maxWidth
				: -block.maxWidth / 2;

	return {
		left,
		top: -block.height / 2,
		width: block.maxWidth,
		height: block.height,
	};
}

function isTextBackgroundVisible({
	background,
}: {
	background: TextElement["background"];
}): boolean {
	return Boolean(background.color) && background.color !== "transparent";
}

export function getTextBackgroundRect({
	textAlign,
	block,
	background,
	fontSizeRatio = 1,
}: {
	textAlign: TextElement["textAlign"];
	block: TextBlockMeasurement;
	background: TextElement["background"];
	fontSizeRatio?: number;
}): TextRect | null {
	if (!isTextBackgroundVisible({ background })) {
		return null;
	}

	const textRect = getTextRect({ textAlign, block });
	const paddingX =
		(background.paddingX ?? DEFAULT_TEXT_BACKGROUND.paddingX) * fontSizeRatio;
	const paddingY =
		(background.paddingY ?? DEFAULT_TEXT_BACKGROUND.paddingY) * fontSizeRatio;
	const offsetX = background.offsetX ?? DEFAULT_TEXT_BACKGROUND.offsetX;
	const offsetY = background.offsetY ?? DEFAULT_TEXT_BACKGROUND.offsetY;

	return {
		left: textRect.left - paddingX + offsetX,
		top: textRect.top - paddingY + offsetY,
		width: textRect.width + paddingX * 2,
		height: textRect.height + paddingY * 2,
	};
}

export function getTextVisualRect({
	textAlign,
	block,
	background,
	fontSizeRatio = 1,
}: {
	textAlign: TextElement["textAlign"];
	block: TextBlockMeasurement;
	background: TextElement["background"];
	fontSizeRatio?: number;
}): TextRect {
	const textRect = getTextRect({ textAlign, block });
	const backgroundRect = getTextBackgroundRect({
		textAlign,
		block,
		background,
		fontSizeRatio,
	});

	if (!backgroundRect) {
		return textRect;
	}

	const left = Math.min(textRect.left, backgroundRect.left);
	const top = Math.min(textRect.top, backgroundRect.top);
	const right = Math.max(
		textRect.left + textRect.width,
		backgroundRect.left + backgroundRect.width,
	);
	const bottom = Math.max(
		textRect.top + textRect.height,
		backgroundRect.top + backgroundRect.height,
	);

	return {
		left,
		top,
		width: right - left,
		height: bottom - top,
	};
}

function getLineLeft({
	textAlign,
	lineWidth,
}: {
	textAlign: TextElement["textAlign"];
	lineWidth: number;
}): number {
	if (textAlign === "left") return 0;
	if (textAlign === "right") return -lineWidth;
	return -lineWidth / 2;
}

export function getLineFitBackgroundRects({
	textAlign,
	block,
	lineMetrics,
	lineHeightPx,
	fallbackFontSize,
	background,
	fontSizeRatio = 1,
}: {
	textAlign: TextElement["textAlign"];
	block: TextBlockMeasurement;
	lineMetrics: TextMetrics[];
	lineHeightPx: number;
	fallbackFontSize: number;
	background: TextElement["background"];
	fontSizeRatio?: number;
}): TextRect[] {
	if (!isTextBackgroundVisible({ background })) {
		return [];
	}

	const paddingX =
		(background.paddingX ?? DEFAULT_TEXT_BACKGROUND.paddingX) * fontSizeRatio;
	const paddingY =
		(background.paddingY ?? DEFAULT_TEXT_BACKGROUND.paddingY) * fontSizeRatio;
	const offsetX = background.offsetX ?? DEFAULT_TEXT_BACKGROUND.offsetX;
	const offsetY = background.offsetY ?? DEFAULT_TEXT_BACKGROUND.offsetY;
	const baseAscent = fallbackFontSize * 0.8;
	const baseDescent = fallbackFontSize * 0.2;
	const uniformGlyphHeight = baseAscent + baseDescent;
	const uniformHeight = uniformGlyphHeight + paddingY * 2;

	return lineMetrics.map((metrics, index) => {
		const lineY = index * lineHeightPx - block.visualCenterOffset;
		const lineLeft = getLineLeft({
			textAlign,
			lineWidth: metrics.width,
		});
		return {
			left: lineLeft - paddingX + offsetX,
			top: lineY - uniformGlyphHeight / 2 - paddingY + offsetY,
			width: Math.max(0, metrics.width + paddingX * 2),
			height: Math.max(0, uniformHeight),
		};
	});
}

export function getTextVisualRectForBackgroundMode({
	textAlign,
	block,
	lineMetrics,
	lineHeightPx,
	fallbackFontSize,
	background,
	backgroundMode = "block",
	fontSizeRatio = 1,
}: {
	textAlign: TextElement["textAlign"];
	block: TextBlockMeasurement;
	lineMetrics: TextMetrics[];
	lineHeightPx: number;
	fallbackFontSize: number;
	background: TextElement["background"];
	backgroundMode?: TextBackgroundMode;
	fontSizeRatio?: number;
}): TextRect {
	if (backgroundMode !== "line-fit") {
		return getTextVisualRect({
			textAlign,
			block,
			background,
			fontSizeRatio,
		});
	}

	const textRect = getTextRect({ textAlign, block });
	const rects = getLineFitBackgroundRects({
		textAlign,
		block,
		lineMetrics,
		lineHeightPx,
		fallbackFontSize,
		background,
		fontSizeRatio,
	});

	if (rects.length === 0) return textRect;

	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;

	for (const rect of rects) {
		left = Math.min(left, rect.left);
		top = Math.min(top, rect.top);
		right = Math.max(right, rect.left + rect.width);
		bottom = Math.max(bottom, rect.top + rect.height);
	}

	left = Math.min(left, textRect.left);
	top = Math.min(top, textRect.top);
	right = Math.max(right, textRect.left + textRect.width);
	bottom = Math.max(bottom, textRect.top + textRect.height);

	return {
		left,
		top,
		width: right - left,
		height: bottom - top,
	};
}

export function resolveTextPlacement({
	canvasWidth,
	canvasHeight,
	positionX,
	positionY,
	scale,
	visualRect,
	fitInCanvas,
}: {
	canvasWidth: number;
	canvasHeight: number;
	positionX: number;
	positionY: number;
	scale: number;
	visualRect: TextRect;
	fitInCanvas?: boolean;
}): { x: number; y: number; effectiveScale: number } {
	let x = positionX;
	let y = positionY;
	let effectiveScale = scale;

	if (!fitInCanvas) {
		return { x, y, effectiveScale };
	}

	const margin = Math.min(canvasWidth, canvasHeight) * 0.04;
	const availableWidth = canvasWidth - margin * 2;
	const availableHeight = canvasHeight - margin * 2;
	const scaledWidth = visualRect.width * effectiveScale;
	const scaledHeight = visualRect.height * effectiveScale;

	if (scaledWidth > 0 && scaledHeight > 0) {
		const fitScale = Math.min(
			1,
			availableWidth / scaledWidth,
			availableHeight / scaledHeight,
		);
		effectiveScale *= fitScale;
	}

	const left = x + visualRect.left * effectiveScale;
	const right = x + (visualRect.left + visualRect.width) * effectiveScale;
	const top = y + visualRect.top * effectiveScale;
	const bottom = y + (visualRect.top + visualRect.height) * effectiveScale;

	if (right - left <= availableWidth) {
		const minX = margin - visualRect.left * effectiveScale;
		const maxX =
			canvasWidth -
			margin -
			(visualRect.left + visualRect.width) * effectiveScale;
		x = Math.min(Math.max(x, minX), maxX);
	} else {
		x = canvasWidth / 2;
	}

	if (bottom - top <= availableHeight) {
		const minY = margin - visualRect.top * effectiveScale;
		const maxY =
			canvasHeight -
			margin -
			(visualRect.top + visualRect.height) * effectiveScale;
		y = Math.min(Math.max(y, minY), maxY);
	} else {
		// Preserve top anchoring behavior when content is taller than available area.
		y = margin - visualRect.top * effectiveScale;
	}

	return { x, y, effectiveScale };
}

export function wrapTextToWidth({
	text,
	maxWidth,
	measure,
}: {
	text: string;
	maxWidth: number;
	measure: (candidate: string) => number;
}): string[] {
	if (!text) return [""];
	if (maxWidth <= 0) return text.split("\n");

	const wrappedLines: string[] = [];
	const paragraphs = text.split("\n");

	for (const paragraph of paragraphs) {
		const words = paragraph.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) {
			wrappedLines.push("");
			continue;
		}

		let currentLine = words[0];
		for (let i = 1; i < words.length; i++) {
			const word = words[i];
			const nextLine = `${currentLine} ${word}`;
			if (measure(nextLine) <= maxWidth) {
				currentLine = nextLine;
				continue;
			}

			wrappedLines.push(currentLine);
			currentLine = word;
		}
		wrappedLines.push(currentLine);
	}

	return wrappedLines;
}
