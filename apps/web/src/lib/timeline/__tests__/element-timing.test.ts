import { describe, expect, test } from "bun:test";
import {
	normalizeElementTiming,
	normalizeTimelineElementForInvariants,
	normalizeTimelineTracksForInvariants,
} from "@/lib/timeline/element-timing";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video",
		mediaId: "media-1",
		startTime: 2,
		duration: 4,
		trimStart: 1,
		trimEnd: 0,
		opacity: 1,
		transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
		...overrides,
	};
}

describe("element timing invariants", () => {
	test("anchors negative start to zero by consuming left trim and extending duration", () => {
		const result = normalizeElementTiming({
			startTime: -0.75,
			duration: 2,
			trimStart: 1.5,
			trimEnd: 0.25,
			minDuration: 1 / 30,
		});
		expect(result.startTime).toBe(0);
		expect(result.trimStart).toBeCloseTo(0.75, 6);
		expect(result.duration).toBeCloseTo(2.75, 6);
		expect(result.trimEnd).toBeCloseTo(0.25, 6);
	});

	test("normalizes non-finite/negative timing inputs", () => {
		const result = normalizeElementTiming({
			startTime: Number.NaN,
			duration: Number.NEGATIVE_INFINITY,
			trimStart: Number.NaN,
			trimEnd: -3,
			minDuration: 1 / 24,
		});
		expect(result.startTime).toBe(0);
		expect(result.duration).toBeGreaterThanOrEqual(1 / 24);
		expect(result.trimStart).toBe(0);
		expect(result.trimEnd).toBe(0);
	});

	test("returns same element reference when already valid", () => {
		const element = buildVideoElement();
		const normalized = normalizeTimelineElementForInvariants({
			element,
			minDuration: 1 / 30,
		});
		expect(normalized).toBe(element);
	});

	test("normalizes tracks and preserves references for unchanged tracks", () => {
		const changedElement = buildVideoElement({
			id: "video-changed",
			startTime: -1,
			trimStart: 0.5,
			duration: 3,
		});
		const unchangedElement = buildVideoElement({ id: "video-ok" });
		const tracks: TimelineTrack[] = [
			{
				id: "track-1",
				type: "video",
				name: "Main",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [changedElement],
			},
			{
				id: "track-2",
				type: "video",
				name: "Secondary",
				isMain: false,
				muted: false,
				hidden: false,
				elements: [unchangedElement],
			},
		];

		const normalized = normalizeTimelineTracksForInvariants({
			tracks,
			fps: 30,
		});
		expect(normalized).not.toBe(tracks);
		expect(normalized[0]).not.toBe(tracks[0]);
		expect(normalized[1]).toBe(tracks[1]);
		expect(normalized[0]?.elements[0]?.startTime).toBe(0);
	});
});
