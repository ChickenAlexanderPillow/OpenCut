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
});
