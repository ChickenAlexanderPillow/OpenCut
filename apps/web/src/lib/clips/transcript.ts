import { DEFAULT_TRANSCRIPTION_MODEL } from "@/constants/transcription-constants";
import { decodeAudioToFloat32 } from "@/lib/media/audio";
import type { MediaAsset } from "@/types/assets";
import type { TMediaTranscriptLinkEntry, TProject } from "@/types/project";
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
export const PROJECT_MEDIA_TRANSCRIPT_MODEL: TranscriptionModelId =
	DEFAULT_TRANSCRIPTION_MODEL;
export const PROJECT_MEDIA_TRANSCRIPT_LANGUAGE: TranscriptionLanguage = "auto";
const CHUNKED_TRANSCRIPTION_DURATION_THRESHOLD_SECONDS = 4 * 60;
const CHUNKED_TRANSCRIPTION_FILE_SIZE_THRESHOLD_BYTES = 180 * 1024 * 1024;
const CHUNKED_TRANSCRIPTION_MIN_WINDOW_SECONDS = 60;
const CHUNKED_TRANSCRIPTION_MAX_WINDOW_SECONDS = 180;
const CHUNKED_TRANSCRIPTION_TARGET_CHUNK_COUNT = 8;
const CHUNKED_TRANSCRIPTION_TARGET_UPLOAD_BYTES = 8 * 1024 * 1024;
const CHUNKED_TRANSCRIPTION_OVERLAP_SECONDS = 1.5;
const CHUNK_PROGRESS_HEARTBEAT_MS = 1200;
const CHUNK_TRANSCRIPTION_CONCURRENCY = 2;
const CLIP_TRANSCRIPTION_API_TIMEOUT_MS = 120000;
const CLIP_TRANSCRIPTION_TARGET_SAMPLE_RATE = 16000;

function nowMs(): number {
	if (
		typeof performance !== "undefined" &&
		typeof performance.now === "function"
	) {
		return performance.now();
	}
	return Date.now();
}

function resolveClipTranscriptionApiModel({
	modelId,
}: {
	modelId: TranscriptionModelId;
}): string {
	switch (modelId) {
		case "whisper-tiny":
			return "tiny";
		case "whisper-small":
			return "small";
		case "whisper-medium":
			return "medium";
		case "whisper-large-v3-turbo":
			return "large-v3-turbo";
		default:
			return "large-v3";
	}
}

function normalizeDurationForFingerprint({
	duration,
}: {
	duration: number | undefined;
}): number {
	if (typeof duration !== "number" || !Number.isFinite(duration)) return 0;
	return Number(duration.toFixed(3));
}

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
		// OPFS can normalize file timestamps when rehydrating files.
		// Keep fingerprint stable across reloads by excluding lastModified.
		fileSize: asset.file.size,
		duration: normalizeDurationForFingerprint({ duration: asset.duration }),
	});
}

export function buildProjectMediaTranscriptLinkKey({
	asset,
}: {
	asset: Pick<
		MediaAsset,
		"name" | "type" | "file" | "duration" | "width" | "height" | "fps"
	>;
}): string {
	return JSON.stringify({
		type: asset.type,
		name: asset.name,
		fileSize: asset.file.size,
		duration: normalizeDurationForFingerprint({ duration: asset.duration }),
		width: asset.width ?? 0,
		height: asset.height ?? 0,
		fps: asset.fps ?? 0,
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

export function buildClipTranscriptCacheEntryForAsset({
	asset,
	modelId,
	language,
	text,
	segments,
	updatedAt = new Date().toISOString(),
}: {
	asset: MediaAsset;
	modelId: TranscriptionModelId;
	language: TranscriptionLanguage;
	text: string;
	segments: TranscriptionSegment[];
	updatedAt?: string;
}): {
	transcript: ClipTranscriptCacheEntry;
	cacheKey: string;
	transcriptRef: ClipTranscriptRef;
} {
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
	const transcript: ClipTranscriptCacheEntry = {
		cacheVersion: CLIP_TRANSCRIPT_CACHE_VERSION,
		mediaId: asset.id,
		fingerprint,
		language: resolvedLanguage,
		modelId,
		text,
		segments: normalizeTranscriptionSegments({ segments }),
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
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function resampleMonoSamplesForTranscription({
	samples,
	sampleRate,
	targetSampleRate = CLIP_TRANSCRIPTION_TARGET_SAMPLE_RATE,
}: {
	samples: Float32Array;
	sampleRate: number;
	targetSampleRate?: number;
}): { samples: Float32Array; sampleRate: number } {
	if (
		!Number.isFinite(sampleRate) ||
		sampleRate <= 0 ||
		!Number.isFinite(targetSampleRate) ||
		targetSampleRate <= 0 ||
		sampleRate === targetSampleRate
	) {
		return { samples, sampleRate };
	}

	const targetLength = Math.max(
		1,
		Math.round((samples.length * targetSampleRate) / sampleRate),
	);
	const resampled = new Float32Array(targetLength);
	const ratio = sampleRate / targetSampleRate;

	for (let i = 0; i < targetLength; i++) {
		const srcIndex = i * ratio;
		const left = Math.floor(srcIndex);
		const right = Math.min(left + 1, samples.length - 1);
		const weight = srcIndex - left;
		const leftValue = samples[left] ?? 0;
		const rightValue = samples[right] ?? leftValue;
		resampled[i] = leftValue * (1 - weight) + rightValue * weight;
	}

	return {
		samples: resampled,
		sampleRate: targetSampleRate,
	};
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

function resolveClipTranscriptionApiCandidates(): string[] {
	const fallbackBase = process.env.NEXT_PUBLIC_SITE_URL?.trim();
	const candidates: string[] = [];

	if (typeof window !== "undefined") {
		const origin = window.location.origin;
		if (origin.startsWith("http://") || origin.startsWith("https://")) {
			candidates.push(`${origin}/api/clips/transcribe`);
		}
		candidates.push("/api/clips/transcribe");
		if (fallbackBase) {
			candidates.push(
				`${fallbackBase.replace(/\/$/, "")}/api/clips/transcribe`,
			);
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

async function transcribeWithClipApi({
	samples,
	sampleRate,
	language,
	modelId,
	cacheKey,
}: {
	samples: Float32Array;
	sampleRate: number;
	language: TranscriptionLanguage;
	modelId: TranscriptionModelId;
	cacheKey: string;
}): Promise<{ text: string; segments: TranscriptionSegment[] }> {
	const normalizedAudio = resampleMonoSamplesForTranscription({
		samples,
		sampleRate,
	});
	const wavBlob = encodeMonoPcm16WavBlob({
		samples: normalizedAudio.samples,
		sampleRate: normalizedAudio.sampleRate,
	});
	return await transcribeWavBlobWithClipApi({
		wavBlob,
		language,
		modelId,
		cacheKey,
	});
}

async function transcribeWavBlobWithClipApi({
	wavBlob,
	language,
	modelId,
	cacheKey,
}: {
	wavBlob: Blob;
	language: TranscriptionLanguage;
	modelId: TranscriptionModelId;
	cacheKey: string;
}): Promise<{ text: string; segments: TranscriptionSegment[] }> {
	if (wavBlob.size <= 0) {
		return { text: "", segments: [] };
	}
	const requestStartedAt = nowMs();
	const approxAudioDurationSeconds = Math.max(
		0,
		Math.round(
			(Math.max(0, wavBlob.size - 44) /
				2 /
				CLIP_TRANSCRIPTION_TARGET_SAMPLE_RATE) *
				1000,
		) / 1000,
	);

	const endpoints = resolveClipTranscriptionApiCandidates();
	let lastError: Error | null = null;

	for (const endpoint of endpoints) {
		const controller = new AbortController();
		const timeoutId = window.setTimeout(() => {
			controller.abort("Clip transcription request timed out");
		}, CLIP_TRANSCRIPTION_API_TIMEOUT_MS);

		try {
			const form = new FormData();
			form.append("file", wavBlob, "clip.wav");
			form.append(
				"model",
				resolveClipTranscriptionApiModel({
					modelId,
				}),
			);
			form.append("cacheKey", cacheKey);
			if (language !== "auto") {
				form.append("language", language);
			}
			form.append("sourceModel", modelId);

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

			const payload = (await response.json()) as {
				segments?: Array<{ text: string; start: number; end: number }>;
				granularity?: "word" | "segment" | "none";
				engine?: string;
				model?: string;
				timingsMs?: Record<string, number>;
				audioDurationSeconds?: number;
				wordCount?: number;
			};
			if (payload.granularity && payload.granularity !== "word") {
				throw new Error(
					`Clip transcription returned ${payload.granularity}-level timing; word-level timing is required`,
				);
			}
			const segments = normalizeTranscriptionSegments({
				segments: (payload.segments ?? []).map((segment) => ({
					text: segment.text,
					start: segment.start,
					end: segment.end,
				})),
			});
			const elapsedMs = Math.round(nowMs() - requestStartedAt);
			const resolvedAudioDuration =
				payload.audioDurationSeconds ?? approxAudioDurationSeconds;
			const realtimeFactor =
				resolvedAudioDuration > 0
					? Number((elapsedMs / 1000 / resolvedAudioDuration).toFixed(3))
					: null;
			console.info("Clip transcript request metrics", {
				cacheKey,
				endpoint,
				engine: payload.engine ?? "unknown",
				model: payload.model ?? "unknown",
				durationMs: elapsedMs,
				audioDurationSeconds: resolvedAudioDuration,
				realtimeFactor,
				wordCount: payload.wordCount ?? segments.length,
				timingsMs: payload.timingsMs ?? null,
			});
			return {
				text: segments
					.map((segment) => segment.text)
					.join(" ")
					.trim(),
				segments,
			};
		} catch (error) {
			window.clearTimeout(timeoutId);
			lastError =
				error instanceof Error
					? error
					: new Error("Failed to reach clip transcription API");
		}
	}

	throw lastError ?? new Error("Failed to reach clip transcription API");
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

function shouldUseChunkedTranscription({
	asset,
}: {
	asset: MediaAsset;
}): boolean {
	if (asset.file.size >= CHUNKED_TRANSCRIPTION_FILE_SIZE_THRESHOLD_BYTES) {
		return true;
	}
	if (
		(asset.duration ?? 0) >= CHUNKED_TRANSCRIPTION_DURATION_THRESHOLD_SECONDS
	) {
		return true;
	}
	return false;
}

export async function transcribeClipTranscriptLocallyForAsset({
	asset,
	modelId = PROJECT_MEDIA_TRANSCRIPT_MODEL,
	language = PROJECT_MEDIA_TRANSCRIPT_LANGUAGE,
	onProgress,
}: {
	asset: MediaAsset;
	modelId?: TranscriptionModelId;
	language?: TranscriptionLanguage;
	onProgress?: (progress: TranscriptionProgress) => void;
}): Promise<{ text: string; segments: TranscriptionSegment[] }> {
	const resolvedLanguage = language ?? "auto";
	const emitProgress = ({
		progress,
		message,
	}: {
		progress: number;
		message?: string;
	}) => {
		onProgress?.({
			status: "transcribing",
			progress: Math.round(clamp(progress, 0, 100)),
			message,
		});
	};
	return shouldUseChunkedTranscription({ asset })
		? await transcribeAssetInChunks({
				asset,
				modelId,
				language: resolvedLanguage,
				onProgress,
			})
		: await (async () => {
				emitProgress({ progress: 0, message: "Preparing audio..." });
				const decodeStartedAt = nowMs();
				let decodeSoftProgress = 0;
				const decodeHeartbeatId = window.setInterval(() => {
					const elapsedSeconds = Math.max(
						0,
						(nowMs() - decodeStartedAt) / 1000,
					);
					decodeSoftProgress = Math.min(
						30,
						decodeSoftProgress + Math.max(0.6, elapsedSeconds * 0.08),
					);
					emitProgress({
						progress: decodeSoftProgress,
						message: "Preparing audio...",
					});
				}, CHUNK_PROGRESS_HEARTBEAT_MS);
				let decoded: { samples: Float32Array; sampleRate: number };
				try {
					decoded = await decodeAudioToFloat32({
						audioBlob: asset.file,
						fallbackUrl: asset.url,
					});
				} finally {
					window.clearInterval(decodeHeartbeatId);
				}
				emitProgress({ progress: 35, message: "Transcribing..." });
				const transcribeStartedAt = nowMs();
				let transcribeSoftProgress = 35;
				const durationSeconds =
					decoded.sampleRate > 0
						? decoded.samples.length / decoded.sampleRate
						: (asset.duration ?? 0);
				const expectedTranscribeSeconds = Math.max(
					8,
					Math.min(120, durationSeconds * 1.35),
				);
				const transcribeHeartbeatId = window.setInterval(() => {
					const elapsedSeconds = Math.max(
						0,
						(nowMs() - transcribeStartedAt) / 1000,
					);
					const progressByTime =
						35 + (elapsedSeconds / expectedTranscribeSeconds) * 62;
					transcribeSoftProgress = Math.max(
						transcribeSoftProgress,
						Math.min(97, progressByTime),
					);
					emitProgress({
						progress: transcribeSoftProgress,
						message: "Transcribing...",
					});
				}, CHUNK_PROGRESS_HEARTBEAT_MS);
				let result: { text: string; segments: TranscriptionSegment[] };
				try {
					result = await transcribeWithClipApi({
						samples: decoded.samples,
						sampleRate: decoded.sampleRate,
						language: resolvedLanguage,
						modelId,
						cacheKey: `${asset.id}:${modelId}:${resolvedLanguage}:single`,
					});
				} finally {
					window.clearInterval(transcribeHeartbeatId);
				}
				emitProgress({ progress: 100, message: "Transcribing..." });
				return result;
			})();
}

function resolveChunkWindowSeconds({ duration }: { duration: number }): number {
	if (!Number.isFinite(duration) || duration <= 0) {
		return CHUNKED_TRANSCRIPTION_MIN_WINDOW_SECONDS;
	}

	const bytesPerSecond = CLIP_TRANSCRIPTION_TARGET_SAMPLE_RATE * 2;
	const maxWindowByUploadSize = Math.max(
		CHUNKED_TRANSCRIPTION_MIN_WINDOW_SECONDS,
		Math.floor(
			Math.max(1, CHUNKED_TRANSCRIPTION_TARGET_UPLOAD_BYTES - 44) /
				Math.max(1, bytesPerSecond),
		),
	);
	const maxAllowedWindow = Math.min(
		CHUNKED_TRANSCRIPTION_MAX_WINDOW_SECONDS,
		maxWindowByUploadSize,
	);

	const desiredWindow = Math.ceil(
		duration / CHUNKED_TRANSCRIPTION_TARGET_CHUNK_COUNT,
	);
	return clamp(
		desiredWindow,
		CHUNKED_TRANSCRIPTION_MIN_WINDOW_SECONDS,
		Math.max(CHUNKED_TRANSCRIPTION_MIN_WINDOW_SECONDS, maxAllowedWindow),
	);
}

type ChunkDecodePlan = {
	chunkIndex: number;
	logicalStart: number;
	logicalEnd: number;
	decodeStart: number;
	decodeEnd: number;
};

type PreparedChunkAudio = ChunkDecodePlan & {
	wavBlob: Blob;
};

function buildChunkDecodePlans({
	duration,
	windowSeconds,
}: {
	duration: number;
	windowSeconds: number;
}): ChunkDecodePlan[] {
	const chunkCount = Math.max(
		1,
		Math.ceil(duration / Math.max(1, windowSeconds)),
	);
	const plans: ChunkDecodePlan[] = [];
	for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
		const logicalStart = chunkIndex * windowSeconds;
		const logicalEnd = Math.min(duration, logicalStart + windowSeconds);
		const decodeStart = Math.max(
			0,
			logicalStart -
				(chunkIndex === 0 ? 0 : CHUNKED_TRANSCRIPTION_OVERLAP_SECONDS),
		);
		const decodeEnd = Math.min(
			duration,
			logicalEnd + CHUNKED_TRANSCRIPTION_OVERLAP_SECONDS,
		);
		plans.push({
			chunkIndex,
			logicalStart,
			logicalEnd,
			decodeStart,
			decodeEnd,
		});
	}
	return plans;
}

function mergeToMonoSamples({
	chunks,
}: {
	chunks: AudioBuffer[];
}): { samples: Float32Array; sampleRate: number } | null {
	if (chunks.length === 0) return null;
	const sampleRate = chunks[0].sampleRate;
	const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	if (totalSamples <= 0) return null;

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
}

async function prepareChunkAudioForTranscription({
	asset,
	plans,
	onProgress,
}: {
	asset: MediaAsset;
	plans: ChunkDecodePlan[];
	onProgress?: (progress: TranscriptionProgress) => void;
}): Promise<PreparedChunkAudio[]> {
	const prepared: PreparedChunkAudio[] = [];
	const chunkCount = plans.length;
	const preparationScale = 50;

	const input = new Input({
		source: new BlobSource(asset.file),
		formats: ALL_FORMATS,
	});

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return prepared;
		const sink = new AudioBufferSink(audioTrack);

		for (const plan of plans) {
			const prepBaseProgress =
				(plan.chunkIndex / chunkCount) * preparationScale;
			const prepMaxSoftProgress =
				((plan.chunkIndex + 0.92) / chunkCount) * preparationScale;
			onProgress?.({
				status: "transcribing",
				progress: Math.round(prepBaseProgress),
				message: `Preparing chunk ${plan.chunkIndex + 1}/${chunkCount} audio...`,
			});

			let decodeHeartbeatProgress = prepBaseProgress;
			const decodeHeartbeatId = window.setInterval(() => {
				decodeHeartbeatProgress = Math.min(
					prepMaxSoftProgress,
					decodeHeartbeatProgress + Math.max(0.2, 2 / chunkCount),
				);
				onProgress?.({
					status: "transcribing",
					progress: Math.round(decodeHeartbeatProgress),
					message: `Preparing chunk ${plan.chunkIndex + 1}/${chunkCount} audio...`,
				});
			}, CHUNK_PROGRESS_HEARTBEAT_MS);

			const chunks: AudioBuffer[] = [];
			for await (const { buffer } of sink.buffers(
				plan.decodeStart,
				plan.decodeEnd,
			)) {
				chunks.push(buffer);
			}
			window.clearInterval(decodeHeartbeatId);

			const merged = mergeToMonoSamples({ chunks });
			if (!merged || merged.samples.length === 0) {
				onProgress?.({
					status: "transcribing",
					progress: Math.round(
						((plan.chunkIndex + 1) / chunkCount) * preparationScale,
					),
					message: `Preparing chunk ${plan.chunkIndex + 1}/${chunkCount} audio...`,
				});
				continue;
			}
			const normalizedChunkAudio = resampleMonoSamplesForTranscription({
				samples: merged.samples,
				sampleRate: merged.sampleRate,
			});

			prepared.push({
				...plan,
				wavBlob: encodeMonoPcm16WavBlob({
					samples: normalizedChunkAudio.samples,
					sampleRate: normalizedChunkAudio.sampleRate,
				}),
			});

			onProgress?.({
				status: "transcribing",
				progress: Math.round(
					((plan.chunkIndex + 1) / chunkCount) * preparationScale,
				),
				message: `Preparing chunk ${plan.chunkIndex + 1}/${chunkCount} audio...`,
			});
		}

		return prepared;
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
	const totalStartedAt = nowMs();
	const duration = Math.max(0, asset.duration ?? 0);
	if (!Number.isFinite(duration) || duration <= 0) {
		const decoded = await decodeAudioToFloat32({
			audioBlob: asset.file,
			fallbackUrl: asset.url,
		});
		const result = await transcribeWithClipApi({
			samples: decoded.samples,
			sampleRate: decoded.sampleRate,
			language,
			modelId,
			cacheKey: `${asset.id}:${modelId}:${language}:full`,
		});
		return {
			text: result.text,
			segments: normalizeTranscriptionSegments({ segments: result.segments }),
		};
	}

	const windowSeconds = resolveChunkWindowSeconds({ duration });
	const plans = buildChunkDecodePlans({ duration, windowSeconds });
	const chunkCount = plans.length;
	const mergedSegments: TranscriptionSegment[] = [];
	const mergedTextParts: string[] = [];
	const prepareStartedAt = nowMs();
	const preparedChunks = await prepareChunkAudioForTranscription({
		asset,
		plans,
		onProgress,
	});
	const prepareDurationMs = Math.round(nowMs() - prepareStartedAt);
	const preparedByIndex = new Map(
		preparedChunks.map((chunk) => [chunk.chunkIndex, chunk] as const),
	);
	const adjustedByChunk = new Map<
		number,
		{
			segments: TranscriptionSegment[];
			textPart: string;
		}
	>();
	let nextChunkIndex = 0;
	let completedChunks = 0;
	let activeChunks = 0;
	const transcriptionStartedAt = nowMs();
	const workerCount = Math.min(CHUNK_TRANSCRIPTION_CONCURRENCY, chunkCount);
	onProgress?.({
		status: "transcribing",
		progress: 50,
		message: `Transcribing chunks (0/${chunkCount})...`,
	});
	const transcribeHeartbeatId = window.setInterval(() => {
		const elapsedSeconds = Math.max(
			0,
			(nowMs() - transcriptionStartedAt) / 1000,
		);
		const completedProgress = 50 + (completedChunks / chunkCount) * 50;
		const softProgress = Math.min(
			99,
			completedProgress +
				Math.min(8, elapsedSeconds * Math.max(0.15, 1 / chunkCount)),
		);
		onProgress?.({
			status: "transcribing",
			progress: Math.round(softProgress),
			message: `Transcribing chunks (${completedChunks}/${chunkCount})...`,
		});
	}, CHUNK_PROGRESS_HEARTBEAT_MS);
	try {
		await Promise.all(
			Array.from({ length: workerCount }, async () => {
				while (true) {
					const index = nextChunkIndex;
					nextChunkIndex += 1;
					if (index >= plans.length) {
						return;
					}
					const plan = plans[index];
					if (!plan) {
						return;
					}
					const chunkStartedAt = nowMs();
					activeChunks += 1;
					try {
						const prepared = preparedByIndex.get(plan.chunkIndex);
						const chunkResult =
							!prepared || prepared.wavBlob.size <= 0
								? { text: "", segments: [] }
								: await transcribeWavBlobWithClipApi({
										wavBlob: prepared.wavBlob,
										language,
										modelId,
										cacheKey: `${asset.id}:${modelId}:${language}:chunk:${plan.chunkIndex}:${plan.decodeStart.toFixed(3)}:${plan.decodeEnd.toFixed(3)}`,
									});

						const adjustedSegments = chunkResult.segments
							.map((segment) => ({
								text: segment.text,
								start: segment.start + plan.decodeStart,
								end: segment.end + plan.decodeStart,
							}))
							.filter(
								(segment) =>
									segment.end > plan.logicalStart &&
									segment.start < plan.logicalEnd,
							)
							.map((segment) => ({
								text: segment.text,
								start: clamp(segment.start, plan.logicalStart, plan.logicalEnd),
								end: clamp(segment.end, plan.logicalStart, plan.logicalEnd),
							}))
							.filter((segment) => segment.end > segment.start);

						adjustedByChunk.set(plan.chunkIndex, {
							segments: adjustedSegments,
							textPart: chunkResult.text.trim(),
						});
						completedChunks += 1;
						const progress = 50 + (completedChunks / chunkCount) * 50;
						onProgress?.({
							status: "transcribing",
							progress: Math.round(progress),
							message: `Transcribing chunks (${completedChunks}/${chunkCount})...`,
						});
						const chunkDurationMs = Math.round(nowMs() - chunkStartedAt);
						const chunkAudioSeconds = Math.max(
							0.01,
							plan.decodeEnd - plan.decodeStart,
						);
						console.info("Chunk transcription metrics", {
							assetId: asset.id,
							chunkIndex: plan.chunkIndex,
							chunkCount,
							chunkDurationMs,
							chunkAudioSeconds: Number(chunkAudioSeconds.toFixed(3)),
							realtimeFactor: Number(
								(chunkDurationMs / 1000 / chunkAudioSeconds).toFixed(3),
							),
							wordCount: adjustedSegments.length,
							activeChunks,
						});
					} finally {
						activeChunks = Math.max(0, activeChunks - 1);
					}
				}
			}),
		);
	} finally {
		window.clearInterval(transcribeHeartbeatId);
	}
	const transcriptionDurationMs = Math.round(nowMs() - transcriptionStartedAt);

	for (const plan of plans) {
		const adjusted = adjustedByChunk.get(plan.chunkIndex);
		if (!adjusted) continue;
		mergedSegments.push(...adjusted.segments);
		if (adjusted.textPart.length > 0) {
			mergedTextParts.push(adjusted.textPart);
		}
	}

	const normalizedSegments = normalizeTranscriptionSegments({
		segments: mergedSegments,
	});
	const totalDurationMs = Math.round(nowMs() - totalStartedAt);
	console.info("Chunked transcript pipeline metrics", {
		assetId: asset.id,
		modelId,
		chunkCount,
		chunkConcurrency: workerCount,
		prepareDurationMs,
		transcriptionDurationMs,
		totalDurationMs,
		audioDurationSeconds: Number(duration.toFixed(3)),
		realtimeFactor: Number(
			(totalDurationMs / 1000 / Math.max(0.01, duration)).toFixed(3),
		),
		wordCount: normalizedSegments.length,
	});

	return {
		text:
			normalizedSegments
				.map((segment) => segment.text)
				.join(" ")
				.trim() || mergedTextParts.join(" ").trim(),
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
	const entry =
		project.externalTranscriptCache?.[key] ??
		Object.values(project.externalTranscriptCache ?? {}).find(
			(candidate) =>
				candidate.sourceSystem === mediaLink.sourceSystem &&
				candidate.externalProjectId === mediaLink.externalProjectId,
		);
	if (!entry) return null;
	const suitability = evaluateTranscriptSuitability({
		transcriptText: entry.transcriptText,
		segments: entry.segments,
		audioDurationSeconds: entry.audioDurationSeconds,
	});
	return suitability.isSuitable ? entry : null;
}

function getLinkedProjectTranscriptForMedia({
	project,
	asset,
	modelId,
	language,
}: {
	project: TProject;
	asset: MediaAsset;
	modelId: TranscriptionModelId;
	language: TranscriptionLanguage;
}): { linkKey: string; entry: TMediaTranscriptLinkEntry } | null {
	const linkKey =
		asset.transcriptLinkKey ?? buildProjectMediaTranscriptLinkKey({ asset });
	const entry = project.mediaTranscriptLinks?.[linkKey];
	if (!entry) return null;
	if (entry.modelId !== modelId) return null;
	if ((entry.language ?? "auto") !== (language ?? "auto")) return null;
	return { linkKey, entry };
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
	source:
		| "media-linked"
		| "cache"
		| "global-linked"
		| "project-media-link"
		| "local-backfill";
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

	const linkedProjectTranscript = getLinkedProjectTranscriptForMedia({
		project,
		asset,
		modelId,
		language: resolvedLanguage,
	});
	if (linkedProjectTranscript) {
		const derived = buildClipTranscriptCacheEntryForAsset({
			asset,
			modelId,
			language: resolvedLanguage,
			text: linkedProjectTranscript.entry.text,
			segments: linkedProjectTranscript.entry.segments,
			updatedAt: linkedProjectTranscript.entry.updatedAt,
		});
		return {
			transcript: derived.transcript,
			cacheKey: derived.cacheKey,
			transcriptRef: derived.transcriptRef,
			fromCache: true,
			source: "project-media-link",
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

	const result = await transcribeClipTranscriptLocallyForAsset({
		asset,
		modelId,
		language: resolvedLanguage,
		onProgress,
	});
	const derived = buildClipTranscriptCacheEntryForAsset({
		asset,
		modelId,
		language: resolvedLanguage,
		text: result.text,
		segments: result.segments,
	});
	return {
		transcript: derived.transcript,
		cacheKey: derived.cacheKey,
		transcriptRef: derived.transcriptRef,
		fromCache: false,
		source: "local-backfill",
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
		const nearest = timedWords.reduce(
			(closest, candidate) => {
				const candidateDistance = Math.abs(
					(candidate.start + candidate.end) / 2 - midpoint,
				);
				if (!closest) {
					return { item: candidate, distance: candidateDistance };
				}
				return candidateDistance < closest.distance
					? { item: candidate, distance: candidateDistance }
					: closest;
			},
			null as {
				item: { word: string; start: number; end: number };
				distance: number;
			} | null,
		);
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
				text: overlappingWords
					.map((word) => word.word)
					.join(" ")
					.trim(),
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
