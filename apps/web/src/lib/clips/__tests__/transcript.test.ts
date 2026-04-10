import { describe, expect, test } from "bun:test";
import {
	buildClipTranscriptCacheEntryForAsset,
	clipTranscriptSegmentsForWindow,
	clipTranscriptWordsForWindow,
	getOrCreateClipTranscriptForAsset,
	PROJECT_MEDIA_TRANSCRIPT_LANGUAGE,
} from "@/lib/clips/transcript";
import type { MediaAsset } from "@/types/assets";
import type { TProject } from "@/types/project";

function buildTestAsset(): MediaAsset {
	return {
		id: "media-1",
		name: "clip.mp4",
		type: "video",
		size: 1024,
		lastModified: 0,
		duration: 180,
		width: 1920,
		height: 1080,
		fps: 30,
		file: new File(["test"], "clip.mp4", { type: "video/mp4" }),
	};
}

function buildTestProject(): TProject {
	return {
		metadata: {
			id: "project-1",
			name: "Project",
			duration: 180,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		},
		scenes: [],
		currentSceneId: "scene-1",
		settings: {
			fps: 30,
			canvasSize: {
				width: 1920,
				height: 1080,
			},
			background: {
				type: "color",
				color: "#000000",
			},
		},
		version: 1,
	};
}

describe("clipTranscriptSegmentsForWindow", () => {
	test("defaults clip transcript language to english", () => {
		expect(PROJECT_MEDIA_TRANSCRIPT_LANGUAGE).toBe("en");
	});

	test("rebases segment timestamps to clip start", () => {
		const clipped = clipTranscriptSegmentsForWindow({
			segments: [
				{ text: "alpha", start: 5, end: 12 },
				{ text: "beta", start: 14, end: 20 },
			],
			startTime: 10,
			endTime: 18,
		});

		expect(clipped).toEqual([
			{ text: "alpha", start: 0, end: 2 },
			{ text: "beta", start: 4, end: 8 },
		]);
	});

	test("drops segments outside the selected window", () => {
		const clipped = clipTranscriptSegmentsForWindow({
			segments: [
				{ text: "outside", start: 1, end: 2 },
				{ text: "inside", start: 30, end: 31 },
			],
			startTime: 20,
			endTime: 40,
		});

		expect(clipped).toEqual([{ text: "inside", start: 10, end: 11 }]);
	});

	test("rebases raw word timestamps to clip start", () => {
		const clipped = clipTranscriptWordsForWindow({
			words: [
				{ word: "uh", start: 9.8, end: 10.1 },
				{ word: "hello", start: 10.2, end: 10.6 },
				{ word: "world", start: 17.5, end: 18.4 },
			],
			startTime: 10,
			endTime: 18,
		});

		expect(clipped).toHaveLength(3);
		expect(clipped[0]?.word).toBe("uh");
		expect(clipped[0]?.start).toBeCloseTo(0, 6);
		expect(clipped[0]?.end).toBeCloseTo(0.1, 6);
		expect(clipped[1]?.word).toBe("hello");
		expect(clipped[1]?.start).toBeCloseTo(0.2, 6);
		expect(clipped[1]?.end).toBeCloseTo(0.6, 6);
		expect(clipped[2]?.word).toBe("world");
		expect(clipped[2]?.start).toBeCloseTo(7.5, 6);
		expect(clipped[2]?.end).toBeCloseTo(8, 6);
	});

	test("does not prefer an unsuitable media-linked transcript over a valid cached transcript", async () => {
		const asset = buildTestAsset();
		const cached = buildClipTranscriptCacheEntryForAsset({
			asset,
			modelId: "whisper-large-v3",
			language: "auto",
			text: "This cached transcript covers the full source and includes multiple sections across the timeline.",
			segments: [
				{ text: "Full transcript intro section.", start: 0, end: 20 },
				{ text: "Middle section with more content.", start: 70, end: 92 },
				{
					text: "Late section with a clean standalone ending.",
					start: 140,
					end: 165,
				},
				{
					text: "Closing context that still belongs in the source.",
					start: 165,
					end: 178,
				},
				{ text: "Final sentence.", start: 178, end: 180 },
			],
		});
		const project: TProject = {
			...buildTestProject(),
			externalMediaLinks: {
				[asset.id]: {
					sourceSystem: "thumbnail_decoupled",
					externalProjectId: "external-1",
					linkedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
				},
			},
			externalTranscriptCache: {
				"thumbnail_decoupled:external-1": {
					sourceSystem: "thumbnail_decoupled",
					externalProjectId: "external-1",
					transcriptText: "Short intro only.",
					segments: [{ text: "Short intro only.", start: 0, end: 8 }],
					segmentsCount: 1,
					audioDurationSeconds: 180,
					updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
				},
			},
			clipTranscriptCache: {
				[cached.cacheKey]: cached.transcript,
			},
		};

		const result = await getOrCreateClipTranscriptForAsset({
			project,
			asset,
			modelId: "whisper-large-v3",
			language: "auto",
		});

		expect(result.source).toBe("cache");
		expect(result.transcript.segments).toEqual(cached.transcript.segments);
	});

	test("ignores legacy project media transcript links without speaker annotation version", async () => {
		const asset = buildTestAsset();
		const cached = buildClipTranscriptCacheEntryForAsset({
			asset,
			modelId: "whisper-large-v3",
			language: "en",
			text: "Fresh diarized transcript.",
			segments: [
				{
					text: "Fresh diarized transcript.",
					start: 0,
					end: 3,
					speakerId: "SPEAKER_00",
				},
			],
			words: [
				{
					word: "Fresh",
					start: 0,
					end: 1,
					speakerId: "SPEAKER_00",
				},
				{
					word: "diarized",
					start: 1,
					end: 2,
					speakerId: "SPEAKER_00",
				},
			],
		});
		const project: TProject = {
			...buildTestProject(),
			mediaTranscriptLinks: {
				legacy: {
					modelId: "whisper-large-v3",
					language: "en",
					text: "Old transcript without speakers.",
					segments: [{ text: "Old transcript without speakers.", start: 0, end: 3 }],
					words: [{ word: "Old", start: 0, end: 1 }],
					updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
				},
			},
			clipTranscriptCache: {
				[cached.cacheKey]: cached.transcript,
			},
		};
		asset.transcriptLinkKey = "legacy";

		const result = await getOrCreateClipTranscriptForAsset({
			project,
			asset,
			modelId: "whisper-large-v3",
			language: "en",
		});

		expect(result.source).toBe("cache");
		expect(result.transcript.words?.[0]?.speakerId).toBe("SPEAKER_00");
	});
});
