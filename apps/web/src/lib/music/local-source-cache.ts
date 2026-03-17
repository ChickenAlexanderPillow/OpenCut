type CachedLocalSourceFile = {
	file: File;
	lastAccessAt: number;
};

const MAX_CACHED_LOCAL_SOURCE_FILES = 24;
const localSourceFileCache = new Map<string, CachedLocalSourceFile>();
const localSourceFilePromiseCache = new Map<string, Promise<File>>();

function touchCacheEntry({
	sourceUrl,
	entry,
}: {
	sourceUrl: string;
	entry: CachedLocalSourceFile;
}): void {
	entry.lastAccessAt = Date.now();
	localSourceFileCache.delete(sourceUrl);
	localSourceFileCache.set(sourceUrl, entry);
}

function trimLocalSourceCache(): void {
	while (localSourceFileCache.size > MAX_CACHED_LOCAL_SOURCE_FILES) {
		const oldestKey = localSourceFileCache.keys().next().value as
			| string
			| undefined;
		if (!oldestKey) {
			break;
		}
		localSourceFileCache.delete(oldestKey);
	}
}

export async function getOrFetchLocalSourceFile({
	sourceUrl,
	fallbackName,
}: {
	sourceUrl: string;
	fallbackName: string;
}): Promise<File> {
	const cachedEntry = localSourceFileCache.get(sourceUrl);
	if (cachedEntry) {
		touchCacheEntry({
			sourceUrl,
			entry: cachedEntry,
		});
		return cachedEntry.file;
	}

	const existingPromise = localSourceFilePromiseCache.get(sourceUrl);
	if (existingPromise) {
		return await existingPromise;
	}

	const pendingFile = (async () => {
		const response = await fetch(sourceUrl);
		if (!response.ok) {
			throw new Error(`Local source fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const fileNameHeader = response.headers.get("x-file-name");
		const fileName = fileNameHeader
			? decodeURIComponent(fileNameHeader)
			: fallbackName;
		const file = new File([blob], fileName, {
			type: blob.type || "application/octet-stream",
			lastModified: Date.now(),
		});
		localSourceFileCache.set(sourceUrl, {
			file,
			lastAccessAt: Date.now(),
		});
		trimLocalSourceCache();
		return file;
	})().finally(() => {
		localSourceFilePromiseCache.delete(sourceUrl);
	});

	localSourceFilePromiseCache.set(sourceUrl, pendingFile);
	return await pendingFile;
}

export function clearLocalSourceFileCache(): void {
	localSourceFileCache.clear();
	localSourceFilePromiseCache.clear();
}
