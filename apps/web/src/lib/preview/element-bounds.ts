import type {
	AudioElement,
	TextElement,
	TimelineTrack,
	TimelineElement,
	VideoElement,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { isMainTrack } from "@/lib/timeline";
import {
	DEFAULT_TEXT_ELEMENT,
	DEFAULT_LINE_HEIGHT,
	FONT_SIZE_SCALE_REFERENCE,
} from "@/constants/text-constants";
import {
	getMiddleBaselineCompensation,
	getTextVisualRectForBackgroundMode,
	measureTextBlock,
	resolveTextPlacement,
	wrapTextToWidth,
} from "@/lib/text/layout";
import { resolveElementTransformAtTime } from "@/lib/animation";
import { resolveSafeAreaAnchoredPositionY } from "@/constants/safe-area-constants";
import { toTimelineCaptionWordTimings } from "@/lib/captions/timing";
import {
	getVideoSplitScreenDividers,
	getVideoSplitScreenViewports,
	resolveVideoSplitScreenAtTime,
} from "@/lib/reframe/video-reframe";

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

type CaptionDividerPlacement = "above-divider" | "on-divider" | "below-divider";
type CaptionSourceVideoBoundsContext = {
	startTime: number;
	duration: number;
	trimStart: number;
	reframePresets?: VideoElement["reframePresets"];
	reframeSwitches?: VideoElement["reframeSwitches"];
	defaultReframePresetId?: string | null;
	splitScreen?: VideoElement["splitScreen"];
};

const DEFAULT_DIVIDER_PLACEMENT: CaptionDividerPlacement = "on-divider";
const DIVIDER_PLACEMENT_GAP = 20;

function resolveDividerPlacement(
	value: string | undefined,
): CaptionDividerPlacement {
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
): CaptionDividerPlacement | null {
	if (
		value === "above-divider" ||
		value === "on-divider" ||
		value === "below-divider"
	) {
		return value;
	}
	return null;
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

function isEditableMediaElement(
	element: TimelineElement,
): element is VideoElement | AudioElement {
	return element.type === "video" || element.type === "audio";
}

function resolveCaptionPlacementVideoCompanion({
	sourceMedia,
	candidates,
}: {
	sourceMedia: VideoElement | AudioElement;
	candidates: Array<VideoElement | AudioElement>;
}): VideoElement | null {
	if (sourceMedia.type === "video") return sourceMedia;
	let best: VideoElement | null = null;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const candidate of candidates) {
		if (candidate.id === sourceMedia.id || candidate.type !== "video") continue;
		const startDistance = Math.abs(candidate.startTime - sourceMedia.startTime);
		const trimDistance = Math.abs(candidate.trimStart - sourceMedia.trimStart);
		const endDistance = Math.abs(
			candidate.trimStart +
				candidate.duration -
				(sourceMedia.trimStart + sourceMedia.duration),
		);
		const overlap = Math.max(
			0,
			Math.min(
				candidate.startTime + candidate.duration,
				sourceMedia.startTime + sourceMedia.duration,
			) - Math.max(candidate.startTime, sourceMedia.startTime),
		);
		const score =
			overlap - startDistance * 4 - trimDistance * 3 - endDistance * 3;
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return best;
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
			Math.min(elementEnd, candidateEnd) -
				Math.max(element.startTime, candidate.startTime),
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

function resolveCaptionSplitViewport({
	captionStyle,
	captionSourceVideo,
	canvasWidth,
	canvasHeight,
	currentTime,
}: {
	captionStyle: NonNullable<TextElement["captionStyle"]>;
	captionSourceVideo?: CaptionSourceVideoBoundsContext;
	canvasWidth: number;
	canvasHeight: number;
	currentTime: number;
}) {
	if (captionStyle.splitScreenOverrides?.anchorToSplitViewport === false) {
		return null;
	}
	if (!captionSourceVideo?.splitScreen) return null;
	const localTime = Math.max(
		0,
		Math.min(captionSourceVideo.duration, currentTime - captionSourceVideo.startTime),
	);
	const activeSplitScreen = resolveVideoSplitScreenAtTime({
		element: {
			id: "__caption_source__",
			type: "video",
			mediaId: "__caption_source__",
			name: "__caption_source__",
			startTime: 0,
			duration: captionSourceVideo.duration,
			trimStart: captionSourceVideo.trimStart,
			trimEnd: 0,
			transform: DEFAULT_TEXT_ELEMENT.transform,
			opacity: 1,
			reframePresets: captionSourceVideo.reframePresets,
			reframeSwitches: captionSourceVideo.reframeSwitches,
			defaultReframePresetId: captionSourceVideo.defaultReframePresetId,
			splitScreen: captionSourceVideo.splitScreen,
		},
		localTime,
	});
	if (!activeSplitScreen) return null;
	const viewports = getVideoSplitScreenViewports({
		layoutPreset: activeSplitScreen.layoutPreset,
		viewportBalance: activeSplitScreen.viewportBalance,
		width: canvasWidth,
		height: canvasHeight,
	});
	const divider = getVideoSplitScreenDividers({
		layoutPreset: activeSplitScreen.layoutPreset,
		viewportBalance: activeSplitScreen.viewportBalance,
		width: canvasWidth,
		height: canvasHeight,
	})[0];
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
		viewports.get(resolvedSlotId) ?? Array.from(viewports.values())[0] ?? null;
	return viewport
		? {
				slotId: resolvedSlotId,
				viewportBalance: activeSplitScreen.viewportBalance ?? "balanced",
				dividerTopY: divider?.y,
				dividerBottomY: divider ? divider.y + divider.height : undefined,
				dividerCenterY: divider ? divider.y + divider.height / 2 : undefined,
				...viewport,
			}
		: null;
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
	captionSourceVideo,
	currentTime = element.startTime,
}: {
	element: TimelineElement;
	canvasSize: { width: number; height: number };
	backgroundReferenceCanvasSize?: { width: number; height: number };
	mediaAsset?: MediaAsset | null;
	captionSourceVideo?: CaptionSourceVideoBoundsContext;
	currentTime?: number;
}): ElementBounds | null {
	if (element.type === "audio") return null;
	if ("hidden" in element && element.hidden) return null;

	const { width: canvasWidth, height: canvasHeight } = canvasSize;
	const localTime = Math.max(0, currentTime - element.startTime);
	const resolvedTransform = resolveElementTransformAtTime({
		element,
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
		const effectiveCaptionStyle = {
			...(element.captionStyle ?? {}),
			...((element.captionStyle?.splitScreenOverrides?.enabled ?? true) &&
			resolveCaptionSplitViewport({
				captionStyle: (element.captionStyle ?? {}) as NonNullable<
					TextElement["captionStyle"]
				>,
				captionSourceVideo,
				canvasWidth,
				canvasHeight,
				currentTime,
			})
				? (element.captionStyle?.splitScreenOverrides ?? {})
				: {}),
			splitScreenOverrides: element.captionStyle?.splitScreenOverrides,
		} as NonNullable<TextElement["captionStyle"]>;
		const splitViewport = resolveCaptionSplitViewport({
			captionStyle: effectiveCaptionStyle,
			captionSourceVideo,
			canvasWidth,
			canvasHeight,
			currentTime,
		});
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
			const wordsOnScreenRaw = effectiveCaptionStyle.wordsOnScreen;
			const wordsOnScreen =
				typeof wordsOnScreenRaw === "number"
					? clampWordCount(wordsOnScreenRaw)
					: null;
			const neverShrinkFont = effectiveCaptionStyle.neverShrinkFont === true;
			const fitInCanvas = effectiveCaptionStyle.fitInCanvas;
			const maxLinesOnScreenRaw = effectiveCaptionStyle.maxLinesOnScreen;
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
			const backgroundMode = effectiveCaptionStyle.backgroundFitMode ?? "block";
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
				effectiveCaptionStyle.anchorToSafeAreaBottom ?? true,
				effectiveCaptionStyle.safeAreaBottomOffset ?? 0,
				effectiveCaptionStyle.anchorToSafeAreaTop ?? false,
				effectiveCaptionStyle.safeAreaTopOffset ?? 0,
				effectiveCaptionStyle.splitScreenOverrides?.slotAnchor ?? "auto",
				effectiveCaptionStyle.splitScreenOverrides?.anchorToSplitViewport ?? true,
				effectiveCaptionStyle.splitScreenOverrides?.dividerPlacement ??
					DEFAULT_DIVIDER_PLACEMENT,
				splitViewport?.slotId ?? "none",
				splitViewport?.viewportBalance ?? "none",
				splitViewport?.dividerTopY ?? "none",
				splitViewport?.dividerBottomY ?? "none",
				splitViewport?.dividerCenterY ?? "none",
				currentTime.toFixed(3),
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
						useUniformMetrics: captionWords.length > 0,
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
									effectiveCaptionStyle.anchorToSafeAreaBottom ?? true,
								safeAreaBottomOffset:
									effectiveCaptionStyle.safeAreaBottomOffset ?? 0,
								anchorToSafeAreaTop:
									effectiveCaptionStyle.anchorToSafeAreaTop ?? false,
								safeAreaTopOffset:
									effectiveCaptionStyle.safeAreaTopOffset ?? 0,
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
				useUniformMetrics: captionWords.length > 0,
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
			const explicitDividerPlacement = getExplicitDividerPlacement(
				effectiveCaptionStyle.splitScreenOverrides?.dividerPlacement,
			);
			const shouldUseExplicitDividerPlacement =
				Boolean(splitViewport) &&
				explicitDividerPlacement !== null &&
				splitViewport?.dividerCenterY !== undefined;
			const anchorsToBottomEdge =
				(effectiveCaptionStyle.anchorToSafeAreaBottom ?? true) &&
				!(effectiveCaptionStyle.anchorToSafeAreaTop ?? false);
			const shouldUseCanvasBottomPlacement =
				!shouldUseExplicitDividerPlacement &&
				Boolean(splitViewport) &&
				splitViewport?.slotId === "bottom" &&
				anchorsToBottomEdge &&
				splitViewport?.viewportBalance !== "unbalanced" &&
				splitViewport.y + splitViewport.height >= canvasHeight;
			const placementCanvasWidth = shouldUseCanvasBottomPlacement
				? canvasWidth
				: shouldUseExplicitDividerPlacement
					? canvasWidth
					: (splitViewport?.width ?? canvasWidth);
			const placementCanvasHeight = shouldUseCanvasBottomPlacement
				? canvasHeight
				: shouldUseExplicitDividerPlacement
					? canvasHeight
					: (splitViewport?.height ?? canvasHeight);
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
				transformPositionY: resolvedTransform.position.y,
				scale: resolvedTransform.scale,
				visualRect,
				anchorToSafeAreaBottom:
					effectiveCaptionStyle.anchorToSafeAreaBottom ?? true,
				safeAreaBottomOffset: effectiveCaptionStyle.safeAreaBottomOffset ?? 0,
				anchorToSafeAreaTop:
					effectiveCaptionStyle.anchorToSafeAreaTop ?? false,
				safeAreaTopOffset: effectiveCaptionStyle.safeAreaTopOffset ?? 0,
			});
			const resolvedPositionY = shouldUseExplicitDividerPlacement
				? (() => {
						const dividerPlacement = resolveDividerPlacement(
							explicitDividerPlacement,
						);
						const dividerTopY = splitViewport?.dividerTopY ?? splitViewport?.y ?? 0;
						const dividerBottomY =
							splitViewport?.dividerBottomY ?? splitViewport?.y ?? 0;
						const dividerCenterY =
							splitViewport?.dividerCenterY ?? splitViewport?.y ?? 0;
						const halfHeight = (visualRect.height * resolvedTransform.scale) / 2;
						const baselineCompensation =
							getMiddleBaselineCompensation({
								fallbackFontSize: scaledFontSize,
							}) * resolvedTransform.scale;
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
				positionX: placementCanvasWidth / 2 + resolvedTransform.position.x,
				positionY: resolvedPositionY,
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
				cx: placement.x + placementOffsetX + rotatedCenterX,
				cy: placement.y + placementOffsetY + rotatedCenterY,
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
	const mediaElements = tracks.flatMap((track) =>
		track.elements.filter(isEditableMediaElement),
	);
	const mediaElementById = new Map(mediaElements.map((element) => [element.id, element]));
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
			const sourceMediaId =
				element.type === "text"
					? (element.captionSourceRef?.mediaElementId ?? null)
					: null;
			const sourceMediaFromRef = sourceMediaId
				? mediaElementById.get(sourceMediaId) ?? null
				: null;
			const sourceMedia =
				sourceMediaFromRef ??
				(element.type === "text"
					? resolveCaptionSourceMediaHeuristically({
							element,
							candidates: mediaElements,
						})
					: null);
			const captionSourceVideo =
				sourceMedia && isEditableMediaElement(sourceMedia)
					? resolveCaptionPlacementVideoCompanion({
							sourceMedia,
							candidates: mediaElements,
						})
					: null;
			const bounds = getElementBounds({
				element,
				canvasSize,
				backgroundReferenceCanvasSize,
				mediaAsset,
				captionSourceVideo: captionSourceVideo
					? {
							startTime: captionSourceVideo.startTime,
							duration: captionSourceVideo.duration,
							trimStart: captionSourceVideo.trimStart,
							reframePresets: captionSourceVideo.reframePresets,
							reframeSwitches: captionSourceVideo.reframeSwitches,
							defaultReframePresetId: captionSourceVideo.defaultReframePresetId,
							splitScreen: captionSourceVideo.splitScreen,
						}
					: undefined,
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
