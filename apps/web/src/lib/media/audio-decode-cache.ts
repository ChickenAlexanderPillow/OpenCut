import type { MediaAsset } from "@/types/assets";

export type DecodeMode = "full" | "windowed";

export interface DecodeCacheKeyParts {
	mediaId: string;
	mediaType: MediaAsset["type"] | "library-audio";
	fileSize: number;
	lastModified: number;
	sampleRate: number;
	channels: number;
	decodeMode: DecodeMode;
	trimStart: number;
	duration: number;
	transcriptRevision: string;
	sourceUrl?: string;
}

type CacheEntry = {
	key: string;
	promise: Promise<AudioBuffer | null>;
	bytes: number;
	lastAccessAt: number;
	mediaId: string;
};

const DEFAULT_MAX_CACHE_BYTES = 160 * 1024 * 1024;
let maxCacheBytes = DEFAULT_MAX_CACHE_BYTES;
const cache = new Map<string, CacheEntry>();

function estimateAudioBufferBytes(buffer: AudioBuffer | null): number {
	if (!buffer) return 0;
	return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

function touchEntry(entry: CacheEntry): void {
	entry.lastAccessAt = Date.now();
	cache.delete(entry.key);
	cache.set(entry.key, entry);
}

function getTotalBytes(): number {
	let total = 0;
	for (const entry of cache.values()) {
		total += entry.bytes;
	}
	return total;
}

export function setAudioDecodeCacheBudget({
	maxBytes,
}: {
	maxBytes: number;
}): void {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
	maxCacheBytes = Math.max(8 * 1024 * 1024, Math.floor(maxBytes));
}

export function buildDecodeCacheKey(parts: DecodeCacheKeyParts): string {
	const sourcePart = parts.sourceUrl ? `:${parts.sourceUrl}` : "";
	return [
		parts.mediaId,
		parts.mediaType,
		parts.fileSize,
		parts.lastModified,
		parts.sampleRate,
		parts.channels,
		parts.decodeMode,
		parts.trimStart.toFixed(4),
		parts.duration.toFixed(4),
		parts.transcriptRevision,
		sourcePart,
	].join("|");
}

export async function getOrDecodeClipWindow({
	keyParts,
	decode,
}: {
	keyParts: DecodeCacheKeyParts;
	decode: () => Promise<AudioBuffer | null>;
}): Promise<{ buffer: AudioBuffer | null; cacheHit: boolean; key: string }> {
	const key = buildDecodeCacheKey(keyParts);
	const existing = cache.get(key);
	if (existing) {
		touchEntry(existing);
		return {
			buffer: await existing.promise,
			cacheHit: true,
			key,
		};
	}

	const entry: CacheEntry = {
		key,
		mediaId: keyParts.mediaId,
		bytes: 0,
		lastAccessAt: Date.now(),
		promise: decode().then((buffer) => {
			entry.bytes = estimateAudioBufferBytes(buffer);
			trimToBudget({ maxBytes: maxCacheBytes });
			return buffer;
		}),
	};
	cache.set(key, entry);

	return {
		buffer: await entry.promise,
		cacheHit: false,
		key,
	};
}

export function invalidateByMediaId({ mediaId }: { mediaId: string }): void {
	for (const [key, entry] of cache.entries()) {
		if (entry.mediaId !== mediaId) continue;
		cache.delete(key);
	}
}

export function clearAudioDecodeCache(): void {
	cache.clear();
}

export function trimToBudget({ maxBytes }: { maxBytes: number }): void {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
	let total = getTotalBytes();
	if (total <= maxBytes) return;

	for (const [key, entry] of cache.entries()) {
		cache.delete(key);
		total -= entry.bytes;
		if (total <= maxBytes) break;
	}
}

export function getAudioDecodeCacheStats(): {
	entries: number;
	bytes: number;
	maxBytes: number;
} {
	return {
		entries: cache.size,
		bytes: getTotalBytes(),
		maxBytes: maxCacheBytes,
	};
}
