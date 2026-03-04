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
			expect(candidate.duration).toBeGreaterThanOrEqual(20);
			expect(candidate.duration).toBeLessThanOrEqual(90);
			expect(candidate.startTime).toBeGreaterThanOrEqual(0);
			expect(candidate.endTime).toBeLessThanOrEqual(200);
		}
	});

	test("drops windows that begin with unresolved context references", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 120,
			segments: [
				{
					text: "It completely changed our retention curve.",
					start: 30,
					end: 38,
				},
				{
					text: "The key was pairing product nudges with customer education.",
					start: 38,
					end: 52,
				},
			],
		});

		expect(candidates.length).toBe(0);
	});

	test("allows context-dependent opening only when clip begins near media start", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 90,
			segments: [
				{
					text: "It sounds obvious, but this is where most teams fail.",
					start: 0,
					end: 12,
				},
				{
					text: "If you map onboarding step by step, drop-off falls quickly.",
					start: 12,
					end: 30,
				},
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
	});

	test("cuts before a second question in the same candidate window", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 180,
			segments: [
				{ text: "What is your strategy for growth?", start: 10, end: 16 },
				{
					text: "We focus on retention and long term value.",
					start: 16,
					end: 28,
				},
				{ text: "Can you share a specific example?", start: 28, end: 34 },
				{
					text: "Yes, we launched an onboarding experiment.",
					start: 34,
					end: 44,
				},
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) {
			const snippetQuestions = (candidate.transcriptSnippet.match(/\?/g) ?? [])
				.length;
			expect(snippetQuestions).toBeLessThanOrEqual(1);
		}
	});

	test("cuts trailing unanswered follow-up question from candidate windows", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 180,
			minClipSeconds: 20,
			targetClipSeconds: 35,
			maxClipSeconds: 60,
			segments: [
				{ text: "How are you approaching this year?", start: 10, end: 15 },
				{
					text: "We are focused on distribution and retention.",
					start: 15,
					end: 27,
				},
				{
					text: "Can you comment on next quarter guidance?",
					start: 27,
					end: 33,
				},
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) {
			const snippet = candidate.transcriptSnippet.toLowerCase();
			expect(snippet).not.toContain("next quarter guidance");
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
			candidates.map(
				(candidate) => `${candidate.startTime}-${candidate.endTime}`,
			),
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

	test("clips snippet text to overlapped window for partially overlapped segments", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 120,
			minClipSeconds: 20,
			targetClipSeconds: 20,
			maxClipSeconds: 40,
			segments: [
				{
					text: "Hello viewers Tim Poole here on The Huddle and I am with Gronja Hurst CEO of the Betting and Gaming Council",
					start: 0,
					end: 30,
				},
				{
					text: "the only real winner out of this process is going to be the black market",
					start: 30,
					end: 38,
				},
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
		const candidateNearBoundary = candidates.find((candidate) =>
			candidate.transcriptSnippet.toLowerCase().includes("black market"),
		);
		expect(candidateNearBoundary).toBeDefined();
		expect(
			candidateNearBoundary?.transcriptSnippet.toLowerCase(),
		).not.toContain("hello viewers");
		expect(candidateNearBoundary?.transcriptSnippet.toLowerCase()).toContain(
			"black market",
		);
	});

	test("enforces max duration cap even when sentence continuation is long", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 200,
			minClipSeconds: 20,
			targetClipSeconds: 35,
			maxClipSeconds: 40,
			segments: [
				{
					text: "What changed in your go-to-market over the last year?",
					start: 5,
					end: 10,
				},
				{
					text: "We shifted from broad awareness to a tighter enterprise motion with clearer qualification and stronger handoffs across teams",
					start: 10,
					end: 48,
				},
				{
					text: "That gave us better conversion and a shorter cycle.",
					start: 48,
					end: 54,
				},
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
		const longAnswerCandidate = candidates.find((candidate) =>
			candidate.transcriptSnippet.toLowerCase().includes("handoffs"),
		);
		expect(longAnswerCandidate).toBeDefined();
		expect(longAnswerCandidate?.duration).toBeLessThanOrEqual(40);
	});
});
