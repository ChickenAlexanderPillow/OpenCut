import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";

export function getMouseTimeFromClientX({
	clientX,
	containerRect,
	zoomLevel,
	scrollLeft,
	mapVisualTimeToRealTime,
}: {
	clientX: number;
	containerRect: DOMRect;
	zoomLevel: number;
	scrollLeft: number;
	mapVisualTimeToRealTime?: (time: number) => number;
}): number {
	const mouseX = clientX - containerRect.left + scrollLeft;
	const visualTime = Math.max(
		0,
		(mouseX - TIMELINE_CONSTANTS.START_OFFSET_PX) /
			(TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel),
	);
	return mapVisualTimeToRealTime ? mapVisualTimeToRealTime(visualTime) : visualTime;
}
