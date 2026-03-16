import { describe, expect, test } from "bun:test";
import {
	applySelectedReframePresetPreviewToTracks,
	getActiveReframePresetId,
	replaceOrInsertReframeSwitch,
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
});
