import { describe, expect, test } from "bun:test";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import {
	buildTranscriptTimelineSnapshot,
	validateCaptionAgainstSnapshot,
} from "@/lib/transcript-editor/snapshot";
import { syncCaptionsFromTranscriptEdits, validateAndHealCaptionDriftInTracks } from "@/lib/transcript-editor/sync-captions";
import type { AudioElement, TextElement, TimelineTrack } from "@/types/timeline";

function createAudioElement({
	id,
	startTime,
	duration,
	words,
	cuts = [],
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
	cuts?: Array<{ start: number; end: number; reason: "manual" | "filler" | "pause" }>;
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
			cuts,
			updatedAt: new Date().toISOString(),
		},
	};
}

function createCaption({
	id,
	sourceMediaElementId,
	content,
	wordTimings,
}: {
	id: string;
	sourceMediaElementId: string;
	content: string;
	wordTimings: Array<{ word: string; startTime: number; endTime: number }>;
}): TextElement {
	const start = wordTimings[0]?.startTime ?? 0;
	const end = wordTimings[wordTimings.length - 1]?.endTime ?? start + 0.04;
	return {
		...DEFAULT_TEXT_ELEMENT,
		id,
		name: "Caption 1",
		content,
		startTime: start,
		duration: Math.max(0.04, end - start),
		captionWordTimings: wordTimings,
		captionSourceRef: {
			mediaElementId: sourceMediaElementId,
			transcriptVersion: 1,
		},
	};
}

describe("transcript timeline snapshot", () => {
	test("builds effective cuts from removed words and preserves pause cuts", () => {
		const snapshot = buildTranscriptTimelineSnapshot({
			mediaElementId: "audio-1",
			transcriptVersion: 1,
			updatedAt: "2026-03-05T00:00:00.000Z",
			words: [
				{ id: "w0", text: "hello", startTime: 0.0, endTime: 0.3, removed: false },
				{ id: "w1", text: "uh", startTime: 0.35, endTime: 0.5, removed: true },
				{ id: "w2", text: "world", startTime: 0.9, endTime: 1.2, removed: false },
			],
			cuts: [{ start: 1.3, end: 1.8, reason: "pause" }],
			mediaStartTime: 10,
			mediaDuration: 3,
		});
		expect(snapshot.effectiveCuts.length).toBeGreaterThanOrEqual(2);
		expect(snapshot.captionPayload?.content).toBe("hello world");
	});

	test("legacy non-pause cuts still remove words when removed flags are absent", () => {
		const snapshot = buildTranscriptTimelineSnapshot({
			mediaElementId: "audio-1",
			transcriptVersion: 1,
			updatedAt: "2026-03-05T00:00:00.000Z",
			words: [
				{ id: "w0", text: "hello", startTime: 0.0, endTime: 0.3, removed: false },
				{ id: "w1", text: "muted", startTime: 0.35, endTime: 0.6, removed: false },
				{ id: "w2", text: "world", startTime: 0.8, endTime: 1.1, removed: false },
			],
			cuts: [{ start: 0.3, end: 0.75, reason: "manual" }],
			mediaStartTime: 5,
			mediaDuration: 3,
		});
		expect(snapshot.captionPayload?.content).toBe("hello world");
		expect(snapshot.activeWords.map((word) => word.text)).toEqual(["hello", "world"]);
	});

	test("validator detects content and timing drift", () => {
		const snapshot = buildTranscriptTimelineSnapshot({
			mediaElementId: "audio-1",
			transcriptVersion: 1,
			updatedAt: "2026-03-05T00:00:00.000Z",
			words: [
				{ id: "w0", text: "alpha", startTime: 0.0, endTime: 0.3, removed: false },
				{ id: "w1", text: "beta", startTime: 0.35, endTime: 0.7, removed: false },
			],
			cuts: [],
			mediaStartTime: 5,
			mediaDuration: 3,
		});
		if (!snapshot.captionPayload) throw new Error("Expected caption payload");

		const staleCaption = createCaption({
			id: "caption-1",
			sourceMediaElementId: "audio-1",
			content: "alpha stale",
			wordTimings: snapshot.captionPayload.wordTimings,
		});
		const contentValidation = validateCaptionAgainstSnapshot({
			captionElement: staleCaption,
			snapshot,
		});
		expect(contentValidation.valid).toBe(false);

		const staleTimingCaption = createCaption({
			id: "caption-2",
			sourceMediaElementId: "audio-1",
			content: snapshot.captionPayload.content,
			wordTimings: snapshot.captionPayload.wordTimings.map((timing, index) =>
				index === 0
					? { ...timing, startTime: timing.startTime + 0.2 }
					: timing,
			),
		});
		const timingValidation = validateCaptionAgainstSnapshot({
			captionElement: staleTimingCaption,
			snapshot,
		});
		expect(timingValidation.valid).toBe(false);
	});

	test("drift checker auto-heals stale captions", () => {
		const audio = createAudioElement({
			id: "audio-1",
			startTime: 5,
			duration: 2,
			words: [
				{ id: "w0", text: "hello", startTime: 0.0, endTime: 0.3, removed: false },
				{ id: "w1", text: "world", startTime: 0.4, endTime: 0.8, removed: false },
			],
		});
		const staleCaption = createCaption({
			id: "caption-1",
			sourceMediaElementId: "audio-1",
			content: "stale",
			wordTimings: [{ word: "stale", startTime: 99, endTime: 100 }],
		});
		const tracks: TimelineTrack[] = [
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
				name: "Captions",
				hidden: false,
				elements: [staleCaption],
			},
		];
		const synced = syncCaptionsFromTranscriptEdits({
			tracks,
			mediaElementId: "audio-1",
		});
		expect(synced.changed).toBe(true);
		const staleAfterMutation = synced.tracks.map((track) => {
			if (track.id !== "text-track" || track.type !== "text") return track;
			return {
				...track,
				elements: track.elements.map((element) =>
					element.id === "caption-1"
						? {
								...element,
								content: "stale again",
							}
						: element,
				),
			};
		});
		const healed = validateAndHealCaptionDriftInTracks({
			tracks: staleAfterMutation,
			projectId: "project-1",
		});
		expect(healed.changed).toBe(true);
		const healedTrack = healed.tracks.find((track) => track.id === "text-track");
		expect(healedTrack?.type).toBe("text");
		if (healedTrack?.type !== "text") return;
		expect(healedTrack.elements[0]?.content).toBe("hello world");
	});
});
