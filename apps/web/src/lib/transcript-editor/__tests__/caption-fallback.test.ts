import { describe, expect, test } from "bun:test";
import { buildTranscriptWordsFromCaptionTimings } from "@/lib/transcript-editor/caption-fallback";

describe("buildTranscriptWordsFromCaptionTimings", () => {
	test("preserves hidden flags when reconstructing transcript words", () => {
		const words = buildTranscriptWordsFromCaptionTimings({
			mediaElementId: "audio-1",
			mediaStartTime: 12,
			timings: [
				{ word: "hello", startTime: 12.2, endTime: 12.5 },
				{ word: "secret", startTime: 12.6, endTime: 12.9, hidden: true },
			],
		});

		expect(words).toHaveLength(2);
		expect(words[0]?.text).toBe("hello");
		expect(words[0]?.removed).toBe(false);
		expect(words[0]?.hidden).toBe(false);
		expect(words[0]?.startTime ?? 0).toBeCloseTo(0.2, 6);
		expect(words[0]?.endTime ?? 0).toBeCloseTo(0.5, 6);
		expect(words[1]?.text).toBe("secret");
		expect(words[1]?.removed).toBe(false);
		expect(words[1]?.hidden).toBe(true);
		expect(words[1]?.startTime ?? 0).toBeCloseTo(0.6, 6);
		expect(words[1]?.endTime ?? 0).toBeCloseTo(0.9, 6);
	});
});
