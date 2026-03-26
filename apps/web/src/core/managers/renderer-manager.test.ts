import { describe, expect, test } from "bun:test";
import { getLastMediaEndTime } from "./renderer-manager";
import type { TimelineTrack } from "@/types/timeline";

describe("renderer-manager export range helpers", () => {
	test("prefers the last media end over non-media tails", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "video-track",
				type: "video",
				name: "Video",
				elements: [
					{
						id: "video-1",
						type: "video",
						mediaId: "media-1",
						name: "Clip",
						startTime: 0,
						duration: 8,
						trimStart: 0,
						trimEnd: 0,
						transform: {
							position: { x: 0, y: 0 },
							scale: 1,
							rotate: 0,
						},
						opacity: 1,
					},
				],
			},
			{
				id: "text-track",
				type: "text",
				name: "Text",
				elements: [
					{
						id: "text-1",
						type: "text",
						name: "Caption tail",
						content: "tail",
						startTime: 0,
						duration: 20,
						trimStart: 0,
						trimEnd: 0,
						fontSize: 24,
						fontFamily: "Arial",
						color: "#fff",
						background: { color: "transparent" },
						textAlign: "center",
						fontWeight: "normal",
						fontStyle: "normal",
						textDecoration: "none",
						transform: {
							position: { x: 0, y: 0 },
							scale: 1,
							rotate: 0,
						},
						opacity: 1,
					},
				],
			},
		];

		expect(getLastMediaEndTime({ tracks })).toBe(8);
	});
});
