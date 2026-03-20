import { describe, expect, test } from "bun:test";
import { detectAudioDisfluencyCandidatesFromSamples } from "@/lib/transcript-editor/audio-disfluency";

describe("audio disfluency detector", () => {
	test("finds a short voiced burst inside a transcript gap", () => {
		const sampleRate = 1000;
		const samples = new Float32Array(2000);

		for (let index = 0; index < samples.length; index++) {
			samples[index] = 0.0005;
		}

		for (let index = 920; index < 1080; index++) {
			samples[index] = Math.sin((index / 12) * Math.PI) * 0.05;
		}

		const candidates = detectAudioDisfluencyCandidatesFromSamples({
			samples,
			sampleRate,
			clipTrimStart: 0,
			words: [
				{
					id: "w1",
					text: "hello",
					startTime: 0.4,
					endTime: 0.8,
					removed: false,
				},
				{
					id: "w2",
					text: "world",
					startTime: 1.2,
					endTime: 1.5,
					removed: false,
				},
			],
		});

		expect(candidates.length).toBeGreaterThan(0);
		expect(candidates[0]?.startTime ?? 0).toBeGreaterThan(0.85);
		expect(candidates[0]?.endTime ?? 0).toBeLessThan(1.15);
	});
});
