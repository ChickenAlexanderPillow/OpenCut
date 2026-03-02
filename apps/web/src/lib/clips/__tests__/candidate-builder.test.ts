import { describe, expect, test } from "bun:test";
import { buildClipCandidatesFromTranscript } from "@/lib/clips/candidate-builder";

describe("buildClipCandidatesFromTranscript", () => {
	test("builds candidates in configured duration range", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 200,
			segments: [
				{ text: "hello there", start: 5, end: 7 },
				{ text: "this is a longer run", start: 20, end: 42 },
				{ text: "another hook", start: 80, end: 95 },
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) {
			expect(candidate.duration).toBeGreaterThanOrEqual(30);
			expect(candidate.duration).toBeLessThanOrEqual(60);
			expect(candidate.startTime).toBeGreaterThanOrEqual(0);
			expect(candidate.endTime).toBeLessThanOrEqual(200);
		}
	});

	test("deduplicates highly overlapping windows", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 120,
			segments: [
				{ text: "one", start: 0, end: 5 },
				{ text: "two", start: 2, end: 7 },
				{ text: "three", start: 3, end: 8 },
				{ text: "four", start: 4, end: 10 },
			],
		});

		const uniqueRanges = new Set(
			candidates.map((candidate) => `${candidate.startTime}-${candidate.endTime}`),
		);
		expect(uniqueRanges.size).toBe(candidates.length);
	});

	test("returns empty when transcript is sparse/invalid", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 90,
			segments: [{ text: "bad", start: 10, end: 10 }],
		});

		expect(candidates).toHaveLength(0);
	});
});
