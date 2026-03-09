import { describe, expect, test } from "bun:test";
import {
	buildCompressedVisualTracks,
	mapPlaybackTimeToCompressedVisualTime,
} from "@/lib/transcript-editor/visual-timeline";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

const DEFAULT_TRANSFORM = {
	scale: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
} as const;

function createVideoElement({
	id,
	startTime,
	duration,
	playableDuration,
}: {
	id: string;
	startTime: number;
	duration: number;
	playableDuration?: number;
}): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: id,
		startTime,
		duration,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		transcriptApplied:
			typeof playableDuration === "number"
				? {
						version: 1,
						revisionKey: `${id}:rev`,
						updatedAt: "2026-03-09T00:00:00.000Z",
						removedRanges: [],
						keptSegments: [],
						timeMap: {
							cutBoundaries: [],
							sourceDuration: duration,
							playableDuration,
						},
						captionPayload: null,
				  }
				: undefined,
	};
}

describe("visual transcript timeline", () => {
	test("compresses transcript-edited main track visuals and shifts following clips earlier", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "main-track",
				name: "Main",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [
					createVideoElement({
						id: "clip-a",
						startTime: 0,
						duration: 10,
						playableDuration: 7,
					}),
					createVideoElement({
						id: "clip-b",
						startTime: 10,
						duration: 5,
					}),
				],
			},
		];

		const compressed = buildCompressedVisualTracks({ tracks });
		const mainTrack = compressed[0];
		const clipA = mainTrack?.elements[0];
		const clipB = mainTrack?.elements[1];

		expect(clipA?.duration).toBeCloseTo(7, 6);
		expect(clipB?.startTime).toBeCloseTo(7, 6);
	});

	test("maps playhead time to compressed visual time after edited clip playable end", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "main-track",
				name: "Main",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [
					createVideoElement({
						id: "clip-a",
						startTime: 0,
						duration: 10,
						playableDuration: 7,
					}),
				],
			},
		];

		expect(
			mapPlaybackTimeToCompressedVisualTime({
				time: 6.5,
				tracks,
			}),
		).toBeCloseTo(6.5, 6);
		expect(
			mapPlaybackTimeToCompressedVisualTime({
				time: 7.2,
				tracks,
			}),
		).toBeCloseTo(4.2, 6);
	});
});
