import { describe, expect, test } from "bun:test";
import {
	buildAutoReframePresetsFromDetections,
	choosePrimarySubjectBox,
	getVideoElementSourceRange,
} from "../subject-aware";

describe("subject-aware reframe preset generation", () => {
	test("prefers the requested side when selecting an initial tracked subject", () => {
		const leftCandidate = {
			centerX: 520,
			centerY: 320,
			width: 170,
			height: 280,
			fitWidth: 120,
			fitHeight: 180,
		};
		const rightCandidate = {
			centerX: 1360,
			centerY: 320,
			width: 170,
			height: 280,
			fitWidth: 120,
			fitHeight: 180,
		};

		const leftSelection = choosePrimarySubjectBox({
			candidates: [leftCandidate, rightCandidate],
			previousBox: null,
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetCenterHint: { x: 960, y: 540 },
			targetSubjectHint: "left",
		});
		const rightSelection = choosePrimarySubjectBox({
			candidates: [leftCandidate, rightCandidate],
			previousBox: null,
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetCenterHint: { x: 960, y: 540 },
			targetSubjectHint: "right",
		});

		expect(leftSelection?.centerX).toBe(leftCandidate.centerX);
		expect(rightSelection?.centerX).toBe(rightCandidate.centerX);
	});

	test("prefers candidates inside the preset source window for initial tracking", () => {
		const leftCandidate = {
			centerX: 560,
			centerY: 320,
			width: 170,
			height: 280,
			fitWidth: 120,
			fitHeight: 180,
		};
		const rightCandidate = {
			centerX: 1360,
			centerY: 320,
			width: 170,
			height: 280,
			fitWidth: 120,
			fitHeight: 180,
		};

		const selection = choosePrimarySubjectBox({
			candidates: [leftCandidate, rightCandidate],
			previousBox: null,
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetCenterHint: { x: 960, y: 540 },
			targetSubjectHint: "right",
			targetViewportBounds: {
				left: 1100,
				right: 1700,
				top: 120,
				bottom: 760,
			},
		});

		expect(selection?.centerX).toBe(rightCandidate.centerX);
	});

	test("uses the auto-detected subject seed to keep subject right on the right person", () => {
		const leftCandidate = {
			centerX: 760,
			centerY: 330,
			width: 210,
			height: 320,
			anchorX: 760,
			anchorY: 250,
			fitWidth: 140,
			fitHeight: 210,
		};
		const rightCandidate = {
			centerX: 1160,
			centerY: 332,
			width: 210,
			height: 320,
			anchorX: 1160,
			anchorY: 252,
			fitWidth: 140,
			fitHeight: 210,
		};

		const selection = choosePrimarySubjectBox({
			candidates: [leftCandidate, rightCandidate],
			previousBox: null,
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetCenterHint: { x: 1060, y: 540 },
			targetSubjectHint: "right",
			targetViewportBounds: {
				left: 760,
				right: 1360,
				top: 80,
				bottom: 860,
			},
			targetSubjectSeed: {
				center: { x: 1160, y: 252 },
				size: { width: 140, height: 210 },
				identity: "right",
			},
		});

		expect(selection?.centerX).toBe(rightCandidate.centerX);
	});

	test("builds a right-biased preset when detections span across the frame", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 520, centerY: 300, width: 180, height: 320 },
				{ centerX: 540, centerY: 302, width: 176, height: 316 },
				{ centerX: 1160, centerY: 305, width: 185, height: 325 },
				{ centerX: 1185, centerY: 310, width: 190, height: 330 },
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		const subjectLeft = result.presets.find(
			(preset) => preset.name === "Subject Left",
		);
		const subjectRight = result.presets.find(
			(preset) => preset.name === "Subject Right",
		);

		expect(subjectLeft).toBeDefined();
		expect(subjectRight).toBeDefined();
		expect(result.presets.map((preset) => preset.name)).toEqual([
			"Subject Left",
			"Subject Right",
		]);
		expect(subjectLeft!.transform.position.x).toBeGreaterThan(0);
		expect(subjectRight!.transform.position.x).toBeLessThan(0);
		expect(subjectLeft!.transform.position.x - subjectRight!.transform.position.x).toBeGreaterThan(800);

		const rightDetection = { centerX: 1185, width: 190 };
		const containScale = Math.min(1080 / 1920, 1920 / 1080);
		const rightScale = subjectRight!.transform.scale;
		const viewportCenterX =
			1920 / 2 -
			subjectRight!.transform.position.x / (containScale * rightScale);
		const visibleHalfWidth = 1080 / (2 * containScale * rightScale);
		const viewportRight = viewportCenterX + visibleHalfWidth;
		const subjectRightEdge = rightDetection.centerX + rightDetection.width / 2;
		expect(subjectRightEdge).toBeLessThan(viewportRight - 10);
		expect(result.defaultPresetId).toBe(subjectLeft!.id);
		expect(result.switches).toEqual([]);
	});

	test("keeps two subjects identifiable even when one side has fewer observations", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 460, centerY: 300, width: 170, height: 300 },
				{ centerX: 480, centerY: 302, width: 172, height: 302 },
				{ centerX: 500, centerY: 299, width: 169, height: 301 },
				{ centerX: 520, centerY: 304, width: 171, height: 303 },
				{ centerX: 1180, centerY: 308, width: 182, height: 320 },
				{ centerX: 1205, centerY: 311, width: 184, height: 322 },
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		const subjectLeft = result.presets.find(
			(preset) => preset.name === "Subject Left",
		);
		const subjectRight = result.presets.find(
			(preset) => preset.name === "Subject Right",
		);

		expect(result.subjectClusterCount).toBeGreaterThanOrEqual(2);
		expect(subjectLeft).toBeDefined();
		expect(subjectRight).toBeDefined();
		expect(subjectLeft!.transform.position.x).toBeGreaterThan(800);
		expect(subjectRight!.transform.position.x).toBeLessThan(-500);
		expect(subjectLeft!.transform.position.x - subjectRight!.transform.position.x).toBeGreaterThan(1300);
	});

	test("starts on the opening subject side and switches to subject left once two subjects appear", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 930, centerY: 300, width: 170, height: 300 },
				{ centerX: 950, centerY: 302, width: 172, height: 302 },
				{ centerX: 520, centerY: 299, width: 169, height: 301 },
				{ centerX: 1180, centerY: 308, width: 182, height: 320 },
				{ centerX: 540, centerY: 304, width: 171, height: 303 },
				{ centerX: 1205, centerY: 311, width: 184, height: 322 },
			],
			observations: [
				{
					time: 0,
					boxes: [{ centerX: 940, centerY: 302, width: 172, height: 302 }],
				},
				{
					time: 2.4,
					boxes: [
						{ centerX: 530, centerY: 304, width: 171, height: 303 },
						{ centerX: 1195, centerY: 311, width: 184, height: 322 },
					],
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		const subjectRight = result.presets.find(
			(preset) => preset.name === "Subject Right",
		);
		const subjectLeft = result.presets.find(
			(preset) => preset.name === "Subject Left",
		);

		expect(subjectRight).toBeDefined();
		expect(subjectLeft).toBeDefined();
		expect(result.defaultPresetId).toBe(subjectRight!.id);
		expect(result.switches).toHaveLength(1);
		expect(result.switches[0]?.time).toBe(2.4);
		expect(result.switches[0]?.presetId).toBe(subjectLeft!.id);
	});

	test("preserves a short opening right-subject section before a two-subject section", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 944, centerY: 302, width: 172, height: 302 },
				{ centerX: 528, centerY: 304, width: 171, height: 303 },
				{ centerX: 1195, centerY: 311, width: 184, height: 322 },
			],
			observations: [
				{
					time: 0,
					boxes: [{ centerX: 944, centerY: 302, width: 172, height: 302 }],
				},
				{
					time: 0.12,
					boxes: [
						{ centerX: 528, centerY: 304, width: 171, height: 303 },
						{ centerX: 1195, centerY: 311, width: 184, height: 322 },
					],
				},
				{
					time: 0.34,
					boxes: [
						{ centerX: 532, centerY: 305, width: 170, height: 301 },
						{ centerX: 1188, centerY: 309, width: 182, height: 320 },
					],
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		const subjectRight = result.presets.find(
			(preset) => preset.name === "Subject Right",
		);
		const subjectLeft = result.presets.find(
			(preset) => preset.name === "Subject Left",
		);

		expect(subjectRight).toBeDefined();
		expect(subjectLeft).toBeDefined();
		expect(result.defaultPresetId).toBe(subjectRight!.id);
		expect(result.switches).toHaveLength(1);
		expect(result.switches[0]?.time).toBe(0.12);
		expect(result.switches[0]?.presetId).toBe(subjectLeft!.id);
	});

	test("auto-seeds sustained sections across changing subject layouts", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 930, centerY: 300, width: 170, height: 300 },
				{ centerX: 950, centerY: 302, width: 172, height: 302 },
				{ centerX: 520, centerY: 299, width: 169, height: 301 },
				{ centerX: 1180, centerY: 308, width: 182, height: 320 },
				{ centerX: 540, centerY: 304, width: 171, height: 303 },
				{ centerX: 1205, centerY: 311, width: 184, height: 322 },
				{ centerX: 1170, centerY: 300, width: 178, height: 310 },
				{ centerX: 1195, centerY: 304, width: 180, height: 315 },
			],
			observations: [
				{
					time: 0,
					boxes: [{ centerX: 940, centerY: 302, width: 172, height: 302 }],
				},
				{
					time: 0.4,
					boxes: [{ centerX: 946, centerY: 301, width: 170, height: 300 }],
				},
				{
					time: 1.2,
					boxes: [
						{ centerX: 530, centerY: 304, width: 171, height: 303 },
						{ centerX: 1195, centerY: 311, width: 184, height: 322 },
					],
				},
				{
					time: 1.7,
					boxes: [
						{ centerX: 526, centerY: 300, width: 170, height: 300 },
						{ centerX: 1188, centerY: 308, width: 182, height: 320 },
					],
				},
				{
					time: 3.1,
					boxes: [{ centerX: 1184, centerY: 302, width: 180, height: 315 }],
				},
				{
					time: 3.6,
					boxes: [{ centerX: 1178, centerY: 300, width: 178, height: 310 }],
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		const subjectRight = result.presets.find(
			(preset) => preset.name === "Subject Right",
		);
		const subjectLeft = result.presets.find(
			(preset) => preset.name === "Subject Left",
		);

		expect(subjectRight).toBeDefined();
		expect(subjectLeft).toBeDefined();
		expect(result.defaultPresetId).toBe(subjectRight!.id);
		expect(result.switches).toHaveLength(2);
		expect(result.switches[0]?.time).toBe(1.2);
		expect(result.switches[0]?.presetId).toBe(subjectLeft!.id);
		expect(result.switches[1]?.time).toBe(3.1);
		expect(result.switches[1]?.presetId).toBe(subjectRight!.id);
	});

	test("derives the analyzed source window from clip trim data", () => {
		expect(
			getVideoElementSourceRange({
				element: {
					trimStart: 12,
					trimEnd: 18,
					duration: 30,
				},
				asset: {
					duration: 60,
				},
			}),
		).toEqual({
			startTime: 12,
			endTime: 42,
		});
	});
});
