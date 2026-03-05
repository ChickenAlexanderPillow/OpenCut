import type { TimelineTrack, TimelineElement } from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { isMainTrack } from "@/lib/timeline";
import {
	DEFAULT_TEXT_ELEMENT,
	DEFAULT_LINE_HEIGHT,
	FONT_SIZE_SCALE_REFERENCE,
} from "@/constants/text-constants";
import {
	getTextVisualRectForBackgroundMode,
	measureTextBlock,
	resolveTextPlacement,
	wrapTextToWidth,
} from "@/lib/text/layout";
import { resolveSafeAreaAnchoredPositionY } from "@/constants/safe-area-constants";
import { toTimelineCaptionWordTimings } from "@/lib/captions/timing";

export interface ElementBounds {
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation: number;
}

export interface ElementWithBounds {
	trackId: string;
	elementId: string;
	element: TimelineElement;
	bounds: ElementBounds;
}

type CachedCaptionTimingData = {
	signature: string;
	timings: Array<{ word: string; startTime: number; endTime: number }>;
	words: string[];
	startTimes: number[];
};

type CachedTextBounds = {
	signature: string;
	bounds: ElementBounds;
};

const MAX_PREVIEW_CACHE_ENTRIES = 300;
const captionTimingCacheByElementId = new Map<string, CachedCaptionTimingData>();
const textBoundsCacheByElementId = new Map<string, CachedTextBounds>();

const sharedMeasureCanvas =
	typeof document !== "undefined" ? document.createElement("canvas") : null;
if (sharedMeasureCanvas) {
	sharedMeasureCanvas.width = 4096;
	sharedMeasureCanvas.height = 4096;
}

function evictOldestEntry<T>(cache: Map<string, T>): void {
	while (cache.size > MAX_PREVIEW_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value as string | undefined;
		if (!oldestKey) break;
		cache.delete(oldestKey);
	}
}

function getSharedMeasureContext(): CanvasRenderingContext2D | null {
	if (!sharedMeasureCanvas) return null;
	return sharedMeasureCanvas.getContext("2d");
}

function buildCaptionTimingsSignature({
	element,
}: {
	element: Extract<TimelineElement, { type: "text" }>;
}): string {
	const timings = element.captionWordTimings ?? [];
	const length = timings.length;
	const first = timings[0];
	const middle = length > 2 ? timings[Math.floor(length / 2)] : undefined;
	const last = length > 1 ? timings[length - 1] : first;
	return [
		element.id,
		element.startTime.toFixed(3),
		element.duration.toFixed(3),
		length,
		first?.word ?? "",
		first?.startTime?.toFixed(3) ?? "",
		first?.endTime?.toFixed(3) ?? "",
		middle?.word ?? "",
		middle?.startTime?.toFixed(3) ?? "",
		middle?.endTime?.toFixed(3) ?? "",
		last?.word ?? "",
		last?.startTime?.toFixed(3) ?? "",
		last?.endTime?.toFixed(3) ?? "",
	].join("|");
}

function getCachedCaptionTimingData({
	element,
}: {
	element: Extract<TimelineElement, { type: "text" }>;
}): CachedCaptionTimingData {
	const signature = buildCaptionTimingsSignature({ element });
	const existing = captionTimingCacheByElementId.get(element.id);
	if (existing && existing.signature === signature) {
		return existing;
	}
	const timings = toTimelineCaptionWordTimings({
		timings: element.captionWordTimings ?? [],
		elementStartTime: element.startTime,
		elementDuration: element.duration,
	});
	const data: CachedCaptionTimingData = {
		signature,
		timings,
		words: timings.map((timing) => timing.word),
		startTimes: timings.map((timing) => timing.startTime),
	};
	captionTimingCacheByElementId.set(element.id, data);
	evictOldestEntry(captionTimingCacheByElementId);
	return data;
}

function clampWordCount(value: number): number {
	return Math.max(1, Math.min(12, Math.round(value)));
}

function clampLineCount(value: number): number {
	return Math.max(1, Math.min(4, Math.round(value)));
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

function resolveLatestStartedWordIndex({
	startTimes,
	currentTime,
}: {
	startTimes: number[];
	currentTime: number;
}): number {
	if (startTimes.length === 0) return -1;
	let low = 0;
	let high = startTimes.length - 1;
	let best = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const value = startTimes[mid] ?? 0;
		if (value <= currentTime) {
			best = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best;
}

function getVisualElementBounds({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	transform,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	transform: {
		scale: number;
		position: { x: number; y: number };
		rotate: number;
	};
}): ElementBounds {
	const containScale = Math.min(
		canvasWidth / sourceWidth,
		canvasHeight / sourceHeight,
	);
	const scaledWidth = sourceWidth * containScale * transform.scale;
	const scaledHeight = sourceHeight * containScale * transform.scale;
	const cx = canvasWidth / 2 + transform.position.x;
	const cy = canvasHeight / 2 + transform.position.y;

	return {
		cx,
		cy,
		width: scaledWidth,
		height: scaledHeight,
		rotation: transform.rotate,
	};
}

export function getElementBounds({
	element,
	canvasSize,
	mediaAsset,
	currentTime = element.startTime,
}: {
	element: TimelineElement;
	canvasSize: { width: number; height: number };
	mediaAsset?: MediaAsset | null;
	currentTime?: number;
}): ElementBounds | null {
	if (element.type === "audio") return null;
	if ("hidden" in element && element.hidden) return null;

	const { width: canvasWidth, height: canvasHeight } = canvasSize;

	if (element.type === "video" || element.type === "image") {
		const sourceWidth = mediaAsset?.width ?? canvasWidth;
		const sourceHeight = mediaAsset?.height ?? canvasHeight;
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth,
			sourceHeight,
			transform: element.transform,
		});
	}

	if (element.type === "sticker") {
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth: 200,
			sourceHeight: 200,
			transform: element.transform,
		});
	}

	if (element.type === "text") {
		const scaledFontSize =
			element.fontSize * (canvasHeight / FONT_SIZE_SCALE_REFERENCE);
		const letterSpacing = element.letterSpacing ?? 0;
		const lineHeight = element.lineHeight ?? DEFAULT_LINE_HEIGHT;
		const lineHeightPx = scaledFontSize * lineHeight;

		let measuredWidth = 100;
		let measuredHeight = scaledFontSize;

		const ctx = getSharedMeasureContext();

		if (ctx) {
			const fontWeight = element.fontWeight === "bold" ? "bold" : "normal";
			const fontStyle = element.fontStyle === "italic" ? "italic" : "normal";
			const fontFamily = `"${element.fontFamily.replace(/"/g, '\\"')}"`;
			ctx.font = `${fontStyle} ${fontWeight} ${scaledFontSize}px ${fontFamily}, sans-serif`;
			ctx.textAlign = element.textAlign as CanvasTextAlign;
			if ("letterSpacing" in ctx) {
				(
					ctx as CanvasRenderingContext2D & { letterSpacing: string }
				).letterSpacing = `${letterSpacing}px`;
			}

			const captionTimingData = getCachedCaptionTimingData({ element });
			const captionWordTimings = captionTimingData.timings;
			const captionWords = captionTimingData.words;
			const wordsOnScreenRaw = element.captionStyle?.wordsOnScreen;
			const wordsOnScreen =
				typeof wordsOnScreenRaw === "number"
					? clampWordCount(wordsOnScreenRaw)
					: null;
			const neverShrinkFont = element.captionStyle?.neverShrinkFont === true;
			const fitInCanvas = element.captionStyle?.fitInCanvas;
			const maxLinesOnScreenRaw = element.captionStyle?.maxLinesOnScreen;
			const maxLinesOnScreen =
				typeof maxLinesOnScreenRaw === "number"
					? clampLineCount(maxLinesOnScreenRaw)
					: 2;
			const latestStartedWordIndex = resolveLatestStartedWordIndex({
				startTimes: captionTimingData.startTimes,
				currentTime,
			});
			const shouldLimitWordsOnScreen =
				captionWords.length > 0 && wordsOnScreen !== null && wordsOnScreen > 0;
			const cappedWordsOnScreen = wordsOnScreen ?? captionWords.length;
			const activeWordForWindow =
				latestStartedWordIndex >= 0
					? latestStartedWordIndex
					: 0;
			const backgroundMode = element.captionStyle?.backgroundFitMode ?? "block";
			const textLayoutSignature = [
				captionTimingData.signature,
				canvasWidth,
				canvasHeight,
				element.transform.position.x.toFixed(2),
				element.transform.position.y.toFixed(2),
				element.transform.scale.toFixed(4),
				element.transform.rotate.toFixed(2),
				element.textAlign,
				element.fontFamily,
				element.fontSize.toFixed(3),
				element.fontWeight,
				element.fontStyle,
				lineHeight.toFixed(3),
				letterSpacing.toFixed(3),
				wordsOnScreen ?? "all",
				maxLinesOnScreen,
				latestStartedWordIndex,
				backgroundMode,
				element.content,
			].join("|");
			const cachedBounds = textBoundsCacheByElementId.get(element.id);
			if (cachedBounds?.signature === textLayoutSignature) {
				return cachedBounds.bounds;
			}

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
						ctx.measureText(line),
					);
					const candidateBlock = measureTextBlock({
						lineMetrics: candidateMetrics,
						lineHeightPx,
						fallbackFontSize: scaledFontSize,
					});
					const fontSizeRatio =
						element.fontSize / DEFAULT_TEXT_ELEMENT.fontSize;
					const candidateVisualRect = getTextVisualRectForBackgroundMode({
						textAlign: element.textAlign,
						block: candidateBlock,
						lineMetrics: candidateMetrics,
						lineHeightPx,
						fallbackFontSize: scaledFontSize,
						background: element.background,
						backgroundMode,
						fontSizeRatio,
					});
					const candidatePlacement = resolveTextPlacement({
						canvasWidth,
						canvasHeight,
						positionX: canvasWidth / 2 + element.transform.position.x,
						positionY: resolveSafeAreaAnchoredPositionY({
							canvasWidth,
							canvasHeight,
							transformPositionY: element.transform.position.y,
							scale: element.transform.scale,
							visualRect: candidateVisualRect,
							anchorToSafeAreaBottom:
								element.captionStyle?.anchorToSafeAreaBottom ?? true,
							safeAreaBottomOffset:
								element.captionStyle?.safeAreaBottomOffset ?? 0,
							anchorToSafeAreaTop:
								element.captionStyle?.anchorToSafeAreaTop ?? false,
							safeAreaTopOffset:
								element.captionStyle?.safeAreaTopOffset ?? 0,
						}),
						scale: element.transform.scale,
						visualRect: candidateVisualRect,
						fitInCanvas,
					});
					if (
						candidatePlacement.effectiveScale >=
						element.transform.scale - 0.001
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
					const maxPageSize = Math.min(
						cappedWordsOnScreen,
						captionWords.length - pageStart,
					);
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
						maxWords: Math.min(
							cappedWordsOnScreen,
							captionWords.length - fallbackStart,
						),
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
					: element.content;
			const maxWrapWidth = canvasWidth - Math.min(canvasWidth, canvasHeight) * 0.08;
			const shouldWrapToMaintainFontSize =
				captionWords.length === 0 && Boolean(fitInCanvas);
			const wrappedContent = shouldWrapToMaintainFontSize
				? wrapTextToWidth({
						text: renderContent,
						maxWidth: maxWrapWidth,
						measure: (candidate) => ctx.measureText(candidate).width,
					}).join("\n")
				: renderContent;
			const lines = wrappedContent.split("\n");
			const lineMetrics = lines.map((line) => ctx.measureText(line));
			const block = measureTextBlock({
				lineMetrics,
				lineHeightPx,
				fallbackFontSize: scaledFontSize,
			});
			const fontSizeRatio = element.fontSize / DEFAULT_TEXT_ELEMENT.fontSize;
			const visualRect = getTextVisualRectForBackgroundMode({
				textAlign: element.textAlign,
				block,
				lineMetrics,
				lineHeightPx,
				fallbackFontSize: scaledFontSize,
				background: element.background,
				backgroundMode,
				fontSizeRatio,
			});
			measuredWidth = visualRect.width;
			measuredHeight = visualRect.height;
			const placement = resolveTextPlacement({
				canvasWidth,
				canvasHeight,
				positionX: canvasWidth / 2 + element.transform.position.x,
				positionY: resolveSafeAreaAnchoredPositionY({
					canvasWidth,
					canvasHeight,
					transformPositionY: element.transform.position.y,
					scale: element.transform.scale,
					visualRect,
					anchorToSafeAreaBottom:
						element.captionStyle?.anchorToSafeAreaBottom ?? true,
					safeAreaBottomOffset: element.captionStyle?.safeAreaBottomOffset ?? 0,
					anchorToSafeAreaTop:
						element.captionStyle?.anchorToSafeAreaTop ?? false,
					safeAreaTopOffset: element.captionStyle?.safeAreaTopOffset ?? 0,
				}),
				scale: element.transform.scale,
				visualRect,
				fitInCanvas,
			});
			const localCenterX = visualRect.left + visualRect.width / 2;
			const localCenterY = visualRect.top + visualRect.height / 2;
			const scaledCenterX = localCenterX * placement.effectiveScale;
			const scaledCenterY = localCenterY * placement.effectiveScale;
			const rotationRad = (element.transform.rotate * Math.PI) / 180;
			const cos = Math.cos(rotationRad);
			const sin = Math.sin(rotationRad);
			const rotatedCenterX = scaledCenterX * cos - scaledCenterY * sin;
			const rotatedCenterY = scaledCenterX * sin + scaledCenterY * cos;
			const computedBounds = {
				cx: placement.x + rotatedCenterX,
				cy: placement.y + rotatedCenterY,
				width: measuredWidth * placement.effectiveScale,
				height: measuredHeight * placement.effectiveScale,
				rotation: element.transform.rotate,
			};
			textBoundsCacheByElementId.set(element.id, {
				signature: textLayoutSignature,
				bounds: computedBounds,
			});
			evictOldestEntry(textBoundsCacheByElementId);
			return computedBounds;
		}

		const width = measuredWidth * element.transform.scale;
		const height = measuredHeight * element.transform.scale;
		return {
			cx: canvasWidth / 2 + element.transform.position.x,
			cy: canvasHeight / 2 + element.transform.position.y,
			width,
			height,
			rotation: element.transform.rotate,
		};
	}

	return null;
}

export function getVisibleElementsWithBounds({
	tracks,
	currentTime,
	canvasSize,
	mediaAssets,
}: {
	tracks: TimelineTrack[];
	currentTime: number;
	canvasSize: { width: number; height: number };
	mediaAssets: MediaAsset[];
}): ElementWithBounds[] {
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));
	const visibleTracks = tracks.filter(
		(track) => !("hidden" in track && track.hidden),
	);
	const orderedTracks = [
		...visibleTracks.filter((track) => !isMainTrack(track)),
		...visibleTracks.filter((track) => isMainTrack(track)),
	].reverse();

	const result: ElementWithBounds[] = [];

	for (const track of orderedTracks) {
		const elements = track.elements
			.filter((element) => !("hidden" in element && element.hidden))
			.filter(
				(element) =>
					currentTime >= element.startTime &&
					currentTime < element.startTime + element.duration,
			)
			.slice()
			.sort((a, b) => {
				if (a.startTime !== b.startTime) return a.startTime - b.startTime;
				return a.id.localeCompare(b.id);
			});

		for (const element of elements) {
			const mediaAsset =
				element.type === "video" || element.type === "image"
					? mediaMap.get(element.mediaId)
					: undefined;
			const bounds = getElementBounds({
				element,
				canvasSize,
				mediaAsset,
				currentTime,
			});
			if (bounds) {
				result.push({
					trackId: track.id,
					elementId: element.id,
					element,
					bounds,
				});
			}
		}
	}

	return result;
}
