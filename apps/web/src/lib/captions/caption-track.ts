import type { TimelineTrack } from "@/types/timeline";

export function isGeneratedCaptionElement(element: unknown): boolean {
	if (!element || typeof element !== "object") return false;
	const candidate = element as {
		type?: string;
		name?: string;
		captionWordTimings?: Array<unknown>;
		captionSourceRef?: unknown;
	};
	return (
		candidate.type === "text" &&
		((candidate.captionWordTimings?.length ?? 0) > 0 ||
			Boolean(candidate.captionSourceRef) ||
			(typeof candidate.name === "string" &&
				candidate.name.startsWith("Caption ")))
	);
}

function hasGeneratedCaptions({ track }: { track: TimelineTrack }): boolean {
	if (track.type !== "text") return false;
	return track.elements.some((element) => isGeneratedCaptionElement(element));
}

export function findCaptionTrackIdInScene({
	tracks,
}: {
	tracks: TimelineTrack[];
}): string | null {
	const namedTrack = tracks.find(
		(track) =>
			track.type === "text" && track.name.trim().toLowerCase() === "captions",
	);
	if (namedTrack) return namedTrack.id;

	const generatedTrack = tracks.find((track) =>
		hasGeneratedCaptions({ track }),
	);
	if (generatedTrack) return generatedTrack.id;

	return null;
}
