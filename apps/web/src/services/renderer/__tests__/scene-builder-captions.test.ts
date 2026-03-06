import { describe, expect, test } from "bun:test";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import {
	buildScene,
	resolveLiveCaptionElementFromTranscriptSource,
} from "@/services/renderer/scene-builder";
import type { AudioElement, TextElement } from "@/types/timeline";

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
		removed?: boolean;
	}>;
}): AudioElement {
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

function createCaption({ sourceMediaElementId }: { sourceMediaElementId: string }): TextElement {
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
	});

	test("returns null when transcript no longer has active words", () => {
		const source = createAudioElement({
			id: "audio-1",
			startTime: 10,
			duration: 2,
			words: [{ id: "w0", text: "skip", startTime: 0, endTime: 0.4, removed: true }],
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
			words: [{ id: "shared:word:0", text: "alpha", startTime: 0, endTime: 0.4 }],
		});
		const companion = createAudioElement({
			id: "audio-2",
			startTime: 10,
			duration: 2,
			words: [{ id: "shared:word:0", text: "beta", startTime: 0, endTime: 0.5 }],
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

	test("does not heuristically relink caption when explicit source ref is missing", () => {
		const transcriptCarrier = createAudioElement({
			id: "audio-2",
			startTime: 10,
			duration: 2,
			words: [{ id: "shared:word:0", text: "beta", startTime: 0, endTime: 0.5 }],
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
				{ id: "w0", text: "first", startTime: 0.0, endTime: 0.3, removed: false },
				{ id: "w1", text: "muted", startTime: 0.6, endTime: 0.9, removed: true },
				{ id: "w2", text: "third", startTime: 1.0, endTime: 1.3, removed: false },
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
		const transcriptEdit = {
			version: 1,
			source: "word-level" as const,
			words: [
				{ id: "w0", text: "hello", startTime: 0.0, endTime: 0.3, removed: false },
				{ id: "w1", text: "world", startTime: 0.35, endTime: 0.7, removed: false },
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
});
