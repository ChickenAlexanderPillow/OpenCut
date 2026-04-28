import { describe, expect, test } from "bun:test";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS } from "@/lib/transcript-editor/constants";
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
	shadowColor: string;
	shadowBlur: number;
	shadowOffsetX: number;
	shadowOffsetY: number;
	textBaseline: CanvasTextBaseline;
	globalAlpha: number;
	letterSpacing?: string;
};

function createFakeRenderer() {
	const operations: string[] = [];
	const translations: Array<[number, number]> = [];
	const filledTexts: string[] = [];
	const context: FakeContext = {
		save: () => operations.push("save"),
		restore: () => operations.push("restore"),
		measureText: (text) =>
			({
				width: text.length * 10,
				actualBoundingBoxAscent: 10,
				actualBoundingBoxDescent: 2,
			}) as TextMetrics,
		fillText: (...args) => {
			operations.push("fillText");
			filledTexts.push(String(args[0] ?? ""));
		},
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
		shadowColor: "transparent",
		shadowBlur: 0,
		shadowOffsetX: 0,
		shadowOffsetY: 0,
		textBaseline: "alphabetic",
		globalAlpha: 1,
	};

	return {
		context,
		operations,
		translations,
		filledTexts,
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

function createKaraokeCaptionNode(
	captionWordTimings: Array<{
		word: string;
		startTime: number;
		endTime: number;
	}>,
) {
	return new TextNode({
		...DEFAULT_TEXT_ELEMENT,
		id: "caption-karaoke",
		name: "Caption Karaoke",
		content: captionWordTimings.map((timing) => timing.word).join(" "),
		startTime: 10,
		duration: 2,
		canvasCenter: { x: 640, y: 360 },
		canvasWidth: 1280,
		canvasHeight: 720,
		background: {
			...DEFAULT_TEXT_ELEMENT.background,
			color: "transparent",
		},
		captionStyle: {
			karaokeWordHighlight: true,
			karaokeHighlightMode: "block",
		},
		captionWordTimings,
	});
}

describe("TextNode caption gap rendering", () => {
	test("keeps karaoke highlight on the previous word during sub-threshold gaps", async () => {
		const node = createKaraokeCaptionNode([
			{ word: "hello", startTime: 10.0, endTime: 10.4 },
			{ word: "world", startTime: 10.8, endTime: 11.2 },
		]);
		const { operations, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 10.6 });

		expect(operations).toContain("roundRect");
	});

	test("clears karaoke highlight when the gap reaches the transcript threshold", async () => {
		const node = createKaraokeCaptionNode([
			{ word: "hello", startTime: 10.0, endTime: 10.4 },
			{
				word: "world",
				startTime: 10.4 + MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS,
				endTime: 11.3,
			},
		]);
		const { operations, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 10.7 });

		expect(operations).not.toContain("roundRect");
	});

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

	test("hides captions before the first explicit visibility window", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionVisibilityWindows: [{ startTime: 10.8, endTime: 11.6 }],
		});
		const { operations, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 10.2 });

		expect(operations).toEqual([]);
	});

	test("hides captions after the last explicit visibility window", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionVisibilityWindows: [{ startTime: 10.0, endTime: 10.4 }],
		});
		const { operations, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 10.8 });

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

	test("does not preload post-pause words during a long pause when words on screen is limited", async () => {
		const node = new TextNode({
			...DEFAULT_TEXT_ELEMENT,
			id: "caption-window-long-pause",
			name: "Caption Window Long Pause",
			content: "hello world later",
			startTime: 10,
			duration: 2,
			canvasCenter: { x: 640, y: 360 },
			canvasWidth: 1280,
			canvasHeight: 720,
			captionStyle: {
				wordsOnScreen: 2,
			},
			captionWordTimings: [
				{ word: "hello", startTime: 10.0, endTime: 10.2 },
				{ word: "world", startTime: 10.2, endTime: 10.4 },
				{ word: "later", startTime: 11.0, endTime: 11.3 },
			],
		});
		const { filledTexts, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 10.6 });

		expect(filledTexts).toContain("hello");
		expect(filledTexts).toContain("world");
		expect(filledTexts).not.toContain("later");
	});

	test("keeps only already-started words visible during a short merged pause", async () => {
		const node = new TextNode({
			...DEFAULT_TEXT_ELEMENT,
			id: "caption-window-short-pause",
			name: "Caption Window Short Pause",
			content: "hello world later",
			startTime: 10,
			duration: 2,
			canvasCenter: { x: 640, y: 360 },
			canvasWidth: 1280,
			canvasHeight: 720,
			captionStyle: {
				wordsOnScreen: 2,
			},
			captionVisibilityWindows: [{ startTime: 10.0, endTime: 11.0 }],
			captionWordTimings: [
				{ word: "hello", startTime: 10.0, endTime: 10.2 },
				{ word: "world", startTime: 10.2, endTime: 10.4 },
				{ word: "later", startTime: 10.75, endTime: 11.0 },
			],
		});
		const { filledTexts, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 10.6 });

		expect(filledTexts).toContain("hello");
		expect(filledTexts).toContain("world");
		expect(filledTexts).not.toContain("later");
	});

	test("reveals the next word exactly at its start time after a pause", async () => {
		const node = new TextNode({
			...DEFAULT_TEXT_ELEMENT,
			id: "caption-window-boundary",
			name: "Caption Window Boundary",
			content: "hello world later",
			startTime: 10,
			duration: 2,
			canvasCenter: { x: 640, y: 360 },
			canvasWidth: 1280,
			canvasHeight: 720,
			captionStyle: {
				wordsOnScreen: 2,
			},
			captionWordTimings: [
				{ word: "hello", startTime: 10.0, endTime: 10.2 },
				{ word: "world", startTime: 10.2, endTime: 10.4 },
				{ word: "later", startTime: 11.0, endTime: 11.3 },
			],
		});
		const beforeBoundary = createFakeRenderer();
		await node.render({ renderer: beforeBoundary.renderer, time: 10.999 });
		expect(beforeBoundary.filledTexts).toContain("hello");
		expect(beforeBoundary.filledTexts).toContain("world");
		expect(beforeBoundary.filledTexts).not.toContain("later");

		const atBoundary = createFakeRenderer();
		await node.render({ renderer: atBoundary.renderer, time: 11.0 });
		expect(atBoundary.filledTexts).toContain("later");
	});

	test("restarts caption paging from the resumed window after a pause split", async () => {
		const node = new TextNode({
			...DEFAULT_TEXT_ELEMENT,
			id: "caption-window-resume",
			name: "Caption Window Resume",
			content: "looming in the uk market I think",
			startTime: 10,
			duration: 3,
			canvasCenter: { x: 640, y: 360 },
			canvasWidth: 1280,
			canvasHeight: 720,
			captionVisibilityWindows: [
				{ startTime: 10.0, endTime: 10.9 },
				{ startTime: 11.5, endTime: 12.2 },
			],
			captionWordTimings: [
				{ word: "looming", startTime: 10.0, endTime: 10.2 },
				{ word: "in", startTime: 10.2, endTime: 10.3 },
				{ word: "the", startTime: 10.3, endTime: 10.4 },
				{ word: "uk", startTime: 10.4, endTime: 10.55 },
				{ word: "market", startTime: 10.55, endTime: 10.85 },
				{ word: "I", startTime: 11.5, endTime: 11.65 },
				{ word: "think", startTime: 11.65, endTime: 12.2 },
			],
		});
		const { filledTexts, renderer } = createFakeRenderer();

		await node.render({ renderer, time: 11.6 });

		expect(filledTexts).toContain("I");
		expect(filledTexts).not.toContain("looming");
		expect(filledTexts).not.toContain("market");
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
						{
							slotId: "bottom",
							mode: "fixed-preset",
							presetId: "subject-right",
						},
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

	test("defaults auto split anchor to the divider center for bottom-anchored captions", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionStyle: {
				anchorToSafeAreaBottom: true,
				safeAreaBottomOffset: 0,
				splitScreenOverrides: {
					dividerPlacement: "on-divider",
				},
			},
			captionSourceVideo: {
				startTime: 10,
				duration: 2,
				trimStart: 0,
				defaultReframePresetId: "subject-left",
				splitScreen: {
					enabled: true,
					layoutPreset: "top-bottom",
					viewportBalance: "unbalanced",
					slots: [
						{ slotId: "top", mode: "fixed-preset", presetId: "subject-left" },
						{
							slotId: "bottom",
							mode: "fixed-preset",
							presetId: "subject-right",
						},
					],
					sections: [],
				},
			},
		});
		const { operations, renderer, translations } = createFakeRenderer();

		await node.render({ renderer, time: 10.39 });

		expect(operations).toContain("fillText");
		expect(translations.length).toBeGreaterThan(0);
		expect((translations[0]?.[1] ?? 0) > 223).toBe(true);
		expect((translations[0]?.[1] ?? 0) < 233).toBe(true);
	});

	test("ignores top slot preference for unbalanced bottom-anchored captions and keeps them in the bottom slot", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionStyle: {
				anchorToSafeAreaBottom: true,
				safeAreaBottomOffset: 0,
				splitScreenOverrides: {
					dividerPlacement: "on-divider",
					slotAnchor: "top",
				},
			},
			captionSourceVideo: {
				startTime: 10,
				duration: 2,
				trimStart: 0,
				defaultReframePresetId: "subject-left",
				splitScreen: {
					enabled: true,
					layoutPreset: "top-bottom",
					viewportBalance: "unbalanced",
					slots: [
						{ slotId: "top", mode: "fixed-preset", presetId: "subject-left" },
						{
							slotId: "bottom",
							mode: "fixed-preset",
							presetId: "subject-right",
						},
					],
					sections: [],
				},
			},
		});
		const { operations, renderer, translations } = createFakeRenderer();

		await node.render({ renderer, time: 10.39 });

		expect(operations).toContain("fillText");
		expect(translations.length).toBeGreaterThan(0);
		expect((translations[0]?.[1] ?? 0) > 223).toBe(true);
		expect((translations[0]?.[1] ?? 0) < 233).toBe(true);
	});

test("anchors unbalanced split captions to the divider center", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionStyle: {
				anchorToSafeAreaBottom: true,
				safeAreaBottomOffset: 0,
				splitScreenOverrides: {
					dividerPlacement: "on-divider",
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
						{
							slotId: "bottom",
							mode: "fixed-preset",
							presetId: "subject-right",
						},
					],
					sections: [],
				},
			},
		});
		const { operations, renderer, translations } = createFakeRenderer();

		await node.render({ renderer, time: 10.39 });

		expect(operations).toContain("fillText");
		expect(translations.length).toBeGreaterThan(0);
		expect((translations[0]?.[1] ?? 0) > 223).toBe(true);
		expect((translations[0]?.[1] ?? 0) < 233).toBe(true);
	});

	test("keeps divider-centered captions vertically stable as caption words change", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionWordTimings: [
				{ word: "HI", startTime: 10.0, endTime: 10.4 },
				{ word: "gy", startTime: 10.4, endTime: 10.8 },
			],
			captionStyle: {
				anchorToSafeAreaBottom: true,
				safeAreaBottomOffset: 0,
				wordsOnScreen: 1,
				splitScreenOverrides: {
					dividerPlacement: "on-divider",
				},
			},
			captionSourceVideo: {
				startTime: 10,
				duration: 2,
				trimStart: 0,
				defaultReframePresetId: "subject-left",
				splitScreen: {
					enabled: true,
					layoutPreset: "top-bottom",
					viewportBalance: "unbalanced",
					slots: [
						{ slotId: "top", mode: "fixed-preset", presetId: "subject-left" },
						{
							slotId: "bottom",
							mode: "fixed-preset",
							presetId: "subject-right",
						},
					],
					sections: [],
				},
			},
		});
		const { renderer, translations } = createFakeRenderer();
		renderer.context.measureText = ((text: string) =>
			({
				width: text.length * 10,
				actualBoundingBoxAscent: text.includes("g") ? 8 : 10,
				actualBoundingBoxDescent: text.includes("g") ? 6 : 2,
			}) as TextMetrics) satisfies typeof renderer.context.measureText;

		await node.render({ renderer, time: 10.2 });
		await node.render({ renderer, time: 10.6 });

		expect(translations).toHaveLength(2);
		expect(translations[0]?.[1]).toBe(translations[1]?.[1]);
	});

	test("applies split-screen font and background padding overrides", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			background: {
				...DEFAULT_TEXT_ELEMENT.background,
				color: "#000000b9",
			},
			captionStyle: {
				anchorToSafeAreaBottom: true,
				safeAreaBottomOffset: 0,
				splitScreenOverrides: {
					slotAnchor: "bottom",
					fontSize: 4,
					backgroundPaddingY:
						(DEFAULT_TEXT_ELEMENT.background.paddingY ?? 0) - 5,
				},
			},
			captionSourceVideo: {
				startTime: 10,
				duration: 2,
				trimStart: 0,
				defaultReframePresetId: "subject-left",
				splitScreen: {
					enabled: true,
					layoutPreset: "top-bottom",
					slots: [
						{ slotId: "top", mode: "fixed-preset", presetId: "subject-left" },
						{
							slotId: "bottom",
							mode: "fixed-preset",
							presetId: "subject-right",
						},
					],
					sections: [],
				},
			},
		});
		const { renderer, context } = createFakeRenderer();

		await node.render({ renderer, time: 10.39 });

		expect(context.font).toContain("32px");
	});

	test("keeps unbalanced split captions above the divider when top anchor is selected", async () => {
		const node = new TextNode({
			...createCaptionNode().params,
			captionStyle: {
				anchorToSafeAreaBottom: false,
				anchorToSafeAreaTop: true,
				safeAreaTopOffset: 0,
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
						{
							slotId: "bottom",
							mode: "fixed-preset",
							presetId: "subject-right",
						},
					],
					sections: [],
				},
			},
		});
		const { operations, renderer, translations } = createFakeRenderer();

		await node.render({ renderer, time: 10.39 });

		expect(operations).toContain("fillText");
		expect((translations[0]?.[1] ?? 0) < 240).toBe(true);
	});

	test("renders shadow and outline passes before the caption fill", async () => {
		const node = createCaptionNode();
		node.params.strokeWidth = 3;
		node.params.strokeSoftness = 4;
		node.params.shadowColor = "#000000";
		node.params.shadowOpacity = 0.7;
		node.params.shadowDistance = 8;
		node.params.shadowAngle = 90;
		node.params.shadowSoftness = 6;

		const { operations, renderer } = createFakeRenderer();
		await node.render({ renderer, time: 10.2 });

		expect(
			operations.filter((operation) => operation === "strokeText").length,
		).toBeGreaterThanOrEqual(2);
		expect(
			operations.filter((operation) => operation === "fillText").length,
		).toBeGreaterThanOrEqual(3);
		expect(operations.indexOf("strokeText")).toBeLessThan(
			operations.lastIndexOf("fillText"),
		);
	});
});
