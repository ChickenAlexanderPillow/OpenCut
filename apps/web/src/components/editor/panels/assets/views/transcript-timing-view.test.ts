import { describe, expect, test } from "bun:test";
import {
	buildTranscriptWaveformBars,
} from "@/components/editor/panels/assets/views/transcript-timing-view";
import { WAVEFORM_ENVELOPE_VERSION } from "@/lib/media/waveform-envelope";

describe("buildTranscriptWaveformBars", () => {
	const envelope = {
		version: WAVEFORM_ENVELOPE_VERSION,
		sourceDurationSeconds: 1,
		bucketsPerSecond: 10,
		peaks: Array.from({ length: 20 }, (_, index) =>
			index % 2 === 0 ? -((index / 2) + 1) / 10 : ((index + 1) / 2) / 10,
		),
	} as const;

	test("matches local word boundaries to exact source-time windows", () => {
		const localWords = [
			{
				word: {
					kind: "word" as const,
					id: "a",
					text: "alpha",
					wordIds: ["a"],
					firstWord: { id: "a", text: "alpha", startTime: 0, endTime: 0.4 },
					lastWord: { id: "a", text: "alpha", startTime: 0, endTime: 0.4 },
					startTime: 0,
					endTime: 0.4,
				},
				displayStartTime: 0,
				displayEndTime: 0.4,
			},
			{
				word: {
					kind: "word" as const,
					id: "b",
					text: "beta",
					wordIds: ["b"],
					firstWord: { id: "b", text: "beta", startTime: 0.4, endTime: 0.8 },
					lastWord: { id: "b", text: "beta", startTime: 0.4, endTime: 0.8 },
					startTime: 0.4,
					endTime: 0.8,
				},
				displayStartTime: 0.4,
				displayEndTime: 0.8,
			},
		];

		const bars = buildTranscriptWaveformBars({
			envelope,
			localWords,
			localWindow: { startTime: 0, duration: 0.8 },
			barCount: 2,
		});

		expect(bars).toEqual([
			{ min: -0.4, max: 0.4 },
			{ min: -0.8, max: 0.8 },
		]);
	});

	test("updates the sampled waveform when preview boundaries move", () => {
		const previewWords = [
			{
				word: {
					kind: "word" as const,
					id: "a",
					text: "alpha",
					wordIds: ["a"],
					firstWord: { id: "a", text: "alpha", startTime: 0, endTime: 0.5 },
					lastWord: { id: "a", text: "alpha", startTime: 0, endTime: 0.5 },
					startTime: 0,
					endTime: 0.5,
				},
				displayStartTime: 0,
				displayEndTime: 0.5,
			},
			{
				word: {
					kind: "word" as const,
					id: "b",
					text: "beta",
					wordIds: ["b"],
					firstWord: { id: "b", text: "beta", startTime: 0.5, endTime: 0.8 },
					lastWord: { id: "b", text: "beta", startTime: 0.5, endTime: 0.8 },
					startTime: 0.5,
					endTime: 0.8,
				},
				displayStartTime: 0.5,
				displayEndTime: 0.8,
			},
		];

		const bars = buildTranscriptWaveformBars({
			envelope,
			localWords: previewWords,
			localWindow: { startTime: 0, duration: 0.8 },
			barCount: 2,
		});

		expect(bars).toEqual([
			{ min: -0.4, max: 0.4 },
			{ min: -0.8, max: 0.8 },
		]);
		expect(bars[0]).not.toEqual({ min: -0.5, max: 0.5 });
	});
});
