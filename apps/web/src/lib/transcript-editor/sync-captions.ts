import { resolveBlueHighlightCaptionPreset } from "@/constants/caption-presets";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { findCaptionTrackIdInScene } from "@/lib/captions/caption-track";
import {
	buildCaptionPayloadFromTranscriptWords,
	buildTranscriptCutsFromWords,
	mergeCutRanges,
} from "@/lib/transcript-editor/core";
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

function resolveTranscriptUnitSourceRefId({
	mediaElement,
	mediaElementId,
}: {
	mediaElement: VideoElement | AudioElement;
	mediaElementId: string;
}): string {
	const firstWordId = mediaElement.transcriptEdit?.words[0]?.id ?? "";
	const marker = ":word:";
	const markerIndex = firstWordId.indexOf(marker);
	if (markerIndex > 0) {
		return firstWordId.slice(0, markerIndex);
	}
	return mediaElementId;
}

function collectEditableMediaElements({
	tracks,
}: {
	tracks: TimelineTrack[];
}): Array<VideoElement | AudioElement> {
	return tracks.flatMap((track) =>
		track.elements.filter((element): element is VideoElement | AudioElement =>
			isEditableMediaElement(element),
		),
	);
}

function isCompanionAligned({
	target,
	candidate,
}: {
	target: VideoElement | AudioElement;
	candidate: VideoElement | AudioElement;
}): boolean {
	const startAligned = Math.abs(candidate.startTime - target.startTime) < 0.02;
	const trimAligned = Math.abs(candidate.trimStart - target.trimStart) < 0.05;
	const endAligned =
		Math.abs(
			candidate.trimStart + candidate.duration - (target.trimStart + target.duration),
		) < 0.05;
	return startAligned && trimAligned && endAligned;
}

function collectCompanionMediaIds({
	tracks,
	mediaElementId,
	targetMediaElement,
	sourceRefId,
}: {
	tracks: TimelineTrack[];
	mediaElementId: string;
	targetMediaElement: VideoElement | AudioElement;
	sourceRefId: string;
}): Set<string> {
	const ids = new Set<string>([mediaElementId]);
	for (const element of collectEditableMediaElements({ tracks })) {
		const candidateSourceRefId = resolveTranscriptUnitSourceRefId({
			mediaElement: element,
			mediaElementId: element.id,
		});
		if (candidateSourceRefId !== sourceRefId) continue;
		if (!isCompanionAligned({ target: targetMediaElement, candidate: element })) {
			continue;
		}
		ids.add(element.id);
	}
	return ids;
}

function removeLinkedCaptionsForMedia({
	tracks,
	linkedMediaElementIds,
	legacySourceRefId,
}: {
	tracks: TimelineTrack[];
	linkedMediaElementIds: Set<string>;
	legacySourceRefId?: string;
}): { tracks: TimelineTrack[]; changed: boolean } {
	let changed = false;
	const nextTracks = tracks.map((track) => {
		if (track.type !== "text") return track;
		const nextElements = track.elements.filter((element) => {
			if (element.type !== "text") return true;
			const sourceId = element.captionSourceRef?.mediaElementId;
			const linkedToTarget =
				(typeof sourceId === "string" && linkedMediaElementIds.has(sourceId)) ||
				(Boolean(legacySourceRefId) && sourceId === legacySourceRefId);
			if (!linkedToTarget) return true;
			changed = true;
			return false;
		});
		if (nextElements.length === track.elements.length) return track;
		return { ...track, elements: nextElements };
	});
	return { tracks: nextTracks, changed };
}

function toTimelineCaptionPayload({
	payload,
	mediaStartTime,
	alreadyTimelineAligned = false,
}: {
	payload: {
		content: string;
		startTime: number;
		duration: number;
		wordTimings: Array<{ word: string; startTime: number; endTime: number }>;
	};
	mediaStartTime: number;
	alreadyTimelineAligned?: boolean;
}): {
	content: string;
	startTime: number;
	duration: number;
	wordTimings: Array<{ word: string; startTime: number; endTime: number }>;
} {
	if (alreadyTimelineAligned) {
		return payload;
	}
	return {
		content: payload.content,
		startTime: mediaStartTime + payload.startTime,
		duration: payload.duration,
		wordTimings: payload.wordTimings.map((timing) => ({
			word: timing.word,
			startTime: mediaStartTime + timing.startTime,
			endTime: mediaStartTime + timing.endTime,
		})),
	};
}

function isTranscriptAlreadyTimelineAligned({
	words,
	mediaStartTime,
	mediaDuration,
}: {
	words: Array<{ startTime: number; endTime: number }>;
	mediaStartTime: number;
	mediaDuration: number;
}): boolean {
	if (words.length === 0) return false;
	const minStart = Math.min(...words.map((word) => word.startTime));
	const maxEnd = Math.max(...words.map((word) => word.endTime));
	const epsilon = 0.05;
	const durationSlack = 0.35;
	const looksLocal =
		minStart >= -epsilon && maxEnd <= mediaDuration + durationSlack;
	const looksTimeline =
		minStart >= mediaStartTime - epsilon &&
		maxEnd <= mediaStartTime + mediaDuration + durationSlack;
	if (looksTimeline && !looksLocal) return true;
	return false;
}

function resolveCaptionSeedStyle({
	track,
}: {
	track: Extract<TimelineTrack, { type: "text" }>;
}): Pick<
	TextElement,
	| "fontFamily"
	| "fontSize"
	| "fontWeight"
	| "fontStyle"
	| "lineHeight"
	| "letterSpacing"
	| "color"
	| "background"
	| "textAlign"
	| "textDecoration"
	| "opacity"
	| "transform"
	| "captionStyle"
> {
	const seed = track.elements.find(
		(element) =>
			element.type === "text" && (element.captionWordTimings?.length ?? 0) > 0,
	);
	if (seed && seed.type === "text") {
		return {
			fontFamily: seed.fontFamily,
			fontSize: seed.fontSize,
			fontWeight: seed.fontWeight,
			fontStyle: seed.fontStyle,
			lineHeight: seed.lineHeight,
			letterSpacing: seed.letterSpacing,
			color: seed.color,
			background: seed.background,
			textAlign: seed.textAlign,
			textDecoration: seed.textDecoration,
			opacity: seed.opacity,
			transform: seed.transform,
			captionStyle: seed.captionStyle,
		};
	}
	const blue = resolveBlueHighlightCaptionPreset();
	return {
		fontFamily: blue.textProps.fontFamily ?? DEFAULT_TEXT_ELEMENT.fontFamily,
		fontSize: blue.textProps.fontSize ?? DEFAULT_TEXT_ELEMENT.fontSize,
		fontWeight: blue.textProps.fontWeight ?? DEFAULT_TEXT_ELEMENT.fontWeight,
		fontStyle: blue.textProps.fontStyle ?? DEFAULT_TEXT_ELEMENT.fontStyle,
		lineHeight: blue.textProps.lineHeight ?? DEFAULT_TEXT_ELEMENT.lineHeight,
		letterSpacing:
			blue.textProps.letterSpacing ?? DEFAULT_TEXT_ELEMENT.letterSpacing,
		color: blue.textProps.color ?? DEFAULT_TEXT_ELEMENT.color,
		background: blue.textProps.background ?? DEFAULT_TEXT_ELEMENT.background,
		textAlign: blue.textProps.textAlign ?? DEFAULT_TEXT_ELEMENT.textAlign,
		textDecoration:
			blue.textProps.textDecoration ?? DEFAULT_TEXT_ELEMENT.textDecoration,
		opacity: blue.textProps.opacity ?? DEFAULT_TEXT_ELEMENT.opacity,
		transform: blue.textProps.transform ?? DEFAULT_TEXT_ELEMENT.transform,
		captionStyle: blue.captionStyle,
	};
}

function resolveRebuildTargetCaptionTrackId({
	tracks,
	mediaElementId,
	sourceRefId,
	companionMediaIds,
}: {
	tracks: TimelineTrack[];
	mediaElementId: string;
	sourceRefId: string;
	companionMediaIds: Set<string>;
}): string | null {
	for (const track of tracks) {
		if (track.type !== "text") continue;
		const hasDirectLinkedCaption = track.elements.some((element) => {
			if (element.type !== "text") return false;
			const linkedMediaId = element.captionSourceRef?.mediaElementId;
			return (
				(typeof linkedMediaId === "string" &&
					companionMediaIds.has(linkedMediaId)) ||
				linkedMediaId === mediaElementId
			);
		});
		if (hasDirectLinkedCaption) return track.id;
	}

	if (sourceRefId !== mediaElementId) {
		for (const track of tracks) {
			if (track.type !== "text") continue;
			const hasLegacyLinkedCaption = track.elements.some((element) => {
				if (element.type !== "text") return false;
				return element.captionSourceRef?.mediaElementId === sourceRefId;
			});
			if (hasLegacyLinkedCaption) return track.id;
		}
	}

	return findCaptionTrackIdInScene({ tracks });
}

function resolveEffectiveTranscriptCuts({
	words,
	cuts,
}: {
	words: Array<{ startTime: number; endTime: number; removed?: boolean; text: string; id: string }>;
	cuts: Array<{ start: number; end: number; reason: "manual" | "pause" | "filler" }>;
}): Array<{ start: number; end: number; reason: "manual" | "pause" | "filler" }> {
	const derivedWordCuts = buildTranscriptCutsFromWords({ words });
	const pauseCuts = cuts.filter((cut) => cut.reason === "pause");
	return mergeCutRanges({
		cuts: [...derivedWordCuts, ...pauseCuts],
	});
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
	const sourceRefId = resolveTranscriptUnitSourceRefId({
		mediaElement: mediaRecord.element,
		mediaElementId,
	});
	const companionMediaIds = collectCompanionMediaIds({
		tracks,
		mediaElementId,
		targetMediaElement: mediaRecord.element,
		sourceRefId,
	});
	if (!transcriptEdit || transcriptEdit.words.length === 0) {
		const removed = removeLinkedCaptionsForMedia({
			tracks,
			linkedMediaElementIds: companionMediaIds,
			legacySourceRefId: sourceRefId !== mediaElementId ? sourceRefId : undefined,
		});
		return removed.changed
			? { tracks: removed.tracks, changed: true }
			: { tracks, changed: false, error: "transcript edit metadata missing" };
	}

	const payload = buildCaptionPayloadFromTranscriptWords({
		words: transcriptEdit.words,
		cuts: resolveEffectiveTranscriptCuts({
			words: transcriptEdit.words,
			cuts: transcriptEdit.cuts,
		}),
	});
	if (!payload) {
		const removed = removeLinkedCaptionsForMedia({
			tracks,
			linkedMediaElementIds: companionMediaIds,
			legacySourceRefId: sourceRefId !== mediaElementId ? sourceRefId : undefined,
		});
		return removed.changed
			? { tracks: removed.tracks, changed: true }
			: { tracks, changed: false, error: "cannot remove all words from transcript" };
	}
	const timelinePayload = toTimelineCaptionPayload({
		payload,
		mediaStartTime: mediaRecord.element.startTime,
	});

	const sourceVersion = transcriptEdit.version;
	const targetTrackInfo = ensureCaptionTrack({ tracks });
	const targetTrackId = targetTrackInfo.trackId;
	let nextTracks = targetTrackInfo.tracks;
	let changed = targetTrackInfo.tracks !== tracks;

	const relatedMediaBySourceRef = collectEditableMediaElements({ tracks }).filter(
		(element) =>
			resolveTranscriptUnitSourceRefId({
				mediaElement: element,
				mediaElementId: element.id,
			}) === sourceRefId,
	);
	const canUseLegacySourceRefMatching =
		sourceRefId !== mediaElementId &&
		relatedMediaBySourceRef.length <= companionMediaIds.size;

	const linkedCaptions = nextTracks
		.flatMap((track) =>
			track.type === "text"
				? track.elements
						.filter(
							(element) => {
								if (element.type !== "text") return false;
								const linkedMediaId = element.captionSourceRef?.mediaElementId;
								const linkedByCompanion =
									typeof linkedMediaId === "string" &&
									companionMediaIds.has(linkedMediaId);
								return (
									(linkedByCompanion ||
									(canUseLegacySourceRefMatching &&
										linkedMediaId === sourceRefId)) &&
									element.captionStyle?.linkedToCaptionGroup !== false
								);
							},
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
										Math.abs(element.startTime - timelinePayload.startTime) <=
											0.25 &&
										Math.abs(element.duration - timelinePayload.duration) <= 1.5,
								)
								.map((element) => ({ trackId: track.id, element }))
						: [],
			  );
	const candidateCaptions =
		linkedCaptions.length > 0 ? linkedCaptions : heuristicCaptions;
	const primaryCaption = candidateCaptions[0] ?? null;
	const duplicateCaptionIds = new Set(
		candidateCaptions.slice(1).map((item) => item.element.id),
	);
	if (duplicateCaptionIds.size > 0) {
		changed = true;
	}
	const finalPayload = timelinePayload;

	const updatedCaptionElements: Array<{ trackId: string; element: TextElement }> = [];
	if (!primaryCaption) {
		const blue = resolveBlueHighlightCaptionPreset();
		updatedCaptionElements.push({
			trackId: targetTrackId,
			element: {
				...DEFAULT_TEXT_ELEMENT,
				id: crypto.randomUUID(),
				name: "Caption 1",
				content: finalPayload.content,
				startTime: finalPayload.startTime,
				duration: finalPayload.duration,
				captionWordTimings: finalPayload.wordTimings,
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
		const existingSourceId = primaryCaption.element.captionSourceRef?.mediaElementId;
		const stableSourceId =
			typeof existingSourceId === "string" &&
			companionMediaIds.has(existingSourceId)
				? existingSourceId
				: mediaElementId;
		updatedCaptionElements.push({
			trackId: primaryCaption.trackId,
			element: {
				...primaryCaption.element,
				content: finalPayload.content,
				startTime: finalPayload.startTime,
				duration: finalPayload.duration,
				captionWordTimings: finalPayload.wordTimings,
				captionSourceRef: {
					mediaElementId: stableSourceId,
					transcriptVersion: sourceVersion,
				},
			},
		});
		changed = true;
	}

	if (!changed) {
		return { tracks, changed: false };
	}

	nextTracks = nextTracks.map((track) => {
		if (track.type !== "text") return track;
		const filteredElements =
			duplicateCaptionIds.size > 0
				? track.elements.filter((element) => !duplicateCaptionIds.has(element.id))
				: track.elements;
		const updatesForTrack = updatedCaptionElements.filter(
			(item) => item.trackId === track.id,
		);
		if (updatesForTrack.length === 0) {
			if (filteredElements !== track.elements) {
				return { ...track, elements: filteredElements };
			}
			return track;
		}

		const updateMap = new Map(updatesForTrack.map((item) => [item.element.id, item.element]));
		const existing = filteredElements.map((element) => {
			const updated = updateMap.get(element.id);
			return updated ? updated : element;
		});
		const appended = updatesForTrack
			.filter(
				(item) =>
					!filteredElements.some((element) => element.id === item.element.id),
			)
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

export function rebuildCaptionTrackForMediaElement({
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
	const sourceRefId = resolveTranscriptUnitSourceRefId({
		mediaElement: mediaRecord.element,
		mediaElementId,
	});
	const companionMediaIds = collectCompanionMediaIds({
		tracks,
		mediaElementId,
		targetMediaElement: mediaRecord.element,
		sourceRefId,
	});
	const payload = buildCaptionPayloadFromTranscriptWords({
		words: transcriptEdit.words,
		cuts: resolveEffectiveTranscriptCuts({
			words: transcriptEdit.words,
			cuts: transcriptEdit.cuts,
		}),
	});
	if (!payload) {
		return { tracks, changed: false, error: "cannot rebuild caption from empty transcript" };
	}
	const timelinePayload = toTimelineCaptionPayload({
		payload,
		mediaStartTime: mediaRecord.element.startTime,
		alreadyTimelineAligned: isTranscriptAlreadyTimelineAligned({
			words: transcriptEdit.words,
			mediaStartTime: mediaRecord.element.startTime,
			mediaDuration: mediaRecord.element.duration,
		}),
	});
	const preferredTrackId = resolveRebuildTargetCaptionTrackId({
		tracks,
		mediaElementId,
		sourceRefId,
		companionMediaIds,
	});
	const ensured = preferredTrackId
		? { tracks, trackId: preferredTrackId }
		: ensureCaptionTrack({ tracks });
	const trackId = ensured.trackId;
	const nextTracks = ensured.tracks.map((track) => {
		if (track.type !== "text") return track;
		const styleSeed = resolveCaptionSeedStyle({ track });
		const rebuilt: TextElement = {
			...DEFAULT_TEXT_ELEMENT,
			...styleSeed,
			id: crypto.randomUUID(),
			name: "Caption 1",
			content: timelinePayload.content,
			startTime: timelinePayload.startTime,
			duration: timelinePayload.duration,
			captionWordTimings: timelinePayload.wordTimings,
			captionSourceRef: {
				mediaElementId,
				transcriptVersion: transcriptEdit.version,
			},
		};
		if (track.id !== trackId) {
			const filtered = track.elements.filter((element) => {
				if (element.type !== "text") return true;
				const linkedMediaId = element.captionSourceRef?.mediaElementId;
				return !(
					(typeof linkedMediaId === "string" &&
						companionMediaIds.has(linkedMediaId)) ||
					(linkedMediaId === sourceRefId && sourceRefId !== mediaElementId)
				);
			});
			if (filtered.length === track.elements.length) return track;
			return {
				...track,
				elements: filtered,
			};
		}
		return {
			...track,
			hidden: false,
			elements: [rebuilt],
		};
	});
	return { tracks: nextTracks, changed: true };
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
