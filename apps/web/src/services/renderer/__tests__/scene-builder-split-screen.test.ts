import { describe, expect, test } from "bun:test";
import { buildScene } from "@/services/renderer/scene-builder";
import { ImageNode } from "@/services/renderer/nodes/image-node";
import { SplitScreenNode } from "@/services/renderer/nodes/split-screen-node";
import type { ImageElement, VideoElement, VideoTrack } from "@/types/timeline";

describe("scene builder mixed-source split screen", () => {
	test("builds a split-screen compositor for host video plus external image source", () => {
		Object.defineProperty(globalThis, "Image", {
			value: class {
				naturalWidth = 1080;
				naturalHeight = 1080;
				onload: (() => void) | null = null;
				onerror: (() => void) | null = null;

				set src(_value: string) {
					this.onload?.();
				}
			},
			configurable: true,
		});

		const hostVideo: VideoElement = {
			id: "video-host",
			type: "video",
			mediaId: "video-asset",
			name: "Host Video",
			startTime: 0,
			duration: 5,
			trimStart: 0,
			trimEnd: 0,
			transform: {
				position: { x: 0, y: 0 },
				scale: 1,
				rotate: 0,
			},
			opacity: 1,
			reframePresets: [
				{
					id: "subject-left",
					name: "Subject Left",
					transform: {
						position: { x: -120, y: 0 },
						scale: 2,
					},
				},
			],
			defaultReframePresetId: "subject-left",
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "subject-left" },
					{
						slotId: "bottom",
						mode: "follow-active",
						sourceElementId: "image-broll",
					},
				],
				sections: [],
			},
		};

		const brollImage: ImageElement = {
			id: "image-broll",
			type: "image",
			mediaId: "image-asset",
			name: "B-roll",
			startTime: 0,
			duration: 5,
			trimStart: 0,
			trimEnd: 0,
			transform: {
				position: { x: 0, y: 0 },
				scale: 1,
				rotate: 0,
			},
			opacity: 1,
		};

		const scene = buildScene({
			tracks: [
				{
					id: "track-broll",
					type: "video",
					name: "B-roll",
					isMain: false,
					muted: false,
					hidden: false,
					elements: [brollImage],
				} satisfies VideoTrack,
				{
					id: "track-host",
					type: "video",
					name: "Host",
					isMain: true,
					muted: false,
					hidden: false,
					elements: [hostVideo],
				} satisfies VideoTrack,
			],
			mediaAssets: [
				{
					id: "video-asset",
					name: "video.mp4",
					type: "video",
					width: 1920,
					height: 1080,
					duration: 5,
					file: new File(["video"], "video.mp4", { type: "video/mp4" }),
					url: "https://example.com/video.mp4",
				},
				{
					id: "image-asset",
					name: "image.png",
					type: "image",
					width: 1080,
					height: 1080,
					duration: 5,
					file: new File(["image"], "image.png", { type: "image/png" }),
					url: "https://example.com/image.png",
				},
			],
			duration: 5,
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		});

		const splitNode = scene.children.find(
			(node) => node instanceof SplitScreenNode,
		) as SplitScreenNode | undefined;
		expect(splitNode).toBeDefined();

		const standaloneImageNode = scene.children.find(
			(node) => node instanceof ImageNode,
		) as ImageNode | undefined;
		expect(standaloneImageNode).toBeDefined();
		expect(standaloneImageNode?.params.suppressDuringRanges).toEqual([
			{ startTime: 0, endTime: 5 },
		]);
	});
});
