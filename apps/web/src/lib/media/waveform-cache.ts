const MAX_CACHED_WAVEFORMS = 64;
const waveformPeaksCache = new Map<string, Promise<number[] | null>>();

export function clearWaveformPeaksCache(): void {
	waveformPeaksCache.clear();
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

export function deleteWaveformPeaksCacheEntry({
	cacheKey,
}: {
	cacheKey: string;
}): void {
	waveformPeaksCache.delete(cacheKey);
}
