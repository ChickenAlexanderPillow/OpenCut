import { useState, useCallback, type RefObject } from "react";
import { useEditor } from "@/hooks/use-editor";
import { processMediaAssets } from "@/lib/media/processing";
import { prepareProjectMediaImport } from "@/lib/media/project-import";
import {
	autoLinkTranscriptAndCaptionsForMediaElement,
} from "@/lib/media/transcript-import";
import { toast } from "sonner";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { snapTimeToFrame } from "@/lib/time";
import {
	buildTextElement,
	buildStickerElement,
	buildElementFromMedia,
} from "@/lib/timeline/element-utils";
import { getVideoCoverScaleMultiplier } from "@/lib/timeline/video-cover-fit";
import type { Command } from "@/lib/commands/base-command";
import { AddTrackCommand, InsertElementCommand } from "@/lib/commands/timeline";
import { BatchCommand } from "@/lib/commands";
import { computeDropTarget } from "@/lib/timeline/drop-utils";
import { getDragData, hasDragData } from "@/lib/drag-data";
import { invokeAction } from "@/lib/actions";
import { importLocalMusicToTimeline } from "@/lib/music/import-local-music";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import type { TrackType, DropTarget, ElementType } from "@/types/timeline";
import type {
	LocalMusicDragData,
	MediaDragData,
	StickerDragData,
} from "@/types/drag";

interface UseTimelineDragDropProps {
	containerRef: RefObject<HTMLDivElement | null>;
	headerRef?: RefObject<HTMLElement | null>;
	zoomLevel: number;
}

const EDITOR_SUBSCRIBE_DRAG_DROP = [
	"timeline",
	"media",
	"playback",
	"project",
] as const;

export function useTimelineDragDrop({
	containerRef,
	headerRef,
	zoomLevel,
}: UseTimelineDragDropProps) {
	const editor = useEditor({ subscribeTo: EDITOR_SUBSCRIBE_DRAG_DROP });
	const [isDragOver, setIsDragOver] = useState(false);
	const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
	const [dragElementType, setElementType] = useState<ElementType | null>(null);
	const [dragElementDuration, setDragElementDuration] = useState<number | null>(
		null,
	);
	const [transitionDropTarget, setTransitionDropTarget] = useState<{
		trackId: string;
		elementId: string;
		side: "in" | "out";
	} | null>(null);

	const tracks = editor.timeline.getTracks();
	const currentTime = editor.playback.getCurrentTime();
	const mediaAssets = editor.media.getAssets();
	const activeProject = editor.project.getActive();

	const getSnappedTime = useCallback(
		({ time }: { time: number }) => {
			const projectFps = activeProject.settings.fps;
			return snapTimeToFrame({ time, fps: projectFps });
		},
		[activeProject.settings.fps],
	);

	const getElementType = useCallback(
		({ dataTransfer }: { dataTransfer: DataTransfer }): ElementType | null => {
			const dragData = getDragData({ dataTransfer });
			if (!dragData) return null;

			if (dragData.type === "text") return "text";
			if (dragData.type === "sticker") return "sticker";
			if (dragData.type === "local-music") return "audio";
			if (dragData.type === "media") {
				return dragData.mediaType;
			}
			return null;
		},
		[],
	);

	const getElementDuration = useCallback(
		({
			elementType,
			mediaId,
		}: {
			elementType: ElementType;
			mediaId?: string;
		}): number => {
			if (elementType === "text" || elementType === "sticker") {
				return TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
			}
			if (mediaId) {
				const media = mediaAssets.find((m) => m.id === mediaId);
				return media?.duration ?? TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
			}
			return TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
		},
		[mediaAssets],
	);

	const handleDragEnter = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		const hasAsset = hasDragData({ dataTransfer: e.dataTransfer });
		const hasFiles = e.dataTransfer.types.includes("Files");
		if (!hasAsset && !hasFiles) return;
		setIsDragOver(true);
	}, []);

	const handleDragOver = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();

			const rect = containerRef.current?.getBoundingClientRect();
			if (!rect) return;

			const headerHeight =
				headerRef?.current?.getBoundingClientRect().height ?? 0;
			const hasFiles = e.dataTransfer.types.includes("Files");
			const isExternal =
				hasFiles && !hasDragData({ dataTransfer: e.dataTransfer });

			const dragData = getDragData({ dataTransfer: e.dataTransfer });
			if (dragData?.type === "transition") {
				const domTarget = (
					e.target as HTMLElement | null
				)?.closest<HTMLElement>(
					"[data-timeline-element-id][data-timeline-track-id]",
				);
				if (domTarget) {
					const elementRect = domTarget.getBoundingClientRect();
					const edgeThreshold = Math.max(
						8,
						Math.min(18, elementRect.width * 0.25),
					);
					const side =
						e.clientX - elementRect.left <= edgeThreshold
							? "in"
							: elementRect.right - e.clientX <= edgeThreshold
								? "out"
								: null;
					const elementType = domTarget.dataset.timelineElementType;
					const isVisual =
						elementType === "video" ||
						elementType === "image" ||
						elementType === "text" ||
						elementType === "sticker";
					if (side && isVisual) {
						setTransitionDropTarget({
							trackId: domTarget.dataset.timelineTrackId ?? "",
							elementId: domTarget.dataset.timelineElementId ?? "",
							side,
						});
					} else {
						setTransitionDropTarget(null);
					}
				} else {
					setTransitionDropTarget(null);
				}
				setDropTarget(null);
				setElementType(null);
				setDragElementDuration(null);
				return;
			}

			setTransitionDropTarget(null);
			const elementType = getElementType({ dataTransfer: e.dataTransfer });

			if (!elementType && hasFiles && isExternal) {
				setDropTarget(null);
				setElementType(null);
				setDragElementDuration(null);
				return;
			}

			if (!elementType) return;

			setElementType(elementType);

			const duration = getElementDuration({
				elementType,
				mediaId: dragData?.type === "media" ? dragData.id : undefined,
			});
			if (dragData?.type === "media") {
				setDragElementDuration((prev) => (prev === duration ? prev : duration));
			} else {
				setDragElementDuration((prev) => (prev === null ? prev : null));
			}

			const mouseX = e.clientX - rect.left;
			const mouseY = Math.max(0, e.clientY - rect.top - headerHeight);

			const target = computeDropTarget({
				elementType,
				mouseX,
				mouseY,
				tracks,
				playheadTime: currentTime,
				isExternalDrop: isExternal,
				elementDuration: duration,
				pixelsPerSecond: TIMELINE_CONSTANTS.PIXELS_PER_SECOND,
				zoomLevel,
			});

			target.xPosition = getSnappedTime({ time: target.xPosition });

			setDropTarget(target);
			e.dataTransfer.dropEffect = "copy";
		},
		[
			containerRef,
			headerRef,
			tracks,
			currentTime,
			zoomLevel,
			getElementType,
			getElementDuration,
			getSnappedTime,
		],
	);

	const handleDragLeave = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			const rect = containerRef.current?.getBoundingClientRect();
			if (rect) {
				const { clientX, clientY } = e;
				if (
					clientX < rect.left ||
					clientX > rect.right ||
					clientY < rect.top ||
					clientY > rect.bottom
				) {
					setIsDragOver(false);
					setDropTarget(null);
					setElementType(null);
					setDragElementDuration(null);
					setTransitionDropTarget(null);
				}
			}
		},
		[containerRef],
	);

	const executeTextDrop = useCallback(
		({
			target,
			dragData,
		}: {
			target: DropTarget;
			dragData: {
				name?: string;
				content?: string;
				raw?: Record<string, unknown>;
			};
		}) => {
			let trackId: string;

			if (target.isNewTrack) {
				trackId = editor.timeline.addTrack({
					type: "text",
					index: target.trackIndex,
				});
			} else {
				const track = tracks[target.trackIndex];
				if (!track) return;
				trackId = track.id;
			}

			const element = buildTextElement({
				raw: {
					...(dragData.raw ?? {}),
					name: dragData.name ?? "",
					content: dragData.content ?? "",
				},
				startTime: target.xPosition,
			});

			editor.timeline.insertElement({
				placement: { mode: "explicit", trackId },
				element,
			});
		},
		[editor.timeline, tracks],
	);

	const executeStickerDrop = useCallback(
		({
			target,
			dragData,
		}: {
			target: DropTarget;
			dragData: StickerDragData;
		}) => {
			let trackId: string;

			if (target.isNewTrack) {
				trackId = editor.timeline.addTrack({
					type: "sticker",
					index: target.trackIndex,
				});
			} else {
				const track = tracks[target.trackIndex];
				if (!track) return;
				trackId = track.id;
			}

			const element = buildStickerElement({
				stickerId: dragData.stickerId,
				name: dragData.name,
				startTime: target.xPosition,
			});

			editor.timeline.insertElement({
				placement: { mode: "explicit", trackId },
				element,
			});
		},
		[editor.timeline, tracks],
	);

	const executeMediaDrop = useCallback(
		({ target, dragData }: { target: DropTarget; dragData: MediaDragData }) => {
			const mediaAsset = mediaAssets.find((m) => m.id === dragData.id);
			if (!mediaAsset) return;

			const trackType: TrackType =
				dragData.mediaType === "audio" ? "audio" : "video";
			let trackId: string;

			if (target.isNewTrack) {
				trackId = editor.timeline.addTrack({
					type: trackType,
					index: target.trackIndex,
				});
			} else {
				const track = tracks[target.trackIndex];
				if (!track) return;
				trackId = track.id;
			}

			const duration =
				mediaAsset.duration ?? TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
			const canvasSize = activeProject?.settings.canvasSize;
			const element = buildElementFromMedia({
				mediaId: mediaAsset.id,
				mediaType: mediaAsset.type,
				name: mediaAsset.name,
				duration,
				startTime: target.xPosition,
				transformScale:
					mediaAsset.type === "video" && canvasSize
						? getVideoCoverScaleMultiplier({
								canvasSize,
								sourceWidth: mediaAsset.width,
								sourceHeight: mediaAsset.height,
						  })
						: undefined,
			});

			const insertCmd = new InsertElementCommand({
				placement: { mode: "explicit", trackId },
				element,
			});
			editor.command.execute({ command: insertCmd });
			if (dragData.mediaType === "video" || dragData.mediaType === "audio") {
				void autoLinkTranscriptAndCaptionsForMediaElement({
					editor,
					trackId,
					elementId: insertCmd.getElementId(),
				});
			}
		},
		[activeProject, editor.command, editor, mediaAssets, tracks],
	);

	const executeLocalMusicDrop = useCallback(
		async ({
			target,
			dragData,
		}: {
			target: DropTarget;
			dragData: LocalMusicDragData;
		}) => {
			const existingTrackId = target.isNewTrack
				? undefined
				: tracks[target.trackIndex]?.id;

			await importLocalMusicToTimeline({
				editor,
				root: dragData.root,
				file: {
					name: dragData.name,
					relativePath: dragData.relativePath,
					extension: dragData.extension,
				},
				target: {
					mode: "explicit",
					startTime: target.xPosition,
					trackId: existingTrackId,
					trackIndex: target.trackIndex,
					isNewTrack: target.isNewTrack,
				},
			});
		},
		[editor, tracks],
	);

	const executeFileDrop = useCallback(
		async ({
			files,
			mouseX,
			mouseY,
		}: {
			files: File[];
			mouseX: number;
			mouseY: number;
		}) => {
			if (!activeProject) return;

			const processedAssets = await processMediaAssets({ files });
			for (const asset of processedAssets) {
				const duration =
					asset.duration ?? TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
				const currentTracks = editor.timeline.getTracks();
				const dropTarget = computeDropTarget({
					elementType: asset.type,
					mouseX,
					mouseY,
					tracks: currentTracks,
					playheadTime: currentTime,
					isExternalDrop: true,
					elementDuration: duration,
					pixelsPerSecond: TIMELINE_CONSTANTS.PIXELS_PER_SECOND,
					zoomLevel,
				});

				const trackType: TrackType = asset.type === "audio" ? "audio" : "video";
				const { addMediaCmd, assetId } = await prepareProjectMediaImport({
					editor,
					asset,
				});

				const commands: Command[] = [addMediaCmd];

				let trackId: string | undefined;
				if (dropTarget.isNewTrack) {
					const addTrackCmd = new AddTrackCommand(
						trackType,
						dropTarget.trackIndex,
					);
					trackId = addTrackCmd.getTrackId();
					commands.unshift(addTrackCmd);
				} else {
					trackId = currentTracks[dropTarget.trackIndex]?.id;
				}

				if (!trackId) return;

				const element = buildElementFromMedia({
					mediaId: assetId,
					mediaType: asset.type,
					name: asset.name,
					duration,
					startTime: dropTarget.xPosition,
					transformScale:
						asset.type === "video"
							? getVideoCoverScaleMultiplier({
									canvasSize: activeProject.settings.canvasSize,
									sourceWidth: asset.width,
									sourceHeight: asset.height,
							  })
							: undefined,
				});

				const insertCmd = new InsertElementCommand({
					element,
					placement: { mode: "explicit", trackId },
				});
				commands.push(insertCmd);

				const batchCmd = new BatchCommand(commands);
				editor.command.execute({ command: batchCmd });
				useAssetsPanelStore.getState().requestRevealMedia(assetId);
				if (asset.type === "video" || asset.type === "audio") {
					void autoLinkTranscriptAndCaptionsForMediaElement({
						editor,
						trackId,
						elementId: insertCmd.getElementId(),
					});
				}
			}
		},
		[
			activeProject,
			editor,
			editor.command,
			editor.timeline,
			currentTime,
			zoomLevel,
		],
	);

	const handleDrop = useCallback(
		async (e: React.DragEvent) => {
			e.preventDefault();

			const hasAsset = hasDragData({ dataTransfer: e.dataTransfer });
			const hasFiles = e.dataTransfer.files?.length > 0;

			if (!hasAsset && !hasFiles) return;

			const currentTarget = dropTarget;
			setIsDragOver(false);
			setDropTarget(null);
			setElementType(null);
			setDragElementDuration(null);
			setTransitionDropTarget(null);

			try {
				if (hasAsset) {
					const dragData = getDragData({ dataTransfer: e.dataTransfer });
					if (!dragData) return;

					if (dragData.type === "transition") {
						const transitionTarget = transitionDropTarget;
						if (!transitionTarget?.trackId || !transitionTarget.elementId) {
							return;
						}
						invokeAction(
							transitionTarget.side === "in"
								? "apply-transition-in"
								: "apply-transition-out",
							{
								presetId: dragData.presetId,
								trackId: transitionTarget.trackId,
								elementId: transitionTarget.elementId,
							},
						);
					} else if (dragData.type === "text") {
						if (!currentTarget) return;
						executeTextDrop({ target: currentTarget, dragData });
					} else if (dragData.type === "sticker") {
						if (!currentTarget) return;
						executeStickerDrop({ target: currentTarget, dragData });
					} else if (dragData.type === "local-music") {
						if (!currentTarget) return;
						await executeLocalMusicDrop({ target: currentTarget, dragData });
					} else {
						if (!currentTarget) return;
						executeMediaDrop({ target: currentTarget, dragData });
					}
				} else if (hasFiles) {
					const rect = containerRef.current?.getBoundingClientRect();
					if (!rect) return;
					const mouseX = e.clientX - rect.left;
					const headerHeight =
						headerRef?.current?.getBoundingClientRect().height ?? 0;
					const mouseY = Math.max(0, e.clientY - rect.top - headerHeight);
					await executeFileDrop({
						files: Array.from(e.dataTransfer.files),
						mouseX,
						mouseY,
					});
				}
			} catch (err) {
				console.error("Failed to process drop:", err);
				toast.error("Failed to process drop");
			}
		},
		[
			dropTarget,
			executeTextDrop,
			executeStickerDrop,
			executeLocalMusicDrop,
			executeMediaDrop,
			executeFileDrop,
			transitionDropTarget,
			containerRef,
			headerRef,
		],
	);

	return {
		isDragOver,
		dropTarget,
		transitionDropTarget,
		dragElementType,
		dragElementDuration,
		dragProps: {
			onDragEnter: handleDragEnter,
			onDragOver: handleDragOver,
			onDragLeave: handleDragLeave,
			onDrop: handleDrop,
		},
	};
}
