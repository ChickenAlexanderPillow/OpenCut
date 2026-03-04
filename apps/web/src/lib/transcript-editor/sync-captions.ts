import { resolveBlueHighlightCaptionPreset } from "@/constants/caption-presets";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { findCaptionTrackIdInScene } from "@/lib/captions/caption-track";
import { buildCaptionPayloadFromTranscriptWords } from "@/lib/transcript-editor/core";
import type { TimelineTrack, VideoElement, AudioElement, TextElement } from "@/types/timeline";

function isEditableMediaElement(
	element: unknown,
): element is VideoElement | AudioElement {
	if (!element || typeof element !== "object") return false;
	const candidate = element as { type?: string };
	return candidate.type === "video" || candidate.type === "audio";
}

function ensureCaptionTrack({
	tracks,
}: {
	tracks: TimelineTrack[];
}): { tracks: TimelineTrack[]; trackId: string } {
	const existingCaptionTrackId = findCaptionTrackIdInScene({ tracks });
	if (existingCaptionTrackId) {
		return { tracks, trackId: existingCaptionTrackId };
	}
	const nextTrack: TimelineTrack = {
		id: crypto.randomUUID(),
		type: "text",
		name: "Captions",
		hidden: false,
		elements: [],
	};
	return {
		tracks: [nextTrack, ...tracks],
		trackId: nextTrack.id,
	};
}

export function syncCaptionsFromTranscriptEdits({
	tracks,
	mediaElementId,
}: {
	tracks: TimelineTrack[];
	mediaElementId: string;
}): {
	tracks: TimelineTrack[];
	changed: boolean;
	error?: string;
} {
	const mediaRecord = tracks
		.flatMap((track) => track.elements.map((element) => ({ track, element })))
		.find(
			(item) => item.element.id === mediaElementId && isEditableMediaElement(item.element),
		);
	if (!mediaRecord || !isEditableMediaElement(mediaRecord.element)) {
		return { tracks, changed: false, error: "media element not found" };
	}
	const transcriptEdit = mediaRecord.element.transcriptEdit;
	if (!transcriptEdit || transcriptEdit.words.length === 0) {
		return { tracks, changed: false, error: "transcript edit metadata missing" };
	}

	const payload = buildCaptionPayloadFromTranscriptWords({
		words: transcriptEdit.words,
	});
	if (!payload) {
		return { tracks, changed: false, error: "cannot remove all words from transcript" };
	}

	const sourceVersion = transcriptEdit.version;
	const targetTrackInfo = ensureCaptionTrack({ tracks });
	const targetTrackId = targetTrackInfo.trackId;
	let nextTracks = targetTrackInfo.tracks;
	let changed = targetTrackInfo.tracks !== tracks;

	const linkedCaptions = nextTracks
		.flatMap((track) =>
			track.type === "text"
				? track.elements
						.filter(
							(element) =>
								element.type === "text" &&
								element.captionSourceRef?.mediaElementId === mediaElementId &&
								element.captionStyle?.linkedToCaptionGroup !== false,
						)
						.map((element) => ({ trackId: track.id, element }))
				: [],
		);
	const heuristicCaptions =
		linkedCaptions.length > 0
			? []
			: nextTracks.flatMap((track) =>
					track.type === "text"
						? track.elements
								.filter(
									(element) =>
										element.type === "text" &&
										!element.captionSourceRef &&
										(element.captionWordTimings?.length ?? 0) > 0 &&
										element.captionStyle?.linkedToCaptionGroup !== false &&
										Math.abs(element.startTime - payload.startTime) <= 0.25 &&
										Math.abs(element.duration - payload.duration) <= 1.5,
								)
								.map((element) => ({ trackId: track.id, element }))
						: [],
			  );
	const candidateCaptions =
		linkedCaptions.length > 0 ? linkedCaptions : heuristicCaptions;

	const updatedCaptionElements: Array<{ trackId: string; element: TextElement }> = [];
	if (candidateCaptions.length === 0) {
		const blue = resolveBlueHighlightCaptionPreset();
		updatedCaptionElements.push({
			trackId: targetTrackId,
			element: {
				...DEFAULT_TEXT_ELEMENT,
				id: crypto.randomUUID(),
				name: "Caption 1",
				content: payload.content,
				startTime: payload.startTime,
				duration: payload.duration,
				captionWordTimings: payload.wordTimings,
				...blue.textProps,
				captionStyle: blue.captionStyle,
				captionSourceRef: {
					mediaElementId,
					transcriptVersion: sourceVersion,
				},
			},
		});
		changed = true;
	} else {
		for (const linked of candidateCaptions) {
			updatedCaptionElements.push({
				trackId: linked.trackId,
				element: {
					...linked.element,
					content: payload.content,
					startTime: payload.startTime,
					duration: payload.duration,
					captionWordTimings: payload.wordTimings,
					captionSourceRef: {
						mediaElementId,
						transcriptVersion: sourceVersion,
					},
				},
			});
			changed = true;
		}
	}

	if (!changed) {
		return { tracks, changed: false };
	}

	nextTracks = nextTracks.map((track) => {
		if (track.type !== "text") return track;
		const updatesForTrack = updatedCaptionElements.filter(
			(item) => item.trackId === track.id,
		);
		if (updatesForTrack.length === 0) return track;

		const updateMap = new Map(updatesForTrack.map((item) => [item.element.id, item.element]));
		const existing = track.elements.map((element) => {
			const updated = updateMap.get(element.id);
			return updated ? updated : element;
		});
		const appended = updatesForTrack
			.filter((item) => !track.elements.some((element) => element.id === item.element.id))
			.map((item) => item.element);
		return {
			...track,
			elements: [...existing, ...appended],
		};
	});

	return {
		tracks: nextTracks,
		changed: true,
	};
}

export function syncAllCaptionsFromTranscriptEditsInTracks({
	tracks,
}: {
	tracks: TimelineTrack[];
}): { tracks: TimelineTrack[]; changed: boolean } {
	let nextTracks = tracks;
	let changed = false;
	const mediaIds = tracks.flatMap((track) =>
		track.elements
			.filter((element) => isEditableMediaElement(element) && Boolean(element.transcriptEdit))
			.map((element) => element.id),
	);
	for (const mediaElementId of mediaIds) {
		const result = syncCaptionsFromTranscriptEdits({
			tracks: nextTracks,
			mediaElementId,
		});
		if (result.changed) {
			nextTracks = result.tracks;
			changed = true;
		}
	}
	return { tracks: nextTracks, changed };
}
