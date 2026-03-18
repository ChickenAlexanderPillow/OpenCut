import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useShiftKey } from "@/hooks/use-shift-key";
import type { TextElement, Transform, VideoElement } from "@/types/timeline";
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
import { isGeneratedCaptionElement } from "@/lib/captions/caption-track";
import {
	applySelectedReframePresetPreviewToTracks,
	getSelectedOrActiveReframePresetId,
	normalizeVideoReframeState,
	resolveVideoSplitScreenSlotTransformFromState,
} from "@/lib/reframe/video-reframe";
import {
	buildSplitScreenUpdates,
	getSplitSlotIdAtCanvasPoint,
	getSplitSlotViewportBounds,
	resolveEditableSplitSlotState,
	updateSplitSlotBindingsWithTransform,
} from "@/lib/reframe/split-slot-edit";
import { useReframeStore } from "@/stores/reframe-store";

const MIN_DRAG_DISTANCE = 0.5;
type DragAxisLock = "x" | "y" | null;

interface DragState {
	startX: number;
	startY: number;
	mode: "element" | "split-slot";
	bounds: {
		width: number;
		height: number;
	};
	elements:
		| Array<{
				trackId: string;
				elementId: string;
				initialTransform: Transform;
				reframePresetId: string | null;
		  }>
		| [];
	splitSlot?: {
		trackId: string;
		elementId: string;
		slotId: string;
		initialTransform: Transform;
	};
}

export function usePreviewInteraction({
	canvasRef,
}: {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
	const editor = useEditor({
		subscribeTo: ["timeline", "media", "project", "playback", "selection"],
	});
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

	const setSelectedSplitPreviewSlots = useReframeStore(
		(state) => state.setSelectedSplitPreviewSlots,
	);
	const setSelectedSplitEditSlotId = useReframeStore(
		(state) => state.setSelectedSplitEditSlotId,
	);
	const selectedSplitPreviewByElementId = useReframeStore(
		(state) => state.selectedSplitPreviewByElementId,
	);
	const selectedSplitEditSlotIdByElementId = useReframeStore(
		(state) => state.selectedSplitEditSlotIdByElementId,
	);
	const clearSelectedSplitEditSlotId = useReframeStore(
		(state) => state.clearSelectedSplitEditSlotId,
	);
	const [hoveredSplitSlotId, setHoveredSplitSlotId] = useState<string | null>(
		null,
	);

	const getLocalTimeForElement = useCallback(
		({ element }: { element: { startTime: number; duration: number } }) =>
			Math.max(
				0,
				Math.min(
					element.duration,
					editor.playback.getCurrentTime() - element.startTime,
				),
			),
		[editor.playback],
	);

	const selectedSplitInteraction = useMemo(() => {
		const selectedElement = editor.selection.getSelectedElements()[0] ?? null;
		if (!selectedElement) return null;
		const track = editor.timeline.getTrackById({ trackId: selectedElement.trackId });
		const element =
			track?.type === "video"
				? (track.elements.find(
						(candidate) =>
							candidate.type === "video" &&
							candidate.id === selectedElement.elementId,
					) ?? null)
				: null;
		if (!element || element.type !== "video") return null;
		const normalizedElement = normalizeVideoReframeState({ element });
		const projectCanvas = editor.project.getActive().settings.canvasSize;
		const canvasSize = getPreviewCanvasSize({
			projectWidth: projectCanvas.width,
			projectHeight: projectCanvas.height,
			previewFormatVariant,
		});
		const localTime = getLocalTimeForElement({ element: normalizedElement });
		const editableSplitState = resolveEditableSplitSlotState({
			element: normalizedElement,
			localTime,
			splitPreview: selectedSplitPreviewByElementId[normalizedElement.id] ?? null,
		});
		if (!editableSplitState) return null;
		const regions = editableSplitState.slots
			.map((slot) => {
				const bounds = getSplitSlotViewportBounds({
					layoutPreset: editableSplitState.layoutPreset,
					viewportBalance: editableSplitState.viewportBalance,
					slotId: slot.slotId,
					canvasWidth: canvasSize.width,
					canvasHeight: canvasSize.height,
				});
				return bounds ? { slotId: slot.slotId, bounds } : null;
			})
			.filter(
				(region): region is { slotId: string; bounds: NonNullable<typeof region>["bounds"] } =>
					Boolean(region),
			);
		return {
			trackId: selectedElement.trackId,
			elementId: normalizedElement.id,
			canvasSize,
			regions,
			activeSlotId:
				selectedSplitEditSlotIdByElementId[normalizedElement.id] ?? null,
		};
	}, [
		editor,
		getLocalTimeForElement,
		previewFormatVariant,
		selectedSplitEditSlotIdByElementId,
		selectedSplitPreviewByElementId,
	]);

	const commitSplitSlotPreview = useCallback(
		({ trackId, elementId }: { trackId: string; elementId: string }) => {
			const track = editor.timeline.getTrackById({ trackId });
			const element =
				track?.type === "video"
					? (track.elements.find(
							(candidate) =>
								candidate.type === "video" && candidate.id === elementId,
						) ?? null)
					: null;
			if (!element || element.type !== "video") return;
			const normalizedElement = normalizeVideoReframeState({ element });
			const previewState =
				useReframeStore.getState().selectedSplitPreviewByElementId[elementId] ??
				null;
			if (!previewState?.slots?.length) return;
			editor.timeline.updateVideoSplitScreen({
				trackId,
				elementId,
				updates: buildSplitScreenUpdates({
					element: normalizedElement,
					slots: previewState.slots,
					viewportBalance:
						previewState.viewportBalance ??
						normalizedElement.splitScreen?.viewportBalance ??
						"balanced",
				}),
			});
		},
		[editor.timeline],
	);

	const updateSplitSlotPreviewTransform = useCallback(
		({
			trackId,
			element,
			slotId,
			nextTransform,
		}: {
			trackId: string;
			element: VideoElement;
			slotId: string;
			nextTransform: Pick<Transform, "position" | "scale">;
		}) => {
			const mediaAsset =
				editor.media.getAssets().find((asset) => asset.id === element.mediaId) ??
				null;
			if (
				mediaAsset?.type !== "video" ||
				!Number.isFinite(mediaAsset.width) ||
				!Number.isFinite(mediaAsset.height)
			) {
				return;
			}
			const sourceWidth = mediaAsset.width as number;
			const sourceHeight = mediaAsset.height as number;
			const projectCanvas = editor.project.getActive().settings.canvasSize;
			const localTime = getLocalTimeForElement({ element });
			const currentPreviewState =
				useReframeStore.getState().selectedSplitPreviewByElementId[
					element.id
				] ?? null;
			const editableSplitState = resolveEditableSplitSlotState({
				element,
				localTime,
				splitPreview: currentPreviewState,
			});
			if (!editableSplitState) return;
			const nextSlots = updateSplitSlotBindingsWithTransform({
				bindings: editableSplitState.slots,
				slotId,
				nextTransform,
				element: editableSplitState.element,
				localTime,
				canvasWidth: projectCanvas.width,
				canvasHeight: projectCanvas.height,
				sourceWidth,
				sourceHeight,
				layoutPreset: editableSplitState.layoutPreset,
				viewportBalance: editableSplitState.viewportBalance,
			});
			setSelectedSplitPreviewSlots({
				elementId: element.id,
				slots: nextSlots,
				viewportBalance: editableSplitState.viewportBalance,
			});
			void trackId;
		},
		[
			editor.media,
			editor.project,
			getLocalTimeForElement,
			setSelectedSplitPreviewSlots,
		],
	);

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
		[
			canvasRef,
			editor,
			editingText,
			previewFormatVariant,
		],
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

			if (isGeneratedCaptionElement(hit.element)) {
				return;
			}

			const splitEditSlotId =
				hit.element.type === "video"
					? (useReframeStore.getState().selectedSplitEditSlotIdByElementId[
							hit.element.id
						] ?? null)
					: null;
			if (hit.element.type === "video" && splitEditSlotId) {
				const normalizedElement = normalizeVideoReframeState({
					element: hit.element,
				});
				const localTime = getLocalTimeForElement({
					element: normalizedElement,
				});
				const splitPreview =
					useReframeStore.getState().selectedSplitPreviewByElementId[
						normalizedElement.id
					] ?? null;
				const editableSplitState = resolveEditableSplitSlotState({
					element: normalizedElement,
					localTime,
					splitPreview,
				});
				const activeBinding =
					editableSplitState?.slots.find(
						(binding) => binding.slotId === splitEditSlotId,
					) ?? null;
				const mediaAsset =
					editor.media
						.getAssets()
						.find((asset) => asset.id === normalizedElement.mediaId) ?? null;
				if (
					editableSplitState &&
					activeBinding &&
					mediaAsset?.type === "video" &&
					Number.isFinite(mediaAsset.width) &&
					Number.isFinite(mediaAsset.height)
				) {
					const sourceWidth = mediaAsset.width as number;
					const sourceHeight = mediaAsset.height as number;
					const slotIdAtPoint = getSplitSlotIdAtCanvasPoint({
						layoutPreset: editableSplitState.layoutPreset,
						viewportBalance: editableSplitState.viewportBalance,
						canvasWidth: canvasSize.width,
						canvasHeight: canvasSize.height,
						canvasX: startPos.x,
						canvasY: startPos.y,
					});
					if (slotIdAtPoint === splitEditSlotId) {
						const initialTransform =
							resolveVideoSplitScreenSlotTransformFromState({
								baseTransform: normalizedElement.transform,
								duration: normalizedElement.duration,
								reframePresets: normalizedElement.reframePresets,
								reframeSwitches: normalizedElement.reframeSwitches,
								defaultReframePresetId:
									normalizedElement.defaultReframePresetId,
								localTime,
								slot: activeBinding,
								canvasWidth: canvasSize.width,
								canvasHeight: canvasSize.height,
								sourceWidth,
								sourceHeight,
								layoutPreset: editableSplitState.layoutPreset,
								viewportBalance: editableSplitState.viewportBalance,
							});
						const viewportBounds = getSplitSlotViewportBounds({
							layoutPreset: editableSplitState.layoutPreset,
							viewportBalance: editableSplitState.viewportBalance,
							slotId: splitEditSlotId,
							canvasWidth: canvasSize.width,
							canvasHeight: canvasSize.height,
						});
						if (!viewportBounds) {
							return;
						}
						dragStateRef.current = {
							startX: startPos.x,
							startY: startPos.y,
							mode: "split-slot",
							bounds: {
								width: viewportBounds.width,
								height: viewportBounds.height,
							},
							elements: [],
							splitSlot: {
								trackId: hit.trackId,
								elementId: hit.elementId,
								slotId: splitEditSlotId,
								initialTransform,
							},
						};
						dragAxisLockRef.current = null;
						axisLockSnapshotRef.current = null;
						setIsDragging(true);
						currentTarget.setPointerCapture(pointerId);
						return;
					}
				}
				clearSelectedSplitEditSlotId({ elementId: normalizedElement.id });
			}

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
				mode: "element",
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
		[
			canvasRef,
			clearSelectedSplitEditSlotId,
			editor,
			editingText,
			getLocalTimeForElement,
			previewFormatVariant,
		],
	);

	const handlePointerMove = useCallback(
		({ clientX, clientY }: React.PointerEvent) => {
			if (canvasRef.current && !dragStateRef.current && selectedSplitInteraction) {
				const position = screenToCanvas({
					clientX,
					clientY,
					canvas: canvasRef.current,
				});
				const hoveredRegion =
					selectedSplitInteraction.regions.find(
						(region) =>
							position.x >= region.bounds.cx - region.bounds.width / 2 &&
							position.x <= region.bounds.cx + region.bounds.width / 2 &&
							position.y >= region.bounds.cy - region.bounds.height / 2 &&
							position.y <= region.bounds.cy + region.bounds.height / 2,
					) ?? null;
				setHoveredSplitSlotId(hoveredRegion?.slotId ?? null);
			}
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

			if (dragStateRef.current.mode === "split-slot") {
				const splitSlotState = dragStateRef.current.splitSlot;
				if (!splitSlotState) return;
				const track = editor.timeline.getTrackById({
					trackId: splitSlotState.trackId,
				});
				const element =
					track?.type === "video"
						? (track.elements.find(
								(candidate) =>
									candidate.type === "video" &&
									candidate.id === splitSlotState.elementId,
							) ?? null)
						: null;
				if (!element || element.type !== "video") return;
				const normalizedElement = normalizeVideoReframeState({ element });
				updateSplitSlotPreviewTransform({
					trackId: splitSlotState.trackId,
					element: normalizedElement,
					slotId: splitSlotState.slotId,
					nextTransform: {
						position: {
							x: splitSlotState.initialTransform.position.x + constrainedDeltaX,
							y: splitSlotState.initialTransform.position.y + constrainedDeltaY,
						},
						scale: splitSlotState.initialTransform.scale,
					},
				});
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
			selectedSplitInteraction,
			syncDragAxisLock,
			updateSplitSlotPreviewTransform,
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

			if (dragStateRef.current.mode === "split-slot") {
				if (hasMovement && dragStateRef.current.splitSlot) {
					commitSplitSlotPreview({
						trackId: dragStateRef.current.splitSlot.trackId,
						elementId: dragStateRef.current.splitSlot.elementId,
					});
				}
			} else if (!hasMovement) {
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
		[canvasRef, commitSplitSlotPreview, editor, isDragging, syncDragAxisLock],
	);

	useEffect(() => {
		if (!isDragging || !canvasRef.current) return;
		const handleWindowPointerUp = (event: PointerEvent) => {
			if (!dragStateRef.current || !canvasRef.current) return;
			const currentPos = screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
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
			if (dragStateRef.current.mode === "split-slot") {
				if (hasMovement && dragStateRef.current.splitSlot) {
					commitSplitSlotPreview({
						trackId: dragStateRef.current.splitSlot.trackId,
						elementId: dragStateRef.current.splitSlot.elementId,
					});
				}
			} else if (!hasMovement) {
				editor.timeline.discardPreview();
			} else {
				editor.timeline.commitPreview();
			}
			dragStateRef.current = null;
			dragAxisLockRef.current = null;
			axisLockSnapshotRef.current = null;
			setIsDragging(false);
			setSnapLines([]);
		};
		window.addEventListener("pointerup", handleWindowPointerUp);
		return () => {
			window.removeEventListener("pointerup", handleWindowPointerUp);
		};
	}, [canvasRef, commitSplitSlotPreview, editor, isDragging, syncDragAxisLock]);

	return {
		onPointerDown: handlePointerDown,
		onPointerMove: handlePointerMove,
		onPointerUp: handlePointerUp,
		onDoubleClick: handleDoubleClick,
		snapLines,
		hoveredSplitSlotId,
		splitSlotRegions: selectedSplitInteraction?.regions ?? [],
		activeSplitSlotId: selectedSplitInteraction?.activeSlotId ?? null,
		editingText,
		commitTextEdit,
		cancelTextEdit,
	};
}
