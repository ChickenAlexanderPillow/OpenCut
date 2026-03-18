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
import type { Transform } from "@/types/timeline";
import { usePreviewStore } from "@/stores/preview-store";
import { isGeneratedCaptionElement } from "@/lib/captions/caption-track";
import {
	applySelectedReframePresetPreviewToTracks,
	getSelectedOrActiveReframePresetId,
	normalizeVideoReframeState,
	resolveVideoSplitScreenSlotTransformFromState,
} from "@/lib/reframe/video-reframe";
import {
	buildSplitScreenUpdates,
	getSplitSlotViewportBounds,
	resolveEditableSplitSlotState,
	updateSplitSlotBindingsWithTransform,
} from "@/lib/reframe/split-slot-edit";
import { useReframeStore } from "@/stores/reframe-store";

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type HandleType = Corner | "rotation";

interface ScaleState {
	mode: "element" | "split-slot";
	trackId: string;
	elementId: string;
	initialTransform: Transform;
	reframePresetId: string | null;
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
					});
					if (!editableSplitState) return null;
					const bounds = getSplitSlotViewportBounds({
						layoutPreset: editableSplitState.layoutPreset,
						viewportBalance: editableSplitState.viewportBalance,
						slotId,
						canvasWidth: canvasSize.width,
						canvasHeight: canvasSize.height,
					});
					if (!bounds) return null;
					return {
						slotId,
						clipLocalTime,
						normalizedElement,
						editableSplitState,
						bounds,
					};
				})()
			: null;
	const selectedSplitInteractionContext =
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
			element: Extract<ReturnType<typeof normalizeVideoReframeState>, { type: "video" }>;
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
			const clipLocalTime = Math.max(0, currentTime - element.startTime);
			const editableSplitState = resolveEditableSplitSlotState({
				element,
				localTime: clipLocalTime,
				splitPreview:
					useReframeStore.getState().selectedSplitPreviewByElementId[
						element.id
					] ?? null,
			});
			if (!editableSplitState) return;
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
		[editor.media, editor.project, currentTime],
	);

	const commitSplitSlotPreview = useCallback(
		({ trackId, elementId }: { trackId: string; elementId: string }) => {
			const track = editor.timeline.getTrackById({ trackId });
			const element =
				track?.type === "video"
					? track.elements.find(
							(candidate) =>
								candidate.type === "video" && candidate.id === elementId,
						) ?? null
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
		(() => {
			const activeBinding =
				selectedSplitSlotContext.editableSplitState.slots.find(
					(binding) => binding.slotId === selectedSplitSlotContext.slotId,
				) ?? null;
			const mediaAsset =
				editor.media
					.getAssets()
					.find(
						(asset) => asset.id === selectedSplitSlotContext.normalizedElement.mediaId,
					) ?? null;
			if (
				!activeBinding ||
				mediaAsset?.type !== "video" ||
				!Number.isFinite(mediaAsset.width) ||
				!Number.isFinite(mediaAsset.height)
			) {
				return null;
			}
			return {
				slotId: selectedSplitSlotContext.slotId,
				bounds: selectedSplitSlotContext.bounds,
				scale: resolveVideoSplitScreenSlotTransformFromState({
					baseTransform: selectedSplitSlotContext.normalizedElement.transform,
					duration: selectedSplitSlotContext.normalizedElement.duration,
					reframePresets: selectedSplitSlotContext.normalizedElement.reframePresets,
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
					layoutPreset: selectedSplitSlotContext.editableSplitState.layoutPreset,
					viewportBalance:
						selectedSplitSlotContext.editableSplitState.viewportBalance,
				}).scale,
			};
		})();

	const handleSplitSlotScaleChange = useCallback(
		({ nextScale }: { nextScale: number }) => {
			if (!selectedSplitSlotContext) return;
			updateSplitSlotPreviewTransform({
				element: selectedSplitSlotContext.normalizedElement,
				slotId: selectedSplitSlotContext.slotId,
				nextTransform: {
					position: resolveVideoSplitScreenSlotTransformFromState({
						baseTransform: selectedSplitSlotContext.normalizedElement.transform,
						duration: selectedSplitSlotContext.normalizedElement.duration,
						reframePresets:
							selectedSplitSlotContext.normalizedElement.reframePresets,
						reframeSwitches:
							selectedSplitSlotContext.normalizedElement.reframeSwitches,
						defaultReframePresetId:
							selectedSplitSlotContext.normalizedElement.defaultReframePresetId,
						localTime: selectedSplitSlotContext.clipLocalTime,
						slot:
							selectedSplitSlotContext.editableSplitState.slots.find(
								(binding) => binding.slotId === selectedSplitSlotContext.slotId,
							) ?? {
								slotId: selectedSplitSlotContext.slotId,
								presetId: null,
							},
						canvasWidth: canvasSize.width,
						canvasHeight: canvasSize.height,
						sourceWidth:
							editor.media
								.getAssets()
								.find(
									(asset) =>
										asset.id === selectedSplitSlotContext.normalizedElement.mediaId,
								)?.width ?? canvasSize.width,
						sourceHeight:
							editor.media
								.getAssets()
								.find(
									(asset) =>
										asset.id === selectedSplitSlotContext.normalizedElement.mediaId,
								)?.height ?? canvasSize.height,
						layoutPreset: selectedSplitSlotContext.editableSplitState.layoutPreset,
						viewportBalance:
							selectedSplitSlotContext.editableSplitState.viewportBalance,
					}).position,
					scale: Math.max(MIN_SCALE, nextScale),
				},
			});
		},
		[canvasSize.height, canvasSize.width, editor.media, selectedSplitSlotContext, updateSplitSlotPreviewTransform],
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
			const reframePresetId =
				normalizedElement.type === "video"
					? getSelectedOrActiveReframePresetId({
							element: normalizedElement,
							localTime: clipLocalTime,
							selectedPresetId:
								selectedPresetIdByElementId[normalizedElement.id] ?? null,
						})
					: null;
			const initialTransform =
				selectedSplitSlotContext &&
				normalizedVideoElement &&
				selectedSplitSlotContext.normalizedElement.id === normalizedVideoElement.id
					? (() => {
							const mediaAsset =
								editor.media
									.getAssets()
									.find(
										(asset) => asset.id === normalizedVideoElement.mediaId,
									) ?? null;
							const activeBinding =
								selectedSplitSlotContext.editableSplitState.slots.find(
									(binding) =>
										binding.slotId === selectedSplitSlotContext.slotId,
								) ?? null;
							if (
								mediaAsset?.type !== "video" ||
								!activeBinding ||
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
							return resolveVideoSplitScreenSlotTransformFromState({
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
								layoutPreset: selectedSplitSlotContext.editableSplitState.layoutPreset,
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
			selectedPresetIdByElementId,
			selectedSplitSlotContext,
			selectedWithBounds,
		],
	);

	const handleRotationPointerDown = useCallback(
		({ event }: { event: React.PointerEvent }) => {
			if (!selectedWithBounds || !canvasRef.current || selectedSplitSlotContext) {
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
							? track.elements.find(
									(candidate) =>
										candidate.type === "video" && candidate.id === elementId,
								) ?? null
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
				} else if (reframePresetId) {
					editor.timeline.updateVideoReframePreset({
						trackId,
						elementId,
						presetId: reframePresetId,
						updates: {
							transform: {
								position: initialTransform.position,
								scale: snappedScale,
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
		[activeHandle, canvasRef, editor, isShiftHeldRef, updateSplitSlotPreviewTransform],
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
