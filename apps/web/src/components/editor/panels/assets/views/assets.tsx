"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { MediaDragOverlay } from "@/components/editor/panels/assets/drag-overlay";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { useEditor } from "@/hooks/use-editor";
import { useFileUpload } from "@/hooks/use-file-upload";
import { useRevealItem } from "@/hooks/use-reveal-item";
import { invokeAction } from "@/lib/actions";
import { InsertElementCommand } from "@/lib/commands/timeline";
import { processMediaAssets } from "@/lib/media/processing";
import { prepareProjectMediaImport } from "@/lib/media/project-import";
import {
	autoLinkTranscriptAndCaptionsForMediaElement,
} from "@/lib/media/transcript-import";
import { getMediaTypeFromFile } from "@/lib/media/media-utils";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import type { MediaAsset } from "@/types/assets";
import type { ExternalSourceSystem } from "@/types/external-projects";
import { cn } from "@/utils/ui";
import {
	CloudUploadIcon,
	GridViewIcon,
	LeftToRightListDashIcon,
	SortingOneNineIcon,
	Image02Icon,
	MusicNote03Icon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export function MediaView() {
	const editor = useEditor();
	const mediaFiles = editor.media.getAssets();
	const activeProject = editor.project.getActive();

	const { mediaViewMode, setMediaViewMode, highlightMediaId, clearHighlight } =
		useAssetsPanelStore();
	const setActiveTab = useAssetsPanelStore((state) => state.setActiveTab);
	const requestClipSectionFocus = useAssetsPanelStore(
		(state) => state.requestClipSectionFocus,
	);
	const { highlightedId, registerElement } = useRevealItem(
		highlightMediaId,
		clearHighlight,
	);

	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState(0);
	const [processingStep, setProcessingStep] = useState("");
	const [processingStepProgress, setProcessingStepProgress] = useState<
		number | undefined
	>(undefined);
	const [sortBy, setSortBy] = useState<"name" | "type" | "duration" | "size">(
		"name",
	);
	const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

	const processFiles = async ({ files }: { files: FileList }) => {
		if (!files || files.length === 0) return;
		if (!activeProject) {
			toast.error("No active project");
			return;
		}
		const supportedMediaFiles = Array.from(files).filter((file) => {
			const mediaType = getMediaTypeFromFile({ file });
			return (
				mediaType === "image" || mediaType === "video" || mediaType === "audio"
			);
		});
		if (supportedMediaFiles.length === 0) {
			toast.error("No supported media files selected");
			return;
		}

		setIsProcessing(true);
		setProgress(0);
		setProcessingStep("Starting import");
		setProcessingStepProgress(0);
		try {
			const processedAssets = await processMediaAssets({
				files: supportedMediaFiles,
				onProgress: ({
					progress,
					step,
					stepProgress,
				}: {
					progress: number;
					step?: string;
					stepProgress?: number;
				}) => {
					setProgress(progress);
					if (step) setProcessingStep(step);
					if (typeof stepProgress === "number") {
						setProcessingStepProgress(stepProgress);
					}
				},
			});
			for (const asset of processedAssets) {
				const { addMediaCmd } = await prepareProjectMediaImport({
					editor,
					asset,
					onProgress: ({ progress, step, stepProgress }) => {
						setProgress(Math.max(progress, 75));
						if (step) setProcessingStep(step);
						if (typeof stepProgress === "number") {
							setProcessingStepProgress(stepProgress);
						}
					},
				});
				editor.command.execute({ command: addMediaCmd });
			}
		} catch (error) {
			console.error("Error processing files:", error);
			toast.error("Failed to process files");
		} finally {
			setIsProcessing(false);
			setProgress(0);
			setProcessingStep("");
			setProcessingStepProgress(undefined);
		}
	};

	const { isDragOver, dragProps, openFilePicker, fileInputProps } =
		useFileUpload({
			accept: "image/*,video/*,audio/*",
			multiple: true,
			onFilesSelected: (files) => processFiles({ files }),
		});

	const handleRemove = async ({
		event,
		id,
	}: {
		event: React.MouseEvent;
		id: string;
	}) => {
		event.stopPropagation();

		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		if (activeProject.externalMediaLinks?.[id]) {
			const nextLinks = { ...(activeProject.externalMediaLinks ?? {}) };
			delete nextLinks[id];
			editor.project.setActiveProject({
				project: {
					...activeProject,
					externalMediaLinks: nextLinks,
				},
			});
			editor.save.markDirty();
		}

		await editor.media.removeMediaAsset({
			projectId: activeProject.metadata.id,
			id,
		});
	};

	const addElementAtTime = ({
		asset,
		startTime,
	}: {
		asset: MediaAsset;
		startTime: number;
	}): boolean => {
		const trackType = asset.type === "audio" ? "audio" : "video";
		const duration =
			asset.duration ?? TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration,
			startTime,
		});
		const insertCommand = new InsertElementCommand({
			element,
			placement: { mode: "auto", trackType },
		});
		editor.command.execute({ command: insertCommand });
		const insertedTrackId = insertCommand.getTrackId();
		if (insertedTrackId && (asset.type === "video" || asset.type === "audio")) {
			void autoLinkTranscriptAndCaptionsForMediaElement({
				editor,
				trackId: insertedTrackId,
				elementId: insertCommand.getElementId(),
			});
		}
		return true;
	};

	const filteredMediaItems = useMemo(() => {
		const filtered = mediaFiles.filter((item) => !item.ephemeral);

		filtered.sort((a, b) => {
			let valueA: string | number;
			let valueB: string | number;

			switch (sortBy) {
				case "name":
					valueA = a.name.toLowerCase();
					valueB = b.name.toLowerCase();
					break;
				case "type":
					valueA = a.type;
					valueB = b.type;
					break;
				case "duration":
					valueA = a.duration || 0;
					valueB = b.duration || 0;
					break;
				case "size":
					valueA = a.file.size;
					valueB = b.file.size;
					break;
				default:
					return 0;
			}

			if (valueA < valueB) return sortOrder === "asc" ? -1 : 1;
			if (valueA > valueB) return sortOrder === "asc" ? 1 : -1;
			return 0;
		});

		return filtered;
	}, [mediaFiles, sortBy, sortOrder]);

	const previewComponents = useMemo(() => {
		const previews = new Map<string, React.ReactNode>();

		filteredMediaItems.forEach((item) => {
			previews.set(item.id, <MediaPreview item={item} />);
			previews.set(
				`compact-${item.id}`,
				<MediaPreview item={item} variant="compact" />,
			);
		});

		return previews;
	}, [filteredMediaItems]);

	const renderPreview = (item: MediaAsset) => previewComponents.get(item.id);
	const renderCompactPreview = (item: MediaAsset) =>
		previewComponents.get(`compact-${item.id}`);

	const mediaActions = (
		<div>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							onClick={() =>
								setMediaViewMode(mediaViewMode === "grid" ? "list" : "grid")
							}
							disabled={isProcessing}
							className="items-center justify-center"
						>
							{mediaViewMode === "grid" ? (
								<HugeiconsIcon icon={LeftToRightListDashIcon} />
							) : (
								<HugeiconsIcon icon={GridViewIcon} />
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>
							{mediaViewMode === "grid"
								? "Switch to list view"
								: "Switch to grid view"}
						</p>
					</TooltipContent>
					<Tooltip>
						<DropdownMenu>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<Button
										size="icon"
										variant="ghost"
										disabled={isProcessing}
										className="items-center justify-center"
									>
										<HugeiconsIcon icon={SortingOneNineIcon} />
									</Button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<DropdownMenuContent align="end">
								<SortMenuItem
									label="Name"
									sortKey="name"
									currentSortBy={sortBy}
									currentSortOrder={sortOrder}
									onSort={({ key }) => {
										if (sortBy === key) {
											setSortOrder(sortOrder === "asc" ? "desc" : "asc");
										} else {
											setSortBy(key);
											setSortOrder("asc");
										}
									}}
								/>
								<SortMenuItem
									label="Type"
									sortKey="type"
									currentSortBy={sortBy}
									currentSortOrder={sortOrder}
									onSort={({ key }) => {
										if (sortBy === key) {
											setSortOrder(sortOrder === "asc" ? "desc" : "asc");
										} else {
											setSortBy(key);
											setSortOrder("asc");
										}
									}}
								/>
								<SortMenuItem
									label="Duration"
									sortKey="duration"
									currentSortBy={sortBy}
									currentSortOrder={sortOrder}
									onSort={({ key }) => {
										if (sortBy === key) {
											setSortOrder(sortOrder === "asc" ? "desc" : "asc");
										} else {
											setSortBy(key);
											setSortOrder("asc");
										}
									}}
								/>
								<SortMenuItem
									label="File size"
									sortKey="size"
									currentSortBy={sortBy}
									currentSortOrder={sortOrder}
									onSort={({ key }) => {
										if (sortBy === key) {
											setSortOrder(sortOrder === "asc" ? "desc" : "asc");
										} else {
											setSortBy(key);
											setSortOrder("asc");
										}
									}}
								/>
							</DropdownMenuContent>
						</DropdownMenu>
						<TooltipContent>
							<p>
								Sort by {sortBy} (
								{sortOrder === "asc" ? "ascending" : "descending"})
							</p>
						</TooltipContent>
					</Tooltip>
				</Tooltip>
			</TooltipProvider>
			<Button
				variant="outline"
				onClick={openFilePicker}
				disabled={isProcessing}
				size="sm"
				className="items-center justify-center gap-1.5 ml-1.5"
			>
				<HugeiconsIcon icon={CloudUploadIcon} />
				Import
			</Button>
		</div>
	);

	const handleGenerateClipsForMedia = ({ mediaId }: { mediaId: string }) => {
		const existingCount = clipCountsBySource.get(mediaId) ?? 0;
		if (existingCount > 0) {
			requestClipSectionFocus(mediaId);
			return;
		}
		setActiveTab("clips");
		requestClipSectionFocus(mediaId);
		invokeAction("generate-viral-clips", {
			sourceMediaId: mediaId,
		});
	};
	const handleLinkThumbnailProjectForMedia = async ({
		mediaId,
	}: {
		mediaId: string;
	}) => {
		const existing =
			activeProject.externalMediaLinks?.[mediaId]?.externalProjectId ?? "";
		const entered = window.prompt(
			"Enter thumbnail project_id to link transcript to this media asset:",
			existing,
		);
		const externalProjectId = entered?.trim();
		if (!externalProjectId) return;

		try {
			const linkResponse = await fetch(
				"/api/external-projects/link-thumbnail",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						opencutProjectId: activeProject.metadata.id,
						sourceSystem: "thumbnail_decoupled" as const,
						externalProjectId,
					}),
				},
			);
			const linkJson = (await linkResponse.json()) as { error?: string };
			if (!linkResponse.ok || linkJson.error) {
				throw new Error(linkJson.error || "Failed to link thumbnail project");
			}

			const applyResponse = await fetch(
				`/api/external-projects/${encodeURIComponent(activeProject.metadata.id)}/transcript/apply`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sourceSystem: "thumbnail_decoupled" as ExternalSourceSystem,
						externalProjectId,
					}),
				},
			);
			const applyJson = (await applyResponse.json()) as
				| {
						error?: string;
						sourceSystem: ExternalSourceSystem;
						externalProjectId: string;
						transcriptText: string;
						segments: Array<{ text: string; start: number; end: number }>;
						segmentsCount: number;
						audioDurationSeconds: number | null;
						qualityMeta?: Record<string, unknown>;
						updatedAt: string;
				  }
				| { error: string };
			if (!applyResponse.ok || "error" in applyJson) {
				throw new Error(
					applyJson.error || "Failed to hydrate linked transcript",
				);
			}

			const cacheKey = `${applyJson.sourceSystem}:${applyJson.externalProjectId}`;
			const latestProject = editor.project.getActive();
			editor.project.setActiveProject({
				project: {
					...latestProject,
					externalMediaLinks: {
						...(latestProject.externalMediaLinks ?? {}),
						[mediaId]: {
							sourceSystem: applyJson.sourceSystem,
							externalProjectId: applyJson.externalProjectId,
							opencutProjectId: latestProject.metadata.id,
							linkedAt: new Date().toISOString(),
						},
					},
					externalTranscriptCache: {
						...(latestProject.externalTranscriptCache ?? {}),
						[cacheKey]: {
							sourceSystem: applyJson.sourceSystem,
							externalProjectId: applyJson.externalProjectId,
							transcriptText: applyJson.transcriptText,
							segments: applyJson.segments,
							segmentsCount: applyJson.segmentsCount,
							audioDurationSeconds: applyJson.audioDurationSeconds,
							qualityMeta: applyJson.qualityMeta,
							updatedAt: applyJson.updatedAt,
						},
					},
				},
			});
			editor.save.markDirty();
			await editor.save.flush();
			toast.success("Linked thumbnail transcript to media");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to link thumbnail transcript",
			);
		}
	};

	const handleUnlinkThumbnailProjectForMedia = ({
		mediaId,
	}: {
		mediaId: string;
	}) => {
		const latestProject = editor.project.getActive();
		const nextLinks = { ...(latestProject.externalMediaLinks ?? {}) };
		delete nextLinks[mediaId];
		editor.project.setActiveProject({
			project: {
				...latestProject,
				externalMediaLinks: nextLinks,
			},
		});
		editor.save.markDirty();
		void editor.save.flush();
		toast.success("Removed media transcript link");
	};
	const clipCountsBySource = useMemo(() => {
		const cache = activeProject.clipGenerationCache ?? {};
		const counts = new Map<string, number>();
		for (const [sourceMediaId, entry] of Object.entries(cache)) {
			counts.set(sourceMediaId, entry.candidates.length);
		}
		return counts;
	}, [activeProject.clipGenerationCache]);

	return (
		<>
			<input {...fileInputProps} />

			<PanelView
				title="Assets"
				actions={mediaActions}
				className={isDragOver ? "bg-accent/30" : ""}
				{...dragProps}
			>
				{isDragOver || filteredMediaItems.length === 0 ? (
					<MediaDragOverlay
						isVisible={true}
						isProcessing={isProcessing}
						progress={progress}
						step={processingStep}
						stepProgress={processingStepProgress}
						onClick={openFilePicker}
					/>
				) : mediaViewMode === "grid" ? (
					<GridView
						items={filteredMediaItems}
						renderPreview={renderPreview}
						onRemove={handleRemove}
						onAddToTimeline={addElementAtTime}
						highlightedId={highlightedId}
						registerElement={registerElement}
						onGenerateClips={handleGenerateClipsForMedia}
						clipCountsBySource={clipCountsBySource}
						onLinkThumbnailProject={handleLinkThumbnailProjectForMedia}
						onUnlinkThumbnailProject={handleUnlinkThumbnailProjectForMedia}
						linkedExternalProjectIdsByMedia={
							activeProject.externalMediaLinks ?? {}
						}
					/>
				) : (
					<ListView
						items={filteredMediaItems}
						renderPreview={renderCompactPreview}
						onRemove={handleRemove}
						onAddToTimeline={addElementAtTime}
						highlightedId={highlightedId}
						registerElement={registerElement}
						onGenerateClips={handleGenerateClipsForMedia}
						clipCountsBySource={clipCountsBySource}
						onLinkThumbnailProject={handleLinkThumbnailProjectForMedia}
						onUnlinkThumbnailProject={handleUnlinkThumbnailProjectForMedia}
						linkedExternalProjectIdsByMedia={
							activeProject.externalMediaLinks ?? {}
						}
					/>
				)}
			</PanelView>
		</>
	);
}

function GenerateClipsIconButton({
	item,
	onGenerate,
	clipCount,
}: {
	item: MediaAsset;
	onGenerate: ({ mediaId }: { mediaId: string }) => void;
	clipCount: number;
}) {
	if (item.type !== "video") return null;

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<div className="relative">
						<Button
							size="icon"
							variant="secondary"
							className="h-5 w-5"
							onClick={(event) => {
								event.stopPropagation();
								onGenerate({ mediaId: item.id });
							}}
						>
							<HugeiconsIcon icon={Video01Icon} className="size-3.5" />
						</Button>
						<div className="bg-background absolute -right-1 -bottom-1 rounded px-1 text-[10px] leading-3.5">
							{clipCount}
						</div>
					</div>
				</TooltipTrigger>
				<TooltipContent>
					{clipCount > 0 ? "View clips" : "Generate clips"}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

function MediaItemWithContextMenu({
	item,
	children,
	onRemove,
	onLinkThumbnailProject,
	onUnlinkThumbnailProject,
	linkedExternalProjectId,
}: {
	item: MediaAsset;
	children: React.ReactNode;
	onRemove: ({ event, id }: { event: React.MouseEvent; id: string }) => void;
	onLinkThumbnailProject: ({ mediaId }: { mediaId: string }) => void;
	onUnlinkThumbnailProject: ({ mediaId }: { mediaId: string }) => void;
	linkedExternalProjectId?: string;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem>Export clips</ContextMenuItem>
				{item.type === "video" ? (
					<ContextMenuItem
						onClick={() => onLinkThumbnailProject({ mediaId: item.id })}
					>
						{linkedExternalProjectId
							? `Relink Transcript (${linkedExternalProjectId})`
							: "Link Transcript Project..."}
					</ContextMenuItem>
				) : null}
				{linkedExternalProjectId ? (
					<ContextMenuItem
						onClick={() => onUnlinkThumbnailProject({ mediaId: item.id })}
					>
						Unlink Transcript Project
					</ContextMenuItem>
				) : null}
				<ContextMenuItem
					variant="destructive"
					onClick={(event) => onRemove({ event, id: item.id })}
				>
					Delete
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function GridView({
	items,
	renderPreview,
	onRemove,
	onAddToTimeline,
	highlightedId,
	registerElement,
	onGenerateClips,
	clipCountsBySource,
	onLinkThumbnailProject,
	onUnlinkThumbnailProject,
	linkedExternalProjectIdsByMedia,
}: {
	items: MediaAsset[];
	renderPreview: (item: MediaAsset) => React.ReactNode;
	onRemove: ({ event, id }: { event: React.MouseEvent; id: string }) => void;
	onAddToTimeline: ({
		asset,
		startTime,
	}: {
		asset: MediaAsset;
		startTime: number;
	}) => boolean;
	highlightedId: string | null;
	registerElement: (id: string, element: HTMLElement | null) => void;
	onGenerateClips: ({ mediaId }: { mediaId: string }) => void;
	clipCountsBySource: Map<string, number>;
	onLinkThumbnailProject: ({ mediaId }: { mediaId: string }) => void;
	onUnlinkThumbnailProject: ({ mediaId }: { mediaId: string }) => void;
	linkedExternalProjectIdsByMedia: Record<
		string,
		{ externalProjectId: string }
	>;
}) {
	return (
		<div
			className="grid gap-2"
			style={{
				gridTemplateColumns: "repeat(auto-fill, 160px)",
			}}
		>
			{items.map((item) => (
				<div key={item.id} ref={(el) => registerElement(item.id, el)}>
					<MediaItemWithContextMenu
						item={item}
						onRemove={onRemove}
						onLinkThumbnailProject={onLinkThumbnailProject}
						onUnlinkThumbnailProject={onUnlinkThumbnailProject}
						linkedExternalProjectId={
							linkedExternalProjectIdsByMedia[item.id]?.externalProjectId
						}
					>
						<DraggableItem
							name={item.name}
							preview={renderPreview(item)}
							thumbnailTopRightControl={
								<GenerateClipsIconButton
									item={item}
									onGenerate={onGenerateClips}
									clipCount={clipCountsBySource.get(item.id) ?? 0}
								/>
							}
							dragData={{
								id: item.id,
								type: "media",
								mediaType: item.type,
								name: item.name,
							}}
							shouldShowPlusOnDrag={false}
							onAddToTimeline={({ currentTime }) =>
								onAddToTimeline({ asset: item, startTime: currentTime })
							}
							isRounded={false}
							variant="card"
							isHighlighted={highlightedId === item.id}
						/>
					</MediaItemWithContextMenu>
				</div>
			))}
		</div>
	);
}

function ListView({
	items,
	renderPreview,
	onRemove,
	onAddToTimeline,
	highlightedId,
	registerElement,
	onGenerateClips,
	clipCountsBySource,
	onLinkThumbnailProject,
	onUnlinkThumbnailProject,
	linkedExternalProjectIdsByMedia,
}: {
	items: MediaAsset[];
	renderPreview: (item: MediaAsset) => React.ReactNode;
	onRemove: ({ event, id }: { event: React.MouseEvent; id: string }) => void;
	onAddToTimeline: ({
		asset,
		startTime,
	}: {
		asset: MediaAsset;
		startTime: number;
	}) => boolean;
	highlightedId: string | null;
	registerElement: (id: string, element: HTMLElement | null) => void;
	onGenerateClips: ({ mediaId }: { mediaId: string }) => void;
	clipCountsBySource: Map<string, number>;
	onLinkThumbnailProject: ({ mediaId }: { mediaId: string }) => void;
	onUnlinkThumbnailProject: ({ mediaId }: { mediaId: string }) => void;
	linkedExternalProjectIdsByMedia: Record<
		string,
		{ externalProjectId: string }
	>;
}) {
	return (
		<div className="space-y-1">
			{items.map((item) => (
				<div key={item.id} ref={(el) => registerElement(item.id, el)}>
					<MediaItemWithContextMenu
						item={item}
						onRemove={onRemove}
						onLinkThumbnailProject={onLinkThumbnailProject}
						onUnlinkThumbnailProject={onUnlinkThumbnailProject}
						linkedExternalProjectId={
							linkedExternalProjectIdsByMedia[item.id]?.externalProjectId
						}
					>
						<DraggableItem
							name={item.name}
							preview={renderPreview(item)}
							thumbnailTopRightControl={
								<GenerateClipsIconButton
									item={item}
									onGenerate={onGenerateClips}
									clipCount={clipCountsBySource.get(item.id) ?? 0}
								/>
							}
							dragData={{
								id: item.id,
								type: "media",
								mediaType: item.type,
								name: item.name,
							}}
							shouldShowPlusOnDrag={false}
							onAddToTimeline={({ currentTime }) =>
								onAddToTimeline({ asset: item, startTime: currentTime })
							}
							variant="compact"
							isHighlighted={highlightedId === item.id}
						/>
					</MediaItemWithContextMenu>
				</div>
			))}
		</div>
	);
}

const formatDuration = ({ duration }: { duration: number }) => {
	const min = Math.floor(duration / 60);
	const sec = Math.floor(duration % 60);
	return `${min}:${sec.toString().padStart(2, "0")}`;
};

function MediaDurationBadge({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<div className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-xs text-white">
			{formatDuration({ duration })}
		</div>
	);
}

function MediaDurationLabel({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<span className="text-xs opacity-70">{formatDuration({ duration })}</span>
	);
}

function MediaTypePlaceholder({
	icon,
	label,
	duration,
	variant,
}: {
	icon: IconSvgElement;
	label: string;
	duration?: number;
	variant: "muted" | "bordered";
}) {
	const iconClassName = cn("size-6", variant === "bordered" && "mb-1");

	return (
		<div
			className={cn(
				"text-muted-foreground flex size-full flex-col items-center justify-center rounded",
				variant === "muted" ? "bg-muted/30" : "border",
			)}
		>
			<HugeiconsIcon icon={icon} className={iconClassName} />
			<span className="text-xs">{label}</span>
			<MediaDurationLabel duration={duration} />
		</div>
	);
}

function MediaPreview({
	item,
	variant = "grid",
}: {
	item: MediaAsset;
	variant?: "grid" | "compact";
}) {
	const shouldShowDurationBadge = variant === "grid";

	if (item.type === "image") {
		return (
			<div className="relative flex size-full items-center justify-center">
				<Image
					src={item.url ?? ""}
					alt={item.name}
					fill
					sizes="100vw"
					className="object-cover"
					loading="lazy"
					unoptimized
				/>
			</div>
		);
	}

	if (item.type === "video") {
		if (item.thumbnailUrl) {
			return (
				<div className="relative size-full">
					<Image
						src={item.thumbnailUrl}
						alt={item.name}
						fill
						sizes="100vw"
						className="rounded object-cover"
						loading="lazy"
						unoptimized
					/>
					{shouldShowDurationBadge ? (
						<MediaDurationBadge duration={item.duration} />
					) : null}
				</div>
			);
		}

		return (
			<MediaTypePlaceholder
				icon={Video01Icon}
				label="Video"
				duration={item.duration}
				variant="muted"
			/>
		);
	}

	if (item.type === "audio") {
		return (
			<MediaTypePlaceholder
				icon={MusicNote03Icon}
				label="Audio"
				duration={item.duration}
				variant="bordered"
			/>
		);
	}

	return (
		<MediaTypePlaceholder icon={Image02Icon} label="Unknown" variant="muted" />
	);
}

function SortMenuItem({
	label,
	sortKey,
	currentSortBy,
	currentSortOrder,
	onSort,
}: {
	label: string;
	sortKey: "name" | "type" | "duration" | "size";
	currentSortBy: string;
	currentSortOrder: "asc" | "desc";
	onSort: ({ key }: { key: "name" | "type" | "duration" | "size" }) => void;
}) {
	const isActive = currentSortBy === sortKey;
	const arrow = isActive ? (currentSortOrder === "asc" ? "↑" : "↓") : "";

	return (
		<DropdownMenuItem onClick={() => onSort({ key: sortKey })}>
			{label} {arrow}
		</DropdownMenuItem>
	);
}
