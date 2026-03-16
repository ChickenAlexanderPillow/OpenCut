import { describe, expect, test } from "bun:test";
import { collectAudioClips } from "@/lib/media/audio";
import type { MediaAsset } from "@/types/assets";
import type { TimelineTrack } from "@/types/timeline";

function createFile(name: string, type: string): File {
	return new File([new Uint8Array([1, 2, 3, 4])], name, {
		type,
		lastModified: 1,
	});
}

describe("collectAudioClips companion suppression", () => {
	test("routes aligned uploaded companion audio through the video media source when media ids differ", async () => {
		const mediaAssets: MediaAsset[] = [
			{
				id: "video-media-1",
				type: "video",
				name: "Video",
				file: createFile("video.mp4", "video/mp4"),
				url: "https://example.com/video.mp4",
				duration: 10,
				width: 1920,
				height: 1080,
				size: 4,
				lastModified: 1,
				createdAt: new Date("2026-03-01T00:00:00.000Z"),
				updatedAt: new Date("2026-03-01T00:00:00.000Z"),
			},
			{
				id: "audio-media-1",
				type: "audio",
				name: "Audio",
				file: createFile("audio.wav", "audio/wav"),
				url: "https://example.com/audio.wav",
				duration: 10,
				width: null,
				height: null,
				size: 4,
				lastModified: 1,
				createdAt: new Date("2026-03-01T00:00:00.000Z"),
				updatedAt: new Date("2026-03-01T00:00:00.000Z"),
			},
		];

		const tracks: TimelineTrack[] = [
			{
				id: "video-track",
				type: "video",
				name: "Video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [
					{
						id: "video-1",
						type: "video",
						name: "Video",
						mediaId: "video-media-1",
						startTime: 2,
						duration: 4,
						trimStart: 1,
						trimEnd: 5,
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
						name: "Audio",
						sourceType: "upload",
						mediaId: "audio-media-1",
						startTime: 2.01,
						duration: 4.01,
						trimStart: 1.02,
						trimEnd: 4.97,
						volume: 1,
						muted: false,
					},
				],
			},
		];

		const clips = await collectAudioClips({
			tracks,
			mediaAssets,
		});

		expect(clips).toHaveLength(1);
		expect(clips[0]?.id).toBe("audio-1");
		expect(clips[0]?.sourceKey).toBe("video-media-1");
		expect(clips[0]?.mediaIdentity.id).toBe("video-media-1");
	});
});
