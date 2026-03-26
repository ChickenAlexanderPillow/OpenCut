import { describe, expect, test } from "bun:test";
import { ImageNode } from "@/services/renderer/nodes/image-node";
import { SplitScreenNode } from "@/services/renderer/nodes/split-screen-node";

describe("SplitScreenNode WebGPU mixed-source rendering", () => {
	test("returns GPU draw data for host video plus external image slot", async () => {
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

		const node = new SplitScreenNode({
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
				getGPUFrameAt: async () => ({
					frame: {} as GPUCopyExternalImageSource,
					timestamp: 0,
					duration: 1 / 30,
					width: 1920,
					height: 1080,
				}),
				getFrameAt: async () => null,
			} as never,
		});

		const draws = await node.getWebGPUDrawData({
			time: 0.5,
			rendererWidth: 1080,
			rendererHeight: 1920,
		});

		expect(draws).not.toBeNull();
		expect(draws?.length).toBe(3);

		const [topDraw, bottomDraw, dividerDraw] = draws ?? [];
		expect(topDraw?.clipRect).toEqual({ x: 0, y: 0, width: 1080, height: 959 });
		expect(bottomDraw?.clipRect).toEqual({
			x: 0,
			y: 961,
			width: 1080,
			height: 959,
		});
		expect(topDraw?.source).toBeDefined();
		expect(bottomDraw?.source).toBeDefined();
		expect(bottomDraw?.source).not.toBe(topDraw?.source);
		expect(dividerDraw?.solidColor).toBe("#000000");
	});

	test("applies external slot offset and scale overrides in WebGPU draws", async () => {
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

		const node = new SplitScreenNode({
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
						transformOverride: {
							position: { x: 40, y: -30 },
							scale: 1.2,
						},
					},
				],
				sections: [],
			},
			externalSlotNodesByElementId: new Map([
				["image-broll", externalImageNode],
			]),
			videoCache: {
				getGPUFrameAt: async () => ({
					frame: {} as GPUCopyExternalImageSource,
					timestamp: 0,
					duration: 1 / 30,
					width: 1920,
					height: 1080,
				}),
				getFrameAt: async () => null,
			} as never,
		});

		const draws = await node.getWebGPUDrawData({
			time: 0.5,
			rendererWidth: 1080,
			rendererHeight: 1920,
		});

		const [, bottomDraw] = draws ?? [];
		expect(bottomDraw?.clipRect).toEqual({
			x: 0,
			y: 961,
			width: 1080,
			height: 959,
		});
		expect(bottomDraw?.width).toBeCloseTo(1150.8, 1);
		expect(bottomDraw?.height).toBeCloseTo(1150.8, 1);
		expect(bottomDraw?.x).toBeCloseTo(4.6, 1);
		expect(bottomDraw?.y).toBeCloseTo(835.1, 1);
	});
});
