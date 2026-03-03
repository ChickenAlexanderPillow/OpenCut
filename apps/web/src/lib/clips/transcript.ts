import { DEFAULT_TRANSCRIPTION_MODEL } from "@/constants/transcription-constants";
import { decodeAudioToFloat32 } from "@/lib/media/audio";
import { transcriptionService } from "@/services/transcription/service";
import type { MediaAsset } from "@/types/assets";
import type { TProject } from "@/types/project";
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import type {
	ClipTranscriptCacheEntry,
	ClipTranscriptRef,
} from "@/types/clip-generation";
import type {
	TranscriptionLanguage,
	TranscriptionModelId,
	TranscriptionProgress,
	TranscriptionSegment,
} from "@/types/transcription";
import {
	evaluateTranscriptSuitability,
	hasValidMonotonicSegments,
} from "@/lib/external-projects/transcript-suitability";
import type { ExternalProjectTranscriptCacheEntry } from "@/types/external-projects";

export const CLIP_TRANSCRIPT_CACHE_VERSION = 1;
const CHUNKED_TRANSCRIPTION_DURATION_THRESHOLD_SECONDS = 4 * 60;
const CHUNKED_TRANSCRIPTION_FILE_SIZE_THRESHOLD_BYTES = 180 * 1024 * 1024;
const CHUNKED_TRANSCRIPTION_WINDOW_SECONDS = 60;
const CHUNKED_TRANSCRIPTION_OVERLAP_SECONDS = 1.5;
const CHUNK_PROGRESS_HEARTBEAT_MS = 1200;

function buildClipTranscriptFingerprint({
	asset,
	modelId,
	language,
}: {
	asset: MediaAsset;
	modelId: string;
	language: string;
}): string {
	return JSON.stringify({
		cacheVersion: CLIP_TRANSCRIPT_CACHE_VERSION,
		mediaId: asset.id,
		modelId,
		language,
		fileSize: asset.file.size,
		lastModified: asset.file.lastModified,
		duration: asset.duration ?? 0,
	});
}

function getClipTranscriptCacheKey({
	mediaId,
	modelId,
	language,
}: {
	mediaId: string;
	modelId: string;
	language: string;
}): string {
	return `${mediaId}:${modelId}:${language}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function normalizeTranscriptionSegments({
	segments,
}: {
	segments: TranscriptionSegment[];
}): TranscriptionSegment[] {
	return [...segments]
		.filter(
			(segment) =>
				Number.isFinite(segment.start) &&
				Number.isFinite(segment.end) &&
				segment.end > segment.start,
		)
		.sort((a, b) => a.start - b.start);
}

function shouldUseChunkedTranscription({ asset }: { asset: MediaAsset }): boolean {
	if (asset.file.size >= CHUNKED_TRANSCRIPTION_FILE_SIZE_THRESHOLD_BYTES) {
		return true;
	}
	if ((asset.duration ?? 0) >= CHUNKED_TRANSCRIPTION_DURATION_THRESHOLD_SECONDS) {
		return true;
	}
	return false;
}

async function decodeAudioChunkToMono({
	asset,
	startTime,
	endTime,
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
}): Promise<{ samples: Float32Array; sampleRate: number } | null> {
	const input = new Input({
		source: new BlobSource(asset.file),
		formats: ALL_FORMATS,
	});

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return null;

		const sink = new AudioBufferSink(audioTrack);
		const chunks: AudioBuffer[] = [];

		for await (const { buffer } of sink.buffers(startTime, endTime)) {
			chunks.push(buffer);
		}

		if (chunks.length === 0) return null;
		const sampleRate = chunks[0].sampleRate;
		const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const monoSamples = new Float32Array(totalSamples);

		let writeOffset = 0;
		for (const chunk of chunks) {
			const channelCount = Math.max(1, chunk.numberOfChannels);
			for (let i = 0; i < chunk.length; i++) {
				let channelSum = 0;
				for (let channel = 0; channel < channelCount; channel++) {
					channelSum += chunk.getChannelData(channel)[i] ?? 0;
				}
				monoSamples[writeOffset + i] = channelSum / channelCount;
			}
			writeOffset += chunk.length;
		}

		return {
			samples: monoSamples,
			sampleRate,
		};
	} finally {
		input.dispose();
	}
}

async function transcribeAssetInChunks({
	asset,
	modelId,
	language,
	onProgress,
}: {
	asset: MediaAsset;
	modelId: TranscriptionModelId;
	language: TranscriptionLanguage;
	onProgress?: (progress: TranscriptionProgress) => void;
}): Promise<{ text: string; segments: TranscriptionSegment[] }> {
	const duration = Math.max(0, asset.duration ?? 0);
	if (!Number.isFinite(duration) || duration <= 0) {
		const decoded = await decodeAudioToFloat32({
			audioBlob: asset.file,
			fallbackUrl: asset.url,
		});
		const result = await transcriptionService.transcribe({
			audioData: decoded.samples,
			sampleRate: decoded.sampleRate,
			language: language === "auto" ? undefined : language,
			modelId,
			onProgress,
		});
		return {
			text: result.text,
			segments: normalizeTranscriptionSegments({ segments: result.segments }),
		};
	}

	const chunkCount = Math.max(1, Math.ceil(duration / CHUNKED_TRANSCRIPTION_WINDOW_SECONDS));
	const mergedSegments: TranscriptionSegment[] = [];
	const mergedTextParts: string[] = [];

	for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
		const chunkBaseProgress = (chunkIndex / chunkCount) * 100;
		const chunkMaxSoftProgress = ((chunkIndex + 0.92) / chunkCount) * 100;

		const logicalStart = chunkIndex * CHUNKED_TRANSCRIPTION_WINDOW_SECONDS;
		const logicalEnd = Math.min(
			duration,
			logicalStart + CHUNKED_TRANSCRIPTION_WINDOW_SECONDS,
		);

		const decodeStart = Math.max(
			0,
			logicalStart - (chunkIndex === 0 ? 0 : CHUNKED_TRANSCRIPTION_OVERLAP_SECONDS),
		);
		const decodeEnd = Math.min(duration, logicalEnd + CHUNKED_TRANSCRIPTION_OVERLAP_SECONDS);
		onProgress?.({
			status: "transcribing",
			progress: Math.round(chunkBaseProgress),
			message: `Preparing chunk ${chunkIndex + 1}/${chunkCount} audio...`,
		});
		let decodeHeartbeatProgress = chunkBaseProgress;
		const decodeHeartbeatId = window.setInterval(() => {
			decodeHeartbeatProgress = Math.min(
				chunkMaxSoftProgress,
				decodeHeartbeatProgress + Math.max(0.2, 2 / chunkCount),
			);
			onProgress?.({
				status: "transcribing",
				progress: Math.round(decodeHeartbeatProgress),
				message: `Preparing chunk ${chunkIndex + 1}/${chunkCount} audio...`,
			});
		}, CHUNK_PROGRESS_HEARTBEAT_MS);
		const decodedChunk = await decodeAudioChunkToMono({
			asset,
			startTime: decodeStart,
			endTime: decodeEnd,
		});
		window.clearInterval(decodeHeartbeatId);

		if (!decodedChunk || decodedChunk.samples.length === 0) {
			onProgress?.({
				status: "transcribing",
				progress: Math.round(((chunkIndex + 1) / chunkCount) * 100),
				message: `Transcribing chunk ${chunkIndex + 1}/${chunkCount}...`,
			});
			continue;
		}

		onProgress?.({
			status: "transcribing",
			progress: Math.round(chunkBaseProgress),
			message: `Transcribing chunk ${chunkIndex + 1}/${chunkCount}...`,
		});

		let heartbeatProgress = chunkBaseProgress;
		let chunkProgressFromWorker = chunkBaseProgress;
		const heartbeatId = window.setInterval(() => {
			heartbeatProgress = Math.min(
				chunkMaxSoftProgress,
				heartbeatProgress + Math.max(0.4, 6 / chunkCount),
			);
			const progress = Math.max(heartbeatProgress, chunkProgressFromWorker);
			onProgress?.({
				status: "transcribing",
				progress: Math.round(progress),
				message: `Transcribing chunk ${chunkIndex + 1}/${chunkCount}...`,
			});
		}, CHUNK_PROGRESS_HEARTBEAT_MS);

		let chunkResult: Awaited<ReturnType<typeof transcriptionService.transcribe>>;
		try {
			chunkResult = await transcriptionService.transcribe({
				audioData: decodedChunk.samples,
				sampleRate: decodedChunk.sampleRate,
				language: language === "auto" ? undefined : language,
				modelId,
				onProgress: (chunkProgress) => {
					const completedRatio = chunkIndex / chunkCount;
					const currentRatio =
						(chunkProgress.progress / 100) * (1 / chunkCount) + completedRatio;
					chunkProgressFromWorker = Math.max(
						chunkProgressFromWorker,
						clamp(currentRatio * 100, chunkBaseProgress, chunkMaxSoftProgress),
					);
					onProgress?.({
						status: chunkProgress.status,
						progress: Math.round(clamp(currentRatio * 100, 0, 100)),
						message: `Transcribing chunk ${chunkIndex + 1}/${chunkCount}...`,
					});
				},
			});
		} finally {
			window.clearInterval(heartbeatId);
		}

		onProgress?.({
			status: "transcribing",
			progress: Math.round(((chunkIndex + 1) / chunkCount) * 100),
			message: `Transcribing chunk ${chunkIndex + 1}/${chunkCount}...`,
		});

		const adjustedSegments = chunkResult.segments
			.map((segment) => ({
				text: segment.text,
				start: segment.start + decodeStart,
				end: segment.end + decodeStart,
			}))
			.filter((segment) => segment.end > logicalStart && segment.start < logicalEnd)
			.map((segment) => ({
				text: segment.text,
				start: clamp(segment.start, logicalStart, logicalEnd),
				end: clamp(segment.end, logicalStart, logicalEnd),
			}))
			.filter((segment) => segment.end > segment.start);

		mergedSegments.push(...adjustedSegments);
		if (chunkResult.text.trim().length > 0) {
			mergedTextParts.push(chunkResult.text.trim());
		}
	}

	const normalizedSegments = normalizeTranscriptionSegments({
		segments: mergedSegments,
	});

	return {
		text:
			normalizedSegments.map((segment) => segment.text).join(" ").trim() ||
			mergedTextParts.join(" ").trim(),
		segments: normalizedSegments,
	};
}

function getValidClipTranscriptCacheEntry({
	project,
	asset,
	modelId,
	language,
}: {
	project: TProject;
	asset: MediaAsset;
	modelId: string;
	language: string;
}): { key: string; entry: ClipTranscriptCacheEntry } | null {
	const key = getClipTranscriptCacheKey({
		mediaId: asset.id,
		modelId,
		language,
	});
	const entry = project.clipTranscriptCache?.[key];
	if (!entry) return null;
	if ((entry.cacheVersion ?? 0) !== CLIP_TRANSCRIPT_CACHE_VERSION) return null;
	const expectedFingerprint = buildClipTranscriptFingerprint({
		asset,
		modelId,
		language,
	});
	if (entry.fingerprint !== expectedFingerprint) return null;
	return { key, entry };
}

function getBestLinkedExternalTranscript({
	project,
}: {
	project: TProject;
}): ExternalProjectTranscriptCacheEntry | null {
	const entries = Object.values(project.externalTranscriptCache ?? {});
	if (entries.length === 0) return null;
	const validEntries = entries
		.map((entry) => {
			const suitability = evaluateTranscriptSuitability({
				transcriptText: entry.transcriptText,
				segments: entry.segments,
				audioDurationSeconds: entry.audioDurationSeconds,
			});
			return {
				entry,
				suitability,
			};
		})
		.filter((item) => item.suitability.isSuitable)
		.sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt));
	return validEntries[0]?.entry ?? null;
}

function getLinkedExternalTranscriptForMedia({
	project,
	mediaId,
}: {
	project: TProject;
	mediaId: string;
}): ExternalProjectTranscriptCacheEntry | null {
	const mediaLink = project.externalMediaLinks?.[mediaId];
	if (!mediaLink) return null;
	const key = `${mediaLink.sourceSystem}:${mediaLink.externalProjectId}`;
	const entry = project.externalTranscriptCache?.[key];
	if (!entry) return null;
	const suitability = evaluateTranscriptSuitability({
		transcriptText: entry.transcriptText,
		segments: entry.segments,
		audioDurationSeconds: entry.audioDurationSeconds,
	});
	return suitability.isSuitable ? entry : null;
}

function normalizeLinkedSegments({
	segments,
}: {
	segments: TranscriptionSegment[];
}): TranscriptionSegment[] {
	if (!hasValidMonotonicSegments({ segments })) {
		return normalizeTranscriptionSegments({ segments });
	}
	return segments;
}

export function buildClipTranscriptEntryFromLinkedExternalTranscript({
	asset,
	modelId,
	language,
	externalTranscript,
	requireSuitability = true,
}: {
	asset: MediaAsset;
	modelId: TranscriptionModelId;
	language: TranscriptionLanguage;
	externalTranscript: ExternalProjectTranscriptCacheEntry;
	requireSuitability?: boolean;
}): { transcript: ClipTranscriptCacheEntry; cacheKey: string } | null {
	const suitability = evaluateTranscriptSuitability({
		transcriptText: externalTranscript.transcriptText,
		segments: externalTranscript.segments,
		audioDurationSeconds: externalTranscript.audioDurationSeconds,
	});
	if (requireSuitability && !suitability.isSuitable) return null;
	if (
		externalTranscript.transcriptText.trim().length === 0 ||
		externalTranscript.segments.length === 0
	) {
		return null;
	}

	const resolvedLanguage = language ?? "auto";
	const fingerprint = buildClipTranscriptFingerprint({
		asset,
		modelId,
		language: resolvedLanguage,
	});
	const cacheKey = getClipTranscriptCacheKey({
		mediaId: asset.id,
		modelId,
		language: resolvedLanguage,
	});

	return {
		cacheKey,
		transcript: {
			cacheVersion: CLIP_TRANSCRIPT_CACHE_VERSION,
			mediaId: asset.id,
			fingerprint,
			language: resolvedLanguage,
			modelId,
			text: externalTranscript.transcriptText,
			segments: normalizeLinkedSegments({
				segments: externalTranscript.segments,
			}),
			updatedAt: new Date().toISOString(),
		},
	};
}

export async function getOrCreateClipTranscriptForAsset({
	project,
	asset,
	modelId = DEFAULT_TRANSCRIPTION_MODEL,
	language = "auto",
	onProgress,
}: {
	project: TProject;
	asset: MediaAsset;
	modelId?: TranscriptionModelId;
	language?: TranscriptionLanguage;
	onProgress?: (progress: TranscriptionProgress) => void;
}): Promise<{
	transcript: ClipTranscriptCacheEntry;
	cacheKey: string;
	transcriptRef: ClipTranscriptRef;
	fromCache: boolean;
	source: "media-linked" | "cache" | "global-linked" | "local-transcription";
}> {
	const resolvedLanguage = language ?? "auto";
	const linkedTranscriptForMedia = getLinkedExternalTranscriptForMedia({
		project,
		mediaId: asset.id,
	});
	if (linkedTranscriptForMedia) {
		const derived = buildClipTranscriptEntryFromLinkedExternalTranscript({
			asset,
			modelId,
			language: resolvedLanguage,
			externalTranscript: linkedTranscriptForMedia,
			requireSuitability: false,
		});
		if (derived) {
			return {
				transcript: derived.transcript,
				cacheKey: derived.cacheKey,
				transcriptRef: {
					cacheKey: derived.cacheKey,
					modelId,
					language: resolvedLanguage,
					updatedAt: derived.transcript.updatedAt,
				},
				fromCache: true,
				source: "media-linked",
			};
		}
	}

	const validCache = getValidClipTranscriptCacheEntry({
		project,
		asset,
		modelId,
		language: resolvedLanguage,
	});
	if (validCache) {
		return {
			transcript: validCache.entry,
			cacheKey: validCache.key,
			transcriptRef: {
				cacheKey: validCache.key,
				modelId,
				language: resolvedLanguage,
				updatedAt: validCache.entry.updatedAt,
			},
			fromCache: true,
			source: "cache",
		};
	}

	const linkedExternalTranscript = getBestLinkedExternalTranscript({ project });
	if (linkedExternalTranscript) {
		const derived = buildClipTranscriptEntryFromLinkedExternalTranscript({
			asset,
			modelId,
			language: resolvedLanguage,
			externalTranscript: linkedExternalTranscript,
		});
		if (derived) {
			return {
				transcript: derived.transcript,
				cacheKey: derived.cacheKey,
				transcriptRef: {
					cacheKey: derived.cacheKey,
					modelId,
					language: resolvedLanguage,
					updatedAt: derived.transcript.updatedAt,
				},
				fromCache: true,
				source: "global-linked",
			};
		}
	}

	const result = shouldUseChunkedTranscription({ asset })
		? await transcribeAssetInChunks({
				asset,
				modelId,
				language: resolvedLanguage,
				onProgress,
			})
		: await (async () => {
				const { samples, sampleRate } = await decodeAudioToFloat32({
					audioBlob: asset.file,
					fallbackUrl: asset.url,
				});
				return await transcriptionService.transcribe({
					audioData: samples,
					sampleRate,
					language: resolvedLanguage === "auto" ? undefined : resolvedLanguage,
					modelId,
					onProgress,
				});
			})();

	const fingerprint = buildClipTranscriptFingerprint({
		asset,
		modelId,
		language: resolvedLanguage,
	});
	const cacheKey = getClipTranscriptCacheKey({
		mediaId: asset.id,
		modelId,
		language: resolvedLanguage,
	});
	const updatedAt = new Date().toISOString();
	const transcript: ClipTranscriptCacheEntry = {
		cacheVersion: CLIP_TRANSCRIPT_CACHE_VERSION,
		mediaId: asset.id,
		fingerprint,
		language: resolvedLanguage,
		modelId,
		text: result.text,
		segments: result.segments,
		updatedAt,
	};
	return {
		transcript,
		cacheKey,
		transcriptRef: {
			cacheKey,
			modelId,
			language: resolvedLanguage,
			updatedAt,
		},
		fromCache: false,
		source: "local-transcription",
	};
}

export function clipTranscriptSegmentsForWindow({
	segments,
	startTime,
	endTime,
}: {
	segments: TranscriptionSegment[];
	startTime: number;
	endTime: number;
}): TranscriptionSegment[] {
	const getOverlappingWords = ({
		text,
		segmentStart,
		segmentEnd,
		overlapStart,
		overlapEnd,
	}: {
		text: string;
		segmentStart: number;
		segmentEnd: number;
		overlapStart: number;
		overlapEnd: number;
	}): Array<{ word: string; start: number; end: number }> => {
		const words = text.match(/\S+/g) ?? [];
		if (words.length === 0) return [];
		const duration = segmentEnd - segmentStart;
		if (!Number.isFinite(duration) || duration <= 0) {
			return [
				{
					word: words.join(" "),
					start: overlapStart,
					end: overlapEnd,
				},
			];
		}

		const weights = words.map((word) => Math.max(1, word.length));
		const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
		if (!Number.isFinite(totalWeight) || totalWeight <= 0) return [];

		let accumulatedWeight = 0;
		const timedWords: Array<{ word: string; start: number; end: number }> = [];
		for (let index = 0; index < words.length; index++) {
			const startRatio = accumulatedWeight / totalWeight;
			accumulatedWeight += weights[index] ?? 1;
			const endRatio = accumulatedWeight / totalWeight;
			const wordStart = segmentStart + duration * startRatio;
			const wordEnd = segmentStart + duration * endRatio;
			timedWords.push({
				word: words[index] ?? "",
				start: wordStart,
				end: Math.max(wordEnd, wordStart + 0.01),
			});
		}

		const overlapping = timedWords.filter(
			(word) => word.end > overlapStart && word.start < overlapEnd,
		);
		if (overlapping.length > 0) return overlapping;

		const midpoint = (overlapStart + overlapEnd) / 2;
		const nearest = timedWords.reduce((closest, candidate) => {
			const candidateDistance = Math.abs(
				(candidate.start + candidate.end) / 2 - midpoint,
			);
			if (!closest) {
				return { item: candidate, distance: candidateDistance };
			}
			return candidateDistance < closest.distance
				? { item: candidate, distance: candidateDistance }
				: closest;
		}, null as { item: { word: string; start: number; end: number }; distance: number } | null);
		return nearest ? [nearest.item] : [];
	};

	return segments
		.filter((segment) => segment.end > startTime && segment.start < endTime)
		.map((segment) => {
			const overlapStart = Math.max(startTime, segment.start);
			const overlapEnd = Math.min(endTime, segment.end);
			const overlappingWords = getOverlappingWords({
				text: segment.text,
				segmentStart: segment.start,
				segmentEnd: segment.end,
				overlapStart,
				overlapEnd,
			});
			if (overlappingWords.length === 0) return null;
			const rebasedStart = Math.max(
				0,
				Math.max(overlapStart, overlappingWords[0].start) - startTime,
			);
			const rebasedEnd = Math.max(
				rebasedStart + 0.01,
				Math.min(
					overlapEnd,
					overlappingWords[overlappingWords.length - 1].end,
				) - startTime,
			);
			return {
				text: overlappingWords.map((word) => word.word).join(" ").trim(),
				start: rebasedStart,
				end: rebasedEnd,
			};
		})
		.filter(
			(segment): segment is TranscriptionSegment =>
				segment != null &&
				segment.end > segment.start &&
				segment.text.length > 0,
		);
}
