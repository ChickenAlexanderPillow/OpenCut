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
	input: Input;
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
	lastAccessAt: number;
	estimatedBytes: number;
	sampleGeneration: number;
	disposed: boolean;
}

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	private totalEstimatedBytes = 0;
	private static readonly MAX_SINKS = 4;
	private static readonly MAX_TOTAL_ESTIMATED_BYTES = 220 * 1024 * 1024; // 220MB
	private static readonly PREVIEW_MAX_PIXELS = 1280 * 720;

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
		sinkData.lastAccessAt = Date.now();

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
		sinkData.lastAccessAt = Date.now();

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

	private constrainPreviewSize({
		width,
		height,
	}: {
		width: number;
		height: number;
	}): { width: number; height: number } {
		let constrainedWidth = Math.max(1, Math.round(width));
		let constrainedHeight = Math.max(1, Math.round(height));
		const pixels = constrainedWidth * constrainedHeight;
		if (pixels > VideoCache.PREVIEW_MAX_PIXELS) {
			const scale = Math.sqrt(VideoCache.PREVIEW_MAX_PIXELS / pixels);
			constrainedWidth = Math.max(1, Math.round(constrainedWidth * scale));
			constrainedHeight = Math.max(1, Math.round(constrainedHeight * scale));
		}
		return {
			width: constrainedWidth,
			height: constrainedHeight,
		};
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

	private isSampleStateCurrent({
		sinkData,
		sampleGeneration,
	}: {
		sinkData: VideoSinkData;
		sampleGeneration: number;
	}): boolean {
		return !sinkData.disposed && sinkData.sampleGeneration === sampleGeneration;
	}

	private invalidateSampleState({
		sinkData,
		disposed = false,
	}: {
		sinkData: VideoSinkData;
		disposed?: boolean;
	}): void {
		sinkData.sampleGeneration += 1;
		sinkData.disposed = disposed || sinkData.disposed;

		const sampleIterator = sinkData.sampleIterator;
		sinkData.sampleIterator = null;
		if (sampleIterator) {
			void sampleIterator.return();
		}

		this.closeSample({ sample: sinkData.currentSample });
		this.closeSample({ sample: sinkData.nextSample });
		sinkData.currentSample = null;
		sinkData.nextSample = null;
		sinkData.prefetchingSample = false;
		sinkData.prefetchSamplePromise = null;
		sinkData.lastSampleTime = -1;
	}

	private closeSampleIfInvalid({
		sinkData,
		sampleGeneration,
		sample,
	}: {
		sinkData: VideoSinkData;
		sampleGeneration: number;
		sample: VideoSample | null;
	}): boolean {
		if (!sample) return true;
		if (this.isSampleStateCurrent({ sinkData, sampleGeneration })) {
			return false;
		}
		this.closeSample({ sample });
		return true;
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

				const sampleGeneration = sinkData.sampleGeneration;
				if (
					!this.isSampleStateCurrent({
						sinkData,
						sampleGeneration,
					})
				) {
					return null;
				}

				if (
					sinkData.nextSample &&
					sinkData.nextSample.timestamp <= targetTime + 0.05
				) {
					this.closeSample({ sample: sinkData.currentSample });
					sinkData.currentSample = sinkData.nextSample;
					sinkData.nextSample = null;
				} else {
					const sampleIterator = sinkData.sampleIterator;
					if (!sampleIterator) break;
					const { value: sample, done } = await sampleIterator.next();
					if (done || !sample) break;
					if (
						this.closeSampleIfInvalid({
							sinkData,
							sampleGeneration,
							sample,
						})
					) {
						return null;
					}
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
			this.invalidateSampleState({ sinkData });
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

			if (sinkData.disposed) {
				return null;
			}

			this.invalidateSampleState({ sinkData });
			sinkData.sampleIterator = sinkData.sampleSink.samples(time);
			const sampleGeneration = sinkData.sampleGeneration;
			sinkData.lastSampleTime = time;

			const sampleIterator = sinkData.sampleIterator;
			if (!sampleIterator) {
				return null;
			}

			const { value: sample } = await sampleIterator.next();
			if (sample) {
				if (
					this.closeSampleIfInvalid({
						sinkData,
						sampleGeneration,
						sample,
					})
				) {
					return null;
				}
				this.closeSample({ sample: sinkData.currentSample });
				sinkData.currentSample = sample;
				try {
					const { value: next } = await sampleIterator.next();
					if (next) {
						if (
							this.closeSampleIfInvalid({
								sinkData,
								sampleGeneration,
								sample: next,
							})
						) {
							return null;
						}
						sinkData.nextSample = next;
					}
				} catch (e) {
					console.warn("Failed to pre-fetch next sample on seek:", e);
				}
				return sample;
			}
		} catch (error) {
			console.warn("Failed to seek video sample:", error);
			this.invalidateSampleState({ sinkData });
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

		const sampleGeneration = sinkData.sampleGeneration;
		const sampleIterator = sinkData.sampleIterator;
		try {
			const { value: sample, done } = await sampleIterator.next();
			if (done || !sample) {
				sinkData.prefetchingSample = false;
				sinkData.prefetchSamplePromise = null;
				return;
			}
			if (
				this.closeSampleIfInvalid({
					sinkData,
					sampleGeneration,
					sample,
				})
			) {
				return;
			}
			this.closeSample({ sample: sinkData.nextSample });
			sinkData.nextSample = sample;
		} catch (error) {
			console.warn("Sample prefetch failed:", error);
			this.invalidateSampleState({ sinkData });
		} finally {
			if (
				this.isSampleStateCurrent({
					sinkData,
					sampleGeneration,
				})
			) {
				sinkData.prefetchingSample = false;
				sinkData.prefetchSamplePromise = null;
			}
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

	private evictIfNeeded({
		preserveMediaId,
	}: {
		preserveMediaId?: string;
	}): void {
		const shouldEvictByCount = this.sinks.size >= VideoCache.MAX_SINKS;
		const shouldEvictByBytes =
			this.totalEstimatedBytes > VideoCache.MAX_TOTAL_ESTIMATED_BYTES;
		if (!shouldEvictByCount && !shouldEvictByBytes) return;

		const candidates = Array.from(this.sinks.entries())
			.filter(([mediaId]) => mediaId !== preserveMediaId)
			.sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
		for (const [evictMediaId] of candidates) {
			if (
				this.sinks.size < VideoCache.MAX_SINKS &&
				this.totalEstimatedBytes <= VideoCache.MAX_TOTAL_ESTIMATED_BYTES
			) {
				break;
			}
			this.clearVideo({ mediaId: evictMediaId });
		}
	}

	private disposeSinkData({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.iterator) {
			void sinkData.iterator.return();
			sinkData.iterator = null;
		}
		this.invalidateSampleState({ sinkData, disposed: true });

		try {
			(sinkData.sink as unknown as { dispose?: () => void }).dispose?.();
		} catch {}
		try {
			(sinkData.sampleSink as unknown as { dispose?: () => void }).dispose?.();
		} catch {}
		try {
			(sinkData.input as unknown as { dispose?: () => void }).dispose?.();
		} catch {}
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
			this.evictIfNeeded({ preserveMediaId: mediaId });

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
			const scaledWidth = Math.max(
				1,
				Math.round(videoTrack.displayWidth * proxyScale),
			);
			const scaledHeight = Math.max(
				1,
				Math.round(videoTrack.displayHeight * proxyScale),
			);
			const constrained = this.constrainPreviewSize({
				width: scaledWidth,
				height: scaledHeight,
			});
			const proxyWidth = constrained.width;
			const proxyHeight = constrained.height;
			const poolSize = 3;
			const sink = new CanvasSink(videoTrack, {
				poolSize,
				fit: "contain",
				width: proxyWidth,
				height: proxyHeight,
			});
			const sampleSink = new VideoSampleSink(videoTrack);
			const estimatedBytes = proxyWidth * proxyHeight * 4 * poolSize;

			this.sinks.set(mediaId, {
				input,
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
				lastAccessAt: Date.now(),
				estimatedBytes,
				sampleGeneration: 0,
				disposed: false,
			});
			this.totalEstimatedBytes += estimatedBytes;
			this.evictIfNeeded({ preserveMediaId: mediaId });
		} catch (error) {
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		const sinkData = this.sinks.get(mediaId);
		if (sinkData) {
			this.disposeSinkData({ sinkData });
			this.sinks.delete(mediaId);
			this.totalEstimatedBytes = Math.max(
				0,
				this.totalEstimatedBytes - sinkData.estimatedBytes,
			);
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
			estimatedBytes: this.totalEstimatedBytes,
		};
	}
}

export const videoCache = new VideoCache();
