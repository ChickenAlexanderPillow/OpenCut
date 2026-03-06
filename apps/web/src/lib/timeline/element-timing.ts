import type { TimelineElement, TimelineTrack } from "@/types/timeline";

const FALLBACK_MIN_DURATION_SECONDS = 1 / 120;

function finiteOrFallback({
	value,
	fallback,
}: {
	value: number;
	fallback: number;
}): number {
	return Number.isFinite(value) ? value : fallback;
}

export function normalizeElementTiming({
	startTime,
	duration,
	trimStart,
	trimEnd,
	minDuration = FALLBACK_MIN_DURATION_SECONDS,
}: {
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	minDuration?: number;
}): {
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
} {
	const safeMinDuration = Math.max(
		FALLBACK_MIN_DURATION_SECONDS,
		finiteOrFallback({
			value: minDuration,
			fallback: FALLBACK_MIN_DURATION_SECONDS,
		}),
	);
	let nextTrimStart = Math.max(
		0,
		finiteOrFallback({ value: trimStart, fallback: 0 }),
	);
	const nextTrimEnd = Math.max(
		0,
		finiteOrFallback({ value: trimEnd, fallback: 0 }),
	);
	let nextDuration = Math.max(
		safeMinDuration,
		finiteOrFallback({ value: duration, fallback: safeMinDuration }),
	);
	let nextStartTime = finiteOrFallback({ value: startTime, fallback: 0 });

	// If time would move before the timeline start, consume available left trim.
	if (nextStartTime < 0) {
		const overflow = Math.abs(nextStartTime);
		const recoverable = Math.min(overflow, nextTrimStart);
		nextTrimStart -= recoverable;
		nextDuration += recoverable;
		nextStartTime = 0;
	} else {
		nextStartTime = Math.max(0, nextStartTime);
	}

	return {
		startTime: nextStartTime,
		duration: nextDuration,
		trimStart: nextTrimStart,
		trimEnd: nextTrimEnd,
	};
}

export function normalizeTimelineElementForInvariants<
	TElement extends TimelineElement,
>({
	element,
	minDuration = FALLBACK_MIN_DURATION_SECONDS,
}: {
	element: TElement;
	minDuration?: number;
}): TElement {
	const normalized = normalizeElementTiming({
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		minDuration,
	});

	if (
		normalized.startTime === element.startTime &&
		normalized.duration === element.duration &&
		normalized.trimStart === element.trimStart &&
		normalized.trimEnd === element.trimEnd
	) {
		return element;
	}

	return {
		...element,
		startTime: normalized.startTime,
		duration: normalized.duration,
		trimStart: normalized.trimStart,
		trimEnd: normalized.trimEnd,
	} as TElement;
}

export function normalizeTimelineTracksForInvariants({
	tracks,
	fps,
}: {
	tracks: TimelineTrack[];
	fps: number;
}): TimelineTrack[] {
	const minDuration = Math.max(
		FALLBACK_MIN_DURATION_SECONDS,
		1 / Math.max(1, Math.round(Number.isFinite(fps) ? fps : 30)),
	);
	let anyTrackChanged = false;
	const nextTracks = tracks.map((track) => {
		let trackChanged = false;
		const nextElements = track.elements.map((element) => {
			const normalizedElement = normalizeTimelineElementForInvariants({
				element,
				minDuration,
			});
			if (normalizedElement !== element) {
				trackChanged = true;
			}
			return normalizedElement;
		});
		if (!trackChanged) {
			return track;
		}
		anyTrackChanged = true;
		return { ...track, elements: nextElements } as TimelineTrack;
	});

	return anyTrackChanged ? nextTracks : tracks;
}
