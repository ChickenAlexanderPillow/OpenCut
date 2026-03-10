import { useCallback, useEffect, useRef, useState } from "react";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { getCumulativeHeightBefore, getTrackHeight } from "@/lib/timeline";
import type { TimelineTrack } from "@/types/timeline";
import type { TimelineVisualModel } from "@/lib/transcript-editor/visual-timeline";
import {
	mapRealTimeToVisualTime,
	getVisualDurationForRealSpan,
} from "@/lib/transcript-editor/visual-timeline";

interface UseSelectionBoxProps {
	containerRef: React.RefObject<HTMLElement | null>;
	tracks: TimelineTrack[];
	onSelectionComplete: (
		elements: { trackId: string; elementId: string }[],
	) => void;
	isEnabled?: boolean;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	zoomLevel: number;
	visualModel: TimelineVisualModel;
}

interface SelectionBoxState {
	startPos: { x: number; y: number };
	currentPos: { x: number; y: number };
	isActive: boolean;
}

interface SelectionRectangle {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

function getNormalizedRectangle({
	startPos,
	endPos,
}: {
	startPos: { x: number; y: number };
	endPos: { x: number; y: number };
}): SelectionRectangle {
	return {
		left: Math.min(startPos.x, endPos.x),
		top: Math.min(startPos.y, endPos.y),
		right: Math.max(startPos.x, endPos.x),
		bottom: Math.max(startPos.y, endPos.y),
	};
}

function getSelectionRectangleInContent({
	container,
	scrollContainer,
	startPos,
	endPos,
}: {
	container: HTMLElement;
	scrollContainer: HTMLDivElement | null;
	startPos: { x: number; y: number };
	endPos: { x: number; y: number };
}): SelectionRectangle {
	const containerRect = container.getBoundingClientRect();
	const scrollLeft = scrollContainer?.scrollLeft ?? 0;
	const scrollTop = scrollContainer?.scrollTop ?? 0;

	const adjustedStart = {
		x: startPos.x - containerRect.left + scrollLeft,
		y: startPos.y - containerRect.top + scrollTop,
	};
	const adjustedEnd = {
		x: endPos.x - containerRect.left + scrollLeft,
		y: endPos.y - containerRect.top + scrollTop,
	};

	return getNormalizedRectangle({
		startPos: adjustedStart,
		endPos: adjustedEnd,
	});
}

function isRectangleIntersecting({
	elementRectangle,
	selectionRectangle,
}: {
	elementRectangle: SelectionRectangle;
	selectionRectangle: SelectionRectangle;
}): boolean {
	return !(
		elementRectangle.right < selectionRectangle.left ||
		elementRectangle.left > selectionRectangle.right ||
		elementRectangle.bottom < selectionRectangle.top ||
		elementRectangle.top > selectionRectangle.bottom
	);
}

export function useSelectionBox({
	containerRef,
	tracks,
	onSelectionComplete,
	isEnabled = true,
	tracksScrollRef,
	zoomLevel,
	visualModel,
}: UseSelectionBoxProps) {
	const [selectionBox, setSelectionBox] = useState<SelectionBoxState | null>(
		null,
	);
	const justFinishedSelectingRef = useRef(false);
	const rafRef = useRef<number | null>(null);
	const latestPointerRef = useRef<{ clientX: number; clientY: number } | null>(
		null,
	);

	const handleMouseDown = useCallback(
		({ clientX, clientY }: React.MouseEvent) => {
			if (!isEnabled) return;

			setSelectionBox({
				startPos: { x: clientX, y: clientY },
				currentPos: { x: clientX, y: clientY },
				isActive: false,
			});
		},
		[isEnabled],
	);

	const selectElementsInBox = useCallback(
		({
			startPos,
			endPos,
		}: {
			startPos: { x: number; y: number };
			endPos: { x: number; y: number };
		}) => {
			if (!containerRef.current) return;

			const container = containerRef.current;
			const selectionRectangle = getSelectionRectangleInContent({
				container,
				scrollContainer: tracksScrollRef.current,
				startPos,
				endPos,
			});
			const pixelsPerSecond = TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;
			const selectedElements: { trackId: string; elementId: string }[] = [];

			for (const [trackIndex, track] of tracks.entries()) {
				const trackTop = getCumulativeHeightBefore({
					tracks,
					trackIndex,
				});
				const trackHeight = getTrackHeight({ type: track.type });
				const elementTop = trackTop;
				const elementBottom = trackTop + trackHeight;

				for (const element of track.elements) {
					const elementLeft =
						mapRealTimeToVisualTime({
							time: element.startTime,
							model: visualModel,
						}) * pixelsPerSecond;
					const elementRight =
						elementLeft +
						getVisualDurationForRealSpan({
							startTime: element.startTime,
							duration: element.duration,
							model: visualModel,
						}) *
							pixelsPerSecond;

					const elementRectangle = {
						left: elementLeft,
						top: elementTop,
						right: elementRight,
						bottom: elementBottom,
					};

					const intersects = isRectangleIntersecting({
						elementRectangle,
						selectionRectangle,
					});

					if (intersects) {
						selectedElements.push({
							trackId: track.id,
							elementId: element.id,
						});
					}
				}
			}
			onSelectionComplete(selectedElements);
		},
		[
			containerRef,
			onSelectionComplete,
			tracks,
			tracksScrollRef,
			zoomLevel,
			visualModel,
		],
	);

	useEffect(() => {
		if (!selectionBox) return;

		const processSelectionPointer = () => {
			rafRef.current = null;
			const pointer = latestPointerRef.current;
			if (!pointer) return;
			const { clientX, clientY } = pointer;
			const deltaX = Math.abs(clientX - selectionBox.startPos.x);
			const deltaY = Math.abs(clientY - selectionBox.startPos.y);
			const shouldActivate = deltaX > 5 || deltaY > 5;

			const newSelectionBox = {
				...selectionBox,
				currentPos: { x: clientX, y: clientY },
				isActive: shouldActivate || selectionBox.isActive,
			};

			setSelectionBox(newSelectionBox);

			if (newSelectionBox.isActive) {
				selectElementsInBox({
					startPos: newSelectionBox.startPos,
					endPos: newSelectionBox.currentPos,
				});
			}
		};

		const handleMouseMove = ({ clientX, clientY }: MouseEvent) => {
			latestPointerRef.current = { clientX, clientY };
			if (rafRef.current == null) {
				rafRef.current = window.requestAnimationFrame(processSelectionPointer);
			}
		};

		const handleMouseUp = () => {
			if (selectionBox?.isActive) {
				justFinishedSelectingRef.current = true;
				requestAnimationFrame(() => {
					justFinishedSelectingRef.current = false;
				});
			}
			setSelectionBox(null);
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);

		return () => {
			if (rafRef.current != null) {
				window.cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};
	}, [selectionBox, selectElementsInBox]);

	useEffect(() => {
		if (!selectionBox) return;

		const previousBodyUserSelect = document.body.style.userSelect;
		const container = containerRef.current;
		const previousContainerUserSelect = container?.style.userSelect ?? "";

		document.body.style.userSelect = "none";
		if (container) container.style.userSelect = "none";

		return () => {
			document.body.style.userSelect = previousBodyUserSelect;
			if (container) container.style.userSelect = previousContainerUserSelect;
		};
	}, [selectionBox, containerRef]);

	const shouldIgnoreClick = useCallback(() => {
		return justFinishedSelectingRef.current;
	}, []);

	return {
		selectionBox,
		handleMouseDown,
		isSelecting: selectionBox?.isActive || false,
		shouldIgnoreClick,
	};
}
