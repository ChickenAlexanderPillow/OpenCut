import type { CanvasRenderer } from "../canvas-renderer";
import { BaseNode } from "./base-node";
import type { TextElement } from "@/types/timeline";
import {
	DEFAULT_TEXT_ELEMENT,
	DEFAULT_LINE_HEIGHT,
	FONT_SIZE_SCALE_REFERENCE,
} from "@/constants/text-constants";
import {
	getMetricAscent,
	getMetricDescent,
	getLineFitBackgroundRects,
	getTextBackgroundRect,
	getTextVisualRectForBackgroundMode,
	measureTextBlock,
	resolveTextPlacement,
	wrapTextToWidth,
} from "@/lib/text/layout";
import { resolveSafeAreaAnchoredPositionY } from "@/constants/safe-area-constants";
import { toTimelineCaptionWordTimings } from "@/lib/captions/timing";

function scaleFontSize({
	fontSize,
	canvasHeight,
}: {
	fontSize: number;
	canvasHeight: number;
}): number {
	return fontSize * (canvasHeight / FONT_SIZE_SCALE_REFERENCE);
}

function quoteFontFamily({ fontFamily }: { fontFamily: string }): string {
	return `"${fontFamily.replace(/"/g, '\\"')}"`;
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

function getWordRange({
	line,
	wordIndex,
}: {
	line: string;
	wordIndex: number;
}): { start: number; end: number } | null {
	let currentIndex = 0;
	const regex = /\S+/g;
	let match: RegExpExecArray | null = regex.exec(line);
	while (match) {
		if (currentIndex === wordIndex) {
			return { start: match.index, end: match.index + match[0].length };
		}
		currentIndex += 1;
		match = regex.exec(line);
	}
	return null;
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
		if (time >= timing.startTime && time < timing.endTime) {
			return i;
		}
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
		if (time >= timing.startTime && time < timing.endTime) {
			indices.push(i);
		}
	}
	return indices;
}

function resolveNextWordIndex({
	captionWordTimings,
	time,
}: {
	captionWordTimings: Array<{ startTime: number }>;
	time: number;
}): number {
	for (let i = 0; i < captionWordTimings.length; i++) {
		if (time < captionWordTimings[i].startTime) {
			return i;
		}
	}
	return -1;
}

function buildLinesFromWords({
	words,
	maxLines,
}: {
	words: string[];
	maxLines: number;
}): string[] {
	if (words.length === 0) return [];
	const clampedMaxLines = clampLineCount(maxLines);
	const lineCount = Math.min(clampedMaxLines, words.length);
	const wordsPerLine = Math.ceil(words.length / lineCount);
	const lines: string[] = [];

	for (let i = 0; i < words.length; i += wordsPerLine) {
		lines.push(words.slice(i, i + wordsPerLine).join(" "));
	}

	return lines;
}

function isSentenceEndingWord(word: string): boolean {
	const trimmed = word.trim();
	if (!trimmed) return false;
	return /[.!?]["')\]]*$/.test(trimmed);
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
	textBaseline?: CanvasTextBaseline;
};

export class TextNode extends BaseNode<TextNodeParams> {
	private cachedCaptionTimingsRef:
		| Array<{ word: string; startTime: number; endTime: number }>
		| null = null;
	private cachedCaptionTimingsStartTime = Number.NaN;
	private cachedCaptionTimingsDuration = Number.NaN;
	private cachedTimelineCaptionTimings: Array<{
		word: string;
		startTime: number;
		endTime: number;
	}> = [];
	private cachedTimelineCaptionWords: string[] = [];

	private getTimelineCaptionTimings(): Array<{
		word: string;
		startTime: number;
		endTime: number;
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
			(timing) => timing.word,
		);
		this.cachedCaptionTimingsRef = sourceTimings;
		this.cachedCaptionTimingsStartTime = this.params.startTime;
		this.cachedCaptionTimingsDuration = this.params.duration;
		return this.cachedTimelineCaptionTimings;
	}

	private getTimelineCaptionWords(): string[] {
		void this.getTimelineCaptionTimings();
		return this.cachedTimelineCaptionWords;
	}

	isInRange({ time }: { time: number }) {
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

		const fontWeight = this.params.fontWeight === "bold" ? "bold" : "normal";
		const fontStyle = this.params.fontStyle === "italic" ? "italic" : "normal";
		const scaledFontSize = scaleFontSize({
			fontSize: this.params.fontSize,
			canvasHeight: this.params.canvasHeight,
		});
		const fontFamily = quoteFontFamily({ fontFamily: this.params.fontFamily });
		renderer.context.font = `${fontStyle} ${fontWeight} ${scaledFontSize}px ${fontFamily}, sans-serif`;
		renderer.context.textAlign = this.params.textAlign;
		renderer.context.fillStyle = this.params.color;
		const strokeWidth = Math.max(0, this.params.strokeWidth ?? 0);
		const hasStroke = strokeWidth > 0;
		if (hasStroke) {
			renderer.context.strokeStyle = this.params.strokeColor ?? "#000000";
			renderer.context.lineWidth = strokeWidth;
			renderer.context.lineJoin = "round";
			renderer.context.miterLimit = 2;
		}

		const letterSpacing = this.params.letterSpacing ?? 0;
		const lineHeight = this.params.lineHeight ?? DEFAULT_LINE_HEIGHT;
		if ("letterSpacing" in renderer.context) {
			(
				renderer.context as CanvasRenderingContext2D & { letterSpacing: string }
			).letterSpacing = `${letterSpacing}px`;
		}

		const karaokeWordHighlight =
			this.params.captionStyle?.karaokeWordHighlight === true;
		const karaokeHighlightMode =
			this.params.captionStyle?.karaokeHighlightMode ?? "block";
		const captionWordTimings = this.getTimelineCaptionTimings();
		if (captionWordTimings.length > 0) {
			const firstWordStart = captionWordTimings[0]?.startTime ?? this.params.startTime;
			const lastWordEnd =
				captionWordTimings[captionWordTimings.length - 1]?.endTime ??
				this.params.startTime + this.params.duration;
			const hasActiveWordWindow = time >= firstWordStart && time < lastWordEnd;
			if (!hasActiveWordWindow) {
				renderer.context.restore();
				return;
			}
		}
		const latestStartedWordIndex = resolveLatestStartedWordIndex({
			captionWordTimings,
			time,
		});
		const strictActiveWordIndex = resolveActiveWordIndex({
			captionWordTimings,
			time,
		});
		const strictActiveWordIndices = resolveActiveWordIndices({
			captionWordTimings,
			time,
		});
		const nextWordIndex = resolveNextWordIndex({
			captionWordTimings,
			time,
		});
		const totalWords = this.params.content.match(/\S+/g)?.length ?? 0;
		const clampedProgress = Math.max(
			0,
			Math.min(0.999999, (time - this.params.startTime) / this.params.duration),
		);
		const fallbackWordIndex =
			totalWords > 0 ? Math.floor(clampedProgress * totalWords) : -1;
		const hasWordTimings = captionWordTimings.length > 0;
		const activeWordIndex = hasWordTimings
			? strictActiveWordIndex
			: fallbackWordIndex;
		const captionWords = this.getTimelineCaptionWords();
		const wordsOnScreenRaw = this.params.captionStyle?.wordsOnScreen;
		const wordsOnScreen =
			typeof wordsOnScreenRaw === "number"
				? clampWordCount(wordsOnScreenRaw)
				: null;
		const neverShrinkFont = this.params.captionStyle?.neverShrinkFont === true;
		const fitInCanvas = this.params.captionStyle?.fitInCanvas;
		const maxLinesOnScreenRaw = this.params.captionStyle?.maxLinesOnScreen;
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
				: nextWordIndex >= 0
					? nextWordIndex
					: latestStartedWordIndex >= 0
						? latestStartedWordIndex
						: 0;
		const lineHeightPx = scaledFontSize * lineHeight;
		const fontSizeRatio = this.params.fontSize / DEFAULT_TEXT_ELEMENT.fontSize;
		const backgroundMode =
			this.params.captionStyle?.backgroundFitMode ?? "block";

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
				const candidateLines = buildLinesFromWords({
					words: candidateWords,
					maxLines: maxLinesOnScreen,
				});
				const candidateMetrics = candidateLines.map((line) =>
					renderer.context.measureText(line),
				);
				const candidateBlock = measureTextBlock({
					lineMetrics: candidateMetrics,
					lineHeightPx,
					fallbackFontSize: scaledFontSize,
				});
				const candidateVisualRect = getTextVisualRectForBackgroundMode({
					textAlign: this.params.textAlign,
					block: candidateBlock,
					lineMetrics: candidateMetrics,
					lineHeightPx,
					fallbackFontSize: scaledFontSize,
					background: this.params.background,
					backgroundMode,
					fontSizeRatio,
				});
					const candidatePlacement = resolveTextPlacement({
						canvasWidth: this.params.canvasWidth,
						canvasHeight: this.params.canvasHeight,
						positionX:
							this.params.transform.position.x + this.params.canvasCenter.x,
						positionY: resolveSafeAreaAnchoredPositionY({
							canvasWidth: this.params.canvasWidth,
							canvasHeight: this.params.canvasHeight,
							transformPositionY: this.params.transform.position.y,
							scale: this.params.transform.scale,
							visualRect: candidateVisualRect,
						anchorToSafeAreaBottom:
								this.params.captionStyle?.anchorToSafeAreaBottom ?? true,
							safeAreaBottomOffset:
								this.params.captionStyle?.safeAreaBottomOffset ?? 0,
							anchorToSafeAreaTop:
								this.params.captionStyle?.anchorToSafeAreaTop ?? false,
							safeAreaTopOffset:
								this.params.captionStyle?.safeAreaTopOffset ?? 0,
						}),
						scale: this.params.transform.scale,
						visualRect: candidateVisualRect,
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
					words: captionWords,
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
						words: captionWords,
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
		const renderWords =
			captionWords.length > 0
				? captionWords.slice(
						windowed.chunkStart,
						windowed.chunkStart + windowed.pageSize,
					)
				: [];
		const renderContent =
			renderWords.length > 0
				? buildLinesFromWords({
						words: renderWords,
						maxLines: maxLinesOnScreen,
					}).join("\n")
				: this.params.content;
		const maxWrapWidth =
			this.params.canvasWidth - Math.min(this.params.canvasWidth, this.params.canvasHeight) * 0.08;
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

		const lines = wrappedContent.split("\n");
		const baseline = this.params.textBaseline ?? "middle";

		renderer.context.textBaseline = baseline;
		const lineMetrics = lines.map((line) => renderer.context.measureText(line));
		const lineCount = lines.length;

		const block = measureTextBlock({
			lineMetrics,
			lineHeightPx,
			fallbackFontSize: scaledFontSize,
		});
		const visualRect = getTextVisualRectForBackgroundMode({
			textAlign: this.params.textAlign,
			block,
			lineMetrics,
			lineHeightPx,
			fallbackFontSize: scaledFontSize,
			background: this.params.background,
			backgroundMode,
			fontSizeRatio,
		});

		const placement = resolveTextPlacement({
			canvasWidth: this.params.canvasWidth,
			canvasHeight: this.params.canvasHeight,
			positionX: this.params.transform.position.x + this.params.canvasCenter.x,
			positionY: resolveSafeAreaAnchoredPositionY({
				canvasWidth: this.params.canvasWidth,
				canvasHeight: this.params.canvasHeight,
				transformPositionY: this.params.transform.position.y,
				scale: this.params.transform.scale,
				visualRect,
				anchorToSafeAreaBottom:
					this.params.captionStyle?.anchorToSafeAreaBottom ?? true,
				safeAreaBottomOffset: this.params.captionStyle?.safeAreaBottomOffset ?? 0,
				anchorToSafeAreaTop:
					this.params.captionStyle?.anchorToSafeAreaTop ?? false,
				safeAreaTopOffset: this.params.captionStyle?.safeAreaTopOffset ?? 0,
			}),
			scale: this.params.transform.scale,
			visualRect,
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
			this.params.background.color &&
			this.params.background.color !== "transparent" &&
			lineCount > 0
		) {
			const { color, cornerRadius = 0 } = this.params.background;
			renderer.context.fillStyle = color;
			if (backgroundMode === "line-fit") {
				lineBackgroundRects = getLineFitBackgroundRects({
					textAlign: this.params.textAlign,
					block,
					lineMetrics,
					lineHeightPx,
					fallbackFontSize: scaledFontSize,
					background: this.params.background,
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
					background: this.params.background,
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
			const lineWords = line.match(/\S+/g) ?? [];
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
				renderer.context.strokeText(line, lineX, lineY);
			}
			renderer.context.fillText(line, lineX, lineY);

			if (karaokeWordHighlight && lineWords.length > 0) {
				for (let localWordIndex = 0; localWordIndex < lineWords.length; localWordIndex++) {
					const windowWordIndex = globalWordIndex + localWordIndex;
					if (
						!renderActiveWordIndices.has(windowWordIndex) &&
						windowWordIndex !== renderActiveWordIndex
					) {
						continue;
					}
					const range = getWordRange({ line, wordIndex: localWordIndex });
					if (!range) continue;
					const word = line.slice(range.start, range.end);
					const prefix = line.slice(0, range.start);
					const prefixWidth = renderer.context.measureText(prefix).width;
					const wordMetrics = renderer.context.measureText(word);
					const wordWidth = wordMetrics.width;
					const lineLeft = getLineLeft({
						textAlign: lineTextAlign,
						lineWidth: lineMetrics[i].width,
					});
					const wordLeft = lineX + lineLeft + prefixWidth;
					const highlightOpacity = clampOpacity(
						this.params.captionStyle?.karaokeHighlightOpacity ?? 1,
					);
					const absoluteWordIndex = windowWordIndex + windowed.chunkStart;
					let easeInOutFactor = 1;
					let motionFactor = 1;
					if (
						hasWordTimings &&
						absoluteWordIndex >= 0 &&
						absoluteWordIndex < captionWordTimings.length
					) {
						const activeTiming = captionWordTimings[absoluteWordIndex];
						const fadeInProgress = Math.max(
							0,
							Math.min(1, (time - activeTiming.startTime) / 0.08),
						);
						motionFactor = easeInQuad(fadeInProgress);
					}
					if (
						this.params.captionStyle?.karaokeHighlightEaseInOnly === true &&
						hasWordTimings &&
						absoluteWordIndex >= 0 &&
						absoluteWordIndex < captionWordTimings.length
					) {
						easeInOutFactor = motionFactor;
					}
					const highlightedWordScale =
						this.params.captionStyle?.karaokeScaleHighlightedWord === true
							? 1 + 0.1 * motionFactor
							: 1;
					const highlightAlpha =
						this.params.opacity * highlightOpacity * easeInOutFactor;
					if (highlightAlpha <= 0) continue;
					const highlightColor =
						this.params.captionStyle?.karaokeHighlightColor ?? "#FDE047";
					const highlightRoundnessRaw = Math.max(
						0,
						Math.round(
							this.params.captionStyle?.karaokeHighlightRoundness ?? 4,
						),
					);
					const highlightTextColor =
						this.params.captionStyle?.karaokeHighlightTextColor ?? "#111111";

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
						renderer.context.fillStyle = highlightTextColor;
						renderer.context.fillText(word, -wordWidth / 2, 0);
						renderer.context.restore();
						renderer.context.textAlign = originalAlign;
						renderer.context.fillStyle = this.params.color;
					} else if (karaokeHighlightMode === "underline") {
						const underlineThicknessRaw = Math.max(
							1,
							Math.round(
								this.params.captionStyle?.karaokeUnderlineThickness ?? 3,
							),
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
						renderer.context.fillStyle = highlightColor;
						renderer.context.globalAlpha = highlightAlpha;
						renderer.context.fillText(word, -wordWidth / 2, 0);
						renderer.context.restore();
						renderer.context.textAlign = originalAlign;
						renderer.context.fillStyle = this.params.color;
					}
					renderer.context.globalAlpha = this.params.opacity;
				}
			}

			globalWordIndex += lineWords.length;
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
