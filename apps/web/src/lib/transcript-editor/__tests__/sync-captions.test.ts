import { describe, expect, test } from "bun:test";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import {
	dedupeTranscriptEditsInTracks,
	rebuildCaptionTrackForMediaElement,
	syncCaptionsFromTranscriptEdits,
} from "@/lib/transcript-editor/sync-captions";
import type { AudioElement, TextElement, TimelineTrack, VideoElement } from "@/types/timeline";

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

function createCaption({
	id,
	sourceMediaElementId,
	startTime,
	duration,
	content,
	wordTimings,
}: {
	id: string;
	sourceMediaElementId: string;
	startTime: number;
	duration: number;
	content: string;
	wordTimings: Array<{ word: string; startTime: number; endTime: number }>;
}): TextElement {
	return {
		...DEFAULT_TEXT_ELEMENT,
		id,
		name: "Caption 1",
		content,
		startTime,
		duration,
		captionWordTimings: wordTimings,
		captionSourceRef: {
			mediaElementId: sourceMediaElementId,
			transcriptVersion: 1,
		},
		captionStyle: {
			...(DEFAULT_TEXT_ELEMENT.captionStyle ?? {}),
			linkedToCaptionGroup: true,
		},
	};
}

function createVideoElement({
	id,
	startTime,
	duration,
	mediaId,
	words,
}: {
	id: string;
	startTime: number;
	duration: number;
	mediaId: string;
	words: Array<{
		id: string;
		text: string;
		startTime: number;
		endTime: number;
		removed?: boolean;
	}>;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId,
		startTime,
		duration,
		trimStart: 0,
		trimEnd: 0,
		muted: false,
		hidden: false,
		transform: DEFAULT_TEXT_ELEMENT.transform,
		opacity: 1,
		transcriptEdit: {
			version: 1,
			source: "word-level",
			words,
			cuts: [],
			updatedAt: new Date().toISOString(),
		},
	};
}

describe("sync captions from transcript edits", () => {
	test("does not cross-update captions when multiple clips share legacy transcript source id", () => {
		const leftAudio = createAudioElement({
			id: "audio-left",
			startTime: 0,
			duration: 2,
			words: [
				{
					id: "source:word:0",
					text: "left",
					startTime: 0,
					endTime: 0.4,
				},
			],
		});
		const rightAudio = createAudioElement({
			id: "audio-right",
			startTime: 2,
			duration: 2,
			words: [
				{
					id: "source:word:1",
					text: "right",
					startTime: 0,
					endTime: 0.5,
				},
			],
		});
		const leftCaption = createCaption({
			id: "caption-left",
			sourceMediaElementId: "audio-left",
			startTime: 0,
			duration: 0.4,
			content: "old left",
			wordTimings: [{ word: "old", startTime: 0, endTime: 0.4 }],
		});
		const rightCaption = createCaption({
			id: "caption-right",
			sourceMediaElementId: "audio-right",
			startTime: 2,
			duration: 0.5,
			content: "old right",
			wordTimings: [{ word: "old", startTime: 0, endTime: 0.5 }],
		});
		const tracks: TimelineTrack[] = [
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
				elements: [leftCaption, rightCaption],
			},
		];

		const result = syncCaptionsFromTranscriptEdits({
			tracks,
			mediaElementId: "audio-left",
		});
		expect(result.changed).toBe(true);

		const syncedTextTrack = result.tracks.find((track) => track.id === "text-track");
		expect(syncedTextTrack?.type).toBe("text");
		const syncedLeft = syncedTextTrack?.type === "text"
			? syncedTextTrack.elements.find((element) => element.id === "caption-left")
			: null;
		const syncedRight = syncedTextTrack?.type === "text"
			? syncedTextTrack.elements.find((element) => element.id === "caption-right")
			: null;

		expect(syncedLeft?.content).toBe("left");
		expect(syncedRight?.content).toBe("old right");
	});

	test("removes linked captions when transcript words become unavailable", () => {
		const audio = createAudioElement({
			id: "audio-1",
			startTime: 0,
			duration: 2,
			words: [],
		});
		const caption = createCaption({
			id: "caption-1",
			sourceMediaElementId: "audio-1",
			startTime: 0,
			duration: 1,
			content: "stale caption",
			wordTimings: [{ word: "stale", startTime: 0, endTime: 1 }],
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
				elements: [caption],
			},
		];

		const result = syncCaptionsFromTranscriptEdits({
			tracks,
			mediaElementId: "audio-1",
		});
		expect(result.changed).toBe(true);

		const syncedTextTrack = result.tracks.find((track) => track.id === "text-track");
		expect(syncedTextTrack?.type).toBe("text");
		if (syncedTextTrack?.type === "text") {
			expect(syncedTextTrack.elements).toHaveLength(0);
		}
	});

	test("re-points caption link to currently edited media id across companions", () => {
		const companionA = createAudioElement({
			id: "audio-a",
			startTime: 0,
			duration: 2,
			words: [
				{
					id: "shared:word:0",
					text: "alpha",
					startTime: 0,
					endTime: 0.4,
				},
			],
		});
		const companionB = createAudioElement({
			id: "audio-b",
			startTime: 0,
			duration: 2,
			words: [
				{
					id: "shared:word:0",
					text: "beta",
					startTime: 0,
					endTime: 0.5,
				},
			],
		});
		const caption = createCaption({
			id: "caption-1",
			sourceMediaElementId: "audio-a",
			startTime: 0,
			duration: 0.4,
			content: "old",
			wordTimings: [{ word: "old", startTime: 0, endTime: 0.4 }],
		});
		const tracks: TimelineTrack[] = [
			{
				id: "audio-track",
				type: "audio",
				name: "Audio",
				muted: false,
				elements: [companionA, companionB],
			},
			{
				id: "text-track",
				type: "text",
				name: "Captions",
				hidden: false,
				elements: [caption],
			},
		];

		const result = syncCaptionsFromTranscriptEdits({
			tracks,
			mediaElementId: "audio-b",
		});
		expect(result.changed).toBe(true);

		const syncedTextTrack = result.tracks.find((track) => track.id === "text-track");
		expect(syncedTextTrack?.type).toBe("text");
		if (syncedTextTrack?.type !== "text") return;

		expect(syncedTextTrack.elements).toHaveLength(1);
		const syncedCaption = syncedTextTrack.elements[0];
		expect(syncedCaption?.content).toBe("beta");
		expect(syncedCaption?.captionSourceRef?.mediaElementId).toBe("audio-b");
	});

	test("writes timeline-aligned recalculated caption timings for non-zero media start", () => {
		const audio = createAudioElement({
			id: "audio-1",
			startTime: 10,
			duration: 2,
			words: [
				{
					id: "audio-1:word:0",
					text: "skip",
					startTime: 0,
					endTime: 0.4,
					removed: true,
				},
				{
					id: "audio-1:word:1",
					text: "go",
					startTime: 0.5,
					endTime: 0.8,
					removed: false,
				},
			],
		});
		const tracks: TimelineTrack[] = [
			{
				id: "audio-track",
				type: "audio",
				name: "Audio",
				muted: false,
				elements: [audio],
			},
		];

		const result = syncCaptionsFromTranscriptEdits({
			tracks,
			mediaElementId: "audio-1",
		});
		expect(result.changed).toBe(true);

		const captionTrack = result.tracks.find((track) => track.type === "text");
		expect(captionTrack?.type).toBe("text");
		if (captionTrack?.type !== "text") return;
		expect(captionTrack.elements).toHaveLength(1);
		const caption = captionTrack.elements[0];
		expect(caption.startTime).toBeCloseTo(10.0, 3);
		expect(caption.captionWordTimings?.[0]?.startTime).toBeCloseTo(10.0, 3);
		expect(caption.captionWordTimings?.[0]?.endTime).toBeCloseTo(10.3, 3);
	});

	test("recalculates caption timing/content from transcript edits while applying removals", () => {
		const audio = createAudioElement({
			id: "audio-1",
			startTime: 10,
			duration: 2,
			words: [
				{
					id: "audio-1:word:0",
					text: "skip",
					startTime: 0,
					endTime: 0.4,
					removed: true,
				},
				{
					id: "audio-1:word:1",
					text: "go",
					startTime: 0.5,
					endTime: 0.9,
					removed: false,
				},
			],
		});
		const existingCaption = createCaption({
			id: "caption-1",
			sourceMediaElementId: "audio-1",
			startTime: 10,
			duration: 0.9,
			content: "skip go",
			wordTimings: [
				{ word: "skip", startTime: 10.12, endTime: 10.28 },
				{ word: "go", startTime: 10.33, endTime: 10.57 },
			],
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
				elements: [existingCaption],
			},
		];

		const result = syncCaptionsFromTranscriptEdits({
			tracks,
			mediaElementId: "audio-1",
		});
		expect(result.changed).toBe(true);

		const textTrack = result.tracks.find((track) => track.id === "text-track");
		expect(textTrack?.type).toBe("text");
		if (textTrack?.type !== "text") return;
		expect(textTrack.elements).toHaveLength(1);
		const caption = textTrack.elements[0];
		expect(caption.content).toBe("go");
		expect(caption.startTime).toBeCloseTo(10.0, 3);
		expect(caption.duration).toBeCloseTo(0.433, 2);
		expect(caption.captionWordTimings?.[0]?.word).toBe("go");
		expect(caption.captionWordTimings?.[0]?.startTime).toBeCloseTo(10.0, 3);
		expect(caption.captionWordTimings?.[0]?.endTime).toBeCloseTo(10.4, 3);
	});

	test("rebuild captions for clip replaces caption track with rebuilt linked caption", () => {
		const audio = createAudioElement({
			id: "audio-1",
			startTime: 5,
			duration: 2,
			words: [
				{
					id: "audio-1:word:0",
					text: "hello",
					startTime: 0.0,
					endTime: 0.4,
					removed: false,
				},
				{
					id: "audio-1:word:1",
					text: "world",
					startTime: 0.5,
					endTime: 0.9,
					removed: false,
				},
			],
		});
		const staleCaptionA = createCaption({
			id: "caption-a",
			sourceMediaElementId: "other",
			startTime: 0,
			duration: 1,
			content: "stale a",
			wordTimings: [{ word: "stale", startTime: 0, endTime: 1 }],
		});
		const staleCaptionB = createCaption({
			id: "caption-b",
			sourceMediaElementId: "other2",
			startTime: 2,
			duration: 1,
			content: "stale b",
			wordTimings: [{ word: "stale", startTime: 2, endTime: 3 }],
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
				elements: [staleCaptionA, staleCaptionB],
			},
		];

		const result = rebuildCaptionTrackForMediaElement({
			tracks,
			mediaElementId: "audio-1",
		});
		expect(result.error).toBeUndefined();
		expect(result.changed).toBe(true);

		const textTrack = result.tracks.find((track) => track.id === "text-track");
		expect(textTrack?.type).toBe("text");
		if (textTrack?.type !== "text") return;
		expect(textTrack.elements).toHaveLength(1);
		const rebuilt = textTrack.elements[0];
		expect(rebuilt.captionSourceRef?.mediaElementId).toBe("audio-1");
		expect(rebuilt.content).toBe("hello world");
		expect(rebuilt.startTime).toBeCloseTo(5.0, 3);
	});

	test("rebuild captions keeps timeline-aligned transcript timings without double offset", () => {
		const audio = createAudioElement({
			id: "audio-1",
			startTime: 12,
			duration: 4,
			words: [
				{
					id: "audio-1:fallback:0",
					text: "hello",
					startTime: 12.2,
					endTime: 12.6,
					removed: false,
				},
				{
					id: "audio-1:fallback:1",
					text: "there",
					startTime: 12.7,
					endTime: 13.1,
					removed: false,
				},
			],
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
				hidden: true,
				elements: [],
			},
		];

		const result = rebuildCaptionTrackForMediaElement({
			tracks,
			mediaElementId: "audio-1",
		});
		expect(result.error).toBeUndefined();
		expect(result.changed).toBe(true);

		const textTrack = result.tracks.find((track) => track.id === "text-track");
		expect(textTrack?.type).toBe("text");
		if (textTrack?.type !== "text") return;
		expect(textTrack.hidden).toBe(false);
		expect(textTrack.elements).toHaveLength(1);
		const rebuilt = textTrack.elements[0];
		expect(rebuilt.startTime).toBeCloseTo(12.2, 3);
		expect(rebuilt.captionWordTimings?.[0]?.startTime).toBeCloseTo(12.2, 3);
	});

	test("rebuild captions removes stale duplicates and leaves one rebuilt linked caption", () => {
		const audio = createAudioElement({
			id: "audio-1",
			startTime: 3,
			duration: 3,
			words: [
				{
					id: "audio-1:word:0",
					text: "fresh",
					startTime: 0.2,
					endTime: 0.5,
					removed: false,
				},
				{
					id: "audio-1:word:1",
					text: "caption",
					startTime: 0.6,
					endTime: 1.0,
					removed: false,
				},
			],
		});
		const linkedTrackCaption = createCaption({
			id: "linked-caption",
			sourceMediaElementId: "audio-1",
			startTime: 3.1,
			duration: 0.4,
			content: "old linked",
			wordTimings: [{ word: "old", startTime: 3.1, endTime: 3.4 }],
		});
		const staleDuplicate = createCaption({
			id: "stale-duplicate",
			sourceMediaElementId: "audio-1",
			startTime: 4.0,
			duration: 0.5,
			content: "stale",
			wordTimings: [{ word: "stale", startTime: 4.0, endTime: 4.5 }],
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
				id: "captions-named-track",
				type: "text",
				name: "Captions",
				hidden: false,
				elements: [staleDuplicate],
			},
			{
				id: "linked-track",
				type: "text",
				name: "Text 2",
				hidden: false,
				elements: [linkedTrackCaption],
			},
		];

		const result = rebuildCaptionTrackForMediaElement({
			tracks,
			mediaElementId: "audio-1",
		});
		expect(result.error).toBeUndefined();
		expect(result.changed).toBe(true);

		const textTracks = result.tracks.filter((track) => track.type === "text");
		const rebuiltTracks = textTracks.filter((track) =>
			track.elements.some(
				(element) =>
					element.type === "text" &&
					element.captionSourceRef?.mediaElementId === "audio-1",
			),
		);
		expect(rebuiltTracks).toHaveLength(1);
		const rebuiltTrack = rebuiltTracks[0];
		expect(rebuiltTrack.elements).toHaveLength(1);
		const rebuilt = rebuiltTrack.elements[0];
		expect(rebuilt.content).toBe("fresh caption");
		expect(rebuilt.captionSourceRef?.mediaElementId).toBe("audio-1");
		expect(rebuilt.startTime).toBeCloseTo(3.2, 3);
	});

	test("dedupe transcript edits keeps only caption-linked transcript per shared source", () => {
		const sharedUpdatedAtOld = "2024-01-01T00:00:00.000Z";
		const sharedUpdatedAtNew = "2025-01-01T00:00:00.000Z";
		const audioA: AudioElement = {
			...createAudioElement({
				id: "audio-a",
				startTime: 0,
				duration: 2,
				words: [{ id: "shared:word:0", text: "old", startTime: 0, endTime: 0.4 }],
			}),
			transcriptEdit: {
				version: 1,
				source: "word-level",
				words: [{ id: "shared:word:0", text: "old", startTime: 0, endTime: 0.4 }],
				cuts: [],
				updatedAt: sharedUpdatedAtOld,
			},
		};
		const audioB: AudioElement = {
			...createAudioElement({
				id: "audio-b",
				startTime: 0,
				duration: 2,
				words: [{ id: "shared:word:0", text: "new", startTime: 0, endTime: 0.5 }],
			}),
			transcriptEdit: {
				version: 1,
				source: "word-level",
				words: [{ id: "shared:word:0", text: "new", startTime: 0, endTime: 0.5 }],
				cuts: [],
				updatedAt: sharedUpdatedAtNew,
			},
		};
		const linkedCaption = createCaption({
			id: "caption-1",
			sourceMediaElementId: "audio-a",
			startTime: 0,
			duration: 0.4,
			content: "old",
			wordTimings: [{ word: "old", startTime: 0, endTime: 0.4 }],
		});
		const tracks: TimelineTrack[] = [
			{
				id: "audio-track",
				type: "audio",
				name: "Audio",
				muted: false,
				elements: [audioA, audioB],
			},
			{
				id: "text-track",
				type: "text",
				name: "Captions",
				hidden: false,
				elements: [linkedCaption],
			},
		];

		const result = dedupeTranscriptEditsInTracks({ tracks });
		expect(result.changed).toBe(true);
		const dedupedAudioTrack = result.tracks.find((track) => track.id === "audio-track");
		expect(dedupedAudioTrack?.type).toBe("audio");
		if (dedupedAudioTrack?.type !== "audio") return;
		const dedupedA = dedupedAudioTrack.elements.find((element) => element.id === "audio-a");
		const dedupedB = dedupedAudioTrack.elements.find((element) => element.id === "audio-b");
		expect(dedupedA?.transcriptEdit?.words[0]?.text).toBe("old");
		expect(dedupedB?.transcriptEdit).toBeUndefined();
	});

	test("dedupe keeps transcript edit only on caption-target companion (aligned video+audio)", () => {
		const words = [{ id: "shared:word:0", text: "hello", startTime: 0, endTime: 0.5 }];
		const audio = {
			...createAudioElement({
				id: "audio-1",
				startTime: 10,
				duration: 4,
				words,
			}),
			mediaId: "media-1",
		};
		const video = createVideoElement({
			id: "video-1",
			mediaId: "media-1",
			startTime: 10,
			duration: 4,
			words,
		});
		const linkedCaption = createCaption({
			id: "caption-1",
			sourceMediaElementId: "audio-1",
			startTime: 10,
			duration: 0.5,
			content: "hello",
			wordTimings: [{ word: "hello", startTime: 10, endTime: 10.5 }],
		});
		const tracks: TimelineTrack[] = [
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
				name: "Captions",
				hidden: false,
				elements: [linkedCaption],
			},
		];

		const result = dedupeTranscriptEditsInTracks({ tracks });
		expect(result.changed).toBe(true);
		const dedupedVideoTrack = result.tracks.find((track) => track.id === "video-track");
		const dedupedAudioTrack = result.tracks.find((track) => track.id === "audio-track");
		expect(dedupedVideoTrack?.type).toBe("video");
		expect(dedupedAudioTrack?.type).toBe("audio");
		if (dedupedVideoTrack?.type !== "video" || dedupedAudioTrack?.type !== "audio") return;
		const dedupedVideoElement = dedupedVideoTrack.elements[0];
		expect(dedupedVideoElement?.type).toBe("video");
		if (!dedupedVideoElement || dedupedVideoElement.type !== "video") return;
		expect(dedupedVideoElement.transcriptEdit).toBeUndefined();
		expect(dedupedAudioTrack.elements[0]?.transcriptEdit).toBeDefined();
	});

	test("dedupe keeps transcript edit only on caption-target companion with slight drift", () => {
		const words = [{ id: "shared:word:0", text: "hello", startTime: 0, endTime: 0.5 }];
		const audio = {
			...createAudioElement({
				id: "audio-1",
				startTime: 10.03,
				duration: 4.02,
				words,
			}),
			mediaId: "media-1",
			trimStart: 0.04,
		};
		const video = {
			...createVideoElement({
				id: "video-1",
				mediaId: "media-1",
				startTime: 10,
				duration: 4,
				words,
			}),
			trimStart: 0,
		};
		const linkedCaption = createCaption({
			id: "caption-1",
			sourceMediaElementId: "audio-1",
			startTime: 10,
			duration: 0.5,
			content: "hello",
			wordTimings: [{ word: "hello", startTime: 10, endTime: 10.5 }],
		});
		const tracks: TimelineTrack[] = [
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
				name: "Captions",
				hidden: false,
				elements: [linkedCaption],
			},
		];

		const result = dedupeTranscriptEditsInTracks({ tracks });
		const dedupedVideoTrack = result.tracks.find((track) => track.id === "video-track");
		const dedupedAudioTrack = result.tracks.find((track) => track.id === "audio-track");
		expect(dedupedVideoTrack?.type).toBe("video");
		expect(dedupedAudioTrack?.type).toBe("audio");
		if (dedupedVideoTrack?.type !== "video" || dedupedAudioTrack?.type !== "audio") return;
		const dedupedVideoElement = dedupedVideoTrack.elements[0];
		expect(dedupedVideoElement?.type).toBe("video");
		if (!dedupedVideoElement || dedupedVideoElement.type !== "video") return;
		expect(result.changed).toBe(true);
		expect(dedupedVideoElement.transcriptEdit).toBeUndefined();
		expect(dedupedAudioTrack.elements[0]?.transcriptEdit).toBeDefined();
	});

	test("muting words does not split caption elements and removes muted words from caption text", () => {
		const audio: AudioElement = {
			...createAudioElement({
				id: "audio-1",
				startTime: 8,
				duration: 3,
				words: [
					{ id: "w1", text: "hello", startTime: 0.0, endTime: 0.3, removed: false },
					{ id: "w2", text: "muted", startTime: 0.35, endTime: 0.6, removed: false },
					{ id: "w3", text: "world", startTime: 0.7, endTime: 1.0, removed: false },
				],
			}),
			transcriptEdit: {
				version: 1,
				source: "word-level",
				words: [
					{ id: "w1", text: "hello", startTime: 0.0, endTime: 0.3, removed: false },
					{ id: "w2", text: "muted", startTime: 0.35, endTime: 0.6, removed: false },
					{ id: "w3", text: "world", startTime: 0.7, endTime: 1.0, removed: false },
				],
				cuts: [{ start: 0.3, end: 0.7, reason: "manual" }],
				updatedAt: new Date().toISOString(),
			},
		};
		const existingCaption = createCaption({
			id: "caption-1",
			sourceMediaElementId: "audio-1",
			startTime: 8,
			duration: 1.0,
			content: "hello muted world",
			wordTimings: [
				{ word: "hello", startTime: 8.0, endTime: 8.3 },
				{ word: "muted", startTime: 8.35, endTime: 8.6 },
				{ word: "world", startTime: 8.7, endTime: 9.0 },
			],
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
				elements: [existingCaption],
			},
		];

		const result = syncCaptionsFromTranscriptEdits({
			tracks,
			mediaElementId: "audio-1",
		});
		expect(result.changed).toBe(true);
		const textTrack = result.tracks.find((track) => track.id === "text-track");
		expect(textTrack?.type).toBe("text");
		if (textTrack?.type !== "text") return;
		expect(textTrack.elements).toHaveLength(1);
		expect(textTrack.elements[0]?.content).toBe("hello world");
		expect(textTrack.elements[0]?.captionWordTimings).toHaveLength(2);
	});
});
