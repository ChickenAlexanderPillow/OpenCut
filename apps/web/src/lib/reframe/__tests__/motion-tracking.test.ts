import { describe, expect, test } from "bun:test";
import { buildMotionTrackingKeyframesFromObservations } from "../subject-aware";
import {
	buildMotionTrackingPresetSignature,
	resolveMotionTrackedReframeTransform,
	resolveMotionTrackedSubjectFrame,
	splitMotionTrackingAtTime,
} from "../motion-tracking";

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

	test("builds tracked framing from the face-sized fit box", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: {
						centerX: 800,
						centerY: 420,
						width: 500,
						height: 700,
						anchorX: 800,
						anchorY: 300,
						fitWidth: 110,
						fitHeight: 170,
					},
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: false,
		});

		expect(result.keyframes).toHaveLength(1);
		expect(result.keyframes[0]?.subjectCenter?.x).toBeCloseTo(800, 6);
		expect(result.keyframes[0]?.subjectCenter?.y).toBeCloseTo(292.228571, 5);
		expect(result.keyframes[0]?.subjectSize?.width).toBeCloseTo(110, 6);
		expect(result.keyframes[0]?.subjectSize?.height).toBeCloseTo(170, 6);
		expect(result.keyframes[0]?.scale).toBeCloseTo(4.189090909, 6);
	});

	test("prefers an explicit face tracking anchor over the inferred box anchor", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: {
						centerX: 800,
						centerY: 420,
						width: 500,
						height: 700,
						anchorX: 800,
						anchorY: 300,
						fitWidth: 110,
						fitHeight: 170,
						trackingAnchorX: 824,
						trackingAnchorY: 276,
					},
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: false,
		});

		expect(result.keyframes).toHaveLength(1);
		expect(result.keyframes[0]?.subjectCenter?.x).toBeCloseTo(824, 6);
		expect(result.keyframes[0]?.subjectCenter?.y).toBeCloseTo(276, 6);
	});

	test("treats head-anchor fallback differently from eye-line tracking", () => {
		const eyeTracked = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: {
						centerX: 800,
						centerY: 420,
						width: 500,
						height: 700,
						anchorX: 800,
						anchorY: 300,
						fitWidth: 110,
						fitHeight: 170,
						trackingAnchorX: 824,
						trackingAnchorY: 500,
						trackingAnchorKind: "eye",
					},
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: false,
		});
		const headTracked = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: {
						centerX: 800,
						centerY: 420,
						width: 500,
						height: 700,
						anchorX: 800,
						anchorY: 300,
						fitWidth: 110,
						fitHeight: 170,
						trackingAnchorX: 824,
						trackingAnchorY: 500,
						trackingAnchorKind: "head",
					},
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: false,
		});

		expect(eyeTracked.keyframes).toHaveLength(1);
		expect(headTracked.keyframes).toHaveLength(1);
		expect(headTracked.keyframes[0]?.subjectCenter?.x).toBeCloseTo(824, 6);
		expect(headTracked.keyframes[0]?.subjectCenter?.y).toBeCloseTo(500, 6);
		expect(headTracked.keyframes[0]!.position.y).not.toBeCloseTo(
			eyeTracked.keyframes[0]!.position.y,
			6,
		);
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
		expect(result.keyframes[0]?.time).toBe(0);
		expect(result.keyframes[1]?.time).toBeGreaterThanOrEqual(0.2);
		expect(result.keyframes.at(-1)!.time).toBeLessThanOrEqual(1.20001);
	});

	test("anchors tracking to clip start when first usable observation lands later", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0.3,
					box: {
						centerX: 840,
						centerY: 360,
						width: 180,
						height: 320,
						anchorX: 840,
						anchorY: 300,
					},
				},
				{
					time: 0.6,
					box: {
						centerX: 860,
						centerY: 364,
						width: 180,
						height: 320,
						anchorX: 860,
						anchorY: 304,
					},
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: true,
		});

		expect(result.keyframes[0]?.time).toBe(0);
		expect(result.keyframes[0]?.subjectCenter?.x).toBeGreaterThan(830);
		expect(result.keyframes[0]?.subjectCenter?.x).toBeLessThan(850);
		expect(result.keyframes[0]?.subjectCenter?.y).toBeGreaterThan(280);
		expect(result.keyframes[0]?.subjectCenter?.y).toBeLessThan(300);
	});

	test("skips a coarse startup head fallback when eye tracking appears immediately after", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: {
						centerX: 760,
						centerY: 360,
						width: 180,
						height: 260,
						anchorX: 760,
						anchorY: 250,
						fitWidth: 120,
						fitHeight: 180,
						trackingAnchorX: 760,
						trackingAnchorY: 250,
						trackingAnchorKind: "head",
						trackingSource: "head-detection",
					},
				},
				{
					time: 0.2,
					box: {
						centerX: 860,
						centerY: 360,
						width: 180,
						height: 260,
						anchorX: 860,
						anchorY: 230,
						fitWidth: 120,
						fitHeight: 180,
						trackingAnchorX: 860,
						trackingAnchorY: 230,
						trackingAnchorKind: "eye",
						trackingSource: "eye",
					},
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: true,
		});

		expect(result.keyframes[0]?.time).toBe(0);
		expect(result.keyframes[0]?.trackingSource).toBe("eye");
		expect(result.keyframes[0]?.subjectCenter?.x).toBeGreaterThan(830);
	});

	test("holds the last tracked face through a brief detector miss", () => {
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
					time: 0.12,
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
					time: 0.24,
					box: null,
				},
				{
					time: 0.36,
					box: {
						centerX: 422,
						centerY: 320,
						width: 152,
						height: 252,
						anchorX: 422,
						anchorY: 250,
						fitWidth: 112,
						fitHeight: 172,
					},
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: true,
		});

		expect(result.keyframes).toHaveLength(4);
		expect(result.keyframes[2]?.time).toBeCloseTo(0.240002, 6);
		expect(result.keyframes[2]?.subjectCenter?.x).toBeCloseTo(
			result.keyframes[1]!.subjectCenter!.x,
			6,
		);
	});

	test("drops tracking after a longer face-turn gap instead of holding stale framing", () => {
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

		expect(result.keyframes.at(-1)?.time).toBeCloseTo(0.350001, 6);
		expect(result.trackedSampleCount).toBe(2);
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
				0.1,
			);
		}
		expect(Math.max(...scales) - Math.min(...scales)).toBeLessThanOrEqual(0.1);
		expect(result.keyframes[1]?.subjectSize?.width).toBeCloseTo(102, 6);
		expect(result.keyframes[2]?.scale).toBeCloseTo(result.keyframes[1]!.scale, 6);
	});

	test("bakes dense tracking keyframes so motion does not lag behind sampled observations", () => {
		const result = buildMotionTrackingKeyframesFromObservations({
			observations: [
				{
					time: 0,
					box: {
						centerX: 800,
						centerY: 320,
						width: 180,
						height: 320,
						anchorX: 800,
						anchorY: 250,
					},
				},
				{
					time: 0.2,
					box: {
						centerX: 820,
						centerY: 320,
						width: 180,
						height: 320,
						anchorX: 820,
						anchorY: 250,
					},
				},
				{
					time: 0.4,
					box: {
						centerX: 840,
						centerY: 320,
						width: 180,
						height: 320,
						anchorX: 840,
						anchorY: 250,
					},
				},
				{
					time: 0.6,
					box: {
						centerX: 860,
						centerY: 320,
						width: 180,
						height: 320,
						anchorX: 860,
						anchorY: 250,
					},
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
			animateScale: false,
		});

		expect(result.trackedSampleCount).toBe(4);
		expect(result.keyframes).toHaveLength(4);
		expect(result.keyframes.map((keyframe) => Number(keyframe.time.toFixed(1)))).toEqual([
			0, 0.2, 0.4, 0.6,
		]);
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

	test("holds a stable subject size when animateScale is disabled", () => {
		const resolved = resolveMotionTrackedSubjectFrame({
			motionTracking: {
				enabled: true,
				mode: "subject-single-v1",
				source: "baked-keyframes",
				animateScale: false,
				keyframes: [
					{
						id: "a",
						time: 0,
						position: { x: 0, y: 0 },
						scale: 1,
						subjectCenter: { x: 100, y: 120 },
						subjectSize: { width: 180, height: 300 },
					},
					{
						id: "b",
						time: 1,
						position: { x: 20, y: -10 },
						scale: 1.5,
						subjectCenter: { x: 180, y: 200 },
						subjectSize: { width: 320, height: 520 },
					},
				],
			},
			localTime: 1,
		});

		expect(resolved?.center.x).toBeCloseTo(180, 6);
		expect(resolved?.center.y).toBeCloseTo(200, 6);
		expect(resolved?.size?.width).toBeCloseTo(180, 6);
		expect(resolved?.size?.height).toBeCloseTo(300, 6);
	});

	test("locks to the initial tracked scale when animateScale is disabled", () => {
		const resolved = resolveMotionTrackedReframeTransform({
			baseTransform: {
				position: { x: 0, y: 0 },
				scale: 0.75,
			},
			motionTracking: {
				enabled: true,
				mode: "subject-single-v1",
				source: "baked-keyframes",
				animateScale: false,
				keyframes: [
					{
						id: "a",
						time: 0,
						position: { x: 10, y: 20 },
						scale: 1.4,
					},
					{
						id: "b",
						time: 1,
						position: { x: 30, y: 40 },
						scale: 2.2,
					},
				],
			},
			localTime: 0.8,
		});

		expect(resolved.position.x).toBeCloseTo(26, 6);
		expect(resolved.position.y).toBeCloseTo(36, 6);
		expect(resolved.scale).toBeCloseTo(1.4, 6);
	});

	test("interpolates tracking linearly without easing acceleration", () => {
		const atQuarter = resolveMotionTrackedReframeTransform({
			baseTransform: {
				position: { x: 0, y: 0 },
				scale: 1,
			},
			motionTracking: {
				enabled: true,
				mode: "subject-single-v1",
				source: "baked-keyframes",
				animateScale: true,
				keyframes: [
					{
						id: "a",
						time: 0,
						position: { x: 0, y: 0 },
						scale: 1,
					},
					{
						id: "b",
						time: 1,
						position: { x: 100, y: 40 },
						scale: 1.8,
					},
				],
			},
			localTime: 0.25,
		});
		const atHalf = resolveMotionTrackedReframeTransform({
			baseTransform: {
				position: { x: 0, y: 0 },
				scale: 1,
			},
			motionTracking: {
				enabled: true,
				mode: "subject-single-v1",
				source: "baked-keyframes",
				animateScale: true,
				keyframes: [
					{
						id: "a",
						time: 0,
						position: { x: 0, y: 0 },
						scale: 1,
					},
					{
						id: "b",
						time: 1,
						position: { x: 100, y: 40 },
						scale: 1.8,
					},
				],
			},
			localTime: 0.5,
		});
		const atThreeQuarters = resolveMotionTrackedReframeTransform({
			baseTransform: {
				position: { x: 0, y: 0 },
				scale: 1,
			},
			motionTracking: {
				enabled: true,
				mode: "subject-single-v1",
				source: "baked-keyframes",
				animateScale: true,
				keyframes: [
					{
						id: "a",
						time: 0,
						position: { x: 0, y: 0 },
						scale: 1,
					},
					{
						id: "b",
						time: 1,
						position: { x: 100, y: 40 },
						scale: 1.8,
					},
				],
			},
			localTime: 0.75,
		});

		expect(atQuarter.position.x).toBeCloseTo(25, 6);
		expect(atQuarter.position.y).toBeCloseTo(10, 6);
		expect(atQuarter.scale).toBeCloseTo(1.2, 6);
		expect(atHalf.position.x).toBeCloseTo(50, 6);
		expect(atHalf.position.y).toBeCloseTo(20, 6);
		expect(atHalf.scale).toBeCloseTo(1.4, 6);
		expect(atThreeQuarters.position.x).toBeCloseTo(75, 6);
		expect(atThreeQuarters.position.y).toBeCloseTo(30, 6);
		expect(atThreeQuarters.scale).toBeCloseTo(1.6, 6);
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

	test("includes subject seed and cache version in the tracking signature", () => {
		const basePreset = {
			id: "preset-a",
			name: "Subject",
			transform: {
				position: { x: 0, y: 0 },
				scale: 1.8,
			},
			motionTracking: {
				enabled: true,
				mode: "subject-single-v1",
				source: "baked-keyframes",
				animateScale: false,
				trackingStrength: 0.55,
				keyframes: [],
			},
			subjectSeed: {
				center: { x: 800, y: 260 },
				size: { width: 110, height: 170 },
				identity: "subject" as const,
			},
		};
		const movedSeedPreset = {
			...basePreset,
			subjectSeed: {
				...basePreset.subjectSeed,
				center: { x: 840, y: 260 },
			},
		};

		const baseSignature = buildMotionTrackingPresetSignature({
			preset: basePreset,
		});
		const movedSignature = buildMotionTrackingPresetSignature({
			preset: movedSeedPreset,
		});

		expect(baseSignature).toContain("mt-v7");
		expect(baseSignature).not.toBe(movedSignature);
	});
});
