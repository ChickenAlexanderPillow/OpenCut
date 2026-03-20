import {
	DEFAULT_PAUSE_REMOVAL_MIN_GAP_SECONDS,
	PAUSE_REMOVAL_CUT_END_PADDING_SECONDS,
	PAUSE_REMOVAL_CUT_START_PADDING_SECONDS,
} from "@/lib/transcript-editor/constants";
import type {
	TranscriptCutTimeDomain,
	TranscriptEditCutRange,
	TranscriptGapEdit,
	TranscriptEditWord,
} from "@/types/transcription";

export type TranscriptEditState = {
	version: 1;
	source: "word-level";
	words: TranscriptEditWord[];
	cuts: TranscriptEditCutRange[];
	cutTimeDomain?: TranscriptCutTimeDomain;
	projectionSource?: {
		words: TranscriptEditWord[];
		cuts: TranscriptEditCutRange[];
		updatedAt: string;
		baseTrimStart: number;
	};
	segmentsUi?: Array<{
		id: string;
		wordStartIndex: number;
		wordEndIndex: number;
		label?: string;
	}>;
	speakerLabels?: Record<string, string>;
	gapEdits?: Record<string, TranscriptGapEdit>;
	updatedAt: string;
};

export function buildTranscriptGapId(
	leftWordId: string,
	rightWordId: string,
): string {
	return `${leftWordId}:${rightWordId}`;
}

export function getTranscriptGapEdit({
	gapEdits,
	leftWordId,
	rightWordId,
}: {
	gapEdits?: Record<string, TranscriptGapEdit>;
	leftWordId: string;
	rightWordId: string;
}): TranscriptGapEdit | undefined {
	return gapEdits?.[buildTranscriptGapId(leftWordId, rightWordId)];
}

export function normalizeTranscriptGapEdits({
	gapEdits,
}: {
	gapEdits?: Record<string, TranscriptGapEdit>;
}): Record<string, TranscriptGapEdit> | undefined {
	if (!gapEdits) return undefined;
	const entries = Object.entries(gapEdits)
		.map(([gapId, edit]) => {
			const text = typeof edit?.text === "string" ? edit.text : undefined;
			const removed = Boolean(edit?.removed);
			if (!removed && (text === undefined || text === " ")) {
				return null;
			}
			return [gapId, { ...(text !== undefined ? { text } : {}), ...(removed ? { removed: true } : {}) }] as const;
		})
		.filter((entry): entry is readonly [string, TranscriptGapEdit] => Boolean(entry));
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildTranscriptGapCuts({
	words,
	gapEdits,
}: {
	words: TranscriptEditWord[];
	gapEdits?: Record<string, TranscriptGapEdit>;
}): TranscriptEditCutRange[] {
	if (!gapEdits) return [];
	const normalizedWords = normalizeTranscriptWords({ words });
	const cuts: TranscriptEditCutRange[] = [];
	for (let index = 0; index < normalizedWords.length - 1; index++) {
		const leftWord = normalizedWords[index];
		const rightWord = normalizedWords[index + 1];
		if (!leftWord || !rightWord) continue;
		const gapEdit = getTranscriptGapEdit({
			gapEdits,
			leftWordId: leftWord.id,
			rightWordId: rightWord.id,
		});
		if (!gapEdit?.removed) continue;
		const start = Math.max(0, leftWord.endTime);
		const end = Math.max(start, rightWord.startTime);
		if (end - start <= 0.0001) continue;
		cuts.push({
			start,
			end,
			// Gap edits represent removed silence between words, not removed words.
			// Model them as pause cuts so word projection does not mark neighbors removed.
			reason: "pause",
		});
	}
	return cuts;
}

export type TranscriptFillerCandidateConfidence = "high" | "medium" | "low";

export interface TranscriptFillerCandidate {
	id: string;
	text: string;
	wordIds: string[];
	startTime: number;
	endTime: number;
	confidence: TranscriptFillerCandidateConfidence;
	kind: "token" | "phrase";
}

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

const STRONG_FILLER_TOKENS = new Set([
	"um",
	"uh",
	"umm",
	"uhh",
	"erm",
	"hmm",
	"mm",
	"ah",
	"eh",
]);

const AMBIGUOUS_FILLER_TOKENS = new Set(["like"]);

export const DEFAULT_FILLER_PHRASES = new Set([
	"you know",
	"i mean",
	"kind of",
	"sort of",
]);

const FILLER_PHRASE_CONFIDENCE = new Map<
	string,
	TranscriptFillerCandidateConfidence
>([
	["you know", "medium"],
	["i mean", "medium"],
	["kind of", "low"],
	["sort of", "low"],
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

function isPunctuationOnlyToken(token: string): boolean {
	return /^[^\p{L}\p{N}']+$/u.test(token.trim());
}

function isLikelyBoundaryWord(word: TranscriptEditWord | undefined): boolean {
	if (!word) return true;
	const trimmed = word.text.trim();
	if (!trimmed) return true;
	return /[.!?,:;)]$/.test(trimmed);
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

export function detectTranscriptFillerCandidates({
	words,
}: {
	words: TranscriptEditWord[];
}): TranscriptFillerCandidate[] {
	const normalizedWords = normalizeTranscriptWords({ words });
	const candidates: TranscriptFillerCandidate[] = [];
	const claimedWordIds = new Set<string>();

	for (let index = 0; index < normalizedWords.length; index++) {
		const current = normalizedWords[index];
		if (!current || claimedWordIds.has(current.id)) continue;

		let matchedPhrase:
			| {
					phrase: string;
					length: number;
					confidence: TranscriptFillerCandidateConfidence;
			  }
			| undefined;

		for (const phrase of DEFAULT_FILLER_PHRASES) {
			const parts = phrase.split(" ");
			if (index + parts.length > normalizedWords.length) continue;
			const candidateWords = normalizedWords.slice(index, index + parts.length);
			if (candidateWords.some((word) => claimedWordIds.has(word.id))) continue;
			const joined = candidateWords
				.map((word) => normalizeToken(word.text))
				.join(" ")
				.trim();
			if (joined !== phrase) continue;

			let maxGap = 0;
			for (let cursor = 0; cursor < candidateWords.length - 1; cursor++) {
				const left = candidateWords[cursor];
				const right = candidateWords[cursor + 1];
				maxGap = Math.max(maxGap, Math.max(0, right.startTime - left.endTime));
			}
			if (maxGap > 0.45) continue;

			matchedPhrase = {
				phrase,
				length: parts.length,
				confidence: FILLER_PHRASE_CONFIDENCE.get(phrase) ?? "medium",
			};
			break;
		}

		if (matchedPhrase) {
			const phraseWords = normalizedWords.slice(
				index,
				index + matchedPhrase.length,
			);
			for (const word of phraseWords) claimedWordIds.add(word.id);
			candidates.push({
				id: `phrase:${phraseWords[0]?.id ?? index}`,
				text: phraseWords.map((word) => word.text).join(" "),
				wordIds: phraseWords.map((word) => word.id),
				startTime: phraseWords[0]?.startTime ?? current.startTime,
				endTime:
					phraseWords[phraseWords.length - 1]?.endTime ?? current.endTime,
				confidence: matchedPhrase.confidence,
				kind: "phrase",
			});
			index += matchedPhrase.length - 1;
			continue;
		}

		const normalized = normalizeToken(current.text);
		if (!normalized) continue;

		const next = normalizedWords[index + 1];
		const normalizedNext = next ? normalizeToken(next.text) : "";
		const pauseAfter = next
			? Math.max(0, next.startTime - current.endTime)
			: Number.POSITIVE_INFINITY;

		if (
			next &&
			!claimedWordIds.has(next.id) &&
			normalized.length > 0 &&
			normalized === normalizedNext &&
			!isPunctuationOnlyToken(current.text) &&
			pauseAfter <= 0.25
		) {
			claimedWordIds.add(current.id);
			candidates.push({
				id: `repeat:${current.id}`,
				text: current.text,
				wordIds: [current.id],
				startTime: current.startTime,
				endTime: current.endTime,
				confidence: "high",
				kind: "token",
			});
			continue;
		}

		if (
			next &&
			!claimedWordIds.has(next.id) &&
			normalized.length >= 1 &&
			normalized.length <= 4 &&
			normalizedNext.length > normalized.length &&
			normalizedNext.startsWith(normalized) &&
			!isPunctuationOnlyToken(current.text) &&
			pauseAfter <= 0.18
		) {
			claimedWordIds.add(current.id);
			candidates.push({
				id: `stutter:${current.id}`,
				text: current.text,
				wordIds: [current.id],
				startTime: current.startTime,
				endTime: current.endTime,
				confidence: "medium",
				kind: "token",
			});
			continue;
		}

		if (STRONG_FILLER_TOKENS.has(normalized)) {
			claimedWordIds.add(current.id);
			candidates.push({
				id: `token:${current.id}`,
				text: current.text,
				wordIds: [current.id],
				startTime: current.startTime,
				endTime: current.endTime,
				confidence: "high",
				kind: "token",
			});
			continue;
		}

		if (AMBIGUOUS_FILLER_TOKENS.has(normalized)) {
			const previous = normalizedWords[index - 1];
			const pauseBefore = previous
				? Math.max(0, current.startTime - previous.endTime)
				: 0;
			const confidence: TranscriptFillerCandidateConfidence =
				pauseBefore >= 0.12 ||
				pauseAfter >= 0.12 ||
				isLikelyBoundaryWord(previous)
					? "medium"
					: "low";
			candidates.push({
				id: `token:${current.id}`,
				text: current.text,
				wordIds: [current.id],
				startTime: current.startTime,
				endTime: current.endTime,
				confidence,
				kind: "token",
			});
		}
	}

	return candidates;
}

export function detectStrongFillerTokenHits({
	words,
}: {
	words: TranscriptEditWord[];
}): Array<{
	id: string;
	originalText: string;
	normalizedText: string;
	startTime: number;
	endTime: number;
}> {
	return normalizeTranscriptWords({ words })
		.map((word) => ({
			word,
			normalizedText: normalizeToken(word.text),
		}))
		.filter(({ normalizedText }) => STRONG_FILLER_TOKENS.has(normalizedText))
		.map(({ word, normalizedText }) => ({
			id: word.id,
			originalText: word.text,
			normalizedText,
			startTime: word.startTime,
			endTime: word.endTime,
		}));
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
			hidden: Boolean(word.hidden),
		}));
	}

	return normalizedWords.map((word) => {
		const removedByCuts = mergedCuts.some(
			(cut) =>
				cut.reason !== "pause" &&
				cut.start <= word.startTime + 0.0001 &&
				cut.end >= word.endTime - 0.0001,
		);
		return {
			...word,
			removed: Boolean(word.removed) || removedByCuts,
			hidden: Boolean(word.hidden),
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

		const rangeStart = word.startTime;
		let rangeEnd = word.endTime;
		let cursor = index + 1;

		// Collapse contiguous removed words into one cut. Gap-only removals are
		// handled separately via transcript gap edits and should not be inferred
		// from word removals.
		while (cursor < normalized.length && normalized[cursor]?.removed) {
			rangeEnd = Math.max(rangeEnd, normalized[cursor].endTime);
			cursor += 1;
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
	const projectedWordEntries = transcriptEdit.words
		.map((word, index) => ({ word, index }))
		.filter(
			({ word }) => word.endTime > windowStart && word.startTime < windowEnd,
		)
		.map(({ word, index }) => ({
			index,
			word: {
				...word,
				startTime: Math.max(
					0,
					Math.min(windowEnd, word.startTime) - windowStart,
				),
				endTime: Math.max(0, Math.min(windowEnd, word.endTime) - windowStart),
			},
		}));
	const projectedWords = normalizeTranscriptWords({
		words: projectedWordEntries.map(({ word }) => word),
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
	const projectedIndexByOriginalIndex = new Map<number, number>();
	projectedWordEntries.forEach(({ index }, projectedIndex) => {
		projectedIndexByOriginalIndex.set(index, projectedIndex);
	});
	const preservedSegmentsUi =
		projectedWords.length === 0
			? []
			: (transcriptEdit.segmentsUi ?? [])
					.map((segment, index) => {
						const projectedIndices: number[] = [];
						for (
							let originalIndex = segment.wordStartIndex;
							originalIndex <= segment.wordEndIndex;
							originalIndex++
						) {
							const projectedIndex =
								projectedIndexByOriginalIndex.get(originalIndex);
							if (projectedIndex !== undefined) {
								projectedIndices.push(projectedIndex);
							}
						}
						if (projectedIndices.length === 0) return null;
						return {
							id: `${elementId}:seg:${index}`,
							wordStartIndex: projectedIndices[0] ?? 0,
							wordEndIndex: projectedIndices[projectedIndices.length - 1] ?? 0,
							label: segment.label,
						};
					})
					.filter((segment): segment is NonNullable<typeof segment> =>
						Boolean(segment),
					);
	const segmentsUi =
		preservedSegmentsUi.length > 0
			? preservedSegmentsUi
			: projectedWords.length === 0
				? []
				: [
						{
							id: `${elementId}:seg:0`,
							wordStartIndex: 0,
							wordEndIndex: projectedWords.length - 1,
						},
					];

	const projectedWordIdSet = new Set(projectedWords.map((word) => word.id));
	const projectedGapEdits = normalizeTranscriptGapEdits({
		gapEdits: Object.fromEntries(
			Object.entries(transcriptEdit.gapEdits ?? {}).filter(([gapId]) => {
				const [leftWordId, rightWordId] = gapId.split(":");
				return (
					Boolean(leftWordId) &&
					Boolean(rightWordId) &&
					projectedWordIdSet.has(leftWordId) &&
					projectedWordIdSet.has(rightWordId)
				);
			}),
		),
	});

	return {
		...transcriptEdit,
		words: projectedWords,
		cuts: projectedCuts,
		cutTimeDomain: "clip-local-source",
		segmentsUi,
		gapEdits: projectedGapEdits,
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
		if (safeTime < compressedCursor + keep) {
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
	gapEdits,
}: {
	words: TranscriptEditWord[];
	cuts?: TranscriptEditCutRange[];
	gapEdits?: Record<string, TranscriptGapEdit>;
}): {
	content: string;
	startTime: number;
	duration: number;
	wordTimings: Array<{
		word: string;
		startTime: number;
		endTime: number;
		hidden?: boolean;
	}>;
} | null {
	const normalized = normalizeTranscriptWords({ words });
	const transcriptCuts = cuts
		? mergeCutRanges({ cuts })
		: buildTranscriptCutsFromWords({ words: normalized });
	const wordsWithCutState = applyCutRangesToWords({
		words: normalized,
		cuts: transcriptCuts,
	});
	const active = wordsWithCutState.filter((word) => !word.removed);
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
				id: word.id,
				word: word.text,
				startTime,
				endTime,
				hidden:
					Boolean(word.hidden) || isFillerWordOrPhrase({ text: word.text }),
			};
		})
		.filter((timing) => timing.word.trim().length > 0);

	if (timings.length === 0) return null;

	const visibleTimings = timings.filter((timing) => !timing.hidden);
	const content = visibleTimings
		.map((timing, index) => {
			if (index === 0) return timing.word;
			const previous = visibleTimings[index - 1];
			if (!previous) return timing.word;
			const gapText =
				getTranscriptGapEdit({
					gapEdits,
					leftWordId: previous.id,
					rightWordId: timing.id,
				})?.text ?? " ";
			return `${gapText}${timing.word}`;
		})
		.join("")
		.trim();
	if (!content) return null;
	const startTime = timings[0].startTime;
	const endTime = timings[timings.length - 1].endTime;
	return {
		content,
		startTime,
		duration: Math.max(0.04, endTime - startTime),
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
