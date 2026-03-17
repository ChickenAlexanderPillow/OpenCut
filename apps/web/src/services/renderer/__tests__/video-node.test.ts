import { describe, expect, test } from "bun:test";
import { VideoNode } from "@/services/renderer/nodes/video-node";

describe("VideoNode split-screen placement", () => {
	test("keeps top and bottom split draws aligned to the full vertical canvas", async () => {
		const node = new VideoNode({
			duration: 4,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 0,
			transform: {
				position: { x: 0, y: 0 },
				scale: 2,
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
				{
					id: "subject-right",
					name: "Subject Right",
					transform: {
						position: { x: 180, y: 0 },
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
					{ slotId: "bottom", mode: "fixed-preset", presetId: "subject-right" },
				],
				sections: [],
			},
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

		const [topDraw, bottomDraw] = draws ?? [];
		expect(topDraw?.clipRect).toEqual({ x: 0, y: 0, width: 1080, height: 960 });
		expect(bottomDraw?.clipRect).toEqual({
			x: 0,
			y: 960,
			width: 1080,
			height: 960,
		});
		expect(topDraw?.y).toBe(bottomDraw?.y);
		expect(topDraw?.height).toBe(bottomDraw?.height);
		expect(topDraw && topDraw.height > 960).toBe(true);
		expect(bottomDraw && bottomDraw.height > 960).toBe(true);
		expect(topDraw?.y).toBeGreaterThanOrEqual(0);
		expect(topDraw?.y).toBeLessThan(960);
	});

	test("adds a divider draw and supports unbalanced split viewports", async () => {
		const node = new VideoNode({
			duration: 4,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 0,
			transform: {
				position: { x: 0, y: 0 },
				scale: 2,
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
				{
					id: "subject-right",
					name: "Subject Right",
					transform: {
						position: { x: 180, y: 0 },
						scale: 2,
					},
				},
			],
			defaultReframePresetId: "subject-left",
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				viewportBalance: "unbalanced",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "subject-left" },
					{ slotId: "bottom", mode: "fixed-preset", presetId: "subject-right" },
				],
				sections: [],
			},
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
		expect(topDraw?.clipRect).toEqual({ x: 0, y: 0, width: 1080, height: 640 });
		expect(bottomDraw?.clipRect).toEqual({
			x: 0,
			y: 640,
			width: 1080,
			height: 1280,
		});
		expect(dividerDraw?.solidColor).toBe("#000000");
		expect(dividerDraw?.y).toBeGreaterThanOrEqual(637);
		expect(dividerDraw?.y).toBeLessThanOrEqual(639);
	});
});
