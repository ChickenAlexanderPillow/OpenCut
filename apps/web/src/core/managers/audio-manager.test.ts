import { beforeEach, describe, expect, test } from "bun:test";
import { AudioManager } from "./audio-manager";

describe("AudioManager", () => {
	beforeEach(() => {
		let timeoutId = 0;
		(
			globalThis as typeof globalThis & {
				__opencut_audio_manager_singleton__?: unknown;
			}
		).__opencut_audio_manager_singleton__ = null;
		Object.defineProperty(globalThis, "window", {
			value: {
				addEventListener: () => {},
				clearTimeout: () => {},
				dispatchEvent: () => true,
				removeEventListener: () => {},
				setTimeout: () => ++timeoutId,
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

	test("primeCurrentTimelineAudio does not block on background prewarm", async () => {
		const editor = {
			playback: {
				getVolume: () => 1,
				getCurrentTime: () => 12,
				getIsPlaying: () => false,
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
		let prewarmResolved = false;
		const prewarmCalls: number[] = [];
		(
			manager as unknown as {
				unlockAudioContext: () => Promise<void>;
				prepareStreamingGraph: (args: { playhead: number }) => Promise<void>;
				streamingEngine: {
					prewarm: (args: { playhead: number; horizonSeconds: number }) => Promise<void>;
				};
			}
		).unlockAudioContext = async () => {};
		(
			manager as unknown as {
				prepareStreamingGraph: (args: { playhead: number }) => Promise<void>;
			}
		).prepareStreamingGraph = async () => {};
		(
			manager as unknown as {
				streamingEngine: {
					prewarm: (args: { playhead: number; horizonSeconds: number }) => Promise<void>;
				};
			}
		).streamingEngine = {
			prewarm: async ({ horizonSeconds }) => {
				prewarmCalls.push(horizonSeconds);
				if (horizonSeconds <= 2) {
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
				prewarmResolved = true;
			},
		};

		await manager.primeCurrentTimelineAudio();
		expect(prewarmCalls).toEqual([2, 12]);
		expect(prewarmResolved).toBe(false);
	});

	test("pause stops output without discarding the prepared streaming engine", () => {
		const editor = {
			playback: {
				getVolume: () => 1,
				getCurrentTime: () => 12,
				getIsPlaying: () => false,
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
		let stopCalls = 0;
		const fakeStreamingEngine = {
			stop: () => {
				stopCalls += 1;
			},
		};
		(
			manager as unknown as {
				streamingEngine: typeof fakeStreamingEngine | null;
				lastIsPlaying: boolean;
				handlePlaybackChange: () => void;
			}
		).streamingEngine = fakeStreamingEngine;
		(
			manager as unknown as {
				lastIsPlaying: boolean;
			}
		).lastIsPlaying = true;

		(
			manager as unknown as {
				handlePlaybackChange: () => void;
			}
		).handlePlaybackChange();

		expect(stopCalls).toBeGreaterThan(0);
		expect(
			(
				manager as unknown as {
					streamingEngine: typeof fakeStreamingEngine | null;
				}
			).streamingEngine,
		).toBe(fakeStreamingEngine);
	});

	test("pending paused seek priming is cancelled when playback starts", () => {
		const scheduled = new Map<number, () => void>();
		let timeoutId = 0;
		Object.defineProperty(globalThis, "window", {
			value: {
				addEventListener: () => {},
				clearTimeout: (id: number) => {
					scheduled.delete(id);
				},
				dispatchEvent: () => true,
				removeEventListener: () => {},
				setTimeout: (callback: () => void) => {
					const id = ++timeoutId;
					scheduled.set(id, callback);
					return id;
				},
			},
			configurable: true,
		});

		let isPlaying = false;
		const editor = {
			playback: {
				getVolume: () => 1,
				getCurrentTime: () => 0,
				getIsPlaying: () => isPlaying,
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
		scheduled.clear();
		let prepareCalls = 0;
		let startPlaybackCalls = 0;
		(
			manager as unknown as {
				prepareStreamingGraph: (args: {
					playhead: number;
					prewarm?: boolean;
				}) => Promise<void>;
				startPlayback: (args: { time: number }) => Promise<void>;
				schedulePausedSeekPrime: (args: { time: number }) => void;
				handlePlaybackChange: () => void;
			}
		).prepareStreamingGraph = async () => {
			prepareCalls += 1;
		};
		(
			manager as unknown as {
				startPlayback: (args: { time: number }) => Promise<void>;
			}
		).startPlayback = async () => {
			startPlaybackCalls += 1;
		};

		(
			manager as unknown as {
				schedulePausedSeekPrime: (args: { time: number }) => void;
			}
		).schedulePausedSeekPrime({ time: 0 });
		expect(scheduled.size).toBe(1);

		isPlaying = true;
		(
			manager as unknown as {
				handlePlaybackChange: () => void;
			}
		).handlePlaybackChange();

		expect(startPlaybackCalls).toBe(1);
		expect(scheduled.size).toBe(0);
		expect(prepareCalls).toBe(0);
	});
});
