import { isMainTrack } from "@/lib/timeline";
import { getTranscriptApplied, getTranscriptDraft } from "@/lib/transcript-editor/state";
import type {
	AudioElement,
	TextElement,
	TimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";

type TranscriptMediaElement = AudioElement | VideoElement;

type VisualTimelineCut = {
	id: string;
	realStart: number;
	realEnd: number;
	duration: number;
	visualTime: number;
};

export type TimelineVisualModel = {
	cuts: VisualTimelineCut[];
	totalRemovedDuration: number;
	totalVisualDuration: number;
};

export type TimelineCutMarker = {
	leftPercent: number;
};

export type TimelineElementVisualLayout = {
	visualStartTime: number;
	visualDuration: number;
	cutMarkers: TimelineCutMarker[];
};

const MIN_VISUAL_DURATION = 1 / 120;
const EPSILON = 1e-6;

function isTranscriptMediaElement(
	element: TimelineElement,
): element is TranscriptMediaElement {
	return element.type === "audio" || element.type === "video";
}

function getSourceCutsForMediaElement(
	element: TranscriptMediaElement,
): Array<{ start: number; end: number }> {
	const draft = getTranscriptDraft(element);
	const applied = getTranscriptApplied(element);
	const cuts = draft?.cuts ?? applied?.removedRanges ?? [];
	if (cuts.length === 0 || element.duration <= 0) return [];

	const visibleStart = element.trimStart;
	const visibleEnd = element.trimStart + element.duration;

	return cuts
		.map((cut) => ({
			start: Math.max(visibleStart, cut.start),
			end: Math.min(visibleEnd, cut.end),
		}))
		.filter((cut) => cut.end - cut.start > EPSILON);
}

function getTimelineCutsForMediaElement(
	element: TranscriptMediaElement,
): Array<{ realStart: number; realEnd: number }> {
	return getSourceCutsForMediaElement(element).map((cut) => ({
		realStart: element.startTime + (cut.start - element.trimStart),
		realEnd: element.startTime + (cut.end - element.trimStart),
	}));
}

function mergeTimelineCuts(
	cuts: Array<{ id: string; realStart: number; realEnd: number }>,
): Array<{ id: string; realStart: number; realEnd: number }> {
	if (cuts.length <= 1) return cuts;
	const sorted = [...cuts].sort((left, right) =>
		left.realStart === right.realStart
			? left.id.localeCompare(right.id)
			: left.realStart - right.realStart,
	);
	const merged: Array<{ id: string; realStart: number; realEnd: number }> = [];
	for (const cut of sorted) {
		const previous = merged[merged.length - 1];
		if (!previous || cut.realStart > previous.realEnd + EPSILON) {
			merged.push({ ...cut });
			continue;
		}
		previous.realEnd = Math.max(previous.realEnd, cut.realEnd);
	}
	return merged;
}

function findCaptionSourceMedia({
	element,
	tracks,
}: {
	element: TextElement;
	tracks: TimelineTrack[];
}): TranscriptMediaElement | null {
	const mediaElementId = element.captionSourceRef?.mediaElementId;
	if (!mediaElementId) return null;
	for (const track of tracks) {
		for (const candidate of track.elements) {
			if (
				isTranscriptMediaElement(candidate) &&
				candidate.id === mediaElementId
			) {
				return candidate;
			}
		}
	}
	return null;
}

export function buildTimelineVisualModel({
	tracks,
	duration,
}: {
	tracks: TimelineTrack[];
	duration: number;
}): TimelineVisualModel {
	const cuts = mergeTimelineCuts(
		tracks
			.filter((track) => isMainTrack(track))
			.flatMap((track) =>
				track.elements.flatMap((element) =>
					isTranscriptMediaElement(element)
						? getTimelineCutsForMediaElement(element).map((cut, index) => ({
								id: `${element.id}:${index}`,
								...cut,
						  }))
						: [],
				),
			),
	);

	let removedDuration = 0;
	const resolvedCuts: VisualTimelineCut[] = cuts.map((cut) => {
		const duration = Math.max(0, cut.realEnd - cut.realStart);
		const visualTime = Math.max(0, cut.realStart - removedDuration);
		removedDuration += duration;
		return {
			id: cut.id,
			realStart: cut.realStart,
			realEnd: cut.realEnd,
			duration,
			visualTime,
		};
	});

	return {
		cuts: resolvedCuts,
		totalRemovedDuration: removedDuration,
		totalVisualDuration: Math.max(0, duration - removedDuration),
	};
}

export function mapRealTimeToVisualTime({
	time,
	model,
}: {
	time: number;
	model: TimelineVisualModel;
}): number {
	let removedDurationBeforeTime = 0;
	for (const cut of model.cuts) {
		if (time <= cut.realStart + EPSILON) break;
		if (time >= cut.realEnd - EPSILON) {
			removedDurationBeforeTime += cut.duration;
			continue;
		}
		return Math.max(0, cut.visualTime);
	}
	return Math.max(0, time - removedDurationBeforeTime);
}

export function mapPlaybackTimeToCompressedVisualTime({
	time,
	tracks,
	duration,
}: {
	time: number;
	tracks: TimelineTrack[];
	duration?: number;
}): number {
	const inferredDuration =
		duration ??
		tracks.reduce((maxDuration, track) => {
			for (const element of track.elements) {
				maxDuration = Math.max(
					maxDuration,
					element.startTime + element.duration,
				);
			}
			return maxDuration;
		}, 0);
	return mapRealTimeToVisualTime({
		time,
		model: buildTimelineVisualModel({ tracks, duration: inferredDuration }),
	});
}

export function mapVisualTimeToRealTime({
	time,
	model,
}: {
	time: number;
	model: TimelineVisualModel;
}): number {
	let removedDurationBeforeTime = 0;
	for (const cut of model.cuts) {
		if (time < cut.visualTime - EPSILON) {
			return Math.max(0, time + removedDurationBeforeTime);
		}
		if (Math.abs(time - cut.visualTime) <= EPSILON) {
			return cut.realEnd;
		}
		removedDurationBeforeTime += cut.duration;
	}
	return Math.max(0, time + removedDurationBeforeTime);
}

export function getVisualDurationForRealSpan({
	startTime,
	duration,
	model,
}: {
	startTime: number;
	duration: number;
	model: TimelineVisualModel;
}): number {
	const endTime = startTime + duration;
	const visualStart = mapRealTimeToVisualTime({ time: startTime, model });
	const visualEnd = mapRealTimeToVisualTime({ time: endTime, model });
	if (duration <= 0) return 0;
	return Math.max(MIN_VISUAL_DURATION, visualEnd - visualStart);
}

export function getTimelineElementVisualLayout({
	element,
	tracks,
	model,
}: {
	element: TimelineElement;
	tracks: TimelineTrack[];
	model: TimelineVisualModel;
}): TimelineElementVisualLayout {
	const visualStartTime = mapRealTimeToVisualTime({
		time: element.startTime,
		model,
	});
	const visualDuration = getVisualDurationForRealSpan({
		startTime: element.startTime,
		duration: element.duration,
		model,
	});

	const sourceMedia =
		isTranscriptMediaElement(element)
			? element
			: element.type === "text"
				? findCaptionSourceMedia({ element, tracks })
				: null;

	if (!sourceMedia) {
		return {
			visualStartTime,
			visualDuration,
			cutMarkers: [],
		};
	}

	const elementRealStart = element.startTime;
	const elementRealEnd = element.startTime + element.duration;
	const cutMarkers = getTimelineCutsForMediaElement(sourceMedia)
		.filter((cut) => cut.realStart >= elementRealStart - EPSILON)
		.filter((cut) => cut.realStart <= elementRealEnd + EPSILON)
		.map((cut) => {
			const markerVisualTime = mapRealTimeToVisualTime({
				time: cut.realStart,
				model,
			});
			const offset = markerVisualTime - visualStartTime;
			return {
				leftPercent:
					visualDuration <= EPSILON
						? 0
						: Math.max(0, Math.min(100, (offset / visualDuration) * 100)),
			};
		});

	return {
		visualStartTime,
		visualDuration,
		cutMarkers,
	};
}
