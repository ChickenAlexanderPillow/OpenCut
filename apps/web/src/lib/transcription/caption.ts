import type { TranscriptionSegment, CaptionChunk } from "@/types/transcription";
import {
	DEFAULT_WORDS_PER_CAPTION,
} from "@/constants/transcription-constants";

export type CaptionGenerationMode = "segment" | "chunked";

const DEFAULT_MAX_WORDS_PER_SEGMENT = 12;
const DEFAULT_SEGMENT_MAX_GAP_SECONDS = 0.45;
const DEFAULT_SEGMENT_MAX_DURATION_SECONDS = 4;

type CaptionWordTiming = {
	word: string;
	startTime: number;
	endTime: number;
};

function normalizeWord(word: string): string {
	return word.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
}

function normalizeWordTimings({
	wordTimings,
}: {
	wordTimings: CaptionWordTiming[];
}): CaptionWordTiming[] {
	const sorted = [...wordTimings].sort((a, b) => {
		if (a.startTime !== b.startTime) return a.startTime - b.startTime;
		return a.endTime - b.endTime;
	});

	const result: CaptionWordTiming[] = [];
	for (const timing of sorted) {
		const next: CaptionWordTiming = {
			word: timing.word.trim(),
			startTime: Math.max(0, timing.startTime),
			endTime: Math.max(timing.startTime + 0.01, timing.endTime),
		};
		if (!next.word) continue;

		const previous = result[result.length - 1];
		if (!previous) {
			result.push(next);
			continue;
		}

		const previousNormalized = normalizeWord(previous.word);
		const nextNormalized = normalizeWord(next.word);
		const overlaps = next.startTime <= previous.endTime + 0.08;
		const isDuplicateToken =
			previousNormalized.length > 0 &&
			nextNormalized.length > 0 &&
			previousNormalized === nextNormalized;

		if (isDuplicateToken && overlaps) {
			previous.endTime = Math.max(previous.endTime, next.endTime);
			continue;
		}

		if (next.startTime < previous.endTime) {
			next.startTime = previous.endTime;
			next.endTime = Math.max(next.endTime, next.startTime + 0.01);
		}

		result.push(next);
	}

	return result;
}

function extractWordTimingsFromSegment({
	segment,
}: {
	segment: TranscriptionSegment;
}): CaptionWordTiming[] {
	const words = segment.text.match(/\S+/g) ?? [];
	if (words.length === 0) return [];

	const segmentStart = Math.max(0, segment.start);
	const segmentEnd = Math.max(segmentStart, segment.end);
	const segmentDuration = Math.max(0.01, segmentEnd - segmentStart);
	const weights = words.map((word) => Math.max(1, word.length));
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

	return words.map((word, index) => {
		const beforeWeight = weights
			.slice(0, index)
			.reduce((sum, weight) => sum + weight, 0);
		const start = segmentStart + (segmentDuration * beforeWeight) / totalWeight;
		const end =
			segmentStart +
			(segmentDuration * (beforeWeight + weights[index])) / totalWeight;
		return { word, startTime: start, endTime: end };
	});
}

function buildCaptionSegmentsFromWordTimings({
	wordTimings,
}: {
	wordTimings: CaptionWordTiming[];
}): CaptionChunk[] {
	const captions: CaptionChunk[] = [];
	let current: CaptionWordTiming[] = [];

	const pushCurrent = () => {
		if (current.length === 0) return;
		const startTime = current[0].startTime;
		const endTime = current[current.length - 1].endTime;
		captions.push({
			text: current.map((word) => word.word).join(" "),
			startTime,
			duration: Math.max(0.04, endTime - startTime),
			wordTimings: [...current],
		});
		current = [];
	};

	for (const wordTiming of wordTimings) {
		if (current.length === 0) {
			current.push(wordTiming);
			continue;
		}

		const previous = current[current.length - 1];
		const gap = Math.max(0, wordTiming.startTime - previous.endTime);
		const currentDuration = Math.max(
			0,
			wordTiming.endTime - current[0].startTime,
		);
		const previousEndsSentence = /[.!?]$/.test(previous.word);

		const shouldBreak =
			gap > DEFAULT_SEGMENT_MAX_GAP_SECONDS ||
			current.length >= DEFAULT_MAX_WORDS_PER_SEGMENT ||
			currentDuration > DEFAULT_SEGMENT_MAX_DURATION_SECONDS ||
			previousEndsSentence;

		if (shouldBreak) {
			pushCurrent();
		}

		current.push(wordTiming);
	}

	pushCurrent();
	return captions;
}

export function buildCaptionChunks({
	segments,
	mode = "segment",
	wordsPerChunk = DEFAULT_WORDS_PER_CAPTION,
}: {
	segments: TranscriptionSegment[];
	mode?: CaptionGenerationMode;
	wordsPerChunk?: number;
}): CaptionChunk[] {
	const wordTimings = normalizeWordTimings({
		wordTimings: segments
		.flatMap((segment) => extractWordTimingsFromSegment({ segment }))
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.endTime - b.endTime;
		}),
	});

	if (mode === "segment") {
		return buildCaptionSegmentsFromWordTimings({ wordTimings });
	}

	const captions: CaptionChunk[] = [];
	let previousEndTime = 0;
	for (let i = 0; i < wordTimings.length; i += wordsPerChunk) {
		const chunkWordTimings = wordTimings.slice(i, i + wordsPerChunk);
		if (chunkWordTimings.length === 0) continue;

		const chunkText = chunkWordTimings.map((word) => word.word).join(" ");
		const rawStart = chunkWordTimings[0].startTime;
		const rawEnd = chunkWordTimings[chunkWordTimings.length - 1].endTime;
		const adjustedStartTime = Math.max(rawStart, previousEndTime);
		const shiftedBy = adjustedStartTime - rawStart;
		const shiftedWordTimings = chunkWordTimings.map((wordTiming) => ({
			word: wordTiming.word,
			startTime: wordTiming.startTime + shiftedBy,
			endTime: wordTiming.endTime + shiftedBy,
		}));
		const chunkDuration = Math.max(0.04, rawEnd - rawStart);
		captions.push({
			text: chunkText,
			startTime: adjustedStartTime,
			duration: chunkDuration,
			wordTimings: shiftedWordTimings,
		});

		previousEndTime = adjustedStartTime + chunkDuration;
	}

	return captions;
}
