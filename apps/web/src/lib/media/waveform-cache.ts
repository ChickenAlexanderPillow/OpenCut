const MAX_CACHED_WAVEFORMS = 256;
const waveformPeaksCache = new Map<string, Promise<number[] | null>>();
const resolvedWaveformPeaksCache = new Map<string, number[]>();

export function clearWaveformPeaksCache(): void {
	waveformPeaksCache.clear();
	resolvedWaveformPeaksCache.clear();
}

export function getWaveformPeaksCacheEntry({
	cacheKey,
}: {
	cacheKey: string;
}): Promise<number[] | null> | undefined {
	return waveformPeaksCache.get(cacheKey);
}

export function touchWaveformPeaksCacheEntry({
	cacheKey,
}: {
	cacheKey: string;
}): void {
	const existing = waveformPeaksCache.get(cacheKey);
	if (!existing) return;
	waveformPeaksCache.delete(cacheKey);
	waveformPeaksCache.set(cacheKey, existing);
}

export function setWaveformPeaksCacheEntry({
	cacheKey,
	value,
}: {
	cacheKey: string;
	value: Promise<number[] | null>;
}): void {
	if (
		!waveformPeaksCache.has(cacheKey) &&
		waveformPeaksCache.size >= MAX_CACHED_WAVEFORMS
	) {
		const oldestKey = waveformPeaksCache.keys().next().value;
		if (typeof oldestKey === "string") {
			waveformPeaksCache.delete(oldestKey);
		}
	}
	waveformPeaksCache.set(cacheKey, value);
}

export function setResolvedWaveformPeaksCacheEntry({
	cacheKey,
	value,
}: {
	cacheKey: string;
	value: number[];
}): void {
	if (
		!resolvedWaveformPeaksCache.has(cacheKey) &&
		resolvedWaveformPeaksCache.size >= MAX_CACHED_WAVEFORMS
	) {
		const oldestKey = resolvedWaveformPeaksCache.keys().next().value;
		if (typeof oldestKey === "string") {
			resolvedWaveformPeaksCache.delete(oldestKey);
		}
	}
	resolvedWaveformPeaksCache.set(cacheKey, value);
}

export function getResolvedWaveformPeaksCacheEntry({
	cacheKey,
}: {
	cacheKey: string;
}): number[] | undefined {
	return resolvedWaveformPeaksCache.get(cacheKey);
}

export function deleteWaveformPeaksCacheEntry({
	cacheKey,
}: {
	cacheKey: string;
}): void {
	waveformPeaksCache.delete(cacheKey);
	resolvedWaveformPeaksCache.delete(cacheKey);
}
