import type {
	AudioElement,
	TimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";

const COMPANION_ALIGNMENT_TOLERANCE_SECONDS = 0.05;
const COMPANION_OVERLAP_MIN_RATIO = 0.8;

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

function hasStrongRangeOverlap({
	startA,
	endA,
	startB,
	endB,
	minRatio = COMPANION_OVERLAP_MIN_RATIO,
}: {
	startA: number;
	endA: number;
	startB: number;
	endB: number;
	minRatio?: number;
}): boolean {
	const aStart = Math.min(startA, endA);
	const aEnd = Math.max(startA, endA);
	const bStart = Math.min(startB, endB);
	const bEnd = Math.max(startB, endB);
	const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
	if (overlap <= 0) return false;
	const aDuration = Math.max(0.001, aEnd - aStart);
	const bDuration = Math.max(0.001, bEnd - bStart);
	return overlap / Math.min(aDuration, bDuration) >= minRatio;
}

function isAlignedCompanionPair({
	left,
	right,
}: {
	left: VideoElement | AudioElement;
	right: VideoElement | AudioElement;
}): boolean {
	const startAligned =
		Math.abs(left.startTime - right.startTime) <=
		COMPANION_ALIGNMENT_TOLERANCE_SECONDS;
	const durationAligned =
		Math.abs(left.duration - right.duration) <=
		COMPANION_ALIGNMENT_TOLERANCE_SECONDS;
	const trimStartAligned =
		Math.abs(left.trimStart - right.trimStart) <=
		COMPANION_ALIGNMENT_TOLERANCE_SECONDS;
	const trimEndAligned =
		Math.abs(left.trimEnd - right.trimEnd) <=
		COMPANION_ALIGNMENT_TOLERANCE_SECONDS;
	if (startAligned && durationAligned && trimStartAligned && trimEndAligned) {
		return true;
	}

	const leftTimelineEnd = left.startTime + left.duration;
	const rightTimelineEnd = right.startTime + right.duration;
	const leftSourceEnd = left.trimStart + left.duration;
	const rightSourceEnd = right.trimStart + right.duration;
	return (
		hasStrongRangeOverlap({
			startA: left.startTime,
			endA: leftTimelineEnd,
			startB: right.startTime,
			endB: rightTimelineEnd,
		}) &&
		hasStrongRangeOverlap({
			startA: left.trimStart,
			endA: leftSourceEnd,
			startB: right.trimStart,
			endB: rightSourceEnd,
		})
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
			const candidateSourceId = getCompanionSourceId(candidate);
			const sharesSourceId =
				candidateSourceId !== null && candidateSourceId === currentSourceId;
			const isCrossTypePair = candidate.type !== current.type;
			if (!sharesSourceId && !isCrossTypePair) continue;
			if (!isAlignedCompanionPair({ left: current, right: candidate })) continue;
			expanded.add(candidate.id);
			queue.push(candidate.id);
		}
	}

	return expanded;
}
