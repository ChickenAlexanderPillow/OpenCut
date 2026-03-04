import { describe, expect, test } from "bun:test";
import {
	applyCutRangesToWords,
	buildCaptionPayloadFromTranscriptWords,
	buildTranscriptCutsFromWords,
	computeKeepDuration,
	mapCompressedTimeToSourceTime,
	mapSourceTimeToCompressedTime,
	withFillerWordsRemoved,
} from "@/lib/transcript-editor/core";

describe("transcript editor core", () => {
	test("builds cuts and caption payload from removed words", () => {
		const words = [
			{ id: "w1", text: "hello", startTime: 0, endTime: 0.4, removed: false },
			{ id: "w2", text: "um", startTime: 0.4, endTime: 0.7, removed: true },
			{ id: "w3", text: "world", startTime: 0.7, endTime: 1.2, removed: false },
		];

		const cuts = buildTranscriptCutsFromWords({ words });
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.start).toBeCloseTo(0.4, 3);
		expect(cuts[0]?.end).toBeCloseTo(0.7, 3);

		const payload = buildCaptionPayloadFromTranscriptWords({ words });
		expect(payload).not.toBeNull();
		expect(payload?.content).toBe("hello world");
		expect(payload?.wordTimings[1]?.startTime ?? 0).toBeLessThan(1);
	});

	test("maps compressed/source time with cuts", () => {
		const cuts = [{ start: 1, end: 2, reason: "manual" as const }];
		expect(
			mapCompressedTimeToSourceTime({ compressedTime: 0.5, cuts }),
		).toBeCloseTo(0.5, 4);
		expect(
			mapCompressedTimeToSourceTime({ compressedTime: 1.1, cuts }),
		).toBeCloseTo(2.1, 4);

		expect(
			mapSourceTimeToCompressedTime({ sourceTime: 0.5, cuts }),
		).toBeCloseTo(0.5, 4);
		expect(
			mapSourceTimeToCompressedTime({ sourceTime: 2.1, cuts }),
		).toBeCloseTo(1.1, 4);
	});

	test("computes keep duration and removes fillers", () => {
		const words = [
			{ id: "w1", text: "I", startTime: 0, endTime: 0.2, removed: false },
			{ id: "w2", text: "umm", startTime: 0.2, endTime: 0.5, removed: false },
			{ id: "w3", text: "agree", startTime: 0.5, endTime: 1, removed: false },
		];
		const filtered = withFillerWordsRemoved({ words });
		expect(filtered[1]?.removed).toBe(true);
		const cuts = buildTranscriptCutsFromWords({ words: filtered });
		const keepDuration = computeKeepDuration({ originalDuration: 1, cuts });
		expect(keepDuration).toBeLessThan(1);
	});

	test("applies cut ranges to word removal state for UI/playback consistency", () => {
		const words = [
			{ id: "w1", text: "hello", startTime: 0, endTime: 0.4, removed: false },
			{ id: "w2", text: "there", startTime: 0.4, endTime: 0.8, removed: false },
			{ id: "w3", text: "world", startTime: 0.8, endTime: 1.2, removed: false },
		];
		const cuts = [{ start: 0.45, end: 0.75, reason: "manual" as const }];
		const applied = applyCutRangesToWords({ words, cuts });

		expect(applied[0]?.removed).toBe(false);
		expect(applied[1]?.removed).toBe(true);
		expect(applied[2]?.removed).toBe(false);
	});

	test("extends cuts through inter-word gaps after removed words", () => {
		const words = [
			{ id: "w1", text: "from", startTime: 0.0, endTime: 0.2, removed: true },
			{ id: "w2", text: "poland", startTime: 0.28, endTime: 0.5, removed: true },
			{
				id: "w3",
				text: "european",
				startTime: 0.7,
				endTime: 0.95,
				removed: false,
			},
		];
		const cuts = buildTranscriptCutsFromWords({ words });
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.start).toBeCloseTo(0.0, 3);
		expect(cuts[0]?.end).toBeCloseTo(0.7, 3);
	});
});
