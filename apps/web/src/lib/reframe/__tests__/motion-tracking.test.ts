import { describe, expect, test } from "bun:test";
import { buildMotionTrackingKeyframesFromObservations } from "../subject-aware";
import { splitMotionTrackingAtTime } from "../motion-tracking";

describe("motion tracking keyframe generation", () => {
	test("smooths stable single-subject movement into monotonic baked keyframes", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: { centerX: 800, centerY: 400, width: 180, height: 320 },
				},
				{
					time: 0.2,
					box: { centerX: 840, centerY: 402, width: 180, height: 320 },
				},
				{
					time: 0.4,
					box: { centerX: 900, centerY: 405, width: 180, height: 320 },
				},
				{
					time: 0.6,
					box: { centerX: 960, centerY: 408, width: 180, height: 320 },
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: false,
		});

		expect(result.sampleCount).toBe(4);
		expect(result.trackedSampleCount).toBe(4);
		expect(result.keyframes.length).toBeGreaterThanOrEqual(2);
		for (let index = 1; index < result.keyframes.length; index++) {
			expect(result.keyframes[index]!.position.x).toBeLessThanOrEqual(
				result.keyframes[index - 1]!.position.x,
			);
		}
	});

	test("does not drift through long detection loss", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: { centerX: 900, centerY: 405, width: 180, height: 320 },
				},
				{
					time: 0.2,
					box: { centerX: 905, centerY: 404, width: 180, height: 320 },
				},
				{
					time: 0.8,
					box: null,
				},
				{
					time: 1.2,
					box: null,
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: true,
		});

		expect(result.keyframes).toHaveLength(2);
		expect(result.keyframes[0]!.time).toBe(0);
		expect(result.keyframes[1]!.time).toBeCloseTo(0.200001, 6);
	});

	test("preserves the tracked frame at split boundaries", () => {
		const split = splitMotionTrackingAtTime({
			motionTracking: {
				enabled: true,
				mode: "subject-single-v1",
				source: "baked-keyframes",
				animateScale: true,
				cacheKey: "cached",
				keyframes: [
					{
						id: "a",
						time: 0,
						position: { x: 0, y: 10 },
						scale: 1,
					},
					{
						id: "b",
						time: 1,
						position: { x: 100, y: 30 },
						scale: 1.4,
					},
				],
			},
			splitTime: 0.5,
		});

		expect(split.left?.cacheKey).toBeUndefined();
		expect(split.right?.cacheKey).toBeUndefined();
		expect(split.left?.keyframes.at(-1)?.time).toBeCloseTo(0.5, 6);
		expect(split.left?.keyframes.at(-1)?.position.x).toBeCloseTo(50, 6);
		expect(split.left?.keyframes.at(-1)?.position.y).toBeCloseTo(20, 6);
		expect(split.left?.keyframes.at(-1)?.scale).toBeCloseTo(1.2, 6);
		expect(split.right?.keyframes[0]?.time).toBe(0);
		expect(split.right?.keyframes[0]?.position.x).toBeCloseTo(50, 6);
		expect(split.right?.keyframes[0]?.position.y).toBeCloseTo(20, 6);
		expect(split.right?.keyframes[0]?.scale).toBeCloseTo(1.2, 6);
	});

	test("can snap a split clip to the first retained tracked pose", () => {
		const split = splitMotionTrackingAtTime({
			motionTracking: {
				enabled: true,
				mode: "subject-single-v1",
				source: "baked-keyframes",
				animateScale: true,
				keyframes: [
					{
						id: "a",
						time: 0,
						position: { x: 0, y: 10 },
						scale: 1,
					},
					{
						id: "b",
						time: 1,
						position: { x: 100, y: 30 },
						scale: 1.4,
					},
				],
			},
			splitTime: 0.5,
			rightBoundaryStrategy: "hold-next-keyframe",
		});

		expect(split.right?.keyframes[0]?.time).toBe(0);
		expect(split.right?.keyframes[0]?.position.x).toBeCloseTo(100, 6);
		expect(split.right?.keyframes[0]?.position.y).toBeCloseTo(30, 6);
		expect(split.right?.keyframes[0]?.scale).toBeCloseTo(1.4, 6);
		expect(split.right?.keyframes[1]?.time).toBeCloseTo(0.5, 6);
		expect(split.right?.keyframes[1]?.position.x).toBeCloseTo(100, 6);
	});
});
