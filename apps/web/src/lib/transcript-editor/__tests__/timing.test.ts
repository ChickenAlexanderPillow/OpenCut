import { describe, expect, test } from "bun:test";

import {
	MIN_TRANSCRIPT_WORD_DURATION_SECONDS,
	clampTranscriptWordBoundaryTime,
	updateTranscriptWordBoundary,
} from "@/lib/transcript-editor/timing";
import type { TranscriptEditWord } from "@/types/transcription";

function createWord(
	id: string,
	startTime: number,
	endTime: number,
): TranscriptEditWord {
	return {
		id,
		text: id,
		startTime,
		endTime,
	};
}

describe("transcript word boundary timing", () => {
	test("clamps a boundary to preserve minimum duration on both sides", () => {
		const leftWord = createWord("left", 0, 0.5);
		const rightWord = createWord("right", 0.8, 1.2);

		expect(
			clampTranscriptWordBoundaryTime({
				leftWord,
				rightWord,
				time: -1,
			}),
		).toBeCloseTo(0.01, 6);
		expect(
			clampTranscriptWordBoundaryTime({
				leftWord,
				rightWord,
				time: 2,
			}),
		).toBeCloseTo(1.19, 6);
	});

	test("updates only the targeted adjacent words", () => {
		const words = [
			createWord("one", 0, 0.3),
			createWord("two", 0.45, 0.8),
			createWord("three", 1, 1.3),
		];

		const updated = updateTranscriptWordBoundary({
			words,
			leftWordId: "one",
			rightWordId: "two",
			time: 0.4,
		});

		expect(updated).not.toBeNull();
		expect(updated?.[0]?.endTime).toBeCloseTo(0.4, 6);
		expect(updated?.[1]?.startTime).toBeCloseTo(0.4, 6);
		expect(updated?.[2]).toEqual(words[2]);
	});

	test("rejects non-adjacent words", () => {
		const words = [
			createWord("one", 0, 0.3),
			createWord("two", 0.45, 0.8),
			createWord("three", 1, 1.3),
		];

		expect(
			updateTranscriptWordBoundary({
				words,
				leftWordId: "one",
				rightWordId: "three",
				time: 0.6,
			}),
		).toBeNull();
	});

	test("respects the exported minimum duration constant", () => {
		const words = [createWord("one", 0, 0.02), createWord("two", 0.02, 0.04)];

		const updated = updateTranscriptWordBoundary({
			words,
			leftWordId: "one",
			rightWordId: "two",
			time: 0.03,
		});

		expect(updated?.[0]?.endTime).toBeCloseTo(0.03, 6);
		expect(updated?.[1]?.startTime).toBeCloseTo(0.03, 6);
		expect(updated?.[0]?.endTime).toBeGreaterThanOrEqual(
			MIN_TRANSCRIPT_WORD_DURATION_SECONDS,
		);
	});
});
