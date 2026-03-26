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

	test("centers wide subject tracking on the combined visible subjects", () => {
		const selection = choosePrimarySubjectBox({
			candidates: [
				{
					centerX: 560,
					centerY: 320,
					width: 180,
					height: 280,
					anchorX: 560,
					anchorY: 250,
					fitWidth: 120,
					fitHeight: 180,
				},
				{
					centerX: 1360,
					centerY: 340,
					width: 200,
					height: 300,
					anchorX: 1360,
					anchorY: 265,
					fitWidth: 132,
					fitHeight: 196,
				},
			],
			previousBox: null,
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetCenterHint: { x: 960, y: 540 },
			targetSubjectHint: "center",
			targetViewportBounds: {
				left: 420,
				right: 1500,
				top: 120,
				bottom: 860,
			},
		});

		expect(selection?.centerX).toBe(960);
		expect(selection?.centerY).toBe(330);
		expect(selection?.anchorX).toBe(960);
		expect(selection?.anchorY).toBe(257.5);
		expect(selection?.fitWidth).toBe(126);
		expect(selection?.fitHeight).toBe(188);
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

	test("builds left subject seed from stable observations instead of the first noisy match", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 260, centerY: 320, width: 210, height: 320 },
				{ centerX: 780, centerY: 322, width: 205, height: 315 },
				{ centerX: 790, centerY: 321, width: 204, height: 314 },
				{ centerX: 1320, centerY: 324, width: 208, height: 318 },
				{ centerX: 1332, centerY: 323, width: 206, height: 316 },
			],
			observations: [
				{
					time: 0,
					boxes: [
						{ centerX: 260, centerY: 320, width: 210, height: 320 },
						{ centerX: 1320, centerY: 324, width: 208, height: 318 },
					],
				},
				{
					time: 0.8,
					boxes: [
						{ centerX: 780, centerY: 322, width: 205, height: 315 },
						{ centerX: 1332, centerY: 323, width: 206, height: 316 },
					],
				},
				{
					time: 1.6,
					boxes: [
						{ centerX: 790, centerY: 321, width: 204, height: 314 },
						{ centerX: 1326, centerY: 322, width: 207, height: 317 },
					],
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		const subjectLeft = result.presets.find(
			(preset) => preset.name === "Subject Left",
		);

		expect(subjectLeft).toBeDefined();
		expect(subjectLeft?.subjectSeed?.center.x ?? 0).toBeGreaterThan(650);
		expect(subjectLeft?.subjectSeed?.center.x ?? 0).toBeLessThan(900);
	});

	test("keeps subject left on the leftmost person when a center distractor appears", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 360, centerY: 320, width: 180, height: 300 },
				{ centerX: 930, centerY: 330, width: 420, height: 420 },
				{ centerX: 1450, centerY: 322, width: 188, height: 308 },
				{ centerX: 372, centerY: 322, width: 182, height: 302 },
				{ centerX: 918, centerY: 331, width: 410, height: 418 },
				{ centerX: 1440, centerY: 324, width: 186, height: 306 },
			],
			observations: [
				{
					time: 0,
					boxes: [
						{ centerX: 360, centerY: 320, width: 180, height: 300 },
						{ centerX: 930, centerY: 330, width: 420, height: 420 },
						{ centerX: 1450, centerY: 322, width: 188, height: 308 },
					],
				},
				{
					time: 0.9,
					boxes: [
						{ centerX: 372, centerY: 322, width: 182, height: 302 },
						{ centerX: 918, centerY: 331, width: 410, height: 418 },
						{ centerX: 1440, centerY: 324, width: 186, height: 306 },
					],
				},
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
		expect(subjectLeft!.subjectSeed?.center.x ?? 0).toBeLessThan(500);
		expect(subjectRight!.subjectSeed?.center.x ?? 0).toBeGreaterThan(1300);
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

	test("anchors single-subject framing horizontally to the face center", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{
					centerX: 1040,
					centerY: 320,
					width: 260,
					height: 420,
					anchorX: 960,
					anchorY: 250,
					fitWidth: 180,
					fitHeight: 260,
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		const subject = result.presets.find((preset) => preset.name === "Subject");
		expect(subject).toBeDefined();

		const containScale = Math.min(1080 / 1920, 1920 / 1080);
		const viewportCenterX =
			1920 / 2 - subject!.transform.position.x / (containScale * subject!.transform.scale);

		expect(Math.abs(viewportCenterX - 960)).toBeLessThan(8);
		expect(Math.abs(viewportCenterX - 1040)).toBeGreaterThan(40);
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

	test("prefers dual-subject observations over collapsed aggregate detections when clustering subjects", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 900, centerY: 320, width: 760, height: 420 },
				{ centerX: 980, centerY: 322, width: 740, height: 410 },
				{ centerX: 940, centerY: 318, width: 750, height: 415 },
				{ centerX: 1020, centerY: 321, width: 730, height: 408 },
			],
			observations: [
				{
					time: 0,
					boxes: [
						{ centerX: 430, centerY: 320, width: 180, height: 300 },
						{ centerX: 1490, centerY: 318, width: 176, height: 296 },
					],
				},
				{
					time: 0.9,
					boxes: [
						{ centerX: 448, centerY: 322, width: 182, height: 302 },
						{ centerX: 1472, centerY: 320, width: 178, height: 298 },
					],
				},
				{
					time: 1.8,
					boxes: [
						{ centerX: 438, centerY: 321, width: 181, height: 301 },
						{ centerX: 1482, centerY: 319, width: 177, height: 297 },
					],
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		expect(result.subjectClusterCount).toBe(2);
		expect(result.presets.map((preset) => preset.name)).toEqual([
			"Subject Left",
			"Subject Right",
		]);
	});

	test("keeps two close visible subjects as separate groups", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 760, centerY: 320, width: 250, height: 360 },
				{ centerX: 1080, centerY: 320, width: 245, height: 355 },
				{ centerX: 772, centerY: 322, width: 248, height: 358 },
				{ centerX: 1068, centerY: 321, width: 242, height: 352 },
			],
			observations: [
				{
					time: 0,
					boxes: [
						{ centerX: 760, centerY: 320, width: 250, height: 360 },
						{ centerX: 1080, centerY: 320, width: 245, height: 355 },
					],
				},
				{
					time: 0.8,
					boxes: [
						{ centerX: 772, centerY: 322, width: 248, height: 358 },
						{ centerX: 1068, centerY: 321, width: 242, height: 352 },
					],
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		expect(result.subjectClusterCount).toBe(2);
		expect(result.presets.map((preset) => preset.name)).toEqual([
			"Subject Left",
			"Subject Right",
		]);
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
		const defaultPreset = result.presets.find(
			(preset) => preset.id === result.defaultPresetId,
		);

		expect(subjectRight).toBeDefined();
		expect(subjectLeft).toBeDefined();
		expect(defaultPreset?.subjectSeed?.identity).toBe("right");
		expect(result.switches).toHaveLength(1);
		expect(result.switches[0]?.time).toBe(0.12);
		expect(
			result.presets.find((preset) => preset.id === result.switches[0]?.presetId)
				?.subjectSeed?.identity,
		).toBe("left");
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
		const defaultPreset = result.presets.find(
			(preset) => preset.id === result.defaultPresetId,
		);

		expect(subjectRight).toBeDefined();
		expect(subjectLeft).toBeDefined();
		expect(defaultPreset?.subjectSeed?.identity).toBe("right");
		expect(result.switches).toHaveLength(2);
		expect(result.switches[0]?.time).toBe(1.2);
		expect(
			result.presets.find((preset) => preset.id === result.switches[0]?.presetId)
				?.subjectSeed?.identity,
		).toBe("left");
		expect(result.switches[1]?.time).toBe(3.1);
		expect(
			result.presets.find((preset) => preset.id === result.switches[1]?.presetId)
				?.subjectSeed?.identity,
		).toBe("right");
	});

	test("derives subject availability sections when the clip changes from two subjects to one and back", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 520, centerY: 299, width: 169, height: 301 },
				{ centerX: 1180, centerY: 308, width: 182, height: 320 },
				{ centerX: 540, centerY: 304, width: 171, height: 303 },
				{ centerX: 1205, centerY: 311, width: 184, height: 322 },
				{ centerX: 1184, centerY: 302, width: 180, height: 315 },
				{ centerX: 526, centerY: 300, width: 170, height: 300 },
				{ centerX: 1188, centerY: 308, width: 182, height: 320 },
			],
			observations: [
				{
					time: 0,
					boxes: [
						{ centerX: 530, centerY: 304, width: 171, height: 303 },
						{ centerX: 1195, centerY: 311, width: 184, height: 322 },
					],
				},
				{
					time: 1.4,
					boxes: [{ centerX: 1184, centerY: 302, width: 180, height: 315 }],
				},
				{
					time: 2.8,
					boxes: [
						{ centerX: 526, centerY: 300, width: 170, height: 300 },
						{ centerX: 1188, centerY: 308, width: 182, height: 320 },
					],
				},
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
		expect(result.availabilitySections).toEqual([
			{
				id: result.availabilitySections[0]?.id,
				startTime: 0,
				availablePresetIds: [subjectLeft!.id, subjectRight!.id],
			},
			{
				id: result.availabilitySections[1]?.id,
				startTime: 1.4,
				availablePresetIds: [subjectRight!.id],
			},
			{
				id: result.availabilitySections[2]?.id,
				startTime: 2.8,
				availablePresetIds: [subjectLeft!.id, subjectRight!.id],
			},
		]);
	});

	test("keeps one semantic preset per subject and stores major framing changes as auto segments", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 420, centerY: 300, width: 180, height: 300 },
				{ centerX: 1450, centerY: 305, width: 185, height: 310 },
				{ centerX: 418, centerY: 302, width: 182, height: 304 },
				{ centerX: 1448, centerY: 307, width: 184, height: 312 },
				{ centerX: 900, centerY: 260, width: 250, height: 380 },
				{ centerX: 1130, centerY: 270, width: 252, height: 386 },
				{ centerX: 912, centerY: 262, width: 248, height: 378 },
				{ centerX: 1122, centerY: 272, width: 254, height: 388 },
			],
			observations: [
				{
					time: 0,
					boxes: [
						{ centerX: 420, centerY: 300, width: 180, height: 300 },
						{ centerX: 1450, centerY: 305, width: 185, height: 310 },
					],
				},
				{
					time: 0.8,
					boxes: [
						{ centerX: 418, centerY: 302, width: 182, height: 304 },
						{ centerX: 1448, centerY: 307, width: 184, height: 312 },
					],
				},
				{
					time: 3.4,
					boxes: [
						{ centerX: 900, centerY: 260, width: 250, height: 380 },
						{ centerX: 1130, centerY: 270, width: 252, height: 386 },
					],
				},
				{
					time: 4.1,
					boxes: [
						{ centerX: 912, centerY: 262, width: 248, height: 378 },
						{ centerX: 1122, centerY: 272, width: 254, height: 388 },
					],
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		expect(result.presets.map((preset) => preset.name)).toEqual([
			"Subject Left",
			"Subject Right",
		]);
		expect(
			result.presets.find((preset) => preset.name === "Subject Left")
				?.autoSegments?.length,
		).toBe(2);
		expect(
			result.presets.find((preset) => preset.name === "Subject Right")
				?.autoSegments?.length,
		).toBe(2);
		expect(
			result.presets.find((preset) => preset.name === "Subject Left")
				?.autoSegments?.map((segment) => segment.startTime),
		).toEqual([0, 3.4]);
	});

	test("does not create new auto segments for moderate movement within the same shot", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 430, centerY: 300, width: 180, height: 300 },
				{ centerX: 1450, centerY: 305, width: 185, height: 310 },
				{ centerX: 510, centerY: 302, width: 182, height: 304 },
				{ centerX: 1375, centerY: 307, width: 184, height: 312 },
				{ centerX: 590, centerY: 304, width: 184, height: 306 },
				{ centerX: 1300, centerY: 309, width: 186, height: 314 },
			],
			observations: [
				{
					time: 0,
					boxes: [
						{ centerX: 430, centerY: 300, width: 180, height: 300 },
						{ centerX: 1450, centerY: 305, width: 185, height: 310 },
					],
				},
				{
					time: 1.2,
					boxes: [
						{ centerX: 510, centerY: 302, width: 182, height: 304 },
						{ centerX: 1375, centerY: 307, width: 184, height: 312 },
					],
				},
				{
					time: 2.4,
					boxes: [
						{ centerX: 590, centerY: 304, width: 184, height: 306 },
						{ centerX: 1300, centerY: 309, width: 186, height: 314 },
					],
				},
			],
			canvasSize: { width: 1080, height: 1920 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			baseScale: 1.8,
		});

		expect(
			result.presets.find((preset) => preset.name === "Subject Left")
				?.autoSegments?.length,
		).toBe(1);
		expect(
			result.presets.find((preset) => preset.name === "Subject Right")
				?.autoSegments?.length,
		).toBe(1);
	});

	test("switches stale active angles to the next available subject at availability boundaries", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 520, centerY: 299, width: 169, height: 301 },
				{ centerX: 1180, centerY: 308, width: 182, height: 320 },
				{ centerX: 540, centerY: 304, width: 171, height: 303 },
				{ centerX: 1205, centerY: 311, width: 184, height: 322 },
				{ centerX: 1184, centerY: 302, width: 180, height: 315 },
				{ centerX: 1178, centerY: 300, width: 178, height: 310 },
			],
			observations: [
				{
					time: 0,
					boxes: [
						{ centerX: 530, centerY: 304, width: 171, height: 303 },
						{ centerX: 1195, centerY: 311, width: 184, height: 322 },
					],
				},
				{
					time: 1.2,
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

		expect(subjectRight).toBeDefined();
		expect(result.switches[result.switches.length - 1]).toEqual({
			id: result.switches[result.switches.length - 1]?.id,
			time: 3.1,
			presetId: subjectRight!.id,
		});
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
