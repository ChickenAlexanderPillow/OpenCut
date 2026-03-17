"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "./base-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { useReframeStore } from "@/stores/reframe-store";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { resolveElementTransformAtTime } from "@/lib/animation";
import { snapTimeToFrame } from "@/lib/time";
import {
	analyzeGeneratedClipReframes,
	getVideoElementSourceRange,
} from "@/lib/reframe/subject-aware";
import {
	buildDefaultVideoSplitScreenBindings,
	deriveVideoSplitScreenSlotAdjustmentFromTransform,
	deriveVideoAngleSections,
	getVideoAngleSectionAtTime,
	getVideoAngleSectionByStartTime,
	getSelectedOrActiveReframePresetId,
	getVideoReframeSectionAtTime,
	getVideoReframeSectionByStartTime,
	getVideoSplitScreenSectionAtTime,
	normalizeVideoReframeState,
	rebuildVideoReframeStateFromAngleSections,
	replaceOrInsertReframeSwitch,
	resolveVideoSplitScreenSlotTransformFromState,
} from "@/lib/reframe/video-reframe";
import {
	CircleDot,
	GripHorizontal,
	Plus,
	RefreshCw,
	ScanFace,
	Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type {
	VideoReframePreset,
	VideoReframeSwitch,
	VideoSplitScreen,
	VideoSplitScreenViewportBalance,
	VideoSplitScreenSlotBinding,
} from "@/types/timeline";

export function ReframeView() {
	const activeTab = useAssetsPanelStore((state) => state.activeTab);
	const editor = useEditor({
		subscribeTo:
			activeTab === "reframe"
				? ["timeline", "selection", "project", "media", "playback"]
				: ["timeline", "selection", "project", "media"],
	});
	const { selectedElements } = useElementSelection();
	const selectedPresetIdByElementId = useReframeStore(
		(state) => state.selectedPresetIdByElementId,
	);
	const selectedSplitPreviewByElementId = useReframeStore(
		(state) => state.selectedSplitPreviewByElementId,
	);
	const selectedSectionStartTimeByElementId = useReframeStore(
		(state) => state.selectedSectionStartTimeByElementId,
	);
	const setSelectedPresetId = useReframeStore(
		(state) => state.setSelectedPresetId,
	);
	const setSelectedSplitPreviewSlots = useReframeStore(
		(state) => state.setSelectedSplitPreviewSlots,
	);
	const setSelectedSectionStartTime = useReframeStore(
		(state) => state.setSelectedSectionStartTime,
	);
	const selected = editor.timeline.getElementsWithTracks({
		elements: selectedElements,
	});
	const selectedVideo = selected.find(
		({ element }) => element.type === "video",
	);

	const normalizedVideo = useMemo(() => {
		if (!selectedVideo || selectedVideo.element.type !== "video") return null;
		return {
			trackId: selectedVideo.track.id,
			element: normalizeVideoReframeState({
				element: selectedVideo.element,
			}),
		};
	}, [selectedVideo]);
	const projectFps = Math.max(1, editor.project.getActive().settings.fps);
	const localTime = normalizedVideo
		? snapTimeToFrame({
				time: Math.max(
					0,
					Math.min(
						normalizedVideo.element.duration,
						editor.playback.getCurrentTime() -
							normalizedVideo.element.startTime,
					),
				),
				fps: projectFps,
			})
		: 0;
	const playheadSection = useMemo(() => {
		if (!normalizedVideo) return null;
		return getVideoReframeSectionAtTime({
			element: normalizedVideo.element,
			localTime,
		});
	}, [normalizedVideo, localTime]);
	const storedFocusedSection = normalizedVideo
		? getVideoReframeSectionByStartTime({
				element: normalizedVideo.element,
				startTime:
					selectedSectionStartTimeByElementId[normalizedVideo.element.id] ??
					null,
			})
		: null;
	const isPlayheadWithinStoredSection = storedFocusedSection
		? localTime >= storedFocusedSection.startTime &&
			localTime <= storedFocusedSection.endTime
		: false;
	const focusedSectionStartTime = normalizedVideo
		? editor.playback.getIsPlaying()
			? (playheadSection?.startTime ?? null)
			: isPlayheadWithinStoredSection
				? (storedFocusedSection?.startTime ??
					playheadSection?.startTime ??
					null)
				: (playheadSection?.startTime ?? null)
		: null;

	const selectedPreset = useMemo(() => {
		if (!normalizedVideo) return null;
		const explicitlySelectedPresetId = editor.playback.getIsPlaying()
			? null
			: (selectedPresetIdByElementId[normalizedVideo.element.id] ?? null);
		if (explicitlySelectedPresetId) {
			return (
				normalizedVideo.element.reframePresets?.find(
					(preset: VideoReframePreset) =>
						preset.id === explicitlySelectedPresetId,
				) ?? null
			);
		}
		const selectedSection = getVideoReframeSectionByStartTime({
			element: normalizedVideo.element,
			startTime: focusedSectionStartTime,
		});
		if (selectedSection?.presetId) {
			return (
				normalizedVideo.element.reframePresets?.find(
					(preset: VideoReframePreset) =>
						preset.id === selectedSection.presetId,
				) ?? null
			);
		}
		const presetId = getSelectedOrActiveReframePresetId({
			element: normalizedVideo.element,
			localTime,
			selectedPresetId: explicitlySelectedPresetId,
		});
		return (
			normalizedVideo.element.reframePresets?.find(
				(preset: VideoReframePreset) => preset.id === presetId,
			) ?? null
		);
	}, [
		normalizedVideo,
		localTime,
		focusedSectionStartTime,
		selectedPresetIdByElementId,
	]);

	const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const [isAnalyzing, setIsAnalyzing] = useState(false);
	const [selectedSplitSectionId, setSelectedSplitSectionId] = useState<
		string | null
	>(null);
	const [draggingMarkerStartTime, setDraggingMarkerStartTime] = useState<
		number | null
	>(null);
	const [markerDragOrderStartTimes, setMarkerDragOrderStartTimes] = useState<
		number[] | null
	>(null);
	const markerItemElementsRef = useRef<Map<number, HTMLDivElement>>(new Map());
	const [markerDragState, setMarkerDragState] = useState<{
		startTime: number;
		pointerY: number;
		offsetY: number;
		left: number;
		width: number;
		height: number;
	} | null>(null);

	const selectedMediaAsset = useMemo(() => {
		if (!normalizedVideo) return null;
		return (
			editor.media
				.getAssets()
				.find((asset) => asset.id === normalizedVideo.element.mediaId) ?? null
		);
	}, [editor.media, normalizedVideo]);
	const handleAnalyzeReframes = async () => {
		if (!normalizedVideo) return;
		if (!selectedMediaAsset || selectedMediaAsset.type !== "video") {
			toast.error("Selected clip does not have a valid video source");
			return;
		}

		setIsAnalyzing(true);
		try {
			const projectCanvas = editor.project.getActive().settings.canvasSize;
			const sourceRange = getVideoElementSourceRange({
				element: normalizedVideo.element,
				asset: selectedMediaAsset,
			});
			const result = await analyzeGeneratedClipReframes({
				asset: selectedMediaAsset,
				startTime: sourceRange.startTime,
				endTime: sourceRange.endTime,
				canvasSize: projectCanvas,
				baseScale: normalizedVideo.element.transform.scale,
			});

			const manualPresets = (
				normalizedVideo.element.reframePresets ?? []
			).filter((preset: VideoReframePreset) => !preset.autoSeeded);
			const preservedSwitches = (
				normalizedVideo.element.reframeSwitches ?? []
			).filter((entry: VideoReframeSwitch) => {
				const matchingPreset = normalizedVideo.element.reframePresets?.find(
					(preset: VideoReframePreset) => preset.id === entry.presetId,
				);
				return Boolean(matchingPreset && !matchingPreset.autoSeeded);
			});
			const nextPresets = [...manualPresets, ...result.presets];
			const nextDefaultPresetId = manualPresets.some(
				(preset: VideoReframePreset) =>
					preset.id === normalizedVideo.element.defaultReframePresetId,
			)
				? (normalizedVideo.element.defaultReframePresetId ??
					result.defaultPresetId)
				: result.defaultPresetId;

			const nextSwitches = result.switches.reduce(
				(currentSwitches, entry) =>
					replaceOrInsertReframeSwitch({
						switches: currentSwitches,
						nextSwitch: entry,
						duration: normalizedVideo.element.duration,
					}),
				preservedSwitches,
			);

			editor.timeline.updateElements({
				updates: [
					{
						trackId: normalizedVideo.trackId,
						elementId: normalizedVideo.element.id,
						updates: {
							reframePresets: nextPresets,
							reframeSwitches: nextSwitches,
							defaultReframePresetId: nextDefaultPresetId,
							reframeSeededBy:
								result.presets.length > 0 ? "subject-aware-v1" : undefined,
						},
					},
				],
			});

			const nextSelectedPreset =
				result.presets.find((preset) => preset.name === "Subject") ??
				result.presets[0] ??
				manualPresets[0] ??
				null;
			if (nextSelectedPreset) {
				setSelectedPresetId({
					elementId: normalizedVideo.element.id,
					presetId: nextSelectedPreset.id,
				});
			}
			if (result.detectionCount === 0) {
				toast.warning(
					"No subjects were detected in this clip. Keeping only a centered Subject preset.",
				);
			} else if (result.subjectClusterCount < 2) {
				toast.info(
					`Detected ${result.detectionCount} subject observations, but only ${result.subjectClusterCount} subject group. Generated centered Subject framing.`,
				);
			} else {
				toast.success(
					`Detected ${result.subjectClusterCount} subjects across ${result.detectionCount} observations and auto-seeded reframe sections.`,
				);
			}
		} catch (error) {
			console.error("Failed to analyze reframe presets", error);
			toast.error("Failed to analyze subject-aware reframes");
		} finally {
			setIsAnalyzing(false);
		}
	};

	const splitScreen = normalizedVideo?.element.splitScreen ?? null;
	const combinedMarkerSections = useMemo(() => {
		if (!normalizedVideo) return [];
		const splitSectionsByStartTime = new Map(
			(splitScreen?.sections ?? []).map(
				(section) => [section.startTime, section] as const,
			),
		);
		return deriveVideoAngleSections({
			element: normalizedVideo.element,
			mergeAdjacent: false,
		}).map((section) => ({
			...section,
			splitMarker: splitSectionsByStartTime.get(section.startTime) ?? null,
		}));
	}, [normalizedVideo, splitScreen]);

	const orderedCombinedMarkerSections = useMemo(() => {
		if (!markerDragOrderStartTimes?.length) {
			return combinedMarkerSections;
		}
		const sectionByStartTime = new Map(
			combinedMarkerSections.map(
				(section) => [section.startTime, section] as const,
			),
		);
		return markerDragOrderStartTimes
			.map((startTime) => sectionByStartTime.get(startTime) ?? null)
			.filter((section): section is NonNullable<typeof section> =>
				Boolean(section),
			);
	}, [combinedMarkerSections, markerDragOrderStartTimes]);
	const draggedMarkerSection = useMemo(
		() =>
			markerDragState
				? (orderedCombinedMarkerSections.find(
						(section) =>
							Math.abs(section.startTime - markerDragState.startTime) <=
							1 / 1000,
					) ?? null)
				: null,
		[markerDragState, orderedCombinedMarkerSections],
	);
	const splitSectionAtFocus = useMemo(() => {
		if (!normalizedVideo) return null;
		return getVideoSplitScreenSectionAtTime({
			element: normalizedVideo.element,
			localTime: focusedSectionStartTime ?? localTime,
		});
	}, [normalizedVideo, focusedSectionStartTime, localTime]);
	const angleSectionAtFocus = useMemo(() => {
		if (!normalizedVideo) return null;
		const storedAngleSection = getVideoAngleSectionByStartTime({
			element: normalizedVideo.element,
			startTime: focusedSectionStartTime,
		});
		if (storedAngleSection) {
			return storedAngleSection;
		}
		return getVideoAngleSectionAtTime({
			element: normalizedVideo.element,
			localTime,
		});
	}, [normalizedVideo, focusedSectionStartTime, localTime]);
	const previewSplitBindings =
		normalizedVideo && !editor.playback.getIsPlaying()
			? (selectedSplitPreviewByElementId[normalizedVideo.element.id]?.slots ??
				null)
			: null;
	const previewSplitViewportBalance =
		normalizedVideo && !editor.playback.getIsPlaying()
			? (selectedSplitPreviewByElementId[normalizedVideo.element.id]
					?.viewportBalance ?? null)
			: null;
	const previewSelectedPresetId =
		normalizedVideo && !editor.playback.getIsPlaying()
			? (selectedPresetIdByElementId[normalizedVideo.element.id] ?? null)
			: null;
	const previousPausedLocalTimeRef = useRef<number | null>(null);
	const editingSplitSection =
		splitScreen?.sections?.find(
			(section) => section.id === selectedSplitSectionId,
		) ?? null;
	const activeFocusedSplitSection =
		splitSectionAtFocus?.enabled !== false ? splitSectionAtFocus : null;
	const selectedSplitSectionEnabled = editingSplitSection?.enabled !== false;
	const activeSplitSection =
		previewSelectedPresetId || !previewSplitBindings?.length
			? selectedSplitSectionEnabled
				? editingSplitSection
				: activeFocusedSplitSection
			: {
					id: "__preview-split__",
					startTime: focusedSectionStartTime ?? 0,
					enabled: true,
					slots: previewSplitBindings,
				};
	const selectedAngleMode: "preset" | "split" =
		previewSplitBindings?.length ||
		activeSplitSection ||
		angleSectionAtFocus?.isSplit
			? "split"
			: "preset";
	const effectiveSplitViewportBalance =
		previewSplitViewportBalance ?? splitScreen?.viewportBalance ?? "balanced";

	useEffect(() => {
		if (!normalizedVideo) return;
		if (editor.playback.getIsPlaying()) {
			previousPausedLocalTimeRef.current = null;
			return;
		}
		const previousTime = previousPausedLocalTimeRef.current;
		previousPausedLocalTimeRef.current = localTime;
		if (
			previousTime === null ||
			Math.abs(previousTime - localTime) <= 1 / 1000
		) {
			return;
		}
		if (!previewSelectedPresetId && !previewSplitBindings?.length) {
			return;
		}
		setSelectedPresetId({
			elementId: normalizedVideo.element.id,
			presetId: null,
		});
		setSelectedSplitPreviewSlots({
			elementId: normalizedVideo.element.id,
			slots: null,
		});
		setSelectedSplitSectionId(null);
	}, [
		editor.playback,
		localTime,
		normalizedVideo,
		previewSelectedPresetId,
		previewSplitBindings,
		setSelectedPresetId,
		setSelectedSplitPreviewSlots,
	]);

	const resolveConcreteSplitBindings = (
		bindings: VideoSplitScreenSlotBinding[],
	): VideoSplitScreenSlotBinding[] =>
		bindings.map((binding) => ({
			slotId: binding.slotId,
			mode: "fixed-preset" as const,
			presetId:
				binding.presetId ??
				selectedPreset?.id ??
				normalizedVideo?.element.defaultReframePresetId ??
				null,
			transformOverride: binding.transformOverride ?? null,
			transformOverridesBySlotId: binding.transformOverridesBySlotId
				? { ...binding.transformOverridesBySlotId }
				: undefined,
			transformAdjustmentsBySlotId: binding.transformAdjustmentsBySlotId
				? { ...binding.transformAdjustmentsBySlotId }
				: undefined,
		}));
	const withBindingSlotAdjustment = ({
		binding,
		slotId = binding.slotId,
		transformAdjustment,
	}: {
		binding: VideoSplitScreenSlotBinding;
		slotId?: string;
		transformAdjustment: NonNullable<
			VideoSplitScreenSlotBinding["transformAdjustmentsBySlotId"]
		>[string];
	}): VideoSplitScreenSlotBinding => ({
		...binding,
		slotId,
		transformAdjustmentsBySlotId: {
			...(binding.transformAdjustmentsBySlotId ?? {}),
			[slotId]: transformAdjustment,
		},
	});
	const editableSplitBindings = resolveConcreteSplitBindings(
		previewSplitBindings ??
			editingSplitSection?.slots ??
			splitScreen?.slots ??
			[],
	);
	const updateBaseSplitBindings = ({
		slots,
		pushHistory = true,
	}: {
		slots: VideoSplitScreenSlotBinding[];
		pushHistory?: boolean;
	}) => {
		if (!normalizedVideo) return;
		editor.timeline.updateVideoSplitScreen({
			trackId: normalizedVideo.trackId,
			elementId: normalizedVideo.element.id,
			updates: {
				...(splitScreen ?? buildInitialSplitScreen()),
				slots,
				sections: (splitScreen?.sections ?? []).map((section) =>
					section.enabled === false
						? section
						: {
								...section,
								slots,
							},
				),
			},
			pushHistory,
		});
		setSelectedSplitPreviewSlots({
			elementId: normalizedVideo.element.id,
			slots,
			viewportBalance:
				splitScreen?.viewportBalance ??
				previewSplitViewportBalance ??
				"balanced",
		});
	};

	const updateSplitBindings = ({
		slotId,
		presetId,
	}: {
		slotId: string;
		presetId: string | null;
	}) => {
		if (!normalizedVideo) return;
		const applyBinding = (bindings: VideoSplitScreenSlotBinding[]) =>
			bindings.map((binding) =>
				binding.slotId === slotId
					? {
							...binding,
							mode: "fixed-preset" as const,
							presetId,
							transformOverride: null,
							transformOverridesBySlotId: undefined,
							transformAdjustmentsBySlotId: undefined,
						}
					: binding,
			);
		updateBaseSplitBindings({
			slots: applyBinding(
				splitScreen?.slots ?? buildInitialSplitScreen().slots,
			),
		});
	};

	const updateSplitViewportBalance = ({
		viewportBalance,
	}: {
		viewportBalance: VideoSplitScreenViewportBalance;
	}) => {
		if (!normalizedVideo) return;
		const currentViewportBalance =
			previewSplitViewportBalance ?? splitScreen?.viewportBalance ?? "balanced";
		if (currentViewportBalance === viewportBalance) {
			return;
		}
		editor.timeline.updateVideoSplitScreen({
			trackId: normalizedVideo.trackId,
			elementId: normalizedVideo.element.id,
			updates: {
				...(splitScreen ?? buildInitialSplitScreen()),
				viewportBalance,
				slots: editableSplitBindings,
				sections: (splitScreen?.sections ?? []).map((section) =>
					section.enabled === false
						? section
						: {
								...section,
								slots: editableSplitBindings,
							},
				),
			},
		});
		setSelectedSplitPreviewSlots({
			elementId: normalizedVideo.element.id,
			slots: editableSplitBindings,
			viewportBalance,
		});
	};

	const swapSplitBindings = () => {
		if (!normalizedVideo) return;
		const bindings = editableSplitBindings;
		if (bindings.length < 2) return;
		const swappedBindings = bindings.map((binding, index, list) => {
			const sourceBinding = list[(index + 1) % list.length] ?? binding;
			return {
				...sourceBinding,
				slotId: binding.slotId,
				transformAdjustmentsBySlotId: sourceBinding.transformAdjustmentsBySlotId
					? { ...sourceBinding.transformAdjustmentsBySlotId }
					: undefined,
			};
		});
		updateBaseSplitBindings({
			slots: swappedBindings,
		});
	};

	const buildInitialSplitScreen = (): VideoSplitScreen => {
		const presets = normalizedVideo?.element.reframePresets ?? [];
		return {
			enabled: false,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			slots: buildDefaultVideoSplitScreenBindings({
				layoutPreset: "top-bottom",
				presets,
			}),
			sections: [],
		};
	};

	const applyPresetSelection = ({ presetId }: { presetId: string }) => {
		if (!normalizedVideo) return;
		activatePresetPreview({ presetId });
		setSelectedSectionStartTime({
			elementId: normalizedVideo.element.id,
			startTime: focusedSectionStartTime,
		});
	};

	const activatePresetPreview = ({ presetId }: { presetId: string }) => {
		if (!normalizedVideo) return;
		setSelectedPresetId({
			elementId: normalizedVideo.element.id,
			presetId,
		});
		setSelectedSplitPreviewSlots({
			elementId: normalizedVideo.element.id,
			slots: null,
		});
		setSelectedSplitSectionId(null);
	};

	const getSplitSlotTransform = (binding: VideoSplitScreenSlotBinding) => {
		if (
			!normalizedVideo ||
			selectedMediaAsset?.type !== "video" ||
			!Number.isFinite(selectedMediaAsset.width) ||
			!Number.isFinite(selectedMediaAsset.height)
		) {
			const slotPreset =
				normalizedVideo?.element.reframePresets?.find(
					(preset) => preset.id === binding.presetId,
				) ?? null;
			return {
				position: slotPreset?.transform.position ?? { x: 0, y: 0 },
				scale:
					slotPreset?.transform.scale ??
					normalizedVideo?.element.transform.scale ??
					1,
			};
		}
		const projectCanvas = editor.project.getActive().settings.canvasSize;
		return resolveVideoSplitScreenSlotTransformFromState({
			baseTransform: normalizedVideo.element.transform,
			duration: normalizedVideo.element.duration,
			reframePresets: normalizedVideo.element.reframePresets,
			reframeSwitches: normalizedVideo.element.reframeSwitches,
			defaultReframePresetId: normalizedVideo.element.defaultReframePresetId,
			localTime,
			slot: binding,
			canvasWidth: projectCanvas.width,
			canvasHeight: projectCanvas.height,
			sourceWidth: selectedMediaAsset.width,
			sourceHeight: selectedMediaAsset.height,
			layoutPreset: splitScreen?.layoutPreset ?? "top-bottom",
			viewportBalance: effectiveSplitViewportBalance,
		});
	};

	const updateSplitSlotTransform = ({
		slotId,
		updates,
		pushHistory,
	}: {
		slotId: string;
		updates: Partial<{
			x: number;
			y: number;
			scale: number;
		}>;
		pushHistory: boolean;
	}) => {
		if (!normalizedVideo) return;
		if (
			selectedMediaAsset?.type !== "video" ||
			!Number.isFinite(selectedMediaAsset.width) ||
			!Number.isFinite(selectedMediaAsset.height)
		) {
			return;
		}
		const sourceWidth = selectedMediaAsset.width!;
		const sourceHeight = selectedMediaAsset.height!;
		const projectCanvas = editor.project.getActive().settings.canvasSize;
		const applyOverride = (bindings: VideoSplitScreenSlotBinding[]) =>
			bindings.map((binding) => {
				if (binding.slotId !== slotId) {
					return binding;
				}
				const currentTransform = getSplitSlotTransform(binding);
				const nextTransform = {
					position: {
						x: updates.x ?? currentTransform.position.x,
						y: updates.y ?? currentTransform.position.y,
					},
					scale: updates.scale ?? currentTransform.scale,
				};
				const baseResolvedTransform =
					resolveVideoSplitScreenSlotTransformFromState({
						baseTransform: normalizedVideo.element.transform,
						duration: normalizedVideo.element.duration,
						reframePresets: normalizedVideo.element.reframePresets,
						reframeSwitches: normalizedVideo.element.reframeSwitches,
						defaultReframePresetId:
							normalizedVideo.element.defaultReframePresetId,
						localTime,
						slot: {
							slotId: binding.slotId,
							presetId: binding.presetId ?? null,
						},
					});
				return withBindingSlotAdjustment({
					binding,
					transformAdjustment:
						deriveVideoSplitScreenSlotAdjustmentFromTransform({
							baseTransform: baseResolvedTransform,
							finalTransform: nextTransform,
							slotId: binding.slotId,
							layoutPreset: splitScreen?.layoutPreset ?? "top-bottom",
							viewportBalance: effectiveSplitViewportBalance,
							canvasWidth: projectCanvas.width,
							canvasHeight: projectCanvas.height,
							sourceWidth,
							sourceHeight,
						}),
				});
			});

		updateBaseSplitBindings({
			slots: applyOverride(
				splitScreen?.slots ?? buildInitialSplitScreen().slots,
			),
			pushHistory,
		});
	};

	const updatePresetTransform = ({
		preset,
		updates,
		pushHistory,
	}: {
		preset: VideoReframePreset;
		updates: Partial<{
			x: number;
			y: number;
			scale: number;
		}>;
		pushHistory: boolean;
	}) => {
		if (!normalizedVideo) return;
		activatePresetPreview({ presetId: preset.id });
		editor.timeline.updateVideoReframePreset({
			trackId: normalizedVideo.trackId,
			elementId: normalizedVideo.element.id,
			presetId: preset.id,
			updates: {
				transform: {
					...preset.transform,
					position: {
						x: updates.x ?? preset.transform.position.x,
						y: updates.y ?? preset.transform.position.y,
					},
					scale: updates.scale ?? preset.transform.scale,
				},
			},
			pushHistory,
		});
	};

	const buildReorderedMarkerStartTimes = ({
		order,
		fromStartTime,
		toStartTime,
	}: {
		order: number[];
		fromStartTime: number;
		toStartTime: number;
	}) => {
		if (fromStartTime === toStartTime) return order;
		const next = [...order];
		const fromIndex = next.findIndex(
			(startTime) => Math.abs(startTime - fromStartTime) <= 1 / 1000,
		);
		const toIndex = next.findIndex(
			(startTime) => Math.abs(startTime - toStartTime) <= 1 / 1000,
		);
		if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
			return order;
		}
		const [moved] = next.splice(fromIndex, 1);
		if (moved === undefined) {
			return order;
		}
		next.splice(toIndex, 0, moved);
		return next;
	};

	const commitMarkerSectionOrder = ({
		orderedStartTimes,
		selectedOrderedStartTime,
	}: {
		orderedStartTimes: number[];
		selectedOrderedStartTime: number | null;
	}) => {
		if (!normalizedVideo) return;
		const sectionByStartTime = new Map(
			combinedMarkerSections.map(
				(section) => [section.startTime, section] as const,
			),
		);
		const sections = orderedStartTimes
			.map((startTime) => sectionByStartTime.get(startTime) ?? null)
			.filter((section): section is NonNullable<typeof section> =>
				Boolean(section),
			)
			.map((section) => ({
				startTime: section.startTime,
				endTime: section.endTime,
				presetId: section.presetId,
				switchId: section.switchId,
				splitSectionId: section.splitSectionId,
				isSplit: section.isSplit,
			}));
		if (sections.length === 0) return;
		const boundaries = [...combinedMarkerSections]
			.map((section) => section.startTime)
			.sort((left, right) => left - right);
		const rebuiltSections = sections.map((section, index) => ({
			...section,
			startTime: boundaries[index] ?? 0,
			endTime: boundaries[index + 1] ?? normalizedVideo.element.duration,
		}));
		const nextState = rebuildVideoReframeStateFromAngleSections({
			element: normalizedVideo.element,
			sections: rebuiltSections,
		});
		editor.timeline.updateElements({
			updates: [
				{
					trackId: normalizedVideo.trackId,
					elementId: normalizedVideo.element.id,
					updates: nextState,
				},
			],
		});
		const selectedIndex =
			selectedOrderedStartTime === null
				? -1
				: orderedStartTimes.findIndex(
						(startTime) =>
							Math.abs(startTime - selectedOrderedStartTime) <= 1 / 1000,
					);
		const selectedSection =
			(selectedIndex >= 0 ? rebuiltSections[selectedIndex] : null) ??
			rebuiltSections[0] ??
			null;
		setSelectedSectionStartTime({
			elementId: normalizedVideo.element.id,
			startTime: selectedSection?.startTime ?? null,
		});
	};

	useEffect(() => {
		if (!markerDragState) return;
		const onPointerMove = (event: PointerEvent) => {
			setMarkerDragState((previous) =>
				previous
					? {
							...previous,
							pointerY: event.clientY,
						}
					: previous,
			);
			setMarkerDragOrderStartTimes((previous) => {
				const currentOrder =
					previous ??
					orderedCombinedMarkerSections.map((section) => section.startTime);
				const hovered = orderedCombinedMarkerSections.find((section) => {
					if (
						Math.abs(section.startTime - markerDragState.startTime) <=
						1 / 1000
					) {
						return false;
					}
					const element = markerItemElementsRef.current.get(section.startTime);
					if (!element) return false;
					const rect = element.getBoundingClientRect();
					return event.clientY >= rect.top && event.clientY <= rect.bottom;
				});
				if (!hovered) {
					return currentOrder;
				}
				return buildReorderedMarkerStartTimes({
					order: currentOrder,
					fromStartTime: markerDragState.startTime,
					toStartTime: hovered.startTime,
				});
			});
		};
		const onPointerUp = () => {
			if (markerDragOrderStartTimes?.length) {
				commitMarkerSectionOrder({
					orderedStartTimes: markerDragOrderStartTimes,
					selectedOrderedStartTime: markerDragState.startTime,
				});
			}
			setDraggingMarkerStartTime(null);
			setMarkerDragOrderStartTimes(null);
			setMarkerDragState(null);
		};
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		return () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
		};
	}, [
		buildReorderedMarkerStartTimes,
		commitMarkerSectionOrder,
		markerDragOrderStartTimes,
		markerDragState,
		orderedCombinedMarkerSections,
	]);

	return (
		<PanelView title="Reframe" contentClassName="space-y-3 pb-3">
			{!normalizedVideo ? (
				<div className="text-muted-foreground rounded-md border p-3 text-sm">
					Select a single video clip to edit reframe presets and switch markers.
				</div>
			) : (
				<>
					<div className="grid grid-cols-2 gap-2">
						<Button
							size="sm"
							variant="default"
							disabled={isAnalyzing || !selectedMediaAsset}
							onClick={() => {
								void handleAnalyzeReframes();
							}}
						>
							<ScanFace className="mr-2 size-4" />
							{isAnalyzing ? "Analyzing..." : "Analyze"}
						</Button>
						<Button
							size="sm"
							variant="secondary"
							onClick={() => {
								const resolvedTransform = resolveElementTransformAtTime({
									element: normalizedVideo.element,
									localTime,
									baseTransformLocalTime: localTime,
								});
								const presetId = editor.timeline.createVideoReframePreset({
									trackId: normalizedVideo.trackId,
									elementId: normalizedVideo.element.id,
									name: `Preset ${(normalizedVideo.element.reframePresets?.length ?? 0) + 1}`,
									transform: {
										position: resolvedTransform.position,
										scale: resolvedTransform.scale,
									},
								});
								if (presetId) {
									setSelectedPresetId({
										elementId: normalizedVideo.element.id,
										presetId,
									});
								}
							}}
						>
							<Plus className="mr-2 size-4" />
							New
						</Button>
					</div>

					<div className="grid grid-cols-1 gap-2">
						{(normalizedVideo.element.reframePresets ?? []).map(
							(preset: VideoReframePreset) => {
								const isActive =
									selectedAngleMode === "preset" &&
									selectedPreset?.id === preset.id;
								const isEditingName = editingPresetId === preset.id;
								return (
									<div
										key={preset.id}
										className={cn(
											"rounded-lg border p-2 transition-colors",
											isActive && "border-primary bg-primary/5",
										)}
										onClick={() => {
											applyPresetSelection({
												presetId: preset.id,
											});
										}}
									>
										<div className="flex items-center gap-2">
											<div className="flex min-w-0 flex-1 items-center gap-2">
												<ReframePresetGlyph name={preset.name} />
												{isEditingName ? (
													<Input
														autoFocus
														value={editingName}
														onClick={(event) => event.stopPropagation()}
														onChange={(event) =>
															setEditingName(event.target.value)
														}
														onBlur={() => {
															const nextName =
																editingName.trim() || preset.name;
															if (nextName !== preset.name) {
																editor.timeline.updateVideoReframePreset({
																	trackId: normalizedVideo.trackId,
																	elementId: normalizedVideo.element.id,
																	presetId: preset.id,
																	updates: { name: nextName },
																});
															}
															setEditingPresetId(null);
														}}
														onKeyDown={(event) => {
															if (event.key === "Enter") {
																event.currentTarget.blur();
																return;
															}
															if (event.key === "Escape") {
																setEditingName(preset.name);
																setEditingPresetId(null);
															}
														}}
														className="h-8"
													/>
												) : (
													<button
														type="button"
														className="truncate text-left text-sm font-medium"
														onClick={(event) => {
															event.stopPropagation();
															setEditingPresetId(preset.id);
															setEditingName(preset.name);
														}}
													>
														{preset.name}
													</button>
												)}
												{preset.autoSeeded && (
													<span className="text-muted-foreground text-[10px] uppercase tracking-[0.14em]">
														Auto
													</span>
												)}
											</div>
										</div>
										<div className="mt-2 grid grid-cols-3 gap-2">
											<ReframeScrubber
												label="X"
												value={preset.transform.position.x}
												min={-1200}
												max={1200}
												step={1}
												formatValue={(value) => Math.round(value).toString()}
												onChange={(value, pushHistory) =>
													updatePresetTransform({
														preset,
														updates: { x: value },
														pushHistory,
													})
												}
											/>
											<ReframeScrubber
												label="Y"
												value={preset.transform.position.y}
												min={-1200}
												max={1200}
												step={1}
												formatValue={(value) => Math.round(value).toString()}
												onChange={(value, pushHistory) =>
													updatePresetTransform({
														preset,
														updates: { y: value },
														pushHistory,
													})
												}
											/>
											<ReframeScrubber
												label="Scale"
												value={preset.transform.scale}
												min={0.5}
												max={8}
												step={0.01}
												dragScale={0.01}
												formatValue={(value) => value.toFixed(2)}
												onChange={(value, pushHistory) =>
													updatePresetTransform({
														preset,
														updates: { scale: value },
														pushHistory,
													})
												}
											/>
										</div>
									</div>
								);
							},
						)}
						<div
							className={cn(
								"rounded-lg border p-2 transition-colors",
								selectedAngleMode === "split" && "border-primary bg-primary/5",
							)}
							onClick={() => {
								setSelectedPresetId({
									elementId: normalizedVideo.element.id,
									presetId: null,
								});
								setSelectedSplitSectionId(null);
								setSelectedSplitPreviewSlots({
									elementId: normalizedVideo.element.id,
									slots: resolveConcreteSplitBindings(
										editingSplitSection?.slots ??
											splitScreen?.slots ??
											buildInitialSplitScreen().slots,
									),
									viewportBalance:
										splitScreen?.viewportBalance ??
										previewSplitViewportBalance ??
										buildInitialSplitScreen().viewportBalance,
								});
								setSelectedSectionStartTime({
									elementId: normalizedVideo.element.id,
									startTime: focusedSectionStartTime,
								});
							}}
						>
							<div className="flex items-center gap-2">
								<div className="flex min-w-0 flex-1 items-center gap-2">
									<SplitScreenPresetGlyph />
									<div className="truncate text-left text-sm font-medium">
										Split Screen
									</div>
								</div>
							</div>
							<div className="mt-3 space-y-2">
								<div className="flex items-center justify-between gap-2">
									<div className="text-muted-foreground text-xs">
										Marks a top/bottom split section and keeps single view
										elsewhere
									</div>
									<Button
										size="sm"
										variant="secondary"
										onClick={(event) => {
											event.stopPropagation();
											swapSplitBindings();
										}}
										disabled={editableSplitBindings.length < 2}
										title="Swap top and bottom"
									>
										<RefreshCw className="size-4" />
									</Button>
								</div>
								<div className="grid grid-cols-2 gap-2">
									<Button
										type="button"
										variant={
											effectiveSplitViewportBalance === "balanced"
												? "secondary"
												: "outline"
										}
										size="sm"
										onClick={(event) => {
											event.stopPropagation();
											updateSplitViewportBalance({
												viewportBalance: "balanced",
											});
										}}
									>
										Balanced 1:1
									</Button>
									<Button
										type="button"
										variant={
											effectiveSplitViewportBalance === "unbalanced"
												? "secondary"
												: "outline"
										}
										size="sm"
										onClick={(event) => {
											event.stopPropagation();
											updateSplitViewportBalance({
												viewportBalance: "unbalanced",
											});
										}}
									>
										Unbalanced 1:2
									</Button>
								</div>
								{editingSplitSection && selectedSplitSectionEnabled && (
									<div className="rounded-md border p-2 text-xs">
										Editing split marker at{" "}
										{editingSplitSection.startTime.toFixed(2)}s
									</div>
								)}
								<div className="grid gap-2">
									{editableSplitBindings.map((binding) => (
										<div
											key={binding.slotId}
											className="grid grid-cols-[90px_minmax(0,1fr)] items-center gap-2"
										>
											<div className="text-xs font-medium uppercase tracking-[0.14em]">
												{binding.slotId}
											</div>
											<div className="flex items-center gap-2">
												{(() => {
													const selectedSlotPreset =
														normalizedVideo.element.reframePresets?.find(
															(preset) => preset.id === binding.presetId,
														) ?? null;
													return selectedSlotPreset ? (
														<ReframePresetGlyph
															name={selectedSlotPreset.name}
														/>
													) : (
														<div className="bg-muted flex size-7 items-center justify-center rounded-md border" />
													);
												})()}
												<select
													className="bg-background h-8 flex-1 rounded-md border px-2 text-sm"
													value={`fixed:${binding.presetId ?? ""}`}
													onClick={(event) => event.stopPropagation()}
													onChange={(event) => {
														updateSplitBindings({
															slotId: binding.slotId,
															presetId:
																event.target.value.replace(/^fixed:/, "") ||
																null,
														});
													}}
												>
													{(normalizedVideo.element.reframePresets ?? []).map(
														(preset) => (
															<option
																key={preset.id}
																value={`fixed:${preset.id}`}
															>
																{preset.name}
															</option>
														),
													)}
												</select>
											</div>
											{(() => {
												const slotTransform = getSplitSlotTransform(binding);
												return (
													<div className="col-span-2 mt-2 grid grid-cols-3 gap-2">
														<ReframeScrubber
															label="X"
															value={slotTransform.position.x}
															min={-1200}
															max={1200}
															step={1}
															formatValue={(value) =>
																Math.round(value).toString()
															}
															onChange={(value, pushHistory) =>
																updateSplitSlotTransform({
																	slotId: binding.slotId,
																	updates: { x: value },
																	pushHistory,
																})
															}
														/>
														<ReframeScrubber
															label="Y"
															value={slotTransform.position.y}
															min={-1200}
															max={1200}
															step={1}
															formatValue={(value) =>
																Math.round(value).toString()
															}
															onChange={(value, pushHistory) =>
																updateSplitSlotTransform({
																	slotId: binding.slotId,
																	updates: { y: value },
																	pushHistory,
																})
															}
														/>
														<ReframeScrubber
															label="Scale"
															value={slotTransform.scale}
															min={0.5}
															max={8}
															step={0.01}
															dragScale={0.01}
															formatValue={(value) => value.toFixed(2)}
															onChange={(value, pushHistory) =>
																updateSplitSlotTransform({
																	slotId: binding.slotId,
																	updates: { scale: value },
																	pushHistory,
																})
															}
														/>
													</div>
												);
											})()}
										</div>
									))}
								</div>
							</div>
						</div>
					</div>

					<div className="space-y-2 rounded-lg border p-3">
						<div className="flex items-center justify-between gap-2">
							<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em]">
								<CircleDot className="size-3.5" />
								<span>Markers</span>
							</div>
							{(normalizedVideo.element.reframeSwitches ?? []).length > 0 && (
								<Button
									size="sm"
									variant="ghost"
									className="h-7 px-2 text-xs"
									onClick={() =>
										editor.timeline.clearVideoReframeSwitches({
											trackId: normalizedVideo.trackId,
											elementId: normalizedVideo.element.id,
										})
									}
								>
									Clear
								</Button>
							)}
						</div>
						<div className="text-muted-foreground text-xs">
							Angle markers switch reframes. Split markers apply the selected
							top/bottom split.
						</div>
						<div className="relative space-y-1.5">
							{orderedCombinedMarkerSections.length === 0 ? (
								<div className="text-muted-foreground text-sm">
									No sections yet.
								</div>
							) : (
								orderedCombinedMarkerSections.map((section) => {
									const presetName =
										normalizedVideo.element.reframePresets?.find(
											(preset: VideoReframePreset) =>
												preset.id === section.presetId,
										)?.name ?? "Subject";
									const label =
										section.splitMarker?.enabled === false
											? "Single view"
											: section.isSplit
												? "Split screen"
												: presetName;
									return (
										<div
											key={`combined:${section.startTime}`}
											ref={(node) => {
												if (node) {
													markerItemElementsRef.current.set(
														section.startTime,
														node,
													);
													return;
												}
												markerItemElementsRef.current.delete(section.startTime);
											}}
											className={cn(
												"bg-muted/20 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-transform duration-150",
												draggingMarkerStartTime === section.startTime &&
													"border-primary bg-primary/10 opacity-0",
											)}
										>
											<button
												type="button"
												className="text-muted-foreground cursor-grab touch-none"
												onPointerDown={(event) => {
													const row = markerItemElementsRef.current.get(
														section.startTime,
													);
													if (!row) return;
													const rect = row.getBoundingClientRect();
													setDraggingMarkerStartTime(section.startTime);
													setMarkerDragOrderStartTimes(
														orderedCombinedMarkerSections.map(
															(candidate) => candidate.startTime,
														),
													);
													setMarkerDragState({
														startTime: section.startTime,
														pointerY: event.clientY,
														offsetY: event.clientY - rect.top,
														left: rect.left,
														width: rect.width,
														height: rect.height,
													});
												}}
											>
												<GripHorizontal className="size-3.5" />
											</button>
											<button
												type="button"
												className="hover:text-foreground text-muted-foreground min-w-11 text-left font-medium"
												onClick={() => {
													setSelectedSectionStartTime({
														elementId: normalizedVideo.element.id,
														startTime: section.startTime,
													});
												}}
											>
												{section.startTime.toFixed(2)}s
											</button>
											<div className="flex min-w-0 flex-1 items-center gap-2">
												{section.isSplit ? (
													<SplitScreenPresetGlyph />
												) : (
													<ReframePresetGlyph name={presetName} />
												)}
												<span className="text-muted-foreground truncate">
													{label}
												</span>
											</div>
										</div>
									);
								})
							)}
							{draggedMarkerSection && markerDragState && (
								<div
									className="bg-muted border-primary pointer-events-none fixed z-20 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs shadow-lg"
									style={{
										left: markerDragState.left,
										top: markerDragState.pointerY - markerDragState.offsetY,
										width: markerDragState.width,
										height: markerDragState.height,
									}}
								>
									<div className="text-muted-foreground">
										<GripHorizontal className="size-3.5" />
									</div>
									<div className="text-muted-foreground min-w-11 text-left font-medium">
										{draggedMarkerSection.startTime.toFixed(2)}s
									</div>
									<div className="flex min-w-0 flex-1 items-center gap-2">
										{draggedMarkerSection.isSplit ? (
											<SplitScreenPresetGlyph />
										) : (
											<ReframePresetGlyph
												name={
													normalizedVideo.element.reframePresets?.find(
														(preset: VideoReframePreset) =>
															preset.id === draggedMarkerSection.presetId,
													)?.name ?? "Subject"
												}
											/>
										)}
										<span className="text-muted-foreground truncate">
											{draggedMarkerSection.splitMarker?.enabled === false
												? "Single view"
												: draggedMarkerSection.isSplit
													? "Split screen"
													: (normalizedVideo.element.reframePresets?.find(
															(preset: VideoReframePreset) =>
																preset.id === draggedMarkerSection.presetId,
														)?.name ?? "Subject")}
										</span>
									</div>
								</div>
							)}
						</div>
					</div>
				</>
			)}
		</PanelView>
	);
}

function ReframePresetGlyph({ name }: { name: string }) {
	const normalized = name.trim().toLowerCase();
	const kind = normalized.includes("left")
		? "subject-left"
		: normalized.includes("right")
			? "subject-right"
			: "subject";
	return (
		<div className="bg-muted flex size-7 items-center justify-center rounded-md border">
			<QuickAngleGlyph kind={kind} className="size-4" />
		</div>
	);
}

function SplitScreenPresetGlyph() {
	return (
		<div className="bg-muted flex size-7 items-center justify-center rounded-md border">
			<QuickAngleGlyph kind="split-screen" className="size-4" />
		</div>
	);
}

function QuickAngleGlyph({
	kind,
	className,
}: {
	kind: "subject" | "subject-left" | "subject-right" | "split-screen";
	className?: string;
}) {
	if (kind === "subject") {
		return <PersonCameraGlyph className={className} />;
	}
	if (kind === "split-screen") {
		return <SplitScreenGlyph className={className} />;
	}

	return (
		<div className={cn("relative", className)}>
			<div
				className={cn(
					"absolute inset-y-0 overflow-hidden",
					kind === "subject-left" ? "left-0 w-1/2" : "right-0 w-1/2",
				)}
			>
				<PersonCameraGlyph
					className={cn(
						"absolute top-0 size-full",
						kind === "subject-left" ? "left-0" : "right-0",
					)}
				/>
			</div>
			<div className="absolute inset-y-[1px] left-1/2 w-px -translate-x-1/2 bg-current/60" />
		</div>
	);
}

function SplitScreenGlyph({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 16 16"
			className={className}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.15"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="1.75" y="1.75" width="12.5" height="12.5" rx="1.6" />
			<path d="M3 8h10" />
			<circle cx="8" cy="4.9" r="1.35" />
			<path d="M5.9 7.1c.42-1.18 1.25-1.8 2.1-1.8s1.68.62 2.1 1.8" />
			<circle cx="8" cy="11.15" r="1.35" />
			<path d="M5.9 13.35c.42-1.18 1.25-1.8 2.1-1.8s1.68.62 2.1 1.8" />
		</svg>
	);
}

function PersonCameraGlyph({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 16 16"
			className={className}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx="8" cy="5.25" r="2.15" />
			<path d="M4.8 12.8c.7-2.05 2.2-3.1 3.2-3.1s2.5 1.05 3.2 3.1" />
		</svg>
	);
}

function ReframeScrubber({
	label,
	value,
	min,
	max,
	step,
	dragScale = step,
	formatValue,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	dragScale?: number;
	formatValue: (value: number) => string;
	onChange: (value: number, pushHistory: boolean) => void;
}) {
	const [isHovering, setIsHovering] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const [draftValue, setDraftValue] = useState("");
	const startXRef = useRef(0);
	const startValueRef = useRef(value);
	const dragDeltaRef = useRef(0);
	const hasDraggedRef = useRef(false);
	const pointerLockElementRef = useRef<HTMLElement | null>(null);
	const pointerLockActiveRef = useRef(false);
	const dragFrameRef = useRef<number | null>(null);
	const latestDragValueRef = useRef(value);

	useEffect(() => {
		if (!isDragging) {
			latestDragValueRef.current = value;
		}
	}, [isDragging, value]);

	useEffect(() => {
		if (!isEditing) {
			setDraftValue(formatValue(value));
		}
	}, [formatValue, isEditing, value]);

	useEffect(() => {
		return () => {
			if (dragFrameRef.current != null) {
				window.cancelAnimationFrame(dragFrameRef.current);
			}
		};
	}, []);

	const roundToStep = (nextValue: number) => {
		const decimals =
			step >= 1 ? 0 : Math.max(0, (step.toString().split(".")[1] ?? "").length);
		return Number(nextValue.toFixed(decimals));
	};

	const clampValue = (nextValue: number) =>
		Math.max(min, Math.min(max, roundToStep(nextValue)));

	const setValueFromClientX = ({ clientX }: { clientX: number }) => {
		const deltaX = clientX - startXRef.current;
		const nextValue = clampValue(startValueRef.current + deltaX * dragScale);
		latestDragValueRef.current = nextValue;
		onChange(nextValue, false);
	};

	const setValueFromMovementX = ({ movementX }: { movementX: number }) => {
		dragDeltaRef.current += movementX;
		const nextValue = clampValue(
			startValueRef.current + dragDeltaRef.current * dragScale,
		);
		latestDragValueRef.current = nextValue;
		onChange(nextValue, false);
	};

	const stopDrag = () => {
		if (
			typeof document !== "undefined" &&
			document.pointerLockElement &&
			typeof document.exitPointerLock === "function"
		) {
			try {
				document.exitPointerLock();
			} catch {}
		}
		if (hasDraggedRef.current) {
			onChange(latestDragValueRef.current, true);
		} else {
			setDraftValue(formatValue(value));
			setIsEditing(true);
		}
		setIsDragging(false);
		hasDraggedRef.current = false;
		pointerLockElementRef.current = null;
		pointerLockActiveRef.current = false;
		if (dragFrameRef.current != null) {
			window.cancelAnimationFrame(dragFrameRef.current);
			dragFrameRef.current = null;
		}
	};

	useEffect(() => {
		if (!isDragging) return;
		const handlePointerMove = (event: PointerEvent) => {
			if (pointerLockActiveRef.current) {
				const deltaX = Math.abs(dragDeltaRef.current + event.movementX);
				if (!hasDraggedRef.current && deltaX >= 2) {
					hasDraggedRef.current = true;
				}
				if (!hasDraggedRef.current) return;
				event.preventDefault();
				if (dragFrameRef.current != null) return;
				const movementX = event.movementX;
				dragFrameRef.current = window.requestAnimationFrame(() => {
					dragFrameRef.current = null;
					setValueFromMovementX({ movementX });
				});
				return;
			}
			const deltaX = Math.abs(event.clientX - startXRef.current);
			if (!hasDraggedRef.current && deltaX >= 2) {
				hasDraggedRef.current = true;
			}
			if (!hasDraggedRef.current) return;
			event.preventDefault();
			if (dragFrameRef.current != null) return;
			const clientX = event.clientX;
			dragFrameRef.current = window.requestAnimationFrame(() => {
				dragFrameRef.current = null;
				setValueFromClientX({ clientX });
			});
		};

		const handlePointerLockChange = () => {
			pointerLockActiveRef.current =
				document.pointerLockElement === pointerLockElementRef.current;
		};

		document.addEventListener("pointerlockchange", handlePointerLockChange);
		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", stopDrag);
		window.addEventListener("pointercancel", stopDrag);
		return () => {
			document.removeEventListener(
				"pointerlockchange",
				handlePointerLockChange,
			);
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", stopDrag);
			window.removeEventListener("pointercancel", stopDrag);
		};
	}, [isDragging]);

	const roundToStepString = (nextValue: number) =>
		formatValue(clampValue(nextValue));

	const commitDraft = () => {
		const parsed = Number.parseFloat(draftValue.trim());
		if (Number.isNaN(parsed)) {
			setDraftValue(formatValue(value));
			setIsEditing(false);
			return;
		}
		const nextValue = clampValue(parsed);
		onChange(nextValue, true);
		setDraftValue(roundToStepString(nextValue));
		setIsEditing(false);
	};

	const cancelDraft = () => {
		setDraftValue(formatValue(value));
		setIsEditing(false);
	};

	return (
		<div
			className="bg-muted/30 rounded-md px-2 py-1"
			onClick={(event) => event.stopPropagation()}
			onMouseEnter={() => setIsHovering(true)}
			onMouseLeave={() => setIsHovering(false)}
		>
			<div className="text-[10px] uppercase tracking-[0.14em]">{label}</div>
			{isEditing ? (
				<Input
					autoFocus
					value={draftValue}
					inputMode="decimal"
					className="mt-1 h-7 text-center text-xs font-medium"
					onClick={(event) => event.stopPropagation()}
					onFocus={(event) => event.currentTarget.select()}
					onChange={(event) => setDraftValue(event.target.value)}
					onBlur={commitDraft}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.currentTarget.blur();
							return;
						}
						if (event.key === "Escape") {
							event.preventDefault();
							cancelDraft();
						}
					}}
					aria-label={`Edit ${label}`}
				/>
			) : (
				<button
					type="button"
					className={cn(
						"text-foreground mt-0.5 flex w-full cursor-ew-resize items-center justify-between gap-2 text-xs font-medium",
						isDragging && "text-primary",
					)}
					onPointerDown={(event) => {
						event.stopPropagation();
						startXRef.current = event.clientX;
						startValueRef.current = value;
						dragDeltaRef.current = 0;
						hasDraggedRef.current = false;
						latestDragValueRef.current = value;
						pointerLockElementRef.current = event.currentTarget;
						if (typeof event.currentTarget.requestPointerLock === "function") {
							try {
								event.currentTarget.requestPointerLock();
							} catch {}
						}
						setIsDragging(true);
					}}
					aria-label={`Adjust ${label}`}
					title={`Click to edit or drag left/right to adjust ${label}.`}
				>
					<span
						aria-hidden
						className={cn(
							"bg-muted-foreground/60 inline-block h-3 w-[2px] rounded-full transition-opacity",
							isDragging || isHovering ? "opacity-100" : "opacity-60",
						)}
					/>
					<span className="min-w-0 flex-1 text-center">
						{formatValue(value)}
					</span>
					<span
						aria-hidden
						className={cn(
							"bg-muted-foreground/60 inline-block h-3 w-[2px] rounded-full transition-opacity",
							isDragging || isHovering ? "opacity-100" : "opacity-60",
						)}
					/>
				</button>
			)}
		</div>
	);
}
