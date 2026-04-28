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
			reframeSeededBy: "subject-aware-v1",
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
		expect(topDraw?.clipRect).toEqual({ x: 0, y: 0, width: 1080, height: 959 });
		expect(bottomDraw?.clipRect).toEqual({
			x: 0,
			y: 961,
			width: 1080,
			height: 959,
		});
		expect(topDraw?.y).toBe(bottomDraw?.y);
		expect(topDraw?.height).toBe(bottomDraw?.height);
		expect(topDraw && topDraw.height > 959).toBe(true);
		expect(bottomDraw && bottomDraw.height > 959).toBe(true);
		expect(topDraw?.y).toBeGreaterThanOrEqual(0);
		expect(topDraw?.y).toBeLessThan(959);
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
			reframeSeededBy: "subject-aware-v1",
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
		expect(topDraw?.clipRect).toEqual({ x: 0, y: 0, width: 1080, height: 639 });
		expect(bottomDraw?.clipRect).toEqual({
			x: 0,
			y: 641,
			width: 1080,
			height: 1279,
		});
		expect(dividerDraw?.solidColor).toBe("#000000");
		expect(dividerDraw?.opacity).toBe(1);
		expect(dividerDraw?.blendMode).toBe("normal");
		expect(dividerDraw?.y).toBe(639);
		expect(dividerDraw?.height).toBe(2);
	});

	test("skips transparent split slots so lower timeline media can show through", async () => {
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
			reframeSeededBy: "subject-aware-v1",
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
					{
						slotId: "top",
						mode: "fixed-preset",
						presetId: "subject-left",
						isTransparent: true,
					},
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
		expect(draws?.length).toBe(1);
		expect(draws?.[0]?.clipRect).toEqual({
			x: 0,
			y: 961,
			width: 1080,
			height: 959,
		});
	});

	test("holds the previous canvas frame when a later decode lookup misses", async () => {
		const firstCanvas = { width: 1920, height: 1080 } as HTMLCanvasElement;
		let frameCallCount = 0;
		const node = new VideoNode({
			duration: 4,
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
			videoCache: {
				getGPUFrameAt: async () => null,
				getFrameAt: async () => {
					frameCallCount += 1;
					if (frameCallCount === 1) {
						return {
							canvas: firstCanvas,
							timestamp: 0,
							duration: 1 / 30,
						};
					}
					return null;
				},
			} as never,
		});

		const firstDraws = await node.getWebGPUDrawData({
			time: 0,
			rendererWidth: 1920,
			rendererHeight: 1080,
		});
		const secondDraws = await node.getWebGPUDrawData({
			time: 1 / 30,
			rendererWidth: 1920,
			rendererHeight: 1080,
		});

		expect(firstDraws?.[0]?.source).toBe(firstCanvas);
		expect(secondDraws?.[0]?.source).toBe(firstCanvas);
	});
});
