import { describe, expect, test } from "bun:test";
import { computePeakFromChannels, isPeakSilent } from "@/lib/media/audio";

describe("audio level diagnostics", () => {
	test("computePeakFromChannels returns max absolute value across channels", () => {
		const peak = computePeakFromChannels({
			channels: [
				new Float32Array([0, -0.1, 0.3]),
				new Float32Array([0.25, -0.6, 0.2]),
			],
		});
		expect(peak).toBeCloseTo(0.6, 5);
	});

	test("isPeakSilent identifies near-zero peak as silent", () => {
		expect(isPeakSilent({ peak: 0 })).toBe(true);
		expect(isPeakSilent({ peak: 5e-5 })).toBe(true);
		expect(isPeakSilent({ peak: 0.01 })).toBe(false);
	});
});
