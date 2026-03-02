"use client";

import { useMemo, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
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
		<div className="space-y-2 rounded-sm border p-2">
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
				<div className="bg-secondary rounded-sm px-2 py-1 text-xs font-semibold">
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
				<div className="text-muted-foreground rounded-sm border border-dashed p-2 text-xs">
					Preview unavailable until source media is loaded.
				</div>
			)}
			<div className="flex flex-wrap gap-1 text-[11px]">
				<span className="bg-muted rounded-sm px-1.5 py-0.5">
					Hook {candidate.scoreBreakdown.hook}
				</span>
				<span className="bg-muted rounded-sm px-1.5 py-0.5">
					Emotion {candidate.scoreBreakdown.emotion}
				</span>
				<span className="bg-muted rounded-sm px-1.5 py-0.5">
					Shareability {candidate.scoreBreakdown.shareability}
				</span>
				<span className="bg-muted rounded-sm px-1.5 py-0.5">
					Clarity {candidate.scoreBreakdown.clarity}
				</span>
				<span className="bg-muted rounded-sm px-1.5 py-0.5">
					Momentum {candidate.scoreBreakdown.momentum}
				</span>
			</div>
			<div className="text-muted-foreground line-clamp-2 text-xs">
				{candidate.transcriptSnippet}
			</div>
			<div className="text-xs">{candidate.rationale}</div>
		</div>
	);
}

export function Clips() {
	const editor = useEditor();
	const project = editor.project.getActive();
	const mediaAssets = editor.media.getAssets();
	const {
		status,
		error,
		sourceMediaId: generatingSourceMediaId,
		hydrate,
		setSelectedCandidateIds,
		reset,
	} = useClipGenerationStore();
	const [selectedBySource, setSelectedBySource] = useState<Record<string, string[]>>(
		{},
	);

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
	const generatingSourceLabel =
		(generatingSourceMediaId && mediaById.get(generatingSourceMediaId)?.name) ??
		generatingSourceMediaId ??
		"source media";

	const toggleSelection = ({
		sourceMediaId,
		candidateId,
	}: {
		sourceMediaId: string;
		candidateId: string;
	}) => {
		setSelectedBySource((previous) => {
			const current = previous[sourceMediaId] ?? [];
			const exists = current.includes(candidateId);
			return {
				...previous,
				[sourceMediaId]: exists
					? current.filter((id) => id !== candidateId)
					: [...current, candidateId],
			};
		});
	};

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
						setSelectedBySource({});
					}}
				>
					Clear
				</Button>
			}
			contentClassName="space-y-3 pb-3"
		>
			{error && <div className="text-xs text-red-500">{error}</div>}
			{isGenerating && (
				<div className="flex items-center gap-2 rounded-sm border p-2 text-xs">
					<Spinner className="size-3.5" />
					<span className="text-muted-foreground">
						Generating clips for {generatingSourceLabel}...
					</span>
				</div>
			)}

			{groups.length === 0 && (
				<div className="text-muted-foreground text-xs">
					No stored clip groups for this project. Use the clip icon on media in Assets to
					generate clips.
				</div>
			)}

			{groups.map((group) => {
				const sourceMedia = mediaById.get(group.sourceMediaId) ?? null;
				const previewSource =
					sourceMedia &&
					sourceMedia.url &&
					(sourceMedia.type === "video" || sourceMedia.type === "audio")
						? {
								url: sourceMedia.url,
								type: sourceMedia.type,
							}
						: null;
				const selectedIds = selectedBySource[group.sourceMediaId] ?? [];
				const processingThisGroup =
					isGenerating && generatingSourceMediaId === group.sourceMediaId;

				return (
					<div key={group.sourceMediaId} className="space-y-2">
						<div className="text-sm font-semibold">
							{sourceMedia?.name ?? group.sourceMediaId}
						</div>
						<div className="border-t" />
						<div className="flex items-center gap-2">
							{processingThisGroup && (
								<div className="text-muted-foreground flex items-center gap-1.5 text-xs">
									<Spinner className="size-3.5" />
									<span>Generating...</span>
								</div>
							)}
							<Button
								size="sm"
								variant="secondary"
								disabled={selectedIds.length === 0}
								onClick={() => {
									hydrate({
										sourceMediaId: group.sourceMediaId,
										candidates: group.candidates,
										transcriptRef: group.transcriptRef,
										error: group.error,
									});
									setSelectedCandidateIds({ candidateIds: selectedIds });
									invokeAction("import-selected-viral-clips", {
										candidateIds: selectedIds,
									});
								}}
							>
								Import Selected ({selectedIds.length})
							</Button>
						</div>
						{group.error && <div className="text-xs text-red-400">{group.error}</div>}
						{group.candidates.map((candidate) => (
							<CandidateCard
								key={`${group.sourceMediaId}:${candidate.id}`}
								candidate={candidate}
								mediaUrl={previewSource?.url ?? null}
								mediaType={previewSource?.type ?? null}
								isSelected={selectedIds.includes(candidate.id)}
								onToggle={() =>
									toggleSelection({
										sourceMediaId: group.sourceMediaId,
										candidateId: candidate.id,
									})
								}
							/>
						))}
					</div>
				);
			})}
		</PanelView>
	);
}
