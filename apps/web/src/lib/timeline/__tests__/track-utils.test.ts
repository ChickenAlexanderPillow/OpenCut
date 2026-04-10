import { describe, expect, test } from "bun:test";
import { enforceMainTrackStart } from "@/lib/timeline/track-utils";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

function buildVideoElement(
	id: string,
	startTime: number,
	duration: number,
): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: `${id}-media`,
		startTime,
		duration,
		trimStart: 0,
		trimEnd: 0,
		opacity: 1,
		transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
	};
}

describe("track utils", () => {
	test("keeps the earliest main-track element pinned to zero when no other visual layer covers timeline start", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "main-track",
				type: "video",
				name: "Main",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [buildVideoElement("main", 0, 6)],
			},
		];

		expect(
			enforceMainTrackStart({
				tracks,
				targetTrackId: "main-track",
				requestedStartTime: 2,
				excludeElementId: "main",
			}),
		).toBe(0);
	});

	test("allows the earliest main-track element to move later when another visible video layer already covers timeline start", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "overlay-track",
				type: "video",
				name: "Overlay",
				isMain: false,
				muted: false,
				hidden: false,
				elements: [buildVideoElement("overlay", 0, 6)],
			},
			{
				id: "main-track",
				type: "video",
				name: "Main",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [buildVideoElement("main", 0, 6)],
			},
		];

		expect(
			enforceMainTrackStart({
				tracks,
				targetTrackId: "main-track",
				requestedStartTime: 2,
				excludeElementId: "main",
			}),
		).toBe(2);
	});
});
