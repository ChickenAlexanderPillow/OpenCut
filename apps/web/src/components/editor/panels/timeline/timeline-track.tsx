"use client";

import { invokeAction } from "@/lib/actions";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { TimelineElement } from "./timeline-element";
import type { TimelineTrack } from "@/types/timeline";
import type {
	TimelineElement as TimelineElementType,
	TimelineGapSelection,
} from "@/types/timeline";
import type { SnapPoint } from "@/lib/timeline/snap-utils";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { useEdgeAutoScroll } from "@/hooks/timeline/use-edge-auto-scroll";
import type { ElementDragState } from "@/types/timeline";
import type { TimelineVisualModel } from "@/lib/transcript-editor/visual-timeline";
import { getTrackGaps } from "@/lib/timeline";

interface TimelineTrackContentProps {
	track: TimelineTrack;
	tracks: TimelineTrack[];
	zoomLevel: number;
	visualModel: TimelineVisualModel;
	dragState: ElementDragState;
	rulerScrollRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	lastMouseXRef: React.RefObject<number>;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
	onResizeStateChange?: (params: { isResizing: boolean }) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onTrackMouseDown?: (event: React.MouseEvent) => void;
	onTrackClick?: (event: React.MouseEvent) => void;
	shouldIgnoreClick?: () => boolean;
}

export function TimelineTrackContent({
	track,
	tracks,
	zoomLevel,
	visualModel,
	dragState,
	rulerScrollRef,
	tracksScrollRef,
	lastMouseXRef,
	onSnapPointChange,
	onResizeStateChange,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackClick,
	shouldIgnoreClick,
}: TimelineTrackContentProps) {
	const {
		isElementSelected,
		isGapSelected,
		selectGap,
		clearElementSelection,
	} = useElementSelection();
	const visualDuration = visualModel.totalVisualDuration;
	const trackGaps = getTrackGaps({ track });

	useEdgeAutoScroll({
		isActive: dragState.isDragging,
		getMouseClientX: () => lastMouseXRef.current ?? 0,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth:
			visualDuration * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel,
	});

	return (
		<div
			className="size-full"
			onClick={(event) => {
				if (shouldIgnoreClick?.()) return;
				clearElementSelection();
				onTrackClick?.(event);
			}}
			onMouseDown={(event) => {
				event.preventDefault();
				onTrackMouseDown?.(event);
			}}
		>
			<div className="relative h-full min-w-full">
				{trackGaps.map((gap) => (
					<GapRegion
						key={`${gap.trackId}:${gap.startTime}:${gap.endTime}`}
						gap={gap}
						zoomLevel={zoomLevel}
						isSelected={isGapSelected({ gap })}
						onSelect={(nextGap) => selectGap({ gap: nextGap })}
					/>
				))}
				{track.elements.length === 0 ? (
					<div className="text-muted-foreground border-muted/30 flex size-full items-center justify-center rounded-sm border-2 border-dashed text-xs" />
				) : (
					track.elements.map((element) => {
						const isSelected = isElementSelected({
							trackId: track.id,
							elementId: element.id,
						});

						return (
							<TimelineElement
								key={element.id}
								element={element}
								track={track}
								tracks={tracks}
								zoomLevel={zoomLevel}
								visualModel={visualModel}
								isSelected={isSelected}
								onSnapPointChange={onSnapPointChange}
								onResizeStateChange={onResizeStateChange}
								onElementMouseDown={(event, element) =>
									onElementMouseDown({ event, element, track })
								}
								onElementClick={(event, element) =>
									onElementClick({ event, element, track })
								}
								dragState={dragState}
							/>
						);
					})
				)}
			</div>
		</div>
	);
}

function GapRegion({
	gap,
	zoomLevel,
	isSelected,
	onSelect,
}: {
	gap: TimelineGapSelection;
	zoomLevel: number;
	isSelected: boolean;
	onSelect: (gap: TimelineGapSelection) => void;
}) {
	const left =
		gap.startTime * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;
	const width = Math.max(
		2,
		(gap.endTime - gap.startTime) *
			TIMELINE_CONSTANTS.PIXELS_PER_SECOND *
			zoomLevel,
	);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<button
					type="button"
					className={`absolute top-0 bottom-0 z-[1] cursor-pointer rounded-sm border transition-colors ${
						isSelected
							? "border-primary/70 bg-primary/15"
							: "border-transparent bg-foreground/5 hover:border-border/60 hover:bg-foreground/8"
					}`}
					style={{ left: `${left}px`, width: `${width}px` }}
					onMouseDown={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onSelect(gap);
					}}
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onSelect(gap);
					}}
					onContextMenu={(event) => {
						event.stopPropagation();
						onSelect(gap);
					}}
					aria-label={`Gap from ${gap.startTime.toFixed(2)} to ${gap.endTime.toFixed(2)} seconds`}
					title={`Gap ${gap.startTime.toFixed(2)}s - ${gap.endTime.toFixed(2)}s`}
				/>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-44">
				<ContextMenuItem
					variant="destructive"
					onSelect={(event) => {
						event.preventDefault();
						event.stopPropagation();
						invokeAction("ripple-delete-gap", gap);
					}}
				>
					Ripple delete gap
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
