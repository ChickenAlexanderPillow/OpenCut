"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { invokeAction } from "@/lib/actions";
import { useEditor } from "@/hooks/use-editor";
import {
	buildClipRatingFeedbackModel,
	getCandidateScoreWithRatingFeedback,
	rankCandidatesWithRatingFeedback,
} from "@/lib/clips/rating-feedback";
import { useClipGenerationStore } from "@/stores/clip-generation-store";
import { useProjectProcessStore } from "@/stores/project-process-store";
import type { ClipCandidate } from "@/types/clip-generation";
import {
	ArrowDownToLine,
	ChevronDown,
	ChevronUp,
	Pause,
	Play,
	RotateCcw,
	ThumbsDown,
	ThumbsUp,
	Volume2,
	VolumeX,
} from "lucide-react";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";

function formatTime(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const mins = Math.floor(total / 60)
		.toString()
		.padStart(2, "0");
	const secs = (total % 60).toString().padStart(2, "0");
	return `${mins}:${secs}`;
}

function buildClipPreviewUrl({
	mediaUrl,
	startTime,
	endTime,
}: {
	mediaUrl: string;
	startTime: number;
	endTime: number;
}): string {
	const baseUrl = mediaUrl.split("#")[0] ?? mediaUrl;
	return `${baseUrl}#t=${Math.max(0, startTime)},${Math.max(startTime, endTime)}`;
}

const CLIP_PREVIEW_PLAY_EVENT = "opencut:clips-preview-play";
const TIMELINE_PLAYBACK_STATE_EVENT = "opencut:timeline-playback-state";

function buildWindowTranscriptText({
	segments,
	startTime,
	endTime,
}: {
	segments: Array<{ text: string; start: number; end: number }>;
	startTime: number;
	endTime: number;
}): string {
	return segments
		.filter((segment) => segment.end > startTime && segment.start < endTime)
		.map((segment) => {
			const fullText = segment.text.trim();
			if (!fullText) return "";
			const overlapStart = Math.max(startTime, segment.start);
			const overlapEnd = Math.min(endTime, segment.end);
			const overlapDuration = Math.max(0, overlapEnd - overlapStart);
			const segmentDuration = Math.max(0.001, segment.end - segment.start);
			if (overlapDuration <= 0) return "";
			if (overlapDuration >= segmentDuration * 0.98 || segmentDuration <= 0.2) {
				return fullText;
			}
			const words = fullText.match(/\S+/g) ?? [];
			if (words.length <= 1) return fullText;
			const fromRatio = (overlapStart - segment.start) / segmentDuration;
			const toRatio = (overlapEnd - segment.start) / segmentDuration;
			const startIndex = Math.max(
				0,
				Math.min(words.length - 1, Math.floor(fromRatio * words.length)),
			);
			const endIndexExclusive = Math.max(
				startIndex + 1,
				Math.min(words.length, Math.ceil(toRatio * words.length)),
			);
			return words.slice(startIndex, endIndexExclusive).join(" ").trim();
		})
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

function CandidateCard({
	candidate,
	feedbackModel,
	fullQuoteText,
	mediaUrl,
	mediaFile,
	mediaType,
	onImport,
	onRate,
	isImporting,
}: {
	candidate: ClipCandidate;
	feedbackModel: ReturnType<typeof buildClipRatingFeedbackModel>;
	fullQuoteText: string;
	mediaUrl: string | null;
	mediaFile: File | null;
	mediaType: "video" | "audio" | null;
	onImport: () => void;
	onRate: (rating: -1 | 1) => void;
	isImporting: boolean;
}) {
	const editor = useEditor({ subscribeTo: [] });
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [isQuoteExpanded, setIsQuoteExpanded] = useState(false);
	const [isPlaying, setIsPlaying] = useState(false);
	const [clipTime, setClipTime] = useState(0);
	const [isMuted, setIsMuted] = useState(false);
	const [isPreviewLoading, setIsPreviewLoading] = useState(Boolean(mediaUrl));
	const [previewError, setPreviewError] = useState<string | null>(null);
	const resolvedMediaUrl = useMemo(() => {
		if (mediaUrl) return mediaUrl;
		if (mediaFile) return URL.createObjectURL(mediaFile);
		return null;
	}, [mediaUrl, mediaFile]);

	useEffect(() => {
		if (!resolvedMediaUrl || mediaUrl || !mediaFile) return;
		return () => URL.revokeObjectURL(resolvedMediaUrl);
	}, [resolvedMediaUrl, mediaUrl, mediaFile]);

	const clipPreviewUrl = resolvedMediaUrl
		? buildClipPreviewUrl({
				mediaUrl: resolvedMediaUrl,
				startTime: candidate.startTime,
				endTime: candidate.endTime,
			})
		: null;
	const resolvedQuoteText = fullQuoteText.trim() || candidate.transcriptSnippet;
	const adjustedScore = getCandidateScoreWithRatingFeedback({
		candidate,
		feedbackModel,
	});
	const isThumbUpActive = candidate.userRating === 1;
	const isThumbDownActive = candidate.userRating === -1;

	useEffect(() => {
		setIsPreviewLoading(Boolean(clipPreviewUrl));
		setPreviewError(null);
		setIsPlaying(false);
		setClipTime(0);
	}, [clipPreviewUrl, candidate.id]);

	const handleVideoTimeUpdate = () => {
		const video = videoRef.current;
		if (!video) return;
		setClipTime(Math.max(0, video.currentTime - candidate.startTime));
		if (video.currentTime >= candidate.endTime) {
			video.currentTime = candidate.startTime;
			if (isPlaying) void video.play();
		}
	};

	useEffect(() => {
		const onOtherPreviewPlay = (event: Event) => {
			const customEvent = event as CustomEvent<{ candidateId?: string }>;
			const playingCandidateId = customEvent.detail?.candidateId;
			if (!playingCandidateId || playingCandidateId === candidate.id) return;
			if (mediaType === "video") {
				const video = videoRef.current;
				if (!video) return;
				video.pause();
				setIsPlaying(false);
				return;
			}
			if (mediaType === "audio") {
				const audio = audioRef.current;
				if (!audio) return;
				audio.pause();
				setIsPlaying(false);
			}
		};
		window.addEventListener(CLIP_PREVIEW_PLAY_EVENT, onOtherPreviewPlay as EventListener);
		return () => {
			window.removeEventListener(
				CLIP_PREVIEW_PLAY_EVENT,
				onOtherPreviewPlay as EventListener,
			);
		};
	}, [candidate.id, mediaType]);

	useEffect(() => {
		const onTimelinePlaybackState = (event: Event) => {
			const customEvent = event as CustomEvent<{ isPlaying?: boolean }>;
			if (!customEvent.detail?.isPlaying) return;

			const video = videoRef.current;
			if (video && !video.paused) {
				video.pause();
			}

			const audio = audioRef.current;
			if (audio && !audio.paused) {
				audio.pause();
			}

			setIsPlaying(false);
		};

		window.addEventListener(
			TIMELINE_PLAYBACK_STATE_EVENT,
			onTimelinePlaybackState as EventListener,
		);

		return () => {
			window.removeEventListener(
				TIMELINE_PLAYBACK_STATE_EVENT,
				onTimelinePlaybackState as EventListener,
			);
		};
	}, []);

	const handleAudioTimeUpdate = () => {
		const audio = audioRef.current;
		if (!audio) return;
		setClipTime(Math.max(0, audio.currentTime - candidate.startTime));
		if (audio.currentTime >= candidate.endTime) {
			audio.currentTime = candidate.startTime;
			if (isPlaying) void audio.play();
		}
	};

	const togglePlayback = async () => {
		if (isPreviewLoading || previewError) return;
		if (mediaType === "video") {
			const video = videoRef.current;
			if (!video) return;
			if (isPlaying) {
				video.pause();
				setIsPlaying(false);
				return;
			}
			if (video.currentTime < candidate.startTime || video.currentTime >= candidate.endTime) {
				video.currentTime = candidate.startTime;
			}
			video.muted = false;
			video.volume = 1;
			setIsMuted(false);
			try {
				editor.playback.pause();
				await video.play();
				window.dispatchEvent(
					new CustomEvent(CLIP_PREVIEW_PLAY_EVENT, {
						detail: { candidateId: candidate.id },
					}),
				);
				setIsPlaying(true);
			} catch (error) {
				console.error("Failed to play clip preview video:", error);
				setPreviewError("Preview failed to play");
			}
			return;
		}
		if (mediaType === "audio") {
			const audio = audioRef.current;
			if (!audio) return;
			if (isPlaying) {
				audio.pause();
				setIsPlaying(false);
				return;
			}
			if (audio.currentTime < candidate.startTime || audio.currentTime >= candidate.endTime) {
				audio.currentTime = candidate.startTime;
			}
			audio.muted = false;
			audio.volume = 1;
			setIsMuted(false);
			try {
				editor.playback.pause();
				await audio.play();
				window.dispatchEvent(
					new CustomEvent(CLIP_PREVIEW_PLAY_EVENT, {
						detail: { candidateId: candidate.id },
					}),
				);
				setIsPlaying(true);
			} catch (error) {
				console.error("Failed to play clip preview audio:", error);
				setPreviewError("Preview failed to play");
			}
		}
	};

	const toggleMute = () => {
		if (mediaType === "video") {
			const video = videoRef.current;
			if (!video) return;
			const nextMuted = !video.muted;
			video.muted = nextMuted;
			setIsMuted(nextMuted);
			return;
		}
		if (mediaType === "audio") {
			const audio = audioRef.current;
			if (!audio) return;
			const nextMuted = !audio.muted;
			audio.muted = nextMuted;
			setIsMuted(nextMuted);
		}
	};

	const handleSeekWithinClip = ({ nextClipTime }: { nextClipTime: number }) => {
		const boundedClipTime = Math.max(0, Math.min(candidate.duration, nextClipTime));
		setClipTime(boundedClipTime);
		const targetTime = candidate.startTime + boundedClipTime;

		if (mediaType === "video") {
			const video = videoRef.current;
			if (!video) return;
			video.currentTime = targetTime;
			return;
		}

		if (mediaType === "audio") {
			const audio = audioRef.current;
			if (!audio) return;
			audio.currentTime = targetTime;
		}
	};

	return (
		<div className="space-y-2.5 rounded-md border bg-background/70 p-2.5">
			<div className="flex items-start justify-between gap-2">
				<div>
					<div className="text-sm font-medium leading-tight">{candidate.title}</div>
					<div className="text-muted-foreground text-xs">
						{formatTime(candidate.startTime)} - {formatTime(candidate.endTime)} (
						{Math.round(candidate.duration)}s)
					</div>
				</div>
				<div className="flex items-center gap-1.5">
					<div className="bg-secondary rounded-sm px-2 py-1 text-xs font-semibold">
						{adjustedScore}/100
					</div>
					<Button
						type="button"
						size="icon"
						variant={isThumbUpActive ? "default" : "secondary"}
						className="h-7 w-7"
						onClick={() => onRate(1)}
						title="Rate clip up"
						aria-label="Rate clip up"
					>
						<ThumbsUp className="size-3.5" />
					</Button>
					<Button
						type="button"
						size="icon"
						variant={isThumbDownActive ? "destructive" : "secondary"}
						className="h-7 w-7"
						onClick={() => onRate(-1)}
						title="Rate clip down"
						aria-label="Rate clip down"
					>
						<ThumbsDown className="size-3.5" />
					</Button>
					<Button
						type="button"
						size="icon"
						variant="secondary"
						className="h-7 w-7"
						onClick={onImport}
						disabled={isImporting}
						title="Import clip to timeline"
						aria-label="Import clip to timeline"
					>
						{isImporting ? (
							<Spinner className="size-3.5" />
						) : (
							<ArrowDownToLine className="size-3.5" />
						)}
					</Button>
				</div>
			</div>
			{clipPreviewUrl && mediaType === "video" ? (
				<div className="relative">
					<div className="bg-muted/50 flex aspect-video w-full items-center justify-center rounded-sm border border-dashed">
						{isPreviewLoading ? (
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<Spinner className="size-3.5" />
								<span>Loading preview...</span>
							</div>
						) : previewError ? (
							<span className="text-xs text-muted-foreground">{previewError}</span>
						) : null}
					</div>
					<video
						ref={videoRef}
						src={clipPreviewUrl}
						preload="metadata"
						className={`absolute inset-0 w-full rounded-sm bg-black/90 ${isPreviewLoading || previewError ? "opacity-0" : "opacity-100"}`}
						onLoadedMetadata={() => {
							const video = videoRef.current;
							if (!video) return;
							video.currentTime = candidate.startTime;
							video.muted = isMuted;
						}}
						onLoadedData={() => {
							setIsPreviewLoading(false);
							setPreviewError(null);
						}}
						onCanPlay={() => {
							setIsPreviewLoading(false);
							setPreviewError(null);
						}}
						onTimeUpdate={handleVideoTimeUpdate}
						onPause={() => setIsPlaying(false)}
						onPlay={() => setIsPlaying(true)}
						onError={() => {
							setPreviewError("Preview failed to load");
							setIsPreviewLoading(false);
						}}
					/>
					<Button
						type="button"
						size="icon"
						variant="secondary"
						className="absolute bottom-1.5 right-1.5 h-7 w-7"
						onClick={toggleMute}
						aria-label={isMuted ? "Unmute preview" : "Mute preview"}
						title={isMuted ? "Unmute preview" : "Mute preview"}
					>
						{isMuted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
					</Button>
				</div>
			) : clipPreviewUrl && mediaType === "audio" ? (
				<div className="space-y-2">
					<div className="bg-muted/50 flex h-16 w-full items-center justify-center rounded-sm border border-dashed">
						{isPreviewLoading ? (
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<Spinner className="size-3.5" />
								<span>Loading preview...</span>
							</div>
						) : previewError ? (
							<span className="text-xs text-muted-foreground">{previewError}</span>
						) : (
							<span className="text-xs text-muted-foreground">Preview ready</span>
						)}
					</div>
					<audio
						ref={audioRef}
						src={clipPreviewUrl}
						preload="metadata"
						className="hidden"
						onLoadedMetadata={() => {
							const audio = audioRef.current;
							if (!audio) return;
							audio.currentTime = candidate.startTime;
							audio.muted = isMuted;
						}}
						onLoadedData={() => {
							setIsPreviewLoading(false);
							setPreviewError(null);
						}}
						onCanPlay={() => {
							setIsPreviewLoading(false);
							setPreviewError(null);
						}}
						onError={() => {
							setPreviewError("Preview failed to load");
							setIsPreviewLoading(false);
						}}
						onTimeUpdate={handleAudioTimeUpdate}
						onPause={() => setIsPlaying(false)}
						onPlay={() => setIsPlaying(true)}
					/>
				</div>
			) : (
				<div className="text-muted-foreground rounded-sm border border-dashed p-2 text-xs">
					Preview unavailable until source media is loaded.
				</div>
			)}
			{clipPreviewUrl && (
				<div className="flex items-center gap-2 text-[11px]">
					<Button
						type="button"
						size="icon"
						variant="secondary"
						className="h-6 w-6 shrink-0"
						onClick={() => void togglePlayback()}
						aria-label={isPlaying ? "Pause preview" : "Play preview"}
						title={isPlaying ? "Pause preview" : "Play preview"}
					>
						{isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
					</Button>
					<div className="text-muted-foreground shrink-0 tabular-nums">
						{formatTime(clipTime)} / {formatTime(candidate.duration)}
					</div>
					<div className="relative flex-1">
						<input
							type="range"
							min={0}
							max={Math.max(0.001, candidate.duration)}
							step={0.01}
							value={Math.max(0, Math.min(candidate.duration, clipTime))}
							onChange={(event) =>
								handleSeekWithinClip({
									nextClipTime: Number.parseFloat(event.target.value) || 0,
								})
							}
							className="absolute inset-0 z-10 h-3 w-full cursor-pointer opacity-0"
							aria-label="Scrub clip preview"
						/>
						<div className="bg-muted h-1.5 overflow-hidden rounded-full">
							<div
								className="bg-foreground/60 h-full"
								style={{
									width: `${Math.max(
										0,
										Math.min(100, (clipTime / Math.max(0.001, candidate.duration)) * 100),
									)}%`,
								}}
							/>
						</div>
					</div>
				</div>
			)}
			<div className="flex flex-nowrap items-center gap-1 text-[10px]">
				<span className="bg-muted inline-flex shrink-0 items-center whitespace-nowrap rounded-sm px-1 py-0.5">
					Hook {candidate.scoreBreakdown.hook}
				</span>
				<span className="bg-muted inline-flex shrink-0 items-center whitespace-nowrap rounded-sm px-1 py-0.5">
					Emotion {candidate.scoreBreakdown.emotion}
				</span>
				<span className="bg-muted inline-flex shrink-0 items-center whitespace-nowrap rounded-sm px-1 py-0.5">
					Shareability {candidate.scoreBreakdown.shareability}
				</span>
				<span className="bg-muted inline-flex shrink-0 items-center whitespace-nowrap rounded-sm px-1 py-0.5">
					Clarity {candidate.scoreBreakdown.clarity}
				</span>
				<span className="bg-muted inline-flex shrink-0 items-center whitespace-nowrap rounded-sm px-1 py-0.5">
					Momentum {candidate.scoreBreakdown.momentum}
				</span>
			</div>
			<div className="relative rounded-sm border border-dashed p-2 text-xs">
				<div
					className={`text-muted-foreground pr-7 ${isQuoteExpanded ? "" : "line-clamp-2"}`}
				>
					"{resolvedQuoteText}"
				</div>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="absolute right-1 top-1 h-5 w-5"
					onClick={() => setIsQuoteExpanded((previous) => !previous)}
					aria-label={isQuoteExpanded ? "Collapse quote" : "Expand quote"}
					title={isQuoteExpanded ? "Collapse quote" : "Expand quote"}
				>
					{isQuoteExpanded ? (
						<ChevronUp className="size-3.5" />
					) : (
						<ChevronDown className="size-3.5" />
					)}
				</Button>
			</div>
			<div className="text-muted-foreground text-xs leading-relaxed">
				{candidate.rationale}
			</div>
		</div>
	);
}

export function Clips() {
	const editor = useEditor();
	const project = editor.project.getActive();
	const processes = useProjectProcessStore((state) => state.processes);
	const mediaAssets = editor.media.getAssets();
	const {
		status,
		progress,
		progressMessage,
		error,
		sourceMediaId: generatingSourceMediaId,
		hydrate,
		reset,
	} = useClipGenerationStore();
	const clipFocusMediaId = useAssetsPanelStore((state) => state.clipFocusMediaId);
	const clearClipSectionFocus = useAssetsPanelStore(
		(state) => state.clearClipSectionFocus,
	);
	const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
	const [importingCandidateId, setImportingCandidateId] = useState<string | null>(null);

	const mediaById = useMemo(
		() => new Map(mediaAssets.map((asset) => [asset.id, asset])),
		[mediaAssets],
	);
	const groups = useMemo(() => {
		const cache = project.clipGenerationCache ?? {};
		return Object.values(cache)
			.filter((entry) => entry.candidates.length > 0 || Boolean(entry.error))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}, [project.clipGenerationCache]);

	const isGenerating =
		status === "extracting" || status === "transcribing" || status === "scoring";

	useEffect(() => {
		if (!clipFocusMediaId) return;
		const target = sectionRefs.current[clipFocusMediaId];
		if (!target) return;
		target.scrollIntoView({ behavior: "smooth", block: "start" });
		const timeoutId = window.setTimeout(() => {
			clearClipSectionFocus();
		}, 500);
		return () => window.clearTimeout(timeoutId);
	}, [clipFocusMediaId, clearClipSectionFocus]);

	const hasClipImportProcess = processes.some(
		(process) =>
			process.projectId === project.metadata.id &&
			process.kind === "clip-generation" &&
			(process.label.startsWith("Importing clips") ||
				process.label.startsWith("Preparing clip imports")),
	);
	const activeClipGenerationProcess = processes.find(
		(process) =>
			process.projectId === project.metadata.id &&
			process.kind === "clip-generation" &&
			!process.label.startsWith("Importing clips") &&
			!process.label.startsWith("Preparing clip imports"),
	);
	const isGeneratingCurrentMedia =
		isGenerating &&
		Boolean(generatingSourceMediaId) &&
		!groups.some((group) => group.sourceMediaId === generatingSourceMediaId);

	useEffect(() => {
		if (hasClipImportProcess) return;
		setImportingCandidateId(null);
	}, [hasClipImportProcess]);

	return (
		<PanelView
			title="Viral Clips"
			actions={
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						invokeAction("clear-viral-clips-session");
						reset();
					}}
				>
					Clear
				</Button>
			}
			contentClassName="space-y-3 pb-3"
		>
			{error && <div className="text-xs text-red-500">{error}</div>}
			{groups.length === 0 && !isGeneratingCurrentMedia && (
				<div className="text-muted-foreground text-xs">
					No stored clip groups for this project. Use the clip icon on media in Assets to
					generate clips.
				</div>
			)}
			{isGeneratingCurrentMedia && generatingSourceMediaId && (
				<div className="rounded-md border p-3">
					<div className="mb-2 flex items-center gap-2">
						<Spinner className="size-4" />
						<div className="text-sm font-medium">
							{mediaById.get(generatingSourceMediaId)?.name ??
								`Generating clips (${generatingSourceMediaId.slice(0, 8)}...)`}
						</div>
					</div>
					<div className="text-muted-foreground text-xs">
						{progressMessage ??
							activeClipGenerationProcess?.label ??
							"Generating clips..."}
					</div>
					<div className="bg-muted mt-2 h-1.5 w-full overflow-hidden rounded-full">
						<div
							className="bg-foreground h-full transition-all duration-300"
							style={{
								width: `${Math.max(
									4,
									Math.min(100, typeof progress === "number" ? progress : 12),
								)}%`,
							}}
						/>
					</div>
					<div className="text-muted-foreground mt-1 text-[11px]">
						{typeof progress === "number"
							? `${Math.round(progress)}%`
							: "In progress"}
					</div>
				</div>
			)}

			{groups.map((group) => {
				const sourceMedia = mediaById.get(group.sourceMediaId) ?? null;
				const transcriptSegments = (() => {
					const clipCache = project.clipTranscriptCache ?? {};
					if (group.transcriptRef?.cacheKey && clipCache[group.transcriptRef.cacheKey]) {
						return clipCache[group.transcriptRef.cacheKey]?.segments ?? [];
					}
					const fallbackEntries = Object.entries(clipCache)
						.filter(([key]) => key.startsWith(`${group.sourceMediaId}:`))
						.map(([, entry]) => entry)
						.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
					return fallbackEntries[0]?.segments ?? [];
				})();
				const previewSource =
					sourceMedia?.url &&
					(sourceMedia.type === "video" || sourceMedia.type === "audio")
						? {
								url: sourceMedia.url,
								type: sourceMedia.type,
							}
						: null;
				const processingThisGroup =
					isGenerating && generatingSourceMediaId === group.sourceMediaId;
				const feedbackModel = buildClipRatingFeedbackModel({
					candidates: group.candidates,
				});
				const rankedCandidates = rankCandidatesWithRatingFeedback({
					candidates: group.candidates,
					feedbackModel,
				});

				return (
					<div
						key={group.sourceMediaId}
						ref={(element) => {
							sectionRefs.current[group.sourceMediaId] = element;
						}}
						className="space-y-2"
					>
						<div className="space-y-1">
							<div className="flex items-center justify-between gap-2">
								<div className="text-sm font-semibold">
									{sourceMedia?.name ??
										`Missing media (${group.sourceMediaId.slice(0, 8)}...)`}
								</div>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="h-7 w-7"
									onClick={() =>
										invokeAction("generate-viral-clips", {
											sourceMediaId: group.sourceMediaId,
										})
									}
									disabled={processingThisGroup}
									title="Regenerate clips for this media"
									aria-label="Regenerate clips for this media"
								>
									{processingThisGroup ? (
										<Spinner className="size-4" />
									) : (
										<RotateCcw className="size-4" />
									)}
								</Button>
							</div>
							<div className="border-t" />
						</div>
						{group.error && <div className="text-xs text-red-400">{group.error}</div>}
						{processingThisGroup && (
							<div className="rounded-md border p-2">
								<div className="mb-1 flex items-center gap-2 text-xs">
									<Spinner className="size-3.5" />
									<span>
										{progressMessage ??
											activeClipGenerationProcess?.label ??
											"Generating clips..."}
									</span>
								</div>
								<div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
									<div
										className="bg-foreground h-full transition-all duration-300"
										style={{
											width: `${Math.max(
												4,
												Math.min(100, typeof progress === "number" ? progress : 12),
											)}%`,
										}}
									/>
								</div>
							</div>
						)}
						{rankedCandidates.map((candidate) => (
							<CandidateCard
								key={`${group.sourceMediaId}:${candidate.id}`}
								candidate={candidate}
								feedbackModel={feedbackModel}
								fullQuoteText={
									buildWindowTranscriptText({
										segments: transcriptSegments,
										startTime: candidate.startTime,
										endTime: candidate.endTime,
									})
										.trim() || candidate.transcriptSnippet
								}
								mediaUrl={previewSource?.url ?? null}
								mediaFile={sourceMedia?.file ?? null}
								mediaType={previewSource?.type ?? null}
								onImport={() => {
									setImportingCandidateId(candidate.id);
									hydrate({
										sourceMediaId: group.sourceMediaId,
										candidates: group.candidates,
										transcriptRef: group.transcriptRef,
										error: group.error,
									});
									invokeAction("import-selected-viral-clips", {
										candidateIds: [candidate.id],
									});
								}}
								onRate={(rating) => {
									const activeProject = editor.project.getActive();
									const cache = activeProject.clipGenerationCache ?? {};
									const currentGroup = cache[group.sourceMediaId];
									if (!currentGroup) return;
									const nextCandidates = currentGroup.candidates.map((entry) => {
										if (entry.id !== candidate.id) return entry;
										const existingRating: -1 | 0 | 1 = entry.userRating ?? 0;
										const nextRating: -1 | 0 | 1 =
											existingRating === rating ? 0 : rating;
										return {
											...entry,
											userRating: nextRating,
										};
									});
									editor.project.setActiveProject({
										project: {
											...activeProject,
											clipGenerationCache: {
												...cache,
												[group.sourceMediaId]: {
													...currentGroup,
													candidates: nextCandidates,
													updatedAt: new Date().toISOString(),
												},
											},
										},
									});
									editor.save.markDirty();
									void editor.save.flush();
								}}
								isImporting={importingCandidateId === candidate.id && hasClipImportProcess}
							/>
						))}
					</div>
				);
			})}
		</PanelView>
	);
}
