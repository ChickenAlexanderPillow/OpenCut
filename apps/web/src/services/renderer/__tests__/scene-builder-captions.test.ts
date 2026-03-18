import { describe, expect, test } from "bun:test";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import {
	buildScene,
	resolveLiveCaptionElementFromTranscriptSource,
} from "@/services/renderer/scene-builder";
import type {
	AudioElement,
	TextElement,
	UploadAudioElement,
	VideoElement,
} from "@/types/timeline";

function createAudioElement({
	id,
	startTime,
	duration,
	words,
}: {
	id: string;
	startTime: number;
	duration: number;
	words: Array<{
		id: string;
		text: string;
		startTime: number;
		endTime: number;
		hidden?: boolean;
		removed?: boolean;
	}>;
}): UploadAudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime,
		duration,
		trimStart: 0,
		trimEnd: 0,
		volume: 1,
		sourceType: "upload",
		mediaId: `${id}:media`,
		transcriptEdit: {
			version: 1,
			source: "word-level",
			words,
			cuts: [],
			updatedAt: new Date().toISOString(),
		},
	};
}

function createCaption({
	sourceMediaElementId,
}: {
	sourceMediaElementId: string;
}): TextElement {
	return {
		...DEFAULT_TEXT_ELEMENT,
		id: "caption-1",
		name: "Caption 1",
		content: "stale content",
		startTime: 99,
		duration: 1,
		captionWordTimings: [{ word: "stale", startTime: 99, endTime: 100 }],
		captionSourceRef: {
			mediaElementId: sourceMediaElementId,
			transcriptVersion: 1,
		},
	};
}

describe("scene builder live caption source resolution", () => {
	test("recalculates caption timings from transcript words and removed state", () => {
		const source = createAudioElement({
			id: "audio-1",
			startTime: 10,
			duration: 2,
			words: [
				{ id: "w0", text: "skip", startTime: 0, endTime: 0.4, removed: true },
				{ id: "w1", text: "go", startTime: 0.5, endTime: 0.9, removed: false },
			],
		});
		const caption = createCaption({ sourceMediaElementId: source.id });

		const resolved = resolveLiveCaptionElementFromTranscriptSource({
			element: caption,
			sourceMedia: source,
		});

		expect(resolved).not.toBeNull();
		if (!resolved) return;
		expect(resolved.content).toBe("go");
		expect(resolved.startTime).toBeCloseTo(10.0, 3);
		expect(resolved.captionWordTimings?.[0]?.startTime).toBeCloseTo(10.0, 3);
		expect(resolved.captionWordTimings?.[0]?.endTime).toBeCloseTo(10.4, 3);
		expect(resolved.captionVisibilityWindows).toEqual([
			{ startTime: 10.5, endTime: 12 },
		]);
	});

	test("returns null when transcript no longer has active words", () => {
		const source = createAudioElement({
			id: "audio-1",
			startTime: 10,
			duration: 2,
			words: [
				{ id: "w0", text: "skip", startTime: 0, endTime: 0.4, removed: true },
			],
		});
		const caption = createCaption({ sourceMediaElementId: source.id });

		const resolved = resolveLiveCaptionElementFromTranscriptSource({
			element: caption,
			sourceMedia: source,
		});
		expect(resolved).toBeNull();
	});

	test("prefers exact caption source media over companion transcript candidates", () => {
		const source = createAudioElement({
			id: "audio-1",
			startTime: 10,
			duration: 2,
			words: [
				{ id: "shared:word:0", text: "alpha", startTime: 0, endTime: 0.4 },
			],
		});
		const companion = createAudioElement({
			id: "audio-2",
			startTime: 10,
			duration: 2,
			words: [
				{ id: "shared:word:0", text: "beta", startTime: 0, endTime: 0.5 },
			],
		});
		const caption = createCaption({ sourceMediaElementId: source.id });

		const scene = buildScene({
			tracks: [
				{
					id: "audio-track",
					type: "audio",
					name: "Audio",
					muted: false,
					elements: [source, companion],
				},
				{
					id: "text-track",
					type: "text",
					name: "Captions",
					hidden: false,
					elements: [caption],
				},
			],
			mediaAssets: [],
			duration: 20,
			canvasSize: { width: 1280, height: 720 },
			background: { type: "color", color: "#000000" },
		});

		const textNode = scene.children.find(
			(node) => node.constructor.name === "TextNode",
		) as { params?: { content?: string } } | undefined;
		expect(textNode?.params?.content).toBe("alpha");
	});

	test("uses aligned companion transcript when explicit source media has been deduped", () => {
		const source: AudioElement = {
			...createAudioElement({
				id: "audio-1",
				startTime: 10,
				duration: 2,
				words: [
					{ id: "shared:word:0", text: "stale", startTime: 0, endTime: 0.4 },
				],
			}),
			mediaId: "shared-media",
			transcriptDraft: undefined,
			transcriptApplied: undefined,
			transcriptEdit: undefined,
		};
		const companion: AudioElement = {
			...createAudioElement({
				id: "audio-2",
				startTime: 10,
				duration: 2,
				words: [
					{ id: "shared:word:0", text: "hello", startTime: 0, endTime: 0.4 },
					{
						id: "shared:word:1",
						text: "world",
						startTime: 0.45,
						endTime: 0.8,
						hidden: true,
					},
				],
			}),
			mediaId: "shared-media",
		};
		const caption = createCaption({ sourceMediaElementId: source.id });

		const scene = buildScene({
			tracks: [
				{
					id: "audio-track",
					type: "audio",
					name: "Audio",
					muted: false,
					elements: [source, companion],
				},
				{
					id: "text-track",
					type: "text",
					name: "Captions",
					hidden: false,
					elements: [caption],
				},
			],
			mediaAssets: [],
			duration: 20,
			canvasSize: { width: 1280, height: 720 },
			background: { type: "color", color: "#000000" },
		});

		const textNode = scene.children.find(
			(node) => node.constructor.name === "TextNode",
		) as
			| {
					params?: {
						content?: string;
					};
			  }
			| undefined;
		expect(textNode?.params?.content).toBe("hello");
	});

	test("does not heuristically relink caption when explicit source ref is missing", () => {
		const transcriptCarrier = createAudioElement({
			id: "audio-2",
			startTime: 10,
			duration: 2,
			words: [
				{ id: "shared:word:0", text: "beta", startTime: 0, endTime: 0.5 },
			],
		});
		const caption = createCaption({ sourceMediaElementId: "audio-missing" });

		const scene = buildScene({
			tracks: [
				{
					id: "audio-track",
					type: "audio",
					name: "Audio",
					muted: false,
					elements: [transcriptCarrier],
				},
				{
					id: "text-track",
					type: "text",
					name: "Captions",
					hidden: false,
					elements: [caption],
				},
			],
			mediaAssets: [],
			duration: 20,
			canvasSize: { width: 1280, height: 720 },
			background: { type: "color", color: "#000000" },
		});

		const textNode = scene.children.find(
			(node) => node.constructor.name === "TextNode",
		) as { params?: { content?: string; startTime?: number } } | undefined;
		expect(textNode?.params?.content).toBe("stale content");
		expect(textNode?.params?.startTime).toBe(99);
	});

	test("muted middle word compresses timeline so caption does not wait for removed span", () => {
		const source = createAudioElement({
			id: "audio-1",
			startTime: 5,
			duration: 3,
			words: [
				{
					id: "w0",
					text: "first",
					startTime: 0.0,
					endTime: 0.3,
					removed: false,
				},
				{
					id: "w1",
					text: "muted",
					startTime: 0.6,
					endTime: 0.9,
					removed: true,
				},
				{
					id: "w2",
					text: "third",
					startTime: 1.0,
					endTime: 1.3,
					removed: false,
				},
			],
		});
		const caption = createCaption({ sourceMediaElementId: source.id });

		const resolved = resolveLiveCaptionElementFromTranscriptSource({
			element: caption,
			sourceMedia: source,
		});

		expect(resolved).not.toBeNull();
		if (!resolved) return;
		expect(resolved.content).toBe("first third");
		expect(resolved.captionWordTimings).toHaveLength(2);
		expect(resolved.captionWordTimings?.[0]?.word).toBe("first");
		expect(resolved.captionWordTimings?.[0]?.startTime).toBeCloseTo(5.0, 3);
		expect(resolved.captionWordTimings?.[1]?.word).toBe("third");
		// Removed gap is compressed out, so third starts immediately after first.
		const firstEnd = resolved.captionWordTimings?.[0]?.endTime ?? 0;
		const thirdStart = resolved.captionWordTimings?.[1]?.startTime ?? 0;
		expect(Math.abs(thirdStart - firstEnd)).toBeLessThanOrEqual(0.011);
	});

	test("recomputes caption timing when media moves without transcript edit changes", () => {
		const transcriptEdit: NonNullable<AudioElement["transcriptEdit"]> = {
			version: 1 as const,
			source: "word-level" as const,
			words: [
				{
					id: "w0",
					text: "hello",
					startTime: 0.0,
					endTime: 0.3,
					removed: false,
				},
				{
					id: "w1",
					text: "world",
					startTime: 0.35,
					endTime: 0.7,
					removed: false,
				},
			],
			cuts: [],
			updatedAt: "2026-03-06T12:00:00.000Z",
		};
		const sourceAtTen: AudioElement = {
			...createAudioElement({
				id: "audio-1",
				startTime: 10,
				duration: 2,
				words: transcriptEdit.words,
			}),
			transcriptEdit,
		};
		const sourceAtFourteen: AudioElement = {
			...sourceAtTen,
			startTime: 14,
			transcriptEdit,
		};
		const caption = createCaption({ sourceMediaElementId: sourceAtTen.id });

		const first = resolveLiveCaptionElementFromTranscriptSource({
			element: caption,
			sourceMedia: sourceAtTen,
		});
		const moved = resolveLiveCaptionElementFromTranscriptSource({
			element: caption,
			sourceMedia: sourceAtFourteen,
		});

		expect(first).not.toBeNull();
		expect(moved).not.toBeNull();
		if (!first || !moved) return;
		expect(first.startTime).toBeCloseTo(10, 3);
		expect(first.captionWordTimings?.[0]?.startTime).toBeCloseTo(10, 3);
		expect(moved.startTime).toBeCloseTo(14, 3);
		expect(moved.captionWordTimings?.[0]?.startTime).toBeCloseTo(14, 3);
	});

	test("clamps caption visibility windows to clip bounds for projected transcript clips", () => {
		const source: AudioElement = {
			...createAudioElement({
				id: "audio-1",
				startTime: 20,
				duration: 1,
				words: [
					{ id: "w0", text: "hello", startTime: 0, endTime: 0.4 },
					{ id: "w1", text: "world", startTime: 0.45, endTime: 0.8 },
				],
			}),
			transcriptApplied: {
				version: 1,
				revisionKey: "projected",
				updatedAt: "2026-03-13T12:00:00.000Z",
				removedRanges: [],
				keptSegments: [{ start: 0, end: 3, duration: 3 }],
				timeMap: {
					cutBoundaries: [],
					sourceDuration: 3,
					playableDuration: 3,
				},
				captionPayload: {
					content: "hello world",
					startTime: 20,
					duration: 1,
					wordTimings: [
						{ word: "hello", startTime: 20, endTime: 20.4 },
						{ word: "world", startTime: 20.45, endTime: 20.8 },
					],
				},
			},
		};
		const caption = createCaption({ sourceMediaElementId: source.id });

		const resolved = resolveLiveCaptionElementFromTranscriptSource({
			element: caption,
			sourceMedia: source,
		});

		expect(resolved?.captionVisibilityWindows).toEqual([
			{ startTime: 20, endTime: 21 },
		]);
	});

	test("uses the strongly aligned split companion transcript instead of an adjacent sibling", () => {
		const leftVideo = {
			id: "video-left",
			type: "video" as const,
			name: "Left",
			mediaId: "shared-media",
			startTime: 0,
			duration: 1,
			trimStart: 0,
			trimEnd: 0,
			transform: DEFAULT_TEXT_ELEMENT.transform,
			opacity: 1,
		};
		const rightVideo = {
			id: "video-right",
			type: "video" as const,
			name: "Right",
			mediaId: "shared-media",
			startTime: 1,
			duration: 1,
			trimStart: 1,
			trimEnd: 0,
			transform: DEFAULT_TEXT_ELEMENT.transform,
			opacity: 1,
		};
		const leftAudio: AudioElement = {
			...createAudioElement({
				id: "audio-left",
				startTime: 0,
				duration: 1,
				words: [{ id: "w-left", text: "left", startTime: 0.0, endTime: 0.4 }],
			}),
			mediaId: "shared-media",
			trimStart: 0,
		};
		const rightAudio: AudioElement = {
			...createAudioElement({
				id: "audio-right",
				startTime: 1,
				duration: 1,
				words: [{ id: "w-right", text: "right", startTime: 0.0, endTime: 0.4 }],
			}),
			mediaId: "shared-media",
			trimStart: 1,
		};
		const caption = createCaption({ sourceMediaElementId: rightVideo.id });

		const scene = buildScene({
			tracks: [
				{
					id: "video-track",
					type: "video",
					name: "Video",
					isMain: true,
					muted: false,
					hidden: false,
					elements: [leftVideo, rightVideo],
				},
				{
					id: "audio-track",
					type: "audio",
					name: "Audio",
					muted: false,
					elements: [leftAudio, rightAudio],
				},
				{
					id: "text-track",
					type: "text",
					name: "Captions",
					hidden: false,
					elements: [caption],
				},
			],
			mediaAssets: [],
			duration: 20,
			canvasSize: { width: 1280, height: 720 },
			background: { type: "color", color: "#000000" },
		});

		const textNode = scene.children.find(
			(node) => node.constructor.name === "TextNode",
		) as
			| {
					params?: {
						content?: string;
						captionWordTimings?: Array<{ startTime: number; endTime: number }>;
					};
			  }
			| undefined;
		expect(textNode?.params?.content).toBe("right");
		expect(textNode?.params?.captionWordTimings?.[0]?.startTime).toBeCloseTo(
			1,
			3,
		);
	});

	test("passes split-screen config through to video nodes", () => {
		const video: VideoElement = {
			id: "video-1",
			type: "video",
			mediaId: "video-asset",
			name: "Video 1",
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
					id: "left",
					name: "Left",
					transform: {
						position: { x: -120, y: 0 },
						scale: 2,
					},
				},
				{
					id: "right",
					name: "Right",
					transform: {
						position: { x: 120, y: 0 },
						scale: 2,
					},
				},
			],
			defaultReframePresetId: "left",
			splitScreen: {
				enabled: true,
				layoutPreset: "top-bottom",
				slots: [
					{ slotId: "top", mode: "fixed-preset", presetId: "left" },
					{ slotId: "bottom", mode: "fixed-preset", presetId: "right" },
				],
				sections: [],
			},
		};

		const scene = buildScene({
			tracks: [
				{
					id: "video-track",
					type: "video",
					name: "Video",
					isMain: true,
					muted: false,
					hidden: false,
					elements: [video],
				},
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
			],
			duration: 5,
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		});

		const videoNode = scene.children.find(
			(node) => node.constructor.name === "VideoNode",
		) as { params?: { splitScreen?: VideoElement["splitScreen"] } } | undefined;
		expect(videoNode?.params?.splitScreen?.enabled).toBe(true);
		expect(videoNode?.params?.splitScreen?.layoutPreset).toBe("top-bottom");
	});

	test("passes linked source split-screen config through to caption text nodes", () => {
		const video: VideoElement = {
			id: "video-1",
			type: "video",
			mediaId: "video-asset",
			name: "Video 1",
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
		};
		const caption = createCaption({ sourceMediaElementId: video.id });

		const scene = buildScene({
			tracks: [
				{
					id: "video-track",
					type: "video",
					name: "Video",
					isMain: true,
					muted: false,
					hidden: false,
					elements: [video],
				},
				{
					id: "text-track",
					type: "text",
					name: "Text",
					hidden: false,
					elements: [caption],
				},
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
			],
			duration: 5,
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		});

		const textNode = scene.children.find(
			(node) => node.constructor.name === "TextNode",
		) as
			| {
					params?: {
						captionSourceVideo?: { splitScreen?: VideoElement["splitScreen"] };
					};
			  }
			| undefined;

		expect(textNode?.params?.captionSourceVideo?.splitScreen?.enabled).toBe(
			true,
		);
		expect(
			textNode?.params?.captionSourceVideo?.splitScreen?.layoutPreset,
		).toBe("top-bottom");
	});

	test("uses aligned split-screen video companion for audio-linked caption placement", () => {
		const video: VideoElement = {
			id: "video-right",
			type: "video",
			mediaId: "video-asset",
			name: "Video Right",
			startTime: 1,
			duration: 1,
			trimStart: 1,
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
		};
		const audio = createAudioElement({
			id: "audio-right",
			startTime: 1,
			duration: 1,
			words: [{ id: "w-right", text: "right", startTime: 0.0, endTime: 0.4 }],
		});
		const caption = createCaption({ sourceMediaElementId: audio.id });

		const scene = buildScene({
			tracks: [
				{
					id: "video-track",
					type: "video",
					name: "Video",
					isMain: true,
					muted: false,
					hidden: false,
					elements: [video],
				},
				{
					id: "audio-track",
					type: "audio",
					name: "Audio",
					muted: false,
					elements: [audio],
				},
				{
					id: "text-track",
					type: "text",
					name: "Text",
					hidden: false,
					elements: [caption],
				},
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
			],
			duration: 5,
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		});

		const textNode = scene.children.find(
			(node) => node.constructor.name === "TextNode",
		) as
			| {
					params?: {
						captionSourceVideo?: {
							splitScreen?: VideoElement["splitScreen"];
							startTime?: number;
						};
					};
			  }
			| undefined;

		expect(textNode?.params?.captionSourceVideo?.startTime).toBe(1);
		expect(
			textNode?.params?.captionSourceVideo?.splitScreen?.viewportBalance,
		).toBe("unbalanced");
	});
});
