import { getDropLineY } from "@/lib/timeline/drop-utils";
import {
	TIMELINE_CONSTANTS,
	TRACK_GAP,
	TRACK_HEIGHTS,
} from "@/constants/timeline-constants";
import type { TimelineTrack, DropTarget, ElementType } from "@/types/timeline";
import type { TimelineVisualModel } from "@/lib/transcript-editor/visual-timeline";
import {
	mapRealTimeToVisualTime,
	getVisualDurationForRealSpan,
} from "@/lib/transcript-editor/visual-timeline";

interface DragLineProps {
	dropTarget: DropTarget | null;
	tracks: TimelineTrack[];
	isVisible: boolean;
	zoomLevel?: number;
	visualModel: TimelineVisualModel;
	dragElementType?: ElementType | null;
	dragElementDuration?: number | null;
	headerHeight?: number;
}

export function DragLine({
	dropTarget,
	tracks,
	isVisible,
	zoomLevel = 1,
	visualModel,
	dragElementType = null,
	dragElementDuration = null,
	headerHeight = 0,
}: DragLineProps) {
	if (!isVisible || !dropTarget) return null;

	const y = getDropLineY({ dropTarget, tracks });
	const lineTop = y + headerHeight;
	const ghostWidthPx =
		dragElementDuration && dragElementDuration > 0
			? Math.max(
					2,
					getVisualDurationForRealSpan({
						startTime: dropTarget.xPosition,
						duration: dragElementDuration,
						model: visualModel,
					}) *
						TIMELINE_CONSTANTS.PIXELS_PER_SECOND *
						zoomLevel,
				)
			: 0;
	const ghostLeftPx =
		mapRealTimeToVisualTime({
			time: dropTarget.xPosition,
			model: visualModel,
		}) *
		TIMELINE_CONSTANTS.PIXELS_PER_SECOND *
		zoomLevel;
	const showGhost =
		ghostWidthPx > 0 &&
		(dragElementType === "audio" ||
			dragElementType === "video" ||
			dragElementType === "image");

	const fallbackTrackType =
		dragElementType === "audio"
			? "audio"
			: dragElementType === "text"
				? "text"
				: dragElementType === "sticker"
					? "sticker"
					: "video";
	const targetTrackType =
		!dropTarget.isNewTrack && tracks[dropTarget.trackIndex]
			? tracks[dropTarget.trackIndex].type
			: fallbackTrackType;
	const ghostHeight = TRACK_HEIGHTS[targetTrackType] - 2;
	const ghostTop = !dropTarget.isNewTrack
		? lineTop + 1
		: dropTarget.insertPosition === "above"
			? Math.max(headerHeight, lineTop - ghostHeight - TRACK_GAP + 2)
			: lineTop + TRACK_GAP;

	return (
		<>
			{showGhost ? (
				<div
					className="border-primary/70 bg-primary/20 pointer-events-none absolute z-40 rounded border"
					style={{
						top: `${ghostTop}px`,
						left: `${ghostLeftPx}px`,
						width: `${ghostWidthPx}px`,
						height: `${ghostHeight}px`,
					}}
				/>
			) : null}
			<div
				className="bg-primary pointer-events-none absolute right-0 left-0 z-50 h-0.5"
				style={{ top: `${lineTop}px` }}
			/>
		</>
	);
}
