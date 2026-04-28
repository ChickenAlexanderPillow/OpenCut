import { resolveBlueHighlightCaptionPreset } from "@/constants/caption-presets";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { isCaptionTimingRelativeToElement } from "@/lib/captions/timing";
import { findCaptionTrackIdInScene } from "@/lib/captions/caption-track";
import {
	buildTranscriptTimelineSnapshot,
	clearTranscriptTimelineSnapshotCache,
	type TranscriptTimelineSnapshot,
	validateCaptionAgainstSnapshot,
} from "@/lib/transcript-editor/snapshot";
import {
	getTranscriptApplied,
	getTranscriptDraft,
	withTranscriptState,
} from "@/lib/transcript-editor/state";
import type {
	TimelineTrack,
	VideoElement,
	AudioElement,
	TextElement,
} from "@/types/timeline";

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

function ensureCaptionTrack({ tracks }: { tracks: TimelineTrack[] }): {
	tracks: TimelineTrack[];
	trackId: string;
} {
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
	const firstWordId = getTranscriptDraft(mediaElement)?.words[0]?.id ?? "";
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

function findEditableMediaRecord({
	tracks,
	mediaElementId,
}: {
	tracks: TimelineTrack[];
	mediaElementId: string;
}): { track: TimelineTrack; element: VideoElement | AudioElement } | null {
	for (const track of tracks) {
		for (const element of track.elements) {
			if (element.id !== mediaElementId) continue;
			if (!isEditableMediaElement(element)) continue;
			return { track, element };
		}
	}
	return null;
}

function areCaptionWordTimingsEqual({
	previous,
	next,
}: {
	previous: NonNullable<TextElement["captionWordTimings"]>;
	next: NonNullable<TextElement["captionWordTimings"]>;
}): boolean {
	if (previous === next) return true;
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index++) {
		const prev = previous[index];
		const curr = next[index];
		if (!prev || !curr) return false;
		if (prev.word !== curr.word) return false;
		if (Math.abs(prev.startTime - curr.startTime) > 1e-6) return false;
		if (Math.abs(prev.endTime - curr.endTime) > 1e-6) return false;
		if (Boolean(prev.hidden) !== Boolean(curr.hidden)) return false;
	}
	return true;
}

function isCaptionElementAlreadySynced({
	element,
	payload,
	mediaElementId,
	sourceVersion,
}: {
	element: TextElement;
	payload: NonNullable<TranscriptTimelineSnapshot["captionPayload"]>;
	mediaElementId: string;
	sourceVersion: number;
}): boolean {
	const sourceRef = element.captionSourceRef;
	const currentTimings = element.captionWordTimings ?? [];
	return (
		element.content === payload.content &&
		element.startTime === payload.startTime &&
		element.duration === payload.duration &&
		sourceRef?.mediaElementId === mediaElementId &&
		sourceRef?.transcriptVersion === sourceVersion &&
		areCaptionWordTimingsEqual({
			previous: currentTimings,
			next: payload.wordTimings,
		})
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
			candidate.trimStart +
				candidate.duration -
				(target.trimStart + target.duration),
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
		if (
			!isCompanionAligned({ target: targetMediaElement, candidate: element })
		) {
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

type CaptionTelemetryEventName =
	| "caption_drift_detected"
	| "caption_drift_autohealed";
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
	| "strokeColor"
	| "strokeWidth"
	| "strokeSoftness"
	| "shadowColor"
	| "shadowOpacity"
	| "shadowDistance"
	| "shadowAngle"
	| "shadowSoftness"
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
			strokeColor: seed.strokeColor,
			strokeWidth: seed.strokeWidth,
			strokeSoftness: seed.strokeSoftness,
			shadowColor: seed.shadowColor,
			shadowOpacity: seed.shadowOpacity,
			shadowDistance: seed.shadowDistance,
			shadowAngle: seed.shadowAngle,
			shadowSoftness: seed.shadowSoftness,
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
		strokeColor: blue.textProps.strokeColor ?? DEFAULT_TEXT_ELEMENT.strokeColor,
		strokeWidth: blue.textProps.strokeWidth ?? DEFAULT_TEXT_ELEMENT.strokeWidth,
		strokeSoftness:
			blue.textProps.strokeSoftness ?? DEFAULT_TEXT_ELEMENT.strokeSoftness,
		shadowColor: blue.textProps.shadowColor ?? DEFAULT_TEXT_ELEMENT.shadowColor,
		shadowOpacity:
			blue.textProps.shadowOpacity ?? DEFAULT_TEXT_ELEMENT.shadowOpacity,
		shadowDistance:
			blue.textProps.shadowDistance ?? DEFAULT_TEXT_ELEMENT.shadowDistance,
		shadowAngle: blue.textProps.shadowAngle ?? DEFAULT_TEXT_ELEMENT.shadowAngle,
		shadowSoftness:
			blue.textProps.shadowSoftness ?? DEFAULT_TEXT_ELEMENT.shadowSoftness,
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
	const mediaRecord = findEditableMediaRecord({ tracks, mediaElementId });
	if (!mediaRecord) {
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
			legacySourceRefId:
				sourceRefId !== mediaElementId ? sourceRefId : undefined,
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

	const relatedMediaBySourceRef = collectEditableMediaElements({
		tracks,
	}).filter(
		(element) =>
			resolveTranscriptUnitSourceRefId({
				mediaElement: element,
				mediaElementId: element.id,
			}) === sourceRefId,
	);
	const canUseLegacySourceRefMatching =
		sourceRefId !== mediaElementId &&
		relatedMediaBySourceRef.length <= companionMediaIds.size;

	const linkedCaptions = nextTracks.flatMap((track) =>
		track.type === "text"
			? track.elements
					.filter((element) => {
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
					})
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
										Math.abs(element.duration - timelinePayload.duration) <=
											1.5,
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

	const updatedCaptionElements: Array<{
		trackId: string;
		element: TextElement;
	}> = [];
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
		if (
			!isCaptionElementAlreadySynced({
				element: primaryCaption.element,
				payload: finalPayload,
				mediaElementId,
				sourceVersion,
			})
		) {
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
	}

	if (!changed) {
		return { tracks, changed: false };
	}

	nextTracks = nextTracks.map((track) => {
		if (track.type !== "text") return track;
		const filteredElements =
			duplicateCaptionIds.size > 0
				? track.elements.filter(
						(element) => !duplicateCaptionIds.has(element.id),
					)
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

		const updateMap = new Map(
			updatesForTrack.map((item) => [item.element.id, item.element]),
		);
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
	const mediaRecord = findEditableMediaRecord({ tracks, mediaElementId });
	if (!mediaRecord) {
		return { tracks, changed: false, error: "media element not found" };
	}
	const transcriptDraft = getTranscriptDraft(mediaRecord.element);
	const transcriptApplied = getTranscriptApplied(mediaRecord.element);
	if (
		!transcriptDraft ||
		transcriptDraft.words.length === 0 ||
		!transcriptApplied
	) {
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
	return reconcileCaptionFromSnapshot({
		tracks,
		mediaElementId,
		snapshot: {
			mediaElementId,
			updatedAt: transcriptApplied.updatedAt,
			transcriptVersion: transcriptDraft.version,
			revisionKey: transcriptApplied.revisionKey,
			words: transcriptDraft.words,
			wordsWithCutState: transcriptDraft.words,
			activeWords: transcriptDraft.words.filter((word) => !word.removed),
			effectiveCuts: transcriptApplied.removedRanges,
			captionPayload: transcriptApplied.captionPayload,
			isTimelineAligned: true,
			timeMap: {
				toSourceTime: (time) => time,
				toCompressedTime: (time) => time,
			},
		},
	});
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
	const mediaRecord = findEditableMediaRecord({ tracks, mediaElementId });
	if (!mediaRecord) {
		return { tracks, changed: false, error: "media element not found" };
	}
	const transcriptDraft = getTranscriptDraft(mediaRecord.element);
	const transcriptApplied = getTranscriptApplied(mediaRecord.element);
	if (
		!transcriptDraft ||
		transcriptDraft.words.length === 0 ||
		!transcriptApplied
	) {
		return {
			tracks,
			changed: false,
			error: "transcript edit metadata missing",
		};
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
	if (!transcriptApplied.captionPayload) {
		return {
			tracks,
			changed: false,
			error: "cannot rebuild caption from empty transcript",
		};
	}
	const timelinePayload = transcriptApplied.captionPayload;
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
				transcriptVersion: transcriptDraft.version,
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
	let hash = 0x811c9dc5;
	const updateHash = (value: string): void => {
		for (let index = 0; index < value.length; index++) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193);
		}
	};
	updateHash(element.content);
	const timings = element.captionWordTimings ?? [];
	updateHash(String(timings.length));
	for (const timing of timings) {
		updateHash(timing.word);
		updateHash(timing.startTime.toFixed(3));
		updateHash(timing.endTime.toFixed(3));
	}
	updateHash(element.captionSourceRef?.mediaElementId ?? "");
	updateHash(String(element.captionSourceRef?.transcriptVersion ?? 0));
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
			const transcriptDraft = sourceMedia
				? getTranscriptDraft(sourceMedia)
				: undefined;
			const transcriptApplied = sourceMedia
				? getTranscriptApplied(sourceMedia)
				: undefined;
			if (!sourceMedia || !transcriptDraft || !transcriptApplied) continue;
			const snapshot = buildTranscriptTimelineSnapshot({
				mediaElementId: sourceMediaId,
				transcriptVersion: transcriptDraft.version,
				updatedAt: transcriptDraft.updatedAt,
				words: transcriptDraft.words,
				cuts: transcriptApplied.removedRanges,
				gapEdits: transcriptDraft.gapEdits,
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
		const transcriptDraft = sourceMedia
			? getTranscriptDraft(sourceMedia)
			: undefined;
		const transcriptApplied = sourceMedia
			? getTranscriptApplied(sourceMedia)
			: undefined;
		if (!sourceMedia || !transcriptDraft || !transcriptApplied) continue;
		const snapshot = buildTranscriptTimelineSnapshot({
			mediaElementId,
			transcriptVersion: transcriptDraft.version,
			updatedAt: transcriptDraft.updatedAt,
			words: transcriptDraft.words,
			cuts: transcriptApplied.removedRanges,
			gapEdits: transcriptDraft.gapEdits,
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

function alignLinkedCaptionBoundsToSourceMedia({
	tracks,
	sourceMediaById,
}: {
	tracks: TimelineTrack[];
	sourceMediaById: Map<string, VideoElement | AudioElement>;
}): { tracks: TimelineTrack[]; changed: boolean } {
	let changed = false;
	const nextTracks = tracks.map((track) => {
		if (track.type !== "text") return track;
		let trackChanged = false;
		const nextElements = track.elements.map((element) => {
			if (element.type !== "text") return element;
			const sourceMediaId = element.captionSourceRef?.mediaElementId;
			if (!sourceMediaId) return element;
			const sourceMedia = sourceMediaById.get(sourceMediaId);
			if (!sourceMedia) return element;
			if (
				Math.abs(element.startTime - sourceMedia.startTime) < 1e-6 &&
				Math.abs(element.duration - sourceMedia.duration) < 1e-6
			) {
				return element;
			}
			const existingTimings = element.captionWordTimings ?? [];
			const timingsAreRelative = isCaptionTimingRelativeToElement({
				timings: existingTimings,
				elementDuration: element.duration,
			});
			const startShift = sourceMedia.startTime - element.startTime;
			const sourceStart = sourceMedia.startTime;
			const sourceEnd = sourceMedia.startTime + sourceMedia.duration;
			const shiftedTimings =
				existingTimings.length === 0 || timingsAreRelative
					? existingTimings
					: existingTimings
							.map((timing) => ({
								word: timing.word,
								startTime: timing.startTime + startShift,
								endTime: timing.endTime + startShift,
							}))
							.filter(
								(timing) =>
									timing.endTime > sourceStart && timing.startTime < sourceEnd,
							)
							.map((timing) => ({
								word: timing.word,
								startTime: Math.max(sourceStart, timing.startTime),
								endTime: Math.min(sourceEnd, timing.endTime),
							}))
							.filter((timing) => timing.endTime - timing.startTime > 0.001);
			trackChanged = true;
			changed = true;
			return {
				...element,
				startTime: sourceMedia.startTime,
				duration: sourceMedia.duration,
				captionWordTimings: shiftedTimings,
			};
		});
		return trackChanged ? { ...track, elements: nextElements } : track;
	});
	return { tracks: nextTracks, changed };
}

function shiftStaleAbsoluteCaptionTimingsForMovedLinkedMedia({
	beforeTracks,
	tracks,
	beforeMediaById,
	afterMediaById,
}: {
	beforeTracks: TimelineTrack[];
	tracks: TimelineTrack[];
	beforeMediaById: Map<string, VideoElement | AudioElement>;
	afterMediaById: Map<string, VideoElement | AudioElement>;
}): { tracks: TimelineTrack[]; changed: boolean } {
	const beforeCaptionById = new Map<string, TextElement>();
	for (const track of beforeTracks) {
		if (track.type !== "text") continue;
		for (const element of track.elements) {
			if (element.type !== "text") continue;
			beforeCaptionById.set(element.id, element);
		}
	}

	let changed = false;
	const nextTracks = tracks.map((track) => {
		if (track.type !== "text") return track;
		let trackChanged = false;
		const nextElements = track.elements.map((element) => {
			if (element.type !== "text") return element;
			const sourceMediaId = element.captionSourceRef?.mediaElementId;
			if (!sourceMediaId) return element;

			const beforeMedia = beforeMediaById.get(sourceMediaId);
			const afterMedia = afterMediaById.get(sourceMediaId);
			if (!beforeMedia || !afterMedia) return element;
			const mediaStartShift = afterMedia.startTime - beforeMedia.startTime;
			if (Math.abs(mediaStartShift) < 1e-6) return element;

			// Only heal the stale path where caption bounds already moved with media
			// but absolute word timings remained at pre-move timeline positions.
			if (
				Math.abs(element.startTime - afterMedia.startTime) > 1e-6 ||
				Math.abs(element.duration - afterMedia.duration) > 1e-6
			) {
				return element;
			}

			const currentTimings = element.captionWordTimings ?? [];
			if (currentTimings.length === 0) return element;
			const timingsAreRelative = isCaptionTimingRelativeToElement({
				timings: currentTimings,
				elementDuration: element.duration,
			});
			if (timingsAreRelative) return element;

			const beforeCaption = beforeCaptionById.get(element.id);
			if (!beforeCaption) return element;
			const previousTimings = beforeCaption.captionWordTimings ?? [];
			if (
				previousTimings.length === 0 ||
				!areCaptionWordTimingsEqual({
					previous: previousTimings,
					next: currentTimings,
				})
			) {
				return element;
			}

			const sourceStart = afterMedia.startTime;
			const sourceEnd = afterMedia.startTime + afterMedia.duration;
			const shiftedTimings = currentTimings
				.map((timing) => ({
					word: timing.word,
					startTime: timing.startTime + mediaStartShift,
					endTime: timing.endTime + mediaStartShift,
				}))
				.filter(
					(timing) =>
						timing.endTime > sourceStart && timing.startTime < sourceEnd,
				)
				.map((timing) => ({
					word: timing.word,
					startTime: Math.max(sourceStart, timing.startTime),
					endTime: Math.min(sourceEnd, timing.endTime),
				}))
				.filter((timing) => timing.endTime - timing.startTime > 0.001);
			if (
				areCaptionWordTimingsEqual({
					previous: currentTimings,
					next: shiftedTimings,
				})
			) {
				return element;
			}

			trackChanged = true;
			changed = true;
			return {
				...element,
				captionWordTimings: shiftedTimings,
			};
		});
		return trackChanged ? { ...track, elements: nextElements } : track;
	});

	return { tracks: nextTracks, changed };
}

function removeCaptionsLinkedToMissingMedia({
	tracks,
	existingMediaIds,
}: {
	tracks: TimelineTrack[];
	existingMediaIds: Set<string>;
}): { tracks: TimelineTrack[]; changed: boolean } {
	let changed = false;
	const nextTracks = tracks.map((track) => {
		if (track.type !== "text") return track;
		const nextElements = track.elements.filter((element) => {
			if (element.type !== "text") return true;
			const mediaElementId = element.captionSourceRef?.mediaElementId;
			if (!mediaElementId) return true;
			if (existingMediaIds.has(mediaElementId)) return true;
			changed = true;
			return false;
		});
		if (nextElements.length === track.elements.length) return track;
		return { ...track, elements: nextElements };
	});
	return { tracks: nextTracks, changed };
}

type LinkedCaptionInvariantViolation =
	| {
			type: "missing-source-media";
			captionElementId: string;
			mediaElementId: string;
	  }
	| {
			type: "bounds-mismatch";
			captionElementId: string;
			mediaElementId: string;
			captionStartTime: number;
			captionDuration: number;
			mediaStartTime: number;
			mediaDuration: number;
	  };

function collectLinkedCaptionInvariantViolations({
	tracks,
}: {
	tracks: TimelineTrack[];
}): LinkedCaptionInvariantViolation[] {
	const mediaById = new Map<string, VideoElement | AudioElement>();
	for (const track of tracks) {
		for (const element of track.elements) {
			if (!isEditableMediaElement(element)) continue;
			mediaById.set(element.id, element);
		}
	}

	const violations: LinkedCaptionInvariantViolation[] = [];
	for (const track of tracks) {
		if (track.type !== "text") continue;
		for (const element of track.elements) {
			if (element.type !== "text") continue;
			const mediaElementId = element.captionSourceRef?.mediaElementId;
			if (!mediaElementId) continue;
			const sourceMedia = mediaById.get(mediaElementId);
			if (!sourceMedia) {
				violations.push({
					type: "missing-source-media",
					captionElementId: element.id,
					mediaElementId,
				});
				continue;
			}
			if (
				Math.abs(element.startTime - sourceMedia.startTime) > 1e-6 ||
				Math.abs(element.duration - sourceMedia.duration) > 1e-6
			) {
				violations.push({
					type: "bounds-mismatch",
					captionElementId: element.id,
					mediaElementId,
					captionStartTime: element.startTime,
					captionDuration: element.duration,
					mediaStartTime: sourceMedia.startTime,
					mediaDuration: sourceMedia.duration,
				});
			}
		}
	}
	return violations;
}

function reportLinkedCaptionInvariantViolations({
	tracks,
	context,
}: {
	tracks: TimelineTrack[];
	context: string;
}): void {
	if (process.env.NODE_ENV === "production") return;
	const violations = collectLinkedCaptionInvariantViolations({ tracks });
	if (violations.length === 0) return;
	console.warn("[caption-invariant]", {
		context,
		count: violations.length,
		sample: violations.slice(0, 5),
	});
}

export function reconcileLinkedCaptionIntegrityInTracks({
	beforeTracks,
	tracks,
}: {
	beforeTracks: TimelineTrack[];
	tracks: TimelineTrack[];
}): { tracks: TimelineTrack[]; changed: boolean } {
	const beforeMediaById = new Map<string, VideoElement | AudioElement>();
	for (const track of beforeTracks) {
		for (const element of track.elements) {
			if (!isEditableMediaElement(element)) continue;
			beforeMediaById.set(element.id, element);
		}
	}
	const afterMediaById = new Map<string, VideoElement | AudioElement>();
	for (const track of tracks) {
		for (const element of track.elements) {
			if (!isEditableMediaElement(element)) continue;
			afterMediaById.set(element.id, element);
		}
	}

	let nextTracks = tracks;
	let changed = false;

	const orphanCleanup = removeCaptionsLinkedToMissingMedia({
		tracks: nextTracks,
		existingMediaIds: new Set(afterMediaById.keys()),
	});
	if (orphanCleanup.changed) {
		nextTracks = orphanCleanup.tracks;
		changed = true;
	}

	const mediaIdsNeedingTranscriptSync = new Set<string>();
	let hasMediaTimingShift = false;
	for (const [mediaElementId, beforeMedia] of beforeMediaById.entries()) {
		const afterMedia = afterMediaById.get(mediaElementId);
		if (!afterMedia) {
			// Removed media are already handled by orphan cleanup above.
			continue;
		}
		const transcriptWords = getTranscriptDraft(afterMedia)?.words.length ?? 0;
		if (transcriptWords === 0) continue;
		const transcriptUpdatedAt = getTranscriptDraft(afterMedia)?.updatedAt ?? "";
		const beforeTranscriptUpdatedAt =
			getTranscriptDraft(beforeMedia)?.updatedAt ?? "";
		const timingOrTrimChanged =
			Math.abs(afterMedia.startTime - beforeMedia.startTime) > 1e-6 ||
			Math.abs(afterMedia.duration - beforeMedia.duration) > 1e-6 ||
			Math.abs(afterMedia.trimStart - beforeMedia.trimStart) > 1e-6 ||
			Math.abs(afterMedia.trimEnd - beforeMedia.trimEnd) > 1e-6;
		if (timingOrTrimChanged) {
			hasMediaTimingShift = true;
		}
		if (
			timingOrTrimChanged ||
			transcriptUpdatedAt !== beforeTranscriptUpdatedAt
		) {
			mediaIdsNeedingTranscriptSync.add(mediaElementId);
		}
	}
	for (const [mediaElementId, media] of afterMediaById.entries()) {
		if (beforeMediaById.has(mediaElementId)) continue;
		if ((getTranscriptDraft(media)?.words.length ?? 0) > 0) {
			mediaIdsNeedingTranscriptSync.add(mediaElementId);
		}
	}
	if (hasMediaTimingShift) {
		clearTranscriptTimelineSnapshotCache();
	}

	for (const mediaElementId of mediaIdsNeedingTranscriptSync) {
		const syncResult = syncCaptionsFromTranscriptEdits({
			tracks: nextTracks,
			mediaElementId,
		});
		if (syncResult.changed) {
			nextTracks = syncResult.tracks;
			changed = true;
		}
	}

	const staleAbsoluteTimingRepair =
		shiftStaleAbsoluteCaptionTimingsForMovedLinkedMedia({
			beforeTracks,
			tracks: nextTracks,
			beforeMediaById,
			afterMediaById,
		});
	if (staleAbsoluteTimingRepair.changed) {
		nextTracks = staleAbsoluteTimingRepair.tracks;
		changed = true;
	}

	const boundsAligned = alignLinkedCaptionBoundsToSourceMedia({
		tracks: nextTracks,
		sourceMediaById: afterMediaById,
	});
	if (boundsAligned.changed) {
		nextTracks = boundsAligned.tracks;
		changed = true;
	}
	reportLinkedCaptionInvariantViolations({
		tracks: nextTracks,
		context: "reconcile-linked-caption-integrity",
	});

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
			.filter(
				(element) =>
					isEditableMediaElement(element) &&
					Boolean(getTranscriptDraft(element)),
			)
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
	const mediaById = new Map<string, VideoElement | AudioElement>();
	for (const track of nextTracks) {
		for (const element of track.elements) {
			if (!isEditableMediaElement(element)) continue;
			mediaById.set(element.id, element);
		}
	}
	const boundsAligned = alignLinkedCaptionBoundsToSourceMedia({
		tracks: nextTracks,
		sourceMediaById: mediaById,
	});
	if (boundsAligned.changed) {
		nextTracks = boundsAligned.tracks;
		changed = true;
	}
	reportLinkedCaptionInvariantViolations({
		tracks: nextTracks,
		context: "sync-all-captions-from-transcript",
	});
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

	const mediaById = new Map(
		mediaEntries.map((entry) => [entry.element.id, entry.element]),
	);
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
		if (!getTranscriptDraft(entry.element)) continue;
		const sourceRefId =
			sourceRefByMediaId.get(entry.element.id) ?? entry.element.id;
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
		const captionTarget = captionTargetId
			? mediaById.get(captionTargetId)
			: null;
		const primary =
			captionTarget && getTranscriptDraft(captionTarget)
				? captionTarget
				: group.reduce((best, candidate) => {
						const bestUpdatedAtMs =
							Date.parse(getTranscriptDraft(best)?.updatedAt ?? "") || 0;
						const candidateUpdatedAtMs =
							Date.parse(getTranscriptDraft(candidate)?.updatedAt ?? "") || 0;
						return candidateUpdatedAtMs > bestUpdatedAtMs ? candidate : best;
					}, group[0]);
		keepIds.add(primary.id);
	}

	let changed = false;
	const nextTracks = tracks.map((track) => {
		if (track.type !== "video" && track.type !== "audio") return track;
		const nextElements = track.elements.map((element) => {
			if (!isEditableMediaElement(element)) return element;
			if (!getTranscriptDraft(element)) return element;
			if (keepIds.has(element.id)) return element;
			changed = true;
			const preservedApplied = getTranscriptApplied(element);
			return withTranscriptState({
				element,
				draft: undefined,
				applied: preservedApplied,
				compileState: {
					status: "idle",
					updatedAt: preservedApplied?.updatedAt,
				},
			});
		});
		return { ...track, elements: nextElements } as TimelineTrack;
	});

	return changed
		? { tracks: nextTracks, changed: true }
		: { tracks, changed: false };
}
