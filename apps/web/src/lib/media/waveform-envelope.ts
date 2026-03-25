import { decodeMediaFileToAudioBuffer } from "@/lib/media/audio";
import {
	deleteWaveformPeaksCacheEntry,
	getResolvedWaveformPeaksCacheEntry,
	getWaveformPeaksCacheEntry,
	setResolvedWaveformPeaksCacheEntry,
	setWaveformPeaksCacheEntry,
	touchWaveformPeaksCacheEntry,
} from "@/lib/media/waveform-cache";

export const WAVEFORM_ENVELOPE_VERSION = 2;
export const DEFAULT_WAVEFORM_BUCKETS_PER_SECOND = 200;

export type WaveformEnvelope = {
	version: typeof WAVEFORM_ENVELOPE_VERSION;
	sourceDurationSeconds: number;
	bucketsPerSecond: number;
	peaks: number[];
};

export function isWaveformEnvelope(value: unknown): value is WaveformEnvelope {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<WaveformEnvelope>;
	return (
		candidate.version === WAVEFORM_ENVELOPE_VERSION &&
		typeof candidate.sourceDurationSeconds === "number" &&
		Number.isFinite(candidate.sourceDurationSeconds) &&
		typeof candidate.bucketsPerSecond === "number" &&
		Number.isFinite(candidate.bucketsPerSecond) &&
		Array.isArray(candidate.peaks)
	);
}

export function createWaveformEnvelope({
	buffer,
	bucketsPerSecond = DEFAULT_WAVEFORM_BUCKETS_PER_SECOND,
}: {
	buffer: AudioBuffer;
	bucketsPerSecond?: number;
}): WaveformEnvelope {
	const safeBucketsPerSecond = Math.max(1, Math.floor(bucketsPerSecond));
	const duration = Math.max(0, buffer.duration);
	if (buffer.numberOfChannels <= 0 || buffer.length <= 0 || duration <= 0) {
		return {
			version: WAVEFORM_ENVELOPE_VERSION,
			sourceDurationSeconds: duration,
			bucketsPerSecond: safeBucketsPerSecond,
			peaks: [],
		};
	}

	const bucketCount = Math.max(1, Math.ceil(duration * safeBucketsPerSecond));
	const samplesPerBucket = buffer.sampleRate / safeBucketsPerSecond;
	const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
		buffer.getChannelData(index),
	);
	const peaks: number[] = [];

	for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
		const startSample = Math.max(
			0,
			Math.min(buffer.length, Math.floor(bucketIndex * samplesPerBucket)),
		);
		const endSample = Math.max(
			startSample + 1,
			Math.min(
				buffer.length,
				Math.ceil((bucketIndex + 1) * samplesPerBucket),
			),
		);
		let min = 1;
		let max = -1;
		let hasValue = false;
		for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex++) {
			for (const channel of channels) {
				const value = channel[sampleIndex] ?? 0;
				if (!hasValue) {
					min = value;
					max = value;
					hasValue = true;
					continue;
				}
				if (value < min) min = value;
				if (value > max) max = value;
			}
		}
		peaks.push(hasValue ? min : 0, hasValue ? max : 0);
	}

	return {
		version: WAVEFORM_ENVELOPE_VERSION,
		sourceDurationSeconds: duration,
		bucketsPerSecond: safeBucketsPerSecond,
		peaks,
	};
}

function clampEnvelopeWindow({
	envelope,
	startTime = 0,
	endTime = envelope.sourceDurationSeconds,
}: {
	envelope: WaveformEnvelope;
	startTime?: number;
	endTime?: number;
}): { startTime: number; endTime: number } {
	const safeStart = Math.max(
		0,
		Math.min(envelope.sourceDurationSeconds, startTime),
	);
	const safeEnd = Math.max(
		safeStart,
		Math.min(envelope.sourceDurationSeconds, endTime),
	);
	return { startTime: safeStart, endTime: safeEnd };
}

function getEnvelopeBucketWindow({
	envelope,
	startTime,
	endTime,
}: {
	envelope: WaveformEnvelope;
	startTime: number;
	endTime: number;
}): { startBucket: number; endBucket: number } {
	if (envelope.peaks.length === 0) {
		return { startBucket: 0, endBucket: 0 };
	}
	const maxBucketCount = Math.max(1, Math.floor(envelope.peaks.length / 2));
	const startBucket = Math.max(
		0,
		Math.min(maxBucketCount - 1, Math.floor(startTime * envelope.bucketsPerSecond)),
	);
	const endBucket = Math.max(
		startBucket + 1,
		Math.min(maxBucketCount, Math.ceil(endTime * envelope.bucketsPerSecond)),
	);
	return { startBucket, endBucket };
}

export function getWaveformMinMaxInRange({
	envelope,
	startTime = 0,
	endTime = envelope.sourceDurationSeconds,
}: {
	envelope: WaveformEnvelope;
	startTime?: number;
	endTime?: number;
}): { min: number; max: number } {
	if (envelope.peaks.length === 0) {
		return { min: 0, max: 0 };
	}
	const window = clampEnvelopeWindow({ envelope, startTime, endTime });
	if (window.endTime <= window.startTime) {
		return { min: 0, max: 0 };
	}
	const { startBucket, endBucket } = getEnvelopeBucketWindow({
		envelope,
		startTime: window.startTime,
		endTime: window.endTime,
	});
	let min = 0;
	let max = 0;
	let hasValue = false;
	for (let bucketIndex = startBucket; bucketIndex < endBucket; bucketIndex++) {
		const peakIndex = bucketIndex * 2;
		const bucketMin = envelope.peaks[peakIndex] ?? 0;
		const bucketMax = envelope.peaks[peakIndex + 1] ?? 0;
		if (!hasValue) {
			min = bucketMin;
			max = bucketMax;
			hasValue = true;
			continue;
		}
		if (bucketMin < min) min = bucketMin;
		if (bucketMax > max) max = bucketMax;
	}
	return hasValue ? { min, max } : { min: 0, max: 0 };
}

export function selectWaveformPeaksForDisplay({
	envelope,
	startTime = 0,
	endTime = envelope.sourceDurationSeconds,
	targetBucketCount,
}: {
	envelope: WaveformEnvelope;
	startTime?: number;
	endTime?: number;
	targetBucketCount?: number;
}): number[] {
	if (envelope.peaks.length === 0) return [];
	const window = clampEnvelopeWindow({ envelope, startTime, endTime });
	if (window.endTime <= window.startTime) return [];
	const { startBucket, endBucket } = getEnvelopeBucketWindow({
		envelope,
		startTime: window.startTime,
		endTime: window.endTime,
	});
	const bucketCount = Math.max(0, endBucket - startBucket);
	if (bucketCount <= 0) return [];
	if (
		typeof targetBucketCount !== "number" ||
		!Number.isFinite(targetBucketCount) ||
		targetBucketCount <= 0 ||
		bucketCount <= targetBucketCount
	) {
		return envelope.peaks.slice(startBucket * 2, endBucket * 2);
	}

	const sampled: number[] = [];
	for (let targetIndex = 0; targetIndex < targetBucketCount; targetIndex++) {
		const rangeStart = Math.floor(
			startBucket + (targetIndex / targetBucketCount) * bucketCount,
		);
		const rangeEnd = Math.max(
			rangeStart + 1,
			Math.ceil(
				startBucket + ((targetIndex + 1) / targetBucketCount) * bucketCount,
			),
		);
		let min = 0;
		let max = 0;
		let hasValue = false;
		for (let bucketIndex = rangeStart; bucketIndex < rangeEnd; bucketIndex++) {
			const peakIndex = bucketIndex * 2;
			const bucketMin = envelope.peaks[peakIndex] ?? 0;
			const bucketMax = envelope.peaks[peakIndex + 1] ?? 0;
			if (!hasValue) {
				min = bucketMin;
				max = bucketMax;
				hasValue = true;
				continue;
			}
			if (bucketMin < min) min = bucketMin;
			if (bucketMax > max) max = bucketMax;
		}
		sampled.push(hasValue ? min : 0, hasValue ? max : 0);
	}
	return sampled;
}

async function decodeAudioUrlToWaveformEnvelope({
	audioUrl,
}: {
	audioUrl: string;
}): Promise<WaveformEnvelope | null> {
	const context = new AudioContext();
	try {
		const response = await fetch(audioUrl);
		if (!response.ok) return null;
		const arrayBuffer = await response.arrayBuffer();
		const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
		return createWaveformEnvelope({ buffer: decoded });
	} catch (error) {
		console.warn("Waveform URL decode failed:", error);
		return null;
	} finally {
		void context.close().catch(() => undefined);
	}
}

export async function resolveWaveformEnvelopeSource({
	audioBuffer,
	audioFile,
	audioUrl,
	cacheKey,
	initialEnvelope,
}: {
	audioBuffer?: AudioBuffer;
	audioFile?: File;
	audioUrl?: string;
	cacheKey?: string;
	initialEnvelope?: WaveformEnvelope | null;
}): Promise<WaveformEnvelope | null> {
	if (initialEnvelope && isWaveformEnvelope(initialEnvelope)) {
		if (cacheKey) {
			setResolvedWaveformPeaksCacheEntry({
				cacheKey,
				value: initialEnvelope,
			});
		}
		return initialEnvelope;
	}

	if (audioBuffer) {
		return createWaveformEnvelope({ buffer: audioBuffer });
	}

	if (!audioFile && !audioUrl) {
		return null;
	}

	const resolvedCacheKey =
		cacheKey ??
		(audioFile
			? `file:${audioFile.name}:${audioFile.size}:${audioFile.lastModified}:${audioFile.type}`
			: audioUrl
				? `url:${audioUrl}`
				: undefined);

	if (resolvedCacheKey) {
		const resolvedEnvelope = getResolvedWaveformPeaksCacheEntry({
			cacheKey: resolvedCacheKey,
		});
		if (resolvedEnvelope) {
			return resolvedEnvelope;
		}
	}

	const cacheTaskKey = resolvedCacheKey ?? crypto.randomUUID();
	let envelopeTask = getWaveformPeaksCacheEntry({ cacheKey: cacheTaskKey });
	if (!envelopeTask) {
		envelopeTask = (async () => {
			if (audioFile) {
				const decodedBuffer = await decodeMediaFileToAudioBuffer({
					file: audioFile,
				});
				if (!decodedBuffer) return null;
				return createWaveformEnvelope({ buffer: decodedBuffer });
			}
			if (audioUrl) {
				return decodeAudioUrlToWaveformEnvelope({ audioUrl });
			}
			return null;
		})();
		setWaveformPeaksCacheEntry({
			cacheKey: cacheTaskKey,
			value: envelopeTask,
		});
	} else {
		touchWaveformPeaksCacheEntry({ cacheKey: cacheTaskKey });
	}

	const envelope = await envelopeTask;
	if (!envelope || envelope.peaks.length === 0) {
		deleteWaveformPeaksCacheEntry({ cacheKey: cacheTaskKey });
		return null;
	}

	if (resolvedCacheKey) {
		setResolvedWaveformPeaksCacheEntry({
			cacheKey: resolvedCacheKey,
			value: envelope,
		});
	}
	return envelope;
}
