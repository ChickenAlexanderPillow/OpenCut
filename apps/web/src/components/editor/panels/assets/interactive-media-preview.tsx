"use client";

import Image from "next/image";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/hooks/use-editor";
import { cn } from "@/utils/ui";
import { MusicNote03Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";

const ASSET_PREVIEW_PLAY_EVENT = "opencut:asset-preview-play";
const TIMELINE_PLAYBACK_STATE_EVENT = "opencut:timeline-playback-state";

function releaseMediaElement(
	media: HTMLVideoElement | HTMLAudioElement | null,
): void {
	if (!media) return;
	media.pause();
	media.removeAttribute("src");
	media.load();
}

function formatDuration(duration: number): string {
	const safeDuration = Math.max(0, duration);
	const minutes = Math.floor(safeDuration / 60);
	const seconds = Math.floor(safeDuration % 60)
		.toString()
		.padStart(2, "0");
	return `${minutes}:${seconds}`;
}

function MediaTypePlaceholder({
	icon,
	label,
	meta,
	className,
}: {
	icon: IconSvgElement;
	label: string;
	meta?: string;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"text-muted-foreground flex size-full flex-col items-center justify-center rounded border border-dashed bg-muted/20",
				className,
			)}
		>
			<HugeiconsIcon icon={icon} className="size-6" />
			<span className="mt-1 text-xs">{label}</span>
			{meta ? (
				<span className="mt-0.5 text-[10px] uppercase">{meta}</span>
			) : null}
		</div>
	);
}

export function InteractiveMediaPreview({
	previewId,
	name,
	mediaType,
	src,
	thumbnailSrc,
	duration,
	audioMetaLabel,
	className,
}: {
	previewId: string;
	name: string;
	mediaType: "image" | "video" | "audio";
	src: string | null;
	thumbnailSrc?: string | null;
	duration?: number;
	audioMetaLabel?: string;
	className?: string;
}) {
	const editor = useEditor({ subscribeTo: [] });
	const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
	const pendingSeekRef = useRef<number | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [isMuted, setIsMuted] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [resolvedDuration, setResolvedDuration] = useState(
		duration && Number.isFinite(duration) && duration > 0 ? duration : 0,
	);
	const [isReady, setIsReady] = useState(mediaType === "image");
	const [error, setError] = useState<string | null>(null);

	const scrubDuration = Math.max(
		duration && Number.isFinite(duration) && duration > 0 ? duration : 0,
		resolvedDuration,
	);

	const syncFromMedia = () => {
		const media = mediaRef.current;
		if (!media) return;
		setCurrentTime(media.currentTime);
		if (Number.isFinite(media.duration) && media.duration > 0) {
			setResolvedDuration(media.duration);
		}
	};

	const commitPendingSeek = () => {
		const media = mediaRef.current;
		const pendingSeek = pendingSeekRef.current;
		if (!media || pendingSeek === null) return;
		if (media.readyState < 1) return;
		media.currentTime = pendingSeek;
		pendingSeekRef.current = null;
	};

	useEffect(() => {
		const media = mediaRef.current;
		if (media) {
			releaseMediaElement(media);
		}
		pendingSeekRef.current = null;
		setIsPlaying(false);
		setCurrentTime(0);
		setResolvedDuration(
			duration && Number.isFinite(duration) && duration > 0 ? duration : 0,
		);
		setError(src || mediaType === "image" ? null : "Preview unavailable");
		setIsReady(mediaType === "image");
	}, [duration, mediaType, src]);

	useEffect(
		() => () => {
			releaseMediaElement(mediaRef.current);
			mediaRef.current = null;
		},
		[],
	);

	useEffect(() => {
		const handleOtherPreviewPlay = (event: Event) => {
			const customEvent = event as CustomEvent<{ previewId?: string }>;
			if (customEvent.detail?.previewId === previewId) return;
			const media = mediaRef.current;
			if (!media || media.paused) return;
			releaseMediaElement(media);
			setIsPlaying(false);
		};

		const handleTimelinePlaybackState = (event: Event) => {
			const customEvent = event as CustomEvent<{ isPlaying?: boolean }>;
			if (!customEvent.detail?.isPlaying) return;
			const media = mediaRef.current;
			if (!media || media.paused) return;
			releaseMediaElement(media);
			setIsPlaying(false);
		};

		window.addEventListener(
			ASSET_PREVIEW_PLAY_EVENT,
			handleOtherPreviewPlay as EventListener,
		);
		window.addEventListener(
			TIMELINE_PLAYBACK_STATE_EVENT,
			handleTimelinePlaybackState as EventListener,
		);

		return () => {
			window.removeEventListener(
				ASSET_PREVIEW_PLAY_EVENT,
				handleOtherPreviewPlay as EventListener,
			);
			window.removeEventListener(
				TIMELINE_PLAYBACK_STATE_EVENT,
				handleTimelinePlaybackState as EventListener,
			);
		};
	}, [previewId]);

	if (mediaType === "image") {
		return (
			<div
				className={cn(
					"relative flex size-full items-center justify-center",
					className,
				)}
			>
				<Image
					src={src ?? ""}
					alt={name}
					fill
					sizes="100vw"
					className="object-cover"
					loading="lazy"
					unoptimized
				/>
			</div>
		);
	}

	if (!src) {
		return mediaType === "video" ? (
			<div className={cn("relative size-full", className)}>
				{thumbnailSrc ? (
					<Image
						src={thumbnailSrc}
						alt={name}
						fill
						sizes="100vw"
						className="rounded object-cover"
						loading="lazy"
						unoptimized
					/>
				) : (
					<MediaTypePlaceholder icon={Video01Icon} label="Video" />
				)}
			</div>
		) : (
			<MediaTypePlaceholder
				icon={MusicNote03Icon}
				label="Audio"
				meta={audioMetaLabel}
				className={className}
			/>
		);
	}

	const handleSeek = (nextTime: number) => {
		const media = mediaRef.current;
		if (!media) return;
		const boundedTime = Math.max(
			0,
			Math.min(scrubDuration || media.duration || 0, nextTime),
		);
		pendingSeekRef.current = boundedTime;
		media.currentTime = boundedTime;
		setCurrentTime(boundedTime);
	};

	const togglePlayback = async () => {
		const media = mediaRef.current;
		if (!media || !isReady || error) return;

		if (isPlaying) {
			media.pause();
			setIsPlaying(false);
			return;
		}

		try {
			editor.playback.pause();
			await media.play();
			window.dispatchEvent(
				new CustomEvent(ASSET_PREVIEW_PLAY_EVENT, {
					detail: { previewId },
				}),
			);
			setIsPlaying(true);
		} catch (playError) {
			console.error("Failed to play asset preview:", playError);
			setError("Preview failed");
		}
	};

	const toggleMute = () => {
		const media = mediaRef.current;
		if (!media) return;
		const nextMuted = !media.muted;
		media.muted = nextMuted;
		setIsMuted(nextMuted);
	};

	return (
		<div
			className={cn(
				"group/preview relative size-full overflow-hidden",
				className,
			)}
		>
			{mediaType === "video" ? (
				<video
					ref={(node) => {
						mediaRef.current = node;
					}}
					src={src}
					poster={thumbnailSrc ?? undefined}
					preload="metadata"
					className="size-full object-cover"
					muted={isMuted}
					onLoadedMetadata={() => {
						const media = mediaRef.current;
						if (!media) return;
						media.muted = isMuted;
						syncFromMedia();
						commitPendingSeek();
					}}
					onLoadedData={() => {
						setIsReady(true);
						setError(null);
						commitPendingSeek();
					}}
					onCanPlay={() => {
						setIsReady(true);
						setError(null);
						commitPendingSeek();
					}}
					onSeeked={syncFromMedia}
					onTimeUpdate={syncFromMedia}
					onPause={() => setIsPlaying(false)}
					onPlay={() => setIsPlaying(true)}
					onEnded={() => {
						setIsPlaying(false);
						handleSeek(0);
					}}
					onError={() => {
						setIsReady(false);
						setError("Preview failed");
					}}
				/>
			) : (
				<>
					<MediaTypePlaceholder
						icon={MusicNote03Icon}
						label="Audio"
						meta={audioMetaLabel}
					/>
					<audio
						ref={(node) => {
							mediaRef.current = node;
						}}
						src={src}
						preload="none"
						className="hidden"
						muted={isMuted}
						onLoadedMetadata={() => {
							const media = mediaRef.current;
							if (!media) return;
							media.muted = isMuted;
							syncFromMedia();
							commitPendingSeek();
						}}
						onLoadedData={() => {
							setIsReady(true);
							setError(null);
							commitPendingSeek();
						}}
						onCanPlay={() => {
							setIsReady(true);
							setError(null);
							commitPendingSeek();
						}}
						onSeeked={syncFromMedia}
						onTimeUpdate={syncFromMedia}
						onPause={() => setIsPlaying(false)}
						onPlay={() => setIsPlaying(true)}
						onEnded={() => {
							setIsPlaying(false);
							handleSeek(0);
						}}
						onError={() => {
							setIsReady(false);
							setError("Preview failed");
						}}
					/>
				</>
			)}

			<div
				className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent p-2 text-white"
				data-drag-ignore="true"
			>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						size="icon"
						variant="secondary"
						className="h-6 w-6 shrink-0"
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							void togglePlayback();
						}}
						aria-label={isPlaying ? "Pause preview" : "Play preview"}
						title={isPlaying ? "Pause preview" : "Play preview"}
						data-drag-ignore="true"
					>
						{isPlaying ? (
							<Pause className="size-3.5" />
						) : (
							<Play className="size-3.5" />
						)}
					</Button>
					<div className="min-w-0 flex-1" data-drag-ignore="true">
						<input
							type="range"
							min={0}
							max={Math.max(0.001, scrubDuration)}
							step={0.01}
							value={Math.max(0, Math.min(scrubDuration, currentTime))}
							onInput={(event: FormEvent<HTMLInputElement>) => {
								handleSeek(Number.parseFloat(event.currentTarget.value) || 0);
							}}
							className="absolute inset-x-10 bottom-[1.15rem] z-10 h-3 cursor-pointer opacity-0"
							aria-label="Scrub preview"
							data-drag-ignore="true"
						/>
						<div className="h-1.5 overflow-hidden rounded-full bg-white/25">
							<div
								className="h-full bg-white/85"
								style={{
									width: `${Math.max(
										0,
										Math.min(
											100,
											(currentTime / Math.max(0.001, scrubDuration)) * 100,
										),
									)}%`,
								}}
							/>
						</div>
						<div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-white/85">
							<span>{formatDuration(currentTime)}</span>
							<span>{formatDuration(scrubDuration)}</span>
						</div>
					</div>
					<Button
						type="button"
						size="icon"
						variant="secondary"
						className="h-6 w-6 shrink-0"
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							toggleMute();
						}}
						aria-label={isMuted ? "Unmute preview" : "Mute preview"}
						title={isMuted ? "Unmute preview" : "Mute preview"}
						data-drag-ignore="true"
					>
						{isMuted ? (
							<VolumeX className="size-3.5" />
						) : (
							<Volume2 className="size-3.5" />
						)}
					</Button>
				</div>
				{error ? (
					<div
						className="mt-1 text-[10px] text-white/85"
						data-drag-ignore="true"
					>
						{error}
					</div>
				) : null}
			</div>
		</div>
	);
}
