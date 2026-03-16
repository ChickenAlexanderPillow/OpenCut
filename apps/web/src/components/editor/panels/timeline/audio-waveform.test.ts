import { describe, expect, test } from "bun:test";
import {
	selectVisibleWaveformPeaks,
} from "@/components/editor/panels/timeline/audio-waveform";

describe("selectVisibleWaveformPeaks", () => {
	test("returns only the trimmed window from cached full-source peaks", () => {
		const peaks = [0, 1, 2, 3, 4, 5, 6, 7];

		const visible = selectVisibleWaveformPeaks({
			peaks,
			trimStart: 2,
			duration: 4,
			trimEnd: 2,
		});

		expect(visible).toEqual([2, 3, 4, 5]);
	});

	test("falls back to the original peaks when trim metadata is incomplete", () => {
		const peaks = [0, 1, 2, 3];

		const visible = selectVisibleWaveformPeaks({
			peaks,
			trimStart: 0,
			duration: 0,
			trimEnd: 0,
		});

		expect(visible).toEqual(peaks);
	});

	test("trimmed peaks still span the full rendered waveform width after slicing", () => {
		const peaks = Array.from({ length: 8 }, (_, index) => index + 1);
		const visible = selectVisibleWaveformPeaks({
			peaks,
			trimStart: 2,
			duration: 4,
			trimEnd: 2,
		});

		const targetBars = 8;
		const sampled = Array.from({ length: targetBars }, (_, barIndex) => {
			const startIndex = Math.floor((barIndex / targetBars) * visible.length);
			const endIndex = Math.max(
				startIndex + 1,
				Math.ceil(((barIndex + 1) / targetBars) * visible.length),
			);
			let peak = 0;
			for (let index = startIndex; index < endIndex; index++) {
				const candidate = visible[index] ?? 0;
				if (candidate > peak) peak = candidate;
			}
			return peak;
		});

		expect(sampled).toHaveLength(targetBars);
		expect(sampled.every((value) => value > 0)).toBe(true);
	});
});
