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
import { resolveTransformAtTime } from "@/lib/animation";
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

type CachedCaptionPagePlan = {
	signature: string;
	pages: Array<{
		chunkStart: number;
		pageSize: number;
		content: string;
	}>;
};

const MAX_PREVIEW_CACHE_ENTRIES = 300;
const captionTimingCacheByElementId = new Map<
	string,
	CachedCaptionTimingData
>();
const textBoundsCacheByElementId = new Map<string, CachedTextBounds>();
const captionPagePlanCacheByElementId = new Map<
	string,
	CachedCaptionPagePlan
>();

const sharedMeasureCanvas =
	typeof document !== "undefined" ? document.createElement("canvas") : null;
if (sharedMeasureCanvas) {
	sharedMeasureCanvas.width = 4096;
	sharedMeasureCanvas.height = 4096;
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
		(fontSize / DEFAULT_TEXT_ELEMENT.fontSize) * (canvasHeight / referenceHeight)
	);
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

function resolveCaptionPageForWordIndex({
	pages,
	activeWordIndex,
}: {
	pages: Array<{ chunkStart: number; pageSize: number; content: string }>;
	activeWordIndex: number;
}): { chunkStart: number; pageSize: number; content: string } | null {
	if (pages.length === 0) return null;
	if (activeWordIndex < 0) return pages[0] ?? null;
	for (const page of pages) {
		if (activeWordIndex < page.chunkStart + page.pageSize) {
			return page;
		}
	}
	return pages[pages.length - 1] ?? null;
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
	backgroundReferenceCanvasSize,
	mediaAsset,
	currentTime = element.startTime,
}: {
	element: TimelineElement;
	canvasSize: { width: number; height: number };
	backgroundReferenceCanvasSize?: { width: number; height: number };
	mediaAsset?: MediaAsset | null;
	currentTime?: number;
}): ElementBounds | null {
	if (element.type === "audio") return null;
	if ("hidden" in element && element.hidden) return null;

	const { width: canvasWidth, height: canvasHeight } = canvasSize;
	const localTime = Math.max(0, currentTime - element.startTime);
	const resolvedTransform = resolveTransformAtTime({
		baseTransform: element.transform,
		animations: element.animations,
		localTime,
	});

	if (element.type === "video" || element.type === "image") {
		const sourceWidth = mediaAsset?.width ?? canvasWidth;
		const sourceHeight = mediaAsset?.height ?? canvasHeight;
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth,
			sourceHeight,
			transform: resolvedTransform,
		});
	}

	if (element.type === "sticker") {
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth: 200,
			sourceHeight: 200,
			transform: resolvedTransform,
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
				latestStartedWordIndex >= 0 ? latestStartedWordIndex : 0;
			const backgroundMode = element.captionStyle?.backgroundFitMode ?? "block";
			const pagePlanSignature = [
				captionTimingData.signature,
				canvasWidth,
				canvasHeight,
				resolvedTransform.position.x.toFixed(2),
				resolvedTransform.position.y.toFixed(2),
				resolvedTransform.scale.toFixed(4),
				resolvedTransform.rotate.toFixed(2),
				element.textAlign,
				element.fontFamily,
				element.fontSize.toFixed(3),
				element.fontWeight,
				element.fontStyle,
				lineHeight.toFixed(3),
				letterSpacing.toFixed(3),
				wordsOnScreen ?? "all",
				maxLinesOnScreen,
				backgroundMode,
				element.captionStyle?.anchorToSafeAreaBottom ?? true,
				element.captionStyle?.safeAreaBottomOffset ?? 0,
				element.captionStyle?.anchorToSafeAreaTop ?? false,
				element.captionStyle?.safeAreaTopOffset ?? 0,
				fitInCanvas ? 1 : 0,
				neverShrinkFont ? 1 : 0,
			].join("|");
			const cachedPagePlan = captionPagePlanCacheByElementId.get(element.id);
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
					const fontSizeRatio = getBackgroundFontSizeRatio({
						fontSize: element.fontSize,
						canvasHeight,
						referenceCanvasHeight: backgroundReferenceCanvasSize?.height,
					});
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
						positionX: canvasWidth / 2 + resolvedTransform.position.x,
						positionY: resolveSafeAreaAnchoredPositionY({
							canvasWidth,
							canvasHeight,
							transformPositionY: resolvedTransform.position.y,
							scale: resolvedTransform.scale,
							visualRect: candidateVisualRect,
							anchorToSafeAreaBottom:
								element.captionStyle?.anchorToSafeAreaBottom ?? true,
							safeAreaBottomOffset:
								element.captionStyle?.safeAreaBottomOffset ?? 0,
							anchorToSafeAreaTop:
								element.captionStyle?.anchorToSafeAreaTop ?? false,
							safeAreaTopOffset: element.captionStyle?.safeAreaTopOffset ?? 0,
						}),
						scale: resolvedTransform.scale,
						visualRect: candidateVisualRect,
						fitInCanvas,
					});
					if (
						candidatePlacement.effectiveScale >=
						resolvedTransform.scale - 0.001
					) {
						return size;
					}
				}

				return 1;
			};

			const pages =
				cachedPagePlan?.signature === pagePlanSignature
					? cachedPagePlan.pages
					: (() => {
							const nextPages: Array<{
								chunkStart: number;
								pageSize: number;
								content: string;
							}> = [];
							if (captionWords.length === 0) return nextPages;
							if (!shouldLimitWordsOnScreen) {
								nextPages.push({
									chunkStart: 0,
									pageSize: captionWords.length,
									content: buildLinesFromWords({
										words: captionWords,
										maxLines: maxLinesOnScreen,
									}).join("\n"),
								});
								return nextPages;
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
								const renderWords = captionWords.slice(
									pageStart,
									pageStart + pageSize,
								);
								nextPages.push({
									chunkStart: pageStart,
									pageSize,
									content: buildLinesFromWords({
										words: renderWords,
										maxLines: maxLinesOnScreen,
									}).join("\n"),
								});
								pageStart += pageSize;
							}
							return nextPages;
						})();
			if (cachedPagePlan?.signature !== pagePlanSignature) {
				captionPagePlanCacheByElementId.set(element.id, {
					signature: pagePlanSignature,
					pages,
				});
				evictOldestEntry(captionPagePlanCacheByElementId);
			}
			const activePage = resolveCaptionPageForWordIndex({
				pages,
				activeWordIndex: activeWordForWindow,
			});
			const textLayoutSignature = [
				pagePlanSignature,
				activePage?.chunkStart ?? 0,
				activePage?.pageSize ?? 0,
				element.content,
			].join("|");
			const cachedBounds = textBoundsCacheByElementId.get(element.id);
			if (cachedBounds?.signature === textLayoutSignature) {
				return cachedBounds.bounds;
			}
			const renderWords =
				captionWords.length > 0
					? captionWords.slice(
							activePage?.chunkStart ?? 0,
							(activePage?.chunkStart ?? 0) + (activePage?.pageSize ?? 0),
						)
					: [];
			const renderContent =
				renderWords.length > 0
					? (activePage?.content ??
						buildLinesFromWords({
							words: renderWords,
							maxLines: maxLinesOnScreen,
						}).join("\n"))
					: element.content;
			const maxWrapWidth =
				canvasWidth - Math.min(canvasWidth, canvasHeight) * 0.08;
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
			const fontSizeRatio = getBackgroundFontSizeRatio({
				fontSize: element.fontSize,
				canvasHeight,
				referenceCanvasHeight: backgroundReferenceCanvasSize?.height,
			});
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
				positionX: canvasWidth / 2 + resolvedTransform.position.x,
				positionY: resolveSafeAreaAnchoredPositionY({
					canvasWidth,
					canvasHeight,
					transformPositionY: resolvedTransform.position.y,
					scale: resolvedTransform.scale,
					visualRect,
					anchorToSafeAreaBottom:
						element.captionStyle?.anchorToSafeAreaBottom ?? true,
					safeAreaBottomOffset: element.captionStyle?.safeAreaBottomOffset ?? 0,
					anchorToSafeAreaTop:
						element.captionStyle?.anchorToSafeAreaTop ?? false,
					safeAreaTopOffset: element.captionStyle?.safeAreaTopOffset ?? 0,
				}),
				scale: resolvedTransform.scale,
				visualRect,
				fitInCanvas,
			});
			const localCenterX = visualRect.left + visualRect.width / 2;
			const localCenterY = visualRect.top + visualRect.height / 2;
			const scaledCenterX = localCenterX * placement.effectiveScale;
			const scaledCenterY = localCenterY * placement.effectiveScale;
			const rotationRad = (resolvedTransform.rotate * Math.PI) / 180;
			const cos = Math.cos(rotationRad);
			const sin = Math.sin(rotationRad);
			const rotatedCenterX = scaledCenterX * cos - scaledCenterY * sin;
			const rotatedCenterY = scaledCenterX * sin + scaledCenterY * cos;
			const computedBounds = {
				cx: placement.x + rotatedCenterX,
				cy: placement.y + rotatedCenterY,
				width: measuredWidth * placement.effectiveScale,
				height: measuredHeight * placement.effectiveScale,
				rotation: resolvedTransform.rotate,
			};
			textBoundsCacheByElementId.set(element.id, {
				signature: textLayoutSignature,
				bounds: computedBounds,
			});
			evictOldestEntry(textBoundsCacheByElementId);
			return computedBounds;
		}

		const width = measuredWidth * resolvedTransform.scale;
		const height = measuredHeight * resolvedTransform.scale;
		return {
			cx: canvasWidth / 2 + resolvedTransform.position.x,
			cy: canvasHeight / 2 + resolvedTransform.position.y,
			width,
			height,
			rotation: resolvedTransform.rotate,
		};
	}

	return null;
}

export function getVisibleElementsWithBounds({
	tracks,
	currentTime,
	canvasSize,
	backgroundReferenceCanvasSize,
	mediaAssets,
}: {
	tracks: TimelineTrack[];
	currentTime: number;
	canvasSize: { width: number; height: number };
	backgroundReferenceCanvasSize?: { width: number; height: number };
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
				backgroundReferenceCanvasSize,
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
