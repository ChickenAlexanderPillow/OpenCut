import { describe, expect, test } from "bun:test";
import { clipTranscriptSegmentsForWindow } from "@/lib/clips/transcript";

describe("clipTranscriptSegmentsForWindow", () => {
	test("rebases segment timestamps to clip start", () => {
		const clipped = clipTranscriptSegmentsForWindow({
			segments: [
				{ text: "alpha", start: 5, end: 12 },
				{ text: "beta", start: 14, end: 20 },
			],
			startTime: 10,
			endTime: 18,
		});

		expect(clipped).toEqual([
			{ text: "alpha", start: 0, end: 2 },
			{ text: "beta", start: 4, end: 8 },
		]);
	});

	test("drops segments outside the selected window", () => {
		const clipped = clipTranscriptSegmentsForWindow({
			segments: [
				{ text: "outside", start: 1, end: 2 },
				{ text: "inside", start: 30, end: 31 },
			],
			startTime: 20,
			endTime: 40,
		});

		expect(clipped).toEqual([{ text: "inside", start: 10, end: 11 }]);
	});
});
