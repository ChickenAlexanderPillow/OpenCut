import { describe, expect, test } from "bun:test";
import { normalizeLegacyCompanionAudioInScenes } from "@/lib/timeline/legacy-companion-audio";
import type { AudioElement, TScene } from "@/types/timeline";

function buildSceneWithCompanion({
	withExtraAudio = false,
}: {
	withExtraAudio?: boolean;
} = {}): TScene {
	return {
		id: "scene-1",
		name: "Scene",
		isMain: true,
		bookmarks: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		tracks: [
			{
				id: "video-track",
				type: "video",
				name: "Main Track",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [
					{
						id: "video-1",
						type: "video",
						mediaId: "media-1",
						name: "clip",
						startTime: 0,
						duration: 8,
						trimStart: 5,
						trimEnd: 12,
						muted: true,
						hidden: false,
						transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
						opacity: 1,
					},
				],
			},
			{
				id: "audio-track",
				type: "audio",
				name: "Audio",
				muted: false,
				volume: 1,
				elements: [
					{
						id: "audio-1",
						type: "audio",
						sourceType: "upload",
						mediaId: "media-1",
						name: "clip audio",
						startTime: 0,
						duration: 8,
						trimStart: 5,
						trimEnd: 12,
						volume: 1,
						muted: false,
						transcriptEdit: {
							version: 1,
							source: "word-level",
							words: [
								{ id: "w0", text: "hello", startTime: 0, endTime: 0.5, removed: false },
							],
							cuts: [],
							updatedAt: "2026-03-01T10:00:00.000Z",
						},
					},
					...(withExtraAudio
						? ([
								{
									id: "audio-2",
									type: "audio" as const,
									sourceType: "library" as const,
									sourceUrl: "https://example.com/music.mp3",
									name: "music",
									startTime: 1,
									duration: 4,
									trimStart: 0,
									trimEnd: 0,
									volume: 1,
									muted: false,
								},
						  ] satisfies AudioElement[])
						: []),
				],
			},
		],
	};
}

describe("normalizeLegacyCompanionAudioInScenes", () => {
	test("removes companion audio and unmutes video", () => {
		const scene = buildSceneWithCompanion();
		const result = normalizeLegacyCompanionAudioInScenes({ scenes: [scene] });

		expect(result.changed).toBe(true);
		const nextScene = result.scenes[0];
		const videoTrack = nextScene.tracks.find((track) => track.type === "video");
		expect(videoTrack?.type).toBe("video");
		if (!videoTrack || videoTrack.type !== "video") return;
		expect(videoTrack.elements[0]?.type).toBe("video");
		if (videoTrack.elements[0]?.type !== "video") return;
		expect(videoTrack.elements[0].muted).toBe(false);
		expect(videoTrack.elements[0].transcriptEdit).toBeDefined();

		const audioTrack = nextScene.tracks.find((track) => track.type === "audio");
		expect(audioTrack).toBeUndefined();
	});

	test("keeps unrelated audio elements on mixed audio tracks", () => {
		const scene = buildSceneWithCompanion({ withExtraAudio: true });
		const result = normalizeLegacyCompanionAudioInScenes({ scenes: [scene] });
		expect(result.changed).toBe(true);
		const nextScene = result.scenes[0];
		const audioTrack = nextScene.tracks.find((track) => track.type === "audio");
		expect(audioTrack?.type).toBe("audio");
		if (!audioTrack || audioTrack.type !== "audio") return;
		expect(audioTrack.elements).toHaveLength(1);
		expect(audioTrack.elements[0]?.type).toBe("audio");
		if (audioTrack.elements[0]?.type !== "audio") return;
		expect(audioTrack.elements[0].sourceType).toBe("library");
	});
});
