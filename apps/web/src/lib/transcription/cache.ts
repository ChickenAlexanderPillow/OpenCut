import { DEFAULT_TRANSCRIPTION_MODEL, TRANSCRIPT_CACHE_VERSION } from "@/constants/transcription-constants";
import type { MediaAsset } from "@/types/assets";
import type { TProject, TTranscriptionCacheEntry } from "@/types/project";
import type { TimelineTrack } from "@/types/timeline";

export function getTranscriptionCacheKey({
	modelId = DEFAULT_TRANSCRIPTION_MODEL,
	language,
}: {
	modelId?: string;
	language: string;
}): string {
	return `${modelId}:${language}`;
}

export function buildTranscriptionFingerprint({
	tracks,
	mediaAssets,
	modelId = DEFAULT_TRANSCRIPTION_MODEL,
	language,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	modelId?: string;
	language: string;
}): string {
	const mediaIndex = new Map(mediaAssets.map((media) => [media.id, media]));
	const audioSignature = tracks.flatMap((track) =>
		track.elements
			.filter((element) => element.type === "audio" || element.type === "video")
			.map((element) => {
				const mediaId = "mediaId" in element ? element.mediaId : "";
				const media = mediaId ? mediaIndex.get(mediaId) : null;
				return {
					type: element.type,
					mediaId,
					startTime: element.startTime,
					duration: element.duration,
					trimStart: element.trimStart,
					trimEnd: element.trimEnd,
					muted: "muted" in element ? (element.muted ?? false) : false,
					fileSize: media?.file.size ?? 0,
					lastModified: media?.file.lastModified ?? 0,
				};
			}),
	);

	return JSON.stringify({
		cacheVersion: TRANSCRIPT_CACHE_VERSION,
		modelId,
		language,
		audioSignature,
	});
}

export function findLatestValidTranscriptionCacheEntry({
	project,
	tracks,
	mediaAssets,
}: {
	project: TProject;
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
}): TTranscriptionCacheEntry | null {
	const entries = Object.values(project.transcriptionCache ?? {});
	if (entries.length === 0) return null;

	let latest: TTranscriptionCacheEntry | null = null;
	for (const entry of entries) {
		if ((entry.cacheVersion ?? 1) !== TRANSCRIPT_CACHE_VERSION) continue;
		const expectedFingerprint = buildTranscriptionFingerprint({
			tracks,
			mediaAssets,
			modelId: entry.modelId || DEFAULT_TRANSCRIPTION_MODEL,
			language: entry.language,
		});
		if (entry.fingerprint !== expectedFingerprint) continue;

		if (!latest) {
			latest = entry;
			continue;
		}
		if (new Date(entry.updatedAt).getTime() > new Date(latest.updatedAt).getTime()) {
			latest = entry;
		}
	}

	return latest;
}

export function findLatestTranscriptionCacheEntry({
	project,
}: {
	project: TProject;
}): TTranscriptionCacheEntry | null {
	const entries = Object.values(project.transcriptionCache ?? {});
	if (entries.length === 0) return null;

	let latest = entries[0] ?? null;
	for (const entry of entries.slice(1)) {
		if (!latest) {
			latest = entry;
			continue;
		}
		if (new Date(entry.updatedAt).getTime() > new Date(latest.updatedAt).getTime()) {
			latest = entry;
		}
	}
	return latest;
}
