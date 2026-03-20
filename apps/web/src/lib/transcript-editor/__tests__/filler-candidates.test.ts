import { describe, expect, test } from "bun:test";
import { detectTranscriptFillerCandidates } from "@/lib/transcript-editor/core";

describe("transcript filler candidates", () => {
	test("marks strong single-token fillers as high confidence", () => {
		const candidates = detectTranscriptFillerCandidates({
			words: [
				{ id: "w1", text: "um", startTime: 0, endTime: 0.2, removed: false },
				{
					id: "w2",
					text: "hello",
					startTime: 0.25,
					endTime: 0.6,
					removed: false,
				},
			],
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.text).toBe("um");
		expect(candidates[0]?.confidence).toBe("high");
	});

	test("detects known filler phrases as a single candidate", () => {
		const candidates = detectTranscriptFillerCandidates({
			words: [
				{ id: "w1", text: "you", startTime: 0, endTime: 0.12, removed: false },
				{
					id: "w2",
					text: "know",
					startTime: 0.14,
					endTime: 0.3,
					removed: false,
				},
				{
					id: "w3",
					text: "this",
					startTime: 0.32,
					endTime: 0.5,
					removed: false,
				},
			],
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.text).toBe("you know");
		expect(candidates[0]?.wordIds).toEqual(["w1", "w2"]);
		expect(candidates[0]?.confidence).toBe("medium");
	});

	test("downgrades ambiguous tokens inside a flowing sentence", () => {
		const candidates = detectTranscriptFillerCandidates({
			words: [
				{ id: "w1", text: "I", startTime: 0, endTime: 0.1, removed: false },
				{
					id: "w2",
					text: "like",
					startTime: 0.11,
					endTime: 0.2,
					removed: false,
				},
				{
					id: "w3",
					text: "editing",
					startTime: 0.21,
					endTime: 0.5,
					removed: false,
				},
			],
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.text).toBe("like");
		expect(candidates[0]?.confidence).toBe("low");
	});

	test("upgrades ambiguous tokens near a boundary or pause", () => {
		const candidates = detectTranscriptFillerCandidates({
			words: [
				{
					id: "w1",
					text: "So,",
					startTime: 0,
					endTime: 0.18,
					removed: false,
				},
				{
					id: "w2",
					text: "like",
					startTime: 0.35,
					endTime: 0.48,
					removed: false,
				},
				{
					id: "w3",
					text: "we",
					startTime: 0.62,
					endTime: 0.72,
					removed: false,
				},
			],
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.confidence).toBe("medium");
	});

	test("marks immediate repeated words as high confidence", () => {
		const candidates = detectTranscriptFillerCandidates({
			words: [
				{ id: "w1", text: "I", startTime: 0, endTime: 0.08, removed: false },
				{
					id: "w2",
					text: "I",
					startTime: 0.1,
					endTime: 0.18,
					removed: false,
				},
				{
					id: "w3",
					text: "think",
					startTime: 0.2,
					endTime: 0.45,
					removed: false,
				},
			],
		});

		expect(candidates).toContainEqual(
			expect.objectContaining({
				id: "repeat:w1",
				wordIds: ["w1"],
				confidence: "high",
			}),
		);
	});

	test("marks short stutter fragments before the completed word", () => {
		const candidates = detectTranscriptFillerCandidates({
			words: [
				{ id: "w1", text: "th", startTime: 0, endTime: 0.05, removed: false },
				{
					id: "w2",
					text: "think",
					startTime: 0.08,
					endTime: 0.4,
					removed: false,
				},
			],
		});

		expect(candidates).toContainEqual(
			expect.objectContaining({
				id: "stutter:w1",
				wordIds: ["w1"],
				confidence: "medium",
			}),
		);
	});
});
