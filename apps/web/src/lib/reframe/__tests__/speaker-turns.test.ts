import { describe, expect, test } from "bun:test";
import type { VideoElement } from "@/types/timeline";
import { buildSpeakerTurnReframeSwitches } from "../speaker-turns";

const baseElement: VideoElement = {
	id: "video-1",
	type: "video",
	mediaId: "media-1",
	name: "Clip",
	startTime: 0,
	duration: 10,
	trimStart: 0,
	trimEnd: 0,
	muted: false,
	hidden: false,
	transform: {
		position: { x: 0, y: 0 },
		scale: 1.8,
		rotate: 0,
	},
	opacity: 1,
	reframePresets: [
		{
			id: "subject-left",
			name: "Subject Left",
			transform: {
				position: { x: -140, y: -20 },
				scale: 2.4,
			},
			subjectSeed: {
				center: { x: 480, y: 220 },
				size: { width: 120, height: 180 },
				identity: "left",
			},
		},
		{
			id: "subject-right",
			name: "Subject Right",
			transform: {
				position: { x: 140, y: -20 },
				scale: 2.4,
			},
			subjectSeed: {
				center: { x: 1440, y: 220 },
				size: { width: 120, height: 180 },
				identity: "right",
			},
		},
	],
	transcriptDraft: {
		version: 1,
		source: "word-level",
		words: [
			{
				id: "word-1",
				text: "Hello",
				startTime: 0,
				endTime: 0.7,
				speakerId: "speaker-a",
			},
			{
				id: "word-2",
				text: "there",
				startTime: 0.72,
				endTime: 1.1,
				speakerId: "speaker-a",
			},
			{
				id: "word-3",
				text: "reply",
				startTime: 2,
				endTime: 2.7,
				speakerId: "speaker-b",
			},
		],
		cuts: [],
		updatedAt: new Date(0).toISOString(),
	},
};

describe("speaker turn reframes", () => {
	test("falls back to the only available subject in single-subject sections", () => {
		const result = buildSpeakerTurnReframeSwitches({
			element: {
				...baseElement,
				reframeAvailabilitySections: [
					{
						id: "availability-1",
						startTime: 0,
						availablePresetIds: ["subject-left", "subject-right"],
					},
					{
						id: "availability-2",
						startTime: 1.5,
						availablePresetIds: ["subject-left"],
					},
				],
			},
		});

		expect(result).not.toBeNull();
		expect(result?.defaultPresetId).toBe("subject-left");
		expect(result?.switches).toEqual([]);
	});
});
