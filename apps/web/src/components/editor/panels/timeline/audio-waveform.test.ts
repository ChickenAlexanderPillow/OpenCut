import { describe, expect, test } from "bun:test";
import {
	getVisibleWaveformEnvelopePeaks,
} from "@/components/editor/panels/timeline/audio-waveform";
import {
	type WaveformEnvelope,
	WAVEFORM_ENVELOPE_VERSION,
} from "@/lib/media/waveform-envelope";

describe("getVisibleWaveformEnvelopePeaks", () => {
	test("returns only the trimmed window from cached full-source peaks", () => {
		const envelope: WaveformEnvelope = {
			version: WAVEFORM_ENVELOPE_VERSION,
			sourceDurationSeconds: 8,
			bucketsPerSecond: 1,
			peaks: [-0.1, 0.1, -0.2, 0.2, -0.3, 0.3, -0.4, 0.4, -0.5, 0.5, -0.6, 0.6, -0.7, 0.7, -0.8, 0.8],
		};

		const visible = getVisibleWaveformEnvelopePeaks({
			envelope,
			trimStart: 2,
			duration: 4,
			trimEnd: 2,
		});

		expect(visible).toEqual([-0.3, 0.3, -0.4, 0.4, -0.5, 0.5, -0.6, 0.6]);
	});

	test("falls back to the original peaks when trim metadata is incomplete", () => {
		const envelope: WaveformEnvelope = {
			version: WAVEFORM_ENVELOPE_VERSION,
			sourceDurationSeconds: 4,
			bucketsPerSecond: 1,
			peaks: [-0.1, 0.1, -0.2, 0.2, -0.3, 0.3, -0.4, 0.4],
		};

		const visible = getVisibleWaveformEnvelopePeaks({
			envelope,
			trimStart: 0,
			duration: 0,
			trimEnd: 0,
		});

		expect(visible).toEqual(envelope.peaks);
	});

	test("trimmed peaks still span the full rendered waveform width after slicing", () => {
		const envelope: WaveformEnvelope = {
			version: WAVEFORM_ENVELOPE_VERSION,
			sourceDurationSeconds: 8,
			bucketsPerSecond: 1,
			peaks: Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? -0.2 : 0.2) * (index + 1)),
		};
		const visible = getVisibleWaveformEnvelopePeaks({
			envelope,
			trimStart: 2,
			duration: 4,
			trimEnd: 2,
		});

		const targetBars = 8;
		const sampled = Array.from({ length: targetBars }, (_, barIndex) => {
			const startIndex = Math.floor((barIndex / targetBars) * (visible.length / 2));
			const endIndex = Math.max(
				startIndex + 1,
				Math.ceil(((barIndex + 1) / targetBars) * (visible.length / 2)),
			);
			let peak = 0;
			for (let index = startIndex; index < endIndex; index++) {
				const candidate = visible[index * 2 + 1] ?? 0;
				if (candidate > peak) peak = candidate;
			}
			return peak;
		});

		expect(sampled).toHaveLength(targetBars);
		expect(sampled.every((value) => value > 0)).toBe(true);
	});

	test("prefers the actual source duration over inferred trim math when cropping", () => {
		const envelope: WaveformEnvelope = {
			version: WAVEFORM_ENVELOPE_VERSION,
			sourceDurationSeconds: 10,
			bucketsPerSecond: 1,
			peaks: Array.from({ length: 20 }, (_, index) => index),
		};

		const visible = getVisibleWaveformEnvelopePeaks({
			envelope,
			trimStart: 2,
			duration: 4,
			trimEnd: 0,
			sourceDuration: 10,
		});

		expect(visible).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
	});
});
