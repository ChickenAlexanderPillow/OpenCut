import type {
	AudioElement,
	TimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";

const COMPANION_ALIGNMENT_TOLERANCE_SECONDS = 0.05;

function isCompanionEligibleMediaElement(
	element: TimelineElement,
): element is VideoElement | AudioElement {
	if (element.type === "video") return true;
	return element.type === "audio" && element.sourceType === "upload";
}

function getCompanionSourceId(
	element: VideoElement | AudioElement,
): string | null {
	if (element.type === "video") return element.mediaId;
	return element.sourceType === "upload" ? element.mediaId : null;
}

function isAlignedCompanionPair({
	left,
	right,
}: {
	left: VideoElement | AudioElement;
	right: VideoElement | AudioElement;
}): boolean {
	return (
		Math.abs(left.startTime - right.startTime) <=
			COMPANION_ALIGNMENT_TOLERANCE_SECONDS &&
		Math.abs(left.duration - right.duration) <=
			COMPANION_ALIGNMENT_TOLERANCE_SECONDS &&
		Math.abs(left.trimStart - right.trimStart) <=
			COMPANION_ALIGNMENT_TOLERANCE_SECONDS &&
		Math.abs(left.trimEnd - right.trimEnd) <=
			COMPANION_ALIGNMENT_TOLERANCE_SECONDS
	);
}

export function expandElementIdsWithAlignedCompanions({
	tracks,
	elementIds,
}: {
	tracks: TimelineTrack[];
	elementIds: string[];
}): Set<string> {
	const expanded = new Set(elementIds);
	if (elementIds.length === 0) return expanded;

	const mediaElements = tracks.flatMap((track) =>
		track.elements.filter(isCompanionEligibleMediaElement),
	);
	const mediaById = new Map(mediaElements.map((element) => [element.id, element]));
	const queue = [...elementIds];

	while (queue.length > 0) {
		const currentId = queue.shift();
		if (!currentId) continue;
		const current = mediaById.get(currentId);
		if (!current) continue;
		const currentSourceId = getCompanionSourceId(current);
		if (!currentSourceId) continue;

		for (const candidate of mediaElements) {
			if (candidate.id === current.id) continue;
			if (expanded.has(candidate.id)) continue;
			if (getCompanionSourceId(candidate) !== currentSourceId) continue;
			if (!isAlignedCompanionPair({ left: current, right: candidate })) continue;
			expanded.add(candidate.id);
			queue.push(candidate.id);
		}
	}

	return expanded;
}
