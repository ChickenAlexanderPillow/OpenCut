import { CAPTION_TAIL_PAD_SECONDS } from "@/lib/transcript-editor/constants";
import type {
	TranscriptEditCutRange,
	TranscriptEditWord,
} from "@/types/transcription";

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
			previous.reason =
				previous.reason === "manual" || current.reason === "manual"
					? "manual"
					: "filler";
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
		const removedByCuts = mergedCuts.some((cut) =>
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
	const rawCuts = words
		.filter((word) => word.removed)
		.map((word) => ({
			start: word.startTime,
			end: word.endTime,
			reason: "manual" as const,
		}));
	return mergeCutRanges({ cuts: rawCuts });
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
		if (safeTime < cut.start) {
			return compressedCursor + (safeTime - sourceCursor);
		}
		if (safeTime <= cut.end) {
			return compressedCursor;
		}
		compressedCursor += Math.max(0, cut.start - sourceCursor);
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
}: {
	words: TranscriptEditWord[];
}): {
	content: string;
	startTime: number;
	duration: number;
	wordTimings: Array<{ word: string; startTime: number; endTime: number }>;
} | null {
	const normalized = normalizeTranscriptWords({ words });
	const cuts = buildTranscriptCutsFromWords({ words: normalized });
	const active = normalized.filter((word) => !word.removed);
	if (active.length === 0) return null;

	const timings = active
		.map((word) => {
			const startTime = mapSourceTimeToCompressedTime({
				sourceTime: word.startTime,
				cuts,
			});
			const endTime = Math.max(
				startTime + 0.01,
				mapSourceTimeToCompressedTime({
					sourceTime: word.endTime,
					cuts,
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
