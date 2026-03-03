import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

interface AudioWaveformProps {
	audioUrl?: string;
	audioBuffer?: AudioBuffer;
	height?: number;
	className?: string;
}

function extractPeaks({
	buffer,
	length = 512,
}: {
	buffer: AudioBuffer;
	length?: number;
}): number[][] {
	const channels = buffer.numberOfChannels;
	const peaks: number[][] = [];

	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		const step = Math.max(1, Math.floor(data.length / length));
		const channelPeaks: number[] = [];

		for (let i = 0; i < length; i++) {
			const start = i * step;
			const end = Math.min(start + step, data.length);
			let max = 0;
			for (let j = start; j < end; j++) {
				const abs = Math.abs(data[j]);
				if (abs > max) max = abs;
			}
			channelPeaks.push(max);
		}
		peaks.push(channelPeaks);
	}

	return peaks;
}

export function AudioWaveform({
	audioUrl,
	audioBuffer,
	height = 32,
	className = "",
}: AudioWaveformProps) {
	const waveformRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const wavesurfer = useRef<WaveSurfer | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState(false);

	useEffect(() => {
		let mounted = true;
		const ws = wavesurfer.current;

		const initWaveSurfer = async () => {
			if (!waveformRef.current || (!audioUrl && !audioBuffer)) return;

			if (audioBuffer && canvasRef.current) {
				const canvas = canvasRef.current;
				const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
				const width = Math.max(256, waveformRef.current.clientWidth || 256);
				const pixelHeight = Math.max(12, Math.floor(height));
				canvas.width = width * dpr;
				canvas.height = pixelHeight * dpr;
				canvas.style.width = `${width}px`;
				canvas.style.height = `${pixelHeight}px`;

				const ctx = canvas.getContext("2d");
				if (!ctx) {
					setError(true);
					setIsLoading(false);
					return;
				}

				ctx.scale(dpr, dpr);
				ctx.clearRect(0, 0, width, pixelHeight);

				const peaks = extractPeaks({
					buffer: audioBuffer,
					length: Math.max(64, Math.floor(width / 2)),
				});
				const channelPeaks = peaks[0] ?? [];
				const barWidth = 2;
				const barGap = 1;
				const step = barWidth + barGap;
				const centerY = pixelHeight / 2;
				const maxBarHeight = Math.max(2, pixelHeight / 2 - 1);

				ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
				for (let i = 0; i < channelPeaks.length; i++) {
					const x = i * step;
					if (x > width) break;
					const amplitude = Math.max(0.02, Math.min(1, channelPeaks[i] ?? 0));
					const barHeight = Math.max(1, Math.floor(amplitude * maxBarHeight));
					ctx.fillRect(x, centerY - barHeight, barWidth, barHeight * 2);
				}

				setIsLoading(false);
				setError(false);
				return;
			}

			try {
				if (ws) {
					wavesurfer.current = null;
				}

				const newWaveSurfer = WaveSurfer.create({
					container: waveformRef.current,
					waveColor: "rgba(255, 255, 255, 0.6)",
					progressColor: "rgba(255, 255, 255, 0.9)",
					cursorColor: "transparent",
					barWidth: 2,
					barGap: 1,
					height,
					normalize: true,
					interact: false,
				});

				if (mounted) {
					wavesurfer.current = newWaveSurfer;
				} else {
					try {
						newWaveSurfer.destroy();
					} catch {}
					return;
				}

				newWaveSurfer.on("ready", () => {
					if (mounted) {
						setIsLoading(false);
						setError(false);
					}
				});

				newWaveSurfer.on("error", (err) => {
					if (mounted) {
						console.error("WaveSurfer error:", err);
						setError(true);
						setIsLoading(false);
					}
				});

				const readyTimeout = window.setTimeout(() => {
					if (!mounted) return;
					setIsLoading(false);
				}, 2000);
				newWaveSurfer.on("ready", () => {
					window.clearTimeout(readyTimeout);
				});

				if (audioUrl) {
					try {
						const loadResult = newWaveSurfer.load(audioUrl);
						if (
							loadResult &&
							typeof (loadResult as Promise<unknown>).catch === "function"
						) {
							void (loadResult as Promise<unknown>).catch((err) => {
								if (!mounted) return;
								console.error("WaveSurfer load failed:", err);
								setError(true);
								setIsLoading(false);
							});
						}
					} catch (err) {
						if (!mounted) return;
						console.error("WaveSurfer load threw:", err);
						setError(true);
						setIsLoading(false);
					}
				}
			} catch (err) {
				if (mounted) {
					console.error("Failed to initialize WaveSurfer:", err);
					setError(true);
					setIsLoading(false);
				}
			}
		};

		if (ws) {
			const wsToDestroy = ws;
			wavesurfer.current = null;

			requestAnimationFrame(() => {
				try {
					wsToDestroy.destroy();
				} catch {}
				if (mounted) {
					initWaveSurfer();
				}
			});
		} else {
			initWaveSurfer();
		}

		return () => {
			mounted = false;

			const wsToDestroy = wavesurfer.current;

			wavesurfer.current = null;

			if (wsToDestroy) {
				requestAnimationFrame(() => {
					try {
						wsToDestroy.destroy();
					} catch {}
				});
			}
		};
	}, [audioUrl, audioBuffer, height]);

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
				{audioBuffer ? (
					<canvas
						ref={canvasRef}
						className={`w-full ${isLoading ? "opacity-0" : "opacity-100"}`}
					/>
				) : (
					<div
						className={`w-full ${isLoading ? "opacity-0" : "opacity-100"}`}
						style={{ height }}
					/>
				)}
			</div>
		</div>
	);
}

export default AudioWaveform;
