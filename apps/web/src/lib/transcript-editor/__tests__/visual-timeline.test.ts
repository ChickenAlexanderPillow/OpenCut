import { describe, expect, test } from "bun:test";
import {
	buildTimelineVisualModel,
	getTimelineElementVisualLayout,
	mapRealTimeToVisualTime,
	mapVisualTimeToRealTime,
} from "@/lib/transcript-editor/visual-timeline";
import type { TextElement, TimelineTrack, VideoElement } from "@/types/timeline";

const DEFAULT_TRANSFORM = {
	scale: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
} as const;

function createVideoElement({
	id,
	startTime,
	duration,
	removedRanges = [],
}: {
	id: string;
	startTime: number;
	duration: number;
	removedRanges?: Array<{ start: number; end: number }>;
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
			removedRanges.length > 0
				? {
						version: 1,
						revisionKey: `${id}:rev`,
						updatedAt: "2026-03-10T00:00:00.000Z",
						removedRanges: removedRanges.map((cut) => ({
							...cut,
							reason: "manual" as const,
						})),
						keptSegments: [],
						timeMap: {
							cutBoundaries: [],
							sourceDuration: duration,
							playableDuration:
								duration -
								removedRanges.reduce(
									(sum, cut) => sum + (cut.end - cut.start),
									0,
								),
						},
						captionPayload: null,
				  }
				: undefined,
	};
}

function createCaptionElement({
	id,
	startTime,
	duration,
	mediaElementId,
}: {
	id: string;
	startTime: number;
	duration: number;
	mediaElementId: string;
}): TextElement {
	return {
		id,
		name: id,
		type: "text",
		content: "Caption",
		startTime,
		duration,
		trimStart: 0,
		trimEnd: 0,
		fontSize: 32,
		fontFamily: "sans",
		color: "#fff",
		background: { color: "transparent" },
		textAlign: "center",
		fontWeight: "normal",
		fontStyle: "normal",
		textDecoration: "none",
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		captionSourceRef: {
			mediaElementId,
			transcriptVersion: 1,
		},
	};
}

describe("visual transcript timeline", () => {
	test("builds a condensed visual duration from main-track transcript cuts", () => {
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
						removedRanges: [{ start: 3, end: 6 }],
					}),
					createVideoElement({
						id: "clip-b",
						startTime: 10,
						duration: 5,
					}),
				],
			},
		];

		const model = buildTimelineVisualModel({ tracks, duration: 15 });

		expect(model.totalVisualDuration).toBeCloseTo(12, 6);
		expect(mapRealTimeToVisualTime({ time: 10, model })).toBeCloseTo(7, 6);
		expect(mapVisualTimeToRealTime({ time: 7, model })).toBeCloseTo(10, 6);
	});

	test("clamps a removed region to a single visual cut marker time", () => {
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
						removedRanges: [{ start: 3, end: 6 }],
					}),
				],
			},
		];

		const model = buildTimelineVisualModel({ tracks, duration: 10 });

		expect(mapRealTimeToVisualTime({ time: 2.5, model })).toBeCloseTo(2.5, 6);
		expect(mapRealTimeToVisualTime({ time: 3.2, model })).toBeCloseTo(3, 6);
		expect(mapRealTimeToVisualTime({ time: 6.8, model })).toBeCloseTo(3.8, 6);
		expect(mapVisualTimeToRealTime({ time: 3, model })).toBeCloseTo(6, 6);
	});

	test("renders linked captions with matching condensed layout and cut markers", () => {
		const video = createVideoElement({
			id: "clip-a",
			startTime: 5,
			duration: 10,
			removedRanges: [{ start: 2, end: 4 }],
		});
		const caption = createCaptionElement({
			id: "caption-a",
			startTime: 5,
			duration: 10,
			mediaElementId: video.id,
		});
		const tracks: TimelineTrack[] = [
			{
				id: "main-track",
				name: "Main",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [video],
			},
			{
				id: "caption-track",
				name: "Captions",
				type: "text",
				hidden: false,
				elements: [caption],
			},
		];

		const model = buildTimelineVisualModel({ tracks, duration: 15 });
		const layout = getTimelineElementVisualLayout({
			element: caption,
			tracks,
			model,
		});

		expect(layout.visualStartTime).toBeCloseTo(5, 6);
		expect(layout.visualDuration).toBeCloseTo(8, 6);
		expect(layout.cutMarkers).toHaveLength(1);
		expect(layout.cutMarkers[0]?.leftPercent).toBeCloseTo(25, 2);
	});
});
