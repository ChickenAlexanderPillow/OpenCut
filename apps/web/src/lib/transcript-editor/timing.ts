import type { TranscriptEditWord } from "@/types/transcription";

export const MIN_TRANSCRIPT_WORD_DURATION_SECONDS = 0.01;

export function clampTranscriptWordBoundaryTime({
	leftWord,
	rightWord,
	time,
	minDuration = MIN_TRANSCRIPT_WORD_DURATION_SECONDS,
}: {
	leftWord: TranscriptEditWord;
	rightWord: TranscriptEditWord;
	time: number;
	minDuration?: number;
}): number {
	const safeMinDuration = Math.max(
		MIN_TRANSCRIPT_WORD_DURATION_SECONDS,
		minDuration,
	);
	const minTime = leftWord.startTime + safeMinDuration;
	const maxTime = rightWord.endTime - safeMinDuration;
	if (!Number.isFinite(time)) {
		return Math.min(maxTime, Math.max(minTime, leftWord.endTime));
	}
	if (maxTime <= minTime) {
		return minTime;
	}
	return Math.min(maxTime, Math.max(minTime, time));
}

export function updateTranscriptWordBoundary({
	words,
	leftWordId,
	rightWordId,
	time,
	minDuration = MIN_TRANSCRIPT_WORD_DURATION_SECONDS,
}: {
	words: TranscriptEditWord[];
	leftWordId: string;
	rightWordId: string;
	time: number;
	minDuration?: number;
}): TranscriptEditWord[] | null {
	const leftIndex = words.findIndex((word) => word.id === leftWordId);
	const rightIndex = words.findIndex((word) => word.id === rightWordId);
	if (leftIndex < 0 || rightIndex !== leftIndex + 1) {
		return null;
	}

	const leftWord = words[leftIndex];
	const rightWord = words[rightIndex];
	if (!leftWord || !rightWord) return null;

	const boundaryTime = clampTranscriptWordBoundaryTime({
		leftWord,
		rightWord,
		time,
		minDuration,
	});

	return words.map((word, index) => {
		if (index === leftIndex) {
			return {
				...word,
				endTime: boundaryTime,
			};
		}
		if (index === rightIndex) {
			return {
				...word,
				startTime: boundaryTime,
			};
		}
		return word;
	});
}
