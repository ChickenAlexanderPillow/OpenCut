"use client";

import { useTimelineStore } from "@/stores/timeline-store";
import { useActionHandler } from "@/hooks/actions/use-action-handler";
import { useEditor } from "../use-editor";
import { useElementSelection } from "../timeline/element/use-element-selection";
import { getElementsAtTime } from "@/lib/timeline";
import { toast } from "sonner";
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
import type { TimelineTrack, TextElement } from "@/types/timeline";
import type { TranscriptionSegment } from "@/types/transcription";
import { useTranscriptionStatusStore } from "@/stores/transcription-status-store";
import { useProjectProcessStore } from "@/stores/project-process-store";
import { useClipGenerationStore } from "@/stores/clip-generation-store";
import { buildClipCandidatesFromTranscript } from "@/lib/clips/candidate-builder";
import { selectTopCandidatesWithQualityGate } from "@/lib/clips/scoring";
import {
	getOrCreateClipTranscriptForAsset,
} from "@/lib/clips/transcript";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import {
	resolveBlueHighlightCaptionPreset,
} from "@/constants/caption-presets";
import { normalizeGeneratedCaptionsInProject } from "@/lib/captions/generated-caption-normalizer";
import { getMainTrack } from "@/lib/timeline/track-utils";
import type { MediaAsset } from "@/types/assets";
import type { TProject } from "@/types/project";
import { DEFAULT_BLEND_MODE, DEFAULT_OPACITY, DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { getVideoInfo } from "@/lib/media/mediabunny";
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";

const MIN_VIRAL_CLIP_SCORE = 60;
const MAX_VIRAL_CLIP_COUNT = 5;
const CLIP_SCORING_TRANSCRIPT_MAX_CHARS = 20000;
const CLIP_SCORING_TIMEOUT_MS = 60000;
const CLIP_IMPORT_TRANSCRIPTION_MODEL = "large-v3";
const CLIP_TRANSCRIPTION_TIMEOUT_MS = 60000;
const CLIP_TRANSCRIPTION_MIN_DURATION_SECONDS = 0.35;
const CLIP_TRANSCRIPTION_MAX_DURATION_SECONDS = 240;
const CLIP_TRANSCRIPTION_MAX_FILE_BYTES = 20 * 1024 * 1024;
const CLIP_WORD_TRANSCRIPTION_CACHE_VERSION = 6;
const MIN_RENDERABLE_WORD_SECONDS = 1 / 30;
const CAPTION_TAIL_PAD_SECONDS = 1 / 30;
const MIN_PREFERRED_WORD_SECONDS = 3 / 30;
const MIN_BORROW_REMAINING_WORD_SECONDS = 1.5 / 30;
const MAX_BORROW_FRACTION = 0.35;
const CAPTION_PAGE_WORD_COUNT = 3;
const clipTranscriptionInFlight = new Map<
	string,
	Promise<TranscriptionSegment[] | null>
>();

function withProjectClipGenerationCache({
	project,
	sourceMediaId,
	candidates,
	transcriptRef,
	error,
}: {
	project: TProject;
	sourceMediaId: string;
	candidates: Array<{
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

function resolveClipScoringApiCandidates(): string[] {
	const fallbackBase = process.env.NEXT_PUBLIC_SITE_URL?.trim();
	const candidates: string[] = [];

	if (typeof window !== "undefined") {
		const origin = window.location.origin;
		if (origin.startsWith("http://") || origin.startsWith("https://")) {
			candidates.push(`${origin}/api/clips/score`);
			candidates.push("/api/clips/score");
		} else {
			candidates.push("/api/clips/score");
			if (fallbackBase) {
				candidates.push(`${fallbackBase.replace(/\/$/, "")}/api/clips/score`);
			}
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
				candidates.push(`${fallbackBase.replace(/\/$/, "")}/api/clips/transcribe`);
			}
		}
	} else {
		candidates.push("/api/clips/transcribe");
		if (fallbackBase) {
			candidates.push(`${fallbackBase.replace(/\/$/, "")}/api/clips/transcribe`);
		}
	}

	return Array.from(new Set(candidates));
}

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
}): Promise<Response> {
	const endpoints = resolveClipScoringApiCandidates();
	let lastNetworkError: Error | null = null;

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
			return response;
		} catch (error) {
			window.clearTimeout(timeoutId);
			lastNetworkError =
				error instanceof Error ? error : new Error("Failed to reach clip scoring API");
		}
	}

	throw lastNetworkError ?? new Error("Failed to reach clip scoring API");
}

function buildClipElement({
	asset,
	startTime,
	endTime,
	canvasSize,
	scaleOverride,
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
	canvasSize: { width: number; height: number };
	scaleOverride?: number;
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
		? Math.max(canvasSize.width / sourceWidth, canvasSize.height / sourceHeight) /
			Math.min(canvasSize.width / sourceWidth, canvasSize.height / sourceHeight)
		: 1;
	const effectiveScale =
		typeof scaleOverride === "number" && Number.isFinite(scaleOverride) && scaleOverride > 0
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
			muted: true,
			hidden: false,
			transform: {
				...DEFAULT_TRANSFORM,
				scale: Number.isFinite(effectiveScale)
					? Math.max(1, effectiveScale)
					: 1,
			},
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
	redistributeTiming = true,
}: {
	segments: Array<{ text: string; start: number; end: number }>;
	redistributeTiming?: boolean;
}): {
	content: string;
	startTime: number;
	duration: number;
	wordTimings: Array<{ word: string; startTime: number; endTime: number }>;
} | null {
	const sourceWordCount = segments
		.flatMap((segment) => segment.text.match(/\S+/g) ?? [])
		.length;
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
		const previous = normalizedWordTimings[normalizedWordTimings.length - 1];
		const nextStart = Math.max(0, rawWordTimings[i].startTime);
		const stableStart = previous
			? Math.max(nextStart, previous.startTime + MIN_RENDERABLE_WORD_SECONDS)
			: nextStart;
		const nextEnd = Math.max(
			nextStart + MIN_RENDERABLE_WORD_SECONDS,
			rawWordTimings[i].endTime,
		);
		const normalized = {
			word: rawWordTimings[i].word.trim(),
			startTime: stableStart,
			endTime: Math.max(stableStart + MIN_RENDERABLE_WORD_SECONDS, nextEnd),
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

	// Redistribute timing so very short words get readable highlight time.
	// Exception: when next word starts a new on-screen page, keep page transition timing.
	if (redistributeTiming && normalizedWordTimings.length >= 2) {
		for (let index = 0; index < normalizedWordTimings.length - 1; index++) {
			const current = normalizedWordTimings[index];
			const next = normalizedWordTimings[index + 1];
			const nextStartsNewPage = (index + 1) % CAPTION_PAGE_WORD_COUNT === 0;
			if (nextStartsNewPage) {
				continue;
			}

			const currentVisibleSeconds = Math.max(
				0,
				next.startTime - current.startTime,
			);
			if (currentVisibleSeconds >= MIN_PREFERRED_WORD_SECONDS) {
				continue;
			}

			const neededSeconds = MIN_PREFERRED_WORD_SECONDS - currentVisibleSeconds;
			const nextRemainingSeconds = Math.max(0, next.endTime - next.startTime);
			let transferableSeconds = Math.max(
				0,
				nextRemainingSeconds - MIN_BORROW_REMAINING_WORD_SECONDS,
			);
			transferableSeconds = Math.min(
				transferableSeconds,
				nextRemainingSeconds * MAX_BORROW_FRACTION,
			);

			if (index + 2 < normalizedWordTimings.length) {
				const following = normalizedWordTimings[index + 2];
				const latestNextStart = Math.max(
					next.startTime,
					following.startTime - MIN_RENDERABLE_WORD_SECONDS,
				);
				transferableSeconds = Math.min(
					transferableSeconds,
					latestNextStart - next.startTime,
				);
			}

			const shiftSeconds = Math.max(
				0,
				Math.min(neededSeconds, transferableSeconds),
			);
			if (shiftSeconds <= 0) {
				continue;
			}

			next.startTime += shiftSeconds;
			current.endTime = Math.max(current.endTime, next.startTime);
			next.endTime = Math.max(
				next.endTime,
				next.startTime + MIN_BORROW_REMAINING_WORD_SECONDS,
			);
		}

		// Backward pass: allow last word on a page to borrow from previous word.
		for (let index = 1; index < normalizedWordTimings.length; index++) {
			const isLastWordOnPage = (index + 1) % CAPTION_PAGE_WORD_COUNT === 0;
			if (!isLastWordOnPage) continue;

			const current = normalizedWordTimings[index];
			const previous = normalizedWordTimings[index - 1];
			const next = normalizedWordTimings[index + 1] ?? null;
			const currentVisibleSeconds = next
				? Math.max(0, next.startTime - current.startTime)
				: Math.max(0, current.endTime - current.startTime);

			if (currentVisibleSeconds >= MIN_PREFERRED_WORD_SECONDS) continue;

			const neededSeconds = MIN_PREFERRED_WORD_SECONDS - currentVisibleSeconds;
			const previousVisibleSeconds = Math.max(
				0,
				current.startTime - previous.startTime,
			);
			const transferableSeconds = Math.max(
				0,
				previousVisibleSeconds - MIN_BORROW_REMAINING_WORD_SECONDS,
			);
			const boundedTransferableSeconds = Math.min(
				transferableSeconds,
				previousVisibleSeconds * MAX_BORROW_FRACTION,
			);
			const shiftSeconds = Math.max(
				0,
				Math.min(neededSeconds, boundedTransferableSeconds),
			);
			if (shiftSeconds <= 0) continue;

			current.startTime = Math.max(
				previous.startTime + MIN_BORROW_REMAINING_WORD_SECONDS,
				current.startTime - shiftSeconds,
			);
			previous.endTime = Math.max(
				previous.endTime,
				previous.startTime + MIN_BORROW_REMAINING_WORD_SECONDS,
			);
			current.endTime = Math.max(
				current.endTime,
				current.startTime + MIN_RENDERABLE_WORD_SECONDS,
			);
		}
	}

	const content = normalizedWordTimings.map((timing) => timing.word).join(" ").trim();
	if (!content) return null;

	const startTime = normalizedWordTimings[0].startTime;
	const endTime = normalizedWordTimings[normalizedWordTimings.length - 1].endTime;
	return {
		content,
		startTime,
		duration: Math.max(0.04, endTime - startTime + CAPTION_TAIL_PAD_SECONDS),
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
		console.warn("Failed clip-window word-level transcription for captions:", error);
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

			const response = await fetch(endpoint, {
				method: "POST",
				body: form,
				signal: controller.signal,
			});
			window.clearTimeout(timeoutId);
			if (!response.ok) {
				const body = await response.text();
				throw new Error(`Clip transcription failed (${response.status}): ${body}`);
			}
			const json = (await response.json()) as {
				segments?: Array<{ text: string; start: number; end: number }>;
				granularity?: "word" | "segment" | "none";
				engine?: string;
				model?: string;
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
				}));
			if (segments.length > 0) {
				const durationSeconds =
					segments[segments.length - 1]!.end - segments[0]!.start;
				console.info("Clip transcription debug", {
					cacheKey,
					engine: json.engine ?? "unknown",
					model: json.model ?? "unknown",
					wordCount: segments.length,
					durationSeconds,
				});
			}
			return segments.length > 0 ? segments : null;
		} catch (error) {
			window.clearTimeout(timeoutId);
			lastNetworkError =
				error instanceof Error ? error : new Error("Failed to reach transcription API");
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
			const source = decoded.getChannelData(channelIndex).subarray(
				startSample,
				endSample,
			);
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
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) {
			return await sliceClipBufferFromFullDecode({
				asset,
				startTime,
				endTime,
			});
		}
		const sink = new AudioBufferSink(audioTrack);
		const chunks: AudioBuffer[] = [];
		let totalSamples = 0;
		for await (const { buffer } of sink.buffers(startTime, endTime)) {
			chunks.push(buffer);
			totalSamples += buffer.length;
		}
		if (chunks.length === 0 || totalSamples <= 0) {
			return await sliceClipBufferFromFullDecode({
				asset,
				startTime,
				endTime,
			});
		}

		const sampleRate = chunks[0].sampleRate;
		const channels = Math.max(1, chunks[0].numberOfChannels);
		const context = createAudioContext({ sampleRate });
		const merged = context.createBuffer(channels, totalSamples, sampleRate);
		for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
			const channelData = new Float32Array(totalSamples);
			let writeOffset = 0;
			for (const chunk of chunks) {
				const sourceChannel = Math.min(channelIndex, chunk.numberOfChannels - 1);
				channelData.set(chunk.getChannelData(sourceChannel), writeOffset);
				writeOffset += chunk.length;
			}
			merged.copyToChannel(channelData, channelIndex);
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
			.filter((element): element is typeof track.elements[number] => element !== null)
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
		element: { id: string; startTime: number; duration: number; trimStart: number };
	}>;
	resultsByElementKey: Map<string, { segments: Array<{ start: number; end: number }> }>;
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
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const transcriptionStatus = useTranscriptionStatusStore();
	const { registerProcess, updateProcessLabel, removeProcess } =
		useProjectProcessStore();
	const { selectedElements, setElementSelection } = useElementSelection();
	const { clipboard, setClipboard, toggleSnapping, rippleEditingEnabled } =
		useTimelineStore();
	const { setStatus, setError, setCandidates, reset } = useClipGenerationStore();

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
				console.warn("Failed to resolve source video dimensions for cover-fit:", error);
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

	useActionHandler(
		"toggle-play",
		() => {
			editor.playback.toggle();
		},
		undefined,
	);

	useActionHandler(
		"stop-playback",
		() => {
			if (editor.playback.getIsPlaying()) {
				editor.playback.toggle();
			}
			editor.playback.seek({ time: 0 });
		},
		undefined,
	);

	useActionHandler(
		"seek-forward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			editor.playback.seek({
				time: Math.min(
					editor.timeline.getTotalDuration(),
					editor.playback.getCurrentTime() + seconds,
				),
			});
		},
		undefined,
	);

	useActionHandler(
		"seek-backward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			editor.playback.seek({
				time: Math.max(0, editor.playback.getCurrentTime() - seconds),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-forward",
		() => {
			const fps = activeProject.settings.fps;
			editor.playback.seek({
				time: Math.min(
					editor.timeline.getTotalDuration(),
					editor.playback.getCurrentTime() + 1 / fps,
				),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-backward",
		() => {
			const fps = activeProject.settings.fps;
			editor.playback.seek({
				time: Math.max(0, editor.playback.getCurrentTime() - 1 / fps),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-forward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			editor.playback.seek({
				time: Math.min(
					editor.timeline.getTotalDuration(),
					editor.playback.getCurrentTime() + seconds,
				),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-backward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			editor.playback.seek({
				time: Math.max(0, editor.playback.getCurrentTime() - seconds),
			});
		},
		undefined,
	);

	useActionHandler(
		"goto-start",
		() => {
			editor.playback.seek({ time: 0 });
		},
		undefined,
	);

	useActionHandler(
		"goto-end",
		() => {
			editor.playback.seek({ time: editor.timeline.getTotalDuration() });
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
				const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
				let transcriptionCache = findLatestValidTranscriptionCacheEntry({
					project: currentProject,
					tracks,
					mediaAssets,
				});

				if (!transcriptionCache) {
					let transcriptionOperationId: string | undefined;
					let projectProcessId: string | undefined;
					const blueHighlightPreset = resolveBlueHighlightCaptionPreset();
					try {
						toast.info("No transcript cache found. Generating transcript...");
						transcriptionOperationId = transcriptionStatus.start(
							"Extracting audio...",
						);
						projectProcessId = registerProcess({
							projectId: currentProject.metadata.id,
							kind: "transcription",
							label: "Generating transcript...",
							cancel: () => transcriptionService.cancel(),
						});
						const audioBlob = await extractTimelineAudio({
							tracks,
							mediaAssets,
							totalDuration: editor.timeline.getTotalDuration(),
						});
						const { samples, sampleRate } = await decodeAudioToFloat32({
							audioBlob,
						});
						transcriptionStatus.update({
							operationId: transcriptionOperationId,
							message: "Transcribing...",
							progress: null,
						});
						const result = await transcriptionService.transcribe({
							audioData: samples,
							sampleRate,
							language: undefined,
							modelId: DEFAULT_TRANSCRIPTION_MODEL,
							onProgress: (progress) => {
								if (projectProcessId) {
									updateProcessLabel({
										id: projectProcessId,
										label:
											progress.message ??
											`Transcription ${Math.round(progress.progress)}%`,
									});
								}
								transcriptionStatus.update({
									operationId: transcriptionOperationId,
									message: progress.message ?? "Generating transcript...",
									progress: progress.progress,
								});
							},
						});

						const language = "auto";
						const fingerprint = buildTranscriptionFingerprint({
							tracks,
							mediaAssets,
							modelId: DEFAULT_TRANSCRIPTION_MODEL,
							language,
						});
						const cacheKey = getTranscriptionCacheKey({
							modelId: DEFAULT_TRANSCRIPTION_MODEL,
							language,
						});
						const updatedProject = {
							...currentProject,
							transcriptionCache: {
								...(currentProject.transcriptionCache ?? {}),
								[cacheKey]: {
									cacheVersion: TRANSCRIPT_CACHE_VERSION,
									fingerprint,
									language,
									modelId: DEFAULT_TRANSCRIPTION_MODEL,
									text: result.text,
									segments: result.segments,
									updatedAt: new Date().toISOString(),
								},
							},
						};
						editor.project.setActiveProject({ project: updatedProject });
						editor.save.markDirty();
						transcriptionCache = updatedProject.transcriptionCache?.[cacheKey] ?? null;
					} catch (error) {
						console.error("Auto transcript generation failed:", error);
						toast.error(
							"Smart Cut needs a transcript. Auto-generation failed; generate transcript from Captions panel and retry.",
						);
						return;
					} finally {
						transcriptionStatus.stop(transcriptionOperationId);
						if (projectProcessId) {
							removeProcess({ id: projectProcessId });
						}
					}
				}

				if (!transcriptionCache) {
					toast.error("Smart Cut needs transcript data but none is available.");
					return;
				}
				const selectedWithElements = editor.timeline.getElementsWithTracks({
					elements: selectedElements,
				});

				const processable = selectedWithElements.filter(({ element }) => {
					if (element.type !== "video" && element.type !== "audio") return false;
					if (element.type === "video") return mediaById.has(element.mediaId);
					if (element.sourceType === "upload") return mediaById.has(element.mediaId);
					return false;
				});

				if (processable.length === 0) {
					toast.error("No selected clips support Smart Cut");
					return;
				}

				toast.info("Applying transcript-driven Smart Cut...");

				const resultsByElementKey = new Map<
					string,
					ReturnType<typeof computeSmartCutFromTranscriptForElement>
				>();

				for (const { track, element } of processable) {
					const result = computeSmartCutFromTranscriptForElement({
						element,
						segments: transcriptionCache.segments,
					});
					resultsByElementKey.set(`${track.id}:${element.id}`, result);
				}

				if (resultsByElementKey.size === 0) {
					toast.error("Smart Cut could not derive cuts from transcript");
					return;
				}

				const { tracks: updatedTracks, changedElements, totalRemovedDuration } =
					applySmartCutsToTracks({
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
		"generate-viral-clips",
		(args) => {
			void (async () => {
				const candidateSourceAssets = editor
					.media
					.getAssets()
					.filter(
						(asset) =>
							!asset.ephemeral && (asset.type === "video" || asset.type === "audio"),
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
				if (!mediaAsset || (mediaAsset.type !== "video" && mediaAsset.type !== "audio")) {
					setError({ error: "Selected media does not support clip generation" });
					toast.error("Select a video or audio asset to generate clips");
					return;
				}

				const currentProject = editor.project.getActive();
				let transcriptionOperationId: string | undefined;
				let projectProcessId: string | undefined;
				let preparationHeartbeatId: number | undefined;
				let hasTranscriptionProgress = false;

				try {
					const linkedProject = currentProject.externalProjectLink;
					if (linkedProject) {
						const linkedKey = `${linkedProject.sourceSystem}:${linkedProject.externalProjectId}`;
						const hasLinkedTranscript =
							Boolean(currentProject.externalTranscriptCache?.[linkedKey]);
						if (!hasLinkedTranscript) {
							try {
								const response = await fetch(
									`/api/external-projects/${encodeURIComponent(currentProject.metadata.id)}/transcript/apply`,
									{
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({}),
									},
								);
								if (response.ok) {
									const json = (await response.json()) as {
										sourceSystem: "thumbnail_decoupled";
										externalProjectId: string;
										transcriptText: string;
										segments: Array<{ text: string; start: number; end: number }>;
										segmentsCount: number;
										audioDurationSeconds: number | null;
										qualityMeta?: Record<string, unknown>;
										updatedAt: string;
									};
									editor.project.setActiveProject({
										project: {
											...currentProject,
											externalTranscriptCache: {
												...(currentProject.externalTranscriptCache ?? {}),
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
									"Unable to hydrate linked external transcript cache before clip generation:",
									error,
								);
							}
						}
					}

					setStatus({
						status: "extracting",
						sourceMediaId: mediaAsset.id,
					});
					transcriptionOperationId = transcriptionStatus.start("Preparing transcript...");
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
						if (projectProcessId) {
							updateProcessLabel({
								id: projectProcessId,
								label: "Preparing transcript...",
							});
						}
					}, 900);
					const projectForTranscript = editor.project.getActive();

					const transcriptResult = await getOrCreateClipTranscriptForAsset({
						project: projectForTranscript,
						asset: mediaAsset,
						modelId: "whisper-tiny",
						onProgress: (progress) => {
							hasTranscriptionProgress = true;
							setStatus({
								status: "transcribing",
								sourceMediaId: mediaAsset.id,
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
					}

					const mediaDuration =
						mediaAsset.duration ??
						transcriptResult.transcript.segments[
							transcriptResult.transcript.segments.length - 1
						]?.end ??
						0;
					const candidateDrafts = buildClipCandidatesFromTranscript({
						segments: transcriptResult.transcript.segments,
						mediaDuration,
					});

					if (candidateDrafts.length === 0) {
						setError({ error: "No candidate windows found for this transcript" });
						toast.error("Could not derive clip candidates from transcript");
						return;
					}

					setStatus({
						status: "scoring",
						sourceMediaId: mediaAsset.id,
					});
					if (projectProcessId) {
						updateProcessLabel({
							id: projectProcessId,
							label: "Scoring clip virality...",
						});
					}

					const scoringResponse = await fetchScoredCandidates({
						transcript: transcriptResult.transcript.text,
						candidates: candidateDrafts,
					});

					if (!scoringResponse.ok) {
						const errorText = await scoringResponse.text();
						throw new Error(errorText || "Clip scoring failed");
					}

					const scoringJson = (await scoringResponse.json()) as {
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
					const scoredCandidates = scoringJson.candidates ?? [];
					let selectedCandidates = selectTopCandidatesWithQualityGate({
						candidates: scoredCandidates,
						minScore: MIN_VIRAL_CLIP_SCORE,
						maxOverlapRatio: 0,
						maxCount: MAX_VIRAL_CLIP_COUNT,
					});

					let relaxedQualityGateUsed = false;
					if (selectedCandidates.length === 0 && scoredCandidates.length > 0) {
						const topScore = Math.max(
							0,
							Math.min(
								100,
								Math.round(
									Math.max(...scoredCandidates.map((candidate) => candidate.scoreOverall)),
								),
							),
						);
						const relaxedMinScore = Math.max(35, Math.min(59, topScore - 8));
						selectedCandidates = selectTopCandidatesWithQualityGate({
							candidates: scoredCandidates,
							minScore: relaxedMinScore,
							maxOverlapRatio: 0,
							maxCount: MAX_VIRAL_CLIP_COUNT,
						});
						relaxedQualityGateUsed = selectedCandidates.length > 0;
					}

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
					if (relaxedQualityGateUsed) {
						toast.warning(
							`Generated ${selectedCandidates.length} clip candidate(s) with relaxed quality gate`,
						);
					} else {
						toast.success(`Generated ${selectedCandidates.length} clip candidate(s)`);
					}
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

					const mediaAsset = editor
						.media
						.getAssets()
						.find((asset) => asset.id === sourceMediaId);
					if (!mediaAsset || (mediaAsset.type !== "video" && mediaAsset.type !== "audio")) {
						toast.error("Source media for clips was not found");
						return;
					}

					const candidateIds =
						args?.candidateIds?.length
							? args.candidateIds
							: clipStoreState.selectedCandidateIds;
					if (candidateIds.length === 0) {
						toast.error("Select one or more clip candidates to import");
						return;
					}

					const candidates = candidateIds
						.map((id) => clipStoreState.candidates.find((candidate) => candidate.id === id))
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
									?.segments ??
								null;
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
							const clippedSegments: TranscriptionSegment[] = wordLevelSegments ?? [];
							const captionSource: PreparedClipImport["captionSource"] = "local-word";
							preparedImports.push({
								candidate,
								clipAudioBuffer,
								continuousCaption: (() => {
									if (clippedSegments.length === 0) return null;
									let caption = buildContinuousCaptionForClip({
										segments: clippedSegments,
										redistributeTiming: true,
									});
									if (!caption) return null;
									if (
										!hasExactWordSequenceMatch({
											segments: clippedSegments,
											caption,
										})
									) {
										caption = buildContinuousCaptionForClip({
											segments: clippedSegments,
											redistributeTiming: false,
										});
									}
									if (
										!caption ||
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
							const { candidate, clipAudioBuffer, continuousCaption, captionSource } = prepared;
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
									}),
								});
							}

							const audioTrackId = editor.timeline.addTrack({
								type: "audio",
							});
							const sourceDuration = Math.max(
								candidate.endTime,
								mediaAsset.duration ?? candidate.endTime,
							);
							const trimEnd = Math.max(0, sourceDuration - candidate.endTime);
							editor.timeline.insertElement({
								placement: {
									mode: "explicit",
									trackId: audioTrackId,
								},
								element: {
									type: "audio",
									sourceType: "upload",
									mediaId: mediaAsset.id,
									name: `${mediaAsset.name} audio`,
									duration: candidate.duration,
									startTime: 0,
									trimStart: candidate.startTime,
									trimEnd,
									volume: 1,
									muted: false,
								},
							});

							if (continuousCaption) {
								if (captionSource === "local-word") localWordCaptionCount += 1;

								const captionTrackId = editor.timeline.addTrack({
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
										content: continuousCaption.content,
										duration: continuousCaption.duration,
										startTime: continuousCaption.startTime,
										captionWordTimings: continuousCaption.wordTimings,
										...blueHighlightPreset.textProps,
										captionStyle: blueHighlightPreset.captionStyle,
									},
								});

								const insertedCaptions = editor
									.timeline
									.getTrackById({ trackId: captionTrackId })
									?.elements
									.filter(
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
					}
					const normalizedProject = normalizeGeneratedCaptionsInProject({
						project: editor.project.getActive(),
					});
					if (normalizedProject.changed) {
						editor.project.setActiveProject({ project: normalizedProject.project });
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
		"delete-selected",
		() => {
			if (selectedElements.length === 0) {
				return;
			}
			editor.timeline.deleteElements({
				elements: selectedElements,
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
				};
			});

			setClipboard({ items });
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
