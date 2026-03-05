import { describe, expect, test } from "bun:test";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { resolveLiveCaptionElementFromTranscriptSource } from "@/services/renderer/scene-builder";
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
});

