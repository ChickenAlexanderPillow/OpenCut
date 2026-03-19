import { describe, expect, test } from "bun:test";
import {
	applyVideoReframeTransformAdjustment,
	applyPresetToVideoAngleSection,
	applySplitScreenToVideoAngleSection,
	applySelectedReframePresetPreviewToTracks,
	buildDefaultVideoSplitScreenBindings,
	buildTransformForSourceCenter,
	deriveVideoReframeTransformAdjustment,
	deriveVideoReframeTransformFromSplitSlotTransform,
	deriveVideoAngleSections,
	deriveVideoSplitScreenSlotAdjustmentFromTransform,
	getSourceCenterForTransform,
	deriveVideoSplitScreenSectionRanges,
	getVideoSplitScreenDividers,
	getVideoSplitScreenViewports,
	getActiveReframePresetId,
	getVideoAngleSectionAtTime,
	getVideoSplitScreenSectionAtTime,
	remapSplitSlotTransformBetweenViewportBalances,
	remapSplitSlotTransformBetweenViewports,
	replaceOrInsertReframeSwitch,
	resolveVideoSplitScreenAtTime,
	resolveVideoSplitScreenAtTimeFromState,
	resolveVideoSplitScreenSlotTransform,
	resolveVideoSplitScreenSlotTransformFromState,
	resolveVideoBaseTransformAtTime,
	resolveVideoReframeTransform,
	resolveVideoReframeTransformFromState,
} from "../video-reframe";
import { resolveMotionTrackedReframeTransform } from "../motion-tracking";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

const baseElement: VideoElement = {
	id: "video-1",
	type: "video",
	mediaId: "media-1",
	name: "Clip",
	startTime: 0,
	duration: 10,
	trimStart: 0,
	trimEnd: 0,
	muted: false,
	hidden: false,
	transform: {
		position: { x: 0, y: 0 },
		scale: 1.8,
		rotate: 12,
	},
	opacity: 1,
	reframePresets: [
		{
			id: "wide",
			name: "Wide",
			transform: {
				position: { x: 0, y: 0 },
				scale: 1.8,
			},
		},
		{
			id: "subject",
			name: "Subject",
			transform: {
				position: { x: 120, y: -40 },
				scale: 2.5,
			},
		},
	],
	reframeSwitches: [
		{
			id: "switch-1",
			time: 4,
			presetId: "subject",
		},
	],
	defaultReframePresetId: "wide",
};

describe("video reframe resolution", () => {
test("uses the default preset before the first switch", () => {
		expect(
			getActiveReframePresetId({
				element: baseElement,
				localTime: 2,
			}),
	).toBe("wide");
});

	test("remaps legacy generic subject sections to subject left when side presets exist", () => {
		const element: VideoElement = {
			...baseElement,
			reframePresets: [
				baseElement.reframePresets![0]!,
				baseElement.reframePresets![1]!,
				{
					id: "subject-left",
					name: "Subject Left",
					transform: {
						position: { x: -140, y: -20 },
						scale: 2.4,
					},
				},
				{
					id: "subject-right",
					name: "Subject Right",
					transform: {
						position: { x: 140, y: -20 },
						scale: 2.4,
					},
				},
			],
			defaultReframePresetId: "subject",
			reframeSwitches: [
				{
					id: "switch-1",
					time: 4,
					presetId: "subject",
				},
			],
		};

		expect(
			getActiveReframePresetId({
				element,
				localTime: 2,
			}),
		).toBe("subject-left");
		expect(
			getActiveReframePresetId({
				element,
				localTime: 5,
			}),
		).toBe("subject-left");
	});

	test("uses switched preset after the marker and preserves base rotation", () => {
		const transform = resolveVideoBaseTransformAtTime({
			element: baseElement,
			localTime: 5,
		});
		expect(transform.position.x).toBe(120);
		expect(transform.position.y).toBe(-40);
		expect(transform.scale).toBe(2.5);
		expect(transform.rotate).toBe(12);
	});

	test("applies baked motion tracking only while the tracked angle is active", () => {
		const trackedElement: VideoElement = {
			...baseElement,
			reframePresets: [
				{
					...baseElement.reframePresets![0]!,
					motionTracking: {
						enabled: true,
						mode: "subject-single-v1",
						source: "baked-keyframes",
						animateScale: true,
						keyframes: [
							{
								id: "mt-1",
								time: 0,
								position: { x: 0, y: 0 },
								scale: 1.8,
							},
							{
								id: "mt-2",
								time: 3,
								position: { x: 80, y: -24 },
								scale: 2.1,
							},
						],
					},
				},
				baseElement.reframePresets![1]!,
			],
		};

		const trackedWideTransform = resolveVideoBaseTransformAtTime({
			element: trackedElement,
			localTime: 2,
		});
		expect(trackedWideTransform.position.x).toBeCloseTo(53.3333333333, 6);
		expect(trackedWideTransform.position.y).toBeCloseTo(-16, 6);
		expect(trackedWideTransform.scale).toBeCloseTo(2, 6);
		expect(trackedWideTransform.rotate).toBe(12);

		const trackedSubjectTransform = resolveVideoBaseTransformAtTime({
			element: trackedElement,
			localTime: 5,
		});
		expect(trackedSubjectTransform.position.x).toBe(120);
		expect(trackedSubjectTransform.position.y).toBe(-40);
		expect(trackedSubjectTransform.scale).toBe(2.5);
		expect(trackedSubjectTransform.rotate).toBe(12);
	});

	test("applies preset manual adjustments on top of tracked framing", () => {
		const trackedElement: VideoElement = {
			...baseElement,
			reframePresets: [
				{
					...baseElement.reframePresets![0]!,
					transformAdjustment: {
						positionOffset: { x: 24, y: -12 },
						scaleMultiplier: 1.1,
					},
					motionTracking: {
						enabled: true,
						mode: "subject-single-v1",
						source: "baked-keyframes",
						animateScale: true,
						keyframes: [
							{
								id: "mt-1",
								time: 0,
								position: { x: 0, y: 0 },
								scale: 1.8,
							},
							{
								id: "mt-2",
								time: 3,
								position: { x: 80, y: -24 },
								scale: 2.1,
							},
						],
					},
				},
				baseElement.reframePresets![1]!,
			],
		};

		const transform = resolveVideoBaseTransformAtTime({
			element: trackedElement,
			localTime: 2,
		});
		expect(transform.position.x).toBeCloseTo(77.3333333333, 6);
		expect(transform.position.y).toBeCloseTo(-28, 6);
		expect(transform.scale).toBeCloseTo(2.2, 6);
		expect(transform.rotate).toBe(12);
	});

	test("preset manual scale keeps the framing center fixed", () => {
		const trackedPreset = {
			...baseElement.reframePresets![1]!,
			motionTracking: {
				enabled: true,
				mode: "subject-single-v1" as const,
				source: "baked-keyframes" as const,
				animateScale: true,
				keyframes: [
					{
						id: "mt-1",
						time: 0,
						position: { x: 120, y: -40 },
						scale: 2.5,
					},
				],
			},
		};
		const trackedTransform = resolveMotionTrackedReframeTransform({
			baseTransform: trackedPreset.transform,
			motionTracking: trackedPreset.motionTracking,
			localTime: 5,
		});
		const containScale = Math.min(1080 / 1920, 1920 / 1080);
		const sourceCenter = getSourceCenterForTransform({
			transform: trackedTransform,
			baseScale: containScale,
			sourceWidth: 1920,
			sourceHeight: 1080,
		});
		const scaledTransform = buildTransformForSourceCenter({
			sourceCenter,
			scale: trackedTransform.scale * 1.25,
			baseScale: containScale,
			sourceWidth: 1920,
			sourceHeight: 1080,
			rotate: 12,
		});
		const adjustment = deriveVideoReframeTransformAdjustment({
			baseTransform: trackedTransform,
			finalTransform: scaledTransform,
		});
		const adjustedTransform = applyVideoReframeTransformAdjustment({
			transform: trackedTransform,
			adjustment,
		});

		expect(adjustedTransform.position.x).toBeCloseTo(scaledTransform.position.x, 6);
		expect(adjustedTransform.position.y).toBeCloseTo(scaledTransform.position.y, 6);
		expect(adjustedTransform.scale).toBeCloseTo(scaledTransform.scale, 6);

		const resolved = resolveVideoReframeTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: [
				baseElement.reframePresets![0]!,
				{
					...trackedPreset,
					transformAdjustment: adjustment,
				},
			],
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
		});
		const resolvedCenter = getSourceCenterForTransform({
			transform: resolved,
			baseScale: containScale,
			sourceWidth: 1920,
			sourceHeight: 1080,
		});

		expect(resolvedCenter.x).toBeCloseTo(sourceCenter.x, 6);
		expect(resolvedCenter.y).toBeCloseTo(sourceCenter.y, 6);
		expect(resolved.scale).toBeCloseTo(scaledTransform.scale, 6);
	});

	test("replaces a switch when inserting at the same timestamp", () => {
		const switches = replaceOrInsertReframeSwitch({
			switches: baseElement.reframeSwitches,
			nextSwitch: {
				id: "switch-2",
				time: 4,
				presetId: "wide",
			},
			duration: baseElement.duration,
		});

		expect(switches).toEqual([
			{
				id: "switch-2",
				time: 4,
				presetId: "wide",
			},
		]);
	});

	test("resolves from raw reframe state without a full video element", () => {
		const transform = resolveVideoReframeTransform({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: baseElement.reframePresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
		});

		expect(transform).toEqual({
			position: { x: 120, y: -40 },
			scale: 2.5,
			rotate: 12,
		});
	});

	test("fast state resolvers match normalized element resolvers", () => {
		expect(
			resolveVideoReframeTransformFromState({
				baseTransform: baseElement.transform,
				duration: baseElement.duration,
				reframePresets: baseElement.reframePresets,
				reframeSwitches: baseElement.reframeSwitches,
				defaultReframePresetId: baseElement.defaultReframePresetId,
				localTime: 5,
			}),
		).toEqual(
			resolveVideoReframeTransform({
				baseTransform: baseElement.transform,
				duration: baseElement.duration,
				reframePresets: baseElement.reframePresets,
				reframeSwitches: baseElement.reframeSwitches,
				defaultReframePresetId: baseElement.defaultReframePresetId,
				localTime: 5,
			}),
		);

		expect(
			resolveVideoSplitScreenSlotTransformFromState({
				baseTransform: baseElement.transform,
				duration: baseElement.duration,
				reframePresets: baseElement.reframePresets,
				reframeSwitches: baseElement.reframeSwitches,
				defaultReframePresetId: baseElement.defaultReframePresetId,
				localTime: 5,
				slot: {
					slotId: "bottom",
					presetId: "subject",
					transformOverride: {
						position: { x: 360, y: -120 },
						scale: 3.4,
					},
				},
			}),
		).toEqual(
			resolveVideoSplitScreenSlotTransform({
				baseTransform: baseElement.transform,
				duration: baseElement.duration,
				reframePresets: baseElement.reframePresets,
				reframeSwitches: baseElement.reframeSwitches,
				defaultReframePresetId: baseElement.defaultReframePresetId,
				localTime: 5,
				slot: {
					slotId: "bottom",
					presetId: "subject",
					transformOverride: {
						position: { x: 360, y: -120 },
						scale: 3.4,
					},
				},
			}),
		);

		const splitElement: VideoElement = {
			...baseElement,
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
					{ slotId: "bottom", mode: "follow-active", presetId: null },
				],
				sections: [],
			},
		};

		expect(
			resolveVideoSplitScreenAtTimeFromState({
				duration: splitElement.duration,
				splitScreen: splitElement.splitScreen,
				defaultReframePresetId: splitElement.defaultReframePresetId,
				reframeSwitches: splitElement.reframeSwitches,
				localTime: 5,
			}),
		).toEqual(
			resolveVideoSplitScreenAtTime({
				element: splitElement,
				localTime: 5,
			}),
		);
	});

	test("preview override renders the selected preset without mutating base timeline intent", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "track-1",
				type: "video",
				name: "Video",
				isMain: false,
				muted: false,
				hidden: false,
				volume: 1,
				audioEffects: {
					eq: {
						enabled: false,
						lowGainDb: 0,
						midGainDb: 0,
						highGainDb: 0,
						midFrequency: 1200,
						highFrequency: 4800,
					},
					compressor: {
						enabled: false,
						thresholdDb: -18,
						ratio: 2,
						makeupGainDb: 0,
						attackSeconds: 0.01,
						releaseSeconds: 0.18,
					},
					deesser: { enabled: false, amountDb: 0, frequency: 6000, q: 1 },
					limiter: { enabled: false, ceilingDb: -1, releaseSeconds: 0.12 },
				},
				elements: [baseElement],
			},
		];

		const previewTracks = applySelectedReframePresetPreviewToTracks({
			tracks,
			selectedPresetIdByElementId: {
				[baseElement.id]: "subject",
			},
			selectedSplitPreviewByElementId: {},
			selectedElementIds: new Set([baseElement.id]),
		});
		const previewElement = previewTracks[0]?.elements[0];
		expect(previewElement?.type).toBe("video");
		if (!previewElement || previewElement.type !== "video") {
			throw new Error("Expected video element");
		}

		expect(
			resolveVideoBaseTransformAtTime({
				element: previewElement,
				localTime: 1,
			}),
		).toEqual({
			position: { x: 120, y: -40 },
			scale: 2.5,
			rotate: 12,
		});
		expect(baseElement.defaultReframePresetId).toBe("wide");
		expect(baseElement.reframeSwitches?.[0]?.presetId).toBe("subject");
	});

	test("normalizes split-screen preset references and resolves follow-active slots", () => {
		const element: VideoElement = {
			...baseElement,
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "missing" },
					{ slotId: "bottom", mode: "follow-active", presetId: null },
				],
				sections: [],
			},
		};

		const resolved = resolveVideoSplitScreenAtTime({
			element,
			localTime: 5,
		});

		expect(resolved?.slots).toEqual([
			{
				slotId: "top",
				mode: "fixed-preset",
				presetId: "wide",
				transformOverride: null,
			},
			{
				slotId: "bottom",
				mode: "follow-active",
				presetId: "subject",
				transformOverride: null,
			},
		]);
		expect(resolved?.viewportBalance).toBe("balanced");
	});

	test("prefers subject left and subject right for default split-screen bindings", () => {
		expect(
			buildDefaultVideoSplitScreenBindings({
				layoutPreset: "top-bottom",
				presets: baseElement.reframePresets ?? [],
			}),
		).toEqual([
			{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
			{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
		]);

		const presetsWithNamedSides = [
			baseElement.reframePresets?.[0],
			{
				id: "subject-left",
				name: "Subject Left",
				transform: {
					position: { x: -140, y: -20 },
					scale: 2.4,
				},
			},
			{
				id: "subject-right",
				name: "Subject Right",
				transform: {
					position: { x: 140, y: -20 },
					scale: 2.4,
				},
			},
		].filter(Boolean) as NonNullable<VideoElement["reframePresets"]>;

		expect(
			buildDefaultVideoSplitScreenBindings({
				layoutPreset: "top-bottom",
				presets: presetsWithNamedSides,
			}),
		).toEqual([
			{ slotId: "top", mode: "fixed-preset", presetId: "subject-left" },
			{ slotId: "bottom", mode: "fixed-preset", presetId: "subject-right" },
		]);
	});

	test("split-screen sections use the shared split angle bindings when enabled", () => {
		const element: VideoElement = {
			...baseElement,
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "follow-active", presetId: null },
					{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
				],
				sections: [
					{
						id: "section-1",
						startTime: 2,
						slots: [
							{ slotId: "top", mode: "fixed-preset", presetId: "subject" },
							{ slotId: "bottom", mode: "fixed-preset", presetId: "wide" },
						],
					},
				],
			},
		};

		const resolved = resolveVideoSplitScreenAtTime({
			element,
			localTime: 3,
		});

		expect(
			getVideoSplitScreenSectionAtTime({ element, localTime: 3 })?.id,
		).toBe("section-1");
		expect(resolved?.slots).toEqual([
			{
				slotId: "top",
				mode: "follow-active",
				presetId: "wide",
				transformOverride: null,
			},
			{
				slotId: "bottom",
				mode: "fixed-preset",
				presetId: "subject",
				transformOverride: null,
			},
		]);
	});

	test("split-screen slot transform overrides are honored when manual slot adjustments are enabled", () => {
		const resolved = resolveVideoSplitScreenSlotTransform({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: baseElement.reframePresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
				transformOverride: {
					position: { x: 360, y: -120 },
					scale: 3.4,
				},
			},
		});

		expect(resolved).toEqual({
			position: { x: 360, y: -120 },
			scale: 3.4,
			rotate: 12,
		});
		expect(
			baseElement.reframePresets?.find((preset) => preset.id === "subject")
				?.transform,
		).toEqual({
			position: { x: 120, y: -40 },
			scale: 2.5,
		});
	});

	test("split-screen binding applies stored per-slot adjustments when manual slot adjustments are enabled", () => {
		const resolved = resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: baseElement.reframePresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
				transformAdjustmentsBySlotId: {
					top: {
						sourceCenterOffset: { x: 0, y: 0 },
						scaleMultiplier: 1,
					},
					bottom: {
						sourceCenterOffset: { x: 120, y: -40 },
						scaleMultiplier: 0.8,
					},
				},
			},
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
		});

		expect(resolved.position.x).toBeCloseTo(-39, 6);
		expect(resolved.position.y).toBeCloseTo(13, 6);
		expect(resolved.scale).toBeCloseTo(1.2669447341, 6);
		expect(resolved.rotate).toBe(12);
	});

	test("split-screen binding applies balanced and unbalanced manual variants independently", () => {
		const balanced = resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: baseElement.reframePresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
				transformAdjustmentsBySlotId: {
					"balanced:bottom": {
						sourceCenterOffset: { x: 60, y: 0 },
						scaleMultiplier: 1,
					},
					"unbalanced:bottom": {
						sourceCenterOffset: { x: 0, y: -80 },
						scaleMultiplier: 0.85,
					},
				},
			},
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
		});

		const unbalanced = resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: baseElement.reframePresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
				transformAdjustmentsBySlotId: {
					"balanced:bottom": {
						sourceCenterOffset: { x: 60, y: 0 },
						scaleMultiplier: 1,
					},
					"unbalanced:bottom": {
						sourceCenterOffset: { x: 0, y: -80 },
						scaleMultiplier: 0.85,
					},
				},
			},
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "unbalanced",
		});

		expect(balanced.position.x).toBeCloseTo(35.625, 6);
		expect(balanced.position.y).toBeCloseTo(-40, 6);
		expect(balanced.scale).toBeCloseTo(1.5836809176, 6);
		expect(unbalanced.position.x).toBeCloseTo(102, 6);
		expect(unbalanced.position.y).toBeCloseTo(61.625, 6);
		expect(unbalanced.scale).toBeCloseTo(1.0093334636, 6);
	});

	test("split-screen auto framing centers tracked subjects inside slots by default", () => {
		const resolved = resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: [
				baseElement.reframePresets![0]!,
				{
					...baseElement.reframePresets![1]!,
					motionTracking: {
						enabled: true,
						mode: "subject-single-v1",
						source: "baked-keyframes",
						animateScale: true,
						keyframes: [
							{
								id: "track-1",
								time: 0,
								position: { x: 120, y: -40 },
								scale: 2.5,
								subjectCenter: { x: 300, y: 240 },
								subjectSize: { width: 240, height: 420 },
							},
						],
					},
				},
			],
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
			},
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
		});

		const viewport = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			width: 1080,
			height: 1920,
		}).get("bottom");
		expect(viewport).toBeDefined();
		if (!viewport) return;
		const slotCoverScale = Math.max(
			viewport.width / 1920,
			viewport.height / 1080,
		);
		const viewportAdjustedPosition = {
			x: resolved.position.x + 1080 / 2 - (viewport.x + viewport.width / 2),
			y: resolved.position.y + 1920 / 2 - (viewport.y + viewport.height / 2),
		};
		const totalScale = slotCoverScale * resolved.scale;
		const viewportAnchor = {
			x: viewport.width / 2,
			y: viewport.height * 0.4,
		};
		const sourceCenter = {
			x: 1920 / 2 - viewportAdjustedPosition.x / totalScale,
			y:
				1080 / 2 -
				(viewportAdjustedPosition.y -
					(viewportAnchor.y - viewport.height / 2)) /
					totalScale,
		};

		expect(sourceCenter.x).toBeCloseTo(300, 5);
		expect(sourceCenter.y).toBeCloseTo(213.80009144947405, 5);
		expect(resolved.scale).toBeLessThan(2.5);
	});

	test("split-screen manual Y adjustment does not introduce X drift", () => {
		const trackedPresets = [
			baseElement.reframePresets![0]!,
			{
				...baseElement.reframePresets![1]!,
				motionTracking: {
					enabled: true,
					mode: "subject-single-v1",
					source: "baked-keyframes",
					animateScale: true,
					keyframes: [
						{
							id: "track-1",
							time: 0,
							position: { x: 120, y: -40 },
							scale: 2.5,
							subjectCenter: { x: 300, y: 240 },
							subjectSize: { width: 240, height: 420 },
						},
					],
				},
			},
		];
		const autoTransform = resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: trackedPresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
			},
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
		});
		const finalTransform = {
			position: {
				x: autoTransform.position.x,
				y: autoTransform.position.y + 120,
			},
			scale: autoTransform.scale,
		};
		const adjustment = deriveVideoSplitScreenSlotAdjustmentFromTransform({
			baseTransform: baseElement.transform,
			adjustmentBaseTransform: autoTransform,
			finalTransform,
			slotId: "bottom",
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
		});
		const resolved = resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: trackedPresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
				transformAdjustmentsBySlotId: {
					bottom: adjustment,
				},
			},
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
		});

		expect(resolved.position.x).toBeCloseTo(finalTransform.position.x, 6);
		expect(resolved.position.y).toBeCloseTo(finalTransform.position.y, 6);
		expect(resolved.scale).toBeCloseTo(finalTransform.scale, 6);
	});

	test("split-screen manual scale keeps the slot framing center fixed", () => {
		const trackedPresets = [
			baseElement.reframePresets![0]!,
			{
				...baseElement.reframePresets![1]!,
				motionTracking: {
					enabled: true,
					mode: "subject-single-v1",
					source: "baked-keyframes",
					animateScale: true,
					keyframes: [
						{
							id: "track-1",
							time: 0,
							position: { x: 120, y: -40 },
							scale: 2.5,
							subjectCenter: { x: 300, y: 240 },
							subjectSize: { width: 240, height: 420 },
						},
					],
				},
			},
		];
		const viewport = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			width: 1080,
			height: 1920,
		}).get("bottom");
		expect(viewport).toBeDefined();
		if (!viewport) return;
		const autoTransform = resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: trackedPresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
			},
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
		});
		const slotCoverScale = Math.max(
			viewport.width / 1920,
			viewport.height / 1080,
		);
		const sourceCenter = getSourceCenterForTransform({
			transform: autoTransform,
			baseScale: slotCoverScale,
			sourceWidth: 1920,
			sourceHeight: 1080,
		});
		const scaledTransform = buildTransformForSourceCenter({
			sourceCenter,
			scale: autoTransform.scale * 1.25,
			baseScale: slotCoverScale,
			sourceWidth: 1920,
			sourceHeight: 1080,
			rotate: autoTransform.rotate,
		});
		const adjustment = deriveVideoSplitScreenSlotAdjustmentFromTransform({
			baseTransform: baseElement.transform,
			adjustmentBaseTransform: autoTransform,
			finalTransform: scaledTransform,
			slotId: "bottom",
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
		});
		const resolved = resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: trackedPresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
				transformAdjustmentsBySlotId: {
					bottom: adjustment,
				},
			},
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
		});
		const autoCenter = getSourceCenterForTransform({
			transform: autoTransform,
			baseScale: slotCoverScale,
			sourceWidth: 1920,
			sourceHeight: 1080,
		});
		const resolvedCenter = getSourceCenterForTransform({
			transform: resolved,
			baseScale: slotCoverScale,
			sourceWidth: 1920,
			sourceHeight: 1080,
		});

		expect(resolvedCenter.x).toBeCloseTo(autoCenter.x, 5);
		expect(resolvedCenter.y).toBeCloseTo(autoCenter.y, 5);
		expect(resolved.scale).toBeCloseTo(scaledTransform.scale, 6);
	});

	test("converts split-slot framing into equivalent full-screen framing", () => {
		const slotTransform = resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: baseElement.reframePresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
				transformAdjustmentsBySlotId: {
					bottom: {
						sourceCenterOffset: { x: 120, y: -40 },
						scaleMultiplier: 0.8,
					},
				},
			},
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
		});

		const fullScreenTransform = deriveVideoReframeTransformFromSplitSlotTransform({
			slotTransform,
			slotId: "bottom",
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
		});

		const roundTrippedSlotTransform = resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: [
				{
					id: "wide",
					name: "Wide",
					transform: {
						position: { x: 0, y: 0 },
						scale: 1.8,
					},
				},
				{
					id: "subject",
					name: "Subject",
					transform: {
						position: fullScreenTransform.position,
						scale: fullScreenTransform.scale,
					},
				},
			],
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
				slotId: "bottom",
				presetId: "subject",
			},
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
		});

		expect(fullScreenTransform.rotate).toBe(12);
		expect(roundTrippedSlotTransform.position.x).toBeCloseTo(
			slotTransform.position.x,
			5,
		);
		expect(roundTrippedSlotTransform.position.y).toBeCloseTo(
			slotTransform.position.y,
			5,
		);
		expect(roundTrippedSlotTransform.scale).toBeCloseTo(slotTransform.scale, 5);
	});

	test("split-screen section can disable split mode for a timed segment", () => {
		const element: VideoElement = {
			...baseElement,
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
					{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
				],
				sections: [
					{
						id: "single-view",
						startTime: 2,
						enabled: false,
						slots: [
							{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
							{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
						],
					},
				],
			},
		};

		expect(
			resolveVideoSplitScreenAtTime({
				element,
				localTime: 1,
			}),
		).not.toBeNull();
		expect(
			resolveVideoSplitScreenAtTime({
				element,
				localTime: 3,
			}),
		).toBeNull();
	});

	test("derives split-screen section ranges including the default segment", () => {
		const element: VideoElement = {
			...baseElement,
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "follow-active", presetId: null },
					{ slotId: "bottom", mode: "follow-active", presetId: null },
				],
				sections: [
					{
						id: "section-1",
						startTime: 2,
						slots: [
							{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
							{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
						],
					},
					{
						id: "section-2",
						startTime: 6,
						slots: [
							{ slotId: "top", mode: "fixed-preset", presetId: "subject" },
							{ slotId: "bottom", mode: "fixed-preset", presetId: "wide" },
						],
					},
				],
			},
		};

		expect(deriveVideoSplitScreenSectionRanges({ element })).toEqual([
			{ startTime: 0, endTime: 2, sectionId: null, enabled: true },
			{ startTime: 2, endTime: 6, sectionId: "section-1", enabled: true },
			{ startTime: 6, endTime: 10, sectionId: "section-2", enabled: true },
		]);
	});

	test("derives timeline angle sections with split taking precedence", () => {
		const element: VideoElement = {
			...baseElement,
			splitScreen: {
				enabled: false,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
					{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
				],
				sections: [
					{
						id: "split-at-switch",
						startTime: 4,
						enabled: true,
						slots: [
							{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
							{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
						],
					},
				],
			},
		};

		expect(deriveVideoAngleSections({ element })).toEqual([
			{
				startTime: 0,
				endTime: 4,
				presetId: "wide",
				switchId: null,
				splitSectionId: null,
				isSplit: false,
			},
			{
				startTime: 4,
				endTime: 10,
				presetId: "subject",
				switchId: "switch-1",
				splitSectionId: "split-at-switch",
				isSplit: true,
			},
		]);
	});

	test("derives a section boundary when split mode is explicitly disabled", () => {
		const element: VideoElement = {
			...baseElement,
			reframeSwitches: [],
			defaultReframePresetId: "subject",
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
					{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
				],
				sections: [
					{
						id: "single-view",
						startTime: 4,
						enabled: false,
						slots: [
							{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
							{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
						],
					},
				],
			},
		};

		expect(deriveVideoAngleSections({ element })).toEqual([
			{
				startTime: 0,
				endTime: 4,
				presetId: "subject",
				switchId: null,
				splitSectionId: null,
				isSplit: true,
			},
			{
				startTime: 4,
				endTime: 10,
				presetId: "subject",
				switchId: null,
				splitSectionId: null,
				isSplit: false,
			},
		]);
	});

	test("applies a preset to an angle section that exists only because of split boundaries", () => {
		const element: VideoElement = {
			...baseElement,
			reframeSwitches: [],
			defaultReframePresetId: "wide",
			splitScreen: {
				enabled: false,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
					{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
				],
				sections: [
					{
						id: "split-only",
						startTime: 4,
						enabled: true,
						slots: [
							{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
							{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
						],
					},
					{
						id: "single-again",
						startTime: 7,
						enabled: false,
						slots: [
							{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
							{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
						],
					},
				],
			},
		};

		expect(
			getVideoAngleSectionAtTime({
				element,
				localTime: 8,
			}),
		).toMatchObject({
			startTime: 7,
			endTime: 10,
			presetId: "wide",
			isSplit: false,
		});

		const nextState = applyPresetToVideoAngleSection({
			element,
			sectionStartTime: 7,
			presetId: "subject",
		});

		expect(nextState.defaultReframePresetId).toBe("wide");
		expect(nextState.reframeSwitches).toEqual([
			{
				id: expect.any(String),
				time: 4,
				presetId: "wide",
			},
			{
				id: expect.any(String),
				time: 7,
				presetId: "subject",
			},
		]);
		expect(nextState.splitScreen?.sections).toHaveLength(2);
		expect(nextState.splitScreen?.sections?.[0]).toMatchObject({
			id: expect.any(String),
			startTime: 4,
			enabled: true,
			slots: [
				{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
				{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
			],
		});
		expect(nextState.splitScreen?.sections?.[1]).toMatchObject({
			id: expect.any(String),
			startTime: 7,
			enabled: false,
			slots: [
				{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
				{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
			],
		});
	});

	test("keeps adjacent sections when applying the same preset to a split-only angle section", () => {
		const element: VideoElement = {
			...baseElement,
			reframeSwitches: [
				{
					id: "switch-1",
					time: 4,
					presetId: "subject",
				},
			],
			defaultReframePresetId: "wide",
			splitScreen: {
				enabled: false,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
					{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
				],
				sections: [
					{
						id: "split-only",
						startTime: 7,
						enabled: true,
						slots: [
							{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
							{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
						],
					},
				],
			},
		};

		const nextState = applyPresetToVideoAngleSection({
			element,
			sectionStartTime: 7,
			presetId: "subject",
		});

		expect(nextState.reframeSwitches).toEqual([
			{
				id: expect.any(String),
				time: 4,
				presetId: "subject",
			},
			{
				id: expect.any(String),
				time: 7,
				presetId: "subject",
			},
		]);
		expect(
			deriveVideoAngleSections({
				element: {
					...element,
					...nextState,
				},
				mergeAdjacent: false,
			}),
		).toEqual([
			{
				startTime: 0,
				endTime: 4,
				presetId: "wide",
				switchId: null,
				splitSectionId: null,
				isSplit: false,
			},
			{
				startTime: 4,
				endTime: 7,
				presetId: "subject",
				switchId: expect.any(String),
				splitSectionId: null,
				isSplit: false,
			},
			{
				startTime: 7,
				endTime: 10,
				presetId: "subject",
				switchId: expect.any(String),
				splitSectionId: null,
				isSplit: false,
			},
		]);
	});

	test("applies split screen to the current angle section without inventing extra sections", () => {
		const element: VideoElement = {
			...baseElement,
			reframeSwitches: [
				{
					id: "switch-1",
					time: 5,
					presetId: "subject",
				},
			],
			splitScreen: {
				enabled: false,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
					{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
				],
				sections: [],
			},
		};

		const nextState = applySplitScreenToVideoAngleSection({
			element,
			sectionStartTime: 5,
		});

		expect(nextState.reframeSwitches).toEqual([
			{
				id: expect.any(String),
				time: 5,
				presetId: "subject",
			},
		]);
		expect(nextState.splitScreen?.enabled).toBe(false);
		expect(nextState.splitScreen?.sections).toHaveLength(1);
		expect(nextState.splitScreen?.sections?.[0]).toMatchObject({
			id: expect.any(String),
			startTime: 5,
			enabled: true,
			slots: [
				{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
				{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
			],
		});
		const nextSections = deriveVideoAngleSections({
			element: {
				...element,
				...nextState,
			},
		});
		expect(nextSections).toHaveLength(2);
		expect(nextSections[0]).toEqual({
			startTime: 0,
			endTime: 5,
			presetId: "wide",
			switchId: null,
			splitSectionId: null,
			isSplit: false,
		});
		expect(nextSections[1]?.startTime).toBe(5);
		expect(nextSections[1]?.endTime).toBe(10);
		expect(nextSections[1]?.presetId).toBe("subject");
		expect(nextSections[1]?.isSplit).toBe(true);
		expect(typeof nextSections[1]?.switchId).toBe("string");
	});

	test("remaps split slot transforms when swapping between top and bottom", () => {
		expect(
			remapSplitSlotTransformBetweenViewports({
				transform: {
					position: { x: 40, y: -120 },
					scale: 2.2,
				},
				layoutPreset: "top-bottom",
				viewportBalance: "balanced",
				fromSlotId: "top",
				toSlotId: "bottom",
				canvasWidth: 1080,
				canvasHeight: 1920,
				sourceWidth: 1920,
				sourceHeight: 1080,
			}),
		).toEqual({
			position: { x: 40, y: 841 },
			scale: 2.2,
		});

		expect(
			remapSplitSlotTransformBetweenViewports({
				transform: {
					position: { x: -60, y: 510 },
					scale: 1.8,
				},
				layoutPreset: "top-bottom",
				viewportBalance: "balanced",
				fromSlotId: "bottom",
				toSlotId: "top",
				canvasWidth: 1080,
				canvasHeight: 1920,
				sourceWidth: 1920,
				sourceHeight: 1080,
			}),
		).toEqual({
			position: { x: -60, y: -451 },
			scale: 1.8,
		});

		expect(
			remapSplitSlotTransformBetweenViewports({
				transform: {
					position: { x: 40, y: -120 },
					scale: 2.2,
				},
				layoutPreset: "top-bottom",
				viewportBalance: "unbalanced",
				fromSlotId: "top",
				toSlotId: "bottom",
				canvasWidth: 1080,
				canvasHeight: 1920,
				sourceWidth: 1920,
				sourceHeight: 1080,
			}),
		).toEqual({
			position: { x: 80.06259780907669, y: 1362.3145539906104 },
			scale: 2.2,
		});

		expect(
			remapSplitSlotTransformBetweenViewports({
				transform: {
					position: { x: -60, y: 510 },
					scale: 1.8,
				},
				layoutPreset: "top-bottom",
				viewportBalance: "unbalanced",
				fromSlotId: "bottom",
				toSlotId: "top",
				canvasWidth: 1080,
				canvasHeight: 1920,
				sourceWidth: 1920,
				sourceHeight: 1080,
			}),
		).toEqual({
			position: { x: -29.976544175136823, y: -545.8240813135262 },
			scale: 1.8,
		});
	});

	test("builds unbalanced top-bottom split viewports and divider geometry", () => {
		const viewports = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "unbalanced",
			width: 1080,
			height: 1920,
		});
		expect(viewports.get("top")).toEqual({
			x: 0,
			y: 0,
			width: 1080,
			height: 639,
		});
		expect(viewports.get("bottom")).toEqual({
			x: 0,
			y: 641,
			width: 1080,
			height: 1279,
		});
		expect(
			getVideoSplitScreenDividers({
				layoutPreset: "top-bottom",
				viewportBalance: "unbalanced",
				width: 1080,
				height: 1920,
			}),
		).toEqual([{ x: 0, y: 639, width: 1080, height: 2 }]);
	});

	test("remaps split slot transforms when changing viewport balance", () => {
		expect(
			remapSplitSlotTransformBetweenViewportBalances({
				transform: {
					position: { x: 40, y: -120 },
					scale: 2.2,
				},
				layoutPreset: "top-bottom",
				fromViewportBalance: "balanced",
				toViewportBalance: "unbalanced",
				slotId: "top",
				canvasWidth: 1080,
				canvasHeight: 1920,
				sourceWidth: 1920,
				sourceHeight: 1080,
			}),
		).toEqual({
			position: { x: 26.65276329509906, y: -400.29197080291976 },
			scale: 2.2,
		});

		expect(
			remapSplitSlotTransformBetweenViewportBalances({
				transform: {
					position: { x: -60, y: 510 },
					scale: 1.8,
				},
				layoutPreset: "top-bottom",
				fromViewportBalance: "balanced",
				toViewportBalance: "unbalanced",
				slotId: "bottom",
				canvasWidth: 1080,
				canvasHeight: 1920,
				sourceWidth: 1920,
				sourceHeight: 1080,
			}),
		).toEqual({
			position: { x: -80.02085505735141, y: 359.84358706986444 },
			scale: 1.8,
		});
	});

	test("preview split override carries viewport balance into temporary preview tracks", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "track-1",
				type: "video",
				name: "Video",
				isMain: false,
				muted: false,
				hidden: false,
				volume: 1,
				audioEffects: {
					eq: {
						enabled: false,
						lowGainDb: 0,
						midGainDb: 0,
						highGainDb: 0,
						midFrequency: 1200,
						highFrequency: 4800,
					},
					compressor: {
						enabled: false,
						thresholdDb: -18,
						ratio: 2,
						makeupGainDb: 0,
						attackSeconds: 0.01,
						releaseSeconds: 0.18,
					},
					deesser: { enabled: false, amountDb: 0, frequency: 6000, q: 1 },
					limiter: { enabled: false, ceilingDb: -1, releaseSeconds: 0.12 },
				},
				elements: [baseElement],
			},
		];

		const previewTracks = applySelectedReframePresetPreviewToTracks({
			tracks,
			selectedPresetIdByElementId: {},
			selectedSplitPreviewByElementId: {
				[baseElement.id]: {
					slots: [
						{ slotId: "top", mode: "fixed-preset", presetId: "wide" },
						{ slotId: "bottom", mode: "fixed-preset", presetId: "subject" },
					],
					viewportBalance: "unbalanced",
				},
			},
			selectedElementIds: new Set([baseElement.id]),
		});

		const previewElement = previewTracks[0]?.elements[0];
		expect(previewElement?.type).toBe("video");
		if (!previewElement || previewElement.type !== "video") {
			throw new Error("Expected video element");
		}
		expect(previewElement.splitScreen?.viewportBalance).toBe("unbalanced");
	});
});
