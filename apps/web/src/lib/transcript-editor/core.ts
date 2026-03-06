import {
	CAPTION_TAIL_PAD_SECONDS,
	DEFAULT_PAUSE_REMOVAL_MIN_GAP_SECONDS,
	PAUSE_REMOVAL_CUT_END_PADDING_SECONDS,
	PAUSE_REMOVAL_CUT_START_PADDING_SECONDS,
} from "@/lib/transcript-editor/constants";
import type {
	TranscriptEditCutRange,
	TranscriptEditWord,
} from "@/types/transcription";

export type TranscriptEditState = {
	version: 1;
	source: "word-level";
	words: TranscriptEditWord[];
	cuts: TranscriptEditCutRange[];
	segmentsUi?: Array<{
		id: string;
		wordStartIndex: number;
		wordEndIndex: number;
		label?: string;
	}>;
	updatedAt: string;
};

export const DEFAULT_FILLER_TOKENS = new Set([
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

export const DEFAULT_FILLER_PHRASES = new Set([
	"you know",
	"i mean",
	"kind of",
	"sort of",
]);

function mergeCutReason({
	previous,
	current,
}: {
	previous: TranscriptEditCutRange["reason"];
	current: TranscriptEditCutRange["reason"];
}): TranscriptEditCutRange["reason"] {
	if (previous === "manual" || current === "manual") return "manual";
	if (previous === "filler" || current === "filler") return "filler";
	return "pause";
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function normalizeToken(token: string): string {
	return token
		.toLowerCase()
		.replace(/[^\p{L}\p{N}'\s]+/gu, "")
		.trim();
}

function rangesOverlap({
	aStart,
	aEnd,
	bStart,
	bEnd,
}: {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
}): boolean {
	return aEnd > bStart && aStart < bEnd;
}

export function isFillerWordOrPhrase({ text }: { text: string }): boolean {
	const normalized = normalizeToken(text);
	if (!normalized) return true;
	if (DEFAULT_FILLER_PHRASES.has(normalized)) return true;
	const parts = normalized.split(/\s+/).filter(Boolean);
	if (parts.length === 0) return true;
	if (parts.length > 3) return false;
	return parts.every((part) => DEFAULT_FILLER_TOKENS.has(part));
}

export function normalizeTranscriptWords({
	words,
}: {
	words: TranscriptEditWord[];
}): TranscriptEditWord[] {
	return [...words]
		.filter(
			(word) =>
				Number.isFinite(word.startTime) &&
				Number.isFinite(word.endTime) &&
				word.endTime > word.startTime,
		)
		.map((word) => ({
			...word,
			text: word.text.trim(),
			startTime: Math.max(0, word.startTime),
			endTime: Math.max(word.startTime + 0.01, word.endTime),
		}))
		.filter((word) => word.text.length > 0)
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.endTime - b.endTime;
		});
}

export function mergeCutRanges({
	cuts,
}: {
	cuts: TranscriptEditCutRange[];
}): TranscriptEditCutRange[] {
	const sorted = [...cuts]
		.filter(
			(cut) =>
				Number.isFinite(cut.start) &&
				Number.isFinite(cut.end) &&
				cut.end > cut.start,
		)
		.map((cut) => ({
			...cut,
			start: Math.max(0, cut.start),
			end: Math.max(cut.start + 0.01, cut.end),
		}))
		.sort((a, b) => a.start - b.start);
	if (sorted.length === 0) return [];

	const merged: TranscriptEditCutRange[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const current = sorted[i];
		const previous = merged[merged.length - 1];
		if (current.start <= previous.end + 0.01) {
			previous.end = Math.max(previous.end, current.end);
			previous.reason = mergeCutReason({
				previous: previous.reason,
				current: current.reason,
			});
			continue;
		}
		merged.push({ ...current });
	}
	return merged;
}

export function applyCutRangesToWords({
	words,
	cuts,
}: {
	words: TranscriptEditWord[];
	cuts: TranscriptEditCutRange[];
}): TranscriptEditWord[] {
	const normalizedWords = normalizeTranscriptWords({ words });
	const mergedCuts = mergeCutRanges({ cuts });
	if (mergedCuts.length === 0) {
		return normalizedWords.map((word) => ({
			...word,
			removed: Boolean(word.removed),
		}));
	}

	return normalizedWords.map((word) => {
		const removedByCuts = mergedCuts.some(
			(cut) =>
				cut.reason !== "pause" &&
				rangesOverlap({
					aStart: word.startTime,
					aEnd: word.endTime,
					bStart: cut.start,
					bEnd: cut.end,
				}),
		);
		return {
			...word,
			removed: Boolean(word.removed) || removedByCuts,
		};
	});
}

export function buildTranscriptCutsFromWords({
	words,
}: {
	words: TranscriptEditWord[];
}): TranscriptEditCutRange[] {
	const normalized = normalizeTranscriptWords({ words });
	const rawCuts: TranscriptEditCutRange[] = [];
	let index = 0;
	while (index < normalized.length) {
		const word = normalized[index];
		if (!word.removed) {
			index += 1;
			continue;
		}

		const previousKeptWord = (() => {
			for (let cursor = index - 1; cursor >= 0; cursor--) {
				const candidate = normalized[cursor];
				if (!candidate) continue;
				if (!candidate.removed) return candidate;
			}
			return null;
		})();
		const rangeStart = previousKeptWord
			? Math.min(word.startTime, previousKeptWord.endTime)
			: word.startTime;
		let rangeEnd = word.endTime;
		let cursor = index + 1;

		// Collapse contiguous removed words into one cut and include their inter-word gaps.
		while (cursor < normalized.length && normalized[cursor]?.removed) {
			rangeEnd = Math.max(rangeEnd, normalized[cursor].endTime);
			cursor += 1;
		}

		// Extend through the transient gap until the next kept word starts.
		const nextKeptWord = normalized[cursor];
		if (nextKeptWord) {
			rangeEnd = Math.max(rangeEnd, nextKeptWord.startTime);
		}

		rawCuts.push({
			start: rangeStart,
			end: rangeEnd,
			reason: "manual",
		});
		index = cursor;
	}
	return mergeCutRanges({ cuts: rawCuts });
}

export function projectTranscriptEditToWindow({
	transcriptEdit,
	elementId,
	sourceStart,
	sourceEnd,
}: {
	transcriptEdit: TranscriptEditState;
	elementId: string;
	sourceStart: number;
	sourceEnd: number;
}): TranscriptEditState {
	const windowStart = Math.min(sourceStart, sourceEnd);
	const windowEnd = Math.max(windowStart, Math.max(sourceStart, sourceEnd));
	const projectedWords = normalizeTranscriptWords({
		words: transcriptEdit.words
			.filter(
				(word) => word.endTime > windowStart && word.startTime < windowEnd,
			)
			.map((word) => ({
				...word,
				startTime: Math.max(
					0,
					Math.min(windowEnd, word.startTime) - windowStart,
				),
				endTime: Math.max(0, Math.min(windowEnd, word.endTime) - windowStart),
			})),
	});
	const projectedCuts =
		transcriptEdit.cuts.length > 0
			? mergeCutRanges({
					cuts: transcriptEdit.cuts
						.map((cut) => ({
							start: Math.max(windowStart, cut.start),
							end: Math.min(windowEnd, cut.end),
							reason: cut.reason,
						}))
						.filter((cut) => cut.end - cut.start > 0.01)
						.map((cut) => ({
							start: Math.max(0, cut.start - windowStart),
							end: Math.max(0.01, cut.end - windowStart),
							reason: cut.reason,
						})),
				})
			: buildTranscriptCutsFromWords({ words: projectedWords });
	const segmentsUi =
		projectedWords.length === 0
			? []
			: [
					{
						id: `${elementId}:seg:0`,
						wordStartIndex: 0,
						wordEndIndex: projectedWords.length - 1,
					},
				];

	return {
		...transcriptEdit,
		words: projectedWords,
		cuts: projectedCuts,
		segmentsUi,
		updatedAt: new Date().toISOString(),
	};
}

export function buildPauseCutsFromWords({
	words,
	thresholdSeconds = DEFAULT_PAUSE_REMOVAL_MIN_GAP_SECONDS,
	startPaddingSeconds = PAUSE_REMOVAL_CUT_START_PADDING_SECONDS,
	endPaddingSeconds = PAUSE_REMOVAL_CUT_END_PADDING_SECONDS,
}: {
	words: TranscriptEditWord[];
	thresholdSeconds?: number;
	startPaddingSeconds?: number;
	endPaddingSeconds?: number;
}): TranscriptEditCutRange[] {
	const normalized = normalizeTranscriptWords({ words }).filter(
		(word) => !word.removed,
	);
	const minGap = Math.max(0.01, thresholdSeconds);
	const prePad = Math.max(0, startPaddingSeconds);
	const resumePad = Math.max(0, endPaddingSeconds);
	const rawCuts: TranscriptEditCutRange[] = [];

	for (let index = 0; index < normalized.length - 1; index++) {
		const currentWord = normalized[index];
		const nextWord = normalized[index + 1];
		if (!currentWord || !nextWord) continue;
		const gap = nextWord.startTime - currentWord.endTime;
		if (gap <= minGap) continue;
		const start = Math.max(0, currentWord.endTime + prePad);
		const end = Math.max(start + 0.01, nextWord.startTime - resumePad);
		if (end - start <= 0.01) continue;
		rawCuts.push({
			start,
			end,
			reason: "pause",
		});
	}

	return mergeCutRanges({ cuts: rawCuts });
}

export function buildCompressedCutBoundaryTimes({
	cuts,
}: {
	cuts: TranscriptEditCutRange[];
}): number[] {
	const merged = mergeCutRanges({ cuts });
	if (merged.length === 0) return [];
	const boundaries: number[] = [];
	let sourceCursor = 0;
	let compressedCursor = 0;
	for (const cut of merged) {
		const keepDuration = Math.max(0, cut.start - sourceCursor);
		const boundaryTime = compressedCursor + keepDuration;
		boundaries.push(boundaryTime);
		compressedCursor = boundaryTime;
		sourceCursor = Math.max(sourceCursor, cut.end);
	}
	return boundaries;
}

export function mapCompressedTimeToSourceTime({
	compressedTime,
	cuts,
}: {
	compressedTime: number;
	cuts: TranscriptEditCutRange[];
}): number {
	const safeTime = Math.max(0, compressedTime);
	const merged = mergeCutRanges({ cuts });
	let sourceCursor = 0;
	let compressedCursor = 0;
	for (const cut of merged) {
		const keep = Math.max(0, cut.start - sourceCursor);
		if (safeTime <= compressedCursor + keep) {
			return sourceCursor + (safeTime - compressedCursor);
		}
		compressedCursor += keep;
		sourceCursor = Math.max(sourceCursor, cut.end);
	}
	return sourceCursor + (safeTime - compressedCursor);
}

export function mapSourceTimeToCompressedTime({
	sourceTime,
	cuts,
}: {
	sourceTime: number;
	cuts: TranscriptEditCutRange[];
}): number {
	const safeTime = Math.max(0, sourceTime);
	const merged = mergeCutRanges({ cuts });
	let sourceCursor = 0;
	let compressedCursor = 0;
	for (const cut of merged) {
		const keepBeforeCut = Math.max(0, cut.start - sourceCursor);
		const cutBoundary = compressedCursor + keepBeforeCut;
		if (safeTime <= cut.start) {
			return compressedCursor + (safeTime - sourceCursor);
		}
		if (safeTime <= cut.end) {
			return cutBoundary;
		}
		compressedCursor = cutBoundary;
		sourceCursor = cut.end;
	}
	return compressedCursor + (safeTime - sourceCursor);
}

export function computeKeepDuration({
	originalDuration,
	cuts,
}: {
	originalDuration: number;
	cuts: TranscriptEditCutRange[];
}): number {
	const merged = mergeCutRanges({ cuts });
	let removed = 0;
	for (const cut of merged) {
		const start = clamp(cut.start, 0, originalDuration);
		const end = clamp(cut.end, 0, originalDuration);
		if (end > start) removed += end - start;
	}
	return Math.max(0.04, originalDuration - removed);
}

export function buildCaptionPayloadFromTranscriptWords({
	words,
	cuts,
}: {
	words: TranscriptEditWord[];
	cuts?: TranscriptEditCutRange[];
}): {
	content: string;
	startTime: number;
	duration: number;
	wordTimings: Array<{ word: string; startTime: number; endTime: number }>;
} | null {
	const normalized = normalizeTranscriptWords({ words });
	const transcriptCuts = cuts
		? mergeCutRanges({ cuts })
		: buildTranscriptCutsFromWords({ words: normalized });
	const wordsWithCutState = applyCutRangesToWords({
		words: normalized,
		cuts: transcriptCuts,
	});
	// Captions intentionally hide filler words even when transcript keeps them editable.
	const active = wordsWithCutState.filter(
		(word) => !word.removed && !isFillerWordOrPhrase({ text: word.text }),
	);
	if (active.length === 0) return null;

	const timings = active
		.map((word) => {
			const startTime = mapSourceTimeToCompressedTime({
				sourceTime: word.startTime,
				cuts: transcriptCuts,
			});
			const endTime = Math.max(
				startTime + 0.01,
				mapSourceTimeToCompressedTime({
					sourceTime: word.endTime,
					cuts: transcriptCuts,
				}),
			);
			return {
				word: word.text,
				startTime,
				endTime,
			};
		})
		.filter((timing) => timing.word.trim().length > 0);

	if (timings.length === 0) return null;

	const content = timings
		.map((timing) => timing.word)
		.join(" ")
		.trim();
	const startTime = timings[0].startTime;
	const endTime = timings[timings.length - 1].endTime;
	return {
		content,
		startTime,
		duration: Math.max(0.04, endTime - startTime + CAPTION_TAIL_PAD_SECONDS),
		wordTimings: timings,
	};
}

export function withFillerWordsRemoved({
	words,
}: {
	words: TranscriptEditWord[];
}): TranscriptEditWord[] {
	return words.map((word) =>
		isFillerWordOrPhrase({ text: word.text })
			? { ...word, removed: true }
			: word,
	);
}
