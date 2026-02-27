import type { MediaAsset } from "@/types/assets";
import type { TranscriptionSegment } from "@/types/transcription";
import type { TimelineElement, TimelineTrack } from "@/types/timeline";
import { decodeAudioToFloat32 } from "@/lib/media/audio";
import { generateUUID } from "@/utils/id";

const MIN_SEGMENT_DURATION_S = 0.2;
const ANALYSIS_WINDOW_S = 0.05;

const analysisCache = new Map<string, Promise<SmartCutAnalysis>>();

export interface SmartCutAnalysis {
	rmsWindowSeconds: number;
	rms: Float32Array;
	sampleRate: number;
}

export interface SmartCutOptions {
	thresholdMultiplier: number;
	minSilenceSeconds: number;
	paddingSeconds: number;
	minKeepSeconds: number;
}

export interface SmartCutResult {
	segments: Array<{ start: number; end: number }>;
	removedDuration: number;
}

export const DEFAULT_SMART_CUT_OPTIONS: SmartCutOptions = {
	thresholdMultiplier: 2.25,
	minSilenceSeconds: 0.35,
	paddingSeconds: 0.06,
	minKeepSeconds: 0.2,
};

export interface TranscriptSmartCutOptions {
	minSilenceSeconds: number;
	speechPaddingSeconds: number;
	fillerPaddingSeconds: number;
	boundarySafetyPaddingSeconds: number;
	minKeepSeconds: number;
	removeFillers: boolean;
}

export const DEFAULT_TRANSCRIPT_SMART_CUT_OPTIONS: TranscriptSmartCutOptions = {
	minSilenceSeconds: 0.28,
	speechPaddingSeconds: 0.05,
	fillerPaddingSeconds: 0.03,
	boundarySafetyPaddingSeconds: 0.06,
	minKeepSeconds: 0.18,
	removeFillers: true,
};

const FILLER_SINGLE_TOKENS = new Set([
	"um",
	"uh",
	"umm",
	"uhh",
	"erm",
	"hmm",
	"mm",
	"ah",
	"eh",
	"like",
]);

const FILLER_PHRASES = new Set([
	"you know",
	"i mean",
	"sort of",
	"kind of",
]);

function getMediaDurationBase({ element }: { element: TimelineElement }): number {
	return element.trimStart + element.duration + element.trimEnd;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function subtractIntervals({
	base,
	cuts,
}: {
	base: { start: number; end: number };
	cuts: Array<{ start: number; end: number }>;
}): Array<{ start: number; end: number }> {
	const normalizedCuts = cuts
		.map((cut) => ({
			start: clamp(cut.start, base.start, base.end),
			end: clamp(cut.end, base.start, base.end),
		}))
		.filter((cut) => cut.end - cut.start > 0)
		.sort((a, b) => a.start - b.start);

	if (normalizedCuts.length === 0) return [base];

	const merged: Array<{ start: number; end: number }> = [];
	for (const cut of normalizedCuts) {
		const previous = merged[merged.length - 1];
		if (!previous || cut.start > previous.end) {
			merged.push(cut);
		} else {
			previous.end = Math.max(previous.end, cut.end);
		}
	}

	const segments: Array<{ start: number; end: number }> = [];
	let cursor = base.start;
	for (const cut of merged) {
		if (cut.start > cursor) {
			segments.push({ start: cursor, end: cut.start });
		}
		cursor = Math.max(cursor, cut.end);
	}
	if (cursor < base.end) {
		segments.push({ start: cursor, end: base.end });
	}

	return segments;
}

function quantile(values: Float32Array, q: number): number {
	if (values.length === 0) return 0;
	const sorted = Array.from(values).sort((a, b) => a - b);
	const index = Math.floor((sorted.length - 1) * q);
	return sorted[index] ?? 0;
}

function normalizeToken(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}'\s]+/gu, "")
		.trim();
}

function isFillerSegment({ text }: { text: string }): boolean {
	const normalized = normalizeToken(text);
	if (!normalized) return true;
	if (FILLER_PHRASES.has(normalized)) return true;

	const tokens = normalized.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return true;
	if (tokens.length > 3) return false;
	return tokens.every((token) => FILLER_SINGLE_TOKENS.has(token));
}

function mergeRanges({
	ranges,
	joinGapSeconds,
}: {
	ranges: Array<{ start: number; end: number }>;
	joinGapSeconds: number;
}): Array<{ start: number; end: number }> {
	const sorted = [...ranges]
		.filter((range) => range.end - range.start > 0)
		.sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (!previous) {
			merged.push({ ...range });
			continue;
		}
		if (range.start <= previous.end + joinGapSeconds) {
			previous.end = Math.max(previous.end, range.end);
			continue;
		}
		merged.push({ ...range });
	}
	return merged;
}

export function computeSmartCutFromTranscriptForElement({
	element,
	segments,
	options = DEFAULT_TRANSCRIPT_SMART_CUT_OPTIONS,
}: {
	element: TimelineElement;
	segments: TranscriptionSegment[];
	options?: TranscriptSmartCutOptions;
}): SmartCutResult {
	const timelineStart = element.startTime;
	const timelineEnd = element.startTime + element.duration;
	const mediaVisibleStart = element.trimStart;
	const mediaVisibleEnd = element.trimStart + element.duration;

	const overlapping = segments.filter(
		(segment) =>
			Number.isFinite(segment.start) &&
			Number.isFinite(segment.end) &&
			segment.end > timelineStart &&
			segment.start < timelineEnd,
	);

	if (overlapping.length === 0) {
		return {
			segments: [{ start: mediaVisibleStart, end: mediaVisibleEnd }],
			removedDuration: 0,
		};
	}

	const speechRanges: Array<{ start: number; end: number }> = [];
	const fillerRanges: Array<{ start: number; end: number }> = [];

	for (const segment of overlapping) {
		const boundedTimelineStart = clamp(segment.start, timelineStart, timelineEnd);
		const boundedTimelineEnd = clamp(segment.end, timelineStart, timelineEnd);
		if (boundedTimelineEnd - boundedTimelineStart <= 0.01) continue;

		const localStart =
			element.trimStart + (boundedTimelineStart - element.startTime);
		const localEnd = element.trimStart + (boundedTimelineEnd - element.startTime);
		const candidate = { start: localStart, end: localEnd };

		if (options.removeFillers && isFillerSegment({ text: segment.text })) {
			fillerRanges.push(candidate);
		} else {
			speechRanges.push(candidate);
		}
	}

	if (speechRanges.length === 0) {
		return {
			segments: [{ start: mediaVisibleStart, end: mediaVisibleEnd }],
			removedDuration: 0,
		};
	}

	const paddedSpeech = speechRanges.map((range) => ({
		start: range.start - options.speechPaddingSeconds,
		end: range.end + options.speechPaddingSeconds,
	}));

	const mergedSpeech = mergeRanges({
		ranges: paddedSpeech,
		joinGapSeconds: options.minSilenceSeconds,
	})
		.map((range) => ({
			start: clamp(range.start, mediaVisibleStart, mediaVisibleEnd),
			end: clamp(range.end, mediaVisibleStart, mediaVisibleEnd),
		}))
		.filter(
			(range) =>
				range.end - range.start >=
				Math.max(MIN_SEGMENT_DURATION_S, options.minKeepSeconds),
		);

	let keepSegments = mergedSpeech;

	if (options.removeFillers && fillerRanges.length > 0) {
		const fillerCuts = fillerRanges.map((range) => ({
			start: range.start - options.fillerPaddingSeconds,
			end: range.end + options.fillerPaddingSeconds,
		}));

		const nextKeep: Array<{ start: number; end: number }> = [];
		for (const keep of keepSegments) {
			const split = subtractIntervals({
				base: keep,
				cuts: fillerCuts,
			}).filter(
				(range) =>
					range.end - range.start >=
					Math.max(MIN_SEGMENT_DURATION_S, options.minKeepSeconds),
			);
			nextKeep.push(...split);
		}
		keepSegments = mergeRanges({
			ranges: nextKeep,
			joinGapSeconds: 0.04,
		});
	}

	// Final safety expansion to avoid clipping the first/last phoneme around cuts.
	keepSegments = mergeRanges({
		ranges: keepSegments.map((segment) => ({
			start: clamp(
				segment.start - options.boundarySafetyPaddingSeconds,
				mediaVisibleStart,
				mediaVisibleEnd,
			),
			end: clamp(
				segment.end + options.boundarySafetyPaddingSeconds,
				mediaVisibleStart,
				mediaVisibleEnd,
			),
		})),
		joinGapSeconds: 0.03,
	}).filter(
		(segment) =>
			segment.end - segment.start >=
			Math.max(MIN_SEGMENT_DURATION_S, options.minKeepSeconds),
	);

	if (keepSegments.length === 0) {
		return {
			segments: [{ start: mediaVisibleStart, end: mediaVisibleEnd }],
			removedDuration: 0,
		};
	}

	const keptDuration = keepSegments.reduce(
		(sum, segment) => sum + (segment.end - segment.start),
		0,
	);

	return {
		segments: keepSegments,
		removedDuration: Math.max(0, element.duration - keptDuration),
	};
}

export async function analyzeMediaForSmartCut({
	media,
	cacheKey,
}: {
	media: MediaAsset;
	cacheKey: string;
}): Promise<SmartCutAnalysis> {
	const cached = analysisCache.get(cacheKey);
	if (cached) return cached;

	const analysisPromise = (async () => {
		let decoded: Awaited<ReturnType<typeof decodeAudioToFloat32>> | null = null;
		try {
			decoded = await decodeAudioToFloat32({
				audioBlob: media.file,
			});
		} catch (error) {
			const isNotReadable =
				error instanceof DOMException || (error as { name?: string })?.name === "NotReadableError";
			if (!isNotReadable || !media.url) {
				throw error;
			}

			// Playback may still work via object URL even when file handle is stale
			// (common with network shares). Retry by fetching the blob URL.
			const response = await fetch(media.url);
			if (!response.ok) {
				throw error;
			}
			const blob = await response.blob();
			decoded = await decodeAudioToFloat32({
				audioBlob: blob,
			});
		}

		const { samples, sampleRate } = decoded;

		const windowSize = Math.max(64, Math.floor(sampleRate * ANALYSIS_WINDOW_S));
		const windowCount = Math.max(1, Math.ceil(samples.length / windowSize));
		const rms = new Float32Array(windowCount);

		for (let i = 0; i < windowCount; i++) {
			const start = i * windowSize;
			const end = Math.min(start + windowSize, samples.length);
			let sum = 0;
			for (let j = start; j < end; j++) {
				const value = samples[j] ?? 0;
				sum += value * value;
			}
			const size = Math.max(1, end - start);
			rms[i] = Math.sqrt(sum / size);
		}

		return {
			rmsWindowSeconds: windowSize / sampleRate,
			rms,
			sampleRate,
		};
	})();

	analysisCache.set(cacheKey, analysisPromise);
	try {
		return await analysisPromise;
	} catch (error) {
		analysisCache.delete(cacheKey);
		throw error;
	}
}

export function computeSmartCutForElement({
	element,
	analysis,
	options = DEFAULT_SMART_CUT_OPTIONS,
}: {
	element: TimelineElement;
	analysis: SmartCutAnalysis;
	options?: SmartCutOptions;
}): SmartCutResult {
	const visibleStart = element.trimStart;
	const visibleEnd = element.trimStart + element.duration;
	const windowSeconds = analysis.rmsWindowSeconds;

	const startIndex = clamp(
		Math.floor(visibleStart / windowSeconds),
		0,
		analysis.rms.length - 1,
	);
	const endIndex = clamp(
		Math.ceil(visibleEnd / windowSeconds),
		0,
		analysis.rms.length,
	);
	const visibleRms = analysis.rms.slice(startIndex, endIndex);
	const noiseFloor = quantile(visibleRms, 0.2);
	const threshold = Math.max(0.006, noiseFloor * options.thresholdMultiplier);

	const silentRanges: Array<{ start: number; end: number }> = [];
	let runStart = -1;
	for (let i = startIndex; i < endIndex; i++) {
		const isSilent = (analysis.rms[i] ?? 0) < threshold;
		if (isSilent && runStart === -1) {
			runStart = i;
		}
		if (!isSilent && runStart !== -1) {
			silentRanges.push({
				start: runStart * windowSeconds,
				end: i * windowSeconds,
			});
			runStart = -1;
		}
	}
	if (runStart !== -1) {
		silentRanges.push({
			start: runStart * windowSeconds,
			end: endIndex * windowSeconds,
		});
	}

	const eligibleCuts = silentRanges
		.filter((range) => range.end - range.start >= options.minSilenceSeconds)
		.map((range) => ({
			start: range.start + options.paddingSeconds,
			end: range.end - options.paddingSeconds,
		}))
		.filter((range) => range.end - range.start >= MIN_SEGMENT_DURATION_S);

	const keepSegments = subtractIntervals({
		base: { start: visibleStart, end: visibleEnd },
		cuts: eligibleCuts,
	}).filter(
		(segment) =>
			segment.end - segment.start >=
			Math.max(MIN_SEGMENT_DURATION_S, options.minKeepSeconds),
	);

	if (keepSegments.length === 0) {
		return {
			segments: [{ start: visibleStart, end: visibleEnd }],
			removedDuration: 0,
		};
	}

	const keptDuration = keepSegments.reduce(
		(sum, segment) => sum + (segment.end - segment.start),
		0,
	);
	return {
		segments: keepSegments,
		removedDuration: Math.max(0, element.duration - keptDuration),
	};
}

export function applySmartCutsToTracks({
	tracks,
	selectedElements,
	resultsByElementKey,
	ripple,
}: {
	tracks: TimelineTrack[];
	selectedElements: Array<{ trackId: string; elementId: string }>;
	resultsByElementKey: Map<string, SmartCutResult>;
	ripple: boolean;
}): { tracks: TimelineTrack[]; totalRemovedDuration: number; changedElements: number } {
	const selectedSet = new Set(
		selectedElements.map((selected) => `${selected.trackId}:${selected.elementId}`),
	);
	let totalRemovedDuration = 0;
	let changedElements = 0;

	const applyToElements = <T extends TimelineElement>({
		trackId,
		elements,
	}: {
		trackId: string;
		elements: T[];
	}): T[] => {
		let rippleShift = 0;
		const sortedElements = [...elements].sort(
			(a, b) => a.startTime - b.startTime,
		);
		const updatedElements = sortedElements.flatMap((element) => {
			const selectionKey = `${trackId}:${element.id}`;
			const shouldProcess = selectedSet.has(selectionKey);
			const startTimeWithShift = element.startTime - rippleShift;

			if (!shouldProcess) {
				if (rippleShift > 0) {
					return [{ ...element, startTime: startTimeWithShift }];
				}
				return [element];
			}

			const smartCut = resultsByElementKey.get(selectionKey);
			if (!smartCut || smartCut.segments.length === 0) {
				if (rippleShift > 0) {
					return [{ ...element, startTime: startTimeWithShift }];
				}
				return [element];
			}

			const mediaDurationBase = getMediaDurationBase({ element });
			const firstSegment = smartCut.segments[0];
			const lastSegment = smartCut.segments[smartCut.segments.length - 1];
			const singleSegment = smartCut.segments.length === 1;
			const boundaryChanged =
				Math.abs(firstSegment.start - element.trimStart) > 1e-3 ||
				Math.abs(lastSegment.end - (element.trimStart + element.duration)) > 1e-3;

			if (singleSegment && !boundaryChanged && smartCut.removedDuration <= 1e-3) {
				if (rippleShift > 0) {
					return [{ ...element, startTime: startTimeWithShift }];
				}
				return [element];
			}

			if (singleSegment) {
				const keep = firstSegment;
				const nextDuration = Math.max(0.04, keep.end - keep.start);
				const trimmedElement = {
					...element,
					startTime: startTimeWithShift,
					duration: nextDuration,
					trimStart: keep.start,
					trimEnd: Math.max(0, mediaDurationBase - keep.end),
				};

				totalRemovedDuration += Math.max(0, element.duration - nextDuration);
				changedElements += 1;
				if (ripple && smartCut.removedDuration > 0) {
					rippleShift += smartCut.removedDuration;
				}

				return [trimmedElement];
			}

			let timelineCursor = startTimeWithShift;
			const replacement = smartCut.segments.map((segment, segmentIndex) => {
				const duration = segment.end - segment.start;
				const nextElement = {
					...element,
					id: generateUUID(),
					name: `${element.name} (smart ${segmentIndex + 1})`,
					startTime: timelineCursor,
					duration,
					trimStart: segment.start,
					trimEnd: Math.max(0, mediaDurationBase - segment.end),
				};
				timelineCursor += duration;
				return nextElement;
			});

			totalRemovedDuration += smartCut.removedDuration;
			changedElements += 1;
			if (ripple && smartCut.removedDuration > 0) {
				rippleShift += smartCut.removedDuration;
			}

			return replacement as T[];
		});

		return updatedElements.sort((a, b) => a.startTime - b.startTime);
	};

	const updatedTracks = tracks.map((track) => {
		switch (track.type) {
			case "video":
				return {
					...track,
					elements: applyToElements({ trackId: track.id, elements: track.elements }),
				};
			case "audio":
				return {
					...track,
					elements: applyToElements({ trackId: track.id, elements: track.elements }),
				};
			case "text":
				return {
					...track,
					elements: applyToElements({ trackId: track.id, elements: track.elements }),
				};
			case "sticker":
				return {
					...track,
					elements: applyToElements({ trackId: track.id, elements: track.elements }),
				};
		}
	});

	return { tracks: updatedTracks, totalRemovedDuration, changedElements };
}
