import { useEditor } from "@/hooks/use-editor";
import { useReframeStore } from "@/stores/reframe-store";
import {
	TooltipProvider,
	Tooltip,
	TooltipTrigger,
	TooltipContent,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Maximize2, Plus, WandSparkles } from "lucide-react";
import {
	SplitButton,
	SplitButtonLeft,
	SplitButtonRight,
	SplitButtonSeparator,
} from "@/components/ui/split-button";
import { Slider } from "@/components/ui/slider";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { sliderToZoom, zoomToSlider } from "@/lib/timeline/zoom-utils";
import { snapTimeToFrame } from "@/lib/time";
import { ScenesView } from "../../scenes-view";
import { type TAction, invokeAction } from "@/lib/actions";
import { cn } from "@/utils/ui";
import { useTimelineStore } from "@/stores/timeline-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Bookmark02Icon,
	Delete02Icon,
	ScissorIcon,
	MagnetIcon,
	Link04Icon,
	SearchAddIcon,
	SearchMinusIcon,
	Copy01Icon,
	AlignLeftIcon,
	AlignRightIcon,
	Layers01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	applyPresetToVideoReframeSection,
	buildDefaultVideoSplitScreenBindings,
	getVideoReframeSectionAtTime,
	getVideoReframeSectionByStartTime,
	getVideoSplitScreenSectionAtTime,
	normalizeVideoReframeState,
	splitVideoReframeSectionAtTime,
} from "@/lib/reframe/video-reframe";
import { useEffect, useMemo, useState } from "react";

function InOutPointIcon({ type }: { type: "in" | "out" }) {
	const colorClass = type === "in" ? "bg-emerald-500" : "bg-rose-500";
	const arrowClass =
		type === "in"
			? "border-y-[3px] border-y-transparent border-l-[4px] border-l-emerald-500"
			: "border-y-[3px] border-y-transparent border-r-[4px] border-r-rose-500";
	return (
		<span className="relative inline-flex h-4 w-4 items-center justify-center">
			<span className={`h-4 w-0.5 rounded-full ${colorClass}`} />
			<span className={cn("absolute top-1/2 -translate-y-1/2", arrowClass)} />
		</span>
	);
}

export function TimelineToolbar({
	zoomLevel,
	minZoom,
	setZoomLevel,
	fitToView,
}: {
	zoomLevel: number;
	minZoom: number;
	setZoomLevel: ({ zoom }: { zoom: number }) => void;
	fitToView: () => void;
}) {
	const handleZoom = ({ direction }: { direction: "in" | "out" }) => {
		const newZoomLevel =
			direction === "in"
				? Math.min(
						TIMELINE_CONSTANTS.ZOOM_MAX,
						zoomLevel * TIMELINE_CONSTANTS.ZOOM_BUTTON_FACTOR,
					)
				: Math.max(minZoom, zoomLevel / TIMELINE_CONSTANTS.ZOOM_BUTTON_FACTOR);
		setZoomLevel({ zoom: newZoomLevel });
	};

	return (
		<ScrollArea className="scrollbar-hidden">
			<div className="flex h-10 items-center justify-between border-b px-2 py-1">
				<ToolbarLeftSection />

				<SceneSelector />

				<ToolbarRightSection
					zoomLevel={zoomLevel}
					minZoom={minZoom}
					onZoomChange={(zoom) => setZoomLevel({ zoom })}
					onZoom={handleZoom}
					onFitToView={fitToView}
				/>
			</div>
		</ScrollArea>
	);
}

function ToolbarLeftSection() {
	const editor = useEditor();
	const currentTime = editor.playback.getCurrentTime();
	const currentBookmarked = editor.scenes.isBookmarked({ time: currentTime });
	const timelineViewState = editor.project.getTimelineViewState();
	const hasInPoint = typeof timelineViewState.inPoint === "number";
	const hasOutPoint = typeof timelineViewState.outPoint === "number";

	const handleAction = ({
		action,
		event,
	}: {
		action: TAction;
		event: React.MouseEvent;
	}) => {
		event.stopPropagation();
		invokeAction(action);
	};

	return (
		<div className="flex items-center gap-1">
			<TooltipProvider delayDuration={500}>
				<ToolbarButton
					icon={<HugeiconsIcon icon={ScissorIcon} />}
					tooltip="Split element"
					onClick={({ event }) => handleAction({ action: "split", event })}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={AlignLeftIcon} />}
					tooltip="Split left"
					onClick={({ event }) => handleAction({ action: "split-left", event })}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={AlignRightIcon} />}
					tooltip="Split right"
					onClick={({ event }) =>
						handleAction({ action: "split-right", event })
					}
				/>

				<ToolbarButton
					icon={<WandSparkles className="size-4" />}
					tooltip="Smart cut selected clips"
					onClick={({ event }) =>
						handleAction({ action: "smart-cut-selected", event })
					}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={Copy01Icon} />}
					tooltip="Duplicate element"
					onClick={({ event }) =>
						handleAction({ action: "duplicate-selected", event })
					}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={Delete02Icon} />}
					tooltip="Delete element"
					onClick={({ event }) =>
						handleAction({ action: "delete-selected", event })
					}
				/>

				<div className="bg-border mx-1 h-6 w-px" />

				<Tooltip>
					<ToolbarButton
						icon={<HugeiconsIcon icon={Bookmark02Icon} />}
						isActive={currentBookmarked}
						tooltip={currentBookmarked ? "Remove bookmark" : "Add bookmark"}
						onClick={({ event }) =>
							handleAction({ action: "toggle-bookmark", event })
						}
					/>
				</Tooltip>

				<ToolbarButton
					icon={<InOutPointIcon type="in" />}
					isActive={hasInPoint}
					tooltip="Set in point"
					onClick={({ event }) => handleAction({ action: "set-in-point", event })}
				/>

				<ToolbarButton
					icon={<InOutPointIcon type="out" />}
					isActive={hasOutPoint}
					tooltip="Set out point"
					onClick={({ event }) => handleAction({ action: "set-out-point", event })}
				/>

				<QuickReframeToolbarControl />
			</TooltipProvider>
		</div>
	);
}

type QuickReframePresetKind =
	| "subject"
	| "subject-left"
	| "subject-right"
	| "split-screen";

function getQuickReframePresetKind({
	name,
}: {
	name: string;
}): QuickReframePresetKind | null {
	const normalized = name.trim().toLowerCase();
	if (normalized === "subject left" || normalized.includes("left")) {
		return "subject-left";
	}
	if (normalized === "subject right" || normalized.includes("right")) {
		return "subject-right";
	}
	if (normalized === "subject" || normalized.includes("subject")) {
		return "subject";
	}
	return null;
}

function getQuickReframePresets({
	presetSource,
}: {
	presetSource: Array<{ id: string; name: string }>;
}): Array<{
	id: string;
	name: string;
	kind: QuickReframePresetKind;
}> {
	const kindOrder: QuickReframePresetKind[] = [
		"subject",
		"subject-left",
		"subject-right",
	];
	const presets = presetSource
		.map((preset) => {
			const kind = getQuickReframePresetKind({ name: preset.name });
			return kind
				? {
						id: preset.id,
						name: preset.name,
						kind,
				  }
				: null;
		})
		.filter((preset): preset is NonNullable<typeof preset> => Boolean(preset));

	return kindOrder
		.map((kind) => presets.find((preset) => preset.kind === kind) ?? null)
		.filter((preset): preset is NonNullable<typeof preset> => Boolean(preset));
}

function QuickReframeToolbarControl() {
	const editor = useEditor({
		subscribeTo: ["timeline", "selection", "project", "playback"],
	});
	const [isHovered, setIsHovered] = useState(false);
	const [isPinnedOpen, setIsPinnedOpen] = useState(false);
	const [hoverSuppressed, setHoverSuppressed] = useState(false);
	const selectedSectionStartTimeByElementId = useReframeStore(
		(state) => state.selectedSectionStartTimeByElementId,
	);
	const selectedPresetIdByElementId = useReframeStore(
		(state) => state.selectedPresetIdByElementId,
	);
	const selectedSplitPreviewSlotsByElementId = useReframeStore(
		(state) => state.selectedSplitPreviewSlotsByElementId,
	);
	const clearSelectedPresetId = useReframeStore(
		(state) => state.clearSelectedPresetId,
	);
	const clearSelectedSplitPreviewSlots = useReframeStore(
		(state) => state.clearSelectedSplitPreviewSlots,
	);
	const setSelectedSectionStartTime = useReframeStore(
		(state) => state.setSelectedSectionStartTime,
	);
	const selectedElements = editor.selection.getSelectedElements();
	const playbackTime = editor.playback.getCurrentTime();
	const isPlaying = editor.playback.getIsPlaying();

	const selectedVideo = (() => {
		if (selectedElements.length !== 1) return null;
		const selected = editor.timeline.getElementsWithTracks({
			elements: selectedElements,
		})[0];
		if (!selected || selected.element.type !== "video") return null;
		return {
			trackId: selected.track.id,
			element: normalizeVideoReframeState({ element: selected.element }),
		};
	})();
	const getLatestSelectedVideo = () => {
		if (!selectedVideo) return null;
		const track = editor.timeline.getTrackById({
			trackId: selectedVideo.trackId,
		});
		if (!track || track.type !== "video") return null;
		const element = track.elements.find(
			(entry) => entry.id === selectedVideo.element.id,
		);
		if (!element || element.type !== "video") return null;
		return {
			trackId: track.id,
			element: normalizeVideoReframeState({ element }),
		};
	};
	const projectFps = Math.max(1, editor.project.getActive().settings.fps);
	const getSnappedLocalPlayheadTime = () => {
		const latestSelectedVideo = getLatestSelectedVideo() ?? selectedVideo;
		if (!latestSelectedVideo) return 0;
		return snapTimeToFrame({
			time: Math.max(
				0,
				Math.min(
					latestSelectedVideo.element.duration,
					playbackTime - latestSelectedVideo.element.startTime,
				),
			),
			fps: projectFps,
		});
	};
	const getLatestTargetSection = () => {
		const latestSelectedVideo = getLatestSelectedVideo() ?? selectedVideo;
		if (!latestSelectedVideo) return null;
		const shouldFollowPlayhead = isPlaying;
		const localTime = getSnappedLocalPlayheadTime();
		const selectedSection = getVideoReframeSectionByStartTime({
			element: latestSelectedVideo.element,
			startTime:
				selectedSectionStartTimeByElementId[latestSelectedVideo.element.id] ?? null,
		});
		const isPlayheadWithinSelectedSection = selectedSection
			? localTime >= selectedSection.startTime && localTime <= selectedSection.endTime
			: false;
		if (selectedSection && !shouldFollowPlayhead && isPlayheadWithinSelectedSection) {
			return { selectedVideo: latestSelectedVideo, section: selectedSection };
		}
		const playheadSection = getVideoReframeSectionAtTime({
			element: latestSelectedVideo.element,
			localTime,
		});
		if (!playheadSection) return null;
		return { selectedVideo: latestSelectedVideo, section: playheadSection };
	};

	const quickPresets = useMemo(
		() =>
			selectedVideo
				? getQuickReframePresets({
						presetSource: selectedVideo.element.reframePresets ?? [],
					})
				: [],
		[selectedVideo],
	);
	const activeSection = useMemo(() => {
		if (!selectedVideo) return null;
		const shouldFollowPlayhead = isPlaying;
		const localTime = getSnappedLocalPlayheadTime();
		const selectedSection = getVideoReframeSectionByStartTime({
			element: selectedVideo.element,
			startTime:
				selectedSectionStartTimeByElementId[selectedVideo.element.id] ?? null,
		});
		const isPlayheadWithinSelectedSection = selectedSection
			? localTime >= selectedSection.startTime && localTime <= selectedSection.endTime
			: false;
		if (selectedSection && !shouldFollowPlayhead && isPlayheadWithinSelectedSection) {
			return selectedSection;
		}
		return getVideoReframeSectionAtTime({
			element: selectedVideo.element,
			localTime,
		});
	}, [
		isPlaying,
		playbackTime,
		selectedSectionStartTimeByElementId,
		selectedVideo,
	]);
	const activeSplitSection = useMemo(() => {
		if (!selectedVideo || !activeSection) return null;
		const section = getVideoSplitScreenSectionAtTime({
			element: selectedVideo.element,
			localTime: activeSection.startTime,
		});
		return section?.enabled !== false ? section : null;
	}, [activeSection, selectedVideo]);
	const previewSelectedPresetId =
		selectedVideo && !isPlaying
			? (selectedPresetIdByElementId[selectedVideo.element.id] ?? null)
			: null;
	const previewHasSplitSelection =
		selectedVideo && !isPlaying
			? Boolean(
					selectedSplitPreviewSlotsByElementId[selectedVideo.element.id]?.length,
				)
			: false;
	const activeAngleKey = previewHasSplitSelection
		? "__split__"
		: previewSelectedPresetId
			? previewSelectedPresetId
			: activeSplitSection
				? "__split__"
				: (activeSection?.presetId ?? null);
	const expanded = isPinnedOpen || (isHovered && !hoverSuppressed);

	const clearPreviewOverrides = ({ elementId }: { elementId: string }) => {
		clearSelectedPresetId({ elementId });
		clearSelectedSplitPreviewSlots({ elementId });
	};

	const disableSplitAtSectionStart = ({
		trackId,
		element,
		sectionStartTime,
	}: {
		trackId: string;
		element: ReturnType<typeof normalizeVideoReframeState>;
		sectionStartTime: number;
	}) => {
		const activeSplit = getVideoSplitScreenSectionAtTime({
			element,
			localTime: sectionStartTime,
		});
		if (!element.splitScreen || activeSplit?.enabled === false) {
			return;
		}
		editor.timeline.upsertVideoSplitScreenSection({
			trackId,
			elementId: element.id,
			time: sectionStartTime,
			enabled: false,
			slots: activeSplit?.slots ?? element.splitScreen.slots,
		});
	};

	const applySplitScreenToTargetSection = () => {
		const target = getLatestTargetSection();
		if (!target) return;
		clearPreviewOverrides({ elementId: target.selectedVideo.element.id });
		const defaultSlots = buildDefaultVideoSplitScreenBindings({
			layoutPreset: "top-bottom",
			presets: target.selectedVideo.element.reframePresets ?? [],
		});
		const existingSplitSection = getVideoSplitScreenSectionAtTime({
			element: target.selectedVideo.element,
			localTime: target.section.startTime,
		});
		const splitScreen = target.selectedVideo.element.splitScreen;
		if (!splitScreen) {
			editor.timeline.updateVideoSplitScreen({
				trackId: target.selectedVideo.trackId,
				elementId: target.selectedVideo.element.id,
				updates: {
					enabled: false,
					layoutPreset: "top-bottom",
					slots: defaultSlots,
					sections: [],
				},
			});
		} else if (splitScreen.enabled) {
			editor.timeline.updateVideoSplitScreen({
				trackId: target.selectedVideo.trackId,
				elementId: target.selectedVideo.element.id,
				updates: {
					enabled: false,
				},
			});
		}
		editor.timeline.upsertVideoSplitScreenSection({
			trackId: target.selectedVideo.trackId,
			elementId: target.selectedVideo.element.id,
			time: target.section.startTime,
			enabled: true,
			slots: existingSplitSection?.slots ?? defaultSlots,
		});
		setSelectedSectionStartTime({
			elementId: target.selectedVideo.element.id,
			startTime: target.section.startTime,
		});
	};

	useEffect(() => {
		if (!selectedVideo) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (
				target &&
				(target instanceof HTMLInputElement ||
					target instanceof HTMLTextAreaElement ||
					target.isContentEditable)
			) {
				return;
			}

			if (event.code === "Backquote") {
				event.preventDefault();
				const localTime = getSnappedLocalPlayheadTime();
				const latestSelectedVideo = getLatestSelectedVideo() ?? selectedVideo;
				if (!latestSelectedVideo) return;
				clearPreviewOverrides({ elementId: latestSelectedVideo.element.id });
				const nextSwitches = splitVideoReframeSectionAtTime({
					element: latestSelectedVideo.element,
					localTime,
				});
				editor.timeline.updateElements({
					updates: [
						{
							trackId: latestSelectedVideo.trackId,
							elementId: latestSelectedVideo.element.id,
							updates: {
								reframeSwitches: nextSwitches,
							},
						},
					],
				});
				setSelectedSectionStartTime({
					elementId: latestSelectedVideo.element.id,
					startTime: localTime,
				});
				return;
			}

			if (!["Digit1", "Digit2", "Digit3", "Digit4"].includes(event.code)) {
				return;
			}

			const presetIndex = Number.parseInt(event.code.slice(-1), 10) - 1;
			const preset = quickPresets[presetIndex];
			if (!preset) return;

			event.preventDefault();
			const targetSection = getLatestTargetSection();
			if (!targetSection) return;
			clearPreviewOverrides({ elementId: targetSection.selectedVideo.element.id });
			disableSplitAtSectionStart({
				trackId: targetSection.selectedVideo.trackId,
				element: targetSection.selectedVideo.element,
				sectionStartTime: targetSection.section.startTime,
			});
			const nextReframeState = applyPresetToVideoReframeSection({
				element: targetSection.selectedVideo.element,
				sectionStartTime: targetSection.section.startTime,
				presetId: preset.id,
			});
			editor.timeline.updateElements({
				updates: [
					{
						trackId: targetSection.selectedVideo.trackId,
						elementId: targetSection.selectedVideo.element.id,
						updates: nextReframeState,
					},
				],
			});
			setSelectedSectionStartTime({
				elementId: targetSection.selectedVideo.element.id,
				startTime: targetSection.section.startTime,
			});
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		editor.timeline,
		getLatestSelectedVideo,
		getLatestTargetSection,
		getSnappedLocalPlayheadTime,
		isPlaying,
		playbackTime,
		quickPresets,
		selectedVideo,
		setSelectedSectionStartTime,
		clearSelectedPresetId,
		clearSelectedSplitPreviewSlots,
	]);

	if (!selectedVideo) {
		return null;
	}

	return (
		<fieldset
			aria-label="Quick reframe controls"
			className="ml-1 min-w-0 border-0 p-0"
			onMouseEnter={() => {
				setIsHovered(true);
				if (hoverSuppressed) {
					setHoverSuppressed(false);
				}
			}}
			onMouseLeave={() => {
				setIsHovered(false);
				setHoverSuppressed(false);
			}}
		>
			<div className="flex items-center gap-1">
				<div className="bg-border h-6 w-px" />
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={expanded ? "secondary" : "text"}
							size="icon"
							className="rounded-sm"
							onClick={() => {
								if (isPinnedOpen) {
									setIsPinnedOpen(false);
									setHoverSuppressed(true);
									return;
								}
								setIsPinnedOpen(true);
								setHoverSuppressed(false);
							}}
						>
							<ReframeTrayIcon className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>Quick reframe angles</TooltipContent>
				</Tooltip>
				{expanded && (
					<div className="bg-background flex items-center gap-1 rounded-sm border px-1 py-0.5">
						{isPinnedOpen && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="text"
										size="icon"
										className="h-7 w-7 rounded-sm"
										onClick={() => {
											setIsPinnedOpen(false);
											setHoverSuppressed(true);
										}}
									>
										<ChevronLeft className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Collapse reframe tray</TooltipContent>
							</Tooltip>
						)}
						{quickPresets.length === 0 ? (
							<div className="text-muted-foreground px-2 text-xs">
								No detected angles
							</div>
						) : (
							<>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="text"
											size="icon"
											className="h-7 w-7 rounded-sm"
											onClick={() => {
												const localTime = getSnappedLocalPlayheadTime();
												const latestSelectedVideo =
													getLatestSelectedVideo() ?? selectedVideo;
												if (!latestSelectedVideo) return;
												clearPreviewOverrides({
													elementId: latestSelectedVideo.element.id,
												});
												const nextSwitches = splitVideoReframeSectionAtTime({
													element: latestSelectedVideo.element,
													localTime,
												});
												editor.timeline.updateElements({
													updates: [
														{
															trackId: latestSelectedVideo.trackId,
															elementId: latestSelectedVideo.element.id,
															updates: {
																reframeSwitches: nextSwitches,
															},
														},
													],
												});
												setSelectedSectionStartTime({
													elementId: selectedVideo.element.id,
													startTime: localTime,
												});
											}}
										>
											<Plus className="size-4" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>Split section at playhead</TooltipContent>
								</Tooltip>
								<div className="bg-border h-5 w-px" />
								{quickPresets.map((preset) => (
									<Tooltip key={preset.id}>
										<TooltipTrigger asChild>
											<Button
												variant={
													activeAngleKey === preset.id ? "secondary" : "text"
												}
												size="icon"
												className="h-7 w-7 rounded-sm"
												onClick={() => {
													const target = getLatestTargetSection();
													if (!target) return;
													clearPreviewOverrides({
														elementId: target.selectedVideo.element.id,
													});
													disableSplitAtSectionStart({
														trackId: target.selectedVideo.trackId,
														element: target.selectedVideo.element,
														sectionStartTime: target.section.startTime,
													});
													const nextReframeState =
														applyPresetToVideoReframeSection({
															element: target.selectedVideo.element,
															sectionStartTime: target.section.startTime,
															presetId: preset.id,
														});
													editor.timeline.updateElements({
														updates: [
															{
																trackId: target.selectedVideo.trackId,
																elementId: target.selectedVideo.element.id,
																updates: nextReframeState,
															},
														],
													});
													setSelectedSectionStartTime({
														elementId: selectedVideo.element.id,
														startTime: target.section.startTime,
													});
												}}
											>
												<QuickReframePresetIcon kind={preset.kind} />
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{activeSection
												? `Apply ${preset.name} to selected section`
												: preset.name}
										</TooltipContent>
									</Tooltip>
								))}
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant={activeAngleKey === "__split__" ? "secondary" : "text"}
											size="icon"
											className="h-7 w-7 rounded-sm"
											onClick={applySplitScreenToTargetSection}
										>
											<QuickReframePresetIcon kind="split-screen" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{activeSplitSection
											? "Apply split screen to selected section"
											: "Split screen"}
									</TooltipContent>
								</Tooltip>
							</>
						)}
					</div>
				)}
			</div>
		</fieldset>
	);
}

function ReframeTrayIcon({ className }: { className?: string }) {
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
			<rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" />
			<circle cx="8" cy="6" r="1.65" />
			<path d="M5.2 11.8c.55-1.55 1.7-2.35 2.8-2.35s2.25.8 2.8 2.35" />
		</svg>
	);
}

function QuickReframePresetIcon({ kind }: { kind: QuickReframePresetKind }) {
	if (kind === "subject") {
		return <PersonCameraGlyph className="h-4 w-4" />;
	}
	if (kind === "split-screen") {
		return <SplitScreenGlyph className="h-4 w-4" />;
	}

	return (
		<div className="relative h-4 w-4">
			<div
				className={cn(
					"absolute inset-y-0 overflow-hidden",
					kind === "subject-left" ? "left-0 w-1/2" : "right-0 w-1/2",
				)}
			>
				<PersonCameraGlyph
					className={cn(
						"absolute top-0 h-4 w-4",
						kind === "subject-left" ? "left-0" : "left-0 -translate-x-1/2",
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

function PersonCameraGlyph({
	className,
}: {
	className?: string;
}) {
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

function SceneSelector() {
	const editor = useEditor();
	const currentScene = editor.scenes.getActiveScene();

	return (
		<div>
			<SplitButton className="border-foreground/10 border">
				<SplitButtonLeft>{currentScene?.name || "No Scene"}</SplitButtonLeft>
				<SplitButtonSeparator />
				<ScenesView>
					<SplitButtonRight onClick={() => {}}>
						<HugeiconsIcon icon={Layers01Icon} className="size-4" />
					</SplitButtonRight>
				</ScenesView>
			</SplitButton>
		</div>
	);
}

function ToolbarRightSection({
	zoomLevel,
	minZoom,
	onZoomChange,
	onZoom,
	onFitToView,
}: {
	zoomLevel: number;
	minZoom: number;
	onZoomChange: (zoom: number) => void;
	onZoom: (options: { direction: "in" | "out" }) => void;
	onFitToView: () => void;
}) {
	const {
		snappingEnabled,
		rippleEditingEnabled,
		toggleSnapping,
		toggleRippleEditing,
	} = useTimelineStore();

	return (
		<div className="flex items-center gap-1">
			<TooltipProvider delayDuration={500}>
				<ToolbarButton
					icon={<HugeiconsIcon icon={MagnetIcon} />}
					isActive={snappingEnabled}
					tooltip="Auto snapping"
					onClick={() => toggleSnapping()}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={Link04Icon} className="scale-110" />}
					isActive={rippleEditingEnabled}
					tooltip="Ripple editing"
					onClick={() => toggleRippleEditing()}
				/>
			</TooltipProvider>
			<div className="bg-border mx-1 h-6 w-px" />

			<div className="flex items-center gap-1">
				<Button
					variant="text"
					size="icon"
					onClick={() => onZoom({ direction: "out" })}
				>
					<HugeiconsIcon icon={SearchMinusIcon} />
				</Button>
				<Slider
					className="w-28"
					value={[zoomToSlider({ zoomLevel, minZoom })]}
					onValueChange={(values) =>
						onZoomChange(sliderToZoom({ sliderPosition: values[0], minZoom }))
					}
					min={0}
					max={1}
					step={0.005}
				/>
				<Button
					variant="text"
					size="icon"
					onClick={() => onZoom({ direction: "in" })}
				>
					<HugeiconsIcon icon={SearchAddIcon} />
				</Button>
				<TooltipProvider delayDuration={200}>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button variant="text" size="icon" onClick={onFitToView}>
								<Maximize2 className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Fit to view</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			</div>
		</div>
	);
}

function ToolbarButton({
	icon,
	tooltip,
	onClick,
	disabled,
	isActive,
}: {
	icon: React.ReactNode;
	tooltip: string;
	onClick: ({ event }: { event: React.MouseEvent }) => void;
	disabled?: boolean;
	isActive?: boolean;
}) {
	return (
		<Tooltip delayDuration={200}>
			<TooltipTrigger asChild>
				<Button
					variant={isActive ? "secondary" : "text"}
					size="icon"
					disabled={disabled}
					onClick={(event) => onClick({ event })}
					className={cn(
						"rounded-sm",
						disabled ? "cursor-not-allowed opacity-50" : "",
					)}
				>
					{icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	);
}
