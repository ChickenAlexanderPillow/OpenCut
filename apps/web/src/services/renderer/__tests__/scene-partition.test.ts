import { describe, expect, test } from "bun:test";
import { splitSceneForHybridPreview } from "@/services/renderer/scene-partition";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { SplitScreenNode } from "@/services/renderer/nodes/split-screen-node";
import { ImageNode } from "@/services/renderer/nodes/image-node";

describe("scene-partition", () => {
	test("treats SplitScreenNode as GPU-eligible", () => {
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

		const externalImageNode = new ImageNode({
			duration: 5,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 0,
			transform: {
				position: { x: 0, y: 0 },
				scale: 1,
				rotate: 0,
			},
			opacity: 1,
			url: "https://example.com/image.png",
		});

		const splitNode = new SplitScreenNode({
			duration: 5,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 0,
			transform: {
				position: { x: 0, y: 0 },
				scale: 1,
				rotate: 0,
			},
			opacity: 1,
			url: "blob:test",
			file: new File(["test"], "clip.mp4", { type: "video/mp4" }),
			mediaId: "media-1",
			reframePresets: [
				{
					id: "subject-left",
					name: "Subject Left",
					transform: {
						position: { x: -180, y: 0 },
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
			externalSlotNodesByElementId: new Map([
				["image-broll", externalImageNode],
			]),
			videoCache: {
				getGPUFrameAt: async () => null,
				getFrameAt: async () => null,
			} as never,
		});

		const rootNode = new RootNode({ duration: 5 });
		rootNode.add(splitNode);
		const partition = splitSceneForHybridPreview({
			rootNode,
		});

		expect(partition.supported).toBe(true);
		expect(partition.gpuNodes).toEqual([splitNode]);
	});
});
