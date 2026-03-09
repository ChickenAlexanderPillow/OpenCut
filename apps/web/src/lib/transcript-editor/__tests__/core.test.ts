import { describe, expect, test } from "bun:test";
import {
	applyCutRangesToWords,
	buildCaptionPayloadFromTranscriptWords,
	buildPauseCutsFromWords,
	buildTranscriptCutsFromWords,
	buildCompressedCutBoundaryTimes,
	computeKeepDuration,
	mapCompressedTimeToSourceTime,
	mapSourceTimeToCompressedTime,
	projectTranscriptEditToWindow,
	withFillerWordsRemoved,
} from "@/lib/transcript-editor/core";
import {
	DEFAULT_PAUSE_REMOVAL_MIN_GAP_SECONDS,
	PAUSE_REMOVAL_CUT_END_PADDING_SECONDS,
	PAUSE_REMOVAL_CUT_START_PADDING_SECONDS,
} from "@/lib/transcript-editor/constants";

describe("transcript editor core", () => {
	test("builds cuts and caption payload from removed words", () => {
		const words = [
			{ id: "w1", text: "hello", startTime: 0, endTime: 0.4, removed: false },
			{ id: "w2", text: "um", startTime: 0.4, endTime: 0.7, removed: true },
			{ id: "w3", text: "world", startTime: 0.7, endTime: 1.2, removed: false },
		];

		const cuts = buildTranscriptCutsFromWords({ words });
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.start).toBeCloseTo(0.4, 3);
		expect(cuts[0]?.end).toBeCloseTo(0.7, 3);

		const payload = buildCaptionPayloadFromTranscriptWords({ words });
		expect(payload).not.toBeNull();
		expect(payload?.content).toBe("hello world");
		expect(payload?.wordTimings[1]?.startTime ?? 0).toBeLessThan(1);
	});

	test("maps compressed/source time with cuts", () => {
		const cuts = [{ start: 1, end: 2, reason: "manual" as const }];
		expect(
			mapCompressedTimeToSourceTime({ compressedTime: 0.5, cuts }),
		).toBeCloseTo(0.5, 4);
		expect(
			mapCompressedTimeToSourceTime({ compressedTime: 1.1, cuts }),
		).toBeCloseTo(2.1, 4);

		expect(
			mapSourceTimeToCompressedTime({ sourceTime: 0.5, cuts }),
		).toBeCloseTo(0.5, 4);
		expect(
			mapSourceTimeToCompressedTime({ sourceTime: 2.1, cuts }),
		).toBeCloseTo(1.1, 4);
	});

	test("keeps boundary at cut start stable for source->compressed mapping", () => {
		const cuts = [{ start: 0.3, end: 1.0, reason: "manual" as const }];
		expect(
			mapSourceTimeToCompressedTime({ sourceTime: 0.3, cuts }),
		).toBeCloseTo(0.3, 4);
	});

	test("maps compressed cut boundary to the first kept source sample after the cut", () => {
		const cuts = [{ start: 0.225, end: 0.716, reason: "manual" as const }];
		expect(
			mapCompressedTimeToSourceTime({ compressedTime: 0.225, cuts }),
		).toBeCloseTo(0.716, 4);
	});

	test("computes keep duration and removes fillers", () => {
		const words = [
			{ id: "w1", text: "I", startTime: 0, endTime: 0.2, removed: false },
			{ id: "w2", text: "umm", startTime: 0.2, endTime: 0.5, removed: false },
			{ id: "w3", text: "agree", startTime: 0.5, endTime: 1, removed: false },
		];
		const filtered = withFillerWordsRemoved({ words });
		expect(filtered[1]?.removed).toBe(true);
		const cuts = buildTranscriptCutsFromWords({ words: filtered });
		const keepDuration = computeKeepDuration({ originalDuration: 1, cuts });
		expect(keepDuration).toBeLessThan(1);
	});

	test("applies cut ranges to word removal state for UI/playback consistency", () => {
		const words = [
			{ id: "w1", text: "hello", startTime: 0, endTime: 0.4, removed: false },
			{ id: "w2", text: "there", startTime: 0.4, endTime: 0.8, removed: false },
			{ id: "w3", text: "world", startTime: 0.8, endTime: 1.2, removed: false },
		];
		const cuts = [{ start: 0.45, end: 0.75, reason: "manual" as const }];
		const applied = applyCutRangesToWords({ words, cuts });

		expect(applied[0]?.removed).toBe(false);
		expect(applied[1]?.removed).toBe(true);
		expect(applied[2]?.removed).toBe(false);
	});

	test("extends cuts through inter-word gaps after removed words", () => {
		const words = [
			{ id: "w1", text: "from", startTime: 0.0, endTime: 0.2, removed: true },
			{
				id: "w2",
				text: "poland",
				startTime: 0.28,
				endTime: 0.5,
				removed: true,
			},
			{
				id: "w3",
				text: "european",
				startTime: 0.7,
				endTime: 0.95,
				removed: false,
			},
		];
		const cuts = buildTranscriptCutsFromWords({ words });
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.start).toBeCloseTo(0.0, 3);
		expect(cuts[0]?.end).toBeCloseTo(0.7, 3);
	});

	test("removes internal gaps for consecutive removed phrase words", () => {
		const words = [
			{ id: "w1", text: "Well,", startTime: 0.0, endTime: 0.2, removed: true },
			{ id: "w2", text: "I", startTime: 0.32, endTime: 0.45, removed: true },
			{ id: "w3", text: "think", startTime: 0.62, endTime: 0.9, removed: true },
			{ id: "w4", text: "so", startTime: 1.1, endTime: 1.4, removed: false },
		];
		const cuts = buildTranscriptCutsFromWords({ words });
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.start).toBeCloseTo(0.0, 3);
		expect(cuts[0]?.end).toBeCloseTo(1.1, 3);
	});

	test("absorbs pre-gap before a muted word to avoid frozen captions", () => {
		const words = [
			{ id: "w1", text: "hello", startTime: 0.0, endTime: 0.2, removed: false },
			{ id: "w2", text: "um", startTime: 0.5, endTime: 0.6, removed: true },
			{ id: "w3", text: "world", startTime: 0.9, endTime: 1.2, removed: false },
		];
		const cuts = buildTranscriptCutsFromWords({ words });
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.start).toBeCloseTo(0.2, 3);
		expect(cuts[0]?.end).toBeCloseTo(0.9, 3);
	});

	test("builds pause cuts with threshold and speech-safe boundary padding", () => {
		const words = [
			{ id: "w1", text: "hello", startTime: 0.0, endTime: 0.2, removed: false },
			{
				id: "w2",
				text: "world",
				startTime: 0.2 + DEFAULT_PAUSE_REMOVAL_MIN_GAP_SECONDS - 0.05,
				endTime: 0.95,
				removed: false,
			},
			{ id: "w3", text: "again", startTime: 2.0, endTime: 2.3, removed: false },
		];
		const cuts = buildPauseCutsFromWords({ words });
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.start).toBeCloseTo(
			0.95 + PAUSE_REMOVAL_CUT_START_PADDING_SECONDS,
			3,
		);
		expect(cuts[0]?.end).toBeCloseTo(
			2.0 - PAUSE_REMOVAL_CUT_END_PADDING_SECONDS,
			3,
		);
	});

	test("builds compressed cut boundaries for smoothing", () => {
		const boundaries = buildCompressedCutBoundaryTimes({
			cuts: [
				{ start: 1.0, end: 1.4, reason: "pause" as const },
				{ start: 2.0, end: 2.5, reason: "manual" as const },
			],
		});
		expect(boundaries).toHaveLength(2);
		expect(boundaries[0]).toBeCloseTo(1.0, 3);
		expect(boundaries[1]).toBeCloseTo(1.6, 3);
	});

	test("caption payload removes muted words when removal is represented by manual cuts", () => {
		const words = [
			{ id: "w1", text: "hello", startTime: 0.0, endTime: 0.3, removed: false },
			{
				id: "w2",
				text: "muted",
				startTime: 0.35,
				endTime: 0.6,
				removed: false,
			},
			{ id: "w3", text: "world", startTime: 0.7, endTime: 1.0, removed: false },
		];
		const cuts = [{ start: 0.3, end: 0.7, reason: "manual" as const }];

		const payload = buildCaptionPayloadFromTranscriptWords({ words, cuts });
		expect(payload).not.toBeNull();
		expect(payload?.content).toBe("hello world");
		expect(payload?.wordTimings).toHaveLength(2);
		expect(payload?.wordTimings[0]?.word).toBe("hello");
		expect(payload?.wordTimings[1]?.word).toBe("world");
	});

	test("projects transcript edit to trimmed source window and re-bases timing", () => {
		const transcriptEdit = {
			version: 1 as const,
			source: "word-level" as const,
			words: [
				{
					id: "w1",
					text: "alpha",
					startTime: 0.0,
					endTime: 0.3,
					removed: false,
				},
				{
					id: "w2",
					text: "beta",
					startTime: 0.4,
					endTime: 0.8,
					removed: false,
				},
				{
					id: "w3",
					text: "gamma",
					startTime: 0.9,
					endTime: 1.3,
					removed: false,
				},
			],
			cuts: [{ start: 0.25, end: 0.55, reason: "manual" as const }],
			updatedAt: "2026-03-05T00:00:00.000Z",
		};
		const projected = projectTranscriptEditToWindow({
			transcriptEdit,
			elementId: "clip-1",
			sourceStart: 0.2,
			sourceEnd: 1.0,
		});

		expect(projected.words).toHaveLength(3);
		expect(projected.words[0]?.startTime).toBeCloseTo(0.0, 3);
		expect(projected.words[0]?.endTime).toBeCloseTo(0.1, 3);
		expect(projected.words[2]?.startTime).toBeCloseTo(0.7, 3);
		expect(projected.words[2]?.endTime).toBeCloseTo(0.8, 3);
		expect(projected.cuts).toHaveLength(1);
		expect(projected.cuts[0]?.start).toBeCloseTo(0.05, 3);
		expect(projected.cuts[0]?.end).toBeCloseTo(0.35, 3);
		expect(projected.segmentsUi).toHaveLength(1);
		expect(projected.segmentsUi?.[0]?.id).toBe("clip-1:seg:0");
	});

	test("projects transcript edit keeps overlap words when trim cuts through word", () => {
		const transcriptEdit = {
			version: 1 as const,
			source: "word-level" as const,
			words: [
				{
					id: "w1",
					text: "hello",
					startTime: 0.0,
					endTime: 0.5,
					removed: false,
				},
				{
					id: "w2",
					text: "world",
					startTime: 0.5,
					endTime: 1.0,
					removed: false,
				},
			],
			cuts: [],
			updatedAt: "2026-03-05T00:00:00.000Z",
		};
		const projected = projectTranscriptEditToWindow({
			transcriptEdit,
			elementId: "clip-2",
			sourceStart: 0.25,
			sourceEnd: 0.75,
		});

		expect(projected.words).toHaveLength(2);
		expect(projected.words[0]?.startTime).toBeCloseTo(0.0, 3);
		expect(projected.words[0]?.endTime).toBeCloseTo(0.25, 3);
		expect(projected.words[1]?.startTime).toBeCloseTo(0.25, 3);
		expect(projected.words[1]?.endTime).toBeCloseTo(0.5, 3);
	});

	test("projects transcript edit rebases timings when extending backward from trimmed window", () => {
		const transcriptEdit = {
			version: 1 as const,
			source: "word-level" as const,
			// Existing transcript window starts at 2s in source and is already rebased to 0.
			words: [
				{
					id: "w1",
					text: "hello",
					startTime: 0.2,
					endTime: 0.5,
					removed: false,
				},
				{
					id: "w2",
					text: "world",
					startTime: 0.7,
					endTime: 1.0,
					removed: false,
				},
			],
			cuts: [],
			updatedAt: "2026-03-05T00:00:00.000Z",
		};

		const projected = projectTranscriptEditToWindow({
			transcriptEdit,
			elementId: "clip-3",
			// User extends trim backwards by 1s relative to the current transcript window.
			sourceStart: -1.0,
			sourceEnd: 2.0,
		});

		// Existing words should shift forward by 1s in the expanded window.
		expect(projected.words).toHaveLength(2);
		expect(projected.words[0]?.startTime).toBeCloseTo(1.2, 3);
		expect(projected.words[0]?.endTime).toBeCloseTo(1.5, 3);
		expect(projected.words[1]?.startTime).toBeCloseTo(1.7, 3);
		expect(projected.words[1]?.endTime).toBeCloseTo(2.0, 3);
	});
});
