"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Delete02Icon,
	TaskAdd02Icon,
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeLowIcon,
	VolumeHighIcon,
	VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "../../../ui/context-menu";
import { useTimelineZoom } from "@/hooks/timeline/use-timeline-zoom";
import {
	useState,
	useRef,
	useCallback,
	useEffect,
	useMemo,
} from "react";
import { TimelineTrackContent } from "./timeline-track";
import { TimelinePlayhead } from "./timeline-playhead";
import { SelectionBox } from "../../selection-box";
import { useSelectionBox } from "@/hooks/timeline/use-selection-box";
import { SnapIndicator } from "./snap-indicator";
import type { SnapPoint } from "@/lib/timeline/snap-utils";
import type { TimelineTrack } from "@/types/timeline";
import {
	TIMELINE_CONSTANTS,
	TRACK_ICONS,
} from "@/constants/timeline-constants";
import { useElementInteraction } from "@/hooks/timeline/element/use-element-interaction";
import {
	getTrackHeight,
	getCumulativeHeightBefore,
	getTotalTracksHeight,
	canTracktHaveAudio,
	canTrackBeHidden,
	getTimelineZoomMin,
	getTimelinePaddingPx,
	isMainTrack,
} from "@/lib/timeline";
import { TimelineToolbar } from "./timeline-toolbar";
import { useScrollSync } from "@/hooks/timeline/use-scroll-sync";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { useTimelineSeek } from "@/hooks/timeline/use-timeline-seek";
import { useTimelineDragDrop } from "@/hooks/timeline/use-timeline-drag-drop";
import { TimelineRuler } from "./timeline-ruler";
import { TimelineBookmarksRow } from "./bookmarks";
import { useBookmarkDrag } from "@/hooks/timeline/use-bookmark-drag";
import { useEdgeAutoScroll } from "@/hooks/timeline/use-edge-auto-scroll";
import { useTimelineStore } from "@/stores/timeline-store";
import { useEditor } from "@/hooks/use-editor";
import { useTimelinePlayhead } from "@/hooks/timeline/use-timeline-playhead";
import { DragLine } from "./drag-line";
import { invokeAction } from "@/lib/actions";
import { ListChecks } from "lucide-react";
import {
	type TimelineVisualModel,
	mapVisualTimeToRealTime,
} from "@/lib/transcript-editor/visual-timeline";

export function Timeline() {
	const tracksContainerHeight = { min: 0, max: 800 };
	const { snappingEnabled, fitViewRequestId } = useTimelineStore();
	const { clearElementSelection, setElementSelection } = useElementSelection();
	const editor = useEditor({ subscribeTo: ["timeline", "project"] });
	const timeline = editor.timeline;
	const tracks = timeline.getTracks();
	const seek = (time: number) => editor.playback.seek({ time });

	// refs
	const timelineRef = useRef<HTMLDivElement>(null);
	const timelineHeaderRef = useRef<HTMLDivElement>(null);
	const rulerRef = useRef<HTMLDivElement>(null);
	const tracksContainerRef = useRef<HTMLDivElement>(null);
	const tracksScrollRef = useRef<HTMLDivElement>(null);
	const trackLabelsRef = useRef<HTMLDivElement>(null);
	const playheadRef = useRef<HTMLDivElement>(null);
	const trackLabelsScrollRef = useRef<HTMLDivElement>(null);
	const mixerScrollRef = useRef<HTMLDivElement>(null);

	// state
	const [isResizing, setIsResizing] = useState(false);
	const [mixerCollapsed, setMixerCollapsed] = useState(false);
	const [currentSnapPoint, setCurrentSnapPoint] = useState<SnapPoint | null>(
		null,
	);
	const [trackLevels, setTrackLevels] = useState<
		Record<string, { peak: number; rmsDb: number; silent: boolean }>
	>({});
	const [outputLevel, setOutputLevel] = useState<{
		peak: number;
		rmsDb: number;
		silent: boolean;
	}>({
		peak: 0,
		rmsDb: -120,
		silent: true,
	});

	const handleSnapPointChange = useCallback((snapPoint: SnapPoint | null) => {
		setCurrentSnapPoint(snapPoint);
	}, []);
	const handleResizeStateChange = useCallback(
		({ isResizing: nextIsResizing }: { isResizing: boolean }) => {
			setIsResizing(nextIsResizing);
			if (!nextIsResizing) {
				setCurrentSnapPoint(null);
			}
		},
		[],
	);

	const timelineDuration = timeline.getTotalDuration() || 0;
	const visualTimeline = useMemo<TimelineVisualModel>(
		() => ({
			cuts: [],
			totalRemovedDuration: 0,
			totalVisualDuration: timelineDuration,
		}),
		[timelineDuration],
	);
	const visualPlayheadTime = editor.playback.getCurrentTime();
	const minZoomLevel = getTimelineZoomMin({
		duration: visualTimeline.totalVisualDuration,
		containerWidth: tracksContainerRef.current?.clientWidth,
	});

	const savedViewState = editor.project.getTimelineViewState();

	const { zoomLevel, setZoomLevel, handleWheel, saveScrollPosition } =
		useTimelineZoom({
			containerRef: timelineRef,
			minZoom: minZoomLevel,
			initialZoom: savedViewState?.zoomLevel,
			initialScrollLeft: savedViewState?.scrollLeft,
			initialPlayheadTime: savedViewState?.playheadTime,
			tracksScrollRef,
			rulerScrollRef: tracksScrollRef,
			playheadDisplayTime: visualPlayheadTime,
		});

	const {
		dragState,
		dragDropTarget,
		handleElementMouseDown,
		handleElementClick,
		lastMouseXRef,
	} = useElementInteraction({
		zoomLevel,
		timelineRef,
		tracksContainerRef,
		tracksScrollRef,
		headerRef: timelineHeaderRef,
		snappingEnabled,
		onSnapPointChange: handleSnapPointChange,
		mapVisualTimeToRealTime: (time) =>
			mapVisualTimeToRealTime({ time, model: visualTimeline }),
	});

	const {
		dragState: bookmarkDragState,
		handleBookmarkMouseDown,
		lastMouseXRef: bookmarkLastMouseXRef,
	} = useBookmarkDrag({
		zoomLevel,
		scrollRef: tracksScrollRef,
		snappingEnabled,
		onSnapPointChange: handleSnapPointChange,
		mapVisualTimeToRealTime: (time) =>
			mapVisualTimeToRealTime({ time, model: visualTimeline }),
	});

	const { handleRulerMouseDown: handlePlayheadRulerMouseDown } =
		useTimelinePlayhead({
			zoomLevel,
			rulerRef,
			rulerScrollRef: tracksScrollRef,
			tracksScrollRef,
			playheadRef,
			displayTime: visualPlayheadTime,
			displayDuration: visualTimeline.totalVisualDuration,
			mapVisualTimeToRealTime: (time) =>
				mapVisualTimeToRealTime({ time, model: visualTimeline }),
		});

	const {
		isDragOver,
		dropTarget,
		dragElementType,
		dragElementDuration,
		dragProps,
	} = useTimelineDragDrop({
		containerRef: tracksContainerRef,
		headerRef: timelineHeaderRef,
		zoomLevel,
	});

	const {
		selectionBox,
		handleMouseDown: handleSelectionMouseDown,
		isSelecting,
		shouldIgnoreClick,
	} = useSelectionBox({
		containerRef: tracksContainerRef,
		tracks,
		onSelectionComplete: (elements) => {
			setElementSelection({ elements });
		},
		tracksScrollRef,
		zoomLevel,
		visualModel: visualTimeline,
	});

	const containerWidth = tracksContainerRef.current?.clientWidth || 1000;
	const contentWidth =
		visualTimeline.totalVisualDuration *
		TIMELINE_CONSTANTS.PIXELS_PER_SECOND *
		zoomLevel;
	const paddingPx = getTimelinePaddingPx({
		containerWidth,
		zoomLevel,
		minZoom: minZoomLevel,
	});
	const dynamicTimelineWidth = Math.max(
		contentWidth + paddingPx + TIMELINE_CONSTANTS.START_OFFSET_PX,
		containerWidth,
	);

	useEdgeAutoScroll({
		isActive: bookmarkDragState.isDragging,
		getMouseClientX: () => bookmarkLastMouseXRef.current,
		rulerScrollRef: tracksScrollRef,
		tracksScrollRef,
		contentWidth: dynamicTimelineWidth,
	});

	const showSnapIndicator =
		snappingEnabled &&
		currentSnapPoint !== null &&
		(dragState.isDragging || bookmarkDragState.isDragging || isResizing);

	const {
		handleTracksMouseDown,
		handleTracksClick,
		handleRulerMouseDown,
		handleRulerClick,
	} = useTimelineSeek({
		playheadRef,
		trackLabelsRef,
		rulerScrollRef: tracksScrollRef,
		tracksScrollRef,
		zoomLevel,
		duration: timeline.getTotalDuration(),
		displayDuration: visualTimeline.totalVisualDuration,
		isSelecting,
		clearSelectedElements: clearElementSelection,
		seek,
		mapVisualTimeToRealTime: (time) =>
			mapVisualTimeToRealTime({ time, model: visualTimeline }),
	});

	const fitTimelineToView = useCallback(() => {
		setZoomLevel(minZoomLevel);
		const scrollElement = tracksScrollRef.current;
		if (scrollElement) {
			scrollElement.scrollLeft = 0;
			editor.project.setTimelineViewState({
				viewState: {
					...editor.project.getTimelineViewState(),
					zoomLevel: minZoomLevel,
					scrollLeft: 0,
					playheadTime: editor.playback.getCurrentTime(),
				},
			});
		}
	}, [editor, minZoomLevel, setZoomLevel]);

	useEffect(() => {
		if (fitViewRequestId <= 0) return;
		fitTimelineToView();
	}, [fitViewRequestId, fitTimelineToView]);

	useEffect(() => {
		const handleTrackLevels = (
			event: Event,
		) => {
			const detail = (
				event as CustomEvent<{
					tracks: Array<{
						trackId: string;
						peak: number;
						rmsDb: number;
						silent: boolean;
					}>;
				}>
			).detail;
			if (!detail) return;
			setTrackLevels((current) => {
				const next: Record<
					string,
					{ peak: number; rmsDb: number; silent: boolean }
				> = {};
				for (const track of detail.tracks) {
					next[track.trackId] = {
						peak: track.peak,
						rmsDb: track.rmsDb,
						silent: track.silent,
					};
				}
				return Object.keys(next).length === 0 ? current : next;
			});
		};
		window.addEventListener("opencut:audio-track-levels", handleTrackLevels);
		return () => {
			window.removeEventListener(
				"opencut:audio-track-levels",
				handleTrackLevels,
			);
		};
	}, []);

	useEffect(() => {
		const handleOutputLevel = (
			event: Event,
		) => {
			const detail = (
				event as CustomEvent<{
					peak: number;
					rmsDb: number;
					silent: boolean;
				}>
			).detail;
			if (!detail) return;
			setOutputLevel({
				peak: detail.peak,
				rmsDb: detail.rmsDb,
				silent: detail.silent,
			});
		};
		window.addEventListener("opencut:audio-output-level", handleOutputLevel);
		return () => {
			window.removeEventListener(
				"opencut:audio-output-level",
				handleOutputLevel,
			);
		};
	}, []);

	useScrollSync({
		tracksScrollRef,
		trackLabelsScrollRef,
		mixerScrollRef,
	});

	const timelineHeaderHeight =
		timelineHeaderRef.current?.getBoundingClientRect().height ?? 0;

	return (
		<section
			data-editor-selection-root="timeline"
			className={
				"panel bg-background relative flex h-full flex-col overflow-hidden rounded-sm border"
			}
			{...dragProps}
			aria-label="Timeline"
		>
			<TimelineToolbar
				zoomLevel={zoomLevel}
				minZoom={minZoomLevel}
				setZoomLevel={({ zoom }) => setZoomLevel(zoom)}
				fitToView={fitTimelineToView}
			/>

			<div
				className="relative flex flex-1 flex-col overflow-hidden"
				ref={timelineRef}
			>
				<SnapIndicator
					snapPoint={currentSnapPoint}
					zoomLevel={zoomLevel}
					tracks={tracks}
					visualModel={visualTimeline}
					timelineRef={timelineRef}
					trackLabelsRef={trackLabelsRef}
					tracksScrollRef={tracksScrollRef}
					isVisible={showSnapIndicator}
				/>
				<div className="flex flex-1 overflow-hidden">
					<div className="bg-background flex w-28 shrink-0 flex-col border-r">
						<div className="bg-background flex h-4 items-center justify-between px-3">
							<span className="opacity-0">.</span>
						</div>
						<div className="bg-background flex h-4 items-center justify-between px-3">
							<span className="opacity-0">.</span>
						</div>
						{tracks.length > 0 && (
							<div
								ref={trackLabelsRef}
								className="bg-background flex-1 overflow-y-auto"
								style={{ paddingTop: TIMELINE_CONSTANTS.PADDING_TOP_PX }}
							>
								<ScrollArea className="size-full" ref={trackLabelsScrollRef}>
									<div className="flex flex-col gap-1">
										{tracks.map((track) => (
											<div
												key={track.id}
												className="group flex items-center px-3"
												style={{
													height: `${getTrackHeight({ type: track.type })}px`,
												}}
											>
												<div className="flex min-w-0 flex-1 items-center justify-end gap-2">
													{trackHasLinkedCaptions({ track }) && (
														<button
															type="button"
															className="text-muted-foreground hover:text-foreground cursor-pointer"
															onClick={(event) => {
																event.stopPropagation();
																invokeAction("select-all-captions", {
																	trackId: track.id,
																});
															}}
															title="Select all captions"
															aria-label="Select all captions"
														>
															<ListChecks className="size-3.5" />
														</button>
													)}
													{process.env.NODE_ENV === "development" &&
														isMainTrack(track) && (
															<div className="bg-red-500 size-1.5 rounded-full" />
														)}
													{canTracktHaveAudio(track) && (
														<AudioTrackVolumeScrubber
															muted={track.muted}
															volume={track.volume ?? 1}
															onChange={(nextVolume, options) => {
																editor.timeline.setAudioTrackVolume({
																	trackId: track.id,
																	volume: nextVolume,
																	pushHistory: options?.pushHistory ?? true,
																});
																const latestTrack =
																	editor.timeline.getTrackById({
																		trackId: track.id,
																	});
																if (
																	nextVolume > 0.001 &&
																	latestTrack &&
																	canTracktHaveAudio(latestTrack) &&
																	latestTrack.muted
																) {
																	editor.timeline.toggleTrackMute({
																		trackId: track.id,
																	});
																}
															}}
														/>
													)}
													{canTrackBeHidden(track) && (
														<TrackToggleIcon
															isOff={track.hidden}
															icons={{
																on: ViewIcon,
																off: ViewOffSlashIcon,
															}}
															onClick={() =>
																editor.timeline.toggleTrackVisibility({
																	trackId: track.id,
																})
															}
														/>
													)}
													<TrackIcon track={track} />
												</div>
											</div>
										))}
									</div>
								</ScrollArea>
							</div>
						)}
					</div>

					<div
						className="relative flex flex-1 flex-col overflow-hidden"
						ref={tracksContainerRef}
					>
						<SelectionBox
							startPos={selectionBox?.startPos || null}
							currentPos={selectionBox?.currentPos || null}
							containerRef={tracksContainerRef}
							isActive={selectionBox?.isActive || false}
						/>
						<DragLine
							dropTarget={dropTarget}
							tracks={timeline.getTracks()}
							isVisible={isDragOver}
							visualModel={visualTimeline}
							zoomLevel={zoomLevel}
							dragElementType={dragElementType}
							dragElementDuration={dragElementDuration}
							headerHeight={timelineHeaderHeight}
						/>
						<DragLine
							dropTarget={dragDropTarget}
							tracks={timeline.getTracks()}
							isVisible={dragState.isDragging}
							visualModel={visualTimeline}
							headerHeight={timelineHeaderHeight}
						/>
						<ScrollArea
							className="size-full overflow-y-hidden"
							ref={tracksScrollRef}
							onMouseDown={(event) => {
								const isDirectTarget = event.target === event.currentTarget;
								if (!isDirectTarget) return;
								event.stopPropagation();
								handleTracksMouseDown(event);
								handleSelectionMouseDown(event);
							}}
							onClick={(event) => {
								const isDirectTarget = event.target === event.currentTarget;
								if (!isDirectTarget) return;
								event.stopPropagation();
								handleTracksClick(event);
							}}
							onWheel={(event) => {
								if (
									event.shiftKey ||
									Math.abs(event.deltaX) > Math.abs(event.deltaY)
								) {
									return;
								}
								handleWheel(event);
							}}
							onScroll={() => {
								saveScrollPosition();
							}}
						>
							<div
								className="relative"
								style={{
									width: `${dynamicTimelineWidth}px`,
								}}
							>
								<div
									aria-hidden="true"
									className="pointer-events-none absolute top-0 bottom-0 left-0 z-[1]"
									style={{
										width: `${TIMELINE_CONSTANTS.START_OFFSET_PX}px`,
										borderRight:
											"1px solid color-mix(in oklab, var(--foreground) 10%, transparent)",
									}}
								/>
								<div
									ref={timelineHeaderRef}
									className="bg-background sticky top-0 flex flex-col"
								>
									<TimelineRuler
										zoomLevel={zoomLevel}
										dynamicTimelineWidth={dynamicTimelineWidth}
										displayDuration={visualTimeline.totalVisualDuration}
										mapRealTimeToVisualTime={(time) => time}
										mapVisualTimeToRealTime={(time) =>
											mapVisualTimeToRealTime({ time, model: visualTimeline })
										}
										rulerRef={rulerRef}
										tracksScrollRef={tracksScrollRef}
										onSnapPointChange={handleSnapPointChange}
										handleWheel={handleWheel}
										handleTimelineContentClick={handleRulerClick}
										handleRulerTrackingMouseDown={handleRulerMouseDown}
										handleRulerMouseDown={handlePlayheadRulerMouseDown}
									/>
									<TimelineBookmarksRow
										zoomLevel={zoomLevel}
										dynamicTimelineWidth={dynamicTimelineWidth}
										visualModel={visualTimeline}
										dragState={bookmarkDragState}
										onBookmarkMouseDown={handleBookmarkMouseDown}
										handleWheel={handleWheel}
										handleTimelineContentClick={handleRulerClick}
										handleRulerTrackingMouseDown={handleRulerMouseDown}
										handleRulerMouseDown={handlePlayheadRulerMouseDown}
									/>
								</div>
									<TimelinePlayhead
										zoomLevel={zoomLevel}
										displayTime={visualPlayheadTime}
										displayDuration={visualTimeline.totalVisualDuration}
										mapVisualTimeToRealTime={(time) =>
											mapVisualTimeToRealTime({ time, model: visualTimeline })
										}
										rulerRef={rulerRef}
									rulerScrollRef={tracksScrollRef}
									tracksScrollRef={tracksScrollRef}
									timelineRef={timelineRef}
									playheadRef={playheadRef}
									isSnappingToPlayhead={
										showSnapIndicator && currentSnapPoint?.type === "playhead"
									}
								/>
								<div
									className="relative"
									style={{
										height: `${Math.max(
											tracksContainerHeight.min,
											Math.min(
												tracksContainerHeight.max,
												getTotalTracksHeight({ tracks }),
											),
										)}px`,
									}}
								>
									{tracks.length === 0 ? (
										<div />
									) : (
										tracks.map((track, index) => (
											<ContextMenu key={track.id}>
												<ContextMenuTrigger asChild>
													<div
														className="absolute right-0 left-0"
														style={{
															top: `${getCumulativeHeightBefore({
																tracks,
																trackIndex: index,
															})}px`,
															height: `${getTrackHeight({
																type: track.type,
															})}px`,
														}}
													>
														<TimelineTrackContent
															track={track}
															tracks={tracks}
															zoomLevel={zoomLevel}
															visualModel={visualTimeline}
															dragState={dragState}
															rulerScrollRef={tracksScrollRef}
															tracksScrollRef={tracksScrollRef}
															lastMouseXRef={lastMouseXRef}
															onSnapPointChange={handleSnapPointChange}
															onResizeStateChange={handleResizeStateChange}
															onElementMouseDown={handleElementMouseDown}
															onElementClick={handleElementClick}
															onTrackMouseDown={(event) => {
																handleSelectionMouseDown(event);
																handleTracksMouseDown(event);
															}}
															onTrackClick={handleTracksClick}
															shouldIgnoreClick={shouldIgnoreClick}
														/>
													</div>
												</ContextMenuTrigger>
												<ContextMenuContent className="w-40">
													<ContextMenuItem
														icon={<HugeiconsIcon icon={TaskAdd02Icon} />}
														onClick={(e) => {
															e.stopPropagation();
															invokeAction("paste-copied");
														}}
													>
														Paste elements
													</ContextMenuItem>
													<ContextMenuItem
														onClick={(e) => {
															e.stopPropagation();
															timeline.toggleTrackMute({
																trackId: track.id,
															});
														}}
													>
														<HugeiconsIcon icon={VolumeHighIcon} />
														<span>
															{canTracktHaveAudio(track) && track.muted
																? "Unmute track"
																: "Mute track"}
														</span>
													</ContextMenuItem>
													<ContextMenuItem
														onClick={(e) => {
															e.stopPropagation();
															timeline.toggleTrackVisibility({
																trackId: track.id,
															});
														}}
													>
														<HugeiconsIcon icon={ViewIcon} />
														<span>
															{canTrackBeHidden(track) && track.hidden
																? "Show track"
																: "Hide track"}
														</span>
													</ContextMenuItem>
													<ContextMenuItem
														onClick={(e) => {
															e.stopPropagation();
															timeline.removeTrack({
																trackId: track.id,
															});
														}}
														variant="destructive"
													>
														<HugeiconsIcon icon={Delete02Icon} />
														Delete track
													</ContextMenuItem>
												</ContextMenuContent>
											</ContextMenu>
										))
									)}
								</div>
							</div>
						</ScrollArea>
					</div>
					<div className="relative w-[4.25rem] shrink-0 border-l bg-background">
						<div className="pointer-events-none absolute top-0 right-full bottom-0 z-0 w-[13.75rem] overflow-hidden">
							<div
								className={`pointer-events-auto flex h-full w-[13.75rem] flex-col border-l bg-background shadow-sm transition-[transform,opacity] duration-200 ease-out will-change-transform ${
									mixerCollapsed
										? "translate-x-3 opacity-0"
										: "translate-x-0 opacity-100"
								}`}
							>
								<div
									className="bg-background flex items-center border-b px-3"
									style={{ height: `${timelineHeaderHeight || 48}px` }}
								>
									<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em]">
										Levels
									</div>
								</div>
								<div className="min-h-0 flex-1 pb-2">
									<ScrollArea className="h-full min-h-0" ref={mixerScrollRef}>
										<div
											className="flex flex-col gap-1 p-2 pr-1 pb-3"
											style={{ paddingTop: TIMELINE_CONSTANTS.PADDING_TOP_PX }}
										>
											{tracks
												.filter((track) => canTracktHaveAudio(track))
												.map((track) => (
													<TrackLevelStrip
														key={track.id}
														track={track}
														level={trackLevels[track.id]}
														height={getTrackHeight({ type: track.type })}
													/>
												))}
										</div>
									</ScrollArea>
								</div>
							</div>
						</div>
						{!mixerCollapsed && (
							<div className="pointer-events-none absolute top-0 bottom-0 left-0 z-10 border-l" />
						)}
						<div
							className="bg-background relative z-10 flex items-center justify-center border-b"
							style={{ height: `${timelineHeaderHeight || 48}px` }}
						>
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground flex size-full items-center justify-center"
								onClick={() => setMixerCollapsed((current) => !current)}
								aria-label={
									mixerCollapsed ? "Open mixer rail" : "Collapse mixer rail"
								}
								title={
									mixerCollapsed ? "Open mixer rail" : "Collapse mixer rail"
								}
							>
								<HugeiconsIcon
									icon={mixerCollapsed ? ArrowLeft01Icon : ArrowRight01Icon}
									className="size-4"
								/>
							</button>
						</div>
						<div className="relative z-10 h-full pb-2">
							<div className="h-full p-2 pl-1 pb-3">
								<MasterLevelStrip level={outputLevel} />
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function trackHasLinkedCaptions({ track }: { track: TimelineTrack }) {
	if (track.type !== "text") return false;
	return track.elements.some(
		(element) =>
			element.type === "text" &&
			element.name.startsWith("Caption ") &&
			element.captionStyle?.linkedToCaptionGroup !== false,
	);
}

function TrackIcon({ track }: { track: TimelineTrack }) {
	return <>{TRACK_ICONS[track.type]}</>;
}

function TrackToggleIcon({
	isOff,
	icons,
	onClick,
}: {
	isOff: boolean;
	icons: {
		on: IconSvgElement;
		off: IconSvgElement;
	};
	onClick: () => void;
}) {
	return (
		<>
			{isOff ? (
				<HugeiconsIcon
					icon={icons.off}
					className="text-destructive size-4 cursor-pointer"
					onClick={onClick}
				/>
			) : (
				<HugeiconsIcon
					icon={icons.on}
					className="text-muted-foreground size-4 cursor-pointer"
					onClick={onClick}
				/>
			)}
		</>
	);
}

function AudioTrackVolumeScrubber({
	muted = false,
	volume,
	onChange,
}: {
	muted?: boolean;
	volume: number;
	onChange: (
		volume: number,
		options?: {
			pushHistory?: boolean;
		},
	) => void;
}) {
	const normalizedVolume = Math.max(0, Math.min(2, volume));
	const effectiveVolume = muted ? 0 : normalizedVolume;
	const [isHovering, setIsHovering] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const startXRef = useRef(0);
	const startVolumeRef = useRef(normalizedVolume);
	const dragDeltaRef = useRef(0);
	const hasDraggedRef = useRef(false);
	const pointerLockElementRef = useRef<HTMLElement | null>(null);
	const pointerLockActiveRef = useRef(false);
	const lastNonZeroVolumeRef = useRef(
		normalizedVolume > 0 ? normalizedVolume : 1,
	);
	const dragFrameRef = useRef<number | null>(null);
	const latestDragVolumeRef = useRef(effectiveVolume);

	useEffect(() => {
		if (normalizedVolume > 0.001) {
			lastNonZeroVolumeRef.current = normalizedVolume;
		}
	}, [normalizedVolume]);

	useEffect(() => {
		return () => {
			if (dragFrameRef.current != null) {
				window.cancelAnimationFrame(dragFrameRef.current);
				dragFrameRef.current = null;
			}
		};
	}, []);

	const displayedPercent = Math.round(effectiveVolume * 100);
	const icon =
		effectiveVolume <= 0.001
			? VolumeOffIcon
			: effectiveVolume < 0.75
				? VolumeLowIcon
				: VolumeHighIcon;

	const setVolumeFromPointerDelta = ({ clientX }: { clientX: number }) => {
		const deltaX = clientX - startXRef.current;
		const rawNext = startVolumeRef.current + deltaX * 0.005;
		const nextVolume = Math.max(0, Math.min(2, rawNext));
		latestDragVolumeRef.current = nextVolume;
		onChange(nextVolume, { pushHistory: false });
	};

	const setVolumeFromMovementDelta = ({ movementX }: { movementX: number }) => {
		dragDeltaRef.current += movementX;
		const rawNext = startVolumeRef.current + dragDeltaRef.current * 0.005;
		const nextVolume = Math.max(0, Math.min(2, rawNext));
		latestDragVolumeRef.current = nextVolume;
		onChange(nextVolume, { pushHistory: false });
	};

	const startDrag = ({
		clientX,
		lockTarget,
	}: {
		clientX: number;
		lockTarget: HTMLElement | null;
	}) => {
		startXRef.current = clientX;
		startVolumeRef.current = effectiveVolume;
		dragDeltaRef.current = 0;
		hasDraggedRef.current = false;
		latestDragVolumeRef.current = effectiveVolume;
		pointerLockElementRef.current = lockTarget;
		if (lockTarget && typeof lockTarget.requestPointerLock === "function") {
			try {
				lockTarget.requestPointerLock();
			} catch {}
		}
		setIsDragging(true);
	};

	const handlePointerMove = (event: PointerEvent) => {
		if (pointerLockActiveRef.current) {
			const deltaX = Math.abs(dragDeltaRef.current + event.movementX);
			if (!hasDraggedRef.current && deltaX >= 2) {
				hasDraggedRef.current = true;
			}
			if (!hasDraggedRef.current) return;
			event.preventDefault();
			if (dragFrameRef.current != null) return;
			dragFrameRef.current = window.requestAnimationFrame(() => {
				dragFrameRef.current = null;
				setVolumeFromMovementDelta({ movementX: event.movementX });
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
		dragFrameRef.current = window.requestAnimationFrame(() => {
			dragFrameRef.current = null;
			setVolumeFromPointerDelta({ clientX: event.clientX });
		});
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
		if (!hasDraggedRef.current) {
			if (effectiveVolume <= 0.001) {
				onChange(lastNonZeroVolumeRef.current || 1, { pushHistory: true });
			} else {
				lastNonZeroVolumeRef.current = normalizedVolume;
				onChange(0, { pushHistory: true });
			}
		} else {
			onChange(latestDragVolumeRef.current, { pushHistory: true });
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

	return (
		<div
			className="relative flex items-center"
			onMouseDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
			onMouseEnter={() => setIsHovering(true)}
			onMouseLeave={() => setIsHovering(false)}
		>
			<button
				type="button"
				className={`flex items-center gap-1 rounded px-1 py-0.5 ${
					isDragging ? "bg-muted" : ""
				}`}
				onPointerDown={(event) => {
					event.stopPropagation();
					startDrag({
						clientX: event.clientX,
						lockTarget: event.currentTarget,
					});
				}}
				aria-label="Adjust audio track volume"
				title="Click to mute/unmute. Drag left/right to adjust volume."
			>
				<span
					aria-hidden
					className={`bg-muted-foreground/60 inline-block h-3 w-[2px] rounded-full ${
						isDragging || isHovering ? "opacity-100" : "opacity-60"
					}`}
				/>
				<HugeiconsIcon
					icon={icon}
					className="text-muted-foreground size-4 cursor-ew-resize"
				/>
				<span
					aria-hidden
					className={`bg-muted-foreground/60 inline-block h-3 w-[2px] rounded-full ${
						isDragging || isHovering ? "opacity-100" : "opacity-60"
					}`}
				/>
			</button>
			{(isHovering || isDragging) && (
				<div className="bg-background text-foreground absolute top-[-1.35rem] left-1/2 -translate-x-1/2 rounded border px-1.5 py-0.5 text-[10px] leading-none">
					{displayedPercent}%
				</div>
			)}
		</div>
	);
}

function TrackLevelStrip({
	track,
	level,
	height,
}: {
	track: Extract<TimelineTrack, { type: "audio" | "video" }>;
	level?: { peak: number; rmsDb: number; silent: boolean };
	height: number;
}) {
	const meterPercent = getMeterFillPercent({
		peak: level?.peak ?? 0,
		rmsDb: level?.rmsDb ?? -120,
		silent: level?.silent ?? true,
	});

	return (
		<div
			className="flex items-center"
			style={{ minHeight: `${height}px`, height: `${height}px` }}
		>
			<div className="bg-muted/20 flex h-6 w-full items-center gap-2 rounded-md border px-2 py-1">
				<div className="text-muted-foreground flex items-center text-[9px] font-medium leading-none">
					{track.type === "audio" ? "A" : "V"}
				</div>
				<div className="relative flex h-3 flex-1 items-stretch overflow-hidden rounded-md bg-black/10">
					<HorizontalLevelGuides />
					<div
						className={`relative z-[1] h-full rounded-md transition-all ${getLevelColorClass({
							fillPercent: meterPercent,
							silent: level?.silent ?? true,
							muted: track.muted,
						})}`}
						style={{ width: `${meterPercent}%` }}
					/>
				</div>
			</div>
		</div>
	);
}

function MasterLevelStrip({
	level,
}: {
	level: { peak: number; rmsDb: number; silent: boolean };
}) {
	const meterPercent = getMeterFillPercent({
		peak: level.peak,
		rmsDb: level.rmsDb,
		silent: level.silent,
	});

	return (
		<div className="flex h-full min-h-0 flex-col items-center gap-2 py-1">
			<div className="text-muted-foreground text-[9px] font-medium uppercase tracking-[0.18em]">
				Out
			</div>
			<div className="bg-muted/20 relative flex h-full min-h-0 w-8 items-end overflow-hidden rounded-xl border p-1">
				<LevelGuides />
				<div
					className={`relative z-[1] w-full rounded-lg transition-all ${getLevelColorClass({
						fillPercent: meterPercent,
						silent: level.silent,
						muted: false,
					})}`}
					style={{ height: `${meterPercent}%` }}
				/>
			</div>
			<div className="text-muted-foreground text-[9px] leading-none">
				{Math.round(level.rmsDb)}
			</div>
		</div>
	);
}

function LevelGuides() {
	return (
		<>
			<div className="pointer-events-none absolute inset-0">
				{[
					{ top: "12%", label: "0" },
					{ top: "28%", label: "-6" },
					{ top: "44%", label: "-12" },
					{ top: "62%", label: "-18" },
					{ top: "80%", label: "-24" },
				].map((marker) => (
					<div
						key={marker.label}
						className="absolute left-0 right-0 border-t border-white/10"
						style={{ top: marker.top }}
					/>
				))}
			</div>
		</>
	);
}

function HorizontalLevelGuides() {
	return (
		<div className="pointer-events-none absolute inset-0">
			{["25%", "50%", "75%", "92%"].map((left) => (
				<div
					key={left}
					className="absolute top-0 bottom-0 border-l border-white/10"
					style={{ left }}
				/>
			))}
		</div>
	);
}

function getLevelColorClass({
	fillPercent,
	silent,
	muted,
}: {
	fillPercent: number;
	silent: boolean;
	muted: boolean;
}) {
	if (muted || silent || fillPercent <= 2) {
		return "bg-muted-foreground/30";
	}
	if (fillPercent >= 92) {
		return "bg-red-500";
	}
	if (fillPercent >= 78) {
		return "bg-orange-500";
	}
	if (fillPercent >= 62) {
		return "bg-amber-400";
	}
	if (fillPercent >= 44) {
		return "bg-lime-400";
	}
	return "bg-emerald-500";
}

function getMeterFillPercent({
	peak,
	rmsDb,
	silent,
}: {
	peak: number;
	rmsDb: number;
	silent: boolean;
}) {
	if (silent || peak < 0.0005) {
		return 0;
	}

	const peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
	const displayDb = Math.max(rmsDb, peakDb);
	const meterFloorDb = -48;
	const clampedDb = Math.max(meterFloorDb, Math.min(0, displayDb));
	const normalized = (clampedDb - meterFloorDb) / Math.abs(meterFloorDb);
	return Math.max(2, Math.min(100, Math.round(normalized * 100)));
}
