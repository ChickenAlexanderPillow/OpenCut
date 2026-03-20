import { describe, expect, test } from "bun:test";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { getTrackGaps, rippleDeleteGapFromTrack } from "@/lib/timeline/gap-utils";
import type { TextTrack, VideoTrack } from "@/types/timeline";

describe("gap utils", () => {
	test("detects a leading gap from 00:00 and internal gaps", () => {
		const track: VideoTrack = {
			id: "video-track-1",
			name: "Video",
			type: "video",
			isMain: true,
			muted: false,
			hidden: false,
			elements: [
				{
					id: "clip-1",
					type: "video",
					name: "Clip 1",
					mediaId: "media-1",
					startTime: 3,
					duration: 2,
					trimStart: 0,
					trimEnd: 0,
					transform: DEFAULT_TRANSFORM,
					opacity: 1,
				},
				{
					id: "clip-2",
					type: "video",
					name: "Clip 2",
					mediaId: "media-2",
					startTime: 7,
					duration: 1.5,
					trimStart: 0,
					trimEnd: 0,
					transform: DEFAULT_TRANSFORM,
					opacity: 1,
				},
			],
		};

		expect(getTrackGaps({ track })).toEqual([
			{ trackId: "video-track-1", startTime: 0, endTime: 3 },
			{ trackId: "video-track-1", startTime: 5, endTime: 7 },
		]);
	});

	test("does not expose selectable gaps for caption tracks", () => {
		const track: TextTrack = {
			id: "caption-track-1",
			name: "Captions",
			type: "text",
			hidden: false,
			elements: [
				{
					id: "caption-1",
					type: "text",
					name: "Caption 1",
					content: "hello",
					startTime: 4,
					duration: 1,
					trimStart: 0,
					trimEnd: 0,
					fontSize: 48,
					fontFamily: "Geist",
					color: "#fff",
					background: { color: "transparent" },
					textAlign: "center",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					transform: DEFAULT_TRANSFORM,
					opacity: 1,
					captionWordTimings: [
						{ word: "hello", startTime: 4, endTime: 4.45, hidden: false },
					],
					captionSourceRef: {
						mediaElementId: "video-1",
						transcriptVersion: 1,
					},
				},
			],
		};

		expect(getTrackGaps({ track })).toEqual([]);
	});

	test("ripple deletes a selected gap and shifts absolute caption timings", () => {
		const track: TextTrack = {
			id: "text-track-1",
			name: "Text",
			type: "text",
			hidden: false,
			elements: [
				{
					id: "text-1",
					type: "text",
					name: "Title 1",
					content: "hello",
					startTime: 4,
					duration: 1,
					trimStart: 0,
					trimEnd: 0,
					fontSize: 48,
					fontFamily: "Geist",
					color: "#fff",
					background: { color: "transparent" },
					textAlign: "center",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					transform: DEFAULT_TRANSFORM,
					opacity: 1,
					captionWordTimings: [
						{ word: "hello", startTime: 4, endTime: 4.45, hidden: false },
					],
				},
			],
		};

		const updated = rippleDeleteGapFromTrack({
			track,
			gap: { trackId: "text-track-1", startTime: 0, endTime: 2 },
		});

		expect(updated.elements[0]?.startTime).toBeCloseTo(2, 6);
		expect(updated.elements[0]?.type).toBe("text");
		if (updated.elements[0]?.type !== "text") return;
		expect(updated.elements[0].captionWordTimings?.[0]?.startTime).toBeCloseTo(
			2,
			6,
		);
		expect(updated.elements[0].captionWordTimings?.[0]?.endTime).toBeCloseTo(
			2.45,
			6,
		);
	});

	test("does not ripple delete gaps directly from caption tracks", () => {
		const track: TextTrack = {
			id: "caption-track-1",
			name: "Captions",
			type: "text",
			hidden: false,
			elements: [
				{
					id: "caption-1",
					type: "text",
					name: "Caption 1",
					content: "hello",
					startTime: 4,
					duration: 1,
					trimStart: 0,
					trimEnd: 0,
					fontSize: 48,
					fontFamily: "Geist",
					color: "#fff",
					background: { color: "transparent" },
					textAlign: "center",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					transform: DEFAULT_TRANSFORM,
					opacity: 1,
					captionWordTimings: [
						{ word: "hello", startTime: 4, endTime: 4.45, hidden: false },
					],
					captionSourceRef: {
						mediaElementId: "video-1",
						transcriptVersion: 1,
					},
				},
			],
		};

		const updated = rippleDeleteGapFromTrack({
			track,
			gap: { trackId: "caption-track-1", startTime: 0, endTime: 2 },
		});

		expect(updated).toEqual(track);
	});
});
