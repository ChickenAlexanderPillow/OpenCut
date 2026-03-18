import { describe, expect, test } from "bun:test";
import {
	mergeScoredCandidates,
	selectTopCandidatesWithCoverageBackfill,
	selectTopCandidatesWithQualityGate,
} from "@/lib/clips/scoring";
import type { ClipCandidateDraft } from "@/types/clip-generation";

const draft: ClipCandidateDraft = {
	id: "cand-1",
	startTime: 10,
	endTime: 50,
	duration: 40,
	transcriptSnippet: "Great hook with clear payoff.",
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
		expect(merged[0]?.scoreOverall).toBe(91);
		expect(merged[0]?.scoreBreakdown.hook).toBe(95);
		expect(merged[0]?.title).toBe("Strong opening");
		expect(merged[0]?.qaDiagnostics?.startsClean).toBeTrue();
		expect(merged[0]?.qaDiagnostics?.endsClean).toBeTrue();
	});

	test("falls back to deterministic merge on malformed responses", () => {
		const merged = mergeScoredCandidates({
			drafts: [draft],
			scoredText: '{"bad":"shape"}',
		});
		expect(merged).toHaveLength(1);
		expect(merged[0]?.id).toBe("cand-1");
		expect(merged[0]?.rationale).toContain("deterministic local ranking fallback");
	});

	test("penalizes unresolved tail question setups in QA diagnostics", () => {
		const merged = mergeScoredCandidates({
			drafts: [
				{
					id: "cand-tail-question",
					startTime: 0,
					endTime: 34,
					duration: 34,
					transcriptSnippet:
						"We have seen pressure on the market all year. Looking ahead, what can we expect?",
					localScore: 70,
				},
			],
			scoredText: JSON.stringify({
				candidates: [
					{
						id: "cand-tail-question",
						title: "Tail question setup",
						rationale: "Ends with unresolved setup question.",
						scoreOverall: 82,
						scoreBreakdown: {
							hook: 80,
							emotion: 70,
							shareability: 72,
							clarity: 84,
							momentum: 69,
						},
					},
				],
			}),
		});

		expect(merged).toHaveLength(1);
		expect(merged[0]?.qaDiagnostics?.hasTailQuestionSetup).toBeTrue();
		expect(merged[0]?.scoreOverall).toBeLessThan(82);
	});

	test("fills missing LLM IDs with deterministic fallback candidates", () => {
		const draftA: ClipCandidateDraft = {
			id: "cand-a",
			startTime: 0,
			endTime: 30,
			duration: 30,
			transcriptSnippet: "Strong complete statement with payoff.",
			localScore: 78,
		};
		const draftB: ClipCandidateDraft = {
			id: "cand-b",
			startTime: 35,
			endTime: 70,
			duration: 35,
			transcriptSnippet: "Another complete thought with clear impact.",
			localScore: 74,
		};

		const merged = mergeScoredCandidates({
			drafts: [draftA, draftB],
			scoredText: JSON.stringify({
				candidates: [
					{
						id: "cand-a",
						title: "Scored candidate",
						rationale: "Returned by the model.",
						scoreOverall: 86,
						scoreBreakdown: {
							hook: 86,
							emotion: 80,
							shareability: 82,
							clarity: 88,
							momentum: 84,
						},
					},
				],
			}),
		});

		expect(merged).toHaveLength(2);
		expect(merged.some((candidate) => candidate.id === "cand-a")).toBeTrue();
		const fallback = merged.find((candidate) => candidate.id === "cand-b");
		expect(fallback).toBeDefined();
		expect(fallback?.rationale).toContain("LLM omitted this candidate ID");
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

	test("filters cutoff boundary failures by default", () => {
		const results = selectTopCandidatesWithQualityGate({
			candidates: [
				{
					id: "a",
					startTime: 0,
					endTime: 40,
					duration: 40,
					title: "A",
					rationale: "A",
					transcriptSnippet: "A",
					scoreOverall: 95,
					scoreBreakdown: {
						hook: 95,
						emotion: 95,
						shareability: 95,
						clarity: 95,
						momentum: 95,
					},
					failureFlags: ["cutoff_end"],
				},
				{
					id: "b",
					startTime: 45,
					endTime: 82,
					duration: 37,
					title: "B",
					rationale: "B",
					transcriptSnippet: "B",
					scoreOverall: 90,
					scoreBreakdown: {
						hook: 90,
						emotion: 90,
						shareability: 90,
						clarity: 90,
						momentum: 90,
					},
					failureFlags: [],
				},
			],
			minScore: 60,
			maxCount: 5,
		});

		expect(results.map((item) => item.id)).toEqual(["b"]);
	});

	test("backfills later clean clips when the gate would otherwise return only one intro", () => {
		const results = selectTopCandidatesWithCoverageBackfill({
			candidates: [
				{
					id: "intro",
					startTime: 0,
					endTime: 34,
					duration: 34,
					title: "Intro",
					rationale: "Intro",
					transcriptSnippet: "Big opening claim with payoff.",
					scoreOverall: 91,
					scoreBreakdown: {
						hook: 91,
						emotion: 88,
						shareability: 89,
						clarity: 92,
						momentum: 90,
					},
					qaDiagnostics: {
						startsClean: true,
						endsClean: true,
						hasTailQuestionSetup: false,
						hasConsequenceChain: true,
						hasStrongStance: true,
						repetitionRisk: "low",
						infoDensity: "high",
					},
				},
				{
					id: "mid",
					startTime: 66,
					endTime: 98,
					duration: 32,
					title: "Mid",
					rationale: "Mid",
					transcriptSnippet: "Concrete mid-section takeaway with a clean ending.",
					scoreOverall: 43,
					scoreBreakdown: {
						hook: 45,
						emotion: 40,
						shareability: 41,
						clarity: 48,
						momentum: 42,
					},
					qaDiagnostics: {
						startsClean: true,
						endsClean: true,
						hasTailQuestionSetup: false,
						hasConsequenceChain: false,
						hasStrongStance: false,
						repetitionRisk: "low",
						infoDensity: "medium",
					},
				},
				{
					id: "late",
					startTime: 132,
					endTime: 162,
					duration: 30,
					title: "Late",
					rationale: "Late",
					transcriptSnippet: "Later section with a distinct standalone point.",
					scoreOverall: 41,
					scoreBreakdown: {
						hook: 42,
						emotion: 39,
						shareability: 39,
						clarity: 46,
						momentum: 41,
					},
					qaDiagnostics: {
						startsClean: true,
						endsClean: true,
						hasTailQuestionSetup: false,
						hasConsequenceChain: false,
						hasStrongStance: false,
						repetitionRisk: "low",
						infoDensity: "medium",
					},
				},
			],
			minScore: 56,
			maxCount: 5,
			minDesiredCount: 3,
			backfillMinScore: 40,
			coverageBucketSeconds: 36,
		});

		expect(results.map((item) => item.id)).toEqual(["intro", "mid", "late"]);
	});

	test("rescue backfill can use later clips even when boundary diagnostics are imperfect", () => {
		const results = selectTopCandidatesWithCoverageBackfill({
			candidates: [
				{
					id: "intro",
					startTime: 0,
					endTime: 34,
					duration: 34,
					title: "Intro",
					rationale: "Intro",
					transcriptSnippet: "Big opening claim with payoff.",
					scoreOverall: 91,
					scoreBreakdown: {
						hook: 91,
						emotion: 88,
						shareability: 89,
						clarity: 92,
						momentum: 90,
					},
					qaDiagnostics: {
						startsClean: true,
						endsClean: true,
						hasTailQuestionSetup: false,
						hasConsequenceChain: true,
						hasStrongStance: true,
						repetitionRisk: "low",
						infoDensity: "high",
					},
				},
				{
					id: "late-a",
					startTime: 92,
					endTime: 122,
					duration: 30,
					title: "Late A",
					rationale: "Late A",
					transcriptSnippet: "Later strong point.",
					scoreOverall: 27,
					scoreBreakdown: {
						hook: 28,
						emotion: 24,
						shareability: 22,
						clarity: 33,
						momentum: 27,
					},
					failureFlags: ["cutoff_start"],
					qaDiagnostics: {
						startsClean: false,
						endsClean: true,
						hasTailQuestionSetup: false,
						hasConsequenceChain: false,
						hasStrongStance: false,
						repetitionRisk: "low",
						infoDensity: "medium",
					},
				},
				{
					id: "late-b",
					startTime: 140,
					endTime: 171,
					duration: 31,
					title: "Late B",
					rationale: "Late B",
					transcriptSnippet: "Another later point.",
					scoreOverall: 24,
					scoreBreakdown: {
						hook: 25,
						emotion: 22,
						shareability: 21,
						clarity: 30,
						momentum: 24,
					},
					failureFlags: ["cutoff_end"],
					qaDiagnostics: {
						startsClean: true,
						endsClean: false,
						hasTailQuestionSetup: false,
						hasConsequenceChain: false,
						hasStrongStance: false,
						repetitionRisk: "low",
						infoDensity: "medium",
					},
				},
			],
			minScore: 56,
			maxCount: 5,
			minDesiredCount: 3,
			backfillMinScore: 0,
			coverageBucketSeconds: 36,
			requireCleanBoundariesInBackfill: false,
			excludeCutoffFailuresInBackfill: false,
		});

		expect(results.map((item) => item.id)).toEqual(["intro", "late-a", "late-b"]);
	});
});
