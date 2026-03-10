"use client";

import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { formatRulerLabel } from "@/lib/timeline/ruler-utils";

interface TimelineTickProps {
	time: number;
	labelTime?: number;
	zoomLevel: number;
	fps: number;
	showLabel: boolean;
}

export function TimelineTick({
	time,
	labelTime,
	zoomLevel,
	fps,
	showLabel,
}: TimelineTickProps) {
	const leftPosition =
		TIMELINE_CONSTANTS.START_OFFSET_PX +
		time * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;

	if (showLabel) {
		const label = formatRulerLabel({
			timeInSeconds: labelTime ?? time,
			fps,
		});
		return (
			<span
				className="text-muted-foreground/85 absolute bottom-0 select-none text-[10px] leading-none"
				style={{ left: `${leftPosition}px` }}
			>
				{label}
			</span>
		);
	}

	return (
		<div
			className="border-muted-foreground/25 absolute bottom-0.5 h-1.5 border-l"
			style={{ left: `${leftPosition}px` }}
		/>
	);
}
