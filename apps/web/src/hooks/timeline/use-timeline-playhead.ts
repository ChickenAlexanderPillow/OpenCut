import { getSnappedSeekTime } from "@/lib/time";
import { useState, useEffect, useCallback, useRef } from "react";
import { useEdgeAutoScroll } from "@/hooks/timeline/use-edge-auto-scroll";
import { useEditor } from "../use-editor";
import { useShiftKey } from "@/hooks/use-shift-key";
import { findSnapPoints, snapToNearestPoint } from "@/lib/timeline/snap-utils";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { startPlaybackWhenReady } from "@/lib/playback/start-playback";

function trySetPointerCapture({
	target,
	pointerId,
}: {
	target: EventTarget | null;
	pointerId: number;
}) {
	if (!(target instanceof Element) || !target.isConnected) return;
	try {
		target.setPointerCapture?.(pointerId);
	} catch {}
}

interface UseTimelinePlayheadProps {
	zoomLevel: number;
	displayTime?: number;
	displayDuration?: number;
	rulerRef: React.RefObject<HTMLDivElement | null>;
	rulerScrollRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	playheadRef?: React.RefObject<HTMLDivElement | null>;
	mapVisualTimeToRealTime?: (time: number) => number;
}

export function useTimelinePlayhead({
	zoomLevel,
	displayTime,
	displayDuration,
	rulerRef,
	rulerScrollRef,
	tracksScrollRef,
	playheadRef,
	mapVisualTimeToRealTime,
}: UseTimelinePlayheadProps) {
	const editor = useEditor({
		subscribeTo: ["playback", "timeline", "project", "scenes"],
	});
	const activeProject = editor.project.getActive();
	const currentTime = editor.playback.getCurrentTime();
	const duration = editor.timeline.getTotalDuration();
	const isPlaying = editor.playback.getIsPlaying();
	const isScrubbing = editor.playback.getIsScrubbing();
	const isShiftHeldRef = useShiftKey();

	const seek = useCallback(
		({ time }: { time: number }) => editor.playback.seek({ time }),
		[editor.playback],
	);

	const [scrubTime, setScrubTime] = useState<number | null>(null);

	const [isDraggingRuler, setIsDraggingRuler] = useState(false);
	const [hasDraggedRuler, setHasDraggedRuler] = useState(false);
	const lastMouseXRef = useRef<number>(0);
	const shouldResumeAfterScrubRef = useRef(false);
	const scrubPauseTokenRef = useRef(0);
	const activePointerIdRef = useRef<number | null>(null);
	const activePointerTargetRef = useRef<HTMLElement | null>(null);
	const scrubResumeDelayMs = 400;

	const playheadPosition =
		typeof displayTime === "number"
			? displayTime
			: isScrubbing && scrubTime !== null
				? scrubTime
				: currentTime;

	const handleScrub = useCallback(
		({
			event,
			snappingEnabled = true,
		}: {
			event:
				| MouseEvent
				| PointerEvent
				| React.MouseEvent
				| React.PointerEvent<HTMLElement>;
			snappingEnabled?: boolean;
		}) => {
			const ruler = rulerRef.current;
			if (!ruler) return;
			const rulerRect = ruler.getBoundingClientRect();
			const relativeMouseX = event.clientX - rulerRect.left;

			const timelineContentWidth =
				TIMELINE_CONSTANTS.START_OFFSET_PX +
				(displayDuration ?? duration) *
					TIMELINE_CONSTANTS.PIXELS_PER_SECOND *
					zoomLevel;

			const clampedMouseX = Math.max(
				TIMELINE_CONSTANTS.START_OFFSET_PX,
				Math.min(timelineContentWidth, relativeMouseX),
			);

			const rawVisualTime = Math.max(
				0,
				Math.min(
					displayDuration ?? duration,
					(clampedMouseX - TIMELINE_CONSTANTS.START_OFFSET_PX) /
						(TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel),
				),
			);
			const rawTime = mapVisualTimeToRealTime
				? mapVisualTimeToRealTime(rawVisualTime)
				: rawVisualTime;

			const framesPerSecond = activeProject.settings.fps;
			const frameTime = getSnappedSeekTime({
				rawTime,
				duration,
				fps: framesPerSecond,
			});

			const shouldSnap = snappingEnabled && !isShiftHeldRef.current;
			const time = (() => {
				if (!shouldSnap) return frameTime;
				const tracks = editor.timeline.getTracks();
				const bookmarks = editor.scenes.getActiveScene()?.bookmarks ?? [];
				const snapPoints = findSnapPoints({
					tracks,
					playheadTime: frameTime,
					bookmarks,
					enablePlayheadSnapping: false,
				});
				const snapResult = snapToNearestPoint({
					targetTime: frameTime,
					snapPoints,
					zoomLevel,
				});
				return snapResult.snapPoint ? snapResult.snappedTime : frameTime;
			})();

			setScrubTime(time);
			seek({ time });

			lastMouseXRef.current = event.clientX;
		},
		[
			duration,
			displayDuration,
			zoomLevel,
			seek,
			rulerRef,
			activeProject.settings.fps,
			isShiftHeldRef,
			editor.scenes,
			editor.timeline,
			mapVisualTimeToRealTime,
		],
	);

	const handlePlayheadMouseDown = useCallback(
		({ event }: { event: React.PointerEvent<HTMLElement> }) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			activePointerIdRef.current = event.pointerId;
			activePointerTargetRef.current = event.currentTarget;
			trySetPointerCapture({
				target: event.currentTarget,
				pointerId: event.pointerId,
			});
			shouldResumeAfterScrubRef.current = editor.playback.getIsPlaying();
			if (shouldResumeAfterScrubRef.current) {
				editor.playback.pause();
			}
			editor.playback.setScrubbing({ isScrubbing: true });
			handleScrub({ event });
		},
		[handleScrub, editor.playback],
	);

	const handleRulerMouseDown = useCallback(
		({ event }: { event: React.PointerEvent<HTMLDivElement> }) => {
			if (event.button !== 0) return;
			if (playheadRef?.current?.contains(event.target as Node)) return;

			event.preventDefault();
			activePointerIdRef.current = event.pointerId;
			activePointerTargetRef.current = event.currentTarget;
			trySetPointerCapture({
				target: event.currentTarget,
				pointerId: event.pointerId,
			});
			setIsDraggingRuler(true);
			setHasDraggedRuler(false);
			shouldResumeAfterScrubRef.current = editor.playback.getIsPlaying();
			if (shouldResumeAfterScrubRef.current) {
				editor.playback.pause();
			}

			editor.playback.setScrubbing({ isScrubbing: true });
			handleScrub({ event, snappingEnabled: false });
		},
		[handleScrub, playheadRef, editor.playback],
	);

	const handlePlayheadMouseDownEvent = useCallback(
		(event: React.PointerEvent<HTMLElement>) =>
			handlePlayheadMouseDown({ event }),
		[handlePlayheadMouseDown],
	);

	const handleRulerMouseDownEvent = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) =>
			handleRulerMouseDown({ event }),
		[handleRulerMouseDown],
	);

	useEdgeAutoScroll({
		isActive: isScrubbing,
		getMouseClientX: () => lastMouseXRef.current,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth:
			TIMELINE_CONSTANTS.START_OFFSET_PX +
			(displayDuration ?? duration) *
				TIMELINE_CONSTANTS.PIXELS_PER_SECOND *
				zoomLevel,
	});

	useEffect(() => {
		if (!isScrubbing) return;

		const finishScrub = ({ event }: { event?: PointerEvent | MouseEvent }) => {
			if (event) {
				handleScrub({ event });
			}
			editor.playback.setScrubbing({ isScrubbing: false });
			if (scrubTime !== null) {
				seek({ time: scrubTime });
				editor.project.setTimelineViewState({
					viewState: {
						...editor.project.getTimelineViewState(),
						zoomLevel,
						scrollLeft: tracksScrollRef.current?.scrollLeft ?? 0,
						playheadTime: scrubTime,
					},
				});
			}
			setScrubTime(null);

			if (isDraggingRuler) {
				setIsDraggingRuler(false);
				if (!hasDraggedRuler && event) {
					handleScrub({ event, snappingEnabled: false });
				}
				setHasDraggedRuler(false);
			}
			const pointerTarget = activePointerTargetRef.current;
			const pointerId = activePointerIdRef.current;
			if (
				pointerTarget &&
				pointerId !== null &&
				pointerTarget.hasPointerCapture?.(pointerId)
			) {
				pointerTarget.releasePointerCapture?.(pointerId);
			}
			activePointerTargetRef.current = null;
			activePointerIdRef.current = null;

			if (shouldResumeAfterScrubRef.current) {
				shouldResumeAfterScrubRef.current = false;
				const resumeToken = ++scrubPauseTokenRef.current;
				window.setTimeout(() => {
					if (scrubPauseTokenRef.current !== resumeToken) return;
					void startPlaybackWhenReady({ editor });
				}, scrubResumeDelayMs);
			}
		};

		const handlePointerMove = ({ event }: { event: PointerEvent }) => {
			if (
				activePointerIdRef.current !== null &&
				event.pointerId !== activePointerIdRef.current
			) {
				return;
			}
			handleScrub({ event });
			if (isDraggingRuler) {
				setHasDraggedRuler(true);
			}
		};

		const onPointerMove = (event: PointerEvent) => handlePointerMove({ event });
		const onPointerUp = (event: PointerEvent) => finishScrub({ event });
		const onPointerCancel = (event: PointerEvent) => finishScrub({ event });
		const onWindowBlur = () => finishScrub({});

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerCancel);
		window.addEventListener("blur", onWindowBlur);

		return () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerCancel);
			window.removeEventListener("blur", onWindowBlur);
		};
	}, [
		isScrubbing,
		scrubTime,
		seek,
		handleScrub,
		isDraggingRuler,
		hasDraggedRuler,
		editor,
		tracksScrollRef,
		zoomLevel,
	]);

	useEffect(() => {
		if (!isPlaying || isScrubbing) return;

		const rulerViewport = rulerScrollRef.current;
		const tracksViewport = tracksScrollRef.current;
		if (!rulerViewport || !tracksViewport) return;

		const playheadPixels =
			TIMELINE_CONSTANTS.START_OFFSET_PX +
			playheadPosition * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;
		const viewportWidth = rulerViewport.clientWidth;
		const scrollMinimum = 0;
		const scrollMaximum = rulerViewport.scrollWidth - viewportWidth;

		const needsScroll =
			playheadPixels < rulerViewport.scrollLeft ||
			playheadPixels > rulerViewport.scrollLeft + viewportWidth;

		if (needsScroll) {
			const desiredScroll = Math.round(
				Math.max(
					scrollMinimum,
					Math.min(scrollMaximum, playheadPixels - viewportWidth / 2),
				),
			);
			rulerViewport.scrollLeft = tracksViewport.scrollLeft = desiredScroll;
		}
	}, [
		playheadPosition,
		zoomLevel,
		rulerScrollRef,
		tracksScrollRef,
		isScrubbing,
		isPlaying,
	]);

	return {
		playheadPosition,
		handlePlayheadMouseDown: handlePlayheadMouseDownEvent,
		handleRulerMouseDown: handleRulerMouseDownEvent,
		isDraggingRuler,
	};
}
