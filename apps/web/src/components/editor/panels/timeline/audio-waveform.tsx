import { useEffect, useRef, useState } from "react";
import { decodeMediaFileToAudioBuffer } from "@/lib/media/audio";
import {
	deleteWaveformPeaksCacheEntry,
	getWaveformPeaksCacheEntry,
	getResolvedWaveformPeaksCacheEntry,
	setResolvedWaveformPeaksCacheEntry,
	setWaveformPeaksCacheEntry,
	touchWaveformPeaksCacheEntry,
} from "@/lib/media/waveform-cache";

interface AudioWaveformProps {
	audioUrl?: string;
	audioBuffer?: AudioBuffer;
	audioFile?: File;
	cacheKey?: string;
	initialPeaks?: number[];
	onPeaksResolved?: (peaks: number[]) => void;
	trimStart?: number;
	trimEnd?: number;
	duration?: number;
	sourceDuration?: number;
	height?: number;
	className?: string;
}

function getDecodedBufferCacheKey(file: File): string {
	return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

function extractPeaks({
	buffer,
	length = 512,
}: {
	buffer: AudioBuffer;
	length?: number;
}): number[] {
	if (buffer.numberOfChannels <= 0 || buffer.length <= 0) return [];
	const channelData = buffer.getChannelData(0);
	const step = Math.max(1, Math.floor(channelData.length / length));
	const peaks: number[] = [];

	for (let i = 0; i < length; i++) {
		const start = i * step;
		const end = Math.min(start + step, channelData.length);
		let max = 0;
		for (let j = start; j < end; j++) {
			const abs = Math.abs(channelData[j] ?? 0);
			if (abs > max) max = abs;
		}
		peaks.push(max);
	}

	return peaks;
}

async function decodeAudioUrlToPeaks({
	audioUrl,
}: {
	audioUrl: string;
}): Promise<number[] | null> {
	const context = new AudioContext();
	try {
		const response = await fetch(audioUrl);
		if (!response.ok) return null;
		const arrayBuffer = await response.arrayBuffer();
		const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
		return extractPeaks({ buffer: decoded, length: 2048 });
	} catch (error) {
		console.warn("Waveform URL decode failed:", error);
		return null;
	} finally {
		void context.close().catch(() => undefined);
	}
}

function drawPeaksToCanvas({
	canvas,
	container,
	peaks,
	height,
}: {
	canvas: HTMLCanvasElement;
	container: HTMLDivElement;
	peaks: number[];
	height: number;
}): boolean {
	const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
	const width = Math.max(256, container.clientWidth || 256);
	const pixelHeight = Math.max(12, Math.floor(height));
	canvas.width = width * dpr;
	canvas.height = pixelHeight * dpr;
	canvas.style.width = `${width}px`;
	canvas.style.height = `${pixelHeight}px`;

	const ctx = canvas.getContext("2d");
	if (!ctx) return false;

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.scale(dpr, dpr);
	ctx.clearRect(0, 0, width, pixelHeight);

	const barWidth = 2;
	const barGap = 1;
	const step = barWidth + barGap;
	const centerY = pixelHeight / 2;
	const maxBarHeight = Math.max(2, pixelHeight / 2 - 1);
	const targetBars = Math.max(64, Math.floor(width / step));

	ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
	for (let barIndex = 0; barIndex < targetBars; barIndex++) {
		const x = barIndex * step;
		if (x > width) break;
		const startIndex = Math.floor((barIndex / targetBars) * peaks.length);
		const endIndex = Math.max(
			startIndex + 1,
			Math.ceil(((barIndex + 1) / targetBars) * peaks.length),
		);
		let sampledPeak = 0;
		for (let index = startIndex; index < endIndex; index++) {
			const candidate = peaks[index] ?? 0;
			if (candidate > sampledPeak) sampledPeak = candidate;
		}
		const amplitude = Math.max(0.02, Math.min(1, sampledPeak));
		const barHeight = Math.max(1, Math.floor(amplitude * maxBarHeight));
		ctx.fillRect(x, centerY - barHeight, barWidth, barHeight * 2);
	}

	return true;
}

export function selectVisibleWaveformPeaks({
	peaks,
	trimStart = 0,
	trimEnd = 0,
	duration,
	sourceDuration,
}: {
	peaks: number[];
	trimStart?: number;
	trimEnd?: number;
	duration?: number;
	sourceDuration?: number;
}): number[] {
	if (peaks.length === 0) return peaks;
	const safeTrimStart = Math.max(0, trimStart);
	const safeTrimEnd = Math.max(0, trimEnd);
	const visibleDuration =
		typeof duration === "number" && Number.isFinite(duration)
			? Math.max(0, duration)
			: 0;
	const inferredDuration = safeTrimStart + visibleDuration + safeTrimEnd;
	const totalDuration =
		typeof sourceDuration === "number" &&
		Number.isFinite(sourceDuration) &&
		sourceDuration >= safeTrimStart + visibleDuration
			? Math.max(0, sourceDuration)
			: inferredDuration;
	if (totalDuration <= 0 || visibleDuration <= 0) return peaks;

	const startRatio = Math.max(0, Math.min(1, safeTrimStart / totalDuration));
	const endRatio = Math.max(
		startRatio,
		Math.min(1, (safeTrimStart + visibleDuration) / totalDuration),
	);
	const startIndex = Math.min(
		peaks.length - 1,
		Math.floor(startRatio * peaks.length),
	);
	const endIndex = Math.max(
		startIndex + 1,
		Math.min(peaks.length, Math.ceil(endRatio * peaks.length)),
	);
	return peaks.slice(startIndex, endIndex);
}

export function AudioWaveform({
	audioUrl,
	audioBuffer,
	audioFile,
	cacheKey,
	initialPeaks,
	onPeaksResolved,
	trimStart = 0,
	trimEnd = 0,
	duration,
	sourceDuration,
	height = 32,
	className = "",
}: AudioWaveformProps) {
	const waveformRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState(false);

	useEffect(() => {
		let mounted = true;

		const renderWaveform = async () => {
			if (!waveformRef.current || !canvasRef.current) return;
			if (!audioBuffer && !audioFile && !audioUrl) return;
			if (initialPeaks && initialPeaks.length > 0) {
				const visiblePeaks = selectVisibleWaveformPeaks({
					peaks: initialPeaks,
					trimStart,
					trimEnd,
					duration,
					sourceDuration: sourceDuration ?? audioBuffer?.duration,
				});
				const drawn = drawPeaksToCanvas({
					canvas: canvasRef.current,
					container: waveformRef.current,
					peaks: visiblePeaks,
					height,
				});
				if (cacheKey) {
					setResolvedWaveformPeaksCacheEntry({
						cacheKey,
						value: initialPeaks,
					});
				}
				setError(!drawn);
				setIsLoading(false);
				return;
			}

			let peaks: number[] | null = null;
			let resolvedCacheKey: string | null = null;

			if (audioBuffer) {
				peaks = extractPeaks({
					buffer: audioBuffer,
					length: 2048,
				});
			} else if (audioFile) {
				const fileCacheKey = cacheKey ?? `file:${getDecodedBufferCacheKey(audioFile)}`;
				resolvedCacheKey = fileCacheKey;
				const resolvedPeaks = getResolvedWaveformPeaksCacheEntry({
					cacheKey: fileCacheKey,
				});
				if (resolvedPeaks) {
					peaks = resolvedPeaks;
				}
				let peaksTask = getWaveformPeaksCacheEntry({ cacheKey: fileCacheKey });
				if (!peaksTask) {
					peaksTask = (async () => {
						const decodedBuffer = await decodeMediaFileToAudioBuffer({
							file: audioFile,
						});
						if (!decodedBuffer) return null;
						return extractPeaks({
							buffer: decodedBuffer,
							length: 2048,
						});
					})();
					setWaveformPeaksCacheEntry({
						cacheKey: fileCacheKey,
						value: peaksTask,
					});
				} else {
					touchWaveformPeaksCacheEntry({ cacheKey: fileCacheKey });
				}
				if (!peaks) {
					peaks = await peaksTask;
				}
				if (!peaks || peaks.length === 0) {
					deleteWaveformPeaksCacheEntry({ cacheKey: fileCacheKey });
				}
			} else if (audioUrl) {
				const urlCacheKey = cacheKey ?? `url:${audioUrl}`;
				resolvedCacheKey = urlCacheKey;
				const resolvedPeaks = getResolvedWaveformPeaksCacheEntry({
					cacheKey: urlCacheKey,
				});
				if (resolvedPeaks) {
					peaks = resolvedPeaks;
				}
				let peaksTask = getWaveformPeaksCacheEntry({ cacheKey: urlCacheKey });
				if (!peaksTask) {
					peaksTask = decodeAudioUrlToPeaks({ audioUrl });
					setWaveformPeaksCacheEntry({
						cacheKey: urlCacheKey,
						value: peaksTask,
					});
				} else {
					touchWaveformPeaksCacheEntry({ cacheKey: urlCacheKey });
				}
				if (!peaks) {
					peaks = await peaksTask;
				}
				if (!peaks || peaks.length === 0) {
					deleteWaveformPeaksCacheEntry({ cacheKey: urlCacheKey });
				}
			}

			if (!mounted) return;

			if (!peaks || peaks.length === 0) {
				setError(true);
				setIsLoading(false);
				return;
			}
			if (resolvedCacheKey) {
				setResolvedWaveformPeaksCacheEntry({
					cacheKey: resolvedCacheKey,
					value: peaks,
				});
			}
			onPeaksResolved?.(peaks);
			const visiblePeaks = selectVisibleWaveformPeaks({
				peaks,
				trimStart,
				trimEnd,
				duration,
				sourceDuration: sourceDuration ?? audioBuffer?.duration,
			});

			const drawn = drawPeaksToCanvas({
				canvas: canvasRef.current,
				container: waveformRef.current,
				peaks: visiblePeaks,
				height,
			});

			setError(!drawn);
			setIsLoading(false);
		};

		void renderWaveform();

		return () => {
			mounted = false;
		};
	}, [
		audioUrl,
		audioBuffer,
		audioFile,
		cacheKey,
		initialPeaks,
		onPeaksResolved,
		trimStart,
		trimEnd,
		duration,
		sourceDuration,
		height,
	]);

	if (error) {
		return (
			<div
				className={`flex items-center justify-center ${className}`}
				style={{ height }}
			>
				<span className="text-foreground/60 text-xs">Audio unavailable</span>
			</div>
		);
	}

	return (
		<div className={`relative ${className}`}>
			{isLoading && (
				<div className="absolute inset-0 flex items-center justify-center">
					<span className="text-foreground/60 text-xs">Loading...</span>
				</div>
			)}
			<div ref={waveformRef} className="w-full" style={{ height }}>
				<canvas
					ref={canvasRef}
					className={`w-full ${isLoading ? "opacity-0" : "opacity-100"}`}
				/>
			</div>
		</div>
	);
}

export default AudioWaveform;
