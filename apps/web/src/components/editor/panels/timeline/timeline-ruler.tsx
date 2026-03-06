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
import { getRulerConfig, shouldShowLabel } from "@/lib/timeline/ruler-utils";
import { useScrollPosition } from "@/hooks/timeline/use-scroll-position";
import { TimelineTick } from "./timeline-tick";
import { invokeAction } from "@/lib/actions";
import { cn } from "@/utils/ui";

interface TimelineRulerProps {
	zoomLevel: number;
	dynamicTimelineWidth: number;
	rulerRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLElement | null>;
	handleWheel: (e: React.WheelEvent) => void;
	handleTimelineContentClick: (e: React.MouseEvent) => void;
	handleRulerTrackingMouseDown: (e: React.MouseEvent) => void;
	handleRulerMouseDown: (e: React.MouseEvent) => void;
}

export function TimelineRuler({
	zoomLevel,
	dynamicTimelineWidth,
	rulerRef,
	tracksScrollRef,
	handleWheel,
	handleTimelineContentClick,
	handleRulerTrackingMouseDown,
	handleRulerMouseDown,
}: TimelineRulerProps) {
	const editor = useEditor();
	const duration = editor.timeline.getTotalDuration();
	const pixelsPerSecond = TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;
	const visibleDuration = dynamicTimelineWidth / pixelsPerSecond;
	const effectiveDuration = Math.max(duration, visibleDuration);
	const timelineViewState = editor.project.getTimelineViewState();
	const inPoint =
		typeof timelineViewState.inPoint === "number"
			? Math.max(0, Math.min(effectiveDuration, timelineViewState.inPoint))
			: null;
	const outPoint =
		typeof timelineViewState.outPoint === "number"
			? Math.max(0, Math.min(effectiveDuration, timelineViewState.outPoint))
			: null;
	const regionStart = inPoint ?? 0;
	const regionEnd = outPoint ?? effectiveDuration;
	const hasValidRange =
		inPoint !== null && outPoint !== null && regionEnd > regionStart + 1e-6;
	const startPx = regionStart * pixelsPerSecond;
	const endPx = regionEnd * pixelsPerSecond;
	const project = editor.project.getActive();
	const fps = project?.settings.fps ?? DEFAULT_FPS;
	const { labelIntervalSeconds, tickIntervalSeconds } = getRulerConfig({
		zoomLevel,
		fps,
	});
	const tickCount = Math.ceil(effectiveDuration / tickIntervalSeconds) + 1;
	const dragTypeRef = useRef<"in" | "out" | null>(null);
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
		(scrollLeft - bufferPx) / pixelsPerSecond,
	);
	const visibleEndTime =
		(scrollLeft + viewportWidth + bufferPx) / pixelsPerSecond;

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
		const time = tickIndex * tickIntervalSeconds;
		if (time > effectiveDuration) break;

		const showLabel = shouldShowLabel({ time, labelIntervalSeconds });
		timelineTicks.push(
			<TimelineTick
				key={tickIndex}
				time={time}
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
			const markerHitThreshold = 8;
			const hitInMarker =
				inPoint !== null && Math.abs(x - startPx) <= markerHitThreshold;
			const hitOutMarker =
				outPoint !== null && Math.abs(x - endPx) <= markerHitThreshold;
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
			const clampedX = Math.max(0, Math.min(dynamicTimelineWidth, relativeX));
			return clampedX / pixelsPerSecond;
		},
		[rulerRef, dynamicTimelineWidth, pixelsPerSecond],
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

	useEffect(() => {
		const onMouseMove = (event: MouseEvent) => {
			const dragType = dragTypeRef.current;
			if (!dragType) return;
			const time = getTimeFromClientX({ clientX: event.clientX });
			if (time === null) return;
			if (dragType === "in") {
				editor.playback.setInPoint({ time });
			} else {
				editor.playback.setOutPoint({ time });
			}
		};

		const onMouseUp = () => {
			dragTypeRef.current = null;
		};

		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
		return () => {
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, [editor.playback, getTimeFromClientX]);

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
				{hasValidRange && (
					<div
						className="pointer-events-none absolute top-0 h-full border-y border-cyan-500/70 bg-cyan-400/30"
						style={{
							left: `${startPx}px`,
							width: `${Math.max(0, endPx - startPx)}px`,
						}}
					/>
				)}
				{inPoint !== null && (
					<button
						type="button"
						aria-label="In point marker"
						className={cn(
							"absolute top-0 h-full w-2 -translate-x-1/2 cursor-ew-resize",
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
							"absolute top-0 h-full w-2 -translate-x-1/2 cursor-ew-resize",
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
