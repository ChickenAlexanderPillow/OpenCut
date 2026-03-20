"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { InteractiveMediaPreview } from "@/components/editor/panels/assets/interactive-media-preview";
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
import { Skeleton } from "@/components/ui/skeleton";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { useEditor } from "@/hooks/use-editor";
import { useFileUpload } from "@/hooks/use-file-upload";
import { useRevealItem } from "@/hooks/use-reveal-item";
import { invokeAction } from "@/lib/actions";
import { InsertElementCommand } from "@/lib/commands/timeline";
import { processMediaAssets } from "@/lib/media/processing";
import { prepareProjectMediaImport } from "@/lib/media/project-import";
import { autoLinkTranscriptAndCaptionsForMediaElement } from "@/lib/media/transcript-import";
import { getMediaTypeFromFile } from "@/lib/media/media-utils";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import type { MediaAsset } from "@/types/assets";
import type { ExternalSourceSystem } from "@/types/external-projects";
import {
	CloudUploadIcon,
	GridViewIcon,
	LeftToRightListDashIcon,
	SortingOneNineIcon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const ASSET_CARD_WIDTH = 176;

type PendingImport = {
	id: string;
	name: string;
	type: MediaAsset["type"];
	progress: number;
	step: string;
};

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
	const [pendingImports, setPendingImports] = useState<PendingImport[]>([]);
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

		const pending = supportedMediaFiles.map((file, index) => ({
			id: `${file.name}:${file.size}:${file.lastModified}:${index}`,
			name: file.name,
			type: getMediaTypeFromFile({ file }) as MediaAsset["type"],
			progress: 0,
			step: "Queued for import",
		}));
		const pendingIds = new Set(pending.map((entry) => entry.id));
		setPendingImports((current) => [...pending, ...current]);
		setIsProcessing(true);
		setProgress(0);
		setProcessingStep("Starting import");
		setProcessingStepProgress(0);
		try {
			for (const [index, file] of supportedMediaFiles.entries()) {
				const pendingId = pending[index]?.id;
				const processedAssets = await processMediaAssets({
					files: [file],
					onProgress: ({
						progress,
						step,
						stepProgress,
					}: {
						progress: number;
						step?: string;
						stepProgress?: number;
					}) => {
						const overallProgress = Math.round(
							((index + progress / 100) / supportedMediaFiles.length) * 100,
						);
						setProgress(overallProgress);
						if (step) setProcessingStep(step);
						if (typeof stepProgress === "number") {
							setProcessingStepProgress(stepProgress);
						}
						if (pendingId) {
							setPendingImports((current) =>
								current.map((entry) =>
									entry.id === pendingId
										? {
												...entry,
												progress,
												step: step ?? entry.step,
											}
										: entry,
								),
							);
						}
					},
				});
				for (const asset of processedAssets) {
					const { addMediaCmd } = await prepareProjectMediaImport({
						editor,
						asset,
						onProgress: ({ progress, step, stepProgress }) => {
							const overallProgress = Math.round(
								((index + progress / 100) / supportedMediaFiles.length) * 100,
							);
							setProgress(overallProgress);
							if (step) setProcessingStep(step);
							if (typeof stepProgress === "number") {
								setProcessingStepProgress(stepProgress);
							}
							if (pendingId) {
								setPendingImports((current) =>
									current.map((entry) =>
										entry.id === pendingId
											? {
													...entry,
													progress: Math.max(entry.progress, progress),
													step: step ?? entry.step,
												}
											: entry,
									),
								);
							}
						},
					});
					editor.command.execute({ command: addMediaCmd });
				}
				if (pendingId) {
					setPendingImports((current) =>
						current.filter((entry) => entry.id !== pendingId),
					);
				}
			}
		} catch (error) {
			console.error("Error processing files:", error);
			toast.error("Failed to process files");
			setPendingImports((current) =>
				current.filter((entry) => !pendingIds.has(entry.id)),
			);
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
						pendingImports={pendingImports}
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
						pendingImports={pendingImports}
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
	pendingImports,
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
	pendingImports: PendingImport[];
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
				gridTemplateColumns: `repeat(auto-fill, ${ASSET_CARD_WIDTH}px)`,
			}}
		>
			{pendingImports.map((item) => (
				<PendingGridItem key={item.id} item={item} />
			))}
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
							className="w-full"
							containerClassName="w-full"
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
	pendingImports,
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
	pendingImports: PendingImport[];
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
			{pendingImports.map((item) => (
				<PendingListItem key={item.id} item={item} />
			))}
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
							className="rounded-sm hover:bg-accent/40"
							containerClassName="w-full"
							isHighlighted={highlightedId === item.id}
						/>
					</MediaItemWithContextMenu>
				</div>
			))}
		</div>
	);
}

function PendingGridItem({ item }: { item: PendingImport }) {
	return (
		<div className="w-full">
			<div className="relative flex h-auto w-full flex-col gap-1 p-1 opacity-85">
				<div className="bg-accent relative aspect-video overflow-hidden rounded-sm">
					<Skeleton className="size-full rounded-sm" />
					<div className="absolute inset-x-3 bottom-3 space-y-2">
						<Skeleton className="h-3 w-1/2 bg-white/20" />
						<div className="h-1.5 overflow-hidden rounded-full bg-black/20">
							<div
								className="bg-primary h-full rounded-full transition-[width] duration-200"
								style={{ width: `${Math.max(8, item.progress)}%` }}
							/>
						</div>
					</div>
				</div>
				<div className="space-y-1 px-0.5">
					<span className="text-muted-foreground block truncate text-[0.7rem]">
						{item.name}
					</span>
					<span className="text-muted-foreground/80 block truncate text-[0.65rem]">
						{item.type.toUpperCase()} • {item.step}
					</span>
				</div>
			</div>
		</div>
	);
}

function PendingListItem({ item }: { item: PendingImport }) {
	return (
		<div className="flex h-9 w-full items-center gap-3 rounded-sm px-1 opacity-85">
			<div className="relative size-[1.65rem] flex-shrink-0 overflow-hidden rounded-[0.35rem]">
				<Skeleton className="size-full rounded-[0.35rem]" />
			</div>
			<div className="min-w-0 flex-1">
				<div className="text-sm truncate">{item.name}</div>
				<div className="text-muted-foreground truncate text-[10px]">
					{item.type.toUpperCase()} • {item.step}
				</div>
			</div>
			<div className="w-14 overflow-hidden rounded-full bg-muted/70">
				<div
					className="bg-primary h-1.5 rounded-full transition-[width] duration-200"
					style={{ width: `${Math.max(8, item.progress)}%` }}
				/>
			</div>
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

function MediaPreview({
	item,
	variant = "grid",
}: {
	item: MediaAsset;
	variant?: "grid" | "compact";
}) {
	if (item.type === "image") {
		return (
			<InteractiveMediaPreview
				previewId={item.id}
				name={item.name}
				mediaType={item.type}
				src={item.url ?? null}
			/>
		);
	}

	if (variant === "compact") {
		return item.type === "video" ? (
			<div className="relative size-full">
				{item.thumbnailUrl ? (
					<Image
						src={item.thumbnailUrl}
						alt={item.name}
						fill
						sizes="24px"
						className="rounded object-cover"
						loading="lazy"
						unoptimized
					/>
				) : (
					<div className="text-muted-foreground flex size-full items-center justify-center rounded border border-dashed bg-muted/20 text-[10px]">
						VID
					</div>
				)}
			</div>
		) : (
			<div className="text-muted-foreground flex size-full items-center justify-center rounded border border-dashed bg-muted/20 text-[10px]">
				AUD
			</div>
		);
	}

	return (
		<div className="relative size-full">
			<InteractiveMediaPreview
				previewId={item.id}
				name={item.name}
				mediaType={item.type}
				src={item.previewUrl ?? item.url ?? null}
				thumbnailSrc={item.thumbnailUrl}
				duration={item.duration}
			/>
			<MediaDurationBadge duration={item.duration} />
		</div>
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
