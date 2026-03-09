import { isMainTrack } from "@/lib/timeline";
import { getTranscriptApplied } from "@/lib/transcript-editor/state";
import type {
	AudioElement,
	TimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";

type TranscriptMediaElement = AudioElement | VideoElement;

function isTranscriptMediaElement(
	element: TimelineElement,
): element is TranscriptMediaElement {
	return element.type === "audio" || element.type === "video";
}

function getPlayableDuration({
	element,
}: {
	element: TranscriptMediaElement;
}): number {
	const playableDuration = getTranscriptApplied(element)?.timeMap.playableDuration;
	if (!Number.isFinite(playableDuration ?? NaN)) {
		return element.duration;
	}
	return Math.max(1 / 120, Math.min(element.duration, playableDuration ?? element.duration));
}

export function buildCompressedVisualTracks({
	tracks,
}: {
	tracks: TimelineTrack[];
}): TimelineTrack[] {
	return tracks.map((track) => {
		if (!isMainTrack(track)) return track;

		let cumulativeShift = 0;
		let changed = false;
		const nextElements = track.elements
			.slice()
			.sort((left, right) =>
				left.startTime === right.startTime
					? left.id.localeCompare(right.id)
					: left.startTime - right.startTime,
			)
			.map((element) => {
				const nextStartTime = Math.max(0, element.startTime - cumulativeShift);
				if (!isTranscriptMediaElement(element)) {
					if (nextStartTime === element.startTime) {
						return element;
					}
					changed = true;
					return {
						...element,
						startTime: nextStartTime,
					};
				}

				const nextDuration = getPlayableDuration({ element });
				const removedDuration = Math.max(0, element.duration - nextDuration);
				cumulativeShift += removedDuration;
				if (
					nextStartTime === element.startTime &&
					Math.abs(nextDuration - element.duration) <= 1e-6
				) {
					return element;
				}
				changed = true;
				return {
					...element,
					startTime: nextStartTime,
					duration: nextDuration,
				};
			});

		return changed ? { ...track, elements: nextElements } : track;
	});
}

export function mapPlaybackTimeToCompressedVisualTime({
	time,
	tracks,
}: {
	time: number;
	tracks: TimelineTrack[];
}): number {
	let removedDurationBeforeTime = 0;

	for (const track of tracks) {
		if (!isMainTrack(track)) continue;

		const sortedElements = track.elements
			.slice()
			.sort((left, right) =>
				left.startTime === right.startTime
					? left.id.localeCompare(right.id)
					: left.startTime - right.startTime,
			);

		for (const element of sortedElements) {
			if (!isTranscriptMediaElement(element)) continue;
			const playableDuration = getPlayableDuration({ element });
			const removedDuration = Math.max(0, element.duration - playableDuration);
			if (removedDuration <= 1e-6) continue;

			const compressedEnd = element.startTime + playableDuration;
			if (time >= compressedEnd) {
				removedDurationBeforeTime += removedDuration;
			}
		}
	}

	return Math.max(0, time - removedDurationBeforeTime);
}
