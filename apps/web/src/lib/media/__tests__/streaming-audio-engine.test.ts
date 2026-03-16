import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cloneDefaultTrackAudioEffects } from "@/lib/media/track-audio-effects";

describe("StreamingTimelineAudioEngine", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("does not let a stale prepare overwrite a newer committed graph", async () => {
		const firstClip = {
			id: "clip-a",
			trackId: "track-1",
			sourceKey: "clip-a",
			file: new File([new Uint8Array([1])], "clip-a.wav"),
			mediaIdentity: {
				id: "media-a",
				type: "audio" as const,
				size: 1,
				lastModified: 1,
			},
			startTime: 0,
			duration: 1,
			trimStart: 0,
			trimEnd: 0,
			muted: false,
			gain: 1,
			trackGain: 1,
			trackAudioEffects: cloneDefaultTrackAudioEffects(),
			transcriptRevision: "",
			transcriptCuts: [],
		};
		const secondClip = {
			...firstClip,
			id: "clip-b",
			sourceKey: "clip-b",
			file: new File([new Uint8Array([2])], "clip-b.wav"),
			mediaIdentity: {
				...firstClip.mediaIdentity,
				id: "media-b",
				lastModified: 2,
			},
		};

		let resolveFirst: ((value: typeof firstClip[]) => void) | null = null;
		let collectCalls = 0;
		mock.module("../audio", () => ({
			collectAudioClips: mock(() => {
				collectCalls += 1;
				if (collectCalls === 1) {
					return new Promise<typeof firstClip[]>((resolve) => {
						resolveFirst = resolve;
					});
				}
				return Promise.resolve([secondClip]);
			}),
			decodeMediaFileToAudioBuffer: mock(async () => null),
			connectTrackAudioEffects: mock(
				({
					sourceNode,
				}: {
					sourceNode: AudioNode;
				}) => ({
					inputNode: sourceNode,
					outputNode: {
						connect: () => {},
						disconnect: () => {},
					},
					analyserNode: {
						fftSize: 1024,
						smoothingTimeConstant: 0.45,
						connect: () => {},
						disconnect: () => {},
						getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(0),
					},
				}),
			),
		}));

		const { StreamingTimelineAudioEngine } = await import(
			"../streaming-audio-engine"
		);

		const fakeWindow = {
			setInterval: () => 1,
			clearInterval: () => {},
			setTimeout: () => 1,
			clearTimeout: () => {},
			dispatchEvent: () => true,
		};
		Object.defineProperty(globalThis, "window", {
			value: fakeWindow,
			configurable: true,
		});
		Object.defineProperty(globalThis, "navigator", {
			value: { deviceMemory: 8 },
			configurable: true,
		});
		Object.defineProperty(globalThis, "performance", {
			value: { now: () => 0 },
			configurable: true,
		});

		const fakeAudioContext = {
			currentTime: 0,
			sampleRate: 48_000,
			createBufferSource: () => ({
				buffer: null,
				connect: () => {},
				disconnect: () => {},
				start: () => {},
				stop: () => {},
				addEventListener: () => {},
			}),
			createGain: () => ({
				gain: {
					value: 1,
					setValueAtTime: () => {},
					linearRampToValueAtTime: () => {},
					cancelScheduledValues: () => {},
					setTargetAtTime: () => {},
				},
				connect: () => {},
				disconnect: () => {},
			}),
		} as unknown as AudioContext;

		const engine = new StreamingTimelineAudioEngine(
			fakeAudioContext,
			{} as AudioNode,
		);

		const firstPreparePromise = engine.prepare({
			tracks: [],
			mediaAssets: [],
			playhead: 0,
		});
		const secondPreparedGraph = await engine.prepare({
			tracks: [],
			mediaAssets: [],
			playhead: 0,
		});

		engine.applyPreparedGraph({
			...secondPreparedGraph,
			playhead: 0,
		});
		expect(engine.getDiagnostics().clipCount).toBe(1);

		const releaseFirst = resolveFirst as ((value: typeof firstClip[]) => void) | null;
		if (releaseFirst) {
			releaseFirst([firstClip]);
		}
		const firstPreparedGraph = await firstPreparePromise;

		expect(engine.getDiagnostics().clipCount).toBe(1);
		expect(firstPreparedGraph.clips[0]?.id).toBe("clip-a");
		expect(secondPreparedGraph.clips[0]?.id).toBe("clip-b");
		expect(engine.getDiagnostics().clipCount).toBe(
			secondPreparedGraph.clips.length,
		);
	});

	test("seek invalidates an in-flight scheduling pass before it can reschedule", async () => {
		const { StreamingTimelineAudioEngine } = await import(
			"../streaming-audio-engine"
		);

		Object.defineProperty(globalThis, "window", {
			value: {
				setInterval: () => 1,
				clearInterval: () => {},
				setTimeout: () => 1,
				clearTimeout: () => {},
				dispatchEvent: () => true,
			},
			configurable: true,
		});
		Object.defineProperty(globalThis, "navigator", {
			value: { deviceMemory: 8 },
			configurable: true,
		});
		Object.defineProperty(globalThis, "performance", {
			value: { now: () => 0 },
			configurable: true,
		});

		const fakeAudioContext = {
			currentTime: 0,
			sampleRate: 48_000,
			createBufferSource: () => ({
				buffer: null,
				connect: () => {},
				disconnect: () => {},
				start: () => {},
				stop: () => {},
				addEventListener: () => {},
			}),
			createGain: () => ({
				gain: {
					value: 1,
					setValueAtTime: () => {},
					linearRampToValueAtTime: () => {},
					cancelScheduledValues: () => {},
					setTargetAtTime: () => {},
				},
				connect: () => {},
				disconnect: () => {},
			}),
		} as unknown as AudioContext;

		const engine = new StreamingTimelineAudioEngine(
			fakeAudioContext,
			{} as AudioNode,
		);
		const clip = {
			id: "clip-a",
			trackId: "track-1",
			sourceKey: "clip-a",
			file: new File([new Uint8Array([1])], "clip-a.wav"),
			mediaIdentity: {
				id: "media-a",
				type: "audio" as const,
				size: 1,
				lastModified: 1,
			},
			startTime: 0,
			duration: 2,
			trimStart: 0,
			trimEnd: 0,
			muted: false,
			gain: 1,
			trackGain: 1,
			trackAudioEffects: cloneDefaultTrackAudioEffects(),
			transcriptRevision: "",
			transcriptCuts: [],
		};

		(engine as unknown as { clips: typeof clip[] }).clips = [clip];
		engine.start({ atTime: 0 });

		const scheduleClipWindow = mock(() => true);
		(
			engine as unknown as {
				scheduleClipWindow: typeof scheduleClipWindow;
				getOrQueueDecodedWindow: (...args: unknown[]) => object | null;
			}
		).scheduleClipWindow = scheduleClipWindow;
		let hasSeeked = false;
		(
			engine as unknown as {
				getOrQueueDecodedWindow: (...args: unknown[]) => object | null;
			}
		).getOrQueueDecodedWindow = () => {
			if (!hasSeeked) {
				hasSeeked = true;
				engine.seek({ time: 1, immediate: true });
			}
			return {
				buffer: {} as AudioBuffer,
				sourceWindowStart: 0,
				sourceWindowEnd: 2,
			};
		};

		await (
			engine as unknown as {
				tick: () => Promise<void>;
			}
		).tick();

		expect(scheduleClipWindow).toHaveBeenCalledTimes(1);
	});

	test("fades out when the scheduler reaches a real clip boundary", async () => {
		const { StreamingTimelineAudioEngine } = await import(
			"../streaming-audio-engine"
		);

		Object.defineProperty(globalThis, "window", {
			value: {
				setInterval: () => 1,
				clearInterval: () => {},
				setTimeout: () => 1,
				clearTimeout: () => {},
				dispatchEvent: () => true,
			},
			configurable: true,
		});
		Object.defineProperty(globalThis, "navigator", {
			value: { deviceMemory: 8 },
			configurable: true,
		});
		Object.defineProperty(globalThis, "performance", {
			value: { now: () => 0 },
			configurable: true,
		});

		const gainEvents: Array<{ type: string; value: number; time: number }> = [];
		const fakeAudioContext = {
			currentTime: 0,
			sampleRate: 48_000,
			createBufferSource: () => ({
				buffer: null,
				connect: () => {},
				disconnect: () => {},
				start: () => {},
				stop: () => {},
				addEventListener: () => {},
			}),
			createGain: () => ({
				gain: {
					value: 1,
					setValueAtTime: (value: number, time: number) => {
						gainEvents.push({ type: "set", value, time });
					},
					linearRampToValueAtTime: (value: number, time: number) => {
						gainEvents.push({ type: "ramp", value, time });
					},
					cancelScheduledValues: () => {},
					setTargetAtTime: () => {},
				},
				connect: () => {},
				disconnect: () => {},
			}),
		} as unknown as AudioContext;

		const engine = new StreamingTimelineAudioEngine(
			fakeAudioContext,
			{} as AudioNode,
		);
		const clip = {
			id: "clip-a",
			trackId: "track-1",
			sourceKey: "clip-a",
			file: new File([new Uint8Array([1])], "clip-a.wav"),
			mediaIdentity: {
				id: "media-a",
				type: "audio" as const,
				size: 1,
				lastModified: 1,
			},
			startTime: 0,
			duration: 10,
			trimStart: 0,
			trimEnd: 0,
			muted: false,
			gain: 1,
			trackGain: 1,
			trackAudioEffects: cloneDefaultTrackAudioEffects(),
			transcriptRevision: "",
			transcriptCuts: [],
		};

		engine.start({ atTime: 0 });

		(
			engine as unknown as {
				scheduleClipWindow: (args: {
					clip: typeof clip;
					decodedWindow: {
						buffer: AudioBuffer;
						sourceWindowStart: number;
						sourceWindowEnd: number;
					};
					timelineNow: number;
					timelineHorizon: number;
					contextNow: number;
					runGeneration: number;
				}) => boolean;
			}
		).scheduleClipWindow({
			clip,
			decodedWindow: {
				buffer: {
					sampleRate: 48_000,
					length: 480_000,
					numberOfChannels: 1,
					getChannelData: () => new Float32Array(480_000),
				} as unknown as AudioBuffer,
				sourceWindowStart: 0,
				sourceWindowEnd: 10,
			},
			timelineNow: 0,
			timelineHorizon: 2.5,
			contextNow: 0,
			runGeneration: 1,
		});

		expect(gainEvents.some((event) => event.type === "ramp" && event.value === 0)).toBe(
			true,
		);
	});

	test("keeps using the current decoded window while it still covers the playback horizon", async () => {
		const { StreamingTimelineAudioEngine } = await import(
			"../streaming-audio-engine"
		);

		const fakeAudioContext = {
			currentTime: 0,
			sampleRate: 48_000,
		} as unknown as AudioContext;

		const engine = new StreamingTimelineAudioEngine(
			fakeAudioContext,
			{} as AudioNode,
		);
		const clip = {
			id: "clip-a",
			trackId: "track-1",
			sourceKey: "clip-a",
			file: new File([new Uint8Array([1])], "clip-a.wav"),
			mediaIdentity: {
				id: "media-a",
				type: "audio" as const,
				size: 1,
				lastModified: 1,
			},
			startTime: 0,
			duration: 20,
			trimStart: 0,
			trimEnd: 0,
			muted: false,
			gain: 1,
			trackGain: 1,
			trackAudioEffects: cloneDefaultTrackAudioEffects(),
			transcriptRevision: "",
			transcriptCuts: [],
		};

		const fallbackWindow = {
			buffer: {} as AudioBuffer,
			sourceWindowStart: 0,
			sourceWindowEnd: 12,
		};
		const replacementWindow = {
			buffer: {} as AudioBuffer,
			sourceWindowStart: 6,
			sourceWindowEnd: 18,
		};

		(
			engine as unknown as {
				lastDecodedWindowByClipId: Map<string, typeof fallbackWindow>;
				decodedWindowByKey: Map<string, typeof replacementWindow>;
				buildDecodeWindowRequest: (args: {
					clip: typeof clip;
					timelineNow: number;
					timelineHorizon: number;
				}) => { requestKey: string };
			}
		).lastDecodedWindowByClipId.set(clip.id, fallbackWindow);
		(
			engine as unknown as {
				buildDecodeWindowRequest: (args: {
					clip: typeof clip;
					timelineNow: number;
					timelineHorizon: number;
				}) => { requestKey: string };
			}
		).buildDecodeWindowRequest = () => ({ requestKey: "next-window" });
		(
			engine as unknown as {
				decodedWindowByKey: Map<string, typeof replacementWindow>;
			}
		).decodedWindowByKey.set("next-window", replacementWindow);

		const selected = (
			engine as unknown as {
				getOrQueueDecodedWindow: (args: {
					clip: typeof clip;
					timelineNow: number;
					timelineHorizon: number;
				}) => typeof fallbackWindow | null;
			}
		).getOrQueueDecodedWindow({
			clip,
			timelineNow: 5,
			timelineHorizon: 8,
		});

		expect(selected).toBe(fallbackWindow);
	});

	test("decodes short playable clips as a single full window", async () => {
		const { StreamingTimelineAudioEngine } = await import(
			"../streaming-audio-engine"
		);

		const fakeAudioContext = {
			currentTime: 0,
			sampleRate: 48_000,
		} as unknown as AudioContext;

		const engine = new StreamingTimelineAudioEngine(
			fakeAudioContext,
			{} as AudioNode,
		);
		const clip = {
			id: "clip-a",
			trackId: "track-1",
			sourceKey: "clip-a",
			file: new File([new Uint8Array([1])], "clip-a.wav"),
			mediaIdentity: {
				id: "media-a",
				type: "audio" as const,
				size: 1,
				lastModified: 1,
			},
			startTime: 0,
			duration: 30,
			trimStart: 5,
			trimEnd: 0,
			muted: false,
			gain: 1,
			trackGain: 1,
			trackAudioEffects: cloneDefaultTrackAudioEffects(),
			transcriptRevision: "",
			transcriptCuts: [],
		};

		const request = (
			engine as unknown as {
				buildDecodeWindowRequest: (args: {
					clip: typeof clip;
					timelineNow: number;
					timelineHorizon: number;
				}) => {
					decodeMode: "full" | "windowed";
					sourceWindowStart: number;
					sourceWindowDuration: number;
				};
			}
		).buildDecodeWindowRequest({
			clip,
			timelineNow: 0,
			timelineHorizon: 2.5,
		});

		expect(request.decodeMode).toBe("full");
		expect(request.sourceWindowStart).toBe(5);
		expect(request.sourceWindowDuration).toBe(30);
	});

	test("schedules a fully decoded clip as one continuous segment", async () => {
		const { StreamingTimelineAudioEngine } = await import(
			"../streaming-audio-engine"
		);

		Object.defineProperty(globalThis, "window", {
			value: {
				setInterval: () => 1,
				clearInterval: () => {},
				setTimeout: () => 1,
				clearTimeout: () => {},
				dispatchEvent: () => true,
			},
			configurable: true,
		});
		Object.defineProperty(globalThis, "navigator", {
			value: { deviceMemory: 8 },
			configurable: true,
		});
		Object.defineProperty(globalThis, "performance", {
			value: { now: () => 0 },
			configurable: true,
		});

		const fakeAudioContext = {
			currentTime: 0,
			sampleRate: 48_000,
			createBufferSource: () => ({
				buffer: null,
				connect: () => {},
				disconnect: () => {},
				start: () => {},
				stop: () => {},
				addEventListener: () => {},
			}),
			createGain: () => ({
				gain: {
					value: 1,
					setValueAtTime: () => {},
					linearRampToValueAtTime: () => {},
					cancelScheduledValues: () => {},
					setTargetAtTime: () => {},
				},
				connect: () => {},
				disconnect: () => {},
			}),
		} as unknown as AudioContext;

		const engine = new StreamingTimelineAudioEngine(
			fakeAudioContext,
			{} as AudioNode,
		);
		const clip = {
			id: "clip-a",
			trackId: "track-1",
			sourceKey: "clip-a",
			file: new File([new Uint8Array([1])], "clip-a.wav"),
			mediaIdentity: {
				id: "media-a",
				type: "audio" as const,
				size: 1,
				lastModified: 1,
			},
			startTime: 0,
			duration: 10,
			trimStart: 0,
			trimEnd: 0,
			muted: false,
			gain: 1,
			trackGain: 1,
			trackAudioEffects: cloneDefaultTrackAudioEffects(),
			transcriptRevision: "",
			transcriptCuts: [],
		};

		engine.start({ atTime: 0 });
		(
			engine as unknown as {
				trackBuses: Map<
					string,
					{
						input: AudioNode;
					}
				>;
			}
		).trackBuses.set("track-1", {
			input: {} as AudioNode,
		});
		(
			engine as unknown as {
				scheduleClipWindow: (args: {
					clip: typeof clip;
					decodedWindow: {
						buffer: AudioBuffer;
						sourceWindowStart: number;
						sourceWindowEnd: number;
					};
					timelineNow: number;
					timelineHorizon: number;
					contextNow: number;
					runGeneration: number;
				}) => boolean;
				scheduledByKey: Map<string, unknown>;
			}
		).scheduleClipWindow({
			clip,
			decodedWindow: {
				buffer: {
					sampleRate: 48_000,
					length: 480_000,
					numberOfChannels: 1,
					getChannelData: () => new Float32Array(480_000),
				} as unknown as AudioBuffer,
				sourceWindowStart: 0,
				sourceWindowEnd: 10,
			},
			timelineNow: 0,
			timelineHorizon: 2.5,
			contextNow: 0,
			runGeneration: 1,
		});

		const scheduledKeys = Array.from(
			(
				engine as unknown as {
					scheduledByKey: Map<string, unknown>;
				}
			).scheduledByKey.keys(),
		);
		expect(scheduledKeys).toEqual(["clip-a:0.0000:10.0000"]);
	});
});
