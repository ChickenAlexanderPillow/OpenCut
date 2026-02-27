import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	VideoSampleSink,
	type VideoSample,
	type WrappedCanvas,
} from "mediabunny";

export interface VideoFrameCanvas {
	canvas: OffscreenCanvas | HTMLCanvasElement;
	timestamp: number;
	duration: number;
}

export interface VideoFrameGPU {
	frame: VideoFrame;
	timestamp: number;
	duration: number;
	width: number;
	height: number;
}

interface VideoSinkData {
	sink: CanvasSink;
	sampleSink: VideoSampleSink;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	currentFrame: WrappedCanvas | null;
	nextFrame: WrappedCanvas | null;
	sampleIterator: AsyncGenerator<VideoSample, void, unknown> | null;
	currentSample: VideoSample | null;
	nextSample: VideoSample | null;
	previewProxyScale: number;
	lastTime: number;
	lastSampleTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
	prefetchingSample: boolean;
	prefetchSamplePromise: Promise<void> | null;
}

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();

	async getFrameAt({
		mediaId,
		file,
		time,
		proxyScale,
	}: {
		mediaId: string;
		file: File;
		time: number;
		proxyScale?: number;
	}): Promise<VideoFrameCanvas | null> {
		const normalizedProxyScale = this.normalizeProxyScale({ proxyScale });
		await this.ensureSink({
			mediaId,
			file,
			previewProxyScale: normalizedProxyScale,
		});

		const sinkData = this.sinks.get(mediaId);
		if (!sinkData) return null;

		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return this.toPreviewFrame({ frame: sinkData.currentFrame });
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return this.toPreviewFrame({ frame });
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return frame ? this.toPreviewFrame({ frame }) : null;
	}

	async getGPUFrameAt({
		mediaId,
		file,
		time,
		proxyScale,
	}: {
		mediaId: string;
		file: File;
		time: number;
		proxyScale?: number;
	}): Promise<VideoFrameGPU | null> {
		const normalizedProxyScale = this.normalizeProxyScale({ proxyScale });
		await this.ensureSink({
			mediaId,
			file,
			previewProxyScale: normalizedProxyScale,
		});

		const sinkData = this.sinks.get(mediaId);
		if (!sinkData) return null;

		if (
			sinkData.nextSample &&
			sinkData.nextSample.timestamp <= time &&
			time < sinkData.nextSample.timestamp + sinkData.nextSample.duration
		) {
			this.closeSample({ sample: sinkData.currentSample });
			sinkData.currentSample = sinkData.nextSample;
			sinkData.nextSample = null;
			this.startSamplePrefetch({ sinkData });
		}

		if (
			sinkData.currentSample &&
			this.isSampleValid({ sample: sinkData.currentSample, time })
		) {
			if (!sinkData.nextSample && !sinkData.prefetchingSample) {
				this.startSamplePrefetch({ sinkData });
			}
			return this.toGPUFrame({ sample: sinkData.currentSample });
		}

		if (
			sinkData.sampleIterator &&
			sinkData.currentSample &&
			time >= sinkData.lastSampleTime &&
			time < sinkData.lastSampleTime + 2.0
		) {
			const sample = await this.iterateSampleToTime({
				sinkData,
				targetTime: time,
			});
			if (sample) {
				if (!sinkData.nextSample && !sinkData.prefetchingSample) {
					this.startSamplePrefetch({ sinkData });
				}
				return this.toGPUFrame({ sample });
			}
		}

		const sample = await this.seekSampleToTime({ sinkData, time });
		if (sample && !sinkData.nextSample && !sinkData.prefetchingSample) {
			this.startSamplePrefetch({ sinkData });
		}
		return sample ? this.toGPUFrame({ sample }) : null;
	}

	private normalizeProxyScale({ proxyScale }: { proxyScale?: number }): number {
		if (typeof proxyScale !== "number" || !Number.isFinite(proxyScale))
			return 1;
		return Math.max(0.25, Math.min(1, proxyScale));
	}

	private toPreviewFrame({
		frame,
	}: {
		frame: WrappedCanvas;
	}): VideoFrameCanvas {
		return {
			canvas: frame.canvas,
			timestamp: frame.timestamp,
			duration: frame.duration,
		};
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}

	private isSampleValid({
		sample,
		time,
	}: {
		sample: VideoSample;
		time: number;
	}): boolean {
		return (
			time >= sample.timestamp && time < sample.timestamp + sample.duration
		);
	}

	private toGPUFrame({
		sample,
	}: {
		sample: VideoSample;
	}): VideoFrameGPU | null {
		if (typeof VideoFrame === "undefined") return null;
		const frame = sample.toVideoFrame();
		return {
			frame,
			timestamp: sample.timestamp,
			duration: sample.duration,
			width: sample.displayWidth,
			height: sample.displayHeight,
		};
	}

	private closeSample({ sample }: { sample: VideoSample | null }): void {
		if (!sample) return;
		try {
			sample.close();
		} catch {}
	}
	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<WrappedCanvas | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		try {
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;

				// Aggressively fetch next frame immediately to fill buffer
				// This matches the mediaplayer example which fetches 2 frames on start
				try {
					const { value: next } = await sinkData.iterator.next();
					if (next) {
						sinkData.nextFrame = next;
					}
				} catch (e) {
					console.warn("Failed to pre-fetch next frame on seek:", e);
				}

				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	private async iterateSampleToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<VideoSample | null> {
		if (!sinkData.sampleIterator) return null;

		try {
			while (true) {
				if (sinkData.prefetchingSample && sinkData.prefetchSamplePromise) {
					await sinkData.prefetchSamplePromise;
				}

				if (
					sinkData.nextSample &&
					sinkData.nextSample.timestamp <= targetTime + 0.05
				) {
					this.closeSample({ sample: sinkData.currentSample });
					sinkData.currentSample = sinkData.nextSample;
					sinkData.nextSample = null;
				} else {
					const { value: sample, done } = await sinkData.sampleIterator.next();
					if (done || !sample) break;
					this.closeSample({ sample: sinkData.currentSample });
					sinkData.currentSample = sample;
				}

				const sample = sinkData.currentSample;
				if (!sample) break;

				sinkData.lastSampleTime = sample.timestamp;

				if (this.isSampleValid({ sample, time: targetTime })) {
					return sample;
				}

				if (sample.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Sample iterator failed, will restart:", error);
			sinkData.sampleIterator = null;
		}

		return null;
	}

	private async seekSampleToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<VideoSample | null> {
		try {
			if (sinkData.prefetchingSample && sinkData.prefetchSamplePromise) {
				await sinkData.prefetchSamplePromise;
			}

			if (sinkData.sampleIterator) {
				await sinkData.sampleIterator.return();
				sinkData.sampleIterator = null;
			}

			this.closeSample({ sample: sinkData.nextSample });
			sinkData.nextSample = null;
			sinkData.sampleIterator = sinkData.sampleSink.samples(time);
			sinkData.lastSampleTime = time;

			const { value: sample } = await sinkData.sampleIterator.next();
			if (sample) {
				this.closeSample({ sample: sinkData.currentSample });
				sinkData.currentSample = sample;
				try {
					const { value: next } = await sinkData.sampleIterator.next();
					if (next) {
						sinkData.nextSample = next;
					}
				} catch (e) {
					console.warn("Failed to pre-fetch next sample on seek:", e);
				}
				return sample;
			}
		} catch (error) {
			console.warn("Failed to seek video sample:", error);
		}
		return null;
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
		}
	}

	private startSamplePrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (
			sinkData.prefetchingSample ||
			!sinkData.sampleIterator ||
			sinkData.nextSample
		) {
			return;
		}

		sinkData.prefetchingSample = true;
		sinkData.prefetchSamplePromise = this.prefetchNextSample({ sinkData });
	}

	private async prefetchNextSample({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.sampleIterator) {
			sinkData.prefetchingSample = false;
			sinkData.prefetchSamplePromise = null;
			return;
		}

		try {
			const { value: sample, done } = await sinkData.sampleIterator.next();
			if (done || !sample) {
				sinkData.prefetchingSample = false;
				sinkData.prefetchSamplePromise = null;
				return;
			}
			this.closeSample({ sample: sinkData.nextSample });
			sinkData.nextSample = sample;
		} catch (error) {
			console.warn("Sample prefetch failed:", error);
			sinkData.sampleIterator = null;
		} finally {
			sinkData.prefetchingSample = false;
			sinkData.prefetchSamplePromise = null;
		}
	}
	private async ensureSink({
		mediaId,
		file,
		previewProxyScale,
	}: {
		mediaId: string;
		file: File;
		previewProxyScale: number;
	}): Promise<void> {
		const current = this.sinks.get(mediaId);
		if (current) {
			if (Math.abs(current.previewProxyScale - previewProxyScale) < 0.0001) {
				return;
			}
			this.clearVideo({ mediaId });
		}

		if (this.initPromises.has(mediaId)) {
			await this.initPromises.get(mediaId);
			return;
		}

		const initPromise = this.initializeSink({
			mediaId,
			file,
			previewProxyScale,
		});
		this.initPromises.set(mediaId, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(mediaId);
		}
	}
	private async initializeSink({
		mediaId,
		file,
		previewProxyScale,
	}: {
		mediaId: string;
		file: File;
		previewProxyScale: number;
	}): Promise<void> {
		try {
			const input = new Input({
				source: new BlobSource(file),
				formats: ALL_FORMATS,
			});

			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const proxyScale = Math.max(0.25, Math.min(1, previewProxyScale));
			const sink = new CanvasSink(videoTrack, {
				poolSize: 3,
				fit: "contain",
				width: Math.max(1, Math.round(videoTrack.displayWidth * proxyScale)),
				height: Math.max(1, Math.round(videoTrack.displayHeight * proxyScale)),
			});
			const sampleSink = new VideoSampleSink(videoTrack);

			this.sinks.set(mediaId, {
				sink,
				sampleSink,
				iterator: null,
				currentFrame: null,
				nextFrame: null,
				sampleIterator: null,
				currentSample: null,
				nextSample: null,
				previewProxyScale,
				lastTime: -1,
				lastSampleTime: -1,
				prefetching: false,
				prefetchPromise: null,
				prefetchingSample: false,
				prefetchSamplePromise: null,
			});
		} catch (error) {
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		const sinkData = this.sinks.get(mediaId);
		if (sinkData) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}
			if (sinkData.sampleIterator) {
				void sinkData.sampleIterator.return();
			}
			this.closeSample({ sample: sinkData.currentSample });
			this.closeSample({ sample: sinkData.nextSample });

			this.sinks.delete(mediaId);
		}

		this.initPromises.delete(mediaId);
	}

	clearAll(): void {
		for (const [mediaId] of this.sinks) {
			this.clearVideo({ mediaId });
		}
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

export const videoCache = new VideoCache();
