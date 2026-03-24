import { beforeEach, describe, expect, test } from "bun:test";
import {
	resolvePlaybackPreparationTime,
	startPlaybackWhenReady,
} from "./start-playback";

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
});
