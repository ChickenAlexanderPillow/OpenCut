import { beforeEach, describe, expect, test } from "bun:test";
import { AudioManager } from "./audio-manager";

describe("AudioManager", () => {
	beforeEach(() => {
		Object.defineProperty(globalThis, "window", {
			value: {
				addEventListener: () => {},
				removeEventListener: () => {},
				setTimeout: () => 1,
			},
			configurable: true,
		});
	});

	test("only exposes the audio clock while the transport is actively running", () => {
		const editor = {
			playback: {
				getVolume: () => 1,
				getCurrentTime: () => 12,
				getIsPlaying: () => true,
				getIsScrubbing: () => false,
				subscribe: () => () => {},
			},
			timeline: {
				subscribe: () => () => {},
				getTracks: () => [],
			},
			media: {
				subscribe: () => () => {},
				getAssets: () => [],
			},
			scenes: {
				subscribe: () => () => {},
			},
		} as unknown as ConstructorParameters<typeof AudioManager>[0];

		const manager = new AudioManager(editor);
		(
			manager as unknown as {
				streamingEngine: {
					isTransportActive: () => boolean;
					getClockTime: () => number;
				};
			}
		).streamingEngine = {
			isTransportActive: () => false,
			getClockTime: () => 0,
		};

		expect(manager.getPlaybackClockTime()).toBeNull();

		(
			manager as unknown as {
				streamingEngine: {
					isTransportActive: () => boolean;
					getClockTime: () => number;
				};
			}
		).streamingEngine = {
			isTransportActive: () => true,
			getClockTime: () => 24.5,
		};

		expect(manager.getPlaybackClockTime()).toBe(24.5);
	});
});
