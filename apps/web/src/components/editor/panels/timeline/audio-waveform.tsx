import { useEffect, useRef, useState } from "react";
import { decodeMediaFileToAudioBuffer } from "@/lib/media/audio";

interface AudioWaveformProps {
	audioUrl?: string;
	audioBuffer?: AudioBuffer;
	audioFile?: File;
	height?: number;
	className?: string;
}

const MAX_CACHED_WAVEFORMS = 64;
const waveformPeaksCache = new Map<string, Promise<number[] | null>>();

function getDecodedBufferCacheKey(file: File): string {
	return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

function touchWaveformCacheEntry({ cacheKey }: { cacheKey: string }): void {
	const existing = waveformPeaksCache.get(cacheKey);
	if (!existing) return;
	waveformPeaksCache.delete(cacheKey);
	waveformPeaksCache.set(cacheKey, existing);
}

function setWaveformCacheEntry({
	cacheKey,
	value,
}: {
	cacheKey: string;
	value: Promise<number[] | null>;
}): void {
	if (!waveformPeaksCache.has(cacheKey) && waveformPeaksCache.size >= MAX_CACHED_WAVEFORMS) {
		const oldestKey = waveformPeaksCache.keys().next().value;
		if (typeof oldestKey === "string") {
			waveformPeaksCache.delete(oldestKey);
		}
	}
	waveformPeaksCache.set(cacheKey, value);
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

async function decodeAudioUrlToPeaks({ audioUrl }: { audioUrl: string }): Promise<number[] | null> {
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
	const sampleStep = Math.max(1, Math.floor(peaks.length / targetBars));

	ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
	let barIndex = 0;
	for (let i = 0; i < peaks.length; i += sampleStep) {
		const x = barIndex * step;
		if (x > width) break;
		const amplitude = Math.max(0.02, Math.min(1, peaks[i] ?? 0));
		const barHeight = Math.max(1, Math.floor(amplitude * maxBarHeight));
		ctx.fillRect(x, centerY - barHeight, barWidth, barHeight * 2);
		barIndex += 1;
	}

	return true;
}

export function AudioWaveform({
	audioUrl,
	audioBuffer,
	audioFile,
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

			let peaks: number[] | null = null;

			if (audioBuffer) {
				peaks = extractPeaks({
					buffer: audioBuffer,
					length: 2048,
				});
			} else if (audioFile) {
				const cacheKey = getDecodedBufferCacheKey(audioFile);
				let peaksTask = waveformPeaksCache.get(cacheKey);
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
					setWaveformCacheEntry({
						cacheKey,
						value: peaksTask,
					});
				} else {
					touchWaveformCacheEntry({ cacheKey });
				}
				peaks = await peaksTask;
				if (!peaks || peaks.length === 0) {
					waveformPeaksCache.delete(cacheKey);
				}
			} else if (audioUrl) {
				const cacheKey = `url:${audioUrl}`;
				let peaksTask = waveformPeaksCache.get(cacheKey);
				if (!peaksTask) {
					peaksTask = decodeAudioUrlToPeaks({ audioUrl });
					setWaveformCacheEntry({
						cacheKey,
						value: peaksTask,
					});
				} else {
					touchWaveformCacheEntry({ cacheKey });
				}
				peaks = await peaksTask;
				if (!peaks || peaks.length === 0) {
					waveformPeaksCache.delete(cacheKey);
				}
			}

			if (!mounted) return;

			if (!peaks || peaks.length === 0) {
				setError(true);
				setIsLoading(false);
				return;
			}

			const drawn = drawPeaksToCanvas({
				canvas: canvasRef.current,
				container: waveformRef.current,
				peaks,
				height,
			});

			setError(!drawn);
			setIsLoading(false);
		};

		void renderWaveform();

		return () => {
			mounted = false;
		};
	}, [audioUrl, audioBuffer, audioFile, height]);

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
