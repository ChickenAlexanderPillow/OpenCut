import { beforeEach, describe, expect, mock, test } from "bun:test";

describe("StreamingTimelineAudioEngine", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("does not let a stale prepare overwrite a newer committed graph", async () => {
		const firstClip = {
			id: "clip-a",
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
});
