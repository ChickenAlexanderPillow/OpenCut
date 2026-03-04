import { describe, expect, test } from "bun:test";
import { buildClipCandidatesFromTranscriptV2 } from "@/lib/clips/v2/candidate-builder";
import { buildSemanticChunksFromTranscript } from "@/lib/clips/v2/semantic-chunking";

describe("semantic chunking v2", () => {
	test("splits transcript into multiple chunks when topic changes", () => {
		const chunks = buildSemanticChunksFromTranscript({
			mediaDuration: 150,
			segments: [
				{ text: "Today we are covering email deliverability and open rates.", start: 2, end: 9 },
				{ text: "Subject lines and preview text can improve clickthrough.", start: 10, end: 17 },
				{ text: "Audience segmentation is crucial for sender reputation.", start: 18, end: 25 },
				{ text: "Now switching gears to camera lenses and lighting setup.", start: 27, end: 34 },
				{ text: "Use a key light and avoid mixed color temperatures.", start: 35, end: 42 },
				{ text: "A 35mm prime gives a natural framing for talking heads.", start: 43, end: 50 },
			],
		});

		expect(chunks.length).toBeGreaterThanOrEqual(2);
		const firstChunkText = chunks[0]?.segments.map((segment) => segment.text).join(" ") ?? "";
		const secondChunkText = chunks[1]?.segments.map((segment) => segment.text).join(" ") ?? "";
		expect(firstChunkText.toLowerCase()).toContain("email");
		expect(secondChunkText.toLowerCase()).toContain("camera");
	});

	test("avoids over-fragmenting semantically continuous transcript", () => {
		const chunks = buildSemanticChunksFromTranscript({
			mediaDuration: 120,
			segments: [
				{ text: "To improve retention, focus on your opening sentence.", start: 3, end: 9 },
				{ text: "A concrete claim in the first seconds raises watch time.", start: 10, end: 16 },
				{ text: "Then give one example and a clear takeaway.", start: 17, end: 24 },
				{ text: "This structure keeps viewers engaged through the midpoint.", start: 25, end: 31 },
			],
		});

		expect(chunks.length).toBeLessThanOrEqual(2);
		expect(chunks.reduce((sum, chunk) => sum + chunk.duration, 0)).toBeGreaterThan(25);
	});

	test("v2 candidate builder returns bounded candidates from semantic chunks", () => {
		const candidates = buildClipCandidatesFromTranscriptV2({
			mediaDuration: 180,
			minClipSeconds: 20,
			targetClipSeconds: 36,
			maxClipSeconds: 65,
			segments: [
				{ text: "We tested three intro hooks and tracked completion.", start: 4, end: 12 },
				{ text: "The specific-number hook won by a wide margin.", start: 13, end: 21 },
				{ text: "Comments doubled when we promised one concrete framework.", start: 22, end: 30 },
				{ text: "Now switching gears to editing and camera workflow.", start: 35, end: 42 },
				{ text: "Cut dead air aggressively and keep visual rhythm tight.", start: 43, end: 51 },
				{ text: "Use scene changes to reset attention every few seconds.", start: 52, end: 60 },
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) {
			expect(candidate.duration).toBeGreaterThanOrEqual(20);
			expect(candidate.duration).toBeLessThanOrEqual(65);
			expect(candidate.startTime).toBeGreaterThanOrEqual(0);
			expect(candidate.endTime).toBeLessThanOrEqual(180);
		}
	});
});
