import { describe, expect, test } from "bun:test";
import { buildMotionTrackingKeyframesFromObservations } from "../subject-aware";
import { splitMotionTrackingAtTime } from "../motion-tracking";

describe("motion tracking keyframe generation", () => {
	test("smooths stable single-subject movement into monotonic baked keyframes", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: {
						centerX: 800,
						centerY: 400,
						width: 180,
						height: 320,
						anchorX: 800,
						anchorY: 330,
					},
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
		expect(result.keyframes[0]?.subjectCenter?.x).toBeGreaterThan(780);
		expect(result.keyframes[0]?.subjectCenter?.x).toBeLessThan(860);
		expect(result.keyframes[0]?.subjectCenter?.y).toBeLessThan(360);
		expect(result.keyframes[0]?.subjectSize?.width).toBeGreaterThan(170);
		expect(result.keyframes[0]?.subjectSize?.height).toBeGreaterThan(300);
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

		expect(result.keyframes.length).toBeGreaterThanOrEqual(2);
		expect(result.keyframes[0]!.time).toBe(0);
		expect(result.keyframes[1]!.time).toBeCloseTo(0.200001, 6);
		expect(result.keyframes.at(-1)!.time).toBeLessThanOrEqual(1.20001);
	});

	test("holds the last tracked subject through a weak competing detection", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: {
						centerX: 420,
						centerY: 320,
						width: 150,
						height: 250,
						anchorX: 420,
						anchorY: 250,
						fitWidth: 110,
						fitHeight: 170,
					},
				},
				{
					time: 0.3,
					box: {
						centerX: 420,
						centerY: 320,
						width: 150,
						height: 250,
						anchorX: 420,
						anchorY: 250,
						fitWidth: 110,
						fitHeight: 170,
					},
				},
				{
					time: 0.55,
					box: null,
				},
				{
					time: 0.7,
					box: {
						centerX: 1260,
						centerY: 360,
						width: 170,
						height: 270,
						anchorX: 1260,
						anchorY: 280,
						fitWidth: 120,
						fitHeight: 180,
					},
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: true,
		});

		expect(result.keyframes.at(-1)?.subjectCenter?.x).toBeLessThan(700);
	});

	test("holds the last tracked subject through a longer face-turn gap", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: {
						centerX: 520,
						centerY: 320,
						width: 150,
						height: 250,
						anchorX: 520,
						anchorY: 250,
						fitWidth: 110,
						fitHeight: 170,
					},
				},
				{
					time: 0.35,
					box: {
						centerX: 520,
						centerY: 320,
						width: 150,
						height: 250,
						anchorX: 520,
						anchorY: 250,
						fitWidth: 110,
						fitHeight: 170,
					},
				},
				{
					time: 0.9,
					box: null,
				},
				{
					time: 1.25,
					box: null,
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: true,
		});

		expect(result.keyframes.at(-1)?.time).toBeGreaterThan(1);
		expect(result.keyframes.at(-1)?.subjectCenter?.x).toBeCloseTo(520, 5);
	});

	test("damps brief scale spikes during a short face turn", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: {
						centerX: 640,
						centerY: 320,
						width: 150,
						height: 250,
						anchorX: 640,
						anchorY: 250,
						fitWidth: 100,
						fitHeight: 160,
					},
				},
				{
					time: 0.2,
					box: {
						centerX: 642,
						centerY: 320,
						width: 150,
						height: 250,
						anchorX: 642,
						anchorY: 250,
						fitWidth: 138,
						fitHeight: 220,
					},
				},
				{
					time: 0.4,
					box: {
						centerX: 644,
						centerY: 320,
						width: 150,
						height: 250,
						anchorX: 644,
						anchorY: 250,
						fitWidth: 102,
						fitHeight: 164,
					},
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: true,
		});

		const scales = result.keyframes.map((keyframe) => keyframe.scale);
		for (let index = 1; index < scales.length; index++) {
			expect(Math.abs(scales[index]! - scales[index - 1]!)).toBeLessThanOrEqual(
				0.036,
			);
		}
		expect(Math.max(...scales) - Math.min(...scales)).toBeLessThanOrEqual(0.05);
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
