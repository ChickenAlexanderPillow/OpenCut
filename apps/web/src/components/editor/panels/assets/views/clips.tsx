"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { invokeAction } from "@/lib/actions";
import { useEditor } from "@/hooks/use-editor";
import { useClipGenerationStore } from "@/stores/clip-generation-store";
import type { ClipCandidate } from "@/types/clip-generation";

function formatTime(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const mins = Math.floor(total / 60)
		.toString()
		.padStart(2, "0");
	const secs = (total % 60).toString().padStart(2, "0");
	return `${mins}:${secs}`;
}

function CandidateCard({
	candidate,
	mediaUrl,
	mediaType,
	isSelected,
	onToggle,
}: {
	candidate: ClipCandidate;
	mediaUrl: string | null;
	mediaType: "video" | "audio" | null;
	isSelected: boolean;
	onToggle: () => void;
}) {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);

	const handleVideoTimeUpdate = () => {
		const video = videoRef.current;
		if (!video) return;
		if (video.currentTime >= candidate.endTime) {
			video.currentTime = candidate.startTime;
			void video.play();
		}
	};

	const handleAudioTimeUpdate = () => {
		const audio = audioRef.current;
		if (!audio) return;
		if (audio.currentTime >= candidate.endTime) {
			audio.currentTime = candidate.startTime;
			void audio.play();
		}
	};

	return (
		<div className="border rounded-sm p-2 space-y-2">
			<div className="flex items-start justify-between gap-2">
				<div className="flex items-center gap-2">
					<Checkbox checked={isSelected} onCheckedChange={onToggle} />
					<div>
						<div className="text-sm font-medium">{candidate.title}</div>
						<div className="text-muted-foreground text-xs">
							{formatTime(candidate.startTime)} - {formatTime(candidate.endTime)} (
							{Math.round(candidate.duration)}s)
						</div>
					</div>
				</div>
				<div className="text-xs font-semibold rounded-sm px-2 py-1 bg-secondary">
					{candidate.scoreOverall}/100
				</div>
			</div>
			{mediaUrl && mediaType === "video" ? (
				<video
					ref={videoRef}
					src={mediaUrl}
					muted
					controls
					className="w-full rounded-sm bg-black"
					onLoadedMetadata={() => {
						const video = videoRef.current;
						if (!video) return;
						video.currentTime = candidate.startTime;
					}}
					onTimeUpdate={handleVideoTimeUpdate}
				/>
			) : mediaUrl && mediaType === "audio" ? (
				<audio
					ref={audioRef}
					src={mediaUrl}
					controls
					className="w-full"
					onLoadedMetadata={() => {
						const audio = audioRef.current;
						if (!audio) return;
						audio.currentTime = candidate.startTime;
					}}
					onTimeUpdate={handleAudioTimeUpdate}
				/>
			) : (
				<div className="text-xs text-muted-foreground rounded-sm border border-dashed p-2">
					Preview unavailable until source media is loaded.
				</div>
			)}
			<div className="flex flex-wrap gap-1 text-[11px]">
				<span className="px-1.5 py-0.5 rounded-sm bg-muted">
					Hook {candidate.scoreBreakdown.hook}
				</span>
				<span className="px-1.5 py-0.5 rounded-sm bg-muted">
					Emotion {candidate.scoreBreakdown.emotion}
				</span>
				<span className="px-1.5 py-0.5 rounded-sm bg-muted">
					Shareability {candidate.scoreBreakdown.shareability}
				</span>
				<span className="px-1.5 py-0.5 rounded-sm bg-muted">
					Clarity {candidate.scoreBreakdown.clarity}
				</span>
				<span className="px-1.5 py-0.5 rounded-sm bg-muted">
					Momentum {candidate.scoreBreakdown.momentum}
				</span>
			</div>
			<div className="text-xs text-muted-foreground line-clamp-2">
				{candidate.transcriptSnippet}
			</div>
			<div className="text-xs">{candidate.rationale}</div>
		</div>
	);
}

export function Clips() {
	const editor = useEditor();
	const mediaAssets = editor.media.getAssets();
	const {
		status,
		error,
		candidates,
		selectedCandidateIds,
		sourceMediaId: sessionSourceMediaId,
		toggleCandidateSelection,
		hydrate,
		reset,
	} = useClipGenerationStore();
	const activeProject = editor.project.getActive();

	const sourceOptions = useMemo(
		() =>
			mediaAssets.filter(
				(asset) => !asset.ephemeral && (asset.type === "video" || asset.type === "audio"),
			),
		[mediaAssets],
	);
	const [sourceMediaId, setSourceMediaId] = useState<string>("");

	useEffect(() => {
		if (sourceOptions.length === 0) {
			if (sourceMediaId !== "") {
				setSourceMediaId("");
			}
			return;
		}

		const sessionSourceExists = sessionSourceMediaId
			? sourceOptions.some((asset) => asset.id === sessionSourceMediaId)
			: false;
		const currentSourceExists = sourceOptions.some(
			(asset) => asset.id === sourceMediaId,
		);

		const nextSourceMediaId = sessionSourceExists
			? sessionSourceMediaId!
			: currentSourceExists
				? sourceMediaId
				: sourceOptions[0].id;

		if (nextSourceMediaId !== sourceMediaId) {
			setSourceMediaId(nextSourceMediaId);
		}
	}, [sessionSourceMediaId, sourceMediaId, sourceOptions]);

	useEffect(() => {
		if (candidates.length > 0) return;
		if (status === "extracting" || status === "transcribing" || status === "scoring") {
			return;
		}
		const cache = activeProject.clipGenerationCache ?? {};
		const targetSourceMediaId =
			(sourceMediaId && cache[sourceMediaId] ? sourceMediaId : null) ??
			(sessionSourceMediaId && cache[sessionSourceMediaId] ? sessionSourceMediaId : null);
		const fallbackEntry =
			Object.values(cache).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
			null;
		const entry = (targetSourceMediaId ? cache[targetSourceMediaId] : null) ?? fallbackEntry;
		if (!entry) return;

		hydrate({
			sourceMediaId: entry.sourceMediaId,
			candidates: entry.candidates,
			transcriptRef: entry.transcriptRef,
			error: entry.error,
		});
		if (entry.sourceMediaId !== sourceMediaId) {
			setSourceMediaId(entry.sourceMediaId);
		}
	}, [
		activeProject.clipGenerationCache,
		candidates.length,
		hydrate,
		sessionSourceMediaId,
		sourceMediaId,
		status,
	]);

	const sourceMedia =
		sourceOptions.find((asset) => asset.id === sourceMediaId) ??
		sourceOptions.find((asset) => asset.id === sessionSourceMediaId) ??
		null;
	const previewSource: { url: string; type: "video" | "audio" } | null =
		sourceMedia &&
		sourceMedia.url &&
		(sourceMedia.type === "video" || sourceMedia.type === "audio")
			? {
					url: sourceMedia.url,
					type: sourceMedia.type,
				}
			: null;
	const canGenerate = sourceMediaId.length > 0 && status !== "transcribing" && status !== "scoring" && status !== "extracting";
	const canImport = selectedCandidateIds.length > 0 && status === "ready";

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
			contentClassName="space-y-2 pb-3"
		>
			<div className="space-y-2">
				<div className="text-xs text-muted-foreground">Source media</div>
				<Select value={sourceMediaId} onValueChange={setSourceMediaId}>
					<SelectTrigger>
						<SelectValue placeholder="Select video/audio source" />
					</SelectTrigger>
					<SelectContent>
						{sourceOptions.map((asset) => (
							<SelectItem key={asset.id} value={asset.id}>
								{asset.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="flex items-center gap-2">
					<Button
						disabled={!canGenerate}
						onClick={() =>
							invokeAction("generate-viral-clips", {
								sourceMediaId,
							})
						}
					>
						{status === "extracting" || status === "transcribing" || status === "scoring"
							? "Generating..."
							: "Generate Clips"}
					</Button>
					<Button
						variant="secondary"
						disabled={!canImport}
						onClick={() =>
							invokeAction("import-selected-viral-clips", {
								candidateIds: selectedCandidateIds,
							})
						}
					>
						Import Selected ({selectedCandidateIds.length})
					</Button>
				</div>
			</div>

			{error && <div className="text-xs text-red-500">{error}</div>}
			{status === "error" && candidates.length === 0 && (
				<div className="rounded-sm border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-200">
					<div className="font-medium text-red-100">No clips were generated</div>
					<div className="mt-1">{error ?? "No candidates passed the quality gate."}</div>
				</div>
			)}

			{candidates.length === 0 && (
				<div className="text-xs text-muted-foreground">
					{status === "error"
						? "Adjust source media or transcript quality and try Generate Clips again."
						: "Generate clips to see up to 5 ranked candidates."}
				</div>
			)}

			{candidates.map((candidate) => (
				<CandidateCard
					key={candidate.id}
					candidate={candidate}
					mediaUrl={previewSource?.url ?? null}
					mediaType={previewSource?.type ?? null}
					isSelected={selectedCandidateIds.includes(candidate.id)}
					onToggle={() =>
						toggleCandidateSelection({
							candidateId: candidate.id,
						})
					}
				/>
			))}
		</PanelView>
	);
}
