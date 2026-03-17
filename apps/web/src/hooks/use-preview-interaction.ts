import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useShiftKey } from "@/hooks/use-shift-key";
import type { TextElement, Transform } from "@/types/timeline";
import { getVisibleElementsWithBounds } from "@/lib/preview/element-bounds";
import { hitTest } from "@/lib/preview/hit-test";
import {
	screenPixelsToLogicalThreshold,
	screenToCanvas,
} from "@/lib/preview/preview-coords";
import {
	getPreviewCanvasSize,
	remapCaptionTransformsForPreviewVariant,
} from "@/lib/preview/preview-format";
import { isVisualElement } from "@/lib/timeline/element-utils";
import {
	SNAP_THRESHOLD_SCREEN_PIXELS,
	snapPosition,
	type SnapLine,
} from "@/lib/preview/preview-snap";
import { usePreviewStore } from "@/stores/preview-store";
import { resolveElementTransformAtTime } from "@/lib/animation";
import {
	applySelectedReframePresetPreviewToTracks,
	getSelectedOrActiveReframePresetId,
	normalizeVideoReframeState,
} from "@/lib/reframe/video-reframe";
import { useReframeStore } from "@/stores/reframe-store";

const MIN_DRAG_DISTANCE = 0.5;
type DragAxisLock = "x" | "y" | null;

interface DragState {
	startX: number;
	startY: number;
	bounds: {
		width: number;
		height: number;
	};
	elements: Array<{
		trackId: string;
		elementId: string;
		initialTransform: Transform;
		reframePresetId: string | null;
	}>;
}

export function usePreviewInteraction({
	canvasRef,
}: {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
	const editor = useEditor({ subscribeTo: [] });
	const { previewFormatVariant } = usePreviewStore();
	const isShiftHeldRef = useShiftKey();
	const [isDragging, setIsDragging] = useState(false);
	const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
	const [editingText, setEditingText] = useState<{
		trackId: string;
		elementId: string;
		element: TextElement;
		originalOpacity: number;
	} | null>(null);
	const dragStateRef = useRef<DragState | null>(null);
	const wasPlayingRef = useRef(editor.playback.getIsPlaying());
	const editingTextRef = useRef(editingText);
	const dragAxisLockRef = useRef<DragAxisLock>(null);
	const axisLockSnapshotRef = useRef<{ deltaX: number; deltaY: number } | null>(
		null,
	);
	editingTextRef.current = editingText;

	const syncDragAxisLock = useCallback(
		({ deltaX, deltaY }: { deltaX: number; deltaY: number }) => {
			if (!isShiftHeldRef.current) {
				dragAxisLockRef.current = null;
				axisLockSnapshotRef.current = null;
				return null;
			}

			if (dragAxisLockRef.current === null) {
				dragAxisLockRef.current =
					Math.abs(deltaX) >= Math.abs(deltaY) ? "x" : "y";
				axisLockSnapshotRef.current = { deltaX, deltaY };
			}

			return dragAxisLockRef.current;
		},
		[isShiftHeldRef],
	);

	const commitTextEdit = useCallback(() => {
		const current = editingTextRef.current;
		if (!current) return;
		editor.timeline.previewElements({
			updates: [
				{
					trackId: current.trackId,
					elementId: current.elementId,
					updates: { opacity: current.originalOpacity },
				},
			],
		});
		editor.timeline.commitPreview();
		setEditingText(null);
	}, [editor.timeline]);

	const cancelTextEdit = useCallback(() => {
		editor.timeline.discardPreview();
		setEditingText(null);
	}, [editor.timeline]);

	useEffect(() => {
		const unsubscribe = editor.playback.subscribe(() => {
			const isPlaying = editor.playback.getIsPlaying();
			if (isPlaying && !wasPlayingRef.current && editingTextRef.current) {
				commitTextEdit();
			}
			wasPlayingRef.current = isPlaying;
		});
		return unsubscribe;
	}, [editor.playback, commitTextEdit]);

	const handleDoubleClick = useCallback(
		({ clientX, clientY }: React.MouseEvent) => {
			if (!canvasRef.current || editingText) return;

			const tracks = editor.timeline.getTracks();
			const currentTime = editor.playback.getCurrentTime();
			const mediaAssets = editor.media.getAssets();
			const projectCanvas = editor.project.getActive().settings.canvasSize;
			const canvasSize = getPreviewCanvasSize({
				projectWidth: projectCanvas.width,
				projectHeight: projectCanvas.height,
				previewFormatVariant,
			});
			const previewTracks =
				previewFormatVariant === "square"
					? remapCaptionTransformsForPreviewVariant({
							tracks,
							sourceCanvas: projectCanvas,
							previewCanvas: canvasSize,
						})
					: tracks;
			const previewTracksWithSelectedReframe =
				applySelectedReframePresetPreviewToTracks({
					tracks: previewTracks,
					selectedPresetIdByElementId:
						useReframeStore.getState().selectedPresetIdByElementId,
					selectedSplitPreviewByElementId:
						useReframeStore.getState().selectedSplitPreviewByElementId,
					selectedElementIds: new Set(
						editor.selection
							.getSelectedElements()
							.map((selection) => selection.elementId),
					),
				});

			const startPos = screenToCanvas({
				clientX,
				clientY,
				canvas: canvasRef.current,
			});

			const elementsWithBounds = getVisibleElementsWithBounds({
				tracks: previewTracksWithSelectedReframe,
				currentTime,
				canvasSize,
				backgroundReferenceCanvasSize: projectCanvas,
				mediaAssets,
			});

			const hit = hitTest({
				canvasX: startPos.x,
				canvasY: startPos.y,
				elementsWithBounds,
			});

			if (!hit || hit.element.type !== "text") return;

			const textElement = hit.element as TextElement;
			editor.timeline.previewElements({
				updates: [
					{
						trackId: hit.trackId,
						elementId: hit.elementId,
						updates: { opacity: 0 },
					},
				],
			});
			setEditingText({
				trackId: hit.trackId,
				elementId: hit.elementId,
				element: textElement,
				originalOpacity: textElement.opacity,
			});
		},
		[canvasRef, editor, editingText, previewFormatVariant],
	);

	const handlePointerDown = useCallback(
		({
			clientX,
			clientY,
			currentTarget,
			pointerId,
			button,
		}: React.PointerEvent) => {
			if (!canvasRef.current) return;
			if (editingText) return;
			if (button !== 0) return;

			const tracks = editor.timeline.getTracks();
			const currentTime = editor.playback.getCurrentTime();
			const mediaAssets = editor.media.getAssets();
			const projectCanvas = editor.project.getActive().settings.canvasSize;
			const canvasSize = getPreviewCanvasSize({
				projectWidth: projectCanvas.width,
				projectHeight: projectCanvas.height,
				previewFormatVariant,
			});
			const previewTracks =
				previewFormatVariant === "square"
					? remapCaptionTransformsForPreviewVariant({
							tracks,
							sourceCanvas: projectCanvas,
							previewCanvas: canvasSize,
						})
					: tracks;
			const previewTracksWithSelectedReframe =
				applySelectedReframePresetPreviewToTracks({
					tracks: previewTracks,
					selectedPresetIdByElementId:
						useReframeStore.getState().selectedPresetIdByElementId,
					selectedSplitPreviewByElementId:
						useReframeStore.getState().selectedSplitPreviewByElementId,
					selectedElementIds: new Set(
						editor.selection
							.getSelectedElements()
							.map((selection) => selection.elementId),
					),
				});

			const startPos = screenToCanvas({
				clientX,
				clientY,
				canvas: canvasRef.current,
			});

			const elementsWithBounds = getVisibleElementsWithBounds({
				tracks: previewTracksWithSelectedReframe,
				currentTime,
				canvasSize,
				backgroundReferenceCanvasSize: projectCanvas,
				mediaAssets,
			});

			const hit = hitTest({
				canvasX: startPos.x,
				canvasY: startPos.y,
				elementsWithBounds,
			});

			if (!hit) {
				editor.selection.clearSelection();
				return;
			}

			editor.selection.setSelectedElements({
				elements: [{ trackId: hit.trackId, elementId: hit.elementId }],
			});

			const elementsWithTracks = editor.timeline.getElementsWithTracks({
				elements: [{ trackId: hit.trackId, elementId: hit.elementId }],
			});

			const draggableElements = elementsWithTracks.filter(({ element }) =>
				isVisualElement(element),
			);

			if (draggableElements.length === 0) return;

			dragStateRef.current = {
				startX: startPos.x,
				startY: startPos.y,
				bounds: {
					width: hit.bounds.width,
					height: hit.bounds.height,
				},
				elements: draggableElements.map(({ track, element }) => {
					const normalizedElement =
						element.type === "video"
							? normalizeVideoReframeState({ element })
							: element;
					const reframePresetId =
						normalizedElement.type === "video"
							? getSelectedOrActiveReframePresetId({
									element: normalizedElement,
									localTime: Math.max(
										0,
										Math.min(
											normalizedElement.duration,
											currentTime - normalizedElement.startTime,
										),
									),
									selectedPresetId:
										useReframeStore.getState().selectedPresetIdByElementId[
											normalizedElement.id
										] ?? null,
								})
							: null;
					return {
						trackId: track.id,
						elementId: element.id,
						initialTransform: resolveElementTransformAtTime({
							element: normalizedElement as never,
							localTime: Math.max(0, currentTime - normalizedElement.startTime),
							baseTransformLocalTime: Math.max(
								0,
								Math.min(
									normalizedElement.duration,
									currentTime - normalizedElement.startTime,
								),
							),
						}),
						reframePresetId,
					};
				}),
			};
			dragAxisLockRef.current = null;
			axisLockSnapshotRef.current = null;

			setIsDragging(true);
			currentTarget.setPointerCapture(pointerId);
		},
		[editor, canvasRef, editingText, previewFormatVariant],
	);

	const handlePointerMove = useCallback(
		({ clientX, clientY }: React.PointerEvent) => {
			if (!dragStateRef.current || !isDragging || !canvasRef.current) return;

			const projectCanvas = editor.project.getActive().settings.canvasSize;
			const canvasSize = getPreviewCanvasSize({
				projectWidth: projectCanvas.width,
				projectHeight: projectCanvas.height,
				previewFormatVariant,
			});

			const currentPos = screenToCanvas({
				clientX,
				clientY,
				canvas: canvasRef.current,
			});

			const deltaX = currentPos.x - dragStateRef.current.startX;
			const deltaY = currentPos.y - dragStateRef.current.startY;
			const dragAxisLock = syncDragAxisLock({ deltaX, deltaY });
			const axisLockSnapshot = axisLockSnapshotRef.current;
			const constrainedDeltaX =
				dragAxisLock === "y" ? (axisLockSnapshot?.deltaX ?? 0) : deltaX;
			const constrainedDeltaY =
				dragAxisLock === "x" ? (axisLockSnapshot?.deltaY ?? 0) : deltaY;
			const hasMovement =
				Math.abs(constrainedDeltaX) > MIN_DRAG_DISTANCE ||
				Math.abs(constrainedDeltaY) > MIN_DRAG_DISTANCE;
			if (!hasMovement) {
				setSnapLines([]);
				return;
			}

			const firstElement = dragStateRef.current.elements[0];
			const proposedPosition = {
				x: firstElement.initialTransform.position.x + constrainedDeltaX,
				y: firstElement.initialTransform.position.y + constrainedDeltaY,
			};

			const shouldSnap = !isShiftHeldRef.current;
			const snapThreshold = screenPixelsToLogicalThreshold({
				canvas: canvasRef.current,
				screenPixels: SNAP_THRESHOLD_SCREEN_PIXELS,
			});
			const { snappedPosition, activeLines } = shouldSnap
				? snapPosition({
						proposedPosition,
						canvasSize,
						elementSize: dragStateRef.current.bounds,
						snapThreshold,
					})
				: {
						snappedPosition: proposedPosition,
						activeLines: [] as SnapLine[],
					};

			setSnapLines(activeLines);

			const deltaSnappedX =
				snappedPosition.x - firstElement.initialTransform.position.x;
			const deltaSnappedY =
				snappedPosition.y - firstElement.initialTransform.position.y;

			const standardUpdates = dragStateRef.current.elements
				.filter((entry) => !entry.reframePresetId)
				.map(({ trackId, elementId, initialTransform }) => ({
					trackId,
					elementId,
					updates: {
						transform: {
							...initialTransform,
							position: {
								x: initialTransform.position.x + deltaSnappedX,
								y: initialTransform.position.y + deltaSnappedY,
							},
						},
					},
				}));

			for (const entry of dragStateRef.current.elements) {
				if (!entry.reframePresetId) continue;
				editor.timeline.updateVideoReframePreset({
					trackId: entry.trackId,
					elementId: entry.elementId,
					presetId: entry.reframePresetId,
					updates: {
						transform: {
							position: {
								x: entry.initialTransform.position.x + deltaSnappedX,
								y: entry.initialTransform.position.y + deltaSnappedY,
							},
							scale: entry.initialTransform.scale,
						},
					},
					pushHistory: false,
				});
			}
			if (standardUpdates.length > 0) {
				editor.timeline.previewElements({ updates: standardUpdates });
			}
		},
		[
			isDragging,
			canvasRef,
			editor,
			isShiftHeldRef,
			previewFormatVariant,
			syncDragAxisLock,
		],
	);

	const handlePointerUp = useCallback(
		({ clientX, clientY, currentTarget, pointerId }: React.PointerEvent) => {
			if (!dragStateRef.current || !isDragging || !canvasRef.current) return;

			const currentPos = screenToCanvas({
				clientX,
				clientY,
				canvas: canvasRef.current,
			});

			const deltaX = currentPos.x - dragStateRef.current.startX;
			const deltaY = currentPos.y - dragStateRef.current.startY;
			const dragAxisLock = syncDragAxisLock({ deltaX, deltaY });
			const axisLockSnapshot = axisLockSnapshotRef.current;
			const constrainedDeltaX =
				dragAxisLock === "y" ? (axisLockSnapshot?.deltaX ?? 0) : deltaX;
			const constrainedDeltaY =
				dragAxisLock === "x" ? (axisLockSnapshot?.deltaY ?? 0) : deltaY;

			const hasMovement =
				Math.abs(constrainedDeltaX) > MIN_DRAG_DISTANCE ||
				Math.abs(constrainedDeltaY) > MIN_DRAG_DISTANCE;

			if (!hasMovement) {
				editor.timeline.discardPreview();
			} else {
				editor.timeline.commitPreview();
			}

			dragStateRef.current = null;
			dragAxisLockRef.current = null;
			axisLockSnapshotRef.current = null;
			setIsDragging(false);
			setSnapLines([]);
			currentTarget.releasePointerCapture(pointerId);
		},
		[isDragging, canvasRef, editor, syncDragAxisLock],
	);

	return {
		onPointerDown: handlePointerDown,
		onPointerMove: handlePointerMove,
		onPointerUp: handlePointerUp,
		onDoubleClick: handleDoubleClick,
		snapLines,
		editingText,
		commitTextEdit,
		cancelTextEdit,
	};
}
