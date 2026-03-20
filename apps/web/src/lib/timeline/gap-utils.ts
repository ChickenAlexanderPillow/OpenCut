import { isCaptionTimingRelativeToElement } from "@/lib/captions/timing";
import type {
	TextElement,
	TimelineElement,
	TimelineGapSelection,
	TimelineTrack,
} from "@/types/timeline";

const GAP_EPSILON = 1e-6;

export function supportsSelectableTrackGaps({
	track,
}: {
	track: TimelineTrack;
}): boolean {
	if (track.type !== "text") return true;
	if (track.name.trim().toLowerCase() === "captions") return false;
	return !track.elements.some(
		(element) =>
			element.type === "text" &&
			(Boolean(element.captionSourceRef) ||
				element.name.trim().startsWith("Caption ")),
	);
}

export function getTrackGaps({
	track,
}: {
	track: TimelineTrack;
}): TimelineGapSelection[] {
	if (!supportsSelectableTrackGaps({ track })) {
		return [];
	}
	const sortedElements = [...track.elements].sort(
		(left, right) => left.startTime - right.startTime,
	);
	const gaps: TimelineGapSelection[] = [];
	let cursor = 0;

	for (const element of sortedElements) {
		if (element.startTime > cursor + GAP_EPSILON) {
			gaps.push({
				trackId: track.id,
				startTime: cursor,
				endTime: element.startTime,
			});
		}
		cursor = Math.max(cursor, element.startTime + element.duration);
	}

	return gaps.filter((gap) => gap.endTime - gap.startTime > GAP_EPSILON);
}

function shiftCaptionTimings({
	element,
	shiftAmount,
}: {
	element: TextElement;
	shiftAmount: number;
}): TextElement["captionWordTimings"] {
	const timings = element.captionWordTimings ?? [];
	if (
		timings.length === 0 ||
		isCaptionTimingRelativeToElement({
			timings,
			elementDuration: element.duration,
		})
	) {
		return timings;
	}
	return timings.map((timing) => ({
		...timing,
		startTime: Math.max(0, timing.startTime - shiftAmount),
		endTime: Math.max(0, timing.endTime - shiftAmount),
	}));
}

function shiftElementForGapDelete({
	element,
	shiftAmount,
}: {
	element: TimelineElement;
	shiftAmount: number;
}): TimelineElement {
	const nextStartTime = Math.max(0, element.startTime - shiftAmount);
	if (element.type !== "text") {
		return {
			...element,
			startTime: nextStartTime,
		};
	}
	return {
		...element,
		startTime: nextStartTime,
		captionWordTimings: shiftCaptionTimings({
			element,
			shiftAmount,
		}),
	};
}

export function rippleDeleteGapFromTrack({
	track,
	gap,
	elementIds,
}: {
	track: TimelineTrack;
	gap: TimelineGapSelection;
	elementIds?: ReadonlySet<string>;
}): TimelineTrack {
	const shiftAmount = Math.max(0, gap.endTime - gap.startTime);
	if (shiftAmount <= GAP_EPSILON) return track;
	if (!elementIds && !supportsSelectableTrackGaps({ track })) return track;
	if (track.id !== gap.trackId && !elementIds) return track;

	const elements = track.elements.map((element) =>
		(elementIds
			? elementIds.has(element.id)
			: element.startTime >= gap.endTime - GAP_EPSILON)
			? shiftElementForGapDelete({
					element,
					shiftAmount,
				})
			: element,
	);
	return {
		...track,
		elements,
	} as TimelineTrack;
}
