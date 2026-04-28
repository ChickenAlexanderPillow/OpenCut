import { describe, expect, test } from "bun:test";
import {
	filterTracksByExportContent,
	getLastMediaEndTime,
	resolveExportRenderPlan,
} from "./renderer-manager";
import type { MediaAsset } from "@/types/assets";
import type { TimelineTrack } from "@/types/timeline";

describe("renderer-manager export range helpers", () => {
	test("prefers the last media end over non-media tails", () => {
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
				hidden: false,
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

	test("keeps the project render plan unchanged for project aspect export", () => {
		const tracks: TimelineTrack[] = [];
		const plan = resolveExportRenderPlan({
			tracks,
			mediaAssets: [],
			projectCanvasSize: { width: 1920, height: 1080 },
			projectBackground: { type: "color", color: "#123456" },
			aspect: "project",
		});

		expect(plan.canvasSize).toEqual({ width: 1920, height: 1080 });
		expect(plan.background).toEqual({ type: "color", color: "#123456" });
		expect(plan.tracks).toBe(tracks);
	});

	test("builds a square render plan for square aspect export", () => {
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
						mediaId: "media-square",
						name: "Square clip",
						startTime: 0,
						duration: 8,
						trimStart: 0,
						trimEnd: 0,
						transform: {
							position: { x: 177.7777777778, y: 0 },
							scale: 1.7777777778,
							rotate: 0,
						},
						opacity: 1,
					},
				],
			},
		];
		const mediaAssets: MediaAsset[] = [
			{
				id: "media-square",
				type: "video",
				name: "Square clip",
				file: new File(["x"], "square.mp4", { type: "video/mp4" }),
				width: 1080,
				height: 1080,
				duration: 8,
			},
		];

		const plan = resolveExportRenderPlan({
			tracks,
			mediaAssets,
			projectCanvasSize: { width: 1920, height: 1080 },
			projectBackground: { type: "color", color: "#ffffff" },
			aspect: "square",
		});

		expect(plan.canvasSize).toEqual({ width: 1080, height: 1080 });
		expect(plan.background).toEqual({ type: "color", color: "#ffffff" });
		const remappedTrack = plan.tracks[0];
		expect(remappedTrack?.type).toBe("video");
		if (!remappedTrack || remappedTrack.type !== "video") return;
		expect(remappedTrack.elements[0]?.transform.scale).toBeCloseTo(1, 6);
		expect(remappedTrack.elements[0]?.transform.position.x).toBeCloseTo(100, 6);
	});

	test("keeps only generated caption text tracks plus audio for transparent caption export", () => {
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
				id: "audio-track",
				type: "audio",
				name: "Audio",
				muted: false,
				elements: [
					{
						id: "audio-1",
						type: "audio",
						name: "Audio",
						startTime: 0,
						duration: 8,
						trimStart: 0,
						trimEnd: 0,
						volume: 1,
						sourceType: "upload",
						mediaId: "audio-1",
					},
				],
			},
			{
				id: "text-track",
				type: "text",
				name: "Text",
				hidden: false,
				elements: [
					{
						id: "text-1",
						type: "text",
						name: "Title",
						content: "title",
						startTime: 0,
						duration: 3,
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
			{
				id: "captions-track",
				type: "text",
				name: "Captions",
				hidden: false,
				elements: [
					{
						id: "caption-1",
						type: "text",
						name: "Caption 1",
						content: "hello",
						startTime: 0,
						duration: 3,
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
						captionWordTimings: [
							{ word: "hello", startTime: 0, endTime: 0.5 },
						],
					},
				],
			},
		];

		const filtered = filterTracksByExportContent({
			tracks,
			content: "captions_only_transparent",
		});

		expect(filtered.map((track) => track.id)).toEqual([
			"audio-track",
			"captions-track",
		]);
	});
});
