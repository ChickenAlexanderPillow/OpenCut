import { describe, expect, test } from "bun:test";
import {
	buildAutoReframePresetsFromDetections,
	buildMotionTrackingObservationsFromSampledFrames,
	choosePrimarySubjectBox,
	filterCandidatesByIdentityCluster,
	getFaceLandmarkTrackingAnchor,
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

	test("does not fall back to the opposite identity cluster when the requested side has no match", () => {
		const filtered = filterCandidatesByIdentityCluster({
			candidates: [
				{
					centerX: 1240,
					centerY: 332,
					width: 210,
					height: 320,
					anchorX: 1240,
					anchorY: 252,
					fitWidth: 140,
					fitHeight: 210,
				},
			],
			clusters: [
				[
					{
						centerX: 760,
						centerY: 330,
						width: 210,
						height: 320,
						anchorX: 760,
						anchorY: 250,
						fitWidth: 140,
						fitHeight: 210,
					},
				],
				[
					{
						centerX: 1160,
						centerY: 332,
						width: 210,
						height: 320,
						anchorX: 1160,
						anchorY: 252,
						fitWidth: 140,
						fitHeight: 210,
					},
				],
			],
			targetIdentity: "left",
		});

		expect(filtered).toEqual([]);
	});

	test("drops stale tracked state after a miss so pose fallback can resume on the next frame", () => {
		const observations = buildMotionTrackingObservationsFromSampledFrames({
			sampledFrames: [
				{
					time: 0,
					faceCandidates: [
						{
							centerX: 960,
							centerY: 320,
							width: 180,
							height: 280,
							anchorX: 960,
							anchorY: 250,
							fitWidth: 120,
							fitHeight: 180,
						},
					],
					poseCandidates: [],
				},
				{
					time: 0.2,
					faceCandidates: [],
					poseCandidates: [],
				},
				{
					time: 0.4,
					faceCandidates: [],
					poseCandidates: [
						{
							centerX: 990,
							centerY: 330,
							width: 190,
							height: 300,
							anchorX: 990,
							anchorY: 255,
							fitWidth: 125,
							fitHeight: 190,
						},
					],
				},
			],
			identityDetections: [],
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetCenterHint: { x: 960, y: 540 },
		});

		expect(observations[0]?.box?.centerX).toBe(960);
		expect(observations[1]?.box).toBeNull();
		expect(observations[2]?.box?.centerX).toBe(990);
	});

	test("tracks a single centered face instead of averaging multiple visible faces", () => {
		const observations = buildMotionTrackingObservationsFromSampledFrames({
			sampledFrames: [
				{
					time: 0,
					faceCandidates: [
						{
							centerX: 400,
							centerY: 300,
							width: 150,
							height: 200,
							anchorX: 400,
							anchorY: 260,
							fitWidth: 110,
							fitHeight: 170,
							trackingAnchorX: 404,
							trackingAnchorY: 220,
						},
						{
							centerX: 900,
							centerY: 320,
							width: 150,
							height: 200,
							anchorX: 900,
							anchorY: 280,
							fitWidth: 110,
							fitHeight: 170,
							trackingAnchorX: 904,
							trackingAnchorY: 240,
						},
					],
					poseCandidates: [],
				},
			],
			identityDetections: [],
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetCenterHint: { x: 960, y: 540 },
			targetSubjectHint: "center",
		});

		expect(observations).toHaveLength(1);
		expect(observations[0]?.box?.centerX).toBe(900);
		expect(observations[0]?.box?.trackingAnchorX).toBe(904);
		expect(observations[0]?.box?.centerX).not.toBe(650);
	});

	test("falls back to a head anchor when the landmark eye midpoint is unavailable", () => {
		const landmarks = Array.from({ length: 478 }, () => ({
			x: Number.NaN,
			y: Number.NaN,
		}));
		landmarks[10] = { x: 0.25, y: 0.2 };
		landmarks[152] = { x: 0.45, y: 0.6 };
		landmarks[468] = { x: 0.32, y: 0.36 };
		landmarks[469] = { x: 0.33, y: 0.36 };
		landmarks[470] = { x: 0.33, y: 0.37 };
		landmarks[471] = { x: 0.32, y: 0.37 };
		landmarks[472] = { x: Number.NaN, y: Number.NaN };
		landmarks[473] = { x: Number.NaN, y: Number.NaN };
		landmarks[474] = { x: Number.NaN, y: Number.NaN };
		landmarks[475] = { x: Number.NaN, y: Number.NaN };
		landmarks[476] = { x: Number.NaN, y: Number.NaN };
		landmarks[477] = { x: Number.NaN, y: Number.NaN };

		const trackingAnchor = getFaceLandmarkTrackingAnchor({
			landmarks,
			sourceWidth: 1000,
			sourceHeight: 500,
		});

		expect(trackingAnchor).toEqual({
			x: 350,
			y: 184,
			kind: "head",
		});
	});

	test("keeps targeted tracking locked to face candidates instead of falling back to pose", () => {
		const observations = buildMotionTrackingObservationsFromSampledFrames({
			sampledFrames: [
				{
					time: 0,
					faceCandidates: [
						{
							centerX: 1160,
							centerY: 332,
							width: 210,
							height: 320,
							anchorX: 1160,
							anchorY: 252,
							fitWidth: 140,
							fitHeight: 210,
						},
					],
					poseCandidates: [],
				},
				{
					time: 0.2,
					faceCandidates: [],
					poseCandidates: [
						{
							centerX: 980,
							centerY: 360,
							width: 260,
							height: 420,
							anchorX: 980,
							anchorY: 280,
							fitWidth: 170,
							fitHeight: 250,
						},
					],
				},
			],
			identityDetections: [
				{
					centerX: 760,
					centerY: 330,
					width: 210,
					height: 320,
					anchorX: 760,
					anchorY: 250,
					fitWidth: 140,
					fitHeight: 210,
				},
				{
					centerX: 1160,
					centerY: 332,
					width: 210,
					height: 320,
					anchorX: 1160,
					anchorY: 252,
					fitWidth: 140,
					fitHeight: 210,
				},
			],
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetCenterHint: { x: 1060, y: 540 },
			targetSubjectHint: "right",
			targetSubjectSeed: {
				center: { x: 1160, y: 252 },
				size: { width: 140, height: 210 },
				identity: "right",
			},
		});

		expect(observations[0]?.box?.centerX).toBe(1160);
		expect(observations[1]?.box).toBeNull();
	});

	test("uses a continuity-safe pose head fallback during a brief face miss", () => {
		const observations = buildMotionTrackingObservationsFromSampledFrames({
			sampledFrames: [
				{
					time: 0,
					faceCandidates: [
						{
							centerX: 1160,
							centerY: 332,
							width: 210,
							height: 320,
							anchorX: 1160,
							anchorY: 252,
							fitWidth: 140,
							fitHeight: 210,
							trackingAnchorX: 1160,
							trackingAnchorY: 252,
							trackingAnchorKind: "eye",
						},
					],
					poseCandidates: [],
				},
				{
					time: 0.2,
					faceCandidates: [],
					poseCandidates: [
						{
							centerX: 1180,
							centerY: 430,
							width: 260,
							height: 420,
							anchorX: 1168,
							anchorY: 262,
							fitWidth: 170,
							fitHeight: 250,
							trackingAnchorX: 1168,
							trackingAnchorY: 262,
							trackingAnchorKind: "head",
						},
					],
				},
			],
			identityDetections: [],
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetCenterHint: { x: 1060, y: 540 },
			targetSubjectHint: "right",
			targetSubjectSeed: {
				center: { x: 1160, y: 252 },
				size: { width: 140, height: 210 },
				identity: "right",
			},
		});

		expect(observations[1]?.box).toBeTruthy();
		expect(observations[1]?.box?.trackingAnchorKind).toBe("head");
		expect(observations[1]?.box?.trackingAnchorX).toBe(1168);
		expect(observations[1]?.box?.fitWidth).toBe(140);
		expect(observations[1]?.box?.fitHeight).toBe(210);
	});

	test("prefers pose head fallback over a coarse face box without an explicit anchor", () => {
		const observations = buildMotionTrackingObservationsFromSampledFrames({
			sampledFrames: [
				{
					time: 0,
					faceCandidates: [
						{
							centerX: 1160,
							centerY: 332,
							width: 210,
							height: 320,
							anchorX: 1160,
							anchorY: 252,
							fitWidth: 140,
							fitHeight: 210,
							trackingAnchorX: 1160,
							trackingAnchorY: 252,
							trackingAnchorKind: "eye",
						},
					],
					poseCandidates: [],
				},
				{
					time: 0.2,
					faceCandidates: [
						{
							centerX: 1188,
							centerY: 320,
							width: 168,
							height: 240,
							anchorX: 1188,
							anchorY: 282,
							fitWidth: 130,
							fitHeight: 190,
						},
					],
					poseCandidates: [
						{
							centerX: 1180,
							centerY: 430,
							width: 260,
							height: 420,
							anchorX: 1168,
							anchorY: 262,
							fitWidth: 170,
							fitHeight: 250,
							trackingAnchorX: 1168,
							trackingAnchorY: 262,
							trackingAnchorKind: "head",
						},
					],
				},
			],
			identityDetections: [],
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetCenterHint: { x: 1060, y: 540 },
			targetSubjectHint: "right",
			targetSubjectSeed: {
				center: { x: 1160, y: 252 },
				size: { width: 140, height: 210 },
				identity: "right",
			},
		});

		expect(observations[1]?.box?.trackingAnchorKind).toBe("head");
		expect(observations[1]?.box?.trackingAnchorX).toBe(1168);
		expect(observations[1]?.box?.fitWidth).toBe(140);
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

		const containScale = Math.min(1080 / 1920, 1920 / 1080);
		const leftScale = subjectLeft!.transform.scale;
		const leftViewportCenterX =
			1920 / 2 -
			subjectLeft!.transform.position.x / (containScale * leftScale);
		expect(Math.abs(leftViewportCenterX - 530)).toBeLessThan(8);

		const rightDetection = { centerX: 1185, width: 190 };
		const rightScale = subjectRight!.transform.scale;
		const viewportCenterX =
			1920 / 2 -
			subjectRight!.transform.position.x / (containScale * rightScale);
		const visibleHalfWidth = 1080 / (2 * containScale * rightScale);
		const viewportRight = viewportCenterX + visibleHalfWidth;
		const subjectRightEdge = rightDetection.centerX + rightDetection.width / 2;
		expect(subjectRightEdge).toBeLessThan(viewportRight - 10);
		expect(Math.abs(viewportCenterX - 1172.5)).toBeLessThan(8);
		expect(result.defaultPresetId).toBe(subjectLeft!.id);
		expect(result.switches).toEqual([]);
	});

	test("builds side presets from representative subject clusters instead of the first visible side observation", () => {
		const result = buildAutoReframePresetsFromDetections({
			detections: [
				{ centerX: 320, centerY: 300, width: 180, height: 320 },
				{ centerX: 340, centerY: 304, width: 182, height: 324 },
				{ centerX: 1180, centerY: 308, width: 184, height: 322 },
				{ centerX: 1200, centerY: 312, width: 186, height: 326 },
			],
			observations: [
				{
					time: 0,
					boxes: [{ centerX: 960, centerY: 300, width: 180, height: 320 }],
				},
				{
					time: 1.2,
					boxes: [
						{ centerX: 330, centerY: 304, width: 182, height: 324 },
						{ centerX: 1190, centerY: 312, width: 186, height: 326 },
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

		const containScale = Math.min(1080 / 1920, 1920 / 1080);
		const leftViewportCenterX =
			1920 / 2 -
			subjectLeft!.transform.position.x /
				(containScale * subjectLeft!.transform.scale);
		const rightViewportCenterX =
			1920 / 2 -
			subjectRight!.transform.position.x /
				(containScale * subjectRight!.transform.scale);

		expect(Math.abs(leftViewportCenterX - 330)).toBeLessThan(8);
		expect(Math.abs(rightViewportCenterX - 1190)).toBeLessThan(8);
		expect(Math.abs(leftViewportCenterX - 960)).toBeGreaterThan(500);
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
