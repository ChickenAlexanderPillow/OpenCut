import { describe, expect, test } from "bun:test";
import { transformProjectV9ToV10 } from "../transformers/v9-to-v10";

describe("V9 to V10 Migration", () => {
	test("backfills audio effects on audio-capable tracks", () => {
		const project = {
			id: "project-v9",
			version: 9,
			scenes: [
				{
					id: "scene-1",
					tracks: [
						{
							id: "video-track",
							type: "video",
							name: "Video Track",
							isMain: true,
							muted: false,
							elements: [],
						},
						{
							id: "audio-track",
							type: "audio",
							name: "Audio Track",
							muted: false,
							volume: 1.25,
							elements: [],
						},
						{
							id: "text-track",
							type: "text",
							name: "Text Track",
							hidden: false,
							elements: [],
						},
					],
				},
			],
		};

		const result = transformProjectV9ToV10({
			project: project as Parameters<typeof transformProjectV9ToV10>[0]["project"],
		});

		expect(result.skipped).toBe(false);
		expect(result.project.version).toBe(10);
		const scene = (result.project.scenes as Array<{ tracks: Array<Record<string, unknown>> }>)[0];
		const videoTrack = scene.tracks.find((track) => track.id === "video-track");
		const audioTrack = scene.tracks.find((track) => track.id === "audio-track");
		const textTrack = scene.tracks.find((track) => track.id === "text-track");

		expect(videoTrack?.audioEffects).toBeDefined();
		expect(audioTrack?.audioEffects).toBeDefined();
		expect((audioTrack?.audioEffects as { eq: { enabled: boolean } }).eq.enabled).toBe(false);
		expect(textTrack?.audioEffects).toBeUndefined();
	});

	test("skips projects already at v10", () => {
		const result = transformProjectV9ToV10({
			project: {
				id: "project-v10",
				version: 10,
				scenes: [],
			} as Parameters<typeof transformProjectV9ToV10>[0]["project"],
		});

		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("already v10");
	});
});
