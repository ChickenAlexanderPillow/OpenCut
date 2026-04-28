import { describe, expect, test } from "bun:test";
import {
	getVideoSplitScreenViewports,
} from "@/lib/reframe/video-reframe";
import {
	remapSquareSourceVideoTransformsForSquarePreview,
	remapVideoAdjustmentsForPreviewVariant,
	resolveSquarePreviewStrategy,
} from "../preview-format";
import type { MediaAsset } from "@/types/assets";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

describe("preview-format video adjustment remapping", () => {
	test("keeps native square video on the project background in square preview", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "track-1",
				name: "Video",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [
					{
						id: "video-1",
						type: "video",
						mediaId: "media-square",
						name: "Square clip",
						startTime: 0,
						duration: 10,
						trimStart: 0,
						trimEnd: 0,
						transform: {
							position: { x: 0, y: 0 },
							scale: 1,
							rotate: 0,
						},
						opacity: 1,
					},
				],
			},
		];
		const mediaAssets: MediaAsset[] = [
			{
				id: "media-square",
				type: "video",
				name: "Square clip",
				file: new File(["x"], "square.mp4", { type: "video/mp4" }),
				width: 1080,
				height: 1080,
				duration: 10,
			},
		];

		expect(resolveSquarePreviewStrategy({ tracks, mediaAssets })).toEqual({
			backgroundMode: "project",
			remapVideoAdjustments: false,
		});
	});

	test("uses the black square-preview strategy for landscape video", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "track-1",
				name: "Video",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [
					{
						id: "video-1",
						type: "video",
						mediaId: "media-landscape",
						name: "Landscape clip",
						startTime: 0,
						duration: 10,
						trimStart: 0,
						trimEnd: 0,
						transform: {
							position: { x: 0, y: 0 },
							scale: 1,
							rotate: 0,
						},
						opacity: 1,
					},
				],
			},
		];
		const mediaAssets: MediaAsset[] = [
			{
				id: "media-landscape",
				type: "video",
				name: "Landscape clip",
				file: new File(["x"], "landscape.mp4", { type: "video/mp4" }),
				width: 1920,
				height: 1080,
				duration: 10,
			},
		];

		expect(resolveSquarePreviewStrategy({ tracks, mediaAssets })).toEqual({
			backgroundMode: "black",
			remapVideoAdjustments: true,
		});
	});

	test("remaps native square video transforms back to fit in square preview", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "track-1",
				name: "Video",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [
					{
						id: "video-1",
						type: "video",
						mediaId: "media-square",
						name: "Square clip",
						startTime: 0,
						duration: 10,
						trimStart: 0,
						trimEnd: 0,
						transform: {
							position: { x: 177.7777777778, y: -88.8888888889 },
							scale: 1.7777777778,
							rotate: 0,
						},
						reframePresets: [
							{
								id: "preset-1",
								name: "Main",
								transform: {
									position: { x: 88.8888888889, y: 44.4444444444 },
									scale: 2.6666666667,
								},
							},
						],
						opacity: 1,
					},
				],
			},
		];
		const mediaAssets: MediaAsset[] = [
			{
				id: "media-square",
				type: "video",
				name: "Square clip",
				file: new File(["x"], "square.mp4", { type: "video/mp4" }),
				width: 1080,
				height: 1080,
				duration: 10,
			},
		];

		const [track] = remapSquareSourceVideoTransformsForSquarePreview({
			tracks,
			mediaAssets,
			sourceCanvas: { width: 1920, height: 1080 },
		});
		const remapped = track?.type === "video" ? track.elements[0] : null;
		expect(remapped?.type).toBe("video");
		if (!remapped || remapped.type !== "video") return;

		expect(remapped.transform.position.x).toBeCloseTo(100, 6);
		expect(remapped.transform.position.y).toBeCloseTo(-50, 6);
		expect(remapped.transform.scale).toBeCloseTo(1, 6);
		expect(remapped.reframePresets?.[0]?.transform.position.x).toBeCloseTo(
			50,
			6,
		);
		expect(remapped.reframePresets?.[0]?.transform.position.y).toBeCloseTo(
			25,
			6,
		);
		expect(remapped.reframePresets?.[0]?.transform.scale).toBeCloseTo(1.5, 6);
	});

	test("scales reframe adjustment offsets for square preview without changing authored transforms", () => {
		const element: VideoElement = {
			id: "video-1",
			type: "video",
			mediaId: "media-1",
			name: "Clip",
			startTime: 0,
			duration: 10,
			trimStart: 0,
			trimEnd: 0,
			transform: {
				position: { x: 0, y: 0 },
				scale: 1.8,
				rotate: 0,
			},
			opacity: 1,
			reframePresets: [
				{
					id: "subject",
					name: "Subject",
					transform: {
						position: { x: 120, y: -40 },
						scale: 2.5,
					},
					transformAdjustment: {
						positionOffset: { x: 80, y: 120 },
						scaleMultiplier: 1.1,
					},
					manualTransformAdjustment: {
						positionOffset: { x: -40, y: 160 },
						scaleMultiplier: 0.9,
					},
				},
			],
		};
		const tracks: TimelineTrack[] = [
			{
				id: "track-1",
				name: "Video",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [element],
			},
		];

		const [track] = remapVideoAdjustmentsForPreviewVariant({
			tracks,
			sourceCanvas: { width: 1080, height: 1920 },
			previewCanvas: { width: 1080, height: 1080 },
		});
		const remapped = track?.type === "video" ? track.elements[0] : null;
		expect(remapped?.type).toBe("video");
		if (!remapped || remapped.type !== "video") return;

		expect(remapped.transform).toEqual(element.transform);
		expect(remapped.reframePresets?.[0]?.transform).toEqual(
			element.reframePresets?.[0]?.transform,
		);
		expect(remapped.reframePresets?.[0]?.transformAdjustment).toEqual({
			positionOffset: { x: 80, y: 67.5 },
			scaleMultiplier: 1.1,
		});
		expect(remapped.reframePresets?.[0]?.manualTransformAdjustment).toEqual({
			positionOffset: { x: -40, y: 90 },
			scaleMultiplier: 0.9,
		});
	});

	test("scales split-slot position offsets using the destination slot viewport size", () => {
		const element: VideoElement = {
			id: "video-1",
			type: "video",
			mediaId: "media-1",
			name: "Clip",
			startTime: 0,
			duration: 10,
			trimStart: 0,
			trimEnd: 0,
			transform: {
				position: { x: 0, y: 0 },
				scale: 1.8,
				rotate: 0,
			},
			opacity: 1,
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				slots: [
					{
						slotId: "bottom",
						mode: "fixed-preset",
						presetId: "subject",
						transformAdjustmentsBySlotId: {
							"balanced:bottom": {
								positionOffset: { x: 100, y: 200 },
								scaleMultiplier: 1.2,
							},
							"unbalanced:bottom": {
								positionOffset: { x: 90, y: 210 },
								scaleMultiplier: 1.1,
							},
							bottom: {
								sourceCenterOffset: { x: 10, y: -20 },
								scaleMultiplier: 0.95,
							},
						},
					},
				],
				sections: [],
			},
		};
		const tracks: TimelineTrack[] = [
			{
				id: "track-1",
				name: "Video",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [element],
			},
		];

		const [track] = remapVideoAdjustmentsForPreviewVariant({
			tracks,
			sourceCanvas: { width: 1080, height: 1920 },
			previewCanvas: { width: 1080, height: 1080 },
		});
		const remapped = track?.type === "video" ? track.elements[0] : null;
		expect(remapped?.type).toBe("video");
		if (!remapped || remapped.type !== "video") return;

		const projectBalancedBottom = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			width: 1080,
			height: 1920,
		}).get("bottom");
		const previewBalancedBottom = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			width: 1080,
			height: 1080,
		}).get("bottom");
		const projectUnbalancedBottom = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "unbalanced",
			width: 1080,
			height: 1920,
		}).get("bottom");
		const previewUnbalancedBottom = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "unbalanced",
			width: 1080,
			height: 1080,
		}).get("bottom");
		expect(projectBalancedBottom).toBeDefined();
		expect(previewBalancedBottom).toBeDefined();
		expect(projectUnbalancedBottom).toBeDefined();
		expect(previewUnbalancedBottom).toBeDefined();
		if (
			!projectBalancedBottom ||
			!previewBalancedBottom ||
			!projectUnbalancedBottom ||
			!previewUnbalancedBottom
		) {
			return;
		}

		const adjustments =
			remapped.splitScreen?.slots[0]?.transformAdjustmentsBySlotId;
		expect(adjustments?.["balanced:bottom"]).toEqual({
			positionOffset: {
				x: 100,
				y:
					200 *
					(previewBalancedBottom.height / projectBalancedBottom.height),
			},
			scaleMultiplier: 1.2,
		});
		expect(adjustments?.["unbalanced:bottom"]).toEqual({
			positionOffset: {
				x: 90,
				y:
					210 *
					(previewUnbalancedBottom.height /
						projectUnbalancedBottom.height),
			},
			scaleMultiplier: 1.1,
		});
		expect(adjustments?.bottom).toEqual({
			sourceCenterOffset: { x: 10, y: -20 },
			scaleMultiplier: 0.95,
		});
	});

	test("scales split-slot transform overrides using the destination slot viewport size", () => {
		const element: VideoElement = {
			id: "video-1",
			type: "video",
			mediaId: "media-1",
			name: "Clip",
			startTime: 0,
			duration: 10,
			trimStart: 0,
			trimEnd: 0,
			transform: {
				position: { x: 0, y: 0 },
				scale: 1.8,
				rotate: 0,
			},
			opacity: 1,
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				slots: [
					{
						slotId: "top",
						mode: "fixed-preset",
						presetId: "subject",
						transformOverride: {
							position: { x: 120, y: -320 },
							scale: 1.4,
						},
						transformOverridesBySlotId: {
							"balanced:top": {
								position: { x: 120, y: -320 },
								scale: 1.4,
							},
							"unbalanced:top": {
								position: { x: 90, y: -260 },
								scale: 1.3,
							},
						},
					},
				],
				sections: [],
			},
		};
		const tracks: TimelineTrack[] = [
			{
				id: "track-1",
				name: "Video",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [element],
			},
		];

		const [track] = remapVideoAdjustmentsForPreviewVariant({
			tracks,
			sourceCanvas: { width: 1080, height: 1920 },
			previewCanvas: { width: 1080, height: 1080 },
		});
		const remapped = track?.type === "video" ? track.elements[0] : null;
		expect(remapped?.type).toBe("video");
		if (!remapped || remapped.type !== "video") return;

		const projectBalancedTop = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			width: 1080,
			height: 1920,
		}).get("top");
		const previewBalancedTop = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			width: 1080,
			height: 1080,
		}).get("top");
		const projectUnbalancedTop = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "unbalanced",
			width: 1080,
			height: 1920,
		}).get("top");
		const previewUnbalancedTop = getVideoSplitScreenViewports({
			layoutPreset: "top-bottom",
			viewportBalance: "unbalanced",
			width: 1080,
			height: 1080,
		}).get("top");
		expect(projectBalancedTop).toBeDefined();
		expect(previewBalancedTop).toBeDefined();
		expect(projectUnbalancedTop).toBeDefined();
		expect(previewUnbalancedTop).toBeDefined();
		if (
			!projectBalancedTop ||
			!previewBalancedTop ||
			!projectUnbalancedTop ||
			!previewUnbalancedTop
		) {
			return;
		}

		const slot = remapped.splitScreen?.slots[0];
		expect(slot?.transformOverride).toEqual({
			position: {
				x: 120,
				y: -320 * (previewBalancedTop.height / projectBalancedTop.height),
			},
			scale: 1.4,
		});
		expect(slot?.transformOverridesBySlotId?.["balanced:top"]).toEqual({
			position: {
				x: 120,
				y: -320 * (previewBalancedTop.height / projectBalancedTop.height),
			},
			scale: 1.4,
		});
		expect(slot?.transformOverridesBySlotId?.["unbalanced:top"]).toEqual({
			position: {
				x: 90,
				y: -260 * (previewUnbalancedTop.height / projectUnbalancedTop.height),
			},
			scale: 1.3,
		});
	});
});
