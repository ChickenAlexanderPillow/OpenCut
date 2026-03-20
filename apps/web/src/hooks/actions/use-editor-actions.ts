"use client";

import { useTimelineStore } from "@/stores/timeline-store";
import { useActionHandler } from "@/hooks/actions/use-action-handler";
import { useEditor } from "../use-editor";
import { useElementSelection } from "../timeline/element/use-element-selection";
import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import { getElementsAtTime } from "@/lib/timeline";
import { toast } from "sonner";
import { generateUUID } from "@/utils/id";
import { TracksSnapshotCommand } from "@/lib/commands/timeline";
import {
	applySmartCutsToTracks,
	computeSmartCutFromTranscriptForElement,
} from "@/lib/editing/smart-cut";
import {
	buildTranscriptionFingerprint,
	findLatestValidTranscriptionCacheEntry,
	getTranscriptionCacheKey,
} from "@/lib/transcription/cache";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	TRANSCRIPT_CACHE_VERSION,
} from "@/constants/transcription-constants";
import { extractTimelineAudio } from "@/lib/media/mediabunny";
import { createAudioContext, decodeAudioToFloat32 } from "@/lib/media/audio";
import { transcriptionService } from "@/services/transcription/service";
import type {
	AudioElement,
	TextElement,
	TimelineElement,
	TimelineTrack,
	VideoElement,
	VideoMotionTracking,
	VideoReframePreset,
	VisualElement,
} from "@/types/timeline";
import type {
	TranscriptEditCutRange,
	TranscriptionModelId,
	TranscriptionSegment,
} from "@/types/transcription";
import { useTranscriptionStatusStore } from "@/stores/transcription-status-store";
import { useProjectProcessStore } from "@/stores/project-process-store";
import { useClipGenerationStore } from "@/stores/clip-generation-store";
import { buildClipCandidatesFromTranscript } from "@/lib/clips/candidate-builder";
import { buildClipCandidatesFromTranscriptV2 } from "@/lib/clips/v2/candidate-builder";
import {
	selectTopCandidatesWithCoverageBackfill,
	selectTopCandidatesWithQualityGate,
} from "@/lib/clips/scoring";
import {
	buildClipTranscriptEntryFromLinkedExternalTranscript,
	clipTranscriptSegmentsForWindow,
	clipTranscriptWordsForWindow,
	getOrCreateClipTranscriptForAsset,
	PROJECT_MEDIA_TRANSCRIPT_LANGUAGE,
} from "@/lib/clips/transcript";
import { evaluateTranscriptSuitability } from "@/lib/external-projects/transcript-suitability";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { resolveBlueHighlightCaptionPreset } from "@/constants/caption-presets";
import { findCaptionTrackIdInScene } from "@/lib/captions/caption-track";
import { normalizeGeneratedCaptionsInProject } from "@/lib/captions/generated-caption-normalizer";
import { getMainTrack } from "@/lib/timeline/track-utils";
import {
	canElementHaveAudio,
	isVisualElement,
} from "@/lib/timeline/element-utils";
import {
	getTransitionPreset,
	type TransitionSide,
} from "@/lib/transitions/presets";
import {
	buildApplyTransitionCommand,
	buildRemoveTransitionCommand,
} from "@/lib/transitions/commands";
import type { MediaAsset } from "@/types/assets";
import type { TProject } from "@/types/project";
import type { ClipCandidate } from "@/types/clip-generation";
import {
	DEFAULT_BLEND_MODE,
	DEFAULT_OPACITY,
	DEFAULT_TRANSFORM,
} from "@/constants/timeline-constants";
import { getVideoInfo } from "@/lib/media/mediabunny";
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import {
	buildPauseCutsFromWords,
	buildCaptionPayloadFromTranscriptWords,
	buildTranscriptCutsFromWords,
	buildTranscriptGapId,
	computeKeepDuration,
	isFillerWordOrPhrase,
	mergeCutRanges,
	normalizeTranscriptGapEdits,
	normalizeTranscriptWords,
} from "@/lib/transcript-editor/core";
import {
	buildTranscriptWordsFromSegments,
	buildTranscriptWordsFromTimedWords,
} from "@/lib/media/transcript-import";
import { buildTranscriptWordsFromCaptionTimings } from "@/lib/transcript-editor/caption-fallback";
import { DEFAULT_PAUSE_REMOVAL_MIN_GAP_SECONDS } from "@/lib/transcript-editor/constants";
import { clearTranscriptTimelineSnapshotCache } from "@/lib/transcript-editor/snapshot";
import {
	compileTranscriptDraft,
	getTranscriptApplied,
	getTranscriptCompileState,
	getTranscriptDraft,
	withTranscriptState,
} from "@/lib/transcript-editor/state";
import { buildDefaultTranscriptSegmentsUi } from "@/lib/transcript-editor/segments";
import {
	dedupeTranscriptEditsInTracks,
	rebuildCaptionTrackForMediaElement,
	syncCaptionsFromTranscriptEdits,
	validateAndHealCaptionDriftInTracks,
} from "@/lib/transcript-editor/sync-captions";
import {
	cancelPreparedPlaybackStart,
	PREPARING_PLAYBACK_REASON,
	startPlaybackWhenReady,
} from "@/lib/playback/start-playback";
import {
	analyzeGeneratedClipMotionTracking,
	analyzeGeneratedClipReframes,
	getVideoElementSourceRange,
} from "@/lib/reframe/subject-aware";
import { buildSpeakerTurnReframeSwitches } from "@/lib/reframe/speaker-turns";
import { normalizeMotionTrackingStrength } from "@/lib/reframe/motion-tracking";
import { buildDefaultVideoSplitScreenBindings } from "@/lib/reframe/video-reframe";
import { didRevealNewSourceRange } from "@/lib/timeline/clip-expansion";
const MIN_VIRAL_CLIP_SCORE = 56;
const MAX_VIRAL_CLIP_COUNT = 5;
const VIRAL_CLIP_MIN_SECONDS = 18;
const VIRAL_CLIP_TARGET_SECONDS = 36;
const VIRAL_CLIP_MAX_SECONDS = 65;
const CLIP_SCORING_TRANSCRIPT_MAX_CHARS = 20000;
const CLIP_SCORING_TIMEOUT_MS = 120000;
const CLIP_IMPORT_TRANSCRIPTION_MODEL = "medium";
const CLIP_TRANSCRIPTION_TIMEOUT_MS = 60000;
const CLIP_TRANSCRIPTION_MIN_DURATION_SECONDS = 0.35;
const CLIP_TRANSCRIPTION_MAX_DURATION_SECONDS = 240;
const CLIP_TRANSCRIPTION_MAX_FILE_BYTES = 20 * 1024 * 1024;
const CLIP_WORD_TRANSCRIPTION_CACHE_VERSION = 7;
const SMART_CUT_WORD_JOIN_GAP_SECONDS = 0.45;
const clipTranscriptionInFlight = new Map<
	string,
	Promise<TranscriptionSegment[] | null>
>();
const clipTranscriptInFlight = new Map<
	string,
	Promise<Awaited<ReturnType<typeof getOrCreateClipTranscriptForAsset>>>
>();
const transcriptCompileTimers = new Map<string, number>();
const EDITOR_SUBSCRIBE_PROJECT = ["project"] as const;

function asVisualTargetElement({
	element,
}: {
	element: TimelineElement;
}): VisualElement | null {
	return isVisualElement(element) ? element : null;
}

function withProjectClipGenerationCache({
	project,
	sourceMediaId,
	candidates,
	transcriptRef,
	error,
}: {
	project: TProject;
	sourceMediaId: string;
	candidates: ClipCandidate[];
	transcriptRef: {
		cacheKey: string;
		modelId: string;
		language: string;
		updatedAt: string;
	} | null;
	error: string | null;
}): TProject {
	return {
		...project,
		clipGenerationCache: {
			...(project.clipGenerationCache ?? {}),
			[sourceMediaId]: {
				sourceMediaId,
				candidates,
				transcriptRef,
				error,
				updatedAt: new Date().toISOString(),
			},
		},
	};
}

function truncateTranscriptForScoring({
	transcript,
}: {
	transcript: string;
}): string {
	if (transcript.length <= CLIP_SCORING_TRANSCRIPT_MAX_CHARS) {
		return transcript;
	}
	return `${transcript.slice(0, CLIP_SCORING_TRANSCRIPT_MAX_CHARS)}\n[Transcript truncated for scoring request]`;
}

function buildClipWordTranscriptionCacheKey({
	mediaId,
	startTime,
	endTime,
	modelId,
}: {
	mediaId: string;
	startTime: number;
	endTime: number;
	modelId: string;
}): string {
	return [
		mediaId,
		modelId,
		`v${CLIP_WORD_TRANSCRIPTION_CACHE_VERSION}`,
		startTime.toFixed(3),
		endTime.toFixed(3),
	].join(":");
}

function resolveMediaDurationForClipCandidates({
	assetDuration,
	segments,
}: {
	assetDuration: number | undefined;
	segments: TranscriptionSegment[];
}): number {
	if (
		typeof assetDuration === "number" &&
		Number.isFinite(assetDuration) &&
		assetDuration > 0
	) {
		return assetDuration;
	}
	const inferredFromTranscript = segments[segments.length - 1]?.end ?? 0;
	return Number.isFinite(inferredFromTranscript) && inferredFromTranscript > 0
		? inferredFromTranscript
		: 0;
}

function overlapRatio({
	aStart,
	aEnd,
	bStart,
	bEnd,
}: {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
}): number {
	const intersection = Math.max(
		0,
		Math.min(aEnd, bEnd) - Math.max(aStart, bStart),
	);
	const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
	if (union <= 0) return 0;
	return intersection / union;
}

function roundToHundredth(value: number): number {
	return Math.round(value * 100) / 100;
}

function isLikelyWordLevelTranscript({
	segments,
}: {
	segments: TranscriptionSegment[];
}): boolean {
	if (segments.length < 80) return false;
	const sample = segments.slice(0, Math.min(250, segments.length));
	if (sample.length === 0) return false;
	let shortSegmentCount = 0;
	let charCount = 0;
	for (const segment of sample) {
		const text = segment.text.trim();
		const tokenCount = text.length > 0 ? (text.match(/\S+/g)?.length ?? 0) : 0;
		if (tokenCount > 0 && tokenCount <= 3) shortSegmentCount += 1;
		charCount += text.length;
	}
	const shortRatio = shortSegmentCount / sample.length;
	const avgChars = charCount / sample.length;
	return shortRatio >= 0.68 && avgChars <= 18;
}

function truncateCandidateSnippet({ text }: { text: string }): string {
	if (text.length <= 1200) return text;
	const prefix = text.slice(0, 1200).trim();
	const lastWhitespace = prefix.lastIndexOf(" ");
	return lastWhitespace > 0 ? prefix.slice(0, lastWhitespace).trim() : prefix;
}

function buildSegmentsFromWordTimings({
	wordTimings,
	joinGapSeconds,
}: {
	wordTimings: Array<{ startTime: number; endTime: number }>;
	joinGapSeconds: number;
}): TranscriptionSegment[] {
	const sorted = wordTimings
		.filter(
			(word) =>
				Number.isFinite(word.startTime) &&
				Number.isFinite(word.endTime) &&
				word.endTime > word.startTime,
		)
		.sort((a, b) => a.startTime - b.startTime);
	if (sorted.length === 0) return [];

	const segments: TranscriptionSegment[] = [];
	let segmentStart = sorted[0].startTime;
	let segmentEnd = sorted[0].endTime;

	for (let index = 1; index < sorted.length; index++) {
		const word = sorted[index];
		if (word.startTime <= segmentEnd + joinGapSeconds) {
			segmentEnd = Math.max(segmentEnd, word.endTime);
			continue;
		}
		segments.push({
			text: "",
			start: segmentStart,
			end: segmentEnd,
		});
		segmentStart = word.startTime;
		segmentEnd = word.endTime;
	}

	segments.push({
		text: "",
		start: segmentStart,
		end: segmentEnd,
	});

	return segments;
}

function getSmartCutMediaSourceId({
	element,
}: {
	element: VideoElement | AudioElement;
}): string | null {
	if (element.type === "video") return element.mediaId;
	if (element.sourceType === "upload") return element.mediaId;
	return null;
}

function getSmartCutSegmentsForElement({
	element,
	tracks,
	mediaElements,
	fallbackSegments,
}: {
	element: VideoElement | AudioElement;
	tracks: TimelineTrack[];
	mediaElements: Array<VideoElement | AudioElement>;
	fallbackSegments: TranscriptionSegment[] | null;
}): TranscriptionSegment[] {
	const clipStart = element.startTime;
	const clipEnd = element.startTime + element.duration;

	const sourceMediaId = getSmartCutMediaSourceId({ element });
	const transcriptWordTimings = (getTranscriptDraft(element)?.words ?? [])
		.filter((word) => !word.removed)
		.map((word) => ({
			startTime: element.startTime + (word.startTime - element.trimStart),
			endTime: element.startTime + (word.endTime - element.trimStart),
		}));
	const siblingTranscriptWordTimings =
		sourceMediaId === null
			? []
			: mediaElements
					.filter((candidate) => {
						if (candidate.id === element.id) return false;
						return (
							getSmartCutMediaSourceId({ element: candidate }) === sourceMediaId
						);
					})
					.flatMap((candidate) =>
						(getTranscriptDraft(candidate)?.words ?? []).map((word) => ({
							word,
							candidate,
						})),
					)
					.filter(({ word }) => !word.removed)
					.map(({ word, candidate }) => ({
						startTime:
							candidate.startTime + (word.startTime - candidate.trimStart),
						endTime: candidate.startTime + (word.endTime - candidate.trimStart),
					}));
	const fromTranscriptEdit = [
		...transcriptWordTimings,
		...siblingTranscriptWordTimings,
	].map((word) => ({ startTime: word.startTime, endTime: word.endTime }));
	const transcriptSegments = buildSegmentsFromWordTimings({
		wordTimings: fromTranscriptEdit,
		joinGapSeconds: SMART_CUT_WORD_JOIN_GAP_SECONDS,
	}).filter((segment) => segment.end > clipStart && segment.start < clipEnd);
	if (transcriptSegments.length > 0) {
		return transcriptSegments;
	}

	const captionWordTimings = tracks
		.filter((track) => track.type === "text")
		.flatMap((track) => track.elements)
		.filter(
			(caption) =>
				(caption.captionWordTimings?.length ?? 0) > 0 &&
				caption.captionSourceRef?.mediaElementId === element.id,
		)
		.flatMap((caption) => caption.captionWordTimings ?? [])
		.map((word) => ({
			startTime: word.startTime,
			endTime: word.endTime,
		}));
	const captionSegments = buildSegmentsFromWordTimings({
		wordTimings: captionWordTimings,
		joinGapSeconds: SMART_CUT_WORD_JOIN_GAP_SECONDS,
	}).filter((segment) => segment.end > clipStart && segment.start < clipEnd);
	if (captionSegments.length > 0) {
		return captionSegments;
	}

	return (fallbackSegments ?? []).filter(
		(segment) => segment.end > clipStart && segment.start < clipEnd,
	);
}

function buildCoarseFallbackClipCandidatesFromSegments({
	segments,
	mediaDuration,
	minClipSeconds,
	targetClipSeconds,
	maxClipSeconds,
	maxOutput = 12,
}: {
	segments: TranscriptionSegment[];
	mediaDuration: number;
	minClipSeconds: number;
	targetClipSeconds: number;
	maxClipSeconds: number;
	maxOutput?: number;
}): Array<{
	id: string;
	startTime: number;
	endTime: number;
	duration: number;
	transcriptSnippet: string;
	localScore: number;
}> {
	if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return [];
	const normalized = [...segments]
		.filter(
			(segment) =>
				Number.isFinite(segment.start) &&
				Number.isFinite(segment.end) &&
				segment.end > segment.start &&
				segment.text.trim().length > 0,
		)
		.sort((a, b) => a.start - b.start);
	if (normalized.length === 0) return [];

	const candidates: Array<{
		id: string;
		startTime: number;
		endTime: number;
		duration: number;
		transcriptSnippet: string;
		localScore: number;
	}> = [];

	for (let i = 0; i < normalized.length; i++) {
		const start = Math.max(0, normalized[i]?.start ?? 0);
		if (start >= mediaDuration - minClipSeconds) break;

		let bestEndIndex = -1;
		let bestTargetDiff = Number.POSITIVE_INFINITY;
		for (let j = i; j < normalized.length; j++) {
			const end = Math.min(mediaDuration, normalized[j]?.end ?? start);
			const duration = Math.max(0, end - start);
			if (duration < minClipSeconds) continue;
			if (duration > maxClipSeconds) break;
			const targetDiff = Math.abs(duration - targetClipSeconds);
			if (targetDiff < bestTargetDiff) {
				bestTargetDiff = targetDiff;
				bestEndIndex = j;
			}
		}
		if (bestEndIndex < 0) continue;

		const end = Math.min(mediaDuration, normalized[bestEndIndex]?.end ?? start);
		const duration = Math.max(0, end - start);
		if (duration < minClipSeconds || duration > maxClipSeconds) continue;

		const rawSnippet = normalized
			.slice(i, bestEndIndex + 1)
			.map((segment) => segment.text.trim())
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		const snippet = truncateCandidateSnippet({ text: rawSnippet });
		const wordCount = snippet.match(/\S+/g)?.length ?? 0;
		if (wordCount < 8) continue;

		const duplicate = candidates.some(
			(existing) =>
				overlapRatio({
					aStart: start,
					aEnd: end,
					bStart: existing.startTime,
					bEnd: existing.endTime,
				}) > 0.92,
		);
		if (duplicate) continue;

		candidates.push({
			id: generateUUID(),
			startTime: roundToHundredth(start),
			endTime: roundToHundredth(end),
			duration: roundToHundredth(duration),
			transcriptSnippet: snippet,
			localScore: Math.max(18, Math.round(42 - Math.min(18, bestTargetDiff))),
		});
		if (candidates.length >= maxOutput) break;
	}

	return candidates;
}

function resolveClipScoringApiCandidates(): string[] {
	const fallbackBase = process.env.NEXT_PUBLIC_SITE_URL?.trim();
	const candidates: string[] = [];

	if (typeof window !== "undefined") {
		candidates.push("/api/clips/score");
		const origin = window.location.origin;
		if (origin.startsWith("http://") || origin.startsWith("https://")) {
			candidates.push(`${origin}/api/clips/score`);
		}
		if (fallbackBase) {
			candidates.push(`${fallbackBase.replace(/\/$/, "")}/api/clips/score`);
		}
	} else {
		candidates.push("/api/clips/score");
		if (fallbackBase) {
			candidates.push(`${fallbackBase.replace(/\/$/, "")}/api/clips/score`);
		}
	}

	return Array.from(new Set(candidates));
}

function resolveClipTranscriptionApiCandidates(): string[] {
	const fallbackBase = process.env.NEXT_PUBLIC_SITE_URL?.trim();
	const candidates: string[] = [];

	if (typeof window !== "undefined") {
		const origin = window.location.origin;
		if (origin.startsWith("http://") || origin.startsWith("https://")) {
			candidates.push(`${origin}/api/clips/transcribe`);
			candidates.push("/api/clips/transcribe");
		} else {
			candidates.push("/api/clips/transcribe");
			if (fallbackBase) {
				candidates.push(
					`${fallbackBase.replace(/\/$/, "")}/api/clips/transcribe`,
				);
			}
		}
	} else {
		candidates.push("/api/clips/transcribe");
		if (fallbackBase) {
			candidates.push(
				`${fallbackBase.replace(/\/$/, "")}/api/clips/transcribe`,
			);
		}
	}

	return Array.from(new Set(candidates));
}

type ClipScoringResponse = {
	candidates?: Array<{
		id: string;
		startTime: number;
		endTime: number;
		duration: number;
		title: string;
		rationale: string;
		transcriptSnippet: string;
		scoreOverall: number;
		scoreBreakdown: {
			hook: number;
			emotion: number;
			shareability: number;
			clarity: number;
			momentum: number;
		};
	}>;
};

async function fetchScoredCandidates({
	transcript,
	candidates,
}: {
	transcript: string;
	candidates: Array<{
		id: string;
		startTime: number;
		endTime: number;
		duration: number;
		transcriptSnippet: string;
		localScore: number;
	}>;
}): Promise<ClipScoringResponse> {
	const endpoints = resolveClipScoringApiCandidates();
	let lastNetworkError: Error | null = null;
	let lastHttpError: Error | null = null;

	for (const endpoint of endpoints) {
		const controller = new AbortController();
		const timeoutId = window.setTimeout(() => {
			controller.abort("Clip scoring request timed out");
		}, CLIP_SCORING_TIMEOUT_MS);

		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					transcript: truncateTranscriptForScoring({ transcript }),
					candidates,
				}),
				signal: controller.signal,
			});
			window.clearTimeout(timeoutId);
			if (!response.ok) {
				const errorText = await response.text();
				const err = new Error(
					`Clip scoring failed via ${endpoint} (${response.status}): ${errorText || "Unknown error"}`,
				);
				lastHttpError = err;
				// Retry alternate endpoint when infra/proxy endpoint is unhealthy.
				if (response.status >= 500 || response.status === 404) {
					continue;
				}
				throw err;
			}
			return ((await response.json()) as ClipScoringResponse) ?? {};
		} catch (error) {
			window.clearTimeout(timeoutId);
			lastNetworkError =
				error instanceof Error
					? error
					: new Error(`Failed to reach clip scoring API via ${endpoint}`);
		}
	}

	throw (
		lastHttpError ??
		lastNetworkError ??
		new Error(`Failed to reach clip scoring API (${endpoints.join(", ")})`)
	);
}

async function getOrCreateClipTranscriptWithReuse({
	project,
	asset,
	modelId,
	onProgress,
}: {
	project: TProject;
	asset: MediaAsset;
	modelId: TranscriptionModelId;
	onProgress?: Parameters<
		typeof getOrCreateClipTranscriptForAsset
	>[0]["onProgress"];
}) {
	const inFlightKey = `${project.metadata.id}:${asset.id}:${modelId}`;
	const existing = clipTranscriptInFlight.get(inFlightKey);
	if (existing) {
		return await existing;
	}
	const task = getOrCreateClipTranscriptForAsset({
		project,
		asset,
		modelId,
		onProgress,
	});
	clipTranscriptInFlight.set(inFlightKey, task);
	try {
		return await task;
	} finally {
		clipTranscriptInFlight.delete(inFlightKey);
	}
}

function isTranscriptEditableMediaElement(
	element: TimelineElement | undefined,
): element is VideoElement | AudioElement {
	return Boolean(element && canElementHaveAudio(element));
}

function getElementFromTracks({
	tracks,
	trackId,
	elementId,
}: {
	tracks: TimelineTrack[];
	trackId: string;
	elementId: string;
}): TimelineElement | null {
	const track = tracks.find((item) => item.id === trackId);
	if (!track) return null;
	return track.elements.find((item) => item.id === elementId) ?? null;
}

function getEditableMediaElementSourceId({
	element,
}: {
	element: VideoElement | AudioElement;
}): string | null {
	if (element.type === "video") return element.mediaId;
	if (element.sourceType === "upload") return element.mediaId;
	return null;
}

function rangesOverlap({
	startA,
	endA,
	startB,
	endB,
	tolerance = 0.05,
}: {
	startA: number;
	endA: number;
	startB: number;
	endB: number;
	tolerance?: number;
}): boolean {
	const aStart = Math.min(startA, endA);
	const aEnd = Math.max(startA, endA);
	const bStart = Math.min(startB, endB);
	const bEnd = Math.max(startB, endB);
	return aEnd > bStart - tolerance && bEnd > aStart - tolerance;
}

function replaceElementInTracks({
	tracks,
	trackId,
	elementId,
	element,
}: {
	tracks: TimelineTrack[];
	trackId: string;
	elementId: string;
	element: TimelineElement;
}): TimelineTrack[] {
	return tracks.map((track) => {
		if (track.id !== trackId) return track;
		return {
			...track,
			elements: track.elements.map((candidate) =>
				candidate.id === elementId ? (element as typeof candidate) : candidate,
			),
		} as TimelineTrack;
	});
}

function hasMatchingSourceWindow({
	element,
	trimStart,
	duration,
}: {
	element: TimelineElement | null;
	trimStart: number;
	duration: number;
}): boolean {
	return Boolean(
		element &&
			Math.abs(element.trimStart - trimStart) <= 1e-6 &&
			Math.abs(element.duration - duration) <= 1e-6,
	);
}

function buildMotionTrackingPresetSignature({
	preset,
}: {
	preset: VideoReframePreset;
}): string {
	return [
		preset.name.trim().toLowerCase(),
		preset.transform.position.x.toFixed(3),
		preset.transform.position.y.toFixed(3),
		preset.transform.scale.toFixed(4),
		(preset.motionTracking?.animateScale ?? false) ? "scale:1" : "scale:0",
		`strength:${normalizeMotionTrackingStrength(
			preset.motionTracking?.trackingStrength,
		).toFixed(2)}`,
	].join("|");
}

function getTrackingSubjectHint({
	preset,
}: {
	preset: VideoReframePreset;
}): "left" | "right" | "center" {
	return preset.name === "Subject Left"
		? "left"
		: preset.name === "Subject Right"
			? "right"
			: "center";
}

function getTranscriptCompanionElementIds({
	tracks,
	target,
}: {
	tracks: TimelineTrack[];
	target: VideoElement | AudioElement;
}): Set<string> {
	const ids = new Set<string>([target.id]);
	const targetSourceId = getEditableMediaElementSourceId({ element: target });
	if (!targetSourceId) return ids;

	for (const track of tracks) {
		if (track.type !== "video" && track.type !== "audio") continue;
		for (const candidate of track.elements) {
			if (!isTranscriptEditableMediaElement(candidate)) continue;
			if (candidate.id === target.id) continue;
			const candidateSourceId = getEditableMediaElementSourceId({
				element: candidate,
			});
			if (!candidateSourceId || candidateSourceId !== targetSourceId) continue;
			const startAligned =
				Math.abs(candidate.startTime - target.startTime) < 0.02;
			const trimAligned =
				Math.abs(candidate.trimStart - target.trimStart) < 0.05;
			const endAligned =
				Math.abs(
					candidate.trimStart +
						candidate.duration -
						(target.trimStart + target.duration),
				) < 0.05;
			if (startAligned && trimAligned && endAligned) {
				ids.add(candidate.id);
				continue;
			}

			const candidateTimelineEnd = candidate.startTime + candidate.duration;
			const targetTimelineEnd = target.startTime + target.duration;
			const candidateSourceEnd = candidate.trimStart + candidate.duration;
			const targetSourceEnd = target.trimStart + target.duration;
			const timelineOverlap = rangesOverlap({
				startA: candidate.startTime,
				endA: candidateTimelineEnd,
				startB: target.startTime,
				endB: targetTimelineEnd,
			});
			const sourceOverlap = rangesOverlap({
				startA: candidate.trimStart,
				endA: candidateSourceEnd,
				startB: target.trimStart,
				endB: targetSourceEnd,
			});
			if (timelineOverlap && sourceOverlap) {
				ids.add(candidate.id);
			}
		}
	}
	return ids;
}

function initializeTranscriptEditFromExistingCaption({
	tracks,
	mediaElementId,
}: {
	tracks: TimelineTrack[];
	mediaElementId: string;
}): NonNullable<VideoElement["transcriptDraft"]> | null {
	let sourceMediaElement: TimelineElement | null = null;
	for (const track of tracks) {
		if (track.type !== "video" && track.type !== "audio") continue;
		for (const element of track.elements) {
			if (element.id !== mediaElementId) continue;
			sourceMediaElement = element;
			break;
		}
		if (sourceMediaElement) break;
	}
	if (!sourceMediaElement || !canElementHaveAudio(sourceMediaElement)) {
		return null;
	}
	const sourceCaption = tracks
		.flatMap((track) => (track.type === "text" ? track.elements : []))
		.find((element) => {
			if (element.type !== "text") return false;
			if ((element.captionWordTimings?.length ?? 0) === 0) return false;
			if (element.captionSourceRef?.mediaElementId) {
				return element.captionSourceRef.mediaElementId === mediaElementId;
			}
			return true;
		});
	if (!sourceCaption || (sourceCaption.captionWordTimings?.length ?? 0) === 0) {
		return null;
	}
	const words = buildTranscriptWordsFromCaptionTimings({
		mediaElementId,
		mediaStartTime: sourceMediaElement.startTime,
		timings: sourceCaption.captionWordTimings ?? [],
	});
	const cuts = buildTranscriptCutsFromWords({ words });
	return {
		version: 1 as const,
		source: "word-level" as const,
		words,
		cuts,
		cutTimeDomain: "clip-local-source",
		segmentsUi: buildDefaultTranscriptSegmentsUi({
			elementId: mediaElementId,
			words,
		}),
		updatedAt: new Date().toISOString(),
	};
}

function areTranscriptWordsEqual({
	before,
	after,
}: {
	before: NonNullable<VideoElement["transcriptDraft"]>["words"];
	after: NonNullable<VideoElement["transcriptDraft"]>["words"];
}): boolean {
	if (before.length !== after.length) return false;
	for (let i = 0; i < before.length; i++) {
		const a = before[i];
		const b = after[i];
		if (!a || !b) return false;
		if (a.id !== b.id) return false;
		if (a.text !== b.text) return false;
		if (Math.abs(a.startTime - b.startTime) > 0.0001) return false;
		if (Math.abs(a.endTime - b.endTime) > 0.0001) return false;
		if (Boolean(a.removed) !== Boolean(b.removed)) return false;
		if (Boolean(a.hidden) !== Boolean(b.hidden)) return false;
		if ((a.speakerId ?? undefined) !== (b.speakerId ?? undefined)) return false;
		if ((a.segmentId ?? undefined) !== (b.segmentId ?? undefined)) return false;
	}
	return true;
}

function areTranscriptSpeakerLabelsEqual({
	before,
	after,
}: {
	before?: Record<string, string>;
	after?: Record<string, string>;
}): boolean {
	const beforeEntries = Object.entries(before ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	const afterEntries = Object.entries(after ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	if (beforeEntries.length !== afterEntries.length) return false;
	for (let index = 0; index < beforeEntries.length; index++) {
		const beforeEntry = beforeEntries[index];
		const afterEntry = afterEntries[index];
		if (!beforeEntry || !afterEntry) return false;
		if (beforeEntry[0] !== afterEntry[0]) return false;
		if (beforeEntry[1] !== afterEntry[1]) return false;
	}
	return true;
}

function areTranscriptGapEditsEqual({
	before,
	after,
}: {
	before?: Record<string, { text?: string; removed?: boolean }>;
	after?: Record<string, { text?: string; removed?: boolean }>;
}): boolean {
	const beforeEntries = Object.entries(before ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	const afterEntries = Object.entries(after ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	if (beforeEntries.length !== afterEntries.length) return false;
	for (let index = 0; index < beforeEntries.length; index++) {
		const beforeEntry = beforeEntries[index];
		const afterEntry = afterEntries[index];
		if (!beforeEntry || !afterEntry) return false;
		if (beforeEntry[0] !== afterEntry[0]) return false;
		if ((beforeEntry[1].text ?? "") !== (afterEntry[1].text ?? "")) return false;
		if (Boolean(beforeEntry[1].removed) !== Boolean(afterEntry[1].removed))
			return false;
	}
	return true;
}

function areTranscriptSegmentsEqual({
	before,
	after,
}: {
	before: NonNullable<VideoElement["transcriptDraft"]>["segmentsUi"];
	after: NonNullable<VideoElement["transcriptDraft"]>["segmentsUi"];
}): boolean {
	const beforeSegments = before ?? [];
	const afterSegments = after ?? [];
	if (beforeSegments.length !== afterSegments.length) return false;
	for (let i = 0; i < beforeSegments.length; i++) {
		const a = beforeSegments[i];
		const b = afterSegments[i];
		if (!a || !b) return false;
		if (a.id !== b.id) return false;
		if (a.wordStartIndex !== b.wordStartIndex) return false;
		if (a.wordEndIndex !== b.wordEndIndex) return false;
		if ((a.label ?? "") !== (b.label ?? "")) return false;
	}
	return true;
}

function areTranscriptCutsEqual({
	before,
	after,
}: {
	before: TranscriptEditCutRange[];
	after: TranscriptEditCutRange[];
}): boolean {
	const normalizedBefore = mergeCutRanges({ cuts: before });
	const normalizedAfter = mergeCutRanges({ cuts: after });
	if (normalizedBefore.length !== normalizedAfter.length) return false;
	for (let index = 0; index < normalizedBefore.length; index++) {
		const a = normalizedBefore[index];
		const b = normalizedAfter[index];
		if (!a || !b) return false;
		if (Math.abs(a.start - b.start) > 0.0001) return false;
		if (Math.abs(a.end - b.end) > 0.0001) return false;
		if (a.reason !== b.reason) return false;
	}
	return true;
}

function hasTrackStructureChange({
	beforeTracks,
	afterTracks,
}: {
	beforeTracks: TimelineTrack[];
	afterTracks: TimelineTrack[];
}): boolean {
	if (beforeTracks.length !== afterTracks.length) return true;
	for (let trackIndex = 0; trackIndex < beforeTracks.length; trackIndex++) {
		const beforeTrack = beforeTracks[trackIndex];
		const afterTrack = afterTracks[trackIndex];
		if (!beforeTrack || !afterTrack || beforeTrack.id !== afterTrack.id)
			return true;
		if (beforeTrack.elements.length !== afterTrack.elements.length) return true;
		for (
			let elementIndex = 0;
			elementIndex < beforeTrack.elements.length;
			elementIndex++
		) {
			if (
				beforeTrack.elements[elementIndex]?.id !==
				afterTrack.elements[elementIndex]?.id
			) {
				return true;
			}
		}
	}
	return false;
}

type CompactTranscriptPatch = {
	trackId: string;
	elementId: string;
	beforeDuration: number;
	afterDuration: number;
	beforeTrimEnd: number;
	afterTrimEnd: number;
	beforeUpdatedAt: string;
	afterUpdatedAt: string;
	beforeSegmentsUi?: Array<{
		id: string;
		wordStartIndex: number;
		wordEndIndex: number;
		label?: string;
	}>;
	afterSegmentsUi?: Array<{
		id: string;
		wordStartIndex: number;
		wordEndIndex: number;
		label?: string;
	}>;
	wordDiffs: CompactTranscriptWordDiff[];
	beforeCuts?: TranscriptEditCutRange[];
	afterCuts?: TranscriptEditCutRange[];
};

type CompactTranscriptWordDiff = {
	id: string;
	text?: { before: string; after: string };
	removed?: { before: boolean; after: boolean };
	hidden?: { before: boolean; after: boolean };
	segmentId?: { before?: string; after?: string };
};

function buildCompactTranscriptPatch({
	trackId,
	elementId,
	beforeElement,
	afterElement,
}: {
	trackId: string;
	elementId: string;
	beforeElement: VideoElement | AudioElement;
	afterElement: VideoElement | AudioElement;
}): CompactTranscriptPatch | null {
	const beforeDraft = getTranscriptDraft(beforeElement);
	const afterEdit = getTranscriptDraft(afterElement);
	if (!beforeDraft || !afterEdit) return null;
	if (beforeDraft.words.length !== afterEdit.words.length) return null;
	const segmentsChanged = !areTranscriptSegmentsEqual({
		before: beforeDraft.segmentsUi,
		after: afterEdit.segmentsUi,
	});
	const cutsChanged = !areTranscriptCutsEqual({
		before: beforeDraft.cuts,
		after: afterEdit.cuts,
	});

	const wordDiffs: CompactTranscriptWordDiff[] = [];
	for (let index = 0; index < beforeDraft.words.length; index++) {
		const beforeWord = beforeDraft.words[index];
		const afterWord = afterEdit.words[index];
		if (!beforeWord || !afterWord || beforeWord.id !== afterWord.id) {
			return null;
		}
		if (
			Math.abs(beforeWord.startTime - afterWord.startTime) > 0.0001 ||
			Math.abs(beforeWord.endTime - afterWord.endTime) > 0.0001
		) {
			return null;
		}

		const diff: CompactTranscriptWordDiff = { id: beforeWord.id };
		if (beforeWord.text !== afterWord.text) {
			diff.text = { before: beforeWord.text, after: afterWord.text };
		}
		const beforeRemoved = Boolean(beforeWord.removed);
		const afterRemoved = Boolean(afterWord.removed);
		if (beforeRemoved !== afterRemoved) {
			diff.removed = { before: beforeRemoved, after: afterRemoved };
		}
		const beforeHidden = Boolean(beforeWord.hidden);
		const afterHidden = Boolean(afterWord.hidden);
		if (beforeHidden !== afterHidden) {
			diff.hidden = { before: beforeHidden, after: afterHidden };
		}
		if (
			(beforeWord.segmentId ?? undefined) !== (afterWord.segmentId ?? undefined)
		) {
			diff.segmentId = {
				before: beforeWord.segmentId ?? undefined,
				after: afterWord.segmentId ?? undefined,
			};
		}
		if (diff.text || diff.removed || diff.hidden || diff.segmentId) {
			wordDiffs.push(diff);
		}
	}

	return {
		trackId,
		elementId,
		beforeDuration: beforeElement.duration,
		afterDuration: afterElement.duration,
		beforeTrimEnd: beforeElement.trimEnd,
		afterTrimEnd: afterElement.trimEnd,
		beforeUpdatedAt: beforeDraft.updatedAt,
		afterUpdatedAt: afterEdit.updatedAt,
		beforeSegmentsUi:
			segmentsChanged && beforeDraft.segmentsUi
				? [...beforeDraft.segmentsUi]
				: undefined,
		afterSegmentsUi:
			segmentsChanged && afterEdit.segmentsUi
				? [...afterEdit.segmentsUi]
				: undefined,
		wordDiffs,
		beforeCuts: cutsChanged
			? mergeCutRanges({ cuts: beforeDraft.cuts })
			: undefined,
		afterCuts: cutsChanged
			? mergeCutRanges({ cuts: afterEdit.cuts })
			: undefined,
	};
}

class CompactTranscriptMutationCommand extends Command {
	constructor(
		private patches: CompactTranscriptPatch[],
		private mediaElementIds: string[],
	) {
		super();
	}

	private applyPatches({ direction }: { direction: "before" | "after" }): void {
		const editor = EditorCore.getInstance();
		const patchByTrack = new Map<string, Map<string, CompactTranscriptPatch>>();
		for (const patch of this.patches) {
			const byElement =
				patchByTrack.get(patch.trackId) ??
				new Map<string, CompactTranscriptPatch>();
			byElement.set(patch.elementId, patch);
			patchByTrack.set(patch.trackId, byElement);
		}
		let nextTracks = editor.timeline.getTracks().map((track) => {
			const elementPatches = patchByTrack.get(track.id);
			if (!elementPatches) return track;
			if (track.type !== "video" && track.type !== "audio") return track;
			const nextElements = track.elements.map((element) => {
				const patch = elementPatches.get(element.id);
				if (!patch) return element;
				if (!isTranscriptEditableMediaElement(element)) return element;
				const currentDraft = getTranscriptDraft(element);
				if (!currentDraft) return element;
				const wordsById = new Map(
					currentDraft.words.map((word) => [word.id, { ...word }]),
				);
				for (const wordDiff of patch.wordDiffs) {
					const word = wordsById.get(wordDiff.id);
					if (!word) continue;
					if (wordDiff.text) {
						word.text =
							direction === "before"
								? wordDiff.text.before
								: wordDiff.text.after;
					}
					if (wordDiff.removed) {
						word.removed =
							direction === "before"
								? wordDiff.removed.before
								: wordDiff.removed.after;
					}
					if (wordDiff.hidden) {
						word.hidden =
							direction === "before"
								? wordDiff.hidden.before
								: wordDiff.hidden.after;
					}
					if (wordDiff.segmentId) {
						word.segmentId =
							direction === "before"
								? wordDiff.segmentId.before
								: wordDiff.segmentId.after;
					}
				}
				const words = currentDraft.words.map((word) => {
					const nextWord = wordsById.get(word.id);
					return nextWord ?? word;
				});
				const segmentsUi =
					direction === "before"
						? (patch.beforeSegmentsUi ?? currentDraft.segmentsUi)
						: (patch.afterSegmentsUi ?? currentDraft.segmentsUi);
				const cuts =
					direction === "before"
						? (patch.beforeCuts ?? buildTranscriptCutsFromWords({ words }))
						: (patch.afterCuts ?? buildTranscriptCutsFromWords({ words }));
				const nextDraft = {
					...currentDraft,
					words,
					cuts,
					segmentsUi,
					updatedAt:
						direction === "before"
							? patch.beforeUpdatedAt
							: patch.afterUpdatedAt,
				};
				return withTranscriptState({
					element: {
						...element,
						duration:
							direction === "before"
								? patch.beforeDuration
								: patch.afterDuration,
						trimEnd:
							direction === "before" ? patch.beforeTrimEnd : patch.afterTrimEnd,
					},
					draft: nextDraft,
					applied: compileTranscriptDraft({
						mediaElementId: element.id,
						draft: nextDraft,
						mediaStartTime: element.startTime,
						mediaDuration:
							direction === "before"
								? patch.beforeDuration
								: patch.afterDuration,
					}),
					compileState: { status: "idle", updatedAt: nextDraft.updatedAt },
				});
			});
			return { ...track, elements: nextElements } as TimelineTrack;
		});

		const primaryMediaElementId = this.mediaElementIds[0];
		if (primaryMediaElementId) {
			for (const mediaElementId of this.mediaElementIds) {
				const syncResult = syncCaptionsFromTranscriptEdits({
					tracks: nextTracks,
					mediaElementId,
				});
				if (syncResult.changed) {
					nextTracks = syncResult.tracks;
				}
			}
			const deduped = dedupeTranscriptEditsInTracks({ tracks: nextTracks });
			if (deduped.changed) {
				nextTracks = deduped.tracks;
			}
			const driftCheck = validateAndHealCaptionDriftInTracks({
				tracks: nextTracks,
				projectId: editor.project.getActive().metadata.id,
			});
			if (driftCheck.changed) {
				nextTracks = driftCheck.tracks;
			}
		}
		editor.timeline.updateTracks(nextTracks);
	}

	execute(): void {
		this.applyPatches({ direction: "after" });
	}

	undo(): void {
		this.applyPatches({ direction: "before" });
	}
}

function resolveTranscriptProjectedTiming({
	element,
	nextDraft,
}: {
	element: VideoElement | AudioElement;
	nextDraft: NonNullable<VideoElement["transcriptDraft"]>;
}): {
	duration: number;
	trimEnd: number;
	applied: ReturnType<typeof compileTranscriptDraft>;
} {
	const currentApplied = getTranscriptApplied(element);
	const currentSourceDuration =
		currentApplied?.timeMap.sourceDuration ?? element.duration;
	const baseTrimEnd = Math.max(
		0,
		element.trimEnd - Math.max(0, currentSourceDuration - element.duration),
	);
	const applied = compileTranscriptDraft({
		mediaElementId: element.id,
		draft: nextDraft,
		mediaStartTime: element.startTime,
		mediaDuration: currentSourceDuration,
	});
	const removedDuration = Math.max(
		0,
		applied.timeMap.sourceDuration - applied.timeMap.playableDuration,
	);
	return {
		duration: applied.timeMap.playableDuration,
		trimEnd: baseTrimEnd + removedDuration,
		applied,
	};
}

function scheduleTranscriptDraftCompile({
	editor,
	mediaElementIds,
}: {
	editor: ReturnType<typeof useEditor>;
	mediaElementIds: string[];
}): void {
	if (typeof window === "undefined") return;
	const uniqueIds = [...new Set(mediaElementIds)];
	for (const mediaElementId of uniqueIds) {
		const existingTimer = transcriptCompileTimers.get(mediaElementId);
		if (typeof existingTimer === "number") {
			window.clearTimeout(existingTimer);
		}
		const timer = window.setTimeout(() => {
			transcriptCompileTimers.delete(mediaElementId);
			const currentTracks = editor.timeline.getTracks();
			let nextTracks = currentTracks;
			let changed = false;
			for (const track of currentTracks) {
				if (track.type !== "video" && track.type !== "audio") continue;
				for (const element of track.elements) {
					if (!isTranscriptEditableMediaElement(element)) continue;
					if (element.id !== mediaElementId) continue;
					const draft = getTranscriptDraft(element);
					if (!draft || draft.words.length === 0) continue;
					const projected = resolveTranscriptProjectedTiming({
						element,
						nextDraft: draft,
					});
					nextTracks = nextTracks.map((candidateTrack) => {
						if (candidateTrack.id !== track.id) return candidateTrack;
						if (candidateTrack.type === "video") {
							return {
								...candidateTrack,
								elements: candidateTrack.elements.map((candidateElement) =>
									candidateElement.id === mediaElementId &&
									isTranscriptEditableMediaElement(candidateElement)
										? withTranscriptState({
												element: {
													...candidateElement,
													duration: projected.duration,
													trimEnd: projected.trimEnd,
												},
												draft,
												applied: projected.applied,
												compileState: {
													status: "idle",
													updatedAt: draft.updatedAt,
												},
											})
										: candidateElement,
								),
							} satisfies TimelineTrack;
						}
						if (candidateTrack.type === "audio") {
							return {
								...candidateTrack,
								elements: candidateTrack.elements.map((candidateElement) =>
									candidateElement.id === mediaElementId &&
									isTranscriptEditableMediaElement(candidateElement)
										? withTranscriptState({
												element: {
													...candidateElement,
													duration: projected.duration,
													trimEnd: projected.trimEnd,
												},
												draft,
												applied: projected.applied,
												compileState: {
													status: "idle",
													updatedAt: draft.updatedAt,
												},
											})
										: candidateElement,
								),
							} satisfies TimelineTrack;
						}
						return candidateTrack;
					});
					changed = true;
				}
			}
			if (!changed) {
				editor.playback.setBlockedReason({ reason: null });
				return;
			}
			const syncResult = syncCaptionsFromTranscriptEdits({
				tracks: nextTracks,
				mediaElementId,
			});
			if (syncResult.changed) {
				nextTracks = syncResult.tracks;
			}
			const deduped = dedupeTranscriptEditsInTracks({ tracks: nextTracks });
			if (deduped.changed) {
				nextTracks = deduped.tracks;
			}
			const driftCheck = validateAndHealCaptionDriftInTracks({
				tracks: nextTracks,
				projectId: editor.project.getActive().metadata.id,
			});
			if (driftCheck.changed) {
				nextTracks = driftCheck.tracks;
			}
			try {
				editor.timeline.updateTracks(nextTracks);
				clearTranscriptTimelineSnapshotCache();
				editor.save.markDirty();
			} finally {
				editor.playback.setBlockedReason({ reason: null });
			}
		}, 120);
		transcriptCompileTimers.set(mediaElementId, timer);
	}
}

function applyTranscriptEditMutation({
	editor,
	trackId,
	elementId,
	mutateWords,
	mutateSegmentsUi,
	mutateCuts,
	mutateSpeakerLabels,
	mutateGapEdits,
}: {
	editor: ReturnType<typeof useEditor>;
	trackId: string;
	elementId: string;
	mutateWords?: (
		words: NonNullable<VideoElement["transcriptDraft"]>["words"],
	) => NonNullable<VideoElement["transcriptDraft"]>["words"];
	mutateSegmentsUi?: (
		segments: NonNullable<VideoElement["transcriptDraft"]>["segmentsUi"],
		words: NonNullable<VideoElement["transcriptDraft"]>["words"],
	) => NonNullable<VideoElement["transcriptDraft"]>["segmentsUi"];
	mutateCuts?: (
		cuts: TranscriptEditCutRange[],
		words: NonNullable<VideoElement["transcriptDraft"]>["words"],
	) => TranscriptEditCutRange[];
	mutateSpeakerLabels?: (
		speakerLabels: Record<string, string>,
		words: NonNullable<VideoElement["transcriptDraft"]>["words"],
	) => Record<string, string>;
	mutateGapEdits?: (
		gapEdits: Record<string, { text?: string; removed?: boolean }>,
		words: NonNullable<VideoElement["transcriptDraft"]>["words"],
	) => Record<string, { text?: string; removed?: boolean }> | undefined;
}): { changed: boolean; error?: string } {
	const tracks = editor.timeline.getTracks();
	const target = getElementFromTracks({ tracks, trackId, elementId });
	if (!target || !isTranscriptEditableMediaElement(target)) {
		return { changed: false, error: "Select a video/audio element first" };
	}
	const transcriptDraft =
		getTranscriptDraft(target) ??
		initializeTranscriptEditFromExistingCaption({
			tracks,
			mediaElementId: target.id,
		});
	if (!transcriptDraft) {
		return {
			changed: false,
			error: "No word-level transcript available for selected element",
		};
	}

	// Transcript words are the source of truth for editing state.
	// Do not re-derive removed flags from persisted cuts here, or unmute can re-collapse after reload.
	const baseWords = normalizeTranscriptWords({
		words: transcriptDraft.words,
	});
	let nextWords = baseWords;
	if (mutateWords) {
		nextWords = normalizeTranscriptWords({ words: mutateWords(baseWords) });
	}
	const activeWords = nextWords.filter((word) => !word.removed);
	if (activeWords.length === 0) {
		return { changed: false, error: "Cannot remove all words from transcript" };
	}
	const derivedWordCuts = buildTranscriptCutsFromWords({ words: nextWords });
	const preservedNonWordCuts = (transcriptDraft.cuts ?? []).filter(
		(cut) => cut.reason === "pause",
	);
	let cuts = mergeCutRanges({
		cuts: [...derivedWordCuts, ...preservedNonWordCuts],
	});
	if (mutateCuts) {
		cuts = mergeCutRanges({
			cuts: mutateCuts(cuts, nextWords),
		});
	}
	const initialSegmentsUi =
		transcriptDraft.segmentsUi && transcriptDraft.segmentsUi.length > 0
			? transcriptDraft.segmentsUi
			: buildDefaultTranscriptSegmentsUi({
					elementId: target.id,
					words: nextWords,
				});
	const nextSegmentsUi =
		mutateSegmentsUi?.(initialSegmentsUi, nextWords) ?? initialSegmentsUi;
	const initialSpeakerLabels = transcriptDraft.speakerLabels ?? {};
	const nextSpeakerLabels = mutateSpeakerLabels
		? mutateSpeakerLabels(initialSpeakerLabels, nextWords)
		: initialSpeakerLabels;
	const initialGapEdits = normalizeTranscriptGapEdits({
		gapEdits: transcriptDraft.gapEdits,
	}) ?? {};
	const nextGapEdits = mutateGapEdits
		? normalizeTranscriptGapEdits({
				gapEdits: mutateGapEdits(initialGapEdits, nextWords),
			})
		: initialGapEdits;
	const wordsChanged = !areTranscriptWordsEqual({
		before: baseWords,
		after: nextWords,
	});
	const segmentsChanged = !areTranscriptSegmentsEqual({
		before: initialSegmentsUi,
		after: nextSegmentsUi,
	});
	const cutsChanged = !areTranscriptCutsEqual({
		before: transcriptDraft.cuts ?? [],
		after: cuts,
	});
	const speakerLabelsChanged = !areTranscriptSpeakerLabelsEqual({
		before: initialSpeakerLabels,
		after: nextSpeakerLabels,
	});
	const gapEditsChanged = !areTranscriptGapEditsEqual({
		before: initialGapEdits,
		after: nextGapEdits,
	});
	if (
		!wordsChanged &&
		!segmentsChanged &&
		!cutsChanged &&
		!speakerLabelsChanged &&
		!gapEditsChanged
	) {
		return { changed: false };
	}

	const nextDraft = {
		version: 1 as const,
		source: "word-level" as const,
		words: nextWords,
		cuts,
		cutTimeDomain: "clip-local-source" as const,
		segmentsUi: nextSegmentsUi,
		speakerLabels: nextSpeakerLabels,
		gapEdits: nextGapEdits,
		updatedAt: new Date().toISOString(),
	};
	const relatedElementIds = getTranscriptCompanionElementIds({
		tracks,
		target,
	});

	const updatedTracks = tracks.map((track) => {
		if (track.type === "video") {
			const nextElements = track.elements.map((element) =>
				relatedElementIds.has(element.id) &&
				isTranscriptEditableMediaElement(element)
					? (() => {
							const projected = resolveTranscriptProjectedTiming({
								element,
								nextDraft,
							});
							return withTranscriptState({
								element: {
									...element,
									duration: projected.duration,
									trimEnd: projected.trimEnd,
								},
								draft: nextDraft,
								applied: projected.applied,
								compileState: {
									status: "compiling",
									updatedAt: nextDraft.updatedAt,
								},
							});
						})()
					: element,
			);
			return { ...track, elements: nextElements } as TimelineTrack;
		}
		if (track.type === "audio") {
			const nextElements = track.elements.map((element) =>
				relatedElementIds.has(element.id) &&
				isTranscriptEditableMediaElement(element)
					? (() => {
							const projected = resolveTranscriptProjectedTiming({
								element,
								nextDraft,
							});
							return withTranscriptState({
								element: {
									...element,
									duration: projected.duration,
									trimEnd: projected.trimEnd,
								},
								draft: nextDraft,
								applied: projected.applied,
								compileState: {
									status: "compiling",
									updatedAt: nextDraft.updatedAt,
								},
							});
						})()
					: element,
			);
			return { ...track, elements: nextElements } as TimelineTrack;
		}
		return track;
	});
	let syncedTracks = updatedTracks;
	for (const mediaElementId of relatedElementIds) {
		const syncResult = syncCaptionsFromTranscriptEdits({
			tracks: syncedTracks,
			mediaElementId,
		});
		if (syncResult.changed) {
			syncedTracks = syncResult.tracks;
		}
	}

	if (editor.playback.getIsPlaying() || editor.playback.getIsScrubbing()) {
		editor.playback.pause();
	}
	editor.playback.setBlockedReason({
		reason: "Updating transcript playback",
	});

	editor.command.execute({
		command: new TracksSnapshotCommand(tracks, syncedTracks),
	});
	scheduleTranscriptDraftCompile({
		editor,
		mediaElementIds: Array.from(relatedElementIds),
	});
	clearTranscriptTimelineSnapshotCache();
	editor.save.markDirty();

	return { changed: true };
}

function buildClipElement({
	asset,
	startTime,
	endTime,
	canvasSize,
	scaleOverride,
	reframeSeed,
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
	canvasSize: { width: number; height: number };
	scaleOverride?: number;
	reframeSeed?: Awaited<ReturnType<typeof analyzeGeneratedClipReframes>> | null;
}) {
	const duration = Math.max(0.1, endTime - startTime);
	const sourceDuration = Math.max(endTime, asset.duration ?? endTime);
	const trimEnd = Math.max(0, sourceDuration - endTime);
	const sourceWidth = asset.width ?? 0;
	const sourceHeight = asset.height ?? 0;
	const shouldCoverScale =
		asset.type === "video" &&
		sourceWidth > 0 &&
		sourceHeight > 0 &&
		canvasSize.width > 0 &&
		canvasSize.height > 0;
	const coverScale = shouldCoverScale
		? Math.max(
				canvasSize.width / sourceWidth,
				canvasSize.height / sourceHeight,
			) /
			Math.min(canvasSize.width / sourceWidth, canvasSize.height / sourceHeight)
		: 1;
	const effectiveScale =
		typeof scaleOverride === "number" &&
		Number.isFinite(scaleOverride) &&
		scaleOverride > 0
			? scaleOverride
			: coverScale;

	if (asset.type === "video") {
		return {
			type: "video" as const,
			mediaId: asset.id,
			name: asset.name,
			duration,
			startTime: 0,
			trimStart: startTime,
			trimEnd,
			muted: false,
			hidden: false,
			transform: {
				...DEFAULT_TRANSFORM,
				scale: Number.isFinite(effectiveScale)
					? Math.max(1, effectiveScale)
					: 1,
			},
			reframePresets: reframeSeed?.presets ?? [],
			reframeSwitches: reframeSeed?.switches ?? [],
			defaultReframePresetId: reframeSeed?.defaultPresetId ?? null,
			reframeSeededBy:
				(reframeSeed?.presets.length ?? 0) > 0
					? ("subject-aware-v1" as const)
					: undefined,
			opacity: DEFAULT_OPACITY,
			blendMode: DEFAULT_BLEND_MODE,
		};
	}

	return {
		type: "audio" as const,
		sourceType: "upload" as const,
		mediaId: asset.id,
		name: asset.name,
		duration,
		startTime: 0,
		trimStart: startTime,
		trimEnd,
		volume: 1,
		muted: false,
	};
}

function buildContinuousCaptionForClip({
	segments,
}: {
	segments: Array<{ text: string; start: number; end: number }>;
}): {
	content: string;
	startTime: number;
	duration: number;
	wordTimings: Array<{ word: string; startTime: number; endTime: number }>;
} | null {
	const sourceWordCount = segments.flatMap(
		(segment) => segment.text.match(/\S+/g) ?? [],
	).length;
	const rawWordTimings = segments
		.slice()
		.flatMap((segment) => {
			const words = segment.text.match(/\S+/g) ?? [];
			if (words.length === 0) return [];
			const segmentStart = Math.max(0, segment.start);
			const segmentEnd = Math.max(segmentStart + 0.01, segment.end);

			// Preserve exact timings when transcription already returned one word per span.
			if (words.length === 1) {
				return [
					{
						word: words[0] ?? "",
						startTime: segmentStart,
						endTime: segmentEnd,
					},
				];
			}

			const segmentDuration = Math.max(0.01, segmentEnd - segmentStart);
			const weights = words.map((word) => {
				const normalized = word.replace(/[^\p{L}\p{N}']+/gu, "");
				return Math.max(1, normalized.length || word.length || 1);
			});
			const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

			let consumedWeight = 0;
			return words.map((word, index) => {
				const startWeight = consumedWeight;
				consumedWeight += weights[index];
				const endWeight = consumedWeight;
				const startTime =
					segmentStart + (segmentDuration * startWeight) / totalWeight;
				const endTime = Math.max(
					startTime + 0.01,
					segmentStart + (segmentDuration * endWeight) / totalWeight,
				);
				return {
					word: word.trim(),
					startTime,
					endTime,
				};
			});
		})
		.filter(
			(timing) =>
				Number.isFinite(timing.startTime) &&
				Number.isFinite(timing.endTime) &&
				timing.word.trim().length > 0,
		);

	if (rawWordTimings.length === 0) return null;

	const normalizedWordTimings: Array<{
		word: string;
		startTime: number;
		endTime: number;
	}> = [];
	for (let i = 0; i < rawWordTimings.length; i++) {
		const nextStart = Math.max(0, rawWordTimings[i].startTime);
		const nextEnd = Math.max(nextStart + 0.01, rawWordTimings[i].endTime);
		const normalized = {
			word: rawWordTimings[i].word.trim(),
			startTime: nextStart,
			endTime: nextEnd,
		};
		if (!normalized.word) continue;
		normalizedWordTimings.push(normalized);
	}

	if (normalizedWordTimings.length === 0) return null;
	if (sourceWordCount > 0 && normalizedWordTimings.length !== sourceWordCount) {
		console.warn("Clip caption word-count mismatch detected", {
			sourceWordCount,
			normalizedWordCount: normalizedWordTimings.length,
		});
	}

	const content = normalizedWordTimings
		.map((timing) => timing.word)
		.join(" ")
		.trim();
	if (!content) return null;

	const startTime = normalizedWordTimings[0].startTime;
	const endTime =
		normalizedWordTimings[normalizedWordTimings.length - 1].endTime;
	return {
		content,
		startTime,
		duration: Math.max(0.04, endTime - startTime),
		wordTimings: normalizedWordTimings,
	};
}

function normalizeTranscriptToken({ token }: { token: string }): string {
	return token.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
}

function extractNormalizedWordSequenceFromSegments({
	segments,
}: {
	segments: Array<{ text: string }>;
}): string[] {
	return segments
		.flatMap((segment) => segment.text.match(/\S+/g) ?? [])
		.map((word) => normalizeTranscriptToken({ token: word }))
		.filter((word) => word.length > 0);
}

function extractNormalizedWordSequenceFromCaption({
	caption,
}: {
	caption: NonNullable<ReturnType<typeof buildContinuousCaptionForClip>>;
}): string[] {
	return caption.wordTimings
		.map((timing) => normalizeTranscriptToken({ token: timing.word }))
		.filter((word) => word.length > 0);
}

function hasExactWordSequenceMatch({
	segments,
	caption,
}: {
	segments: Array<{ text: string }>;
	caption: NonNullable<ReturnType<typeof buildContinuousCaptionForClip>>;
}): boolean {
	const source = extractNormalizedWordSequenceFromSegments({ segments });
	const generated = extractNormalizedWordSequenceFromCaption({ caption });
	if (source.length !== generated.length) return false;
	for (let index = 0; index < source.length; index++) {
		if (source[index] !== generated[index]) return false;
	}
	return true;
}

async function decodeAssetWindowToMono({
	asset,
	startTime,
	endTime,
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
}): Promise<{ samples: Float32Array; sampleRate: number } | null> {
	const clipBuffer = await decodeAssetWindowToAudioBuffer({
		asset,
		startTime,
		endTime,
	});
	if (!clipBuffer) return null;
	const samples = extractMonoSamplesFromAudioBuffer({
		audioBuffer: clipBuffer,
	});
	return {
		samples,
		sampleRate: clipBuffer.sampleRate,
	};
}

async function transcribeClipWindowWordLevel({
	asset,
	startTime,
	endTime,
	cacheKey,
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
	cacheKey: string;
}): Promise<TranscriptionSegment[] | null> {
	try {
		const decoded = await decodeAssetWindowToMono({
			asset,
			startTime,
			endTime,
		});
		if (!decoded || decoded.samples.length === 0) {
			return null;
		}
		return await transcribeDecodedClipAudioWordLevel({
			samples: decoded.samples,
			sampleRate: decoded.sampleRate,
			cacheKey,
		});
	} catch (error) {
		console.warn(
			"Failed clip-window word-level transcription for captions:",
			error,
		);
		return null;
	}
}

function encodeMonoPcm16WavBlob({
	samples,
	sampleRate,
}: {
	samples: Float32Array;
	sampleRate: number;
}): Blob {
	const numChannels = 1;
	const bitsPerSample = 16;
	const bytesPerSample = bitsPerSample / 8;
	const dataSize = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	const writeString = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++) {
			view.setUint8(offset + i, value.charCodeAt(i));
		}
	};

	writeString(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeString(8, "WAVE");
	writeString(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
	view.setUint16(32, numChannels * bytesPerSample, true);
	view.setUint16(34, bitsPerSample, true);
	writeString(36, "data");
	view.setUint32(40, dataSize, true);

	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const value = Math.max(-1, Math.min(1, samples[i]));
		const int16 = value < 0 ? value * 0x8000 : value * 0x7fff;
		view.setInt16(offset, int16, true);
		offset += 2;
	}

	return new Blob([buffer], { type: "audio/wav" });
}

async function transcribeClipAudioWithApi({
	wavBlob,
	cacheKey,
}: {
	wavBlob: Blob;
	cacheKey: string;
}): Promise<TranscriptionSegment[] | null> {
	const requestStartedAt = Date.now();
	const endpoints = resolveClipTranscriptionApiCandidates();
	let lastNetworkError: Error | null = null;

	for (const endpoint of endpoints) {
		const controller = new AbortController();
		const timeoutId = window.setTimeout(() => {
			controller.abort("Clip transcription request timed out");
		}, CLIP_TRANSCRIPTION_TIMEOUT_MS);

		try {
			const form = new FormData();
			form.append("file", wavBlob, "clip.wav");
			form.append("model", CLIP_IMPORT_TRANSCRIPTION_MODEL);
			form.append("cacheKey", cacheKey);
			form.append("diarize", "true");

			const response = await fetch(endpoint, {
				method: "POST",
				body: form,
				signal: controller.signal,
			});
			window.clearTimeout(timeoutId);
			if (!response.ok) {
				const body = await response.text();
				throw new Error(
					`Clip transcription failed (${response.status}): ${body}`,
				);
			}
			const json = (await response.json()) as {
				segments?: Array<{
					text: string;
					start: number;
					end: number;
					speakerId?: string;
				}>;
				granularity?: "word" | "segment" | "none";
				engine?: string;
				model?: string;
				timingsMs?: Record<string, number>;
				audioDurationSeconds?: number;
				wordCount?: number;
			};
			if (json.granularity && json.granularity !== "word") {
				throw new Error(
					`Clip transcription returned ${json.granularity}-level timing; word-level timing is required`,
				);
			}
			const segments = (json.segments ?? [])
				.filter(
					(segment) =>
						Number.isFinite(segment.start) &&
						Number.isFinite(segment.end) &&
						segment.text.trim().length > 0,
				)
				.map((segment) => ({
					text: segment.text.trim(),
					start: Math.max(0, segment.start),
					end: Math.max(segment.start + 0.01, segment.end),
					speakerId:
						typeof segment.speakerId === "string" &&
						segment.speakerId.trim().length > 0
							? segment.speakerId.trim()
							: undefined,
				}));
			if (segments.length > 0) {
				const durationMs = Date.now() - requestStartedAt;
				const durationSeconds =
					json.audioDurationSeconds ??
					Math.max(0, segments[segments.length - 1]!.end - segments[0]!.start);
				console.info("Clip transcription metrics", {
					cacheKey,
					engine: json.engine ?? "unknown",
					model: json.model ?? "unknown",
					wordCount: json.wordCount ?? segments.length,
					durationSeconds,
					durationMs,
					realtimeFactor:
						durationSeconds > 0
							? Number((durationMs / 1000 / durationSeconds).toFixed(3))
							: null,
					speakerCount: new Set(
						segments
							.map((segment) => segment.speakerId)
							.filter((speakerId): speakerId is string => Boolean(speakerId)),
					).size,
					timingsMs: json.timingsMs ?? null,
				});
			}
			return segments.length > 0 ? segments : null;
		} catch (error) {
			window.clearTimeout(timeoutId);
			lastNetworkError =
				error instanceof Error
					? error
					: new Error("Failed to reach transcription API");
		}
	}

	throw lastNetworkError ?? new Error("Failed to reach transcription API");
}

async function transcribeDecodedClipAudioWordLevel({
	samples,
	sampleRate,
	cacheKey,
}: {
	samples: Float32Array;
	sampleRate: number;
	cacheKey: string;
}): Promise<TranscriptionSegment[] | null> {
	const existing = clipTranscriptionInFlight.get(cacheKey);
	if (existing) return await existing;

	const task = (async () => {
		const durationSeconds = samples.length / Math.max(1, sampleRate);
		if (
			!Number.isFinite(durationSeconds) ||
			durationSeconds < CLIP_TRANSCRIPTION_MIN_DURATION_SECONDS ||
			durationSeconds > CLIP_TRANSCRIPTION_MAX_DURATION_SECONDS
		) {
			return null;
		}
		const wavBlob = encodeMonoPcm16WavBlob({
			samples,
			sampleRate,
		});
		if (wavBlob.size <= 0 || wavBlob.size > CLIP_TRANSCRIPTION_MAX_FILE_BYTES) {
			return null;
		}
		return await transcribeClipAudioWithApi({
			wavBlob,
			cacheKey,
		});
	})();
	clipTranscriptionInFlight.set(cacheKey, task);
	try {
		return await task;
	} finally {
		clipTranscriptionInFlight.delete(cacheKey);
	}
}

function extractMonoSamplesFromAudioBuffer({
	audioBuffer,
}: {
	audioBuffer: AudioBuffer;
}): Float32Array {
	const channelCount = Math.max(1, audioBuffer.numberOfChannels);
	const sampleLength = audioBuffer.length;
	if (sampleLength <= 0) return new Float32Array(0);

	if (channelCount === 1) {
		return audioBuffer.getChannelData(0).slice();
	}

	const mono = new Float32Array(sampleLength);
	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		const channelData = audioBuffer.getChannelData(channelIndex);
		for (let sampleIndex = 0; sampleIndex < sampleLength; sampleIndex++) {
			mono[sampleIndex] += channelData[sampleIndex] ?? 0;
		}
	}
	const scale = 1 / channelCount;
	for (let sampleIndex = 0; sampleIndex < sampleLength; sampleIndex++) {
		mono[sampleIndex] *= scale;
	}
	return mono;
}

async function sliceClipBufferFromFullDecode({
	asset,
	startTime,
	endTime,
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
}): Promise<AudioBuffer | null> {
	try {
		const context = createAudioContext();
		const arrayBuffer = await asset.file.arrayBuffer();
		const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
		const safeStart = Math.max(0, startTime);
		const safeEnd = Math.max(safeStart, endTime);
		const startSample = Math.floor(safeStart * decoded.sampleRate);
		const endSample = Math.min(
			decoded.length,
			Math.ceil(safeEnd * decoded.sampleRate),
		);
		if (endSample <= startSample) {
			void context.close().catch(() => undefined);
			return null;
		}
		const length = endSample - startSample;
		const channels = Math.max(1, decoded.numberOfChannels);
		const clipped = context.createBuffer(channels, length, decoded.sampleRate);
		for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
			const source = decoded
				.getChannelData(channelIndex)
				.subarray(startSample, endSample);
			clipped.copyToChannel(source, channelIndex);
		}
		void context.close().catch(() => undefined);
		return clipped;
	} catch (error) {
		console.warn("Failed full decode clip buffer fallback:", error);
		return null;
	}
}

async function decodeAssetWindowToAudioBuffer({
	asset,
	startTime,
	endTime,
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
}): Promise<AudioBuffer | null> {
	const input = new Input({
		source: new BlobSource(asset.file),
		formats: ALL_FORMATS,
	});

	try {
		const windowStart = Math.max(0, startTime);
		const windowEnd = Math.max(windowStart, endTime);
		if (windowEnd - windowStart <= 0) {
			return null;
		}

		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) {
			return await sliceClipBufferFromFullDecode({
				asset,
				startTime: windowStart,
				endTime: windowEnd,
			});
		}
		const sink = new AudioBufferSink(audioTrack);
		const chunks: AudioBuffer[] = [];
		for await (const { buffer } of sink.buffers(windowStart, windowEnd)) {
			chunks.push(buffer);
		}
		if (chunks.length === 0) {
			return await sliceClipBufferFromFullDecode({
				asset,
				startTime: windowStart,
				endTime: windowEnd,
			});
		}

		const sampleRate = chunks[0].sampleRate;
		const channels = Math.max(1, chunks[0].numberOfChannels);
		let totalSamples = 0;
		for (const chunk of chunks) {
			totalSamples += chunk.length;
		}
		if (totalSamples <= 0) {
			return await sliceClipBufferFromFullDecode({
				asset,
				startTime: windowStart,
				endTime: windowEnd,
			});
		}

		const mergedByChannel = Array.from(
			{ length: channels },
			() => new Float32Array(totalSamples),
		);

		let writeOffset = 0;
		for (const chunk of chunks) {
			const chunkLength = chunk.length;
			if (chunkLength <= 0) continue;
			for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
				const sourceChannel = Math.min(
					channelIndex,
					chunk.numberOfChannels - 1,
				);
				const sourceData = chunk.getChannelData(sourceChannel);
				mergedByChannel[channelIndex].set(sourceData, writeOffset);
			}
			writeOffset += chunkLength;
		}

		const context = createAudioContext({ sampleRate });
		const merged = context.createBuffer(
			channels,
			mergedByChannel[0]?.length ?? totalSamples,
			sampleRate,
		);
		for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
			merged.copyToChannel(mergedByChannel[channelIndex], channelIndex);
		}
		void context.close().catch(() => undefined);
		return merged;
	} finally {
		input.dispose();
	}
}

function mergeTimeRanges(
	ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
	const sorted = [...ranges]
		.filter((range) => range.end - range.start > 0)
		.sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (!previous || range.start > previous.end) {
			merged.push({ ...range });
			continue;
		}
		previous.end = Math.max(previous.end, range.end);
	}
	return merged;
}

function remapTimeWithRemovedRanges({
	time,
	removedRanges,
}: {
	time: number;
	removedRanges: Array<{ start: number; end: number }>;
}): number | null {
	let shift = 0;
	for (const range of removedRanges) {
		if (time < range.start) break;
		if (time <= range.end) return null;
		shift += range.end - range.start;
	}
	return time - shift;
}

function isGeneratedCaption(element: TextElement): boolean {
	return (
		element.name.startsWith("Caption ") &&
		(element.captionWordTimings?.length ?? 0) > 0
	);
}

function retimeGeneratedCaptions({
	tracks,
	removedRanges,
}: {
	tracks: TimelineTrack[];
	removedRanges: Array<{ start: number; end: number }>;
}): TimelineTrack[] {
	if (removedRanges.length === 0) return tracks;

	return tracks.map((track) => {
		if (track.type !== "text") return track;

		const nextElements = track.elements
			.map((element) => {
				if (element.type !== "text" || !isGeneratedCaption(element)) {
					return element;
				}

				const nextWordTimings = (element.captionWordTimings ?? [])
					.map((timing) => {
						const nextStart = remapTimeWithRemovedRanges({
							time: timing.startTime,
							removedRanges,
						});
						const nextEnd = remapTimeWithRemovedRanges({
							time: timing.endTime,
							removedRanges,
						});
						if (nextStart == null || nextEnd == null || nextEnd <= nextStart) {
							return null;
						}
						return {
							word: timing.word,
							startTime: nextStart,
							endTime: nextEnd,
						};
					})
					.filter((word): word is NonNullable<typeof word> => word !== null);

				if (nextWordTimings.length === 0) return null;
				const startTime = nextWordTimings[0].startTime;
				const endTime = nextWordTimings[nextWordTimings.length - 1].endTime;
				return {
					...element,
					content: nextWordTimings.map((word) => word.word).join(" "),
					startTime,
					duration: Math.max(0.04, endTime - startTime),
					captionWordTimings: nextWordTimings,
				};
			})
			.filter(
				(element): element is (typeof track.elements)[number] =>
					element !== null,
			)
			.sort((a, b) => a.startTime - b.startTime);

		return {
			...track,
			elements: nextElements,
		};
	});
}

function computeRemovedTimelineRangesFromTranscriptCuts({
	processable,
	resultsByElementKey,
}: {
	processable: Array<{
		track: TimelineTrack;
		element: {
			id: string;
			startTime: number;
			duration: number;
			trimStart: number;
		};
	}>;
	resultsByElementKey: Map<
		string,
		{ segments: Array<{ start: number; end: number }> }
	>;
}): Array<{ start: number; end: number }> {
	const removed: Array<{ start: number; end: number }> = [];

	for (const { track, element } of processable) {
		const result = resultsByElementKey.get(`${track.id}:${element.id}`);
		if (!result) continue;

		const visibleStart = element.trimStart;
		const visibleEnd = element.trimStart + element.duration;
		const keeps = [...result.segments].sort((a, b) => a.start - b.start);
		let cursor = visibleStart;
		for (const keep of keeps) {
			if (keep.start > cursor) {
				removed.push({
					start: element.startTime + (cursor - visibleStart),
					end: element.startTime + (keep.start - visibleStart),
				});
			}
			cursor = Math.max(cursor, keep.end);
		}
		if (cursor < visibleEnd) {
			removed.push({
				start: element.startTime + (cursor - visibleStart),
				end: element.startTime + (visibleEnd - visibleStart),
			});
		}
	}

	return mergeTimeRanges(removed);
}

export function useEditorActions() {
	const editor = useEditor({ subscribeTo: EDITOR_SUBSCRIBE_PROJECT });
	const activeProject = editor.project.getActive();
	const transcriptionStatus = useTranscriptionStatusStore();
	const { registerProcess, updateProcessLabel, removeProcess } =
		useProjectProcessStore();
	const { selectedElements, selectedGap, setElementSelection } =
		useElementSelection();
	const {
		clipboard,
		setClipboard,
		toggleSnapping,
		rippleEditingEnabled,
		requestFitView,
	} = useTimelineStore();
	const { setStatus, setProgress, setError, setCandidates, reset } =
		useClipGenerationStore();

	async function resolveVideoCoverScale({
		asset,
		canvasSize,
	}: {
		asset: MediaAsset;
		canvasSize: { width: number; height: number };
	}): Promise<number> {
		let width = asset.width ?? 0;
		let height = asset.height ?? 0;

		if ((width <= 0 || height <= 0) && asset.type === "video") {
			try {
				const videoInfo = await getVideoInfo({ videoFile: asset.file });
				if (Number.isFinite(videoInfo.width) && videoInfo.width > 0) {
					width = videoInfo.width;
				}
				if (Number.isFinite(videoInfo.height) && videoInfo.height > 0) {
					height = videoInfo.height;
				}
			} catch (error) {
				console.warn(
					"Failed to resolve source video dimensions for cover-fit:",
					error,
				);
			}
		}

		if (width <= 0 || height <= 0) {
			// Conservative portrait fallback that still ensures visible cover for typical 16:9 sources.
			return canvasSize.height > canvasSize.width ? 3.2 : 1;
		}

		const widthRatio = canvasSize.width / width;
		const heightRatio = canvasSize.height / height;
		if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio)) {
			return 1;
		}
		const containScale = Math.min(widthRatio, heightRatio);
		const coverScale = Math.max(widthRatio, heightRatio);
		if (containScale <= 0) return 1;
		return Math.max(1, coverScale / containScale);
	}

	const resolveTransitionTargets = ({
		trackId,
		elementId,
	}: {
		trackId?: string;
		elementId?: string;
	}): Array<{ trackId: string; elementId: string }> => {
		if (trackId && elementId) {
			return [{ trackId, elementId }];
		}
		return selectedElements;
	};

	const applyTransition = ({
		side,
		presetId,
		durationSeconds,
		trackId,
		elementId,
	}: {
		side: TransitionSide;
		presetId?: string;
		durationSeconds?: number;
		trackId?: string;
		elementId?: string;
	}) => {
		if (!presetId) {
			toast.error("Transition preset is required");
			return;
		}
		if (!getTransitionPreset({ presetId })) {
			toast.error("Transition preset not found");
			return;
		}

		const targets = resolveTransitionTargets({ trackId, elementId });
		if (targets.length === 0) {
			toast.error("Select one or more visual clips first");
			return;
		}

		const elementsWithTracks = editor.timeline.getElementsWithTracks({
			elements: targets,
		});
		const visualTargets = elementsWithTracks
			.map(({ track, element }) => ({
				track,
				element: asVisualTargetElement({ element }),
			}))
			.filter(
				(item): item is { track: TimelineTrack; element: VisualElement } =>
					item.element !== null,
			);

		if (visualTargets.length === 0) {
			toast.error("Transitions are supported on visual clips only");
			return;
		}

		const command = buildApplyTransitionCommand({
			targets: visualTargets.map(({ track, element }) => ({
				trackId: track.id,
				element,
			})),
			side,
			presetId,
			durationSeconds,
			generateId: generateUUID,
			appliedAt: new Date().toISOString(),
		});
		if (command) {
			editor.command.execute({ command });
		}
	};

	const removeTransition = ({
		side,
		trackId,
		elementId,
	}: {
		side: TransitionSide;
		trackId?: string;
		elementId?: string;
	}) => {
		const targets = resolveTransitionTargets({ trackId, elementId });
		if (targets.length === 0) return;

		const elementsWithTracks = editor.timeline.getElementsWithTracks({
			elements: targets,
		});
		const visualTargets = elementsWithTracks
			.map(({ track, element }) => ({
				track,
				element: asVisualTargetElement({ element }),
			}))
			.filter(
				(item): item is { track: TimelineTrack; element: VisualElement } =>
					item.element !== null,
			);
		if (visualTargets.length === 0) return;

		const command = buildRemoveTransitionCommand({
			targets: visualTargets.map(({ track, element }) => ({
				trackId: track.id,
				element,
			})),
			side,
		});
		if (command) {
			editor.command.execute({ command });
		}
	};

	useActionHandler(
		"toggle-play",
		() => {
			if (editor.playback.getIsPlaying()) {
				cancelPreparedPlaybackStart({ editor });
				editor.playback.pause();
				return;
			}
			if (editor.playback.getBlockedReason() === PREPARING_PLAYBACK_REASON) {
				cancelPreparedPlaybackStart({ editor });
				return;
			}
			void startPlaybackWhenReady({ editor });
		},
		undefined,
	);

	useActionHandler(
		"toggle-loop-playback",
		() => {
			editor.playback.toggleLoopEnabled();
		},
		undefined,
	);

	useActionHandler(
		"stop-playback",
		() => {
			if (editor.playback.getIsPlaying()) {
				cancelPreparedPlaybackStart({ editor });
				editor.playback.pause();
			} else if (
				editor.playback.getBlockedReason() === PREPARING_PLAYBACK_REASON
			) {
				cancelPreparedPlaybackStart({ editor });
			}
			const { start } = editor.playback.getPlaybackBounds();
			editor.playback.seek({ time: start });
		},
		undefined,
	);

	useActionHandler(
		"seek-forward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			const { end } = editor.playback.getPlaybackBounds();
			editor.playback.seek({
				time: Math.min(end, editor.playback.getCurrentTime() + seconds),
			});
		},
		undefined,
	);

	useActionHandler(
		"seek-backward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			const { start } = editor.playback.getPlaybackBounds();
			editor.playback.seek({
				time: Math.max(start, editor.playback.getCurrentTime() - seconds),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-forward",
		() => {
			const fps = activeProject.settings.fps;
			const { end } = editor.playback.getPlaybackBounds();
			editor.playback.seek({
				time: Math.min(end, editor.playback.getCurrentTime() + 1 / fps),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-backward",
		() => {
			const fps = activeProject.settings.fps;
			const { start } = editor.playback.getPlaybackBounds();
			editor.playback.seek({
				time: Math.max(start, editor.playback.getCurrentTime() - 1 / fps),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-forward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			const { end } = editor.playback.getPlaybackBounds();
			editor.playback.seek({
				time: Math.min(end, editor.playback.getCurrentTime() + seconds),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-backward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			const { start } = editor.playback.getPlaybackBounds();
			editor.playback.seek({
				time: Math.max(start, editor.playback.getCurrentTime() - seconds),
			});
		},
		undefined,
	);

	useActionHandler(
		"goto-start",
		() => {
			const { start } = editor.playback.getPlaybackBounds();
			editor.playback.seek({ time: start });
		},
		undefined,
	);

	useActionHandler(
		"goto-end",
		() => {
			const { end } = editor.playback.getPlaybackBounds();
			editor.playback.seek({ time: end });
		},
		undefined,
	);

	useActionHandler(
		"split",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const elementsToSplit =
				selectedElements.length > 0
					? selectedElements
					: getElementsAtTime({
							tracks: editor.timeline.getTracks(),
							time: currentTime,
						});

			if (elementsToSplit.length === 0) return;

			editor.timeline.splitElements({
				elements: elementsToSplit,
				splitTime: currentTime,
				rippleEnabled: rippleEditingEnabled,
			});
		},
		undefined,
	);

	useActionHandler(
		"split-left",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const elementsToSplit =
				selectedElements.length > 0
					? selectedElements
					: getElementsAtTime({
							tracks: editor.timeline.getTracks(),
							time: currentTime,
						});

			if (elementsToSplit.length === 0) return;

			editor.timeline.splitElements({
				elements: elementsToSplit,
				splitTime: currentTime,
				retainSide: "right",
				rippleEnabled: rippleEditingEnabled,
			});
		},
		undefined,
	);

	useActionHandler(
		"split-right",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const elementsToSplit =
				selectedElements.length > 0
					? selectedElements
					: getElementsAtTime({
							tracks: editor.timeline.getTracks(),
							time: currentTime,
						});

			if (elementsToSplit.length === 0) return;

			editor.timeline.splitElements({
				elements: elementsToSplit,
				splitTime: currentTime,
				retainSide: "left",
				rippleEnabled: rippleEditingEnabled,
			});
		},
		undefined,
	);

	useActionHandler(
		"smart-cut-selected",
		() => {
			void (async () => {
				if (selectedElements.length === 0) {
					toast.error("Select one or more media clips first");
					return;
				}

				const tracks = editor.timeline.getTracks();
				const mediaAssets = editor.media.getAssets();
				const currentProject = editor.project.getActive();
				const mediaById = new Map(
					mediaAssets.map((asset) => [asset.id, asset]),
				);
				const transcriptionCache = findLatestValidTranscriptionCacheEntry({
					project: currentProject,
					tracks,
					mediaAssets,
				});
				const selectedWithElements = editor.timeline.getElementsWithTracks({
					elements: selectedElements,
				});

				const processable = selectedWithElements.filter(
					(
						item,
					): item is {
						track: TimelineTrack;
						element: VideoElement | AudioElement;
					} => {
						const { element } = item;
						if (element.type !== "video" && element.type !== "audio")
							return false;
						if (element.type === "video") return mediaById.has(element.mediaId);
						if (element.sourceType === "upload")
							return mediaById.has(element.mediaId);
						return false;
					},
				);

				if (processable.length === 0) {
					toast.error("No selected clips support Smart Cut");
					return;
				}
				const timelineMediaElements = tracks.flatMap((track) =>
					track.elements.filter(
						(element): element is VideoElement | AudioElement =>
							element.type === "video" ||
							(element.type === "audio" && element.sourceType === "upload"),
					),
				);

				toast.info("Applying transcript-driven Smart Cut...");

				const resultsByElementKey = new Map<
					string,
					ReturnType<typeof computeSmartCutFromTranscriptForElement>
				>();
				let missingTranscriptCount = 0;

				for (const { track, element } of processable) {
					const segments = getSmartCutSegmentsForElement({
						element,
						tracks,
						mediaElements: timelineMediaElements,
						fallbackSegments: transcriptionCache?.segments ?? null,
					});
					if (segments.length === 0) {
						missingTranscriptCount += 1;
						continue;
					}
					const result = computeSmartCutFromTranscriptForElement({
						element,
						segments,
					});
					resultsByElementKey.set(`${track.id}:${element.id}`, result);
				}

				if (resultsByElementKey.size === 0) {
					toast.error(
						"Smart Cut could not find transcript/caption timing for selected clips.",
					);
					return;
				}

				const {
					tracks: updatedTracks,
					changedElements,
					totalRemovedDuration,
				} = applySmartCutsToTracks({
					tracks,
					selectedElements,
					resultsByElementKey,
					ripple: rippleEditingEnabled,
				});

				let nextTracks = updatedTracks;
				if (rippleEditingEnabled) {
					const removedRanges = computeRemovedTimelineRangesFromTranscriptCuts({
						processable: processable.map(({ track, element }) => ({
							track,
							element: {
								id: element.id,
								startTime: element.startTime,
								duration: element.duration,
								trimStart: element.trimStart,
							},
						})),
						resultsByElementKey: resultsByElementKey as Map<
							string,
							{ segments: Array<{ start: number; end: number }> }
						>,
					});
					nextTracks = retimeGeneratedCaptions({
						tracks: updatedTracks,
						removedRanges,
					});
				}

				if (changedElements === 0) {
					toast.info("No significant silence detected");
					return;
				}

				editor.command.execute({
					command: new TracksSnapshotCommand(tracks, nextTracks),
				});
				toast.success(
					`Smart Cut updated ${changedElements} clip${changedElements > 1 ? "s" : ""} (${totalRemovedDuration.toFixed(1)}s removed)`,
				);
				if (missingTranscriptCount > 0) {
					toast.info(
						`Skipped ${missingTranscriptCount} clip${missingTranscriptCount > 1 ? "s" : ""} with no transcript timing data.`,
					);
				}
				if (!rippleEditingEnabled) {
					toast.info(
						"Enable Ripple Editing to keep generated captions automatically retimed with Smart Cut.",
					);
				}
			})();
		},
		undefined,
	);

	useActionHandler(
		"transcript-toggle-word",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			const wordId = typeof args?.wordId === "string" ? args.wordId : "";
			if (!trackId || !elementId || !wordId) return;

			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateWords: (words) =>
					words.map((word) =>
						word.id === wordId ? { ...word, removed: !word.removed } : word,
					),
			});
			if (result.error) {
				toast.error(result.error);
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-toggle-word-hidden",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			const wordId = typeof args?.wordId === "string" ? args.wordId : "";
			if (!trackId || !elementId || !wordId) return;

			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateWords: (words) =>
					words.map((word) =>
						word.id === wordId ? { ...word, hidden: !word.hidden } : word,
					),
			});
			if (result.error) {
				toast.error(result.error);
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-update-word",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			const wordId = typeof args?.wordId === "string" ? args.wordId : "";
			const text = typeof args?.text === "string" ? args.text.trim() : "";
			if (!trackId || !elementId || !wordId || !text) {
				if (!text) {
					toast.error("Word text cannot be empty");
				}
				return;
			}
			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateWords: (words) =>
					words.map((word) => (word.id === wordId ? { ...word, text } : word)),
			});
			if (result.error) {
				toast.error(result.error);
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-update-words",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			const updates = Array.isArray(args?.updates)
				? args.updates.filter(
						(item): item is { wordId: string; text: string } =>
							Boolean(
								item &&
									typeof item.wordId === "string" &&
									item.wordId.length > 0 &&
									typeof item.text === "string" &&
									item.text.trim().length > 0,
							),
					)
				: [];
			if (!trackId || !elementId || updates.length === 0) return;
			const textByWordId = new Map(
				updates.map((item) => [item.wordId, item.text.trim()]),
			);
			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateWords: (words) =>
					words.map((word) =>
						textByWordId.has(word.id)
							? { ...word, text: textByWordId.get(word.id) ?? word.text }
							: word,
					),
			});
			if (result.error) {
				toast.error(result.error);
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-set-words-removed",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			const wordIds = Array.isArray(args?.wordIds)
				? args.wordIds.filter(
						(value): value is string => typeof value === "string",
					)
				: [];
			const removed = Boolean(args?.removed);
			if (!trackId || !elementId || wordIds.length === 0) return;
			const targetWordIds = new Set(wordIds);
			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateWords: (words) =>
					words.map((word) =>
						targetWordIds.has(word.id) ? { ...word, removed } : word,
					),
			});
			if (result.error) {
				toast.error(result.error);
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-remove-fillers",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			if (!trackId || !elementId) return;
			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateWords: (words) =>
					words.map((word) =>
						isFillerWordOrPhrase({ text: word.text })
							? { ...word, removed: true }
							: word,
					),
			});
			if (result.error) {
				toast.error(result.error);
				return;
			}
			if (result.changed) {
				toast.success("Filler words removed from transcript and captions");
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-remove-pauses",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			const thresholdSecondsRaw = args?.thresholdSeconds;
			const thresholdSeconds =
				typeof thresholdSecondsRaw === "number" &&
				Number.isFinite(thresholdSecondsRaw) &&
				thresholdSecondsRaw > 0
					? thresholdSecondsRaw
					: DEFAULT_PAUSE_REMOVAL_MIN_GAP_SECONDS;
			if (!trackId || !elementId) return;
			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateCuts: (cuts, words) => {
					const pauseCuts = buildPauseCutsFromWords({
						words,
						thresholdSeconds,
					});
					const nonPauseCuts = cuts.filter((cut) => cut.reason !== "pause");
					return [...nonPauseCuts, ...pauseCuts];
				},
			});
			if (result.error) {
				toast.error(result.error);
				return;
			}
			if (result.changed) {
				toast.success(
					`Removed pauses longer than ${thresholdSeconds.toFixed(1)}s`,
				);
			} else {
				toast.info("No long pauses detected");
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-restore-all",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			if (!trackId || !elementId) return;
			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateWords: (words) =>
					words.map((word) => ({ ...word, removed: false, hidden: false })),
			});
			if (result.error) {
				toast.error(result.error);
				return;
			}
			if (result.changed) {
				toast.success("Restored all transcript words");
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-split-segment-ui",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			const wordId = typeof args?.wordId === "string" ? args.wordId : "";
			if (!trackId || !elementId || !wordId) return;
			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateSegmentsUi: (segments, words) => {
					const splitIndex = words.findIndex((word) => word.id === wordId);
					if (splitIndex <= 0 || splitIndex >= words.length - 1)
						return segments;
					const currentSegments =
						segments && segments.length > 0
							? [...segments]
							: [
									{
										id: `${elementId}:seg:0`,
										wordStartIndex: 0,
										wordEndIndex: words.length - 1,
									},
								];
					const containingIndex = currentSegments.findIndex(
						(segment) =>
							splitIndex >= segment.wordStartIndex &&
							splitIndex <= segment.wordEndIndex,
					);
					if (containingIndex < 0) return currentSegments;
					const segment = currentSegments[containingIndex];
					if (splitIndex >= segment.wordEndIndex) return currentSegments;
					const left = {
						...segment,
						wordEndIndex: splitIndex,
					};
					const right = {
						...segment,
						id: `${elementId}:seg:${crypto.randomUUID()}`,
						wordStartIndex: splitIndex + 1,
					};
					return [
						...currentSegments.slice(0, containingIndex),
						left,
						right,
						...currentSegments.slice(containingIndex + 1),
					];
				},
			});
			if (result.error) {
				toast.error(result.error);
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-update-speaker-label",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			const speakerId =
				typeof args?.speakerId === "string" ? args.speakerId.trim() : "";
			const label = typeof args?.label === "string" ? args.label.trim() : "";
			if (!trackId || !elementId || !speakerId || !label) {
				if (!label) {
					toast.error("Speaker name cannot be empty");
				}
				return;
			}

			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateSpeakerLabels: (speakerLabels) => ({
					...speakerLabels,
					[speakerId]: label,
				}),
			});
			if (result.error) {
				toast.error(result.error);
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-update-gap-text",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			const leftWordId =
				typeof args?.leftWordId === "string" ? args.leftWordId : "";
			const rightWordId =
				typeof args?.rightWordId === "string" ? args.rightWordId : "";
			const text = typeof args?.text === "string" ? args.text : "";
			if (!trackId || !elementId || !leftWordId || !rightWordId) return;
			const gapId = buildTranscriptGapId(leftWordId, rightWordId);
			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateGapEdits: (gapEdits) => ({
					...gapEdits,
					[gapId]: {
						...(gapEdits[gapId] ?? {}),
						text,
					},
				}),
			});
			if (result.error) {
				toast.error(result.error);
			}
		},
		undefined,
	);

	useActionHandler(
		"transcript-toggle-gap-removed",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			const leftWordId =
				typeof args?.leftWordId === "string" ? args.leftWordId : "";
			const rightWordId =
				typeof args?.rightWordId === "string" ? args.rightWordId : "";
			if (!trackId || !elementId || !leftWordId || !rightWordId) return;
			const removed = Boolean(args?.removed);
			const gapId = buildTranscriptGapId(leftWordId, rightWordId);
			const result = applyTranscriptEditMutation({
				editor,
				trackId,
				elementId,
				mutateGapEdits: (gapEdits) => ({
					...gapEdits,
					[gapId]: {
						...(gapEdits[gapId] ?? {}),
						removed,
					},
				}),
			});
			if (result.error) {
				toast.error(result.error);
			}
		},
		undefined,
	);

	useActionHandler(
		"rebuild-captions-for-clip",
		(args) => {
			const trackId = typeof args?.trackId === "string" ? args.trackId : "";
			const elementId =
				typeof args?.elementId === "string" ? args.elementId : "";
			if (!trackId || !elementId) return;
			const tracks = editor.timeline.getTracks();
			const target = getElementFromTracks({ tracks, trackId, elementId });
			if (!target || !isTranscriptEditableMediaElement(target)) {
				toast.error("Select a video/audio clip first");
				return;
			}
			const transcriptDraft =
				getTranscriptDraft(target) ??
				initializeTranscriptEditFromExistingCaption({
					tracks,
					mediaElementId: target.id,
				});
			if (!transcriptDraft) {
				toast.error("No transcript data available to rebuild captions");
				return;
			}
			const preparedTracks = tracks.map((track) => {
				if (track.type !== "video" && track.type !== "audio") return track;
				const nextElements = track.elements.map((element) =>
					element.id === target.id && isTranscriptEditableMediaElement(element)
						? withTranscriptState({
								element,
								draft: transcriptDraft,
								applied: compileTranscriptDraft({
									mediaElementId: target.id,
									draft: transcriptDraft,
									mediaStartTime: element.startTime,
									mediaDuration: element.duration,
								}),
								compileState: {
									status: "idle",
									updatedAt: transcriptDraft.updatedAt,
								},
							})
						: element,
				);
				return { ...track, elements: nextElements } as TimelineTrack;
			});
			const rebuilt = rebuildCaptionTrackForMediaElement({
				tracks: preparedTracks,
				mediaElementId: target.id,
			});
			if (rebuilt.error) {
				toast.error(rebuilt.error);
				return;
			}
			if (!rebuilt.changed) {
				toast.info("No caption rebuild changes were needed");
				return;
			}
			const deduped = dedupeTranscriptEditsInTracks({ tracks: rebuilt.tracks });
			const nextTracks = deduped.changed ? deduped.tracks : rebuilt.tracks;
			editor.command.execute({
				command: new TracksSnapshotCommand(tracks, nextTracks),
			});
			clearTranscriptTimelineSnapshotCache();
			editor.save.markDirty();
			toast.success("Rebuilt captions for clip");
		},
		undefined,
	);

	useActionHandler(
		"refresh-derived-media-after-clip-expansion",
		(args) => {
			void (async () => {
				const trackId = typeof args?.trackId === "string" ? args.trackId : "";
				const elementId =
					typeof args?.elementId === "string" ? args.elementId : "";
				if (!trackId || !elementId) return;

				const previousTrimStart =
					typeof args?.previousTrimStart === "number"
						? args.previousTrimStart
						: Number.NaN;
				const previousDuration =
					typeof args?.previousDuration === "number"
						? args.previousDuration
						: Number.NaN;
				if (
					!Number.isFinite(previousTrimStart) ||
					!Number.isFinite(previousDuration)
				) {
					return;
				}

				const initialTracks = editor.timeline.getTracks();
				const target = getElementFromTracks({
					tracks: initialTracks,
					trackId,
					elementId,
				});
				if (!target || !isTranscriptEditableMediaElement(target)) {
					return;
				}
				if (
					!didRevealNewSourceRange({
						before: {
							trimStart: previousTrimStart,
							duration: previousDuration,
						},
						after: {
							trimStart: target.trimStart,
							duration: target.duration,
						},
					})
				) {
					return;
				}

				const expectedTrimStart = target.trimStart;
				const expectedDuration = target.duration;
				const expectedTranscriptUpdatedAt =
					typeof args?.previousTranscriptUpdatedAt === "string"
						? args.previousTranscriptUpdatedAt
						: "";

				let refreshedTranscript:
					| NonNullable<VideoElement["transcriptDraft"]>
					| NonNullable<AudioElement["transcriptDraft"]>
					| null = null;

				const mediaSourceId = getEditableMediaElementSourceId({
					element: target,
				});
				const mediaAsset =
					mediaSourceId === null
						? null
						: (editor.media
								.getAssets()
								.find((asset) => asset.id === mediaSourceId) ?? null);

				if (mediaAsset) {
					try {
						const project = editor.project.getActive();
						const transcriptResult = await getOrCreateClipTranscriptWithReuse({
							project,
							asset: mediaAsset,
							modelId: DEFAULT_TRANSCRIPTION_MODEL,
						});
						if (!transcriptResult.fromCache) {
							editor.project.setActiveProject({
								project: {
									...project,
									clipTranscriptCache: {
										...(project.clipTranscriptCache ?? {}),
										[transcriptResult.cacheKey]: transcriptResult.transcript,
									},
								},
							});
						}

						const sourceWindowWords = clipTranscriptWordsForWindow({
							words: transcriptResult.transcript.words ?? [],
							startTime: expectedTrimStart,
							endTime: expectedTrimStart + expectedDuration,
						});
						const sourceWindowSegments =
							sourceWindowWords.length === 0
								? clipTranscriptSegmentsForWindow({
										segments: transcriptResult.transcript.segments ?? [],
										startTime: expectedTrimStart,
										endTime: expectedTrimStart + expectedDuration,
									})
								: [];
						if (
							sourceWindowWords.length > 0 ||
							sourceWindowSegments.length > 0
						) {
							const fullProjectionWords =
								(transcriptResult.transcript.words?.length ?? 0) > 0
									? buildTranscriptWordsFromTimedWords({
											mediaElementId: target.id,
											words: transcriptResult.transcript.words ?? [],
										})
									: buildTranscriptWordsFromSegments({
											mediaElementId: target.id,
											segments: transcriptResult.transcript.segments ?? [],
										});
							const wordsForEdit =
								sourceWindowWords.length > 0
									? buildTranscriptWordsFromTimedWords({
											mediaElementId: target.id,
											words: sourceWindowWords,
										})
									: buildTranscriptWordsFromSegments({
											mediaElementId: target.id,
											segments: sourceWindowSegments,
										});
							refreshedTranscript = {
								version: 1 as const,
								source: "word-level" as const,
								words: wordsForEdit,
								cuts: buildTranscriptCutsFromWords({ words: wordsForEdit }),
								cutTimeDomain: "clip-local-source" as const,
								updatedAt: new Date().toISOString(),
								projectionSource: {
									words: fullProjectionWords,
									cuts: buildTranscriptCutsFromWords({
										words: fullProjectionWords,
									}),
									updatedAt:
										transcriptResult.transcript.updatedAt ??
										new Date().toISOString(),
									baseTrimStart: 0,
								},
							};
						}
					} catch (error) {
						console.warn(
							"Failed to refresh transcript window after clip expansion:",
							error,
						);
					}
				}

				type MotionTrackingRefreshResult = {
					presetId: string;
					signature: string;
					motionTracking: VideoMotionTracking;
				};
				const motionTrackingResults: MotionTrackingRefreshResult[] = [];
				if (target.type === "video" && mediaAsset?.type === "video") {
					const projectCanvas = editor.project.getActive().settings.canvasSize;
					const sourceRange = getVideoElementSourceRange({
						element: target,
						asset: mediaAsset,
					});
					for (const preset of target.reframePresets ?? []) {
						if (!preset.motionTracking?.enabled) continue;
						try {
							const result = await analyzeGeneratedClipMotionTracking({
								asset: mediaAsset,
								startTime: sourceRange.startTime,
								endTime: sourceRange.endTime,
								canvasSize: projectCanvas,
								baseScale: preset.transform.scale,
								targetTransform: preset.transform,
								targetSubjectHint: getTrackingSubjectHint({ preset }),
								targetSubjectSeed: preset.subjectSeed,
								animateScale: preset.motionTracking?.animateScale ?? false,
								trackingStrength: normalizeMotionTrackingStrength(
									preset.motionTracking?.trackingStrength,
								),
							});
							if (result.keyframes.length === 0) continue;
							motionTrackingResults.push({
								presetId: preset.id,
								signature: buildMotionTrackingPresetSignature({ preset }),
								motionTracking: {
									enabled: true,
									mode: "subject-single-v1",
									source: "baked-keyframes",
									lastAnalyzedAt: new Date().toISOString(),
									animateScale: preset.motionTracking?.animateScale ?? false,
									trackingStrength: normalizeMotionTrackingStrength(
										preset.motionTracking?.trackingStrength,
									),
									sourceAssetId: mediaAsset.id,
									sourceStartTime: sourceRange.startTime,
									sourceEndTime: sourceRange.endTime,
									presetSignature: buildMotionTrackingPresetSignature({
										preset,
									}),
									sampleCount: result.sampleCount,
									trackedSampleCount: result.trackedSampleCount,
									keyframes: result.keyframes,
								},
							});
						} catch (error) {
							console.warn(
								"Failed to refresh motion tracking after clip expansion:",
								error,
							);
						}
					}
				}

				let nextTracks = editor.timeline.getTracks();
				let didChangeTracks = false;
				const latestTarget = getElementFromTracks({
					tracks: nextTracks,
					trackId,
					elementId,
				});
				if (
					!latestTarget ||
					!isTranscriptEditableMediaElement(latestTarget) ||
					!hasMatchingSourceWindow({
						element: latestTarget,
						trimStart: expectedTrimStart,
						duration: expectedDuration,
					})
				) {
					return;
				}

				const transcriptWasEditedSinceResize =
					latestTarget.transcriptDraft &&
					expectedTranscriptUpdatedAt.length > 0 &&
					latestTarget.transcriptDraft.updatedAt !==
						expectedTranscriptUpdatedAt;

				if (refreshedTranscript && !transcriptWasEditedSinceResize) {
					const refreshedTarget = withTranscriptState({
						element: latestTarget,
						draft: refreshedTranscript,
						applied: compileTranscriptDraft({
							mediaElementId: latestTarget.id,
							draft: refreshedTranscript,
							mediaStartTime: latestTarget.startTime,
							mediaDuration: latestTarget.duration,
						}),
						compileState: {
							status: "idle",
							updatedAt: refreshedTranscript.updatedAt,
						},
					});
					nextTracks = replaceElementInTracks({
						tracks: nextTracks,
						trackId,
						elementId,
						element: refreshedTarget,
					});
					didChangeTracks = true;
					const rebuilt = rebuildCaptionTrackForMediaElement({
						tracks: nextTracks,
						mediaElementId: latestTarget.id,
					});
					if (rebuilt.error) {
						console.warn(
							"Failed to rebuild captions after clip expansion:",
							rebuilt.error,
						);
					} else if (rebuilt.changed) {
						const deduped = dedupeTranscriptEditsInTracks({
							tracks: rebuilt.tracks,
						});
						nextTracks = deduped.changed ? deduped.tracks : rebuilt.tracks;
						clearTranscriptTimelineSnapshotCache();
						didChangeTracks = true;
					} else {
						nextTracks = rebuilt.tracks;
					}
				}

				if (motionTrackingResults.length > 0) {
					const latestVideoTarget = getElementFromTracks({
						tracks: nextTracks,
						trackId,
						elementId,
					});
					if (latestVideoTarget?.type === "video") {
						const motionTrackingByPresetId = new Map(
							motionTrackingResults.map((entry) => [entry.presetId, entry]),
						);
						const nextPresets = (latestVideoTarget.reframePresets ?? []).map(
							(preset) => {
								const refreshed = motionTrackingByPresetId.get(preset.id);
								if (!refreshed) return preset;
								if (
									buildMotionTrackingPresetSignature({ preset }) !==
									refreshed.signature
								) {
									return preset;
								}
								return {
									...preset,
									motionTracking: refreshed.motionTracking,
								};
							},
						);
						nextTracks = replaceElementInTracks({
							tracks: nextTracks,
							trackId,
							elementId,
							element: {
								...latestVideoTarget,
								reframePresets: nextPresets,
							},
						});
						didChangeTracks = true;
					}
				}

				if (didChangeTracks) {
					editor.timeline.updateTracks(nextTracks);
					editor.save.markDirty();
				}
			})();
		},
		undefined,
	);

	useActionHandler(
		"caption-run-drift-check",
		() => {
			const tracks = editor.timeline.getTracks();
			const driftCheck = validateAndHealCaptionDriftInTracks({
				tracks,
				projectId: editor.project.getActive().metadata.id,
			});
			if (!driftCheck.changed) {
				toast.info("No caption drift detected");
				return;
			}
			editor.command.execute({
				command: new TracksSnapshotCommand(tracks, driftCheck.tracks),
			});
			editor.save.markDirty();
			toast.success("Caption drift detected and auto-healed");
		},
		undefined,
	);

	useActionHandler(
		"generate-viral-clips",
		(args) => {
			void (async () => {
				const candidateSourceAssets = editor.media
					.getAssets()
					.filter(
						(asset) =>
							!asset.ephemeral &&
							(asset.type === "video" || asset.type === "audio"),
					);
				const resolvedSourceMediaId =
					args?.sourceMediaId && args.sourceMediaId.length > 0
						? args.sourceMediaId
						: candidateSourceAssets[0]?.id;

				if (!resolvedSourceMediaId) {
					toast.error("Add a video or audio media file first");
					return;
				}

				const mediaAsset = candidateSourceAssets.find(
					(asset) => asset.id === resolvedSourceMediaId,
				);
				if (
					!mediaAsset ||
					(mediaAsset.type !== "video" && mediaAsset.type !== "audio")
				) {
					setError({
						error: "Selected media does not support clip generation",
					});
					toast.error("Select a video or audio asset to generate clips");
					return;
				}

				const currentProject = editor.project.getActive();
				let transcriptionOperationId: string | undefined;
				let projectProcessId: string | undefined;
				let preparationHeartbeatId: number | undefined;
				let hasTranscriptionProgress = false;

				try {
					const mediaLinkedProject =
						currentProject.externalMediaLinks?.[mediaAsset.id];
					if (mediaLinkedProject) {
						const linkedKey = `${mediaLinkedProject.sourceSystem}:${mediaLinkedProject.externalProjectId}`;
						const hasLinkedTranscript = Boolean(
							currentProject.externalTranscriptCache?.[linkedKey],
						);
						if (!hasLinkedTranscript) {
							try {
								const response = await fetch(
									`/api/external-projects/${encodeURIComponent(currentProject.metadata.id)}/transcript/apply`,
									{
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({
											sourceSystem: mediaLinkedProject.sourceSystem,
											externalProjectId: mediaLinkedProject.externalProjectId,
										}),
									},
								);
								if (response.ok) {
									const json = (await response.json()) as {
										sourceSystem: "thumbnail_decoupled";
										externalProjectId: string;
										transcriptText: string;
										segments: Array<{
											text: string;
											start: number;
											end: number;
										}>;
										segmentsCount: number;
										audioDurationSeconds: number | null;
										qualityMeta?: Record<string, unknown>;
										updatedAt: string;
									};
									const latestProject = editor.project.getActive();
									editor.project.setActiveProject({
										project: {
											...latestProject,
											externalTranscriptCache: {
												...(latestProject.externalTranscriptCache ?? {}),
												[`${json.sourceSystem}:${json.externalProjectId}`]: {
													sourceSystem: json.sourceSystem,
													externalProjectId: json.externalProjectId,
													transcriptText: json.transcriptText,
													segments: json.segments,
													segmentsCount: json.segmentsCount,
													audioDurationSeconds: json.audioDurationSeconds,
													qualityMeta: json.qualityMeta,
													updatedAt: json.updatedAt,
												},
											},
										},
									});
									editor.save.markDirty();
								}
							} catch (error) {
								console.warn(
									"Unable to hydrate media-linked external transcript before clip generation:",
									error,
								);
							}
						}

						// If this media is explicitly linked, do not fall back to local transcription.
						// Fail fast when transcript cannot be resolved so linkage issues are visible.
						const latestProject = editor.project.getActive();
						const hasResolvedLinkedTranscript = Boolean(
							latestProject.externalTranscriptCache?.[
								linkedKey
							]?.transcriptText?.trim() &&
								(latestProject.externalTranscriptCache?.[linkedKey]?.segments
									?.length ?? 0) > 0,
						);
						if (!hasResolvedLinkedTranscript) {
							throw new Error(
								`Linked transcript not found for media ${mediaAsset.name} (${mediaLinkedProject.externalProjectId}). Skipping fallback transcription.`,
							);
						}
					}

					setStatus({
						status: "extracting",
						sourceMediaId: mediaAsset.id,
						progress: 5,
						progressMessage: "Preparing transcript...",
					});
					transcriptionOperationId = transcriptionStatus.start(
						"Preparing transcript...",
					);
					projectProcessId = registerProcess({
						projectId: currentProject.metadata.id,
						kind: "clip-generation",
						label: "Generating clips...",
					});
					preparationHeartbeatId = window.setInterval(() => {
						if (hasTranscriptionProgress) return;
						transcriptionStatus.update({
							operationId: transcriptionOperationId,
							message: "Preparing transcript...",
							progress: null,
						});
						setProgress({
							sourceMediaId: mediaAsset.id,
							progress: 5,
							progressMessage: "Preparing transcript...",
						});
						if (projectProcessId) {
							updateProcessLabel({
								id: projectProcessId,
								label: "Preparing transcript...",
							});
						}
					}, 900);
					const projectForTranscript = editor.project.getActive();
					const mediaLinkedProjectResolved =
						projectForTranscript.externalMediaLinks?.[mediaAsset.id];
					let transcriptResult: Awaited<
						ReturnType<typeof getOrCreateClipTranscriptWithReuse>
					> | null = null;
					if (mediaLinkedProjectResolved) {
						const linkedKey = `${mediaLinkedProjectResolved.sourceSystem}:${mediaLinkedProjectResolved.externalProjectId}`;
						const linkedTranscript =
							projectForTranscript.externalTranscriptCache?.[linkedKey];
						if (!linkedTranscript) {
							throw new Error(
								`Linked transcript missing in cache for media ${mediaAsset.name} (${mediaLinkedProjectResolved.externalProjectId}).`,
							);
						}
						const derived =
							buildClipTranscriptEntryFromLinkedExternalTranscript({
								asset: mediaAsset,
								modelId: DEFAULT_TRANSCRIPTION_MODEL,
								language: PROJECT_MEDIA_TRANSCRIPT_LANGUAGE,
								externalTranscript: linkedTranscript,
							});
						if (!derived) {
							const suitability = evaluateTranscriptSuitability({
								transcriptText: linkedTranscript.transcriptText,
								segments: linkedTranscript.segments,
								audioDurationSeconds: linkedTranscript.audioDurationSeconds,
							});
							throw new Error(
								`Linked transcript is unsuitable for clip generation for media ${mediaAsset.name} (${mediaLinkedProjectResolved.externalProjectId}): ${suitability.reasons.join(", ") || "unknown suitability failure"}.`,
							);
						}
						transcriptResult = {
							transcript: derived.transcript,
							cacheKey: derived.cacheKey,
							transcriptRef: {
								cacheKey: derived.cacheKey,
								modelId: DEFAULT_TRANSCRIPTION_MODEL,
								language: "auto",
								updatedAt: derived.transcript.updatedAt,
							},
							fromCache: true,
							source: "media-linked",
						};
					} else {
						transcriptResult = await getOrCreateClipTranscriptWithReuse({
							project: projectForTranscript,
							asset: mediaAsset,
							modelId: DEFAULT_TRANSCRIPTION_MODEL,
							onProgress: (progress) => {
								hasTranscriptionProgress = true;
								setStatus({
									status: "transcribing",
									sourceMediaId: mediaAsset.id,
								});
								setProgress({
									sourceMediaId: mediaAsset.id,
									progress: Math.max(
										8,
										Math.min(70, 8 + progress.progress * 0.62),
									),
									progressMessage:
										progress.message ?? "Transcribing source media...",
								});
								transcriptionStatus.update({
									operationId: transcriptionOperationId,
									message: progress.message ?? "Transcribing source media...",
									progress: progress.progress,
								});
								if (projectProcessId) {
									updateProcessLabel({
										id: projectProcessId,
										label:
											progress.message ??
											`Transcription ${Math.round(progress.progress)}%`,
									});
								}
							},
						});
					}

					if (
						mediaLinkedProjectResolved &&
						transcriptResult.source !== "media-linked"
					) {
						throw new Error(
							`Linked media transcript was not selected for ${mediaAsset.name}. Source resolved: ${transcriptResult.source}`,
						);
					}

					if (!transcriptResult.fromCache) {
						const nextProject = {
							...projectForTranscript,
							clipTranscriptCache: {
								...(projectForTranscript.clipTranscriptCache ?? {}),
								[transcriptResult.cacheKey]: transcriptResult.transcript,
							},
						};
						editor.project.setActiveProject({ project: nextProject });
						editor.save.markDirty();
						await editor.save.flush();
					}

					if (transcriptResult.fromCache) {
						hasTranscriptionProgress = true;
						setProgress({
							sourceMediaId: mediaAsset.id,
							progress: 70,
							progressMessage:
								transcriptResult.source === "media-linked"
									? "Using linked transcript"
									: "Using cached transcript",
						});
						transcriptionStatus.update({
							operationId: transcriptionOperationId,
							message:
								transcriptResult.source === "media-linked"
									? "Using linked transcript for this media"
									: "Using cached transcript",
							progress: 100,
						});
						if (transcriptResult.source === "media-linked") {
							toast.success("Linked transcript found and being used");
						}
					}

					const candidateDraftsV2 = buildClipCandidatesFromTranscriptV2({
						segments: transcriptResult.transcript.segments,
						mediaDuration: resolveMediaDurationForClipCandidates({
							assetDuration: mediaAsset.duration,
							segments: transcriptResult.transcript.segments,
						}),
						minClipSeconds: VIRAL_CLIP_MIN_SECONDS,
						targetClipSeconds: VIRAL_CLIP_TARGET_SECONDS,
						maxClipSeconds: VIRAL_CLIP_MAX_SECONDS,
					});
					const candidateDrafts =
						candidateDraftsV2.length > 0
							? candidateDraftsV2
							: buildClipCandidatesFromTranscript({
									segments: transcriptResult.transcript.segments,
									mediaDuration: resolveMediaDurationForClipCandidates({
										assetDuration: mediaAsset.duration,
										segments: transcriptResult.transcript.segments,
									}),
									minClipSeconds: VIRAL_CLIP_MIN_SECONDS,
									targetClipSeconds: VIRAL_CLIP_TARGET_SECONDS,
									maxClipSeconds: VIRAL_CLIP_MAX_SECONDS,
								});
					const mediaDurationForCandidates =
						resolveMediaDurationForClipCandidates({
							assetDuration: mediaAsset.duration,
							segments: transcriptResult.transcript.segments,
						});
					const likelyWordLevelTranscript = isLikelyWordLevelTranscript({
						segments: transcriptResult.transcript.segments,
					});
					const fallbackCandidateDrafts =
						candidateDrafts.length === 0 && likelyWordLevelTranscript
							? buildCoarseFallbackClipCandidatesFromSegments({
									segments: transcriptResult.transcript.segments,
									mediaDuration: mediaDurationForCandidates,
									minClipSeconds: VIRAL_CLIP_MIN_SECONDS,
									targetClipSeconds: VIRAL_CLIP_TARGET_SECONDS,
									maxClipSeconds: VIRAL_CLIP_MAX_SECONDS,
								})
							: [];
					const candidateDraftsResolved =
						candidateDrafts.length > 0
							? candidateDrafts
							: fallbackCandidateDrafts;

					if (candidateDraftsResolved.length === 0) {
						console.warn("Clip candidate derivation failed", {
							sourceMediaId: mediaAsset.id,
							transcriptSource: transcriptResult.source,
							segmentCount: transcriptResult.transcript.segments.length,
							transcriptChars: transcriptResult.transcript.text.length,
							mediaDurationForCandidates,
							likelyWordLevelTranscript,
						});
						setError({
							error: "No candidate windows found for this transcript",
						});
						toast.error("Could not derive clip candidates from transcript");
						return;
					}

					setStatus({
						status: "scoring",
						sourceMediaId: mediaAsset.id,
						progress: 72,
						progressMessage: "Scoring clip candidates...",
					});
					if (projectProcessId) {
						updateProcessLabel({
							id: projectProcessId,
							label: `Scoring clip virality (0/${candidateDraftsResolved.length})...`,
						});
					}
					const scoredResponse = await fetchScoredCandidates({
						transcript: transcriptResult.transcript.text,
						candidates: candidateDraftsResolved,
					});
					const scoredCandidates = scoredResponse.candidates ?? [];
					if (projectProcessId) {
						updateProcessLabel({
							id: projectProcessId,
							label: `Scoring clip virality (${scoredCandidates.length}/${candidateDraftsResolved.length})...`,
						});
					}
					setProgress({
						sourceMediaId: mediaAsset.id,
						progress: 99,
						progressMessage: `Scoring clip candidates (${scoredCandidates.length}/${candidateDraftsResolved.length})...`,
					});
					const minDesiredClipCount = Math.min(3, MAX_VIRAL_CLIP_COUNT);
					const strictCandidates = selectTopCandidatesWithQualityGate({
						candidates: scoredCandidates,
						minScore: MIN_VIRAL_CLIP_SCORE,
						maxOverlapRatio: 0,
						maxCount: MAX_VIRAL_CLIP_COUNT,
						excludeFailureFlags: ["cutoff_start"],
					});
					const selectedCandidates =
						strictCandidates.length >= minDesiredClipCount
							? strictCandidates
							: (() => {
									const relaxed = selectTopCandidatesWithCoverageBackfill({
										candidates: scoredCandidates,
										minScore: Math.max(45, MIN_VIRAL_CLIP_SCORE - 8),
										maxOverlapRatio: 0.2,
										maxCount: MAX_VIRAL_CLIP_COUNT,
										excludeFailureFlags: [],
										minDesiredCount: minDesiredClipCount,
										backfillMinScore: 38,
										backfillMaxOverlapRatio: 0.2,
										coverageBucketSeconds: VIRAL_CLIP_TARGET_SECONDS,
									});
									const baseline =
										relaxed.length === 0 ? strictCandidates : relaxed;
									if (baseline.length >= minDesiredClipCount) {
										return baseline;
									}
									const rescue = selectTopCandidatesWithCoverageBackfill({
										candidates: scoredCandidates,
										minScore: 0,
										maxOverlapRatio: 0.35,
										maxCount: MAX_VIRAL_CLIP_COUNT,
										excludeFailureFlags: [],
										minDesiredCount: minDesiredClipCount,
										backfillMinScore: 0,
										backfillMaxOverlapRatio: 0.35,
										coverageBucketSeconds: VIRAL_CLIP_TARGET_SECONDS,
										requireCleanBoundariesInBackfill: false,
										excludeCutoffFailuresInBackfill: false,
									});
									const byId = new Map(
										[...strictCandidates, ...baseline, ...rescue].map(
											(candidate) => [candidate.id, candidate],
										),
									);
									const resolved = Array.from(byId.values())
										.sort((a, b) => b.scoreOverall - a.scoreOverall)
										.slice(0, MAX_VIRAL_CLIP_COUNT);
									console.info("Clip candidate selection diagnostics", {
										sourceMediaId: mediaAsset.id,
										draftCount: candidateDraftsResolved.length,
										scoredCount: scoredCandidates.length,
										strictCount: strictCandidates.length,
										relaxedCount: relaxed.length,
										rescueCount: rescue.length,
										selectedCount: resolved.length,
										selectedWindows: resolved.map((candidate) => ({
											startTime: candidate.startTime,
											endTime: candidate.endTime,
											scoreOverall: candidate.scoreOverall,
										})),
									});
									return resolved;
								})();

					if (selectedCandidates.length === 0) {
						setError({
							error:
								"No clips passed the quality gate. Try another source or longer material.",
						});
						const projectWithCache = withProjectClipGenerationCache({
							project: editor.project.getActive(),
							sourceMediaId: mediaAsset.id,
							candidates: [],
							transcriptRef: transcriptResult.transcriptRef,
							error:
								"No clips passed the quality gate. Try another source or longer material.",
						});
						editor.project.setActiveProject({ project: projectWithCache });
						editor.save.markDirty();
						await editor.save.flush();
						toast.error("No clips passed the virality quality gate");
						return;
					}

					setCandidates({
						sourceMediaId: mediaAsset.id,
						candidates: selectedCandidates,
						transcriptRef: transcriptResult.transcriptRef,
						status: "ready",
					});
					const projectWithCache = withProjectClipGenerationCache({
						project: editor.project.getActive(),
						sourceMediaId: mediaAsset.id,
						candidates: selectedCandidates,
						transcriptRef: transcriptResult.transcriptRef,
						error: null,
					});
					editor.project.setActiveProject({ project: projectWithCache });
					editor.save.markDirty();
					await editor.save.flush();
					toast.success(
						`Generated ${selectedCandidates.length} clip candidate(s)`,
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Clip generation failed";
					setError({ error: message });
					toast.error(message);
				} finally {
					if (preparationHeartbeatId) {
						window.clearInterval(preparationHeartbeatId);
					}
					transcriptionStatus.stop(transcriptionOperationId);
					if (projectProcessId) {
						removeProcess({ id: projectProcessId });
					}
				}
			})();
		},
		undefined,
	);

	useActionHandler(
		"import-selected-viral-clips",
		(args) => {
			void (async () => {
				try {
					const clipStoreState = useClipGenerationStore.getState();
					const sourceMediaId = clipStoreState.sourceMediaId;
					if (!sourceMediaId) {
						toast.error("Generate clips first");
						return;
					}

					const mediaAsset = editor.media
						.getAssets()
						.find((asset) => asset.id === sourceMediaId);
					if (
						!mediaAsset ||
						(mediaAsset.type !== "video" && mediaAsset.type !== "audio")
					) {
						toast.error("Source media for clips was not found");
						return;
					}

					const candidateIds = args?.candidateIds?.length
						? args.candidateIds
						: clipStoreState.selectedCandidateIds;
					if (candidateIds.length === 0) {
						toast.error("Select one or more clip candidates to import");
						return;
					}

					const candidates = candidateIds
						.map((id) =>
							clipStoreState.candidates.find(
								(candidate) => candidate.id === id,
							),
						)
						.filter(
							(candidate): candidate is NonNullable<typeof candidate> =>
								candidate != null,
						);

					if (candidates.length === 0) {
						toast.error("No valid selected clip candidates found");
						return;
					}

					const refreshedProject = editor.project.getActive();
					const projectCanvas = refreshedProject.settings.canvasSize;
					const clipWordTranscriptionCache =
						refreshedProject.clipWordTranscriptionCache ?? {};
					const createdSceneIds: string[] = [];
					let localWordCaptionCount = 0;
					let preparedClipAudioCount = 0;
					let nearSilentClipAudioCount = 0;
					let projectProcessId: string | undefined;
					type PreparedClipImport = {
						candidate: (typeof candidates)[number];
						clipAudioBuffer: AudioBuffer | null;
						continuousCaption: ReturnType<typeof buildContinuousCaptionForClip>;
						captionSource: "local-word" | "transcript-cache" | null;
						reframeSeed: Awaited<
							ReturnType<typeof analyzeGeneratedClipReframes>
						> | null;
					};
					const preparedImports: PreparedClipImport[] = [];
					const updatedWordTranscriptionCacheEntries: Record<
						string,
						{
							modelId: string;
							mediaId: string;
							startTime: number;
							endTime: number;
							segments: TranscriptionSegment[];
							updatedAt: string;
						}
					> = {};
					const resolvedVideoScale =
						mediaAsset.type === "video"
							? await resolveVideoCoverScale({
									asset: mediaAsset,
									canvasSize: projectCanvas,
								})
							: 1;
					const blueHighlightPreset = resolveBlueHighlightCaptionPreset();

					try {
						projectProcessId = registerProcess({
							projectId: refreshedProject.metadata.id,
							kind: "clip-generation",
							label: `Preparing clip imports (0/${candidates.length})...`,
						});

						for (let i = 0; i < candidates.length; i++) {
							const candidate = candidates[i];
							updateProcessLabel({
								id: projectProcessId,
								label: `Preparing clip imports (${i + 1}/${candidates.length}): audio + transcription...`,
							});
							const clipWordTranscriptionCacheKey =
								buildClipWordTranscriptionCacheKey({
									mediaId: mediaAsset.id,
									startTime: candidate.startTime,
									endTime: candidate.endTime,
									modelId: CLIP_IMPORT_TRANSCRIPTION_MODEL,
								});
							const clipAudioBuffer = await decodeAssetWindowToAudioBuffer({
								asset: mediaAsset,
								startTime: candidate.startTime,
								endTime: candidate.endTime,
							});
							if (clipAudioBuffer) {
								preparedClipAudioCount += 1;
								const rms = (() => {
									const channelData = clipAudioBuffer.getChannelData(0);
									if (channelData.length === 0) return 0;
									let sumSquares = 0;
									for (let index = 0; index < channelData.length; index++) {
										const value = channelData[index];
										sumSquares += value * value;
									}
									return Math.sqrt(sumSquares / channelData.length);
								})();
								if (!Number.isFinite(rms) || rms < 1e-4) {
									nearSilentClipAudioCount += 1;
								}
							}
							let wordLevelSegments: TranscriptionSegment[] | null =
								clipWordTranscriptionCache[clipWordTranscriptionCacheKey]
									?.segments ?? null;
							if (!wordLevelSegments) {
								wordLevelSegments =
									clipAudioBuffer && clipAudioBuffer.length > 0
										? await transcribeDecodedClipAudioWordLevel({
												samples: extractMonoSamplesFromAudioBuffer({
													audioBuffer: clipAudioBuffer,
												}),
												sampleRate: clipAudioBuffer.sampleRate,
												cacheKey: clipWordTranscriptionCacheKey,
											})
										: await transcribeClipWindowWordLevel({
												asset: mediaAsset,
												startTime: candidate.startTime,
												endTime: candidate.endTime,
												cacheKey: clipWordTranscriptionCacheKey,
											});
								if (wordLevelSegments && wordLevelSegments.length > 0) {
									updatedWordTranscriptionCacheEntries[
										clipWordTranscriptionCacheKey
									] = {
										modelId: CLIP_IMPORT_TRANSCRIPTION_MODEL,
										mediaId: mediaAsset.id,
										startTime: candidate.startTime,
										endTime: candidate.endTime,
										segments: wordLevelSegments,
										updatedAt: new Date().toISOString(),
									};
								}
							}
							const usedLocalWordTranscription = Boolean(
								wordLevelSegments && wordLevelSegments.length > 0,
							);
							if (!usedLocalWordTranscription) {
								throw new Error(
									`Word-level transcription unavailable for clip "${candidate.title || candidate.id}". Aborting import to avoid inaccurate caption timing.`,
								);
							}
							const clippedSegments: TranscriptionSegment[] =
								wordLevelSegments ?? [];
							const captionSource: PreparedClipImport["captionSource"] =
								"local-word";
							const reframeSeed =
								mediaAsset.type === "video"
									? await analyzeGeneratedClipReframes({
											asset: mediaAsset,
											startTime: candidate.startTime,
											endTime: candidate.endTime,
											canvasSize: projectCanvas,
											baseScale: resolvedVideoScale,
										})
									: null;
							preparedImports.push({
								candidate,
								clipAudioBuffer,
								continuousCaption: (() => {
									if (clippedSegments.length === 0) return null;
									const caption = buildContinuousCaptionForClip({
										segments: clippedSegments,
									});
									if (!caption) return null;
									if (
										!hasExactWordSequenceMatch({
											segments: clippedSegments,
											caption,
										})
									) {
										throw new Error(
											`Transcript integrity check failed for clip "${candidate.title || candidate.id}" (word sequence mismatch).`,
										);
									}
									return caption;
								})(),
								captionSource,
								reframeSeed,
							});
						}
						if (Object.keys(updatedWordTranscriptionCacheEntries).length > 0) {
							editor.project.setActiveProject({
								project: {
									...editor.project.getActive(),
									clipWordTranscriptionCache: {
										...clipWordTranscriptionCache,
										...updatedWordTranscriptionCacheEntries,
									},
								},
							});
							editor.save.markDirty();
						}

						for (let i = 0; i < preparedImports.length; i++) {
							const prepared = preparedImports[i];
							const { candidate, continuousCaption, captionSource } = prepared;
							updateProcessLabel({
								id: projectProcessId,
								label: `Importing clips (${i + 1}/${preparedImports.length}): creating scene...`,
							});
							const sceneName =
								candidate.title.trim().length > 0
									? candidate.title.trim()
									: `Clip ${i + 1} (${Math.round(candidate.duration)}s)`;
							const sceneId = await editor.scenes.createScene({
								name: sceneName,
								isMain: false,
							});
							createdSceneIds.push(sceneId);
							await editor.scenes.switchToScene({ sceneId });

							const tracks = editor.timeline.getTracks();
							let boundMediaElementId: string | null = null;
							let boundMediaTrackId: string | null = null;
							const generatedCaptionElements = tracks
								.filter((track) => track.type === "text")
								.flatMap((track) =>
									track.elements
										.filter(
											(element) =>
												element.type === "text" &&
												(element.captionWordTimings?.length ?? 0) > 0,
										)
										.map((element) => ({
											trackId: track.id,
											elementId: element.id,
										})),
								);
							if (generatedCaptionElements.length > 0) {
								editor.timeline.deleteElements({
									elements: generatedCaptionElements,
								});
							}

							if (mediaAsset.type === "video") {
								const mainTrack = getMainTrack({ tracks });
								if (!mainTrack) {
									toast.error("No main video track found in the new scene");
									continue;
								}
								editor.timeline.insertElement({
									placement: {
										mode: "explicit",
										trackId: mainTrack.id,
									},
									element: buildClipElement({
										asset: mediaAsset,
										startTime: candidate.startTime,
										endTime: candidate.endTime,
										canvasSize: projectCanvas,
										scaleOverride: resolvedVideoScale,
										reframeSeed: prepared.reframeSeed,
									}),
								});
								const refreshedMainTrack = editor.timeline.getTrackById({
									trackId: mainTrack.id,
								});
								boundMediaElementId =
									refreshedMainTrack?.elements.find(
										(element) =>
											element.type === "video" &&
											element.startTime === 0 &&
											Math.abs(element.trimStart - candidate.startTime) <
												0.02 &&
											Math.abs(element.duration - candidate.duration) < 0.02,
									)?.id ?? null;
								boundMediaTrackId = boundMediaElementId ? mainTrack.id : null;
							}

							if (boundMediaElementId && continuousCaption) {
								const transcriptWords = normalizeTranscriptWords({
									words: continuousCaption.wordTimings.map((timing, index) => ({
										id: `${boundMediaElementId}:word:${index}:${timing.startTime.toFixed(3)}`,
										text: timing.word,
										startTime: timing.startTime,
										endTime: timing.endTime,
										removed: false,
									})),
								});
								if (boundMediaTrackId) {
									const transcriptDraft = {
										version: 1 as const,
										source: "word-level" as const,
										words: transcriptWords,
										cuts: buildTranscriptCutsFromWords({
											words: transcriptWords,
										}),
										cutTimeDomain: "clip-local-source" as const,
										updatedAt: new Date().toISOString(),
									};
									editor.timeline.updateElements({
										updates: [
											{
												trackId: boundMediaTrackId,
												elementId: boundMediaElementId,
												updates: {
													transcriptDraft,
													transcriptEdit: transcriptDraft,
													transcriptApplied: compileTranscriptDraft({
														mediaElementId: boundMediaElementId,
														draft: transcriptDraft,
														mediaStartTime: 0,
														mediaDuration: candidate.duration,
													}),
													transcriptCompileState: {
														status: "idle",
														updatedAt: transcriptDraft.updatedAt,
													},
												},
											},
										],
										pushHistory: false,
									});
								}
							}

							if (continuousCaption) {
								const captionPayloadFromTranscript =
									buildCaptionPayloadFromTranscriptWords({
										words: normalizeTranscriptWords({
											words: continuousCaption.wordTimings.map(
												(timing, index) => ({
													id: `caption-source-word:${index}:${timing.startTime.toFixed(3)}`,
													text: timing.word,
													startTime: timing.startTime,
													endTime: timing.endTime,
													removed: false,
												}),
											),
										}),
									});
								if (!captionPayloadFromTranscript) {
									continue;
								}
								if (captionSource === "local-word") localWordCaptionCount += 1;

								const existingCaptionTrackId = findCaptionTrackIdInScene({
									tracks: editor.timeline.getTracks(),
								});
								const captionTrackId =
									existingCaptionTrackId ??
									editor.timeline.addTrack({
										type: "text",
										index: 0,
									});
								editor.timeline.insertElement({
									placement: {
										mode: "explicit",
										trackId: captionTrackId,
									},
									element: {
										...DEFAULT_TEXT_ELEMENT,
										name:
											captionSource === "local-word"
												? "Caption 1 [local-word]"
												: "Caption 1 [transcript-cache]",
										content: captionPayloadFromTranscript.content,
										duration: captionPayloadFromTranscript.duration,
										startTime: captionPayloadFromTranscript.startTime,
										captionWordTimings:
											captionPayloadFromTranscript.wordTimings,
										captionSourceRef: boundMediaElementId
											? {
													mediaElementId: boundMediaElementId,
													transcriptVersion: 1,
												}
											: undefined,
										...blueHighlightPreset.textProps,
										captionStyle: blueHighlightPreset.captionStyle,
									},
								});

								const insertedCaptions =
									editor.timeline
										.getTrackById({ trackId: captionTrackId })
										?.elements.filter(
											(element) =>
												element.type === "text" &&
												element.name.startsWith("Caption "),
										) ?? [];
								if (insertedCaptions.length > 0) {
									editor.timeline.updateElements({
										updates: insertedCaptions.map((element) => ({
											trackId: captionTrackId,
											elementId: element.id,
											updates: {
												...blueHighlightPreset.textProps,
												captionStyle: blueHighlightPreset.captionStyle,
											},
										})),
										pushHistory: false,
									});
								}
							}

							// Preload scene audio before moving on so first playback is not silent.
							await editor.audio.primeCurrentTimelineAudio();
						}
					} finally {
						if (projectProcessId) {
							removeProcess({ id: projectProcessId });
						}
					}

					if (createdSceneIds[0]) {
						await editor.scenes.switchToScene({ sceneId: createdSceneIds[0] });
						await editor.audio.primeCurrentTimelineAudio();
						requestFitView();
					}
					const normalizedProject = normalizeGeneratedCaptionsInProject({
						project: editor.project.getActive(),
					});
					if (normalizedProject.changed) {
						editor.project.setActiveProject({
							project: normalizedProject.project,
						});
						editor.save.markDirty();
					}
					if (editor.playback.getVolume() <= 0) {
						editor.playback.setVolume({ volume: 1 });
					}
					useClipGenerationStore.getState().setSelectedCandidateIds({
						candidateIds: [],
					});
					toast.success(`Imported ${createdSceneIds.length} clip scene(s)`, {
						description: `Audio prepared ${preparedClipAudioCount}/${createdSceneIds.length} (near-silent ${nearSilentClipAudioCount}). Captions local-word ${localWordCaptionCount}`,
					});
				} catch (error) {
					console.error("Failed to import selected viral clips:", error);
					toast.error(
						error instanceof Error ? error.message : "Clip import failed",
					);
				}
			})();
		},
		undefined,
	);

	useActionHandler(
		"clear-viral-clips-session",
		() => {
			const project = editor.project.getActive();
			if (project.clipGenerationCache) {
				editor.project.setActiveProject({
					project: {
						...project,
						clipGenerationCache: {},
					},
				});
				editor.save.markDirty();
				void editor.save.flush();
			}
			reset();
		},
		undefined,
	);

	useActionHandler(
		"ripple-delete-gap",
		(args) => {
			const gap =
				args &&
				typeof args.trackId === "string" &&
				Number.isFinite(args.startTime) &&
				Number.isFinite(args.endTime)
					? args
					: selectedGap;
			if (!gap) return;
			editor.timeline.deleteGap({ gap });
			editor.selection.clearSelection();
		},
		undefined,
	);

	useActionHandler(
		"delete-selected",
		() => {
			if (selectedGap) {
				editor.timeline.deleteGap({ gap: selectedGap });
				editor.selection.clearSelection();
				return;
			}
			if (selectedElements.length === 0) {
				return;
			}
			editor.timeline.deleteElements({
				elements: selectedElements,
				rippleEnabled: rippleEditingEnabled,
			});
			editor.selection.clearSelection();
		},
		undefined,
	);

	useActionHandler(
		"select-all",
		() => {
			const allElements = editor.timeline.getTracks().flatMap((track) =>
				track.elements.map((element) => ({
					trackId: track.id,
					elementId: element.id,
				})),
			);
			setElementSelection({ elements: allElements });
		},
		undefined,
	);

	useActionHandler(
		"select-all-captions",
		(args) => {
			const trackId =
				typeof args?.trackId === "string" && args.trackId.length > 0
					? args.trackId
					: null;
			const captionElements = editor.timeline
				.getTracks()
				.filter((track) => track.type === "text")
				.filter((track) => (trackId ? track.id === trackId : true))
				.flatMap((track) =>
					track.elements
						.filter(
							(element) =>
								element.type === "text" &&
								element.name.startsWith("Caption ") &&
								element.captionStyle?.linkedToCaptionGroup !== false,
						)
						.map((element) => ({
							trackId: track.id,
							elementId: element.id,
						})),
				);
			if (captionElements.length === 0) {
				toast.error(
					trackId ? "No captions found on selected track" : "No captions found",
				);
				return;
			}
			setElementSelection({ elements: captionElements });
			toast.success(`Selected ${captionElements.length} caption(s)`);
		},
		undefined,
	);

	useActionHandler(
		"duplicate-selected",
		() => {
			editor.timeline.duplicateElements({
				elements: selectedElements,
			});
		},
		undefined,
	);

	useActionHandler(
		"toggle-elements-muted-selected",
		() => {
			editor.timeline.toggleElementsMuted({ elements: selectedElements });
			// Force-refresh mixed timeline audio so mute/unmute is audible immediately.
			editor.audio.clearCachedTimelineAudio();
			void editor.audio.primeCurrentTimelineAudio();
		},
		undefined,
	);

	useActionHandler(
		"toggle-elements-visibility-selected",
		() => {
			editor.timeline.toggleElementsVisibility({ elements: selectedElements });
		},
		undefined,
	);

	useActionHandler(
		"toggle-bookmark",
		() => {
			editor.scenes.toggleBookmark({ time: editor.playback.getCurrentTime() });
		},
		undefined,
	);

	useActionHandler(
		"set-in-point",
		() => {
			editor.playback.setInPointAtCurrentTime();
		},
		undefined,
	);

	useActionHandler(
		"set-out-point",
		() => {
			editor.playback.setOutPointAtCurrentTime();
		},
		undefined,
	);

	useActionHandler(
		"clear-in-out-points",
		() => {
			editor.playback.clearInOutPoints();
		},
		undefined,
	);

	useActionHandler(
		"apply-transition-in",
		(args) => {
			applyTransition({
				side: "in",
				presetId: args?.presetId,
				durationSeconds: args?.durationSeconds,
				trackId: args?.trackId,
				elementId: args?.elementId,
			});
		},
		undefined,
	);

	useActionHandler(
		"apply-transition-out",
		(args) => {
			applyTransition({
				side: "out",
				presetId: args?.presetId,
				durationSeconds: args?.durationSeconds,
				trackId: args?.trackId,
				elementId: args?.elementId,
			});
		},
		undefined,
	);

	useActionHandler(
		"remove-transition-in",
		(args) => {
			removeTransition({
				side: "in",
				trackId: args?.trackId,
				elementId: args?.elementId,
			});
		},
		undefined,
	);

	useActionHandler(
		"remove-transition-out",
		(args) => {
			removeTransition({
				side: "out",
				trackId: args?.trackId,
				elementId: args?.elementId,
			});
		},
		undefined,
	);

	useActionHandler(
		"copy-selected",
		() => {
			if (selectedElements.length === 0) return;

			const results = editor.timeline.getElementsWithTracks({
				elements: selectedElements,
			});
			const items = results.map(({ track, element }) => {
				const { ...elementWithoutId } = element;
				return {
					trackId: track.id,
					trackType: track.type,
					element: elementWithoutId,
					sourceElementId: element.id,
				};
			});

			setClipboard({ items });
		},
		undefined,
	);

	useActionHandler(
		"generate-speaker-turn-reframes",
		(args) => {
			const trackId = args?.trackId;
			const elementId = args?.elementId;
			if (!trackId || !elementId) {
				toast.error("Missing target clip");
				return;
			}
			const track = editor.timeline.getTrackById({ trackId });
			const element = track?.elements.find(
				(candidate) => candidate.id === elementId,
			);
			if (!track || !element || element.type !== "video") {
				toast.error("Select a video clip first");
				return;
			}
			const generated = buildSpeakerTurnReframeSwitches({ element });
			if (!generated) {
				toast.error(
					"Speaker turn reframes need diarized transcript words plus Subject Left and Subject Right presets.",
				);
				return;
			}
			editor.timeline.updateElements({
				updates: [
					{
						trackId,
						elementId,
						updates: {
							defaultReframePresetId: generated.defaultPresetId,
							reframeSwitches: generated.switches,
						},
					},
				],
			});
			toast.success(
				`Generated ${generated.switches.length} speaker turn switches from ${generated.speakerOrder.length} diarized speakers.`,
			);
		},
		undefined,
	);

	useActionHandler(
		"toggle-split-screen-selected",
		() => {
			if (selectedElements.length !== 1) {
				toast.error("Select a single video clip first");
				return;
			}
			const selected = editor.timeline.getElementsWithTracks({
				elements: selectedElements,
			});
			const target = selected[0];
			if (!target || target.element.type !== "video") {
				toast.error("Select a single video clip first");
				return;
			}
			const presets = target.element.reframePresets ?? [];
			editor.timeline.updateVideoSplitScreen({
				trackId: target.track.id,
				elementId: target.element.id,
				updates: target.element.splitScreen?.enabled
					? {
							enabled: false,
						}
					: {
							enabled: true,
							layoutPreset:
								target.element.splitScreen?.layoutPreset ?? "top-bottom",
							slots:
								target.element.splitScreen?.slots ??
								buildDefaultVideoSplitScreenBindings({
									layoutPreset:
										target.element.splitScreen?.layoutPreset ?? "top-bottom",
									presets,
								}),
							sections: target.element.splitScreen?.sections ?? [],
						},
			});
		},
		undefined,
	);

	useActionHandler(
		"paste-copied",
		() => {
			if (!clipboard?.items.length) return;

			editor.timeline.pasteAtTime({
				time: editor.playback.getCurrentTime(),
				clipboardItems: clipboard.items,
			});
		},
		undefined,
	);

	useActionHandler(
		"toggle-snapping",
		() => {
			toggleSnapping();
		},
		undefined,
	);

	useActionHandler(
		"undo",
		() => {
			editor.command.undo();
		},
		undefined,
	);

	useActionHandler(
		"redo",
		() => {
			editor.command.redo();
		},
		undefined,
	);
}
