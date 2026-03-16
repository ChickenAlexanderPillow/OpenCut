import { expect, test } from "bun:test";
import { transformProjectV10ToV11 } from "../transformers/v10-to-v11";

test("adds normalized reframe fields to legacy video elements", () => {
	const result = transformProjectV10ToV11({
		project: {
			id: "project-v10",
			version: 10,
			scenes: [
				{
					id: "scene-1",
					tracks: [
						{
							id: "track-1",
							type: "video",
							elements: [
								{
									id: "video-1",
									type: "video",
									mediaId: "media-1",
									name: "Clip",
									startTime: 0,
									duration: 6,
									trimStart: 0,
									trimEnd: 0,
									muted: false,
									hidden: false,
									transform: {
										position: { x: 0, y: 0 },
										scale: 2,
										rotate: 0,
									},
									opacity: 1,
								},
							],
						},
					],
				},
			],
		},
	});

	expect(result.skipped).toBe(false);
	expect(result.project.version).toBe(11);
	const scenes = result.project.scenes as Array<Record<string, unknown>>;
	const tracks = (scenes[0]?.tracks ?? []) as Array<Record<string, unknown>>;
	const elements = (tracks[0]?.elements ?? []) as Array<Record<string, unknown>>;
	const videoElement = elements[0] as Record<string, unknown>;
	expect(videoElement.reframePresets).toEqual([]);
	expect(videoElement.reframeSwitches).toEqual([]);
	expect(videoElement.defaultReframePresetId).toBeNull();
});
