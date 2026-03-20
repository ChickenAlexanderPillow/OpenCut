import { beforeEach, describe, expect, mock, test } from "bun:test";

type FakeVideoSample = {
	timestamp: number;
	duration: number;
	displayWidth: number;
	displayHeight: number;
	close: ReturnType<typeof mock>;
	toVideoFrame: () => { close: ReturnType<typeof mock> };
};

type ControlledIterator<T> = AsyncGenerator<T, void, unknown> & {
	pushResult: (result: IteratorResult<T, void>) => void;
};

type VideoCacheTestState = {
	sinks: Map<
		string,
		{
			currentSampleFrame:
				| {
						timestamp: number;
						frame: { close: ReturnType<typeof mock> };
				  }
				| null;
			nextSampleFrame:
				| {
						timestamp: number;
						frame: { close: ReturnType<typeof mock> };
				  }
				| null;
		}
	>;
};

let iteratorFactories: Array<
	(time: number) => AsyncGenerator<FakeVideoSample, void, unknown>
> = [];

function createControlledIterator<T>(): ControlledIterator<T> {
	const queue: Array<IteratorResult<T, void>> = [];
	let waiter: ((result: IteratorResult<T, void>) => void) | null = null;

	return {
		pushResult(result) {
			if (waiter) {
				const resolve = waiter;
				waiter = null;
				resolve(result);
				return;
			}
			queue.push(result);
		},
		async next() {
			const nextResult = queue.shift();
			if (nextResult) return nextResult;
			return await new Promise<IteratorResult<T, void>>((resolve) => {
				waiter = resolve;
			});
		},
		async return() {
			return { value: undefined, done: true };
		},
		async throw(error) {
			throw error;
		},
		[Symbol.asyncIterator]() {
			return this;
		},
		async [Symbol.asyncDispose]() {},
	};
}

function createSample({
	timestamp,
	duration = 1,
	width = 1920,
	height = 1080,
}: {
	timestamp: number;
	duration?: number;
	width?: number;
	height?: number;
}): FakeVideoSample {
	const frameClose = mock(() => {});
	return {
		timestamp,
		duration,
		displayWidth: width,
		displayHeight: height,
		close: mock(() => {}),
		toVideoFrame: () => ({
			close: frameClose,
		}),
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

mock.module("mediabunny", () => {
	class FakeInput {
		async getPrimaryVideoTrack() {
			return {
				displayWidth: 1920,
				displayHeight: 1080,
				canDecode: async () => true,
			};
		}
		dispose() {}
	}

	class FakeBlobSource {}

	class FakeCanvasSink {
		canvases(_time: number) {
			return createControlledIterator<{
				canvas: HTMLCanvasElement;
				timestamp: number;
				duration: number;
			}>();
		}
		dispose() {}
	}

	class FakeVideoSampleSink {
		samples(time: number) {
			const factory = iteratorFactories.shift();
			if (!factory) {
				throw new Error(
					`No sample iterator factory configured for time ${time}`,
				);
			}
			return factory(time);
		}
		dispose() {}
	}

	return {
		ALL_FORMATS: {},
		BlobSource: FakeBlobSource,
		CanvasSink: FakeCanvasSink,
		Input: FakeInput,
		VideoSampleSink: FakeVideoSampleSink,
	};
});

describe("VideoCache sample lifecycle", () => {
	beforeEach(() => {
		iteratorFactories = [];
		Object.defineProperty(globalThis, "VideoFrame", {
			value: class FakeVideoFrame {},
			configurable: true,
		});
	});

	test("closes a late prefetched sample after clearVideo", async () => {
		const { VideoCache } = await import("../service");
		const cache = new VideoCache();
		const file = new File(["test"], "clip.mp4", { type: "video/mp4" });

		const sample0 = createSample({ timestamp: 0 });
		const sample1 = createSample({ timestamp: 1 });
		const lateSample = createSample({ timestamp: 2 });
		const iterator = createControlledIterator<FakeVideoSample>();
		iterator.pushResult({ value: sample0, done: false });
		iterator.pushResult({ value: sample1, done: false });
		iteratorFactories.push(() => iterator);

		const initialFrame = await cache.getGPUFrameAt({
			mediaId: "media-1",
			file,
			time: 0,
		});
		expect(initialFrame?.timestamp).toBe(0);

		const nextFrame = await cache.getGPUFrameAt({
			mediaId: "media-1",
			file,
			time: 1,
		});
		expect(nextFrame?.timestamp).toBe(1);

		cache.clearVideo({ mediaId: "media-1" });
		iterator.pushResult({ value: lateSample, done: false });
		await flushMicrotasks();

		expect(lateSample.close.mock.calls.length).toBe(1);
		expect((cache as unknown as VideoCacheTestState).sinks.has("media-1")).toBe(
			false,
		);
	});

	test("closes old-generation samples during proxy-scale reinitialization", async () => {
		const { VideoCache } = await import("../service");
		const cache = new VideoCache();
		const file = new File(["test"], "clip.mp4", { type: "video/mp4" });

		const firstSample = createSample({ timestamp: 0 });
		const secondSample = createSample({ timestamp: 1 });
		const staleLateSample = createSample({ timestamp: 2 });
		const oldIterator = createControlledIterator<FakeVideoSample>();
		oldIterator.pushResult({ value: firstSample, done: false });
		oldIterator.pushResult({ value: secondSample, done: false });
		iteratorFactories.push(() => oldIterator);

		await cache.getGPUFrameAt({
			mediaId: "media-1",
			file,
			time: 0,
			proxyScale: 1,
		});
		await cache.getGPUFrameAt({
			mediaId: "media-1",
			file,
			time: 1,
			proxyScale: 1,
		});

		const replacementSample = createSample({ timestamp: 10 });
		const replacementIterator = createControlledIterator<FakeVideoSample>();
		replacementIterator.pushResult({ value: replacementSample, done: false });
		replacementIterator.pushResult({ value: undefined, done: true });
		iteratorFactories.push(() => replacementIterator);

		const replacementFramePromise = cache.getGPUFrameAt({
			mediaId: "media-1",
			file,
			time: 10,
			proxyScale: 0.5,
		});

		oldIterator.pushResult({ value: staleLateSample, done: false });
		const replacementFrame = await replacementFramePromise;
		await flushMicrotasks();

		expect(replacementFrame?.timestamp).toBe(10);
		expect(staleLateSample.close.mock.calls.length).toBe(1);

		const sinkData = (cache as unknown as VideoCacheTestState).sinks.get(
			"media-1",
		);
		if (!sinkData) {
			throw new Error("Expected sink data for media-1");
		}
		expect(sinkData.currentSampleFrame?.timestamp).toBe(10);
		expect(sinkData.nextSampleFrame).toBeNull();
	});
});
