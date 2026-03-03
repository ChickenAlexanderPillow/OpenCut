"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { invokeAction } from "@/lib/actions";
import { useEditor } from "@/hooks/use-editor";
import { useClipGenerationStore } from "@/stores/clip-generation-store";
import { useProjectProcessStore } from "@/stores/project-process-store";
import type { ClipCandidate } from "@/types/clip-generation";
import { clipTranscriptSegmentsForWindow } from "@/lib/clips/transcript";
import {
	ArrowDownToLine,
	ChevronDown,
	ChevronUp,
	Pause,
	Play,
	RotateCcw,
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

function CandidateCard({
	candidate,
	fullQuoteText,
	mediaUrl,
	mediaFile,
	mediaType,
	onImport,
	isImporting,
}: {
	candidate: ClipCandidate;
	fullQuoteText: string;
	mediaUrl: string | null;
	mediaFile: File | null;
	mediaType: "video" | "audio" | null;
	onImport: () => void;
	isImporting: boolean;
}) {
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
				await video.play();
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
				await audio.play();
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
						{candidate.scoreOverall}/100
					</div>
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
			{groups.length === 0 && (
				<div className="text-muted-foreground text-xs">
					No stored clip groups for this project. Use the clip icon on media in Assets to
					generate clips.
				</div>
			)}

			{groups.map((group) => {
				const sourceMedia = mediaById.get(group.sourceMediaId) ?? null;
				const transcriptSegments =
					(group.transcriptRef?.cacheKey &&
						project.clipTranscriptCache?.[group.transcriptRef.cacheKey]?.segments) ||
					[];
				const previewSource =
					sourceMedia &&
					sourceMedia.url &&
					(sourceMedia.type === "video" || sourceMedia.type === "audio")
						? {
								url: sourceMedia.url,
								type: sourceMedia.type,
							}
						: null;
				const processingThisGroup =
					isGenerating && generatingSourceMediaId === group.sourceMediaId;

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
									{sourceMedia?.name ?? group.sourceMediaId}
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
						{group.candidates.map((candidate) => (
							<CandidateCard
								key={`${group.sourceMediaId}:${candidate.id}`}
								candidate={candidate}
								fullQuoteText={
									clipTranscriptSegmentsForWindow({
										segments: transcriptSegments,
										startTime: candidate.startTime,
										endTime: candidate.endTime,
									})
										.map((segment) => segment.text)
										.join(" ")
										.replace(/\s+/g, " ")
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
								isImporting={importingCandidateId === candidate.id && hasClipImportProcess}
							/>
						))}
					</div>
				);
			})}
		</PanelView>
	);
}
