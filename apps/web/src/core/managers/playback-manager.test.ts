import { beforeEach, describe, expect, test } from "bun:test";
import { PlaybackManager } from "./playback-manager";

describe("PlaybackManager", () => {
	beforeEach(() => {
		Object.defineProperty(globalThis, "window", {
			value: {
				dispatchEvent: () => true,
			},
			configurable: true,
		});
	});

	test("follows the audio playback clock when it is available", () => {
		let now = 1000;
		Object.defineProperty(globalThis, "performance", {
			value: {
				now: () => now,
			},
			configurable: true,
		});
		Object.defineProperty(globalThis, "requestAnimationFrame", {
			value: () => 1,
			configurable: true,
		});
		Object.defineProperty(globalThis, "cancelAnimationFrame", {
			value: () => {},
			configurable: true,
		});

		let audioClockTime: number | null = null;
		const editor = {
			timeline: {
				getTotalDuration: () => 60,
			},
			project: {
				getActive: () => null,
				getTimelineViewState: () => ({}),
				setTimelineViewState: () => {},
			},
			audio: {
				getPlaybackClockTime: () => audioClockTime,
			},
		} as unknown as ConstructorParameters<typeof PlaybackManager>[0];

		const manager = new PlaybackManager(editor);
		manager.play();

		audioClockTime = 12.5;
		now += 16;
		(
			manager as unknown as {
				updateTime: () => void;
			}
		).updateTime();

		expect(manager.getCurrentTime()).toBe(12.5);
	});
});
