import { describe, expect, test } from "bun:test";
import { expandElementIdsWithAlignedCompanions } from "@/lib/timeline/companion-media";
import type { TimelineTrack } from "@/types/timeline";

describe("expandElementIdsWithAlignedCompanions", () => {
	test("includes strongly aligned video/audio companions even when media ids differ", () => {
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
						startTime: 10,
						duration: 4,
						trimStart: 2,
						trimEnd: 1,
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
				elements: [
					{
						id: "audio-1",
						type: "audio",
						name: "Audio",
						sourceType: "upload",
						mediaId: "audio-media-1",
						startTime: 10.01,
						duration: 4.01,
						trimStart: 2.02,
						trimEnd: 0.98,
						volume: 1,
					},
				],
			},
		];

		const expanded = expandElementIdsWithAlignedCompanions({
			tracks,
			elementIds: ["video-1"],
		});

		expect(expanded.has("video-1")).toBe(true);
		expect(expanded.has("audio-1")).toBe(true);
	});
});
