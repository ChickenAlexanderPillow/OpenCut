import { describe, expect, test } from "bun:test";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { TextNode } from "@/services/renderer/nodes/text-node";
import type { CanvasRenderer } from "@/services/renderer/canvas-renderer";

type FakeContext = {
	save: () => void;
	restore: () => void;
	measureText: (text: string) => TextMetrics;
	fillText: (...args: unknown[]) => void;
	strokeText: (...args: unknown[]) => void;
	fillRect: (...args: unknown[]) => void;
	roundRect: (...args: unknown[]) => void;
	beginPath: () => void;
	closePath: () => void;
	fill: () => void;
	stroke: () => void;
	translate: (...args: unknown[]) => void;
	scale: (...args: unknown[]) => void;
	setTransform: (...args: unknown[]) => void;
	font: string;
	textAlign: CanvasTextAlign;
	fillStyle: string;
	strokeStyle: string;
	lineWidth: number;
	lineJoin: CanvasLineJoin;
	miterLimit: number;
	textBaseline: CanvasTextBaseline;
	globalAlpha: number;
	letterSpacing?: string;
};

function createFakeRenderer() {
	const operations: string[] = [];
	const translations: Array<[number, number]> = [];
	const context: FakeContext = {
		save: () => operations.push("save"),
		restore: () => operations.push("restore"),
		measureText: (text) =>
			({
				width: text.length * 10,
				actualBoundingBoxAscent: 10,
				actualBoundingBoxDescent: 2,
			}) as TextMetrics,
		fillText: () => operations.push("fillText"),
		strokeText: () => operations.push("strokeText"),
		fillRect: () => operations.push("fillRect"),
		roundRect: () => operations.push("roundRect"),
		beginPath: () => operations.push("beginPath"),
		closePath: () => operations.push("closePath"),
		fill: () => operations.push("fill"),
		stroke: () => operations.push("stroke"),
		translate: (...args) => {
			operations.push("translate");
			translations.push([Number(args[0] ?? 0), Number(args[1] ?? 0)]);
		},
		scale: () => operations.push("scale"),
		setTransform: () => operations.push("setTransform"),
		font: "",
		textAlign: "center",
		fillStyle: "#ffffff",
		strokeStyle: "#000000",
		lineWidth: 0,
		lineJoin: "round",
		miterLimit: 0,
		textBaseline: "alphabetic",
		globalAlpha: 1,
	};

	return {
		operations,
		translations,
		renderer: {
			context,
			width: 1280,
			height: 720,
			fps: 30,
		} as CanvasRenderer,
	};
}

function createCaptionNode() {
	return new TextNode({
		...DEFAULT_TEXT_ELEMENT,
		id: "caption-1",
		name: "Caption 1",
		content: "hello world again",
		startTime: 10,
		duration: 2,
		canvasCenter: { x: 640, y: 360 },
		canvasWidth: 1280,
		canvasHeight: 720,
		captionWordTimings: [
			{ word: "hello", startTime: 10.0, endTime: 10.4 },
			{ word: "world", startTime: 10.8, endTime: 11.2 },
			{ word: "again", startTime: 11.2, endTime: 11.6 },
		],
	});
}

describe("TextNode caption gap rendering", () => {
	test("hides captions when timeline time falls inside an explicit visibility gap", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionVisibilityWindows: [
				{ startTime: 10.0, endTime: 10.45 },
				{ startTime: 10.8, endTime: 11.6 },
			],
		});
		const { operations, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 10.6 });

		expect(operations).toEqual([]);
	});

	test("still renders captions at word boundaries without a visibility gap", async () => {
		const node = createCaptionNode();
		const { operations, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 10.39 });

		expect(operations).toContain("fillText");
		expect(operations.at(-1)).toBe("restore");
	});

	test("falls back to the last caption word end when no visibility windows are present", async () => {
		const node = createCaptionNode();
		const { operations, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 11.8 });

		expect(operations).toEqual([]);
	});

	test("does not keep the last visible caption on screen for trailing hidden timings", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionWordTimings: [
				{ word: "hello", startTime: 10.0, endTime: 10.4 },
				{ word: "ghost", startTime: 10.4, endTime: 11.2, hidden: true },
			],
		});
		const { operations, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 10.8 });

		expect(operations).toEqual([]);
	});

	test("anchors captions into the active split viewport when linked video is split", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionStyle: {
				anchorToSafeAreaBottom: true,
				safeAreaBottomOffset: 0,
				splitScreenOverrides: {
					slotAnchor: "bottom",
				},
			},
			captionSourceVideo: {
				startTime: 10,
				duration: 2,
				trimStart: 0,
				reframePresets: [
					{
						id: "subject-left",
						name: "Subject Left",
						transform: {
							position: { x: -120, y: 0 },
							scale: 2,
						},
					},
					{
						id: "subject-right",
						name: "Subject Right",
						transform: {
							position: { x: 120, y: 0 },
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
			},
		});
		const { operations, renderer, translations } = createFakeRenderer();

		await node.render({ renderer, time: 10.39 });

		expect(operations).toContain("fillText");
		expect(translations.length).toBeGreaterThan(0);
		expect((translations[0]?.[1] ?? 0) > 360).toBe(true);
	});

	test("anchors unbalanced split captions just below the divider", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionStyle: {
				anchorToSafeAreaBottom: true,
				safeAreaBottomOffset: 0,
				splitScreenOverrides: {
					slotAnchor: "bottom",
				},
			},
			captionSourceVideo: {
				startTime: 10,
				duration: 2,
				trimStart: 0,
				reframePresets: [
					{
						id: "subject-left",
						name: "Subject Left",
						transform: {
							position: { x: -120, y: 0 },
							scale: 2,
						},
					},
					{
						id: "subject-right",
						name: "Subject Right",
						transform: {
							position: { x: 120, y: 0 },
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
			},
		});
		const { operations, renderer, translations } = createFakeRenderer();

		await node.render({ renderer, time: 10.39 });

		expect(operations).toContain("fillText");
		expect(translations.length).toBeGreaterThan(0);
		expect((translations[0]?.[1] ?? 0) > 240).toBe(true);
		expect((translations[0]?.[1] ?? 0) < 360).toBe(true);
	});

	test("forces unbalanced split captions onto the lower side even if top anchor is selected", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionStyle: {
				anchorToSafeAreaBottom: true,
				safeAreaBottomOffset: 0,
				splitScreenOverrides: {
					slotAnchor: "top",
				},
			},
			captionSourceVideo: {
				startTime: 10,
				duration: 2,
				trimStart: 0,
				reframePresets: [
					{
						id: "subject-left",
						name: "Subject Left",
						transform: {
							position: { x: -120, y: 0 },
							scale: 2,
						},
					},
					{
						id: "subject-right",
						name: "Subject Right",
						transform: {
							position: { x: 120, y: 0 },
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
			},
		});
		const { operations, renderer, translations } = createFakeRenderer();

		await node.render({ renderer, time: 10.39 });

		expect(operations).toContain("fillText");
		expect((translations[0]?.[1] ?? 0) > 240).toBe(true);
		expect((translations[0]?.[1] ?? 0) < 360).toBe(true);
	});

});
