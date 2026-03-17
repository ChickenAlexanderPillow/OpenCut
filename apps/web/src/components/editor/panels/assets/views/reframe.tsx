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
	getSelectedOrActiveReframePresetId,
	getVideoReframeSectionAtTime,
	getVideoReframeSectionByStartTime,
	getVideoSplitScreenSectionAtTime,
	normalizeVideoReframeState,
	replaceOrInsertReframeSwitch,
} from "@/lib/reframe/video-reframe";
import {
	ChevronsLeftRight,
	CircleDot,
	Focus,
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
	const selectedSplitPreviewSlotsByElementId = useReframeStore(
		(state) => state.selectedSplitPreviewSlotsByElementId,
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
	const selected = editor.timeline.getElementsWithTracks({ elements: selectedElements });
	const selectedVideo = selected.find(({ element }) => element.type === "video");

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
						editor.playback.getCurrentTime() - normalizedVideo.element.startTime,
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
					selectedSectionStartTimeByElementId[normalizedVideo.element.id] ?? null,
			})
		: null;
	const isPlayheadWithinStoredSection = storedFocusedSection
		? localTime >= storedFocusedSection.startTime &&
			localTime <= storedFocusedSection.endTime
		: false;
	const focusedSectionStartTime = normalizedVideo
		? editor.playback.getIsPlaying()
			? playheadSection?.startTime ?? null
			: isPlayheadWithinStoredSection
				? storedFocusedSection?.startTime ?? playheadSection?.startTime ?? null
				: (playheadSection?.startTime ?? null)
		: null;

	const selectedPreset = useMemo(() => {
		if (!normalizedVideo) return null;
		const explicitlySelectedPresetId =
			editor.playback.getIsPlaying()
				? null
				: (selectedPresetIdByElementId[normalizedVideo.element.id] ?? null);
		if (explicitlySelectedPresetId) {
			return (
				normalizedVideo.element.reframePresets?.find(
					(preset: VideoReframePreset) => preset.id === explicitlySelectedPresetId,
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
					(preset: VideoReframePreset) => preset.id === selectedSection.presetId,
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
	const [selectedSplitSectionId, setSelectedSplitSectionId] = useState<string | null>(null);

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

			const manualPresets = (normalizedVideo.element.reframePresets ?? []).filter(
				(preset: VideoReframePreset) => !preset.autoSeeded,
			);
			const preservedSwitches = (normalizedVideo.element.reframeSwitches ?? []).filter(
				(entry: VideoReframeSwitch) => {
					const matchingPreset = normalizedVideo.element.reframePresets?.find(
						(preset: VideoReframePreset) => preset.id === entry.presetId,
					);
					return Boolean(matchingPreset && !matchingPreset.autoSeeded);
				},
			);
			const nextPresets = [...manualPresets, ...result.presets];
			const nextDefaultPresetId =
				manualPresets.some(
					(preset: VideoReframePreset) =>
						preset.id === normalizedVideo.element.defaultReframePresetId,
				)
					? normalizedVideo.element.defaultReframePresetId ?? result.defaultPresetId
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
	const splitSectionAtFocus = useMemo(() => {
		if (!normalizedVideo) return null;
		return getVideoSplitScreenSectionAtTime({
			element: normalizedVideo.element,
			localTime: focusedSectionStartTime ?? localTime,
		});
	}, [normalizedVideo, focusedSectionStartTime, localTime]);
	const previewSplitBindings =
		normalizedVideo && !editor.playback.getIsPlaying()
			? (selectedSplitPreviewSlotsByElementId[normalizedVideo.element.id] ?? null)
			: null;
	const previewSelectedPresetId =
		normalizedVideo && !editor.playback.getIsPlaying()
			? (selectedPresetIdByElementId[normalizedVideo.element.id] ?? null)
			: null;
	const selectedSplitSection =
		splitScreen?.sections?.find((section) => section.id === selectedSplitSectionId) ??
		splitSectionAtFocus;
	const selectedSplitSectionEnabled = selectedSplitSection?.enabled !== false;
	const activeSplitSection =
		previewSelectedPresetId || !previewSplitBindings?.length
			? selectedSplitSectionEnabled
				? selectedSplitSection
				: null
			: {
					id: "__preview-split__",
					startTime: focusedSectionStartTime ?? 0,
					enabled: true,
					slots: previewSplitBindings,
			  };
	const selectedAngleMode: "preset" | "split" =
		previewSplitBindings?.length || activeSplitSection ? "split" : "preset";
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
		}));
	const editableSplitBindings =
		resolveConcreteSplitBindings(
			selectedSplitSection?.slots ?? splitScreen?.slots ?? [],
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
			},
			pushHistory,
		});
		setSelectedSplitPreviewSlots({
			elementId: normalizedVideo.element.id,
			slots,
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
							transformOverride: binding.transformOverride ?? null,
					  }
					: binding,
			);
		if (selectedSplitSectionId && splitScreen && selectedSplitSection) {
			editor.timeline.upsertVideoSplitScreenSection({
				trackId: normalizedVideo.trackId,
				elementId: normalizedVideo.element.id,
				time: selectedSplitSection.startTime,
				slots: applyBinding(selectedSplitSection.slots),
			});
			return;
		}
		updateBaseSplitBindings({
			slots: applyBinding(splitScreen?.slots ?? buildInitialSplitScreen().slots),
		});
	};

	const swapSplitBindings = () => {
		if (!normalizedVideo) return;
		const bindings = editableSplitBindings;
		if (bindings.length < 2) return;
		const swappedBindings = bindings.map((binding, index, list) => ({
			...binding,
			mode: list[(index + 1) % list.length]?.mode ?? binding.mode,
			presetId: list[(index + 1) % list.length]?.presetId ?? binding.presetId,
			transformOverride:
				list[(index + 1) % list.length]?.transformOverride ??
				binding.transformOverride ??
				null,
		}));
		if (selectedSplitSectionId && splitScreen && selectedSplitSection) {
			editor.timeline.upsertVideoSplitScreenSection({
				trackId: normalizedVideo.trackId,
				elementId: normalizedVideo.element.id,
				time: selectedSplitSection.startTime,
				enabled: selectedSplitSection.enabled !== false,
				slots: swappedBindings,
			});
			return;
		}
		updateBaseSplitBindings({
			slots: swappedBindings,
		});
	};

	const buildInitialSplitScreen = (): VideoSplitScreen => {
		const presets = normalizedVideo?.element.reframePresets ?? [];
		return {
			enabled: false,
			layoutPreset: "top-bottom",
			slots: buildDefaultVideoSplitScreenBindings({
				layoutPreset: "top-bottom",
				presets,
			}),
			sections: [],
		};
	};

	const applyPresetSelection = ({ presetId }: { presetId: string }) => {
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
		setSelectedSectionStartTime({
			elementId: normalizedVideo.element.id,
			startTime: focusedSectionStartTime,
		});
	};

	const getSplitSlotTransform = (binding: VideoSplitScreenSlotBinding) => {
		const slotPreset =
			normalizedVideo?.element.reframePresets?.find(
				(preset) => preset.id === binding.presetId,
			) ?? null;
		return (
			binding.transformOverride ?? {
				position: slotPreset?.transform.position ?? { x: 0, y: 0 },
				scale: slotPreset?.transform.scale ?? normalizedVideo?.element.transform.scale ?? 1,
			}
		);
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
		const applyOverride = (bindings: VideoSplitScreenSlotBinding[]) =>
			bindings.map((binding) => {
				if (binding.slotId !== slotId) {
					return binding;
				}
				const currentTransform = getSplitSlotTransform(binding);
				return {
					...binding,
					transformOverride: {
						position: {
							x: updates.x ?? currentTransform.position.x,
							y: updates.y ?? currentTransform.position.y,
						},
						scale: updates.scale ?? currentTransform.scale,
					},
				};
			});

		if (selectedSplitSectionId && splitScreen && selectedSplitSection) {
			editor.timeline.upsertVideoSplitScreenSection({
				trackId: normalizedVideo.trackId,
				elementId: normalizedVideo.element.id,
				time: selectedSplitSection.startTime,
				enabled: selectedSplitSection.enabled !== false,
				slots: applyOverride(selectedSplitSection.slots),
				pushHistory,
			});
			return;
		}

		updateBaseSplitBindings({
			slots: applyOverride(
				splitScreen?.slots ?? buildInitialSplitScreen().slots,
			),
			pushHistory,
		});
	};

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
								{(normalizedVideo.element.reframePresets ?? []).map((preset: VideoReframePreset) => {
							const isActive =
								selectedAngleMode === "preset" && selectedPreset?.id === preset.id;
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
														const nextName = editingName.trim() || preset.name;
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
												editor.timeline.updateVideoReframePreset({
													trackId: normalizedVideo.trackId,
													elementId: normalizedVideo.element.id,
													presetId: preset.id,
													updates: {
														transform: {
															...preset.transform,
															position: {
																...preset.transform.position,
																x: value,
															},
														},
													},
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
												editor.timeline.updateVideoReframePreset({
													trackId: normalizedVideo.trackId,
													elementId: normalizedVideo.element.id,
													presetId: preset.id,
													updates: {
														transform: {
															...preset.transform,
															position: {
																...preset.transform.position,
																y: value,
															},
														},
													},
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
												editor.timeline.updateVideoReframePreset({
													trackId: normalizedVideo.trackId,
													elementId: normalizedVideo.element.id,
													presetId: preset.id,
													updates: {
														transform: {
															...preset.transform,
															scale: value,
														},
													},
													pushHistory,
												})
											}
										/>
									</div>
								</div>
							);
						})}
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
									slots:
										resolveConcreteSplitBindings(
											selectedSplitSection?.slots ??
												splitScreen?.slots ??
												buildInitialSplitScreen().slots,
										),
								});
								setSelectedSectionStartTime({
									elementId: normalizedVideo.element.id,
									startTime: focusedSectionStartTime,
								});
							}}
						>
							<div className="flex items-center gap-2">
								<div className="flex min-w-0 flex-1 items-center gap-2">
									<div className="bg-muted flex size-7 items-center justify-center rounded-md border">
										<ChevronsLeftRight className="size-3.5" />
									</div>
									<div className="truncate text-left text-sm font-medium">
										Split Screen
									</div>
								</div>
							</div>
							{selectedAngleMode === "split" && (
								<div className="mt-3 space-y-2">
									<div className="flex items-center justify-between gap-2">
										<div className="text-muted-foreground text-xs">
											Marks a top/bottom split section and keeps single view elsewhere
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
									{selectedSplitSection && selectedSplitSectionEnabled && (
										<div className="rounded-md border p-2 text-xs">
											Editing split marker at {selectedSplitSection.startTime.toFixed(2)}s
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
												<select
													className="bg-background h-8 rounded-md border px-2 text-sm"
													value={
														`fixed:${binding.presetId ?? ""}`
													}
													onClick={(event) => event.stopPropagation()}
													onChange={(event) => {
														updateSplitBindings({
															slotId: binding.slotId,
															presetId:
																event.target.value.replace(/^fixed:/, "") || null,
														});
													}}
												>
													{(normalizedVideo.element.reframePresets ?? []).map((preset) => (
														<option key={preset.id} value={`fixed:${preset.id}`}>
															Use {preset.name}
														</option>
													))}
												</select>
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
							)}
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
						Angle markers switch reframes. Split markers apply the selected top/bottom split.
					</div>
						<div className="space-y-1">
							{(normalizedVideo.element.splitScreen?.sections ?? []).length === 0 ? (
								<div className="text-muted-foreground text-sm">
									No split markers yet.
								</div>
							) : (
								(normalizedVideo.element.splitScreen?.sections ?? []).map((section) => (
									<div
										key={section.id}
										className="bg-muted/20 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
									>
										<button
											type="button"
											className="hover:text-foreground text-muted-foreground min-w-11 text-left font-medium"
											onClick={() => {
												setSelectedPresetId({
													elementId: normalizedVideo.element.id,
													presetId: null,
												});
												setSelectedSplitSectionId(section.id);
												setSelectedSplitPreviewSlots({
													elementId: normalizedVideo.element.id,
													slots: resolveConcreteSplitBindings(section.slots),
												});
												setSelectedSectionStartTime({
													elementId: normalizedVideo.element.id,
													startTime: section.startTime,
												});
											}}
										>
											{section.startTime.toFixed(2)}s
										</button>
										<div className="flex min-w-0 flex-1 items-center gap-2">
											<div className="bg-muted flex size-7 items-center justify-center rounded-md border text-[10px] font-medium uppercase">
												{section.enabled === false ? "1x" : "2x"}
											</div>
											<span className="text-muted-foreground truncate">
												{section.enabled === false ? "Single view" : "Split screen"}
											</span>
										</div>
										<Button
											size="sm"
											variant="ghost"
											className="ml-auto h-7 px-2"
											onClick={() =>
												editor.timeline.removeVideoSplitScreenSection({
													trackId: normalizedVideo.trackId,
													elementId: normalizedVideo.element.id,
													sectionId: section.id,
												})
											}
										>
											<Trash2 className="size-3.5" />
										</Button>
									</div>
								))
							)}
						</div>
						{(normalizedVideo.element.reframeSwitches ?? []).length === 0 ? (
							<div className="text-muted-foreground text-sm">
								No angle markers yet.
							</div>
						) : (
							(normalizedVideo.element.reframeSwitches ?? []).map((entry: VideoReframeSwitch) => (
								<div
									key={entry.id}
									className="bg-muted/20 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
								>
										<button
											type="button"
											className="hover:text-foreground text-muted-foreground min-w-11 text-left font-medium"
											onClick={() =>
												applyPresetSelection({
													presetId: entry.presetId,
												})
											}
										>
										{entry.time.toFixed(2)}s
									</button>
									<div className="flex min-w-0 flex-1 items-center gap-2">
										<ReframePresetGlyph
											name={
												normalizedVideo.element.reframePresets?.find(
													(preset: VideoReframePreset) =>
														preset.id === entry.presetId,
												)?.name ?? "Subject"
											}
										/>
										<span className="text-muted-foreground truncate">
											{
												normalizedVideo.element.reframePresets?.find(
													(preset: VideoReframePreset) =>
														preset.id === entry.presetId,
												)?.name
											}
										</span>
									</div>
									<Button
										size="sm"
										variant="ghost"
										className="ml-auto h-7 px-2"
										onClick={() =>
											editor.timeline.removeVideoReframeSwitch({
												trackId: normalizedVideo.trackId,
												elementId: normalizedVideo.element.id,
												switchId: entry.id,
											})
										}
									>
										<Trash2 className="size-3.5" />
									</Button>
								</div>
							))
						)}
					</div>
				</>
			)}
		</PanelView>
	);
}

function ReframePresetGlyph({ name }: { name: string }) {
	const normalized = name.trim().toLowerCase();
	if (normalized.includes("left")) {
		return <SplitFaceGlyph side="left" />;
	}
	if (normalized.includes("right")) {
		return <SplitFaceGlyph side="right" />;
	}
	return (
		<div className="bg-muted flex size-7 items-center justify-center rounded-md border">
			<Focus className="size-3.5" />
		</div>
	);
}

function SplitFaceGlyph({ side }: { side: "left" | "right" }) {
	return (
		<div className="bg-muted relative flex size-7 items-center justify-center overflow-hidden rounded-md border">
			<div className={cn("absolute inset-y-0 w-1/2 bg-primary/10", side === "left" ? "left-0" : "right-0")} />
			<div className="relative h-3.5 w-3.5">
				<div
					className={cn(
						"absolute inset-y-0 overflow-hidden",
						side === "left" ? "left-0 w-1/2" : "right-0 w-1/2",
					)}
				>
					<div
						className={cn(
							"absolute top-0 h-3.5 w-3.5",
							side === "left" ? "left-0" : "left-0 -translate-x-1/2",
						)}
					>
						<UserGlyph />
					</div>
				</div>
				<div className="absolute inset-y-[1px] left-1/2 w-px -translate-x-1/2 bg-foreground/40" />
			</div>
		</div>
	);
}

function UserGlyph() {
	return (
		<svg
			viewBox="0 0 16 16"
			className="h-3.5 w-3.5"
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

	const roundToStepString = (nextValue: number) => formatValue(clampValue(nextValue));

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
						if (
							typeof event.currentTarget.requestPointerLock === "function"
						) {
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
					<span className="min-w-0 flex-1 text-center">{formatValue(value)}</span>
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
