import { useEffect, useRef, useState } from "react";
import type { TWaveformPeaksCacheEntry } from "@/types/project";
import {
	resolveWaveformEnvelopeSource,
	selectWaveformPeaksForDisplay,
	type WaveformEnvelope,
} from "@/lib/media/waveform-envelope";

interface AudioWaveformProps {
	audioUrl?: string;
	audioBuffer?: AudioBuffer;
	audioFile?: File;
	cacheKey?: string;
	initialEnvelope?: TWaveformPeaksCacheEntry;
	onEnvelopeResolved?: (envelope: WaveformEnvelope) => void;
	trimStart?: number;
	trimEnd?: number;
	duration?: number;
	sourceDuration?: number;
	height?: number;
	className?: string;
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
	const sampledPeaks = selectVisibleWaveformPeaks({
		peaks,
		targetBucketCount: targetBars,
	});

	ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
	for (let barIndex = 0; barIndex < sampledPeaks.length / 2; barIndex++) {
		const x = barIndex * step;
		if (x > width) break;
		const peakIndex = barIndex * 2;
		const min = sampledPeaks[peakIndex] ?? 0;
		const max = sampledPeaks[peakIndex + 1] ?? 0;
		const topHeight = Math.max(1, Math.floor(Math.abs(max) * maxBarHeight));
		const bottomHeight = Math.max(1, Math.floor(Math.abs(min) * maxBarHeight));
		ctx.fillRect(x, centerY - topHeight, barWidth, topHeight);
		ctx.fillRect(x, centerY, barWidth, bottomHeight);
	}

	return true;
}

export function selectVisibleWaveformPeaks({
	peaks,
	targetBucketCount,
}: {
	peaks: number[];
	targetBucketCount?: number;
}): number[] {
	if (peaks.length === 0) return peaks;
	const envelope: WaveformEnvelope = {
		version: 2,
		sourceDurationSeconds: Math.max(1, peaks.length / 2),
		bucketsPerSecond: 1,
		peaks,
	};
	return selectWaveformPeaksForDisplay({
		envelope,
		startTime: 0,
		endTime: envelope.sourceDurationSeconds,
		targetBucketCount,
	});
}

export function getVisibleWaveformEnvelopePeaks({
	envelope,
	trimStart = 0,
	trimEnd = 0,
	duration,
	sourceDuration,
	targetBucketCount,
}: {
	envelope: WaveformEnvelope;
	trimStart?: number;
	trimEnd?: number;
	duration?: number;
	sourceDuration?: number;
	targetBucketCount?: number;
}): number[] {
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
	if (totalDuration <= 0 || visibleDuration <= 0) {
		return selectWaveformPeaksForDisplay({
			envelope,
			targetBucketCount,
		});
	}

	const visibleStart = Math.max(0, Math.min(totalDuration, safeTrimStart));
	const visibleEnd = Math.max(
		visibleStart,
		Math.min(totalDuration, safeTrimStart + visibleDuration),
	);
	return selectWaveformPeaksForDisplay({
		envelope,
		startTime: visibleStart,
		endTime: visibleEnd,
		targetBucketCount,
	});
}

export function AudioWaveform({
	audioUrl,
	audioBuffer,
	audioFile,
	cacheKey,
	initialEnvelope,
	onEnvelopeResolved,
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

			const envelope = await resolveWaveformEnvelopeSource({
				audioBuffer,
				audioFile,
				audioUrl,
				cacheKey,
				initialEnvelope,
			});

			if (!mounted) return;
			if (!envelope || envelope.peaks.length === 0) {
				setError(true);
				setIsLoading(false);
				return;
			}

			onEnvelopeResolved?.(envelope);
			const visiblePeaks = getVisibleWaveformEnvelopePeaks({
				envelope,
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
		initialEnvelope,
		onEnvelopeResolved,
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
