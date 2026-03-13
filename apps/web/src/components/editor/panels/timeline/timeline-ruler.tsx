import {
	type JSX,
	useLayoutEffect,
	useRef,
	useState,
	useEffect,
	useCallback,
} from "react";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { DEFAULT_FPS } from "@/constants/project-constants";
import { useEditor } from "@/hooks/use-editor";
import { useShiftKey } from "@/hooks/use-shift-key";
import { useTimelineStore } from "@/stores/timeline-store";
import { getRulerConfig, shouldShowLabel } from "@/lib/timeline/ruler-utils";
import {
	findSnapPoints,
	snapToNearestPoint,
	type SnapPoint,
} from "@/lib/timeline/snap-utils";
import { useScrollPosition } from "@/hooks/timeline/use-scroll-position";
import { TimelineTick } from "./timeline-tick";
import { invokeAction } from "@/lib/actions";
import { cn } from "@/utils/ui";

interface TimelineRulerProps {
	zoomLevel: number;
	dynamicTimelineWidth: number;
	displayDuration: number;
	mapRealTimeToVisualTime: (time: number) => number;
	mapVisualTimeToRealTime: (time: number) => number;
	rulerRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLElement | null>;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
	handleWheel: (e: React.WheelEvent) => void;
	handleTimelineContentClick: (e: React.MouseEvent) => void;
	handleRulerTrackingMouseDown: (e: React.MouseEvent) => void;
	handleRulerMouseDown: (e: React.MouseEvent) => void;
}

export function TimelineRuler({
	zoomLevel,
	dynamicTimelineWidth,
	displayDuration,
	mapRealTimeToVisualTime,
	mapVisualTimeToRealTime,
	rulerRef,
	tracksScrollRef,
	onSnapPointChange,
	handleWheel,
	handleTimelineContentClick,
	handleRulerTrackingMouseDown,
	handleRulerMouseDown,
}: TimelineRulerProps) {
	const editor = useEditor();
	const snappingEnabled = useTimelineStore((state) => state.snappingEnabled);
	const isShiftHeldRef = useShiftKey();
	const duration = editor.timeline.getTotalDuration();
	const tracks = editor.timeline.getTracks();
	const bookmarks = editor.scenes.getActiveScene()?.bookmarks ?? [];
	const playheadTime = editor.playback.getCurrentTime();
	const pixelsPerSecond = TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;
	const visibleDuration = Math.max(
		0,
		(dynamicTimelineWidth - TIMELINE_CONSTANTS.START_OFFSET_PX) /
			pixelsPerSecond,
	);
	const effectiveDuration = Math.max(displayDuration, visibleDuration);
	const timelineViewState = editor.project.getTimelineViewState();
	const inPoint =
		typeof timelineViewState.inPoint === "number"
			? Math.max(0, Math.min(duration, timelineViewState.inPoint))
			: null;
	const outPoint =
		typeof timelineViewState.outPoint === "number"
			? Math.max(0, Math.min(duration, timelineViewState.outPoint))
			: null;
	const regionStart = inPoint ?? 0;
	const regionEnd = outPoint ?? duration;
	const hasValidRange =
		inPoint !== null && outPoint !== null && regionEnd > regionStart + 1e-6;
	const startPx =
		TIMELINE_CONSTANTS.START_OFFSET_PX +
		mapRealTimeToVisualTime(regionStart) * pixelsPerSecond;
	const endPx =
		TIMELINE_CONSTANTS.START_OFFSET_PX +
		mapRealTimeToVisualTime(regionEnd) * pixelsPerSecond;
	const project = editor.project.getActive();
	const fps = project?.settings.fps ?? DEFAULT_FPS;
	const { labelIntervalSeconds, tickIntervalSeconds } = getRulerConfig({
		zoomLevel,
		fps,
	});
	const tickCount = Math.ceil(effectiveDuration / tickIntervalSeconds) + 1;
	const dragTypeRef = useRef<"in" | "out" | "range" | null>(null);
	const rangeDragStartRef = useRef<{
		mouseTime: number;
		inPoint: number;
		outPoint: number;
	} | null>(null);
	const contextMenuRef = useRef<HTMLDivElement | null>(null);
	const [contextMenu, setContextMenu] = useState<{
		open: boolean;
		x: number;
		y: number;
	}>({
		open: false,
		x: 0,
		y: 0,
	});

	const { scrollLeft, viewportWidth } = useScrollPosition({
		scrollRef: tracksScrollRef,
	});

	/**
	 * widens the virtualization buffer during zoom transitions.
	 * useScrollPosition lags one frame behind the scroll adjustment
	 * that useLayoutEffect applies after a zoom change.
	 */
	const prevZoomRef = useRef(zoomLevel);
	const isZoomTransition = zoomLevel !== prevZoomRef.current;
	const bufferPx = isZoomTransition
		? Math.max(200, (scrollLeft + viewportWidth) * 0.15)
		: 200;

	useLayoutEffect(() => {
		prevZoomRef.current = zoomLevel;
	}, [zoomLevel]);

	const visibleStartTime = Math.max(
		0,
		(scrollLeft - bufferPx - TIMELINE_CONSTANTS.START_OFFSET_PX) /
			pixelsPerSecond,
	);
	const visibleEndTime =
		(scrollLeft +
			viewportWidth +
			bufferPx -
			TIMELINE_CONSTANTS.START_OFFSET_PX) /
		pixelsPerSecond;

	const startTickIndex = Math.max(
		0,
		Math.floor(visibleStartTime / tickIntervalSeconds),
	);
	const endTickIndex = Math.min(
		tickCount - 1,
		Math.ceil(visibleEndTime / tickIntervalSeconds),
	);

	const timelineTicks: Array<JSX.Element> = [];
	for (
		let tickIndex = startTickIndex;
		tickIndex <= endTickIndex;
		tickIndex += 1
	) {
		const visualTime = tickIndex * tickIntervalSeconds;
		if (visualTime > effectiveDuration) break;

		const showLabel = shouldShowLabel({ time: visualTime, labelIntervalSeconds });
		timelineTicks.push(
			<TimelineTick
				key={tickIndex}
				time={visualTime}
				labelTime={mapVisualTimeToRealTime(visualTime)}
				zoomLevel={zoomLevel}
				fps={fps}
				showLabel={showLabel}
			/>,
		);
	}

	const isPointerWithinRangeTarget = useCallback(
		({ clientX }: { clientX: number }) => {
			if (inPoint === null && outPoint === null) return false;
			const rulerNode = rulerRef.current;
			if (!rulerNode) return false;
			const rect = rulerNode.getBoundingClientRect();
			const x = clientX - rect.left;
			const markerHitThreshold = 12;
			const insideHitSlop = 12;
			const hitInMarker =
				inPoint !== null &&
				x >= startPx - markerHitThreshold &&
				x <= startPx + insideHitSlop;
			const hitOutMarker =
				outPoint !== null &&
				x >= endPx - insideHitSlop &&
				x <= endPx + markerHitThreshold;
			const hitRegion = hasValidRange && x >= startPx && x <= endPx;
			return hitInMarker || hitOutMarker || hitRegion;
		},
		[inPoint, outPoint, hasValidRange, startPx, endPx, rulerRef],
	);

	const getTimeFromClientX = useCallback(
		({ clientX }: { clientX: number }) => {
			const rulerNode = rulerRef.current;
			if (!rulerNode) return null;
			const rect = rulerNode.getBoundingClientRect();
			const relativeX = clientX - rect.left;
			const clampedX = Math.max(
				TIMELINE_CONSTANTS.START_OFFSET_PX,
				Math.min(dynamicTimelineWidth, relativeX),
			);
			const visualTime =
				(clampedX - TIMELINE_CONSTANTS.START_OFFSET_PX) / pixelsPerSecond;
			return mapVisualTimeToRealTime(visualTime);
		},
		[rulerRef, dynamicTimelineWidth, pixelsPerSecond, mapVisualTimeToRealTime],
	);

	const handleMarkerMouseDown = ({
		event,
		type,
	}: {
		event: React.MouseEvent;
		type: "in" | "out";
	}) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		dragTypeRef.current = type;
	};

	const handleRangeMouseDown = (event: React.MouseEvent) => {
		if (!hasValidRange || inPoint === null || outPoint === null) return;
		if (event.button !== 0) return;
		const mouseTime = getTimeFromClientX({ clientX: event.clientX });
		if (mouseTime === null) return;
		event.preventDefault();
		event.stopPropagation();
		dragTypeRef.current = "range";
		rangeDragStartRef.current = {
			mouseTime,
			inPoint,
			outPoint,
		};
	};

	const getSnapResult = useCallback(
		({
			targetTime,
		}: {
			targetTime: number;
		}): { snappedTime: number; snapPoint: SnapPoint | null; snapDistance: number } => {
			const shouldSnap = snappingEnabled && !isShiftHeldRef.current;
			if (!shouldSnap) {
				return {
					snappedTime: targetTime,
					snapPoint: null,
					snapDistance: Number.POSITIVE_INFINITY,
				};
			}
			return snapToNearestPoint({
				targetTime,
				snapPoints: findSnapPoints({
					tracks,
					playheadTime,
					bookmarks,
				}),
				zoomLevel,
			});
		},
		[
			snappingEnabled,
			isShiftHeldRef,
			tracks,
			playheadTime,
			bookmarks,
			zoomLevel,
		],
	);

	useEffect(() => {
		const onMouseMove = (event: MouseEvent) => {
			const dragType = dragTypeRef.current;
			if (!dragType) return;
			const time = getTimeFromClientX({ clientX: event.clientX });
			if (time === null) return;
			if (dragType === "range") {
				const dragStart = rangeDragStartRef.current;
				if (!dragStart) return;
				const rangeDuration = dragStart.outPoint - dragStart.inPoint;
				if (rangeDuration <= 1e-6) return;
				const delta = time - dragStart.mouseTime;
				const unclampedStart = dragStart.inPoint + delta;
				const startSnap = getSnapResult({ targetTime: unclampedStart });
				const endSnap = getSnapResult({
					targetTime: unclampedStart + rangeDuration,
				});
				const snappedStart =
					startSnap.snapDistance <= endSnap.snapDistance
						? startSnap.snappedTime
						: endSnap.snappedTime - rangeDuration;
				const nextStart = Math.max(
					0,
					Math.min(duration - rangeDuration, snappedStart),
				);
				editor.playback.setPlaybackRange({
					inPoint: nextStart,
					outPoint: nextStart + rangeDuration,
				});
				onSnapPointChange?.(
					startSnap.snapDistance <= endSnap.snapDistance
						? startSnap.snapPoint
						: endSnap.snapPoint,
				);
				return;
			}
			const { snappedTime, snapPoint } = getSnapResult({ targetTime: time });
			if (dragType === "in") {
				editor.playback.setInPoint({ time: snappedTime });
			} else {
				editor.playback.setOutPoint({ time: snappedTime });
			}
			onSnapPointChange?.(snapPoint);
		};

		const onMouseUp = () => {
			dragTypeRef.current = null;
			rangeDragStartRef.current = null;
			onSnapPointChange?.(null);
		};

		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
		return () => {
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, [
		duration,
		editor.playback,
		getTimeFromClientX,
		getSnapResult,
		onSnapPointChange,
	]);

	useEffect(() => {
		if (!contextMenu.open) return;
		const handleOutsideClick = (event: MouseEvent) => {
			if (contextMenuRef.current?.contains(event.target as Node)) return;
			setContextMenu((prev) => ({ ...prev, open: false }));
		};
		const closeMenu = () => {
			setContextMenu((prev) => ({ ...prev, open: false }));
		};
		window.addEventListener("mousedown", handleOutsideClick);
		window.addEventListener("blur", closeMenu);
		return () => {
			window.removeEventListener("mousedown", handleOutsideClick);
			window.removeEventListener("blur", closeMenu);
		};
	}, [contextMenu.open]);

	const handleRangeContextMenu = (event: React.MouseEvent) => {
		if (inPoint === null && outPoint === null) return;
		if (!isPointerWithinRangeTarget({ clientX: event.clientX })) return;
		event.preventDefault();
		event.stopPropagation();
		setContextMenu({
			open: true,
			x: event.clientX,
			y: event.clientY,
		});
	};

	return (
		<div
			role="slider"
			tabIndex={0}
			aria-label="Timeline ruler"
			aria-valuemin={0}
			aria-valuemax={effectiveDuration}
			aria-valuenow={0}
			className="relative h-4 flex-1 overflow-x-visible"
			onWheel={handleWheel}
			onClick={handleTimelineContentClick}
			onMouseDown={handleRulerTrackingMouseDown}
			onKeyDown={() => {}}
		>
			<div
				role="none"
				ref={rulerRef}
				className="relative h-4 cursor-default select-none"
				style={{
					width: `${dynamicTimelineWidth}px`,
				}}
				onMouseDown={handleRulerMouseDown}
				onContextMenu={handleRangeContextMenu}
			>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute top-0 bottom-0 left-0"
					style={{
						width: `${TIMELINE_CONSTANTS.START_OFFSET_PX}px`,
						borderRight:
							"1px solid color-mix(in oklab, var(--foreground) 12%, transparent)",
					}}
				/>
				{hasValidRange && (
					<button
						type="button"
						aria-label="Drag playback range"
						className="absolute top-0 h-full cursor-grab border-y border-cyan-500/70 bg-cyan-400/30 active:cursor-grabbing"
						style={{
							left: `${startPx}px`,
							width: `${Math.max(0, endPx - startPx)}px`,
						}}
						onMouseDown={handleRangeMouseDown}
						onContextMenu={handleRangeContextMenu}
					>
						<span className="pointer-events-none absolute inset-0 flex items-center justify-center">
							<span className="flex items-center gap-1 opacity-85">
								<span className="bg-foreground/55 h-2.5 w-px" />
								<span className="bg-foreground/55 h-2.5 w-px" />
								<span className="bg-foreground/55 h-2.5 w-px" />
							</span>
						</span>
					</button>
				)}
				{inPoint !== null && (
					<button
						type="button"
						aria-label="In point marker"
						className={cn(
							"absolute top-0 h-full w-6 -translate-x-1/2 cursor-ew-resize",
							"hover:bg-emerald-500/15",
						)}
						style={{ left: `${startPx}px` }}
						onMouseDown={(event) =>
							handleMarkerMouseDown({ event, type: "in" })
						}
					>
						<span className="pointer-events-none absolute left-1/2 h-full w-0.5 -translate-x-1/2 bg-emerald-500" />
					</button>
				)}
				{outPoint !== null && (
					<button
						type="button"
						aria-label="Out point marker"
						className={cn(
							"absolute top-0 h-full w-6 -translate-x-1/2 cursor-ew-resize",
							"hover:bg-rose-500/15",
						)}
						style={{ left: `${endPx}px` }}
						onMouseDown={(event) =>
							handleMarkerMouseDown({ event, type: "out" })
						}
					>
						<span className="pointer-events-none absolute left-1/2 h-full w-0.5 -translate-x-1/2 bg-rose-500" />
					</button>
				)}
				{timelineTicks}
			</div>
			{contextMenu.open && (
				<div
					ref={contextMenuRef}
					className="bg-popover text-popover-foreground fixed z-50 min-w-40 rounded-lg border py-1.5 shadow-xl"
					style={{
						left: `${contextMenu.x}px`,
						top: `${contextMenu.y}px`,
					}}
				>
					<button
						type="button"
						className="hover:bg-accent w-full px-4 py-1.5 text-left text-sm"
						onClick={() => {
							invokeAction("clear-in-out-points", undefined, "mouseclick");
							setContextMenu((prev) => ({ ...prev, open: false }));
						}}
					>
						Clear In/Out Points
					</button>
				</div>
			)}
		</div>
	);
}
