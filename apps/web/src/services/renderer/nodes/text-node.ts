import type { CanvasRenderer } from "../canvas-renderer";
import { BaseNode } from "./base-node";
import type { TextElement, VideoElement } from "@/types/timeline";
import {
	DEFAULT_TEXT_ELEMENT,
	DEFAULT_LINE_HEIGHT,
	FONT_SIZE_SCALE_REFERENCE,
} from "@/constants/text-constants";
import {
	getMetricAscent,
	getMetricDescent,
	getLineFitBackgroundRects,
	getMiddleBaselineCompensation,
	getTextBackgroundRect,
	getTextVisualRectForBackgroundMode,
	measureTextBlock,
	resolveTextPlacement,
	wrapTextToWidth,
} from "@/lib/text/layout";
import { resolveSafeAreaAnchoredPositionY } from "@/constants/safe-area-constants";
import { toTimelineCaptionWordTimings } from "@/lib/captions/timing";
import { MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS } from "@/lib/transcript-editor/constants";
import {
	getVideoSplitScreenDividers,
	getVideoSplitScreenViewports,
	resolveVideoSplitScreenAtTime,
} from "@/lib/reframe/video-reframe";

const MIN_CAPTION_FINAL_STATE_HOLD_SECONDS = 0.4;

function scaleFontSize({
	fontSize,
	canvasHeight,
}: {
	fontSize: number;
	canvasHeight: number;
}): number {
	return fontSize * (canvasHeight / FONT_SIZE_SCALE_REFERENCE);
}

function getBackgroundFontSizeRatio({
	fontSize,
	canvasHeight,
	referenceCanvasHeight,
}: {
	fontSize: number;
	canvasHeight: number;
	referenceCanvasHeight?: number;
}): number {
	const referenceHeight =
		referenceCanvasHeight && referenceCanvasHeight > 0
			? referenceCanvasHeight
			: canvasHeight;
	return (
		(fontSize / DEFAULT_TEXT_ELEMENT.fontSize) *
		(canvasHeight / referenceHeight)
	);
}

function quoteFontFamily({ fontFamily }: { fontFamily: string }): string {
	return `"${fontFamily.replace(/"/g, '\\"')}"`;
}

function clampUnitOpacity(value: number | undefined, fallback = 1): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(1, value as number));
}

function degreesToRadians(value: number | undefined): number {
	return ((Number.isFinite(value) ? (value as number) : 90) * Math.PI) / 180;
}

function resetCanvasShadow({
	ctx,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}): void {
	ctx.shadowColor = "transparent";
	ctx.shadowBlur = 0;
	ctx.shadowOffsetX = 0;
	ctx.shadowOffsetY = 0;
}

function drawTextFillWithEffects({
	ctx,
	text,
	x,
	y,
	fillStyle,
	shadowColor,
	shadowOpacity,
	shadowDistance,
	shadowAngle,
	shadowSoftness,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	text: string;
	x: number;
	y: number;
	fillStyle: string;
	shadowColor: string;
	shadowOpacity: number;
	shadowDistance: number;
	shadowAngle: number;
	shadowSoftness: number;
}): void {
	const resolvedShadowOpacity = clampUnitOpacity(shadowOpacity, 0);
	const resolvedShadowDistance = Math.max(0, shadowDistance);
	const resolvedShadowSoftness = Math.max(0, shadowSoftness);
	if (
		resolvedShadowOpacity > 0 &&
		(resolvedShadowDistance > 0 || resolvedShadowSoftness > 0)
	) {
		const previousAlpha = ctx.globalAlpha;
		const angle = degreesToRadians(shadowAngle);
		ctx.save();
		ctx.fillStyle = shadowColor;
		ctx.globalAlpha = previousAlpha * resolvedShadowOpacity;
		resetCanvasShadow({ ctx });
		ctx.shadowColor = shadowColor;
		ctx.shadowBlur = resolvedShadowSoftness;
		ctx.fillText(
			text,
			x + Math.cos(angle) * resolvedShadowDistance,
			y + Math.sin(angle) * resolvedShadowDistance,
		);
		ctx.restore();
		ctx.globalAlpha = previousAlpha;
	}

	ctx.save();
	ctx.fillStyle = fillStyle;
	resetCanvasShadow({ ctx });
	ctx.fillText(text, x, y);
	ctx.restore();
}

function drawTextStroke({
	ctx,
	text,
	x,
	y,
	strokeStyle,
	lineWidth,
	strokeSoftness,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	text: string;
	x: number;
	y: number;
	strokeStyle: string;
	lineWidth: number;
	strokeSoftness: number;
}): void {
	if (!(lineWidth > 0)) return;
	ctx.save();
	ctx.strokeStyle = strokeStyle;
	ctx.lineWidth = lineWidth;
	ctx.lineJoin = "round";
	ctx.miterLimit = 2;
	resetCanvasShadow({ ctx });
	if (strokeSoftness > 0) {
		ctx.shadowColor = strokeStyle;
		ctx.shadowBlur = strokeSoftness;
	}
	ctx.strokeText(text, x, y);
	ctx.restore();
}

function drawTextDecoration({
	ctx,
	textDecoration,
	lineWidth,
	lineY,
	lineX,
	metrics,
	scaledFontSize,
	textAlign,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	textDecoration: string;
	lineWidth: number;
	lineY: number;
	lineX: number;
	metrics: TextMetrics;
	scaledFontSize: number;
	textAlign: CanvasTextAlign;
}): void {
	if (textDecoration === "none" || !textDecoration) return;

	const thickness = Math.max(1, scaledFontSize * 0.07);
	const ascent = getMetricAscent({ metrics, fallbackFontSize: scaledFontSize });
	const descent = getMetricDescent({
		metrics,
		fallbackFontSize: scaledFontSize,
	});

	let xStart = -lineWidth / 2;
	if (textAlign === "left") xStart = 0;
	if (textAlign === "right") xStart = -lineWidth;
	xStart += lineX;

	if (textDecoration === "underline") {
		const underlineY = lineY + descent + thickness;
		ctx.fillRect(xStart, underlineY, lineWidth, thickness);
	}

	if (textDecoration === "line-through") {
		const strikeY = lineY - (ascent - descent) * 0.35;
		ctx.fillRect(xStart, strikeY, lineWidth, thickness);
	}
}

function getLineLeft({
	textAlign,
	lineWidth,
}: {
	textAlign: CanvasTextAlign;
	lineWidth: number;
}): number {
	if (textAlign === "left" || textAlign === "start") return 0;
	if (textAlign === "right" || textAlign === "end") return -lineWidth;
	return -lineWidth / 2;
}

function clampWordCount(value: number): number {
	return Math.max(1, Math.min(12, Math.round(value)));
}

function clampLineCount(value: number): number {
	return Math.max(1, Math.min(4, Math.round(value)));
}

function clampOpacity(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function easeInQuad(t: number): number {
	return t * t;
}

function resolveLatestStartedWordIndex({
	captionWordTimings,
	time,
}: {
	captionWordTimings: Array<{ startTime: number }>;
	time: number;
}): number {
	for (let i = captionWordTimings.length - 1; i >= 0; i--) {
		if (time >= captionWordTimings[i].startTime) {
			return i;
		}
	}
	return -1;
}

function resolveActiveWordIndex({
	captionWordTimings,
	time,
}: {
	captionWordTimings: Array<{ startTime: number; endTime: number }>;
	time: number;
}): number {
	for (let i = captionWordTimings.length - 1; i >= 0; i--) {
		const timing = captionWordTimings[i];
		const nextTiming = captionWordTimings[i + 1];
		let effectiveEndTime = timing.endTime;
		if (nextTiming && nextTiming.startTime < effectiveEndTime) {
			effectiveEndTime =
				nextTiming.startTime > timing.startTime
					? nextTiming.startTime
					: Math.min(effectiveEndTime, nextTiming.endTime);
		}
		effectiveEndTime = Math.max(timing.startTime + 0.01, effectiveEndTime);
		if (time >= timing.startTime && time < effectiveEndTime) {
			return i;
		}
	}
	return -1;
}

function resolveKaraokeActiveWordIndex({
	captionWordTimings,
	time,
}: {
	captionWordTimings: Array<{ startTime: number; endTime: number }>;
	time: number;
}): number {
	const strictActiveWordIndex = resolveActiveWordIndex({
		captionWordTimings,
		time,
	});
	if (strictActiveWordIndex !== -1) {
		return strictActiveWordIndex;
	}
	const latestStartedWordIndex = resolveLatestStartedWordIndex({
		captionWordTimings,
		time,
	});
	if (latestStartedWordIndex === -1) {
		return -1;
	}
	const latestStartedWord = captionWordTimings[latestStartedWordIndex];
	const nextWord = captionWordTimings[latestStartedWordIndex + 1];
	if (!latestStartedWord || !nextWord) {
		return -1;
	}
	const gapSeconds = nextWord.startTime - latestStartedWord.endTime;
	if (
		gapSeconds > 0 &&
		gapSeconds < MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS &&
		time >= latestStartedWord.endTime &&
		time < nextWord.startTime
	) {
		return latestStartedWordIndex;
	}
	return -1;
}

function resolveActiveWordIndices({
	captionWordTimings,
	time,
}: {
	captionWordTimings: Array<{ startTime: number; endTime: number }>;
	time: number;
}): number[] {
	const indices: number[] = [];
	for (let i = 0; i < captionWordTimings.length; i++) {
		const timing = captionWordTimings[i];
		const nextTiming = captionWordTimings[i + 1];
		let effectiveEndTime = timing.endTime;
		if (nextTiming && nextTiming.startTime < effectiveEndTime) {
			effectiveEndTime =
				nextTiming.startTime > timing.startTime
					? nextTiming.startTime
					: Math.min(effectiveEndTime, nextTiming.endTime);
		}
		effectiveEndTime = Math.max(timing.startTime + 0.01, effectiveEndTime);
		if (time >= timing.startTime && time < effectiveEndTime) {
			indices.push(i);
		}
	}
	return indices;
}

type CaptionRenderToken = {
	word: string;
	hidden?: boolean;
};

function buildLineTokenGroups({
	tokens,
	maxLines,
	maxWidth,
	measure,
}: {
	tokens: CaptionRenderToken[];
	maxLines: number;
	maxWidth?: number;
	measure?: (candidate: string) => number;
}): CaptionRenderToken[][] {
	if (tokens.length === 0) return [];
	const clampedMaxLines = clampLineCount(maxLines);
	const singleLine = [tokens];

	if (
		clampedMaxLines === 1 ||
		tokens.length === 1 ||
		!measure ||
		!Number.isFinite(maxWidth) ||
		(maxWidth ?? 0) <= 0
	) {
		return singleLine;
	}

	if (measure(stringifyVisibleLineTokens(tokens)) <= (maxWidth ?? 0)) {
		return singleLine;
	}

	const maxAllowedLines = Math.min(clampedMaxLines, tokens.length);
	const sliceCache = new Map<string, { tokens: CaptionRenderToken[]; width: number }>();
	const getSlice = (start: number, end: number) => {
		const key = `${start}:${end}`;
		const cached = sliceCache.get(key);
		if (cached) return cached;
		const sliceTokens = tokens.slice(start, end);
		const next = {
			tokens: sliceTokens,
			width: measure(stringifyVisibleLineTokens(sliceTokens)),
		};
		sliceCache.set(key, next);
		return next;
	};

	const buildBestSplitForLineCount = (
		lineCount: number,
	): CaptionRenderToken[][] | null => {
		let bestGroups: CaptionRenderToken[][] | null = null;
		let bestWidestLineWidth = Number.POSITIVE_INFINITY;
		let bestBalancePenalty = Number.POSITIVE_INFINITY;

		const visit = (
			start: number,
			remainingLines: number,
			groups: CaptionRenderToken[][],
		) => {
			if (remainingLines === 1) {
				const slice = getSlice(start, tokens.length);
				if (slice.width > (maxWidth ?? 0)) return;
				const nextGroups = [...groups, slice.tokens];
				const lineWidths = nextGroups.map((group) =>
					measure(stringifyVisibleLineTokens(group)),
				);
				const widestLineWidth = Math.max(...lineWidths);
				const balancePenalty = lineWidths.reduce(
					(total, width) => total + Math.abs(widestLineWidth - width),
					0,
				);
				if (
					widestLineWidth < bestWidestLineWidth ||
					(widestLineWidth === bestWidestLineWidth &&
						balancePenalty < bestBalancePenalty)
				) {
					bestGroups = nextGroups;
					bestWidestLineWidth = widestLineWidth;
					bestBalancePenalty = balancePenalty;
				}
				return;
			}

			const maxEnd = tokens.length - (remainingLines - 1);
			for (let end = start + 1; end <= maxEnd; end++) {
				const slice = getSlice(start, end);
				if (slice.width > (maxWidth ?? 0)) continue;
				visit(end, remainingLines - 1, [...groups, slice.tokens]);
			}
		};

		visit(0, lineCount, []);
		return bestGroups;
	};

	for (let lineCount = 2; lineCount <= maxAllowedLines; lineCount++) {
		const split = buildBestSplitForLineCount(lineCount);
		if (split) {
			return split;
		}
	}

	const fallbackLineCount = Math.min(maxAllowedLines, tokens.length);
	const wordsPerLine = Math.ceil(tokens.length / fallbackLineCount);
	const groups: CaptionRenderToken[][] = [];
	for (let i = 0; i < tokens.length; i += wordsPerLine) {
		groups.push(tokens.slice(i, i + wordsPerLine));
	}
	return groups;
}

function stringifyVisibleLineTokens(tokens: CaptionRenderToken[]): string {
	return tokens
		.filter((token) => !token.hidden)
		.map((token) => token.word)
		.join(" ");
}

function isSentenceEndingWord(word: string): boolean {
	const trimmed = word.trim();
	if (!trimmed) return false;
	return /[.!?]["')\]]*$/.test(trimmed);
}

type EffectiveCaptionVisibilityWindow = {
	startTime: number;
	contentEndTime: number;
	renderEndTime: number;
};

function buildEffectiveCaptionVisibilityWindows({
	visibilityWindows,
}: {
	visibilityWindows: Array<{ startTime: number; endTime: number }>;
}): EffectiveCaptionVisibilityWindow[] {
	return visibilityWindows.map((window, index) => {
		const nextWindow = visibilityWindows[index + 1];
		const nextStartTime = nextWindow?.startTime ?? Number.POSITIVE_INFINITY;
		return {
			startTime: window.startTime,
			contentEndTime: window.endTime,
			renderEndTime: Math.min(
				nextStartTime,
				window.endTime + MIN_CAPTION_FINAL_STATE_HOLD_SECONDS,
			),
		};
	});
}

function resolveSentenceBoundedPageSize({
	words,
	start,
	maxPageSize,
}: {
	words: string[];
	start: number;
	maxPageSize: number;
}): number {
	if (maxPageSize <= 1) return Math.max(1, maxPageSize);
	const endExclusive = Math.min(words.length, start + maxPageSize);
	for (let i = start; i < endExclusive; i++) {
		if (isSentenceEndingWord(words[i] ?? "")) {
			return Math.max(1, i - start + 1);
		}
	}
	return maxPageSize;
}

export type TextNodeParams = TextElement & {
	canvasCenter: { x: number; y: number };
	canvasWidth: number;
	canvasHeight: number;
	backgroundReferenceCanvasHeight?: number;
	textBaseline?: CanvasTextBaseline;
	captionSourceVideo?: {
		startTime: number;
		duration: number;
		trimStart: number;
		reframePresets?: VideoElement["reframePresets"];
		reframeSwitches?: VideoElement["reframeSwitches"];
		defaultReframePresetId?: string | null;
		splitScreen?: VideoElement["splitScreen"];
	};
};

type CaptionStyleValue = NonNullable<TextElement["captionStyle"]>;
type DividerPlacement = "above-divider" | "on-divider" | "below-divider";
type CaptionSplitViewport = {
	slotId: string;
	viewportBalance: "balanced" | "unbalanced";
	dividerTopY?: number;
	dividerBottomY?: number;
	dividerCenterY?: number;
	x: number;
	y: number;
	width: number;
	height: number;
};

const DEFAULT_DIVIDER_PLACEMENT: DividerPlacement = "on-divider";
const DIVIDER_PLACEMENT_GAP = 20;

function resolveDividerPlacement(
	value: string | undefined,
): DividerPlacement {
	if (
		value === "above-divider" ||
		value === "on-divider" ||
		value === "below-divider"
	) {
		return value;
	}
	return DEFAULT_DIVIDER_PLACEMENT;
}

function getExplicitDividerPlacement(
	value: string | undefined,
): DividerPlacement | null {
	if (
		value === "above-divider" ||
		value === "on-divider" ||
		value === "below-divider"
	) {
		return value;
	}
	return null;
}

export class TextNode extends BaseNode<TextNodeParams> {
	private cachedCaptionTimingsRef: Array<{
		word: string;
		startTime: number;
		endTime: number;
		hidden?: boolean;
	}> | null = null;
	private cachedCaptionTimingsStartTime = Number.NaN;
	private cachedCaptionTimingsDuration = Number.NaN;
	private cachedTimelineCaptionTimings: Array<{
		word: string;
		startTime: number;
		endTime: number;
		hidden?: boolean;
	}> = [];
	private cachedTimelineCaptionWords: CaptionRenderToken[] = [];

	private getTimelineCaptionTimings(): Array<{
		word: string;
		startTime: number;
		endTime: number;
		hidden?: boolean;
	}> {
		const sourceTimings = this.params.captionWordTimings ?? [];
		if (
			this.cachedCaptionTimingsRef === sourceTimings &&
			this.cachedCaptionTimingsStartTime === this.params.startTime &&
			this.cachedCaptionTimingsDuration === this.params.duration
		) {
			return this.cachedTimelineCaptionTimings;
		}
		this.cachedTimelineCaptionTimings = toTimelineCaptionWordTimings({
			timings: sourceTimings,
			elementStartTime: this.params.startTime,
			elementDuration: this.params.duration,
		});
		this.cachedTimelineCaptionWords = this.cachedTimelineCaptionTimings.map(
			(timing) => ({
				word: timing.word,
				hidden: timing.hidden,
			}),
		);
		this.cachedCaptionTimingsRef = sourceTimings;
		this.cachedCaptionTimingsStartTime = this.params.startTime;
		this.cachedCaptionTimingsDuration = this.params.duration;
		return this.cachedTimelineCaptionTimings;
	}

	private getTimelineCaptionWords(): CaptionRenderToken[] {
		void this.getTimelineCaptionTimings();
		return this.cachedTimelineCaptionWords;
	}

	private resolveEffectiveCaptionPresentation({
		time,
	}: {
		time: number;
	}): {
		captionStyle: CaptionStyleValue;
		fontSize: number;
		background: TextElement["background"];
	} {
		const baseStyle = (this.params.captionStyle ?? {}) as CaptionStyleValue;
		const splitOverrides = baseStyle.splitScreenOverrides;
		if (!splitOverrides || splitOverrides.enabled === false) {
			return {
				captionStyle: baseStyle,
				fontSize: this.params.fontSize,
				background: this.params.background,
			};
		}
		if (!this.resolveActiveSplitViewport({ time, captionStyle: baseStyle })) {
			return {
				captionStyle: baseStyle,
				fontSize: this.params.fontSize,
				background: this.params.background,
			};
		}
		const overrideFontSize =
			typeof splitOverrides.fontSize === "number" &&
			Number.isFinite(splitOverrides.fontSize) &&
			splitOverrides.fontSize > 0
				? splitOverrides.fontSize
				: this.params.fontSize;
		const overridePaddingY =
			typeof splitOverrides.backgroundPaddingY === "number" &&
			Number.isFinite(splitOverrides.backgroundPaddingY)
				? splitOverrides.backgroundPaddingY
				: (this.params.background.paddingY ??
					DEFAULT_TEXT_ELEMENT.background.paddingY);
		return {
			captionStyle: {
				...baseStyle,
				...splitOverrides,
				splitScreenOverrides: splitOverrides,
			},
			fontSize: overrideFontSize,
			background: {
				...this.params.background,
				paddingY: overridePaddingY,
			},
		};
	}

	private resolveActiveSplitViewport({
		time,
		captionStyle,
	}: {
		time: number;
		captionStyle: CaptionStyleValue;
	}): CaptionSplitViewport | null {
		if (captionStyle.splitScreenOverrides?.anchorToSplitViewport === false) {
			return null;
		}
		const sourceVideo = this.params.captionSourceVideo;
		if (!sourceVideo?.splitScreen) return null;
		const localTime = Math.max(
			0,
			Math.min(sourceVideo.duration, time - sourceVideo.startTime),
		);
		const activeSplitScreen = resolveVideoSplitScreenAtTime({
			element: {
				id: "__caption_source__",
				type: "video",
				mediaId: "__caption_source__",
				name: "__caption_source__",
				startTime: 0,
				duration: sourceVideo.duration,
				trimStart: sourceVideo.trimStart,
				trimEnd: 0,
				transform: DEFAULT_TEXT_ELEMENT.transform,
				opacity: 1,
				reframePresets: sourceVideo.reframePresets,
				reframeSwitches: sourceVideo.reframeSwitches,
				defaultReframePresetId: sourceVideo.defaultReframePresetId,
				splitScreen: sourceVideo.splitScreen,
			},
			localTime,
		});
		if (!activeSplitScreen) return null;
		const viewports = getVideoSplitScreenViewports({
			layoutPreset: activeSplitScreen.layoutPreset,
			viewportBalance: activeSplitScreen.viewportBalance,
			width: this.params.canvasWidth,
			height: this.params.canvasHeight,
		});
		const divider = getVideoSplitScreenDividers({
			layoutPreset: activeSplitScreen.layoutPreset,
			viewportBalance: activeSplitScreen.viewportBalance,
			width: this.params.canvasWidth,
			height: this.params.canvasHeight,
		})[0];
		const dividerTopY = divider?.y;
		const dividerBottomY = divider ? divider.y + divider.height : undefined;
		const dividerCenterY = divider
			? divider.y + divider.height / 2
			: undefined;
		const preferredAnchor =
			captionStyle.splitScreenOverrides?.slotAnchor ?? "auto";
		const anchorsToTop = captionStyle.anchorToSafeAreaTop ?? false;
		const anchorsToBottom =
			(captionStyle.anchorToSafeAreaBottom ?? true) && !anchorsToTop;
		const resolvedSlotId =
			activeSplitScreen.viewportBalance === "unbalanced" && anchorsToBottom
				? "bottom"
				: preferredAnchor === "auto"
					? anchorsToTop
						? "top"
						: "bottom"
					: preferredAnchor;
		const viewport =
			viewports.get(resolvedSlotId) ??
			Array.from(viewports.values())[0] ??
			null;
		return viewport
			? {
					slotId: resolvedSlotId,
					viewportBalance: activeSplitScreen.viewportBalance ?? "balanced",
					dividerTopY,
					dividerBottomY,
					dividerCenterY,
					...viewport,
				}
			: null;
	}

	private resolveCaptionPlacement({
		time,
		visualRect,
		captionStyle,
		fitInCanvas,
	}: {
		time: number;
		visualRect: {
			left: number;
			top: number;
			width: number;
			height: number;
		};
		captionStyle: CaptionStyleValue;
		fitInCanvas?: boolean;
	}): { x: number; y: number; effectiveScale: number } {
		const splitViewport = this.resolveActiveSplitViewport({
			time,
			captionStyle,
		});
		const explicitDividerPlacement = getExplicitDividerPlacement(
			captionStyle.splitScreenOverrides?.dividerPlacement,
		);
		const shouldUseExplicitDividerPlacement =
			Boolean(splitViewport) &&
			explicitDividerPlacement !== null &&
			splitViewport?.dividerCenterY !== undefined;
		const anchorsToBottomEdge =
			(captionStyle.anchorToSafeAreaBottom ?? true) &&
			!(captionStyle.anchorToSafeAreaTop ?? false);
		const shouldUseCanvasBottomPlacement =
			!shouldUseExplicitDividerPlacement &&
			Boolean(splitViewport) &&
			splitViewport?.slotId === "bottom" &&
			anchorsToBottomEdge &&
			splitViewport?.viewportBalance !== "unbalanced" &&
			splitViewport.y + splitViewport.height >= this.params.canvasHeight;
		const placementCanvasWidth = shouldUseCanvasBottomPlacement
			? this.params.canvasWidth
			: shouldUseExplicitDividerPlacement
				? this.params.canvasWidth
				: (splitViewport?.width ?? this.params.canvasWidth);
		const placementCanvasHeight = shouldUseCanvasBottomPlacement
			? this.params.canvasHeight
			: shouldUseExplicitDividerPlacement
				? this.params.canvasHeight
				: (splitViewport?.height ?? this.params.canvasHeight);
		const placementOffsetX = shouldUseCanvasBottomPlacement
			? 0
			: shouldUseExplicitDividerPlacement
				? 0
				: (splitViewport?.x ?? 0);
		const placementOffsetY = shouldUseCanvasBottomPlacement
			? 0
			: shouldUseExplicitDividerPlacement
				? 0
				: (splitViewport?.y ?? 0);
		const anchoredPositionY = resolveSafeAreaAnchoredPositionY({
			canvasWidth: placementCanvasWidth,
			canvasHeight: placementCanvasHeight,
			transformPositionY: this.params.transform.position.y,
			scale: this.params.transform.scale,
			visualRect,
			anchorToSafeAreaBottom: captionStyle.anchorToSafeAreaBottom ?? true,
			safeAreaBottomOffset: captionStyle.safeAreaBottomOffset ?? 0,
			anchorToSafeAreaTop: captionStyle.anchorToSafeAreaTop ?? false,
			safeAreaTopOffset: captionStyle.safeAreaTopOffset ?? 0,
		});
		const resolvedPositionY = shouldUseExplicitDividerPlacement
			? (() => {
					const dividerPlacement = resolveDividerPlacement(explicitDividerPlacement);
					const dividerTopY = splitViewport?.dividerTopY ?? splitViewport?.y ?? 0;
					const dividerBottomY =
						splitViewport?.dividerBottomY ?? splitViewport?.y ?? 0;
					const dividerCenterY =
						splitViewport?.dividerCenterY ?? splitViewport?.y ?? 0;
					const halfHeight =
						(visualRect.height * this.params.transform.scale) / 2;
					const baselineCompensation =
						(this.params.textBaseline ?? "middle") === "middle"
							? getMiddleBaselineCompensation({
									fallbackFontSize: scaleFontSize({
										fontSize: this.params.fontSize,
										canvasHeight: this.params.canvasHeight,
									}),
								}) * this.params.transform.scale
							: 0;
					const targetCenterY =
						dividerPlacement === "above-divider"
							? dividerTopY -
								DIVIDER_PLACEMENT_GAP -
								halfHeight -
								baselineCompensation
							: dividerPlacement === "below-divider"
								? dividerBottomY +
									DIVIDER_PLACEMENT_GAP +
									halfHeight -
									baselineCompensation
								: dividerCenterY - baselineCompensation;
					return targetCenterY - placementOffsetY;
				})()
			: anchoredPositionY;
		const placement = resolveTextPlacement({
			canvasWidth: placementCanvasWidth,
			canvasHeight: placementCanvasHeight,
			positionX: this.params.transform.position.x + placementCanvasWidth / 2,
			positionY: resolvedPositionY,
			scale: this.params.transform.scale,
			visualRect,
			fitInCanvas,
		});
		return {
			x: placement.x + placementOffsetX,
			y: placement.y + placementOffsetY,
			effectiveScale: placement.effectiveScale,
		};
	}

	isInRange({ time }: { time: number }) {
		const visibilityWindows = buildEffectiveCaptionVisibilityWindows({
			visibilityWindows: this.params.captionVisibilityWindows ?? [],
		});
		if (visibilityWindows.length > 0) {
			return visibilityWindows.some(
				(window) => time >= window.startTime && time < window.renderEndTime,
			);
		}
		const captionWordTimings = this.getTimelineCaptionTimings();
		if (captionWordTimings.length > 0) {
			const visibleCaptionWordTimings = captionWordTimings.filter(
				(timing) => !timing.hidden,
			);
			const lastCaptionEndTime =
				visibleCaptionWordTimings[visibleCaptionWordTimings.length - 1]
					?.endTime ??
				captionWordTimings[captionWordTimings.length - 1]?.endTime ??
				this.params.startTime + this.params.duration;
			return (
				time >= this.params.startTime &&
				time <
					Math.min(
						this.params.startTime + this.params.duration,
						lastCaptionEndTime + MIN_CAPTION_FINAL_STATE_HOLD_SECONDS,
					)
			);
		}
		return (
			time >= this.params.startTime &&
			time < this.params.startTime + this.params.duration
		);
	}

	async render({ renderer, time }: { renderer: CanvasRenderer; time: number }) {
		if (!this.isInRange({ time })) {
			return;
		}

		renderer.context.save();

		const effectivePresentation = this.resolveEffectiveCaptionPresentation({
			time,
		});
		const { captionStyle, fontSize, background } = effectivePresentation;
		const fontWeight = this.params.fontWeight === "bold" ? "bold" : "normal";
		const fontStyle = this.params.fontStyle === "italic" ? "italic" : "normal";
		const scaledFontSize = scaleFontSize({
			fontSize,
			canvasHeight: this.params.canvasHeight,
		});
		const fontFamily = quoteFontFamily({ fontFamily: this.params.fontFamily });
		renderer.context.font = `${fontStyle} ${fontWeight} ${scaledFontSize}px ${fontFamily}, sans-serif`;
		renderer.context.textAlign = this.params.textAlign;
		renderer.context.fillStyle = this.params.color;
		const strokeWidth = Math.max(0, this.params.strokeWidth ?? 0);
		const strokeSoftness = Math.max(0, this.params.strokeSoftness ?? 0);
		const hasStroke = strokeWidth > 0;
		const shadowColor = this.params.shadowColor ?? "#000000";
		const shadowOpacity = clampUnitOpacity(this.params.shadowOpacity, 0.6);
		const shadowDistance = Math.max(0, this.params.shadowDistance ?? 0);
		const shadowAngle = Number.isFinite(this.params.shadowAngle)
			? (this.params.shadowAngle as number)
			: 90;
		const shadowSoftness = Math.max(0, this.params.shadowSoftness ?? 0);
		resetCanvasShadow({ ctx: renderer.context });

		const letterSpacing = this.params.letterSpacing ?? 0;
		const lineHeight = this.params.lineHeight ?? DEFAULT_LINE_HEIGHT;
		if ("letterSpacing" in renderer.context) {
			(
				renderer.context as CanvasRenderingContext2D & { letterSpacing: string }
			).letterSpacing = `${letterSpacing}px`;
		}

		const karaokeWordHighlight = captionStyle.karaokeWordHighlight === true;
		const karaokeHighlightMode = captionStyle.karaokeHighlightMode ?? "block";
		const captionWordTimings = this.getTimelineCaptionTimings();
		const visibleCaptionWordTimingsAll = captionWordTimings.filter(
			(timing) => !timing.hidden,
		);
		const visibleCaptionWordsAll = this.getTimelineCaptionWords().filter(
			(token) => !token.hidden,
		);
		const activeVisibilityWindow =
			buildEffectiveCaptionVisibilityWindows({
				visibilityWindows: this.params.captionVisibilityWindows ?? [],
			}).find(
				(window) => time >= window.startTime && time < window.renderEndTime,
			) ?? null;
		const activeWindowStartIndex =
			activeVisibilityWindow && visibleCaptionWordTimingsAll.length > 0
				? visibleCaptionWordTimingsAll.findIndex(
						(timing) =>
							timing.startTime >= activeVisibilityWindow.startTime &&
							timing.startTime < activeVisibilityWindow.contentEndTime,
					)
				: -1;
		const activeWindowEndIndexExclusive =
			activeVisibilityWindow && activeWindowStartIndex >= 0
				? visibleCaptionWordTimingsAll.findIndex(
						(timing, index) =>
							index >= activeWindowStartIndex &&
							timing.startTime >= activeVisibilityWindow.contentEndTime,
					)
				: -1;
		const visibleCaptionWordTimings =
			activeWindowStartIndex >= 0
				? visibleCaptionWordTimingsAll.slice(
						activeWindowStartIndex,
						activeWindowEndIndexExclusive >= 0
							? activeWindowEndIndexExclusive
							: visibleCaptionWordTimingsAll.length,
					)
				: visibleCaptionWordTimingsAll;
		const captionWords =
			activeWindowStartIndex >= 0
				? visibleCaptionWordsAll.slice(
						activeWindowStartIndex,
						activeWindowEndIndexExclusive >= 0
							? activeWindowEndIndexExclusive
							: visibleCaptionWordsAll.length,
					)
				: visibleCaptionWordsAll;
		const latestStartedWordIndex = resolveLatestStartedWordIndex({
			captionWordTimings: visibleCaptionWordTimings,
			time,
		});
		const strictActiveWordIndices = resolveActiveWordIndices({
			captionWordTimings: visibleCaptionWordTimings,
			time,
		});
		const totalWords = this.params.content.match(/\S+/g)?.length ?? 0;
		const clampedProgress = Math.max(
			0,
			Math.min(0.999999, (time - this.params.startTime) / this.params.duration),
		);
		const fallbackWordIndex =
			totalWords > 0 ? Math.floor(clampedProgress * totalWords) : -1;
		const hasWordTimings = visibleCaptionWordTimings.length > 0;
		const activeWordIndex = hasWordTimings
			? resolveKaraokeActiveWordIndex({
					captionWordTimings: visibleCaptionWordTimings,
					time,
				})
			: fallbackWordIndex;
		const wordsOnScreenRaw = captionStyle.wordsOnScreen;
		const wordsOnScreen =
			typeof wordsOnScreenRaw === "number"
				? clampWordCount(wordsOnScreenRaw)
				: null;
		const neverShrinkFont = captionStyle.neverShrinkFont === true;
		const fitInCanvas = captionStyle.fitInCanvas;
		const maxLinesOnScreenRaw = captionStyle.maxLinesOnScreen;
		const maxLinesOnScreen =
			typeof maxLinesOnScreenRaw === "number"
				? clampLineCount(maxLinesOnScreenRaw)
				: 2;
		const shouldLimitWordsOnScreen =
			captionWords.length > 0 && wordsOnScreen !== null && wordsOnScreen > 0;
		const cappedWordsOnScreen = wordsOnScreen ?? captionWords.length;
		const activeWordForWindow =
			activeWordIndex >= 0
				? activeWordIndex
				: latestStartedWordIndex >= 0
					? latestStartedWordIndex
					: 0;
		const lineHeightPx = scaledFontSize * lineHeight;
		const fontSizeRatio = getBackgroundFontSizeRatio({
			fontSize,
			canvasHeight: this.params.canvasHeight,
			referenceCanvasHeight: this.params.backgroundReferenceCanvasHeight,
		});
		const backgroundMode = captionStyle.backgroundFitMode ?? "block";

		const getFitPageSize = ({
			start,
			maxWords,
		}: {
			start: number;
			maxWords: number;
		}): number => {
			if (
				!neverShrinkFont ||
				!fitInCanvas ||
				maxWords <= 1 ||
				captionWords.length === 0
			) {
				return maxWords;
			}

			for (let size = maxWords; size >= 1; size--) {
				const candidateWords = captionWords.slice(start, start + size);
				if (candidateWords.length === 0) continue;
				const candidateLines = buildLineTokenGroups({
					tokens: candidateWords,
					maxLines: maxLinesOnScreen,
					maxWidth:
						this.params.canvasWidth -
						Math.min(this.params.canvasWidth, this.params.canvasHeight) * 0.08,
					measure: (candidate) => renderer.context.measureText(candidate).width,
				}).map((lineTokens) => stringifyVisibleLineTokens(lineTokens));
				const candidateMetrics = candidateLines.map((line) =>
					renderer.context.measureText(line),
				);
				const candidateBlock = measureTextBlock({
					lineMetrics: candidateMetrics,
					lineHeightPx,
					fallbackFontSize: scaledFontSize,
					useUniformMetrics: hasWordTimings,
				});
				const candidateVisualRect = getTextVisualRectForBackgroundMode({
					textAlign: this.params.textAlign,
					block: candidateBlock,
					lineMetrics: candidateMetrics,
					lineHeightPx,
					fallbackFontSize: scaledFontSize,
					background,
					backgroundMode,
					fontSizeRatio,
				});
				const candidatePlacement = this.resolveCaptionPlacement({
					time,
					visualRect: candidateVisualRect,
					captionStyle,
					fitInCanvas,
				});
				if (
					candidatePlacement.effectiveScale >=
					this.params.transform.scale - 0.001
				) {
					return size;
				}
			}

			return 1;
		};

		const getWindow = (): { chunkStart: number; pageSize: number } => {
			if (!shouldLimitWordsOnScreen) {
				return {
					chunkStart: 0,
					pageSize: captionWords.length > 0 ? captionWords.length : 0,
				};
			}

			let pageStart = 0;
			while (pageStart < captionWords.length) {
				const unsnappedMaxPageSize = Math.min(
					cappedWordsOnScreen,
					captionWords.length - pageStart,
				);
				const maxPageSize = resolveSentenceBoundedPageSize({
					words: captionWords.map((token) => token.word),
					start: pageStart,
					maxPageSize: unsnappedMaxPageSize,
				});
				const pageSize = getFitPageSize({
					start: pageStart,
					maxWords: maxPageSize,
				});
				if (activeWordForWindow < pageStart + pageSize) {
					return { chunkStart: pageStart, pageSize };
				}
				pageStart += pageSize;
			}

			const fallbackStart = Math.max(
				0,
				captionWords.length - cappedWordsOnScreen,
			);
			return {
				chunkStart: fallbackStart,
				pageSize: getFitPageSize({
					start: fallbackStart,
					maxWords: resolveSentenceBoundedPageSize({
						words: captionWords.map((token) => token.word),
						start: fallbackStart,
						maxPageSize: Math.min(
							cappedWordsOnScreen,
							captionWords.length - fallbackStart,
						),
					}),
				}),
			};
		};

		const windowed = getWindow();
		const renderWords: CaptionRenderToken[] =
			captionWords.length > 0
				? captionWords.slice(
						windowed.chunkStart,
						windowed.chunkStart + windowed.pageSize,
					)
				: [];
		const maxWrapWidth =
			this.params.canvasWidth -
			Math.min(this.params.canvasWidth, this.params.canvasHeight) * 0.08;
		const renderTokenLines =
			renderWords.length > 0
				? buildLineTokenGroups({
						tokens: renderWords,
						maxLines: maxLinesOnScreen,
						maxWidth: maxWrapWidth,
						measure: (candidate) => renderer.context.measureText(candidate).width,
					})
				: [];
		const renderContent =
			renderTokenLines.length > 0
				? renderTokenLines
						.map((lineTokens) => stringifyVisibleLineTokens(lineTokens))
						.join("\n")
				: this.params.content;
		const shouldWrapToMaintainFontSize =
			!hasWordTimings && Boolean(fitInCanvas) && renderWords.length === 0;
		const wrappedContent = shouldWrapToMaintainFontSize
			? wrapTextToWidth({
					text: renderContent,
					maxWidth: maxWrapWidth,
					measure: (candidate) => renderer.context.measureText(candidate).width,
				}).join("\n")
			: renderContent;
		const renderActiveWordIndex =
			activeWordIndex >= 0 ? activeWordIndex - windowed.chunkStart : -1;
		const renderActiveWordIndices = new Set(
			strictActiveWordIndices.map((index) => index - windowed.chunkStart),
		);

		const lines =
			renderTokenLines.length > 0
				? renderContent.split("\n")
				: wrappedContent.split("\n");
		const baseline = this.params.textBaseline ?? "middle";

		renderer.context.textBaseline = baseline;
		const lineMetrics = lines.map((line) => renderer.context.measureText(line));
		const lineCount = lines.length;

		const block = measureTextBlock({
			lineMetrics,
			lineHeightPx,
			fallbackFontSize: scaledFontSize,
			useUniformMetrics: hasWordTimings,
		});
		const visualRect = getTextVisualRectForBackgroundMode({
			textAlign: this.params.textAlign,
			block,
			lineMetrics,
			lineHeightPx,
			fallbackFontSize: scaledFontSize,
			background,
			backgroundMode,
			fontSizeRatio,
		});

		const placement = this.resolveCaptionPlacement({
			time,
			visualRect,
			captionStyle,
			fitInCanvas,
		});
		const { x, y, effectiveScale } = placement;

		renderer.context.translate(x, y);
		renderer.context.scale(effectiveScale, effectiveScale);
		if (this.params.transform.rotate) {
			renderer.context.rotate((this.params.transform.rotate * Math.PI) / 180);
		}

		const prevAlpha = renderer.context.globalAlpha;
		renderer.context.globalCompositeOperation = (
			this.params.blendMode && this.params.blendMode !== "normal"
				? this.params.blendMode
				: "source-over"
		) as GlobalCompositeOperation;
		renderer.context.globalAlpha = this.params.opacity;

		let backgroundRect: {
			left: number;
			top: number;
			width: number;
			height: number;
		} | null = null;
		let lineBackgroundRects: Array<{
			left: number;
			top: number;
			width: number;
			height: number;
		}> = [];
		if (
			background.color &&
			background.color !== "transparent" &&
			lineCount > 0
		) {
			const { color, cornerRadius = 0 } = background;
			renderer.context.fillStyle = color;
			if (backgroundMode === "line-fit") {
				lineBackgroundRects = getLineFitBackgroundRects({
					textAlign: this.params.textAlign,
					block,
					lineMetrics,
					lineHeightPx,
					fallbackFontSize: scaledFontSize,
					background,
					fontSizeRatio,
				});
				for (const lineRect of lineBackgroundRects) {
					if (lineRect.width <= 0 || lineRect.height <= 0) continue;
					renderer.context.beginPath();
					renderer.context.roundRect(
						lineRect.left,
						lineRect.top,
						lineRect.width,
						lineRect.height,
						cornerRadius,
					);
					renderer.context.fill();
				}
			} else {
				backgroundRect = getTextBackgroundRect({
					textAlign: this.params.textAlign,
					block,
					background,
					fontSizeRatio,
				});
				if (backgroundRect) {
					renderer.context.beginPath();
					renderer.context.roundRect(
						backgroundRect.left,
						backgroundRect.top,
						backgroundRect.width,
						backgroundRect.height,
						cornerRadius,
					);
					renderer.context.fill();
				}
			}
			renderer.context.fillStyle = this.params.color;
		}

		let globalWordIndex = 0;
		const baseHighlightAscent = scaledFontSize * 0.8;
		const baseHighlightDescent = scaledFontSize * 0.2;
		const baseHighlightGlyphHeight = baseHighlightAscent + baseHighlightDescent;

		for (let i = 0; i < lineCount; i++) {
			const lineY = i * lineHeightPx - block.visualCenterOffset;
			const line = lines[i];
			const lineTokens: CaptionRenderToken[] =
				renderTokenLines.length > 0
					? (renderTokenLines[i] ?? [])
					: (line.match(/\S+/g) ?? []).map(
							(word) => ({ word }) as CaptionRenderToken,
						);
			const visibleLineWords = lineTokens
				.filter((token) => !token.hidden)
				.map((token) => token.word);
			const lineRect = lineBackgroundRects[i];
			const isLineFitRow =
				backgroundMode === "line-fit" && lineRect && lineRect.width > 0;
			const lineX = isLineFitRow ? lineRect.left + lineRect.width / 2 : 0;
			const lineTextAlign: CanvasTextAlign = isLineFitRow
				? "center"
				: this.params.textAlign;
			renderer.context.textAlign = lineTextAlign;
			renderer.context.fillStyle = this.params.color;
			if (hasStroke) {
				drawTextStroke({
					ctx: renderer.context,
					text: line,
					x: lineX,
					y: lineY,
					strokeStyle: this.params.strokeColor ?? "#000000",
					lineWidth: strokeWidth,
					strokeSoftness,
				});
			}
			drawTextFillWithEffects({
				ctx: renderer.context,
				text: line,
				x: lineX,
				y: lineY,
				fillStyle: this.params.color,
				shadowColor,
				shadowOpacity,
				shadowDistance,
				shadowAngle,
				shadowSoftness,
			});

			if (karaokeWordHighlight && lineTokens.length > 0) {
				let visibleWordIndex = 0;
				for (
					let localWordIndex = 0;
					localWordIndex < lineTokens.length;
					localWordIndex++
				) {
					const token = lineTokens[localWordIndex];
					const windowWordIndex = globalWordIndex + localWordIndex;
					if (!token || token.hidden) {
						continue;
					}
					if (
						!renderActiveWordIndices.has(windowWordIndex) &&
						windowWordIndex !== renderActiveWordIndex
					) {
						visibleWordIndex += 1;
						continue;
					}
					const word = token.word;
					const prefix = visibleLineWords.slice(0, visibleWordIndex).join(" ");
					const prefixWithSpacing =
						visibleWordIndex > 0 ? `${prefix} ` : prefix;
					const prefixWidth =
						renderer.context.measureText(prefixWithSpacing).width;
					const wordMetrics = renderer.context.measureText(word);
					const wordWidth = wordMetrics.width;
					const lineLeft = getLineLeft({
						textAlign: lineTextAlign,
						lineWidth: lineMetrics[i].width,
					});
					const wordLeft = lineX + lineLeft + prefixWidth;
					const highlightOpacity = clampOpacity(
						captionStyle.karaokeHighlightOpacity ?? 1,
					);
					const absoluteWordIndex = windowWordIndex + windowed.chunkStart;
					let easeInOutFactor = 1;
					let motionFactor = 1;
					if (
						hasWordTimings &&
						absoluteWordIndex >= 0 &&
						absoluteWordIndex < visibleCaptionWordTimings.length
					) {
						const activeTiming = visibleCaptionWordTimings[absoluteWordIndex];
						const fadeInProgress = Math.max(
							0,
							Math.min(1, (time - activeTiming.startTime) / 0.08),
						);
						motionFactor = easeInQuad(fadeInProgress);
					}
					if (
						captionStyle.karaokeHighlightEaseInOnly === true &&
						hasWordTimings &&
						absoluteWordIndex >= 0 &&
						absoluteWordIndex < visibleCaptionWordTimings.length
					) {
						easeInOutFactor = motionFactor;
					}
					const highlightedWordScale =
						captionStyle.karaokeScaleHighlightedWord === true
							? 1 + 0.1 * motionFactor
							: 1;
					const highlightAlpha =
						this.params.opacity * highlightOpacity * easeInOutFactor;
					if (highlightAlpha <= 0) continue;
					const highlightColor =
						captionStyle.karaokeHighlightColor ?? "#FDE047";
					const highlightRoundnessRaw = Math.max(
						0,
						Math.round(captionStyle.karaokeHighlightRoundness ?? 4),
					);
					const highlightTextColor =
						captionStyle.karaokeHighlightTextColor ?? "#111111";

					if (karaokeHighlightMode === "block") {
						const padX = Math.max(2, scaledFontSize * 0.08);
						const padY = Math.max(1, scaledFontSize * 0.04);
						let rectLeft = wordLeft - padX;
						let rectTop = lineY - baseHighlightGlyphHeight / 2 - padY;
						let rectWidth = wordWidth + padX * 2;
						let rectHeight = baseHighlightGlyphHeight + padY * 2;

						// Keep visible spacing between karaoke highlight and caption background edge.
						const clampRect =
							backgroundMode === "line-fit"
								? (lineBackgroundRects[i] ?? null)
								: backgroundRect;
						if (clampRect) {
							const edgeInset = Math.max(2, scaledFontSize * 0.06);
							const bgLeft = clampRect.left + edgeInset;
							const bgTop = clampRect.top + edgeInset;
							const bgRight = clampRect.left + clampRect.width - edgeInset;
							const bgBottom = clampRect.top + clampRect.height - edgeInset;

							const desiredRight = rectLeft + rectWidth;
							const desiredBottom = rectTop + rectHeight;
							rectLeft = Math.max(rectLeft, bgLeft);
							rectTop = Math.max(rectTop, bgTop);
							const clampedRight = Math.min(desiredRight, bgRight);
							const clampedBottom = Math.min(desiredBottom, bgBottom);
							rectWidth = Math.max(0, clampedRight - rectLeft);
							rectHeight = Math.max(0, clampedBottom - rectTop);
						}

						if (rectWidth <= 0 || rectHeight <= 0) continue;

						if (highlightedWordScale > 1) {
							const widthDelta = rectWidth * (highlightedWordScale - 1);
							const heightDelta = rectHeight * (highlightedWordScale - 1);
							rectLeft -= widthDelta / 2;
							rectTop -= heightDelta / 2;
							rectWidth += widthDelta;
							rectHeight += heightDelta;
						}
						const highlightRoundness = Math.min(
							highlightRoundnessRaw * 3 * highlightedWordScale,
							rectWidth / 2,
							rectHeight / 2,
						);
						renderer.context.fillStyle = highlightColor;
						renderer.context.globalAlpha = highlightAlpha;
						renderer.context.beginPath();
						renderer.context.roundRect(
							rectLeft,
							rectTop,
							rectWidth,
							rectHeight,
							highlightRoundness,
						);
						renderer.context.fill();
						renderer.context.globalAlpha = highlightAlpha;

						const originalAlign: CanvasTextAlign = renderer.context.textAlign;
						renderer.context.save();
						renderer.context.translate(wordLeft + wordWidth / 2, lineY);
						renderer.context.scale(highlightedWordScale, highlightedWordScale);
						renderer.context.textAlign = "left";
						if (hasStroke) {
							drawTextStroke({
								ctx: renderer.context,
								text: word,
								x: -wordWidth / 2,
								y: 0,
								strokeStyle: this.params.strokeColor ?? "#000000",
								lineWidth: strokeWidth,
								strokeSoftness,
							});
						}
						drawTextFillWithEffects({
							ctx: renderer.context,
							text: word,
							x: -wordWidth / 2,
							y: 0,
							fillStyle: highlightTextColor,
							shadowColor,
							shadowOpacity,
							shadowDistance,
							shadowAngle,
							shadowSoftness,
						});
						renderer.context.restore();
						renderer.context.textAlign = originalAlign;
						renderer.context.fillStyle = this.params.color;
					} else if (karaokeHighlightMode === "underline") {
						const underlineThicknessRaw = Math.max(
							1,
							Math.round(captionStyle.karaokeUnderlineThickness ?? 3),
						);
						const scaleFactor = Math.max(
							0.01,
							scaledFontSize / Math.max(1, this.params.fontSize),
						);
						const underlineThickness = Math.max(
							1,
							underlineThicknessRaw * scaleFactor,
						);
						// Use a fixed font-relative anchor so underline position is
						// consistent across words and descenders can cut through it.
						const underlineY = lineY + scaledFontSize * 0.2;
						const previousCompositeOperation =
							renderer.context.globalCompositeOperation;
						renderer.context.fillStyle = highlightColor;
						renderer.context.globalAlpha = highlightAlpha;
						renderer.context.globalCompositeOperation = "destination-over";
						renderer.context.save();
						renderer.context.translate(
							wordLeft + wordWidth / 2,
							underlineY + underlineThickness / 2,
						);
						renderer.context.scale(highlightedWordScale, highlightedWordScale);
						renderer.context.fillRect(
							-wordWidth / 2,
							-underlineThickness / 2,
							wordWidth,
							underlineThickness,
						);
						renderer.context.restore();
						renderer.context.globalCompositeOperation =
							previousCompositeOperation;
						renderer.context.fillStyle = this.params.color;
					} else {
						const originalAlign: CanvasTextAlign = renderer.context.textAlign;
						renderer.context.save();
						renderer.context.translate(wordLeft + wordWidth / 2, lineY);
						renderer.context.scale(highlightedWordScale, highlightedWordScale);
						renderer.context.textAlign = "left";
						renderer.context.globalAlpha = highlightAlpha;
						if (hasStroke) {
							drawTextStroke({
								ctx: renderer.context,
								text: word,
								x: -wordWidth / 2,
								y: 0,
								strokeStyle: this.params.strokeColor ?? "#000000",
								lineWidth: strokeWidth,
								strokeSoftness,
							});
						}
						drawTextFillWithEffects({
							ctx: renderer.context,
							text: word,
							x: -wordWidth / 2,
							y: 0,
							fillStyle: highlightColor,
							shadowColor,
							shadowOpacity,
							shadowDistance,
							shadowAngle,
							shadowSoftness,
						});
						renderer.context.restore();
						renderer.context.textAlign = originalAlign;
						renderer.context.fillStyle = this.params.color;
					}
					renderer.context.globalAlpha = this.params.opacity;
					visibleWordIndex += 1;
				}
			}

			globalWordIndex += lineTokens.length;
			drawTextDecoration({
				ctx: renderer.context,
				textDecoration: this.params.textDecoration ?? "none",
				lineWidth: lineMetrics[i].width,
				lineY,
				lineX,
				metrics: lineMetrics[i],
				scaledFontSize,
				textAlign: lineTextAlign,
			});
		}

		renderer.context.globalAlpha = prevAlpha;
		renderer.context.restore();
	}
}
