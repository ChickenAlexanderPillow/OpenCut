import { describe, expect, test } from "bun:test";
import {
	getTranscriptApplied,
	getTranscriptAudioRevisionKey,
	getTranscriptRevisionKey,
} from "@/lib/transcript-editor/state";
import type { AudioElement } from "@/types/timeline";

function createElement(
	words: NonNullable<AudioElement["transcriptDraft"]>["words"],
): AudioElement {
	return {
		id: "audio-1",
		type: "audio",
		name: "Audio 1",
		startTime: 0,
		duration: 2,
		trimStart: 0,
		trimEnd: 0,
		volume: 1,
		sourceType: "upload",
		mediaId: "media-1",
		transcriptDraft: {
			version: 1,
			source: "word-level",
			words,
			cuts: [],
			updatedAt: "2026-03-10T12:00:00.000Z",
		},
	};
}

describe("getTranscriptAudioRevisionKey", () => {
	test("does not change for hidden-only transcript updates", () => {
		const base = createElement([
			{ id: "w0", text: "hello", startTime: 0, endTime: 0.4, removed: false },
			{ id: "w1", text: "world", startTime: 0.5, endTime: 0.9, removed: false },
		]);
		const hiddenOnly = createElement([
			{ id: "w0", text: "hello", startTime: 0, endTime: 0.4, removed: false },
			{
				id: "w1",
				text: "world",
				startTime: 0.5,
				endTime: 0.9,
				removed: false,
				hidden: true,
			},
		]);

		expect(getTranscriptApplied(base)?.removedRanges).toEqual(
			getTranscriptApplied(hiddenOnly)?.removedRanges,
		);
		expect(getTranscriptAudioRevisionKey(base)).toBe(
			getTranscriptAudioRevisionKey(hiddenOnly),
		);
		expect(getTranscriptRevisionKey(base)).not.toBe(
			getTranscriptRevisionKey(hiddenOnly),
		);
	});
});
