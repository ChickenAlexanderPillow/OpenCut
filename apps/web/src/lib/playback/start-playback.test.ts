import { beforeEach, describe, expect, test } from "bun:test";
import {
	prewarmPlaybackVideoFrames,
	resolvePlaybackPreparationTime,
	startPlaybackWhenReady,
} from "./start-playback";
import { usePreviewStore } from "@/stores/preview-store";
import { videoCache } from "@/services/video-cache/service";

describe("start-playback", () => {
	beforeEach(() => {
		Object.defineProperty(globalThis, "window", {
			value: {
				setTimeout: (callback: () => void) => {
					callback();
					return 1;
				},
			},
			configurable: true,
		});
	});

	test("prepares playback from the range start when replaying from the end", () => {
		const editor = {
			playback: {
				getCurrentTime: () => 10,
				getPlaybackBounds: () => ({
					start: 0,
					end: 10,
					hasCustomRange: false,
				}),
			},
			timeline: {
				getTotalDuration: () => 10,
			},
		} as unknown as Parameters<typeof resolvePlaybackPreparationTime>[0]["editor"];

		expect(resolvePlaybackPreparationTime({ editor })).toBe(0);
	});

	test("startPlaybackWhenReady primes the effective restart playhead", async () => {
		const primedPlayheads: number[] = [];
		let playCalls = 0;
		let currentTime = 10;
		const seekTimes: number[] = [];
		let blockedReason: string | null = null;
		const editor = {
			playback: {
				getIsPlaying: () => false,
				getBlockedReason: () => blockedReason,
				setBlockedReason: ({ reason }: { reason: string | null }) => {
					blockedReason = reason;
				},
				getCurrentTime: () => currentTime,
				getPlaybackBounds: () => ({
					start: 0,
					end: 10,
					hasCustomRange: false,
				}),
				seek: ({ time }: { time: number }) => {
					currentTime = time;
					seekTimes.push(time);
				},
				play: () => {
					playCalls += 1;
				},
			},
			audio: {
				primeCurrentTimelineAudio: async ({
					playhead,
				}: {
					playhead?: number;
				} = {}) => {
					primedPlayheads.push(playhead ?? -1);
				},
			},
			timeline: {
				getTotalDuration: () => 10,
				getTracks: () => [],
			},
			media: {
				getAssets: () => [],
			},
			project: {
				getActive: () => ({
					settings: {
						fps: 30,
					},
				}),
			},
		} as unknown as Parameters<typeof startPlaybackWhenReady>[0]["editor"];

		await startPlaybackWhenReady({ editor });

		expect(seekTimes).toEqual([0]);
		expect(primedPlayheads).toEqual([0]);
		expect(playCalls).toBe(1);
		expect(blockedReason).toBeNull();
	});

	test("prewarms source frames immediately after transcript-compressed cuts", async () => {
		const requestedTimes: number[] = [];
		const originalGetState = usePreviewStore.getState;
		const originalGetFrameAt = videoCache.getFrameAt.bind(videoCache);
		const originalGetGPUFrameAt = videoCache.getGPUFrameAt.bind(videoCache);
		usePreviewStore.getState = () =>
			({
				playbackQuality: "balanced",
			}) as ReturnType<typeof usePreviewStore.getState>;
		videoCache.getFrameAt = (async ({ time }: { time: number }) => {
			requestedTimes.push(time);
			return null;
		}) as typeof videoCache.getFrameAt;
		videoCache.getGPUFrameAt = (async ({ time }: { time: number }) => {
			requestedTimes.push(time);
			return null;
		}) as typeof videoCache.getGPUFrameAt;

		try {
			const editor = {
				timeline: {
					getTracks: () => [
						{
							id: "track-1",
							type: "video",
							hidden: false,
							elements: [
								{
									id: "video-1",
									type: "video",
									mediaId: "media-1",
									name: "Clip",
									startTime: 0,
									duration: 2,
									trimStart: 0,
									trimEnd: 0,
									transform: {
										position: { x: 0, y: 0 },
										scale: 1,
										rotate: 0,
									},
									opacity: 1,
									transcriptApplied: {
										version: 1,
										updatedAt: "2026-03-26T00:00:00.000Z",
										revisionKey: "rev-1",
										removedRanges: [
											{ start: 0.1, end: 1.1, reason: "word-removed" },
										],
										keptSegments: [
											{ start: 0, end: 0.1, duration: 0.1 },
											{ start: 1.1, end: 2, duration: 0.9 },
										],
										timeMap: {
											toSourceTime: (time: number) => time,
											toCompressedTime: (time: number) => time,
										},
									},
								},
							],
						},
					],
				},
				media: {
					getAssets: () => [
						{
							id: "media-1",
							type: "video",
							file: new File(["test"], "clip.mp4", { type: "video/mp4" }),
						},
					],
				},
				project: {
					getActive: () => ({
						settings: {
							fps: 30,
						},
					}),
				},
			} as unknown as Parameters<typeof prewarmPlaybackVideoFrames>[0]["editor"];

			await prewarmPlaybackVideoFrames({
				editor,
				playhead: 0,
			});
		} finally {
			usePreviewStore.getState = originalGetState;
			videoCache.getFrameAt = originalGetFrameAt;
			videoCache.getGPUFrameAt = originalGetGPUFrameAt;
		}

		expect(requestedTimes.some((time) => time >= 1.1 && time <= 1.2)).toBe(true);
	});
});
