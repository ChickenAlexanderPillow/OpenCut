import { describe, expect, test } from "bun:test";
import {
	isCaptionTimingRelativeToElement,
	toElementLocalCaptionTime,
	toTimelineCaptionWordTimings,
} from "@/lib/captions/timing";

describe("caption timing normalization", () => {
	test("detects relative timings inside element duration", () => {
		const timings = [
			{ startTime: 0.0, endTime: 0.2 },
			{ startTime: 0.25, endTime: 0.5 },
		];
		expect(
			isCaptionTimingRelativeToElement({
				timings,
				elementDuration: 2,
			}),
		).toBe(true);
	});

	test("detects absolute timings outside element-local window", () => {
		const timings = [
			{ startTime: 12.0, endTime: 12.2 },
			{ startTime: 12.25, endTime: 12.5 },
		];
		expect(
			isCaptionTimingRelativeToElement({
				timings,
				elementDuration: 2,
			}),
		).toBe(false);
	});

	test("normalizes relative timings into timeline absolute times", () => {
		const normalized = toTimelineCaptionWordTimings({
			timings: [
				{ word: "hello", startTime: 0.0, endTime: 0.2 },
				{ word: "world", startTime: 0.25, endTime: 0.5 },
			],
			elementStartTime: 10,
			elementDuration: 2,
		});
		expect(normalized[0]?.startTime).toBeCloseTo(10.0, 3);
		expect(normalized[0]?.endTime).toBeCloseTo(10.2, 3);
		expect(normalized[1]?.startTime).toBeCloseTo(10.25, 3);
		expect(normalized[1]?.endTime).toBeCloseTo(10.5, 3);
	});

	test("keeps absolute timings unchanged", () => {
		const normalized = toTimelineCaptionWordTimings({
			timings: [
				{ word: "hello", startTime: 10.0, endTime: 10.2 },
				{ word: "world", startTime: 10.25, endTime: 10.5 },
			],
			elementStartTime: 10,
			elementDuration: 2,
		});
		expect(normalized[0]?.startTime).toBeCloseTo(10.0, 3);
		expect(normalized[0]?.endTime).toBeCloseTo(10.2, 3);
	});

	test("converts absolute timeline times back to element-local for transcript mapping", () => {
		const timings = [
			{ startTime: 10.0, endTime: 10.2 },
			{ startTime: 10.25, endTime: 10.5 },
		];
		expect(
			toElementLocalCaptionTime({
				time: 10.25,
				elementStartTime: 10,
				timings,
				elementDuration: 2,
			}),
		).toBeCloseTo(0.25, 3);
	});
});
