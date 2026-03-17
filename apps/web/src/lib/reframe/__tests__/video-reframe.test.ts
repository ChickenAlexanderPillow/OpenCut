import { describe, expect, test } from "bun:test";
import {
	applySelectedReframePresetPreviewToTracks,
	buildDefaultVideoSplitScreenBindings,
	deriveVideoAngleSections,
	deriveVideoSplitScreenSectionRanges,
	getActiveReframePresetId,
	getVideoSplitScreenSectionAtTime,
	replaceOrInsertReframeSwitch,
	resolveVideoSplitScreenAtTime,
	resolveVideoSplitScreenSlotTransform,
	resolveVideoBaseTransformAtTime,
	resolveVideoReframeTransform,
} from "../video-reframe";
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

	test("split-screen section overrides slot preset bindings", () => {
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

		expect(getVideoSplitScreenSectionAtTime({ element, localTime: 3 })?.id).toBe(
			"section-1",
		);
		expect(resolved?.slots).toEqual([
			{
				slotId: "top",
				mode: "fixed-preset",
				presetId: "subject",
				transformOverride: null,
			},
			{
				slotId: "bottom",
				mode: "fixed-preset",
				presetId: "wide",
				transformOverride: null,
			},
		]);
	});

	test("split-screen slot transform overrides stay separate from the bound preset", () => {
		const resolved = resolveVideoSplitScreenSlotTransform({
			baseTransform: baseElement.transform,
			duration: baseElement.duration,
			reframePresets: baseElement.reframePresets,
			reframeSwitches: baseElement.reframeSwitches,
			defaultReframePresetId: baseElement.defaultReframePresetId,
			localTime: 5,
			slot: {
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
			baseElement.reframePresets?.find((preset) => preset.id === "subject")?.transform,
		).toEqual({
			position: { x: 120, y: -40 },
			scale: 2.5,
		});
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
});
