import { describe, expect, test } from "bun:test";
import {
	mergeScoredCandidates,
	selectTopCandidatesWithQualityGate,
} from "@/lib/clips/scoring";
import type { ClipCandidateDraft } from "@/types/clip-generation";

const draft: ClipCandidateDraft = {
	id: "cand-1",
	startTime: 10,
	endTime: 50,
	duration: 40,
	transcriptSnippet: "great hook with clear payoff",
	localScore: 80,
};

describe("clip scoring", () => {
	test("parses and merges scored candidates from model text", () => {
		const merged = mergeScoredCandidates({
			drafts: [draft],
			scoredText: JSON.stringify({
				candidates: [
					{
						id: "cand-1",
						title: "Strong opening",
						rationale: "The first line creates immediate curiosity.",
						scoreOverall: 88.6,
						scoreBreakdown: {
							hook: 95,
							emotion: 81,
							shareability: 79,
							clarity: 91,
							momentum: 84,
						},
					},
				],
			}),
		});

		expect(merged).toHaveLength(1);
		expect(merged[0]?.scoreOverall).toBe(89);
		expect(merged[0]?.scoreBreakdown.hook).toBe(95);
		expect(merged[0]?.title).toBe("Strong opening");
	});

	test("rejects malformed responses", () => {
		expect(() =>
			mergeScoredCandidates({
				drafts: [draft],
				scoredText: '{"bad":"shape"}',
			}),
		).toThrow();
	});

	test("applies quality gate threshold", () => {
		const results = selectTopCandidatesWithQualityGate({
			candidates: [
				{
					id: "a",
					startTime: 0,
					endTime: 35,
					duration: 35,
					title: "A",
					rationale: "A",
					transcriptSnippet: "A",
					scoreOverall: 59,
					scoreBreakdown: {
						hook: 60,
						emotion: 60,
						shareability: 60,
						clarity: 60,
						momentum: 60,
					},
				},
				{
					id: "b",
					startTime: 40,
					endTime: 78,
					duration: 38,
					title: "B",
					rationale: "B",
					transcriptSnippet: "B",
					scoreOverall: 92,
					scoreBreakdown: {
						hook: 92,
						emotion: 91,
						shareability: 90,
						clarity: 93,
						momentum: 92,
					},
				},
			],
			minScore: 60,
			maxCount: 5,
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe("b");
	});

	test("enforces distinct non-overlapping clips by default", () => {
		const results = selectTopCandidatesWithQualityGate({
			candidates: [
				{
					id: "a",
					startTime: 0,
					endTime: 50,
					duration: 50,
					title: "A",
					rationale: "A",
					transcriptSnippet: "A",
					scoreOverall: 95,
					scoreBreakdown: {
						hook: 95,
						emotion: 90,
						shareability: 90,
						clarity: 90,
						momentum: 90,
					},
				},
				{
					id: "b",
					startTime: 45,
					endTime: 90,
					duration: 45,
					title: "B",
					rationale: "B",
					transcriptSnippet: "B",
					scoreOverall: 93,
					scoreBreakdown: {
						hook: 93,
						emotion: 90,
						shareability: 90,
						clarity: 90,
						momentum: 90,
					},
				},
				{
					id: "c",
					startTime: 90,
					endTime: 130,
					duration: 40,
					title: "C",
					rationale: "C",
					transcriptSnippet: "C",
					scoreOverall: 92,
					scoreBreakdown: {
						hook: 92,
						emotion: 90,
						shareability: 90,
						clarity: 90,
						momentum: 90,
					},
				},
			],
			minScore: 60,
			maxCount: 5,
		});

		expect(results.map((item) => item.id)).toEqual(["a", "c"]);
	});
});
