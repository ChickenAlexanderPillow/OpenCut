import { describe, expect, test } from "bun:test";
import {
	buildClipCandidatesFromTranscript,
	buildSentenceUnitsFromSegments,
} from "@/lib/clips/candidate-builder";

describe("sentence unit candidate builder", () => {
	test("builds sentence units with punctuation-aware split and timing interpolation", () => {
		const units = buildSentenceUnitsFromSegments({
			mediaDuration: 120,
			segments: [
				{
					text: "for gambling. And so look my view is there is momentum.",
					start: 60,
					end: 90,
				},
			],
		});

		expect(units.length).toBeGreaterThan(1);
		expect(units[0]?.text.toLowerCase()).toContain("for gambling");
		expect(units[1]?.text.toLowerCase()).toContain("and so look");
		expect(units[0]?.start).toBeGreaterThanOrEqual(60);
		expect(units[units.length - 1]?.end).toBeLessThanOrEqual(90);
	});

	test("builds candidates in configured duration range", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 200,
			segments: [
				{
					text: "We are seeing strong demand and continued growth in the market.",
					start: 10,
					end: 24,
				},
				{
					text: "There are still headwinds from rates and inflation, but outlook is positive.",
					start: 24,
					end: 42,
				},
				{
					text: "The next quarter should show whether this trend is durable.",
					start: 42,
					end: 54,
				},
			],
			minClipSeconds: 20,
			maxClipSeconds: 40,
		});

		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) {
			expect(candidate.duration).toBeGreaterThanOrEqual(20);
			expect(candidate.duration).toBeLessThanOrEqual(40);
		}
	});

	test("drops question-only windows without answers", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 180,
			minClipSeconds: 20,
			targetClipSeconds: 32,
			maxClipSeconds: 45,
			segments: [
				{
					text: "Now I resisted the urge to ask about prediction markets right away.",
					start: 100,
					end: 112,
				},
				{
					text: "But my question is how do you respond to this trend?",
					start: 112,
					end: 126,
				},
			],
		});

		expect(candidates).toHaveLength(0);
	});

	test("keeps windows that include question and answer", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 180,
			minClipSeconds: 20,
			targetClipSeconds: 32,
			maxClipSeconds: 45,
			segments: [
				{
					text: "What changed in your strategy this year?",
					start: 20,
					end: 28,
				},
				{
					text: "We shifted to retention and focused on long-term value creation.",
					start: 28,
					end: 44,
				},
				{
					text: "That led to better conversion and more predictable growth.",
					start: 44,
					end: 56,
				},
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
		expect(
			candidates.some((candidate) =>
				candidate.transcriptSnippet.toLowerCase().includes("better conversion"),
			),
		).toBeTrue();
	});

	test("splits long unpunctuated runs so bounded candidates can still be produced", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 220,
			minClipSeconds: 20,
			targetClipSeconds: 35,
			maxClipSeconds: 40,
			segments: [
				{
					text: "We shifted from broad awareness to a tighter enterprise motion with clearer qualification stronger handoffs more disciplined account selection and improved onboarding to drive conversion",
					start: 20,
					end: 70,
				},
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
		expect(candidates[0]?.duration).toBeLessThanOrEqual(40);
	});

	test("analogy windows naturally rank high", () => {
		const candidates = buildClipCandidatesFromTranscript({
			mediaDuration: 260,
			minClipSeconds: 20,
			targetClipSeconds: 30,
			maxClipSeconds: 45,
			segments: [
				{
					text: "There is a lot of momentum behind prediction markets.",
					start: 120,
					end: 130,
				},
				{
					text: "But there was a lot of momentum around tulip bulbs in Holland and then they became valueless.",
					start: 130,
					end: 150,
				},
				{
					text: "That is why we think this needs a more grounded regulatory framework.",
					start: 150,
					end: 164,
				},
				{
					text: "Here is another generic update without a strong hook or payoff.",
					start: 190,
					end: 205,
				},
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
		const top = candidates[0];
		expect(top).toBeDefined();
		expect(top?.transcriptSnippet.toLowerCase()).toContain("tulip");
	});

	test("produces stable deterministic windows across repeated runs", () => {
		const input = {
			mediaDuration: 180,
			minClipSeconds: 20,
			targetClipSeconds: 32,
			maxClipSeconds: 45,
			segments: [
				{
					text: "We are seeing growth in several channels.",
					start: 12,
					end: 22,
				},
				{
					text: "But we also face risk from macro conditions and tariff shifts.",
					start: 22,
					end: 36,
				},
				{
					text: "What gives us confidence is sustained demand from core customers.",
					start: 36,
					end: 49,
				},
				{
					text: "That is why we remain optimistic for next year.",
					start: 49,
					end: 60,
				},
			],
		};

		const run1 = buildClipCandidatesFromTranscript(input).map(
			(candidate) => `${candidate.startTime}-${candidate.endTime}`,
		);
		const run2 = buildClipCandidatesFromTranscript(input).map(
			(candidate) => `${candidate.startTime}-${candidate.endTime}`,
		);
		expect(run1).toEqual(run2);
	});
});
