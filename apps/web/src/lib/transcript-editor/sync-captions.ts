import { resolveBlueHighlightCaptionPreset } from "@/constants/caption-presets";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { findCaptionTrackIdInScene } from "@/lib/captions/caption-track";
import {
	buildTranscriptTimelineSnapshot,
	type TranscriptTimelineSnapshot,
	validateCaptionAgainstSnapshot,
} from "@/lib/transcript-editor/snapshot";
import type { TimelineTrack, VideoElement, AudioElement, TextElement } from "@/types/timeline";

function isEditableMediaElement(
	element: unknown,
): element is VideoElement | AudioElement {
	if (!element || typeof element !== "object") return false;
	const candidate = element as { type?: string };
	return candidate.type === "video" || candidate.type === "audio";
}

function hasStrongRangeOverlap({
	startA,
	endA,
	startB,
	endB,
	minRatio = 0.8,
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
	const minDuration = Math.min(aDuration, bDuration);
	return overlap / minDuration >= minRatio;
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
	if (startAligned && trimAligned && endAligned) return true;

	const candidateTimelineEnd = candidate.startTime + candidate.duration;
	const targetTimelineEnd = target.startTime + target.duration;
	const candidateSourceEnd = candidate.trimStart + candidate.duration;
	const targetSourceEnd = target.trimStart + target.duration;
	const timelineOverlap = hasStrongRangeOverlap({
		startA: candidate.startTime,
		endA: candidateTimelineEnd,
		startB: target.startTime,
		endB: targetTimelineEnd,
	});
	const sourceOverlap = hasStrongRangeOverlap({
		startA: candidate.trimStart,
		endA: candidateSourceEnd,
		startB: target.trimStart,
		endB: targetSourceEnd,
	});
	return timelineOverlap && sourceOverlap;
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

type CaptionTelemetryEventName = "caption_drift_detected" | "caption_drift_autohealed";
const DRIFT_TELEMETRY_THROTTLE_MS = 3_000;
const MAX_DRIFT_TELEMETRY_ENTRIES = 500;
const driftTelemetryLastEmittedAt = new Map<string, number>();

function emitCaptionTelemetry({
	event,
	projectId,
	mediaElementId,
	reason,
	revisionKeyBefore,
	revisionKeyAfter,
}: {
	event: CaptionTelemetryEventName;
	projectId: string;
	mediaElementId: string;
	reason: string;
	revisionKeyBefore?: string;
	revisionKeyAfter?: string;
}) {
	const telemetryKey = `${event}:${projectId}:${mediaElementId}:${reason}`;
	const now = Date.now();
	const last = driftTelemetryLastEmittedAt.get(telemetryKey) ?? 0;
	if (now - last < DRIFT_TELEMETRY_THROTTLE_MS) return;
	driftTelemetryLastEmittedAt.set(telemetryKey, now);
	while (driftTelemetryLastEmittedAt.size > MAX_DRIFT_TELEMETRY_ENTRIES) {
		const oldestKey = driftTelemetryLastEmittedAt.keys().next().value;
		if (!oldestKey) break;
		driftTelemetryLastEmittedAt.delete(oldestKey);
	}
	const payload = {
		event,
		projectId,
		mediaElementId,
		reason,
		revisionKeyBefore,
		revisionKeyAfter,
		timestamp: new Date(now).toISOString(),
	};
	console.info("[caption-telemetry]", payload);
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent("opencut:caption-telemetry", {
				detail: payload,
			}),
		);
	}
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

export function reconcileCaptionFromSnapshot({
	tracks,
	mediaElementId,
	snapshot,
}: {
	tracks: TimelineTrack[];
	mediaElementId: string;
	snapshot: TranscriptTimelineSnapshot;
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
	if (!snapshot.captionPayload) {
		const removed = removeLinkedCaptionsForMedia({
			tracks,
			linkedMediaElementIds: companionMediaIds,
			legacySourceRefId: sourceRefId !== mediaElementId ? sourceRefId : undefined,
		});
		return removed.changed
			? { tracks: removed.tracks, changed: true }
			: { tracks, changed: false, error: "transcript edit metadata missing" };
	}

	const timelinePayload = snapshot.captionPayload;
	const sourceVersion = snapshot.transcriptVersion;
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
		updatedCaptionElements.push({
			trackId: primaryCaption.trackId,
			element: {
				...primaryCaption.element,
				content: finalPayload.content,
				startTime: finalPayload.startTime,
				duration: finalPayload.duration,
				captionWordTimings: finalPayload.wordTimings,
				captionSourceRef: {
					mediaElementId,
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
		return reconcileCaptionFromSnapshot({
			tracks,
			mediaElementId,
			snapshot: buildTranscriptTimelineSnapshot({
				mediaElementId,
				transcriptVersion: 1,
				updatedAt: "",
				words: [],
				cuts: [],
				mediaStartTime: mediaRecord.element.startTime,
				mediaDuration: mediaRecord.element.duration,
			}),
		});
	}
	const snapshot = buildTranscriptTimelineSnapshot({
		mediaElementId,
		transcriptVersion: transcriptEdit.version,
		updatedAt: transcriptEdit.updatedAt,
		words: transcriptEdit.words,
		cuts: transcriptEdit.cuts,
		mediaStartTime: mediaRecord.element.startTime,
		mediaDuration: mediaRecord.element.duration,
	});
	return reconcileCaptionFromSnapshot({ tracks, mediaElementId, snapshot });
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
	const snapshot = buildTranscriptTimelineSnapshot({
		mediaElementId,
		transcriptVersion: transcriptEdit.version,
		updatedAt: transcriptEdit.updatedAt,
		words: transcriptEdit.words,
		cuts: transcriptEdit.cuts,
		mediaStartTime: mediaRecord.element.startTime,
		mediaDuration: mediaRecord.element.duration,
	});
	if (!snapshot.captionPayload) {
		return { tracks, changed: false, error: "cannot rebuild caption from empty transcript" };
	}
	const timelinePayload = snapshot.captionPayload;
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

function buildCaptionRevisionKey({
	element,
}: {
	element: TextElement;
}): string {
	const timings = element.captionWordTimings ?? [];
	const signature = JSON.stringify({
		content: element.content,
		wordTimings: timings.map((timing) => [
			timing.word,
			Number(timing.startTime.toFixed(3)),
			Number(timing.endTime.toFixed(3)),
		]),
		source: element.captionSourceRef?.mediaElementId ?? "",
		version: element.captionSourceRef?.transcriptVersion ?? 0,
	});
	let hash = 0x811c9dc5;
	for (let i = 0; i < signature.length; i++) {
		hash ^= signature.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

export function validateAndHealCaptionDriftInTracks({
	tracks,
	projectId,
}: {
	tracks: TimelineTrack[];
	projectId: string;
}): { tracks: TimelineTrack[]; changed: boolean } {
	const mediaById = new Map<string, VideoElement | AudioElement>();
	for (const track of tracks) {
		for (const element of track.elements) {
			if (!isEditableMediaElement(element)) continue;
			mediaById.set(element.id, element);
		}
	}

	let nextTracks = tracks;
	let changed = false;
	const healTargets = new Set<string>();
	for (const track of tracks) {
		if (track.type !== "text") continue;
		for (const element of track.elements) {
			if (element.type !== "text") continue;
			const sourceMediaId = element.captionSourceRef?.mediaElementId;
			if (!sourceMediaId) continue;
			const sourceMedia = mediaById.get(sourceMediaId);
			const transcriptEdit = sourceMedia?.transcriptEdit;
			if (!sourceMedia || !transcriptEdit) continue;
			const snapshot = buildTranscriptTimelineSnapshot({
				mediaElementId: sourceMediaId,
				transcriptVersion: transcriptEdit.version,
				updatedAt: transcriptEdit.updatedAt,
				words: transcriptEdit.words,
				cuts: transcriptEdit.cuts,
				mediaStartTime: sourceMedia.startTime,
				mediaDuration: sourceMedia.duration,
			});
			const validation = validateCaptionAgainstSnapshot({
				captionElement: element,
				snapshot,
			});
			if (validation.valid) continue;
			emitCaptionTelemetry({
				event: "caption_drift_detected",
				projectId,
				mediaElementId: sourceMediaId,
				reason: validation.reason,
				revisionKeyBefore: buildCaptionRevisionKey({ element }),
				revisionKeyAfter: snapshot.revisionKey,
			});
			healTargets.add(sourceMediaId);
		}
	}

	for (const mediaElementId of healTargets) {
		const result = syncCaptionsFromTranscriptEdits({
			tracks: nextTracks,
			mediaElementId,
		});
		if (!result.changed) continue;
		nextTracks = result.tracks;
		changed = true;
		const sourceMedia = mediaById.get(mediaElementId);
		const transcriptEdit = sourceMedia?.transcriptEdit;
		if (!sourceMedia || !transcriptEdit) continue;
		const snapshot = buildTranscriptTimelineSnapshot({
			mediaElementId,
			transcriptVersion: transcriptEdit.version,
			updatedAt: transcriptEdit.updatedAt,
			words: transcriptEdit.words,
			cuts: transcriptEdit.cuts,
			mediaStartTime: sourceMedia.startTime,
			mediaDuration: sourceMedia.duration,
		});
		emitCaptionTelemetry({
			event: "caption_drift_autohealed",
			projectId,
			mediaElementId,
			reason: "sync-captions-from-transcript",
			revisionKeyAfter: snapshot.revisionKey,
		});
	}

	return { tracks: nextTracks, changed };
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

export function dedupeTranscriptEditsInTracks({
	tracks,
}: {
	tracks: TimelineTrack[];
}): { tracks: TimelineTrack[]; changed: boolean } {
	const mediaEntries = tracks.flatMap((track) =>
		track.elements
			.filter((element): element is VideoElement | AudioElement =>
				isEditableMediaElement(element),
			)
			.map((element) => ({ trackId: track.id, element })),
	);
	if (mediaEntries.length === 0) return { tracks, changed: false };

	const mediaById = new Map(mediaEntries.map((entry) => [entry.element.id, entry.element]));
	const sourceRefByMediaId = new Map(
		mediaEntries.map((entry) => [
			entry.element.id,
			resolveTranscriptUnitSourceRefId({
				mediaElement: entry.element,
				mediaElementId: entry.element.id,
			}),
		]),
	);

	const captionTargetBySourceRef = new Map<string, string>();
	for (const track of tracks) {
		if (track.type !== "text") continue;
		for (const element of track.elements) {
			if (element.type !== "text") continue;
			if (element.captionStyle?.linkedToCaptionGroup === false) continue;
			const mediaElementId = element.captionSourceRef?.mediaElementId;
			if (!mediaElementId) continue;
			const sourceRefId =
				sourceRefByMediaId.get(mediaElementId) ?? mediaElementId;
			captionTargetBySourceRef.set(sourceRefId, mediaElementId);
		}
	}

	const groups = new Map<string, Array<VideoElement | AudioElement>>();
	for (const entry of mediaEntries) {
		if (!entry.element.transcriptEdit) continue;
		const sourceRefId = sourceRefByMediaId.get(entry.element.id) ?? entry.element.id;
		const existing = groups.get(sourceRefId);
		if (existing) {
			existing.push(entry.element);
		} else {
			groups.set(sourceRefId, [entry.element]);
		}
	}
	if (groups.size === 0) return { tracks, changed: false };

	const keepIds = new Set<string>();
	for (const [sourceRefId, group] of groups.entries()) {
		const captionTargetId = captionTargetBySourceRef.get(sourceRefId);
		const captionTarget = captionTargetId ? mediaById.get(captionTargetId) : null;
		const primary = captionTarget?.transcriptEdit
			? captionTarget
			: group.reduce((best, candidate) => {
				const bestUpdatedAtMs =
					Date.parse(best.transcriptEdit?.updatedAt ?? "") || 0;
				const candidateUpdatedAtMs =
					Date.parse(candidate.transcriptEdit?.updatedAt ?? "") || 0;
				return candidateUpdatedAtMs > bestUpdatedAtMs ? candidate : best;
			}, group[0]);
		keepIds.add(primary.id);
	}

	let changed = false;
	const nextTracks = tracks.map((track) => {
		if (track.type !== "video" && track.type !== "audio") return track;
		const nextElements = track.elements.map((element) => {
			if (!isEditableMediaElement(element)) return element;
			if (!element.transcriptEdit) return element;
			if (keepIds.has(element.id)) return element;
			changed = true;
			return { ...element, transcriptEdit: undefined };
		});
		return { ...track, elements: nextElements } as TimelineTrack;
	});

	return changed ? { tracks: nextTracks, changed: true } : { tracks, changed: false };
}
