import { describe, expect, test } from "bun:test";
import { normalizeTranscriptCutsToClipLocalSource } from "@/lib/transcript-editor/snapshot";

describe("normalizeTranscriptCutsToClipLocalSource", () => {
	test("keeps clip-local cuts unchanged for trimmed clips", () => {
		const cuts = normalizeTranscriptCutsToClipLocalSource({
			trimStart: 12,
			cuts: [
				{ start: 0.6, end: 1.1, reason: "manual" },
				{ start: 2.2, end: 2.6, reason: "pause" },
			],
		});

		expect(cuts).toEqual([
			{ start: 0.6, end: 1.1, reason: "manual" },
			{ start: 2.2, end: 2.6, reason: "pause" },
		]);
	});

	test("maps source-absolute cuts into clip-local source time", () => {
		const cuts = normalizeTranscriptCutsToClipLocalSource({
			trimStart: 12,
			cutTimeDomain: "source-absolute",
			cuts: [
				{ start: 12.6, end: 13.1, reason: "manual" },
				{ start: 14.2, end: 14.6, reason: "pause" },
			],
		});

		expect(cuts).toHaveLength(2);
		expect(cuts[0]?.reason).toBe("manual");
		expect(cuts[0]?.start).toBeCloseTo(0.6, 6);
		expect(cuts[0]?.end).toBeCloseTo(1.1, 6);
		expect(cuts[1]?.reason).toBe("pause");
		expect(cuts[1]?.start).toBeCloseTo(2.2, 6);
		expect(cuts[1]?.end).toBeCloseTo(2.6, 6);
	});

	test("does not shift when trimStart is zero", () => {
		const cuts = normalizeTranscriptCutsToClipLocalSource({
			trimStart: 0,
			cuts: [{ start: 1.4, end: 2.1, reason: "manual" }],
		});

		expect(cuts).toEqual([{ start: 1.4, end: 2.1, reason: "manual" }]);
	});
});
