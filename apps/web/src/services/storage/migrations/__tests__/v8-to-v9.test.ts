import { describe, expect, test } from "bun:test";
import { transformProjectV8ToV9 } from "../transformers/v8-to-v9";

describe("V8 to V9 Migration", () => {
	test("removes aligned companion audio, unmutes video, and preserves transcript on video", () => {
		const audioTranscriptEdit = {
			version: 1,
			source: "word-level",
			words: [{ id: "w0", text: "hello", startTime: 0, endTime: 0.4, removed: false }],
			cuts: [],
			updatedAt: "2026-03-01T10:00:00.000Z",
		};
		const project = {
			id: "project-v8",
			version: 8,
			scenes: [
				{
					id: "scene-1",
					tracks: [
						{
							id: "video-track",
							type: "video",
							isMain: true,
							elements: [
								{
									id: "video-1",
									type: "video",
									mediaId: "media-1",
									startTime: 0,
									duration: 12,
									trimStart: 8,
									trimEnd: 10,
									muted: true,
								},
							],
						},
						{
							id: "audio-track",
							type: "audio",
							elements: [
								{
									id: "audio-1",
									type: "audio",
									sourceType: "upload",
									mediaId: "media-1",
									startTime: 0,
									duration: 12,
									trimStart: 8,
									trimEnd: 10,
									volume: 1,
									muted: false,
									transcriptEdit: audioTranscriptEdit,
								},
							],
						},
						{
							id: "caption-track",
							type: "text",
							elements: [
								{
									id: "caption-1",
									type: "text",
									captionSourceRef: { mediaElementId: "video-1", transcriptVersion: 1 },
								},
							],
						},
					],
				},
			],
		};

		const result = transformProjectV8ToV9({
			project: project as Parameters<typeof transformProjectV8ToV9>[0]["project"],
		});

		expect(result.skipped).toBe(false);
		expect(result.project.version).toBe(9);
		const scene = (result.project.scenes as Array<{ tracks: Array<Record<string, unknown>> }>)[0];
		const videoTrack = scene.tracks.find((track) => track.type === "video");
		const migratedVideo = (videoTrack?.elements as Array<Record<string, unknown>>)[0];
		expect(migratedVideo.muted).toBe(false);
		expect(migratedVideo.transcriptEdit).toEqual(audioTranscriptEdit);

		const audioTrack = scene.tracks.find((track) => track.type === "audio");
		expect(audioTrack).toBeUndefined();

		const captionTrack = scene.tracks.find((track) => track.type === "text");
		expect(captionTrack).toBeDefined();
		expect((captionTrack?.elements as Array<Record<string, unknown>>)[0]?.captionSourceRef).toEqual(
			{ mediaElementId: "video-1", transcriptVersion: 1 },
		);
	});

	test("keeps non-companion audio tracks untouched", () => {
		const project = {
			id: "project-v8-keep-audio",
			version: 8,
			scenes: [
				{
					id: "scene-1",
					tracks: [
						{
							id: "video-track",
							type: "video",
							isMain: true,
							elements: [
								{
									id: "video-1",
									type: "video",
									mediaId: "media-1",
									startTime: 0,
									duration: 8,
									trimStart: 0,
									trimEnd: 0,
									muted: false,
								},
							],
						},
						{
							id: "audio-track",
							type: "audio",
							elements: [
								{
									id: "audio-1",
									type: "audio",
									sourceType: "upload",
									mediaId: "media-2",
									startTime: 1,
									duration: 4,
									trimStart: 0,
									trimEnd: 0,
									volume: 1,
								},
							],
						},
					],
				},
			],
		};

		const result = transformProjectV8ToV9({
			project: project as Parameters<typeof transformProjectV8ToV9>[0]["project"],
		});

		expect(result.skipped).toBe(false);
		expect(result.project.version).toBe(9);
		const scene = (result.project.scenes as Array<{ tracks: Array<Record<string, unknown>> }>)[0];
		const audioTrack = scene.tracks.find((track) => track.type === "audio");
		expect(audioTrack).toBeDefined();
		expect((audioTrack?.elements as unknown[]).length).toBe(1);
	});

	test("skips projects already at v9", () => {
		const result = transformProjectV8ToV9({
			project: {
				id: "project-v9",
				version: 9,
				scenes: [],
			} as Parameters<typeof transformProjectV8ToV9>[0]["project"],
		});

		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("already v9");
	});
});
