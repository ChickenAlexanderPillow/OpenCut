import { useCallback, useRef, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useShiftKey } from "@/hooks/use-shift-key";
import { useSyncExternalStore } from "react";
import {
	getVisibleElementsWithBounds,
	type ElementWithBounds,
} from "@/lib/preview/element-bounds";
import { resolveElementTransformAtTime } from "@/lib/animation";
import {
	screenPixelsToLogicalThreshold,
	screenToCanvas,
} from "@/lib/preview/preview-coords";
import {
	getPreviewCanvasSize,
	remapCaptionTransformsForPreviewVariant,
} from "@/lib/preview/preview-format";
import {
	MIN_SCALE,
	SNAP_THRESHOLD_SCREEN_PIXELS,
	snapRotation,
	snapScale,
	type SnapLine,
} from "@/lib/preview/preview-snap";
import { isVisualElement } from "@/lib/timeline/element-utils";
import type { Transform, VideoReframeTransformAdjustment } from "@/types/timeline";
import { usePreviewStore } from "@/stores/preview-store";
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

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type HandleType = Corner | "rotation";

interface ScaleState {
	mode: "element" | "split-slot";
	trackId: string;
	elementId: string;
	initialTransform: Transform;
	reframePresetId: string | null;
	initialReframeTransformAdjustment?: VideoReframeTransformAdjustment | null;
	initialDistance: number;
	initialBoundsCx: number;
	initialBoundsCy: number;
	baseWidth: number;
	baseHeight: number;
	splitSlotId?: string;
}

interface RotationState {
	trackId: string;
	elementId: string;
	initialTransform: Transform;
	baseTransform: Transform;
	baseRotate: number;
	initialAngle: number;
	initialBoundsCx: number;
	initialBoundsCy: number;
}

const EDITOR_SUBSCRIBE_TRANSFORM_HANDLES = [
	"timeline",
	"media",
	"project",
	"playback",
] as const;

function areSnapLinesEqual({
	previousLines,
	nextLines,
}: {
	previousLines: SnapLine[];
	nextLines: SnapLine[];
}): boolean {
	if (previousLines.length !== nextLines.length) {
		return false;
	}
	for (const [index, line] of previousLines.entries()) {
		const nextLine = nextLines[index];
		if (!nextLine) {
			return false;
		}
		if (line.type !== nextLine.type || line.position !== nextLine.position) {
			return false;
		}
	}
	return true;
}

function getCornerDistance({
	bounds,
	corner,
}: {
	bounds: {
		cx: number;
		cy: number;
		width: number;
		height: number;
		rotation: number;
	};
	corner: Corner;
}): number {
	const halfW = bounds.width / 2;
	const halfH = bounds.height / 2;
	const angleRad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);

	const localX =
		corner === "top-left" || corner === "bottom-left" ? -halfW : halfW;
	const localY =
		corner === "top-left" || corner === "top-right" ? -halfH : halfH;

	const rotatedX = localX * cos - localY * sin;
	const rotatedY = localX * sin + localY * cos;
	return Math.sqrt(rotatedX * rotatedX + rotatedY * rotatedY) || 1;
}

export function useTransformHandles({
	canvasRef,
}: {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
	const editor = useEditor({
		subscribeTo: EDITOR_SUBSCRIBE_TRANSFORM_HANDLES,
	});
	const { previewFormatVariant } = usePreviewStore();
	const isShiftHeldRef = useShiftKey();
	const [activeHandle, setActiveHandle] = useState<HandleType | null>(null);
	const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
	const snapLinesRef = useRef<SnapLine[]>([]);
	const scaleStateRef = useRef<ScaleState | null>(null);
	const rotationStateRef = useRef<RotationState | null>(null);

	const selectedElements = useSyncExternalStore(
		(listener) => editor.selection.subscribe(listener),
		() => editor.selection.getSelectedElements(),
	);
	const selectedPresetIdByElementId = useReframeStore(
		(state) => state.selectedPresetIdByElementId,
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

	const tracks = editor.timeline.getTracks();
	const currentTime = editor.playback.getCurrentTime();
	const isPlaying = editor.playback.getIsPlaying();
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
			selectedPresetIdByElementId,
			selectedSplitPreviewByElementId,
			selectedElementIds: new Set(
				selectedElements.map((selection) => selection.elementId),
			),
		});
	const shouldComputeBounds = selectedElements.length === 1 && !isPlaying;

	const elementsWithBounds = shouldComputeBounds
		? getVisibleElementsWithBounds({
				tracks: previewTracksWithSelectedReframe,
				currentTime,
				canvasSize,
				backgroundReferenceCanvasSize: projectCanvas,
				mediaAssets,
			})
		: [];

	const selectedWithBounds: ElementWithBounds | null =
		selectedElements.length === 1
			? (elementsWithBounds.find(
					(entry) =>
						entry.trackId === selectedElements[0].trackId &&
						entry.elementId === selectedElements[0].elementId,
				) ?? null)
			: null;

	const hasVisualSelection =
		selectedWithBounds !== null &&
		isVisualElement(selectedWithBounds.element) &&
		!isGeneratedCaptionElement(selectedWithBounds.element);
	const selectedSplitSlotContext =
		ENABLE_MANUAL_SPLIT_SLOT_ADJUSTMENTS &&
		selectedWithBounds?.element.type === "video" &&
		selectedElements.length === 1
			? (() => {
					const normalizedElement = normalizeVideoReframeState({
						element: selectedWithBounds.element,
					});
					const slotId =
						selectedSplitEditSlotIdByElementId[normalizedElement.id] ?? null;
					if (!slotId) return null;
					const clipLocalTime = Math.max(
						0,
						currentTime - normalizedElement.startTime,
					);
					const editableSplitState = resolveEditableSplitSlotState({
						element: normalizedElement,
						localTime: clipLocalTime,
						splitPreview:
							selectedSplitPreviewByElementId[normalizedElement.id] ?? null,
						preferredSlotId: slotId,
					});
					if (!editableSplitState) return null;
					const viewportBounds =
						getEditableSplitSlotRegions({
							editableState: editableSplitState,
							canvasWidth: canvasSize.width,
							canvasHeight: canvasSize.height,
						}).find((region) => region.slotId === slotId)?.bounds ??
						getSplitSlotViewportBounds({
							layoutPreset: editableSplitState.layoutPreset,
							viewportBalance: editableSplitState.viewportBalance,
							slotId,
							canvasWidth: canvasSize.width,
							canvasHeight: canvasSize.height,
						});
					if (!viewportBounds) return null;
					const activeBinding =
						editableSplitState.slots.find((binding) => binding.slotId === slotId) ??
						null;
					const sourceElementId =
						activeBinding &&
						isVideoSplitScreenExternalSourceSlot({ slot: activeBinding })
							? (activeBinding.sourceElementId?.trim() ?? "")
							: "";
					const sourceElement =
						sourceElementId.length > 0
							? editor.timeline
									.getTracks()
									.flatMap((track) => track.elements)
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
					const visualBounds =
						activeBinding &&
						(mediaAsset?.type === "video" || mediaAsset?.type === "image") &&
						Number.isFinite(mediaAsset.width) &&
						Number.isFinite(mediaAsset.height)
							? (() => {
									const sourceWidth = mediaAsset.width as number;
									const sourceHeight = mediaAsset.height as number;
									const currentTransform =
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
													localTime: clipLocalTime,
													slot: activeBinding,
													canvasWidth: canvasSize.width,
													canvasHeight: canvasSize.height,
													sourceWidth,
													sourceHeight,
													layoutPreset: editableSplitState.layoutPreset,
													viewportBalance: editableSplitState.viewportBalance,
											  });
									const slotCoverScale = Math.max(
										viewportBounds.width / Math.max(1, sourceWidth),
										viewportBounds.height / Math.max(1, sourceHeight),
									);
									return {
										cx: canvasSize.width / 2 + currentTransform.position.x,
										cy: canvasSize.height / 2 + currentTransform.position.y,
										width: sourceWidth * slotCoverScale * currentTransform.scale,
										height:
											sourceHeight * slotCoverScale * currentTransform.scale,
										rotation: currentTransform.rotate,
									};
							  })()
							: viewportBounds;
					return {
						slotId,
						clipLocalTime,
						normalizedElement,
						editableSplitState,
						bounds: visualBounds,
						viewportBounds,
						sourceElementId,
					};
				})()
			: null;
	const selectedSplitInteractionContext =
		ENABLE_MANUAL_SPLIT_SLOT_ADJUSTMENTS &&
		selectedWithBounds?.element.type === "video" &&
		selectedElements.length === 1
			? (() => {
					const normalizedElement = normalizeVideoReframeState({
						element: selectedWithBounds.element,
					});
					const clipLocalTime = Math.max(
						0,
						currentTime - normalizedElement.startTime,
					);
					return resolveEditableSplitSlotState({
						element: normalizedElement,
						localTime: clipLocalTime,
						splitPreview:
							selectedSplitPreviewByElementId[normalizedElement.id] ?? null,
					});
				})()
			: null;
	const activeBounds =
		selectedSplitSlotContext?.bounds ?? selectedWithBounds?.bounds ?? null;

	const updateSplitSlotPreviewTransform = useCallback(
		({
			element,
			slotId,
			nextTransform,
		}: {
			element: Extract<
				ReturnType<typeof normalizeVideoReframeState>,
				{ type: "video" }
			>;
			slotId: string;
			nextTransform: Pick<Transform, "position" | "scale">;
		}) => {
			const clipLocalTime = Math.max(0, currentTime - element.startTime);
			const currentPreviewState =
				useReframeStore.getState().selectedSplitPreviewByElementId[
					element.id
				] ?? null;
			const editableSplitState = resolveEditableSplitSlotState({
				element,
				localTime: clipLocalTime,
				splitPreview: currentPreviewState,
			});
			if (!editableSplitState) return;
			const activeBinding =
				editableSplitState.slots.find((binding) => binding.slotId === slotId) ??
				null;
			const sourceElementId =
				activeBinding &&
				isVideoSplitScreenExternalSourceSlot({ slot: activeBinding })
					? (activeBinding.sourceElementId?.trim() ?? "")
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
							(sourceElement?.type === "video" ||
							sourceElement?.type === "image"
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
			const nextSlots = updateSplitSlotBindingsWithTransform({
				bindings: editableSplitState.slots,
				slotId,
				nextTransform,
				element: editableSplitState.element,
				localTime: clipLocalTime,
				canvasWidth: projectCanvas.width,
				canvasHeight: projectCanvas.height,
				sourceWidth,
				sourceHeight,
				layoutPreset: editableSplitState.layoutPreset,
				viewportBalance: editableSplitState.viewportBalance,
			});
			useReframeStore.getState().setSelectedSplitPreviewSlots({
				elementId: element.id,
				slots: nextSlots,
				viewportBalance: editableSplitState.viewportBalance,
			});
		},
		[currentTime, editor.media, editor.project, editor.timeline],
	);

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
	const splitSlotControls =
		selectedSplitSlotContext &&
		(selectedSplitEditSlotIdByElementId[
			selectedSplitSlotContext.normalizedElement.id
		] === selectedSplitSlotContext.slotId ||
			(hoveredSplitSlot?.elementId ===
				selectedSplitSlotContext.normalizedElement.id &&
				hoveredSplitSlot.slotId === selectedSplitSlotContext.slotId) ||
			(hoveredSplitControlSlot?.elementId ===
				selectedSplitSlotContext.normalizedElement.id &&
				hoveredSplitControlSlot.slotId === selectedSplitSlotContext.slotId)) &&
		(() => {
			const activeBinding =
				selectedSplitSlotContext.editableSplitState.slots.find(
					(binding) => binding.slotId === selectedSplitSlotContext.slotId,
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
							(sourceElement?.type === "video" ||
							sourceElement?.type === "image"
								? sourceElement.mediaId
								: selectedSplitSlotContext.normalizedElement.mediaId),
					) ?? null;
			if (
				!activeBinding ||
				(mediaAsset?.type !== "video" && mediaAsset?.type !== "image") ||
				!Number.isFinite(mediaAsset.width) ||
				!Number.isFinite(mediaAsset.height)
			) {
				return null;
			}
			return {
				elementId: selectedSplitSlotContext.normalizedElement.id,
				slotId: selectedSplitSlotContext.slotId,
				bounds: selectedSplitSlotContext.bounds,
				scale: isVideoSplitScreenExternalSourceSlot({ slot: activeBinding })
					? (getEffectiveVideoSplitScreenSlotTransformOverride({
							slot: activeBinding,
							viewportBalance:
								selectedSplitSlotContext.editableSplitState.viewportBalance,
					  })?.scale ?? 1)
					: resolveVideoSplitScreenSlotTransformFromState({
							baseTransform: selectedSplitSlotContext.normalizedElement.transform,
							duration: selectedSplitSlotContext.normalizedElement.duration,
							reframePresets:
								selectedSplitSlotContext.normalizedElement.reframePresets,
							reframeSwitches:
								selectedSplitSlotContext.normalizedElement.reframeSwitches,
							defaultReframePresetId:
								selectedSplitSlotContext.normalizedElement.defaultReframePresetId,
							localTime: selectedSplitSlotContext.clipLocalTime,
							slot: activeBinding,
							canvasWidth: canvasSize.width,
							canvasHeight: canvasSize.height,
							sourceWidth: mediaAsset.width as number,
							sourceHeight: mediaAsset.height as number,
							layoutPreset:
								selectedSplitSlotContext.editableSplitState.layoutPreset,
							viewportBalance:
								selectedSplitSlotContext.editableSplitState.viewportBalance,
					  }).scale,
			};
		})();

	const handleSplitSlotScaleChange = useCallback(
		({ nextScale }: { nextScale: number }) => {
			if (!selectedSplitSlotContext) return;
			const activeBinding =
				selectedSplitSlotContext.editableSplitState.slots.find(
					(binding) => binding.slotId === selectedSplitSlotContext.slotId,
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
							(sourceElement?.type === "video" ||
							sourceElement?.type === "image"
								? sourceElement.mediaId
								: selectedSplitSlotContext.normalizedElement.mediaId),
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
			const currentTransform =
				activeBinding &&
				isVideoSplitScreenExternalSourceSlot({ slot: activeBinding })
					? {
							position:
								getEffectiveVideoSplitScreenSlotTransformOverride({
									slot: activeBinding,
									viewportBalance:
										selectedSplitSlotContext.editableSplitState.viewportBalance,
								})?.position ?? { x: 0, y: 0 },
							scale:
								getEffectiveVideoSplitScreenSlotTransformOverride({
									slot: activeBinding,
									viewportBalance:
										selectedSplitSlotContext.editableSplitState.viewportBalance,
								})?.scale ?? 1,
							rotate: 0,
					  }
					: resolveVideoSplitScreenSlotTransformFromState({
							baseTransform: selectedSplitSlotContext.normalizedElement.transform,
							duration: selectedSplitSlotContext.normalizedElement.duration,
							reframePresets:
								selectedSplitSlotContext.normalizedElement.reframePresets,
							reframeSwitches:
								selectedSplitSlotContext.normalizedElement.reframeSwitches,
							defaultReframePresetId:
								selectedSplitSlotContext.normalizedElement.defaultReframePresetId,
							localTime: selectedSplitSlotContext.clipLocalTime,
							slot: activeBinding ?? {
								slotId: selectedSplitSlotContext.slotId,
								presetId: null,
							},
							canvasWidth: canvasSize.width,
							canvasHeight: canvasSize.height,
							sourceWidth,
							sourceHeight,
							layoutPreset:
								selectedSplitSlotContext.editableSplitState.layoutPreset,
							viewportBalance:
								selectedSplitSlotContext.editableSplitState.viewportBalance,
					  });
			const clampedScale = Math.max(MIN_SCALE, nextScale);
			if (activeBinding && isVideoSplitScreenExternalSourceSlot({ slot: activeBinding })) {
				updateSplitSlotPreviewTransform({
					element: selectedSplitSlotContext.normalizedElement,
					slotId: selectedSplitSlotContext.slotId,
					nextTransform: {
						position: currentTransform.position,
						scale: clampedScale,
					},
				});
				return;
			}
			const slotCoverScale = Math.max(
				1e-6,
				Math.max(
					selectedSplitSlotContext.viewportBounds.width / sourceWidth,
					selectedSplitSlotContext.viewportBounds.height / sourceHeight,
				),
			);
			const slotCenter = {
				x: selectedSplitSlotContext.viewportBounds.cx,
				y: selectedSplitSlotContext.viewportBounds.cy,
			};
			const canvasCenter = {
				x: canvasSize.width / 2,
				y: canvasSize.height / 2,
			};
			const currentSourceCenter = {
				x:
					sourceWidth / 2 +
					(slotCenter.x - canvasCenter.x - currentTransform.position.x) /
						(slotCoverScale * Math.max(MIN_SCALE, currentTransform.scale)),
				y:
					sourceHeight / 2 +
					(slotCenter.y - canvasCenter.y - currentTransform.position.y) /
						(slotCoverScale * Math.max(MIN_SCALE, currentTransform.scale)),
			};
			updateSplitSlotPreviewTransform({
				element: selectedSplitSlotContext.normalizedElement,
				slotId: selectedSplitSlotContext.slotId,
				nextTransform: {
					position: {
						x:
							slotCenter.x -
							canvasCenter.x -
							(currentSourceCenter.x - sourceWidth / 2) *
								slotCoverScale *
								clampedScale,
						y:
							slotCenter.y -
							canvasCenter.y -
							(currentSourceCenter.y - sourceHeight / 2) *
								slotCoverScale *
								clampedScale,
					},
					scale: clampedScale,
				},
			});
		},
		[
			canvasSize.height,
			canvasSize.width,
			editor.media,
			editor.timeline,
			selectedSplitSlotContext,
			updateSplitSlotPreviewTransform,
		],
	);

	const handleCornerPointerDown = useCallback(
		({ event, corner }: { event: React.PointerEvent; corner: Corner }) => {
			if (!selectedWithBounds || !activeBounds) return;
			event.stopPropagation();

			const { trackId, elementId, element } = selectedWithBounds;
			const bounds = activeBounds;
			if (!isVisualElement(element)) return;
			const normalizedVideoElement =
				element.type === "video"
					? normalizeVideoReframeState({ element })
					: null;
			const normalizedElement = normalizedVideoElement ?? element;
			const clipLocalTime = Math.max(
				0,
				currentTime - normalizedElement.startTime,
			);
			const activeReframePresetId =
				normalizedElement.type === "video"
					? getSelectedOrActiveReframePresetId({
							element: normalizedElement,
							localTime: clipLocalTime,
							selectedPresetId:
								selectedPresetIdByElementId[normalizedElement.id] ?? null,
						})
					: null;
			if (
				activeReframePresetId &&
				!ENABLE_MANUAL_REFRAME_PRESET_ADJUSTMENTS
			) {
				return;
			}
			const reframePresetId =
				ENABLE_MANUAL_REFRAME_PRESET_ADJUSTMENTS &&
				normalizedElement.type === "video"
					? activeReframePresetId
					: null;
			const activeReframePreset =
				reframePresetId && normalizedVideoElement
					? (normalizedVideoElement.reframePresets?.find(
							(preset) => preset.id === reframePresetId,
					  ) ?? null)
					: null;
			const initialTransform =
				selectedSplitSlotContext &&
				normalizedVideoElement &&
				selectedSplitSlotContext.normalizedElement.id ===
					normalizedVideoElement.id
					? (() => {
							const activeBinding =
								selectedSplitSlotContext.editableSplitState.slots.find(
									(binding) =>
										binding.slotId === selectedSplitSlotContext.slotId,
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
											.flatMap((track) => track.elements)
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
												: normalizedVideoElement.mediaId),
									) ?? null;
							if (
								!activeBinding ||
								(mediaAsset?.type !== "video" &&
									mediaAsset?.type !== "image") ||
								!Number.isFinite(mediaAsset.width) ||
								!Number.isFinite(mediaAsset.height)
							) {
								return resolveElementTransformAtTime({
									element: normalizedElement as never,
									localTime: clipLocalTime,
									baseTransformLocalTime: clipLocalTime,
								});
							}
							const sourceWidth = mediaAsset.width as number;
							const sourceHeight = mediaAsset.height as number;
							return isVideoSplitScreenExternalSourceSlot({ slot: activeBinding })
								? {
										position:
											getEffectiveVideoSplitScreenSlotTransformOverride({
												slot: activeBinding,
												viewportBalance:
													selectedSplitSlotContext.editableSplitState
														.viewportBalance,
											})?.position ?? { x: 0, y: 0 },
										scale:
											getEffectiveVideoSplitScreenSlotTransformOverride({
												slot: activeBinding,
												viewportBalance:
													selectedSplitSlotContext.editableSplitState
														.viewportBalance,
											})?.scale ?? 1,
										rotate: 0,
								  }
								: resolveVideoSplitScreenSlotTransformFromState({
										baseTransform: normalizedVideoElement.transform,
										duration: normalizedVideoElement.duration,
										reframePresets: normalizedVideoElement.reframePresets,
										reframeSwitches: normalizedVideoElement.reframeSwitches,
										defaultReframePresetId:
											normalizedVideoElement.defaultReframePresetId,
										localTime: clipLocalTime,
										slot: activeBinding,
										canvasWidth: canvasSize.width,
										canvasHeight: canvasSize.height,
										sourceWidth,
										sourceHeight,
										layoutPreset:
											selectedSplitSlotContext.editableSplitState.layoutPreset,
										viewportBalance:
											selectedSplitSlotContext.editableSplitState.viewportBalance,
								  });
						})()
					: resolveElementTransformAtTime({
							element: normalizedElement as never,
							localTime: clipLocalTime,
							baseTransformLocalTime: clipLocalTime,
						});

			const initialDistance = getCornerDistance({ bounds, corner });
			const baseWidth = bounds.width / initialTransform.scale;
			const baseHeight = bounds.height / initialTransform.scale;

			scaleStateRef.current = {
				mode: selectedSplitSlotContext ? "split-slot" : "element",
				trackId,
				elementId,
				initialTransform,
				reframePresetId,
				initialReframeTransformAdjustment:
					activeReframePreset?.transformAdjustment ?? null,
				initialDistance,
				initialBoundsCx: bounds.cx,
				initialBoundsCy: bounds.cy,
				baseWidth,
				baseHeight,
				splitSlotId: selectedSplitSlotContext?.slotId,
			};
			setActiveHandle(corner);
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		},
		[
			activeBounds,
			canvasSize.height,
			canvasSize.width,
			currentTime,
			editor.media,
			editor.timeline,
			selectedPresetIdByElementId,
			selectedSplitSlotContext,
			selectedWithBounds,
		],
	);

	const handleRotationPointerDown = useCallback(
		({ event }: { event: React.PointerEvent }) => {
			if (
				!selectedWithBounds ||
				!canvasRef.current ||
				selectedSplitSlotContext
			) {
				return;
			}
			event.stopPropagation();

			const { bounds, trackId, elementId, element } = selectedWithBounds;
			if (!isVisualElement(element)) return;
			const normalizedElement =
				element.type === "video"
					? normalizeVideoReframeState({ element })
					: element;
			const clipLocalTime = Math.max(
				0,
				currentTime - normalizedElement.startTime,
			);
			const initialTransform = resolveElementTransformAtTime({
				element: normalizedElement as never,
				localTime: clipLocalTime,
				baseTransformLocalTime: clipLocalTime,
			});

			const position = screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
				canvas: canvasRef.current,
			});
			const dx = position.x - bounds.cx;
			const dy = position.y - bounds.cy;
			const initialAngle = (Math.atan2(dy, dx) * 180) / Math.PI;

			rotationStateRef.current = {
				trackId,
				elementId,
				initialTransform,
				baseTransform: element.transform,
				baseRotate: element.transform.rotate,
				initialAngle,
				initialBoundsCx: bounds.cx,
				initialBoundsCy: bounds.cy,
			};
			setActiveHandle("rotation");
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		},
		[canvasRef, currentTime, selectedSplitSlotContext, selectedWithBounds],
	);

	const handlePointerMove = useCallback(
		({ event }: { event: React.PointerEvent }) => {
			if (!canvasRef.current) return;
			if (!scaleStateRef.current && !rotationStateRef.current) return;

			const position = screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
				canvas: canvasRef.current,
			});

			if (
				scaleStateRef.current &&
				activeHandle &&
				activeHandle !== "rotation"
			) {
				const {
					mode,
					trackId,
					elementId,
					initialTransform,
					reframePresetId,
					initialDistance,
					initialBoundsCx,
					initialBoundsCy,
					baseWidth,
					baseHeight,
					splitSlotId,
				} = scaleStateRef.current;

				const dx = position.x - initialBoundsCx;
				const dy = position.y - initialBoundsCy;
				const currentDistance = Math.sqrt(dx * dx + dy * dy) || 1;
				const scaleFactor = currentDistance / initialDistance;
				const proposedScale = Math.max(
					MIN_SCALE,
					initialTransform.scale * scaleFactor,
				);

				const canvasSize = editor.project.getActive().settings.canvasSize;
				const snapThreshold = screenPixelsToLogicalThreshold({
					canvas: canvasRef.current,
					screenPixels: SNAP_THRESHOLD_SCREEN_PIXELS,
				});
				const shouldSnap = !isShiftHeldRef.current && mode === "element";
				const { snappedScale, activeLines } = shouldSnap
					? snapScale({
							proposedScale,
							position: initialTransform.position,
							baseWidth,
							baseHeight,
							canvasSize,
							snapThreshold,
						})
					: { snappedScale: proposedScale, activeLines: [] as SnapLine[] };

				const isSameLines = areSnapLinesEqual({
					previousLines: snapLinesRef.current,
					nextLines: activeLines,
				});

				if (!isSameLines) {
					snapLinesRef.current = activeLines;
					setSnapLines(activeLines);
				}

				if (mode === "split-slot" && splitSlotId) {
					const track = editor.timeline.getTrackById({ trackId });
					const element =
						track?.type === "video"
							? (track.elements.find(
									(candidate) =>
										candidate.type === "video" && candidate.id === elementId,
								) ?? null)
							: null;
					if (!element || element.type !== "video") return;
					updateSplitSlotPreviewTransform({
						element: normalizeVideoReframeState({ element }),
						slotId: splitSlotId,
						nextTransform: {
							position: initialTransform.position,
							scale: snappedScale,
						},
					});
				} else if (
					reframePresetId &&
					ENABLE_MANUAL_REFRAME_PRESET_ADJUSTMENTS
				) {
					editor.timeline.updateVideoReframePreset({
						trackId,
						elementId,
						presetId: reframePresetId,
						updates: {
							transformAdjustment: {
								positionOffset: {
									x:
										scaleStateRef.current.initialReframeTransformAdjustment
											?.positionOffset.x ?? 0,
									y:
										scaleStateRef.current.initialReframeTransformAdjustment
											?.positionOffset.y ?? 0,
								},
								scaleMultiplier:
									(scaleStateRef.current.initialReframeTransformAdjustment
										?.scaleMultiplier ?? 1) *
									(snappedScale / Math.max(1e-6, initialTransform.scale)),
							},
						},
						pushHistory: false,
					});
				} else {
					editor.timeline.previewElements({
						updates: [
							{
								trackId,
								elementId,
								updates: {
									transform: { ...initialTransform, scale: snappedScale },
								},
							},
						],
					});
				}
				return;
			}

			if (rotationStateRef.current && activeHandle === "rotation") {
				const {
					trackId,
					elementId,
					baseTransform,
					baseRotate,
					initialAngle,
					initialBoundsCx,
					initialBoundsCy,
				} = rotationStateRef.current;

				const dx = position.x - initialBoundsCx;
				const dy = position.y - initialBoundsCy;
				const currentAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
				let deltaAngle = currentAngle - initialAngle;
				if (deltaAngle > 180) deltaAngle -= 360;
				if (deltaAngle < -180) deltaAngle += 360;
				const newRotate = baseRotate + deltaAngle;
				const shouldSnapRotation = !isShiftHeldRef.current;
				const { snappedRotation } = shouldSnapRotation
					? snapRotation({ proposedRotation: newRotate })
					: { snappedRotation: newRotate };

				editor.timeline.previewElements({
					updates: [
						{
							trackId,
							elementId,
							updates: {
								transform: { ...baseTransform, rotate: snappedRotation },
							},
						},
					],
				});
			}
		},
		[
			activeHandle,
			canvasRef,
			editor,
			isShiftHeldRef,
			updateSplitSlotPreviewTransform,
		],
	);

	const handlePointerUp = useCallback(
		({ event }: { event: React.PointerEvent }) => {
			if (scaleStateRef.current || rotationStateRef.current) {
				if (scaleStateRef.current?.mode === "split-slot") {
					commitSplitSlotPreview({
						trackId: scaleStateRef.current.trackId,
						elementId: scaleStateRef.current.elementId,
					});
				} else {
					editor.timeline.commitPreview();
				}
				scaleStateRef.current = null;
				rotationStateRef.current = null;
				setActiveHandle(null);
				snapLinesRef.current = [];
				setSnapLines([]);
			}
			(event.currentTarget as HTMLElement).releasePointerCapture(
				event.pointerId,
			);
		},
		[commitSplitSlotPreview, editor],
	);

	return {
		selectedWithBounds:
			selectedWithBounds && activeBounds
				? {
						...selectedWithBounds,
						bounds: activeBounds,
					}
				: selectedWithBounds,
		hasVisualSelection:
			hasVisualSelection && !selectedSplitInteractionContext
				? true
				: Boolean(selectedSplitSlotContext),
		hasSelectedSplitSlot: Boolean(selectedSplitSlotContext),
		showRotationHandle: !selectedSplitSlotContext,
		splitSlotControls,
		onSplitSlotScaleChange: handleSplitSlotScaleChange,
		onSplitSlotScaleCommit: () =>
			selectedSplitSlotContext
				? commitSplitSlotPreview({
						trackId: selectedWithBounds?.trackId ?? "",
						elementId: selectedWithBounds?.elementId ?? "",
					})
				: undefined,
		activeHandle,
		snapLines,
		handleCornerPointerDown,
		handleRotationPointerDown,
		handlePointerMove,
		handlePointerUp,
	};
}
