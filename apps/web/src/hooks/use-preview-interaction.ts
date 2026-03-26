import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useShiftKey } from "@/hooks/use-shift-key";
import type {
	TextElement,
	Transform,
	VideoElement,
	VideoReframeTransformAdjustment,
} from "@/types/timeline";
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
	getEffectiveVideoSplitScreenSlotTransformOverride,
	isVideoSplitScreenExternalSourceSlot,
	getSelectedOrActiveReframePresetId,
	normalizeVideoReframeState,
	resolveVideoSplitScreenSlotTransformFromState,
} from "@/lib/reframe/video-reframe";
import {
	buildSplitScreenUpdates,
	getEditableSplitSlotIdAtCanvasPoint,
	getEditableSplitSlotRegions,
	getSplitSlotViewportBounds,
	resolveEditableSplitSlotState,
	updateSplitSlotBindingsWithTransform,
} from "@/lib/reframe/split-slot-edit";
import {
	ENABLE_MANUAL_REFRAME_PRESET_ADJUSTMENTS,
	ENABLE_MANUAL_SPLIT_SLOT_ADJUSTMENTS,
} from "@/lib/reframe/split-slot-config";
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
				initialReframeTransformAdjustment?: VideoReframeTransformAdjustment | null;
		  }>
		| [];
	splitSlot?: {
		trackId: string;
		elementId: string;
		slotId: string;
		initialTransform: Transform;
	};
}

type SplitInteractionState = {
	trackId: string;
	elementId: string;
	canvasSize: { width: number; height: number };
	regions: Array<{
		slotId: string;
		bounds: {
			cx: number;
			cy: number;
			width: number;
			height: number;
			rotation: number;
		};
	}>;
	activeSlotId: string | null;
};

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
	const playbackTimeRef = useRef(editor.playback.getCurrentTime());
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
	const selectedSplitPreviewByElementId = useReframeStore(
		(state) => state.selectedSplitPreviewByElementId,
	);
	const selectedSplitEditSlotIdByElementId = useReframeStore(
		(state) => state.selectedSplitEditSlotIdByElementId,
	);
	const hoveredSplitSlot = useReframeStore((state) => state.hoveredSplitSlot);
	const hoveredSplitControlSlot = useReframeStore(
		(state) => state.hoveredSplitControlSlot,
	);
	const clearSelectedSplitEditSlotId = useReframeStore(
		(state) => state.clearSelectedSplitEditSlotId,
	);
	const clearAllSelectedSplitEditSlotIds = useReframeStore(
		(state) => state.clearAllSelectedSplitEditSlotIds,
	);
	const setSelectedSplitEditSlotId = useReframeStore(
		(state) => state.setSelectedSplitEditSlotId,
	);
	const setHoveredSplitSlot = useReframeStore(
		(state) => state.setHoveredSplitSlot,
	);
	const clearHoveredSplitSlotState = useReframeStore(
		(state) => state.clearHoveredSplitSlot,
	);
	const [hoverSplitInteraction, setHoverSplitInteraction] =
		useState<SplitInteractionState | null>(null);

	const clearHoveredSplitSlot = useCallback(() => {
		clearHoveredSplitSlotState();
		setHoverSplitInteraction(null);
	}, [clearHoveredSplitSlotState]);

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

	const getPreviewElementsWithBounds = useCallback(() => {
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
		return {
			canvasSize,
			elementsWithBounds: getVisibleElementsWithBounds({
				tracks: previewTracksWithSelectedReframe,
				currentTime,
				canvasSize,
				backgroundReferenceCanvasSize: projectCanvas,
				mediaAssets,
			}),
		};
	}, [
		editor.media,
		editor.playback,
		editor.project,
		editor.selection,
		editor.timeline,
		previewFormatVariant,
	]);

	const resolveSplitInteractionForVideo = useCallback(
		({
			trackId,
			element,
		}: {
			trackId: string;
			element: VideoElement;
		}): SplitInteractionState | null => {
			if (!ENABLE_MANUAL_SPLIT_SLOT_ADJUSTMENTS) return null;
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
				splitPreview:
					selectedSplitPreviewByElementId[normalizedElement.id] ?? null,
				preferredSlotId:
					selectedSplitEditSlotIdByElementId[normalizedElement.id] ?? null,
			});
			if (!editableSplitState) return null;
			return {
				trackId,
				elementId: normalizedElement.id,
				canvasSize,
				regions: getEditableSplitSlotRegions({
					editableState: editableSplitState,
					canvasWidth: canvasSize.width,
					canvasHeight: canvasSize.height,
				}),
				activeSlotId:
					selectedSplitEditSlotIdByElementId[normalizedElement.id] ??
					editableSplitState.singleViewSlotId,
			};
		},
		[
			editor.project,
			getLocalTimeForElement,
			previewFormatVariant,
			selectedSplitEditSlotIdByElementId,
			selectedSplitPreviewByElementId,
		],
	);

	const selectedSplitInteraction = useMemo(() => {
		const selectedElement = editor.selection.getSelectedElements()[0] ?? null;
		if (!selectedElement) return null;
		const track = editor.timeline.getTrackById({
			trackId: selectedElement.trackId,
		});
		const element =
			track?.type === "video"
				? (track.elements.find(
						(candidate) =>
							candidate.type === "video" &&
							candidate.id === selectedElement.elementId,
					) ?? null)
				: null;
		if (!element || element.type !== "video") return null;
		return resolveSplitInteractionForVideo({
			trackId: selectedElement.trackId,
			element,
		});
	}, [editor, resolveSplitInteractionForVideo]);
	const selectedSplitSlotId = selectedSplitInteraction
		? (selectedSplitEditSlotIdByElementId[selectedSplitInteraction.elementId] ??
			null)
		: null;

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
			const currentPreviewState =
				useReframeStore.getState().selectedSplitPreviewByElementId[
					element.id
				] ?? null;
			const editableSplitState = resolveEditableSplitSlotState({
				element,
				localTime: getLocalTimeForElement({ element }),
				splitPreview: currentPreviewState,
			});
			if (!editableSplitState) return;
			const activeBinding =
				editableSplitState.slots.find((binding) => binding.slotId === slotId) ??
				null;
			const sourceElementId =
				isVideoSplitScreenExternalSourceSlot({ slot: activeBinding ?? {} })
					? (activeBinding?.sourceElementId?.trim() ?? "")
					: "";
			const sourceElement =
				sourceElementId.length > 0
					? editor.timeline
							.getTracks()
							.flatMap((track) => track.elements)
							.find(
								(candidate) =>
									(candidate.type === "video" || candidate.type === "image") &&
									candidate.id === sourceElementId,
							) ?? null
					: null;
			const mediaAsset =
				editor.media
					.getAssets()
					.find(
						(asset) =>
							asset.id ===
							(sourceElement?.type === "video" || sourceElement?.type === "image"
								? sourceElement.mediaId
								: element.mediaId),
					) ?? null;
			if (
				(mediaAsset?.type !== "video" && mediaAsset?.type !== "image") ||
				!Number.isFinite(mediaAsset.width) ||
				!Number.isFinite(mediaAsset.height)
			) {
				return;
			}
			const sourceWidth = mediaAsset.width as number;
			const sourceHeight = mediaAsset.height as number;
			const projectCanvas = editor.project.getActive().settings.canvasSize;
			const localTime = getLocalTimeForElement({ element });
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
			editor.timeline,
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
			const currentTime = editor.playback.getCurrentTime();
			if (
				!dragStateRef.current &&
				Math.abs(currentTime - playbackTimeRef.current) > 1e-6
			) {
				clearAllSelectedSplitEditSlotIds();
				clearHoveredSplitSlotState();
				setHoverSplitInteraction(null);
			}
			playbackTimeRef.current = currentTime;
			if (isPlaying && !wasPlayingRef.current && editingTextRef.current) {
				commitTextEdit();
			}
			wasPlayingRef.current = isPlaying;
		});
		return unsubscribe;
	}, [
		clearAllSelectedSplitEditSlotIds,
		clearHoveredSplitSlotState,
		commitTextEdit,
		editor.playback,
	]);

	const handleDoubleClick = useCallback(
		({ clientX, clientY }: React.MouseEvent) => {
			if (!canvasRef.current || editingText) return;

			const { elementsWithBounds } = getPreviewElementsWithBounds();

			const startPos = screenToCanvas({
				clientX,
				clientY,
				canvas: canvasRef.current,
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
		[canvasRef, editor, editingText, getPreviewElementsWithBounds],
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

			const { canvasSize, elementsWithBounds } = getPreviewElementsWithBounds();

			const startPos = screenToCanvas({
				clientX,
				clientY,
				canvas: canvasRef.current,
			});

			const hit = hitTest({
				canvasX: startPos.x,
				canvasY: startPos.y,
				elementsWithBounds: elementsWithBounds.filter(
					(entry) => !isGeneratedCaptionElement(entry.element),
				),
			});

			if (!hit) {
				editor.selection.clearSelection();
				return;
			}

			if (isGeneratedCaptionElement(hit.element)) {
				return;
			}

			editor.selection.setSelectedElements({
				elements: [{ trackId: hit.trackId, elementId: hit.elementId }],
			});

			const splitEditSlotId =
				ENABLE_MANUAL_SPLIT_SLOT_ADJUSTMENTS &&
				hit.element.type === "video"
					? (useReframeStore.getState().selectedSplitEditSlotIdByElementId[
							hit.element.id
						] ?? null)
					: null;
			if (
				ENABLE_MANUAL_SPLIT_SLOT_ADJUSTMENTS &&
				hit.element.type === "video"
			) {
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
					preferredSlotId: splitEditSlotId,
				});
				const slotIdAtPoint = editableSplitState
					? getEditableSplitSlotIdAtCanvasPoint({
							editableState: editableSplitState,
							canvasWidth: canvasSize.width,
							canvasHeight: canvasSize.height,
							canvasX: startPos.x,
							canvasY: startPos.y,
						})
					: null;
				if (slotIdAtPoint) {
					setSelectedSplitEditSlotId({
						elementId: normalizedElement.id,
						slotId: slotIdAtPoint,
					});
				}
				const activeSlotId = slotIdAtPoint ?? splitEditSlotId;
				if (!activeSlotId) {
					if (!slotIdAtPoint) {
						clearSelectedSplitEditSlotId({ elementId: normalizedElement.id });
					}
					return;
				}
				const activeBinding =
					editableSplitState?.slots.find(
						(binding) => binding.slotId === activeSlotId,
					) ?? null;
				const sourceElementId =
					activeBinding &&
					isVideoSplitScreenExternalSourceSlot({ slot: activeBinding })
						? (activeBinding.sourceElementId?.trim() ?? "")
						: "";
				const sourceElement =
					sourceElementId.length > 0
						? editor.timeline
								.getTracks()
								.flatMap((candidateTrack) => candidateTrack.elements)
								.find(
									(candidate) =>
										(candidate.type === "video" ||
											candidate.type === "image") &&
										candidate.id === sourceElementId,
								) ?? null
						: null;
				const mediaAsset =
					editor.media
						.getAssets()
						.find(
							(asset) =>
								asset.id ===
								(sourceElement?.type === "video" ||
								sourceElement?.type === "image"
									? sourceElement.mediaId
									: normalizedElement.mediaId),
						) ?? null;
				if (
					editableSplitState &&
					activeBinding &&
					(mediaAsset?.type === "video" || mediaAsset?.type === "image") &&
					Number.isFinite(mediaAsset.width) &&
					Number.isFinite(mediaAsset.height)
				) {
					const sourceWidth = mediaAsset.width as number;
					const sourceHeight = mediaAsset.height as number;
					if (activeSlotId && slotIdAtPoint === activeSlotId) {
						const initialTransform =
							isVideoSplitScreenExternalSourceSlot({ slot: activeBinding })
								? {
										position:
									getEffectiveVideoSplitScreenSlotTransformOverride({
												slot: activeBinding,
												viewportBalance:
													editableSplitState.viewportBalance,
											})?.position ?? { x: 0, y: 0 },
										scale:
											getEffectiveVideoSplitScreenSlotTransformOverride({
												slot: activeBinding,
												viewportBalance:
													editableSplitState.viewportBalance,
											})?.scale ?? 1,
										rotate: 0,
								  }
								: resolveVideoSplitScreenSlotTransformFromState({
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
						const viewportBounds =
							getEditableSplitSlotRegions({
								editableState: editableSplitState,
								canvasWidth: canvasSize.width,
								canvasHeight: canvasSize.height,
							}).find((region) => region.slotId === activeSlotId)?.bounds ??
							getSplitSlotViewportBounds({
								layoutPreset: editableSplitState.layoutPreset,
								viewportBalance: editableSplitState.viewportBalance,
								slotId: activeSlotId,
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
								slotId: activeSlotId,
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
			const currentTime = editor.playback.getCurrentTime();

			const dragEntries = draggableElements.flatMap(({ track, element }) => {
				const normalizedElement =
					element.type === "video"
						? normalizeVideoReframeState({ element })
						: element;
				const resolvedReframePresetId =
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
				if (
					resolvedReframePresetId &&
					!ENABLE_MANUAL_REFRAME_PRESET_ADJUSTMENTS
				) {
					return [];
				}
				return [
					{
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
						reframePresetId:
							ENABLE_MANUAL_REFRAME_PRESET_ADJUSTMENTS
								? resolvedReframePresetId
								: null,
						initialReframeTransformAdjustment:
							ENABLE_MANUAL_REFRAME_PRESET_ADJUSTMENTS &&
							resolvedReframePresetId &&
							normalizedElement.type === "video"
								? (normalizedElement.reframePresets?.find(
										(preset) => preset.id === resolvedReframePresetId,
								  )?.transformAdjustment ?? null)
								: null,
					},
				];
			});
			if (dragEntries.length === 0) return;
			dragStateRef.current = {
				startX: startPos.x,
				startY: startPos.y,
				mode: "element",
				bounds: {
					width: hit.bounds.width,
					height: hit.bounds.height,
				},
				elements: dragEntries,
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
			getPreviewElementsWithBounds,
			setSelectedSplitEditSlotId,
		],
	);

	const handlePointerMove = useCallback(
		({ clientX, clientY }: React.PointerEvent) => {
			if (canvasRef.current && !dragStateRef.current) {
				const position = screenToCanvas({
					clientX,
					clientY,
					canvas: canvasRef.current,
				});
				const { elementsWithBounds } = getPreviewElementsWithBounds();
				const hit = hitTest({
					canvasX: position.x,
					canvasY: position.y,
					elementsWithBounds: elementsWithBounds.filter(
						(entry) => entry.element.type === "video",
					),
				});
				const hoveredInteraction =
					hit && hit.element.type === "video"
						? resolveSplitInteractionForVideo({
								trackId: hit.trackId,
								element: hit.element,
							})
						: null;
				setHoverSplitInteraction(hoveredInteraction);
				const hoveredRegion =
					hoveredInteraction?.regions.find(
						(region) =>
							position.x >= region.bounds.cx - region.bounds.width / 2 &&
							position.x <= region.bounds.cx + region.bounds.width / 2 &&
							position.y >= region.bounds.cy - region.bounds.height / 2 &&
							position.y <= region.bounds.cy + region.bounds.height / 2,
					) ?? null;
				const nextSlotId = hoveredRegion?.slotId ?? null;
				if (nextSlotId && hoveredInteraction) {
					setHoveredSplitSlot({
						elementId: hoveredInteraction.elementId,
						slotId: nextSlotId,
					});
				} else {
					clearHoveredSplitSlotState();
				}
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
				if (
					!entry.reframePresetId ||
					!ENABLE_MANUAL_REFRAME_PRESET_ADJUSTMENTS
				) {
					continue;
				}
				editor.timeline.updateVideoReframePreset({
					trackId: entry.trackId,
					elementId: entry.elementId,
					presetId: entry.reframePresetId,
					updates: {
						transformAdjustment: {
							positionOffset: {
								x:
									(entry.initialReframeTransformAdjustment?.positionOffset.x ??
										0) + deltaSnappedX,
								y:
									(entry.initialReframeTransformAdjustment?.positionOffset.y ??
										0) + deltaSnappedY,
							},
							scaleMultiplier:
								entry.initialReframeTransformAdjustment?.scaleMultiplier ?? 1,
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
			clearHoveredSplitSlotState,
			editor,
			getPreviewElementsWithBounds,
			isShiftHeldRef,
			previewFormatVariant,
			resolveSplitInteractionForVideo,
			setHoveredSplitSlot,
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

	useEffect(() => {
		if (selectedSplitInteraction) return;
		clearHoveredSplitSlotState();
		setHoverSplitInteraction(null);
	}, [clearHoveredSplitSlotState, selectedSplitInteraction]);

	const hoveredSplitSlotId =
		hoveredSplitSlot &&
		(hoverSplitInteraction?.elementId === hoveredSplitSlot.elementId ||
			selectedSplitInteraction?.elementId === hoveredSplitSlot.elementId)
			? hoveredSplitSlot.slotId
			: null;
	const activeSplitControlSlotId =
		hoveredSplitControlSlot &&
		selectedSplitInteraction?.elementId === hoveredSplitControlSlot.elementId
			? hoveredSplitControlSlot.slotId
			: null;
	const splitSlotRegions =
		hoverSplitInteraction?.regions ??
		(selectedSplitSlotId || activeSplitControlSlotId || isDragging
			? (selectedSplitInteraction?.regions ?? [])
			: []);

	return {
		onPointerDown: handlePointerDown,
		onPointerMove: handlePointerMove,
		onPointerUp: handlePointerUp,
		onDoubleClick: handleDoubleClick,
		onPointerLeave: clearHoveredSplitSlot,
		onPointerCancel: clearHoveredSplitSlot,
		snapLines,
		hoveredSplitSlotId,
		selectedSplitSlotId,
		splitSlotRegions,
		activeSplitSlotId:
			hoveredSplitSlotId ??
			activeSplitControlSlotId ??
			(isDragging
				? (selectedSplitInteraction?.activeSlotId ??
					hoverSplitInteraction?.activeSlotId ??
					null)
				: null),
		editingText,
		commitTextEdit,
		cancelTextEdit,
	};
}
