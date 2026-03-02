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
		const decodedChunk = await decodeAudioChunkToMono({
			asset,
			startTime: decodeStart,
			endTime: decodeEnd,
		});

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
}: {
	asset: MediaAsset;
	modelId: TranscriptionModelId;
	language: TranscriptionLanguage;
	externalTranscript: ExternalProjectTranscriptCacheEntry;
}): { transcript: ClipTranscriptCacheEntry; cacheKey: string } | null {
	const suitability = evaluateTranscriptSuitability({
		transcriptText: externalTranscript.transcriptText,
		segments: externalTranscript.segments,
		audioDurationSeconds: externalTranscript.audioDurationSeconds,
	});
	if (!suitability.isSuitable) return null;

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
}> {
	const resolvedLanguage = language ?? "auto";
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
				fromCache: false,
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
	return segments
		.filter((segment) => segment.end > startTime && segment.start < endTime)
		.map((segment) => ({
			text: segment.text,
			start: Math.max(0, Math.max(startTime, segment.start) - startTime),
			end: Math.max(0, Math.min(endTime, segment.end) - startTime),
		}))
		.filter((segment) => segment.end > segment.start);
}
