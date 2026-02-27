import {
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	CanvasSink,
	CanvasSource,
	Input,
	Mp4OutputFormat,
	Output,
} from "mediabunny";

const DEFAULT_PROXY_QUALITY_RATIO = 0.55;
const DEFAULT_PROXY_MAX_FPS = 30;
const DEFAULT_PROXY_RESOLUTION_RATIO = 0.6;
const DEFAULT_PROXY_MAX_720P_PIXELS = 1280 * 720;

type ProxyProgressCallback = ({ progress }: { progress: number }) => void;

export interface CreateVideoProxyResult {
	file: File;
	width: number;
	height: number;
	fps: number;
	qualityRatio: number;
}

export async function createVideoProxy({
	file,
	qualityRatio = DEFAULT_PROXY_QUALITY_RATIO,
	maxFps = DEFAULT_PROXY_MAX_FPS,
	resolutionRatio = DEFAULT_PROXY_RESOLUTION_RATIO,
	maxPixels = DEFAULT_PROXY_MAX_720P_PIXELS,
	timeoutMs = 30_000,
	onProgress,
}: {
	file: File;
	qualityRatio?: number;
	maxFps?: number;
	resolutionRatio?: number;
	maxPixels?: number;
	timeoutMs?: number;
	onProgress?: ProxyProgressCallback;
}): Promise<CreateVideoProxyResult> {
	onProgress?.({ progress: 0 });
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	let output: Output | null = null;
	const startedAt = performance.now();
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error("No video track found in source");

		const canDecode = await videoTrack.canDecode();
		if (!canDecode) throw new Error("Video codec not supported for proxy decode");

		const duration = await input.computeDuration();
		if (!Number.isFinite(duration) || duration <= 0) {
			throw new Error("Invalid video duration for proxy generation");
		}

		const packetStats = await videoTrack.computePacketStats(100);
		const sourceFpsRaw = Math.round(packetStats.averagePacketRate || 30);
		const fps = Math.max(10, Math.min(maxFps, sourceFpsRaw || 30));
		const frameInterval = 1 / fps;

		const sourceWidth = videoTrack.displayWidth;
		const sourceHeight = videoTrack.displayHeight;
		const ratio = Math.max(0.35, Math.min(1, resolutionRatio));
		let width = Math.max(2, Math.round(sourceWidth * ratio));
		let height = Math.max(2, Math.round(sourceHeight * ratio));
		const pixelCount = width * height;
		if (pixelCount > maxPixels) {
			const scale = Math.sqrt(maxPixels / pixelCount);
			width = Math.max(2, Math.round(width * scale));
			height = Math.max(2, Math.round(height * scale));
		}
		// AVC is most reliable with even dimensions.
		width = width % 2 === 0 ? width : width - 1;
		height = height % 2 === 0 ? height : height - 1;

		// Approximate source bitrate from file size to keep proxy quality in the 50-60% range.
		const sourceBitrate = (file.size * 8) / duration;
		const clampedRatio = Math.max(0.5, Math.min(0.6, qualityRatio));
		const targetBitrate = Math.max(
			900_000,
			Math.min(12_000_000, Math.round(sourceBitrate * clampedRatio)),
		);

		const outputTarget = new BufferTarget();
		output = new Output({
			format: new Mp4OutputFormat(),
			target: outputTarget,
		});

		const encodeCanvas = document.createElement("canvas");
		encodeCanvas.width = width;
		encodeCanvas.height = height;
		const encodeContext = encodeCanvas.getContext("2d", {
			alpha: false,
			desynchronized: true,
		});
		if (!encodeContext) throw new Error("Could not create 2D context for proxy encoding");

		const videoSource = new CanvasSource(encodeCanvas, {
			codec: "avc",
			bitrate: targetBitrate,
		});

		output.addVideoTrack(videoSource, { frameRate: fps });
		await output.start();
		onProgress?.({ progress: 2 });

		const sink = new CanvasSink(videoTrack, {
			poolSize: 2,
			fit: "contain",
			width,
			height,
		});

		let nextEmitTimestamp = 0;
		let frameCount = 0;

		for await (const wrapped of sink.canvases(0)) {
			if (performance.now() - startedAt > timeoutMs) {
				throw new Error("Proxy generation timed out");
			}
			if (wrapped.timestamp > duration + frameInterval) break;
			if (wrapped.timestamp + 0.0001 < nextEmitTimestamp) continue;

			encodeContext.drawImage(wrapped.canvas, 0, 0, width, height);
			const frameDuration = Math.min(frameInterval, Math.max(0.001, duration - wrapped.timestamp));
			await videoSource.add(wrapped.timestamp, frameDuration);
			nextEmitTimestamp = wrapped.timestamp + frameInterval;
			frameCount += 1;

			if (frameCount % 3 === 0) {
				onProgress?.({
					progress: Math.round(
						Math.max(0, Math.min(100, (wrapped.timestamp / duration) * 100)),
					),
				});
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}

		videoSource.close();
		await output.finalize();

		const buffer = outputTarget.buffer;
		if (!buffer || buffer.byteLength === 0) {
			throw new Error("Proxy encoder produced empty output");
		}

		const proxyFile = new File([buffer], `${file.name}.proxy.mp4`, {
			type: "video/mp4",
			lastModified: Date.now(),
		});

		onProgress?.({ progress: 100 });

		return {
			file: proxyFile,
			width,
			height,
			fps,
			qualityRatio: clampedRatio,
		};
	} catch (error) {
		try {
			await output?.cancel();
		} catch {}
		if (error instanceof Error) {
			throw error;
		}
		throw new Error("Unknown proxy generation failure");
	} finally {
		try {
			input.dispose();
		} catch {}
	}
}
