import { describe, expect, test } from "bun:test";
import { getTranscriptApplied } from "@/lib/transcript-editor/state";
import type { AudioElement } from "@/types/timeline";

describe("getTranscriptApplied", () => {
	test("recompiles stale applied state when draft is newer", () => {
		const element: AudioElement = {
			id: "audio-1",
			type: "audio",
			name: "Audio 1",
			startTime: 10,
			duration: 2,
			trimStart: 0,
			trimEnd: 0,
			volume: 1,
			sourceType: "upload",
			mediaId: "media-1",
			transcriptDraft: {
				version: 1,
				source: "word-level",
				words: [
					{ id: "w0", text: "hello", startTime: 0, endTime: 0.4, removed: false },
					{
						id: "w1",
						text: "secret",
						startTime: 0.45,
						endTime: 0.8,
						removed: false,
						hidden: true,
					},
					{ id: "w2", text: "world", startTime: 0.85, endTime: 1.2, removed: false },
				],
				cuts: [],
				updatedAt: "2026-03-10T12:00:01.000Z",
			},
			transcriptApplied: {
				version: 1,
				revisionKey: "stale",
				updatedAt: "2026-03-10T12:00:00.000Z",
				removedRanges: [],
				keptSegments: [{ start: 0, end: 2, duration: 2 }],
				timeMap: {
					cutBoundaries: [],
					sourceDuration: 2,
					playableDuration: 2,
				},
				captionPayload: {
					content: "hello secret world",
					startTime: 0,
					duration: 1.2,
					wordTimings: [
						{ word: "hello", startTime: 0, endTime: 0.4 },
						{ word: "secret", startTime: 0.45, endTime: 0.8 },
						{ word: "world", startTime: 0.85, endTime: 1.2 },
					],
				},
			},
		};

		const applied = getTranscriptApplied(element);

		expect(applied).toBeDefined();
		expect(applied?.updatedAt).toBe("2026-03-10T12:00:01.000Z");
		expect(applied?.captionPayload?.content).toBe("hello world");
		expect(
			applied?.captionPayload?.wordTimings.some((timing) => timing.word === "secret"),
		).toBe(true);
	});
});
