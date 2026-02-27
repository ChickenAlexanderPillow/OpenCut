import type { MediaAsset, MediaType } from "@/types/assets";

export const SUPPORTS_AUDIO: readonly MediaType[] = ["audio", "video"];

export function mediaSupportsAudio({
	media,
}: {
	media: MediaAsset | null | undefined;
}): boolean {
	if (!media) return false;
	return SUPPORTS_AUDIO.includes(media.type);
}

export const getMediaTypeFromFile = ({
	file,
}: {
	file: File;
}): MediaType | null => {
	const { type } = file;

	if (type.startsWith("image/")) {
		return "image";
	}
	if (type.startsWith("video/")) {
		return "video";
	}
	if (type.startsWith("audio/")) {
		return "audio";
	}

	// Some files (especially from network shares) come in with an empty MIME type.
	// Fall back to extension-based detection so ingest still works.
	const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
	const imageExtensions = new Set([
		"jpg",
		"jpeg",
		"png",
		"webp",
		"gif",
		"bmp",
		"tiff",
		"tif",
		"svg",
		"heic",
		"heif",
	]);
	const videoExtensions = new Set([
		"mp4",
		"mov",
		"m4v",
		"webm",
		"mkv",
		"avi",
		"wmv",
		"mpg",
		"mpeg",
		"mts",
		"m2ts",
		"3gp",
	]);
	const audioExtensions = new Set([
		"mp3",
		"wav",
		"m4a",
		"aac",
		"ogg",
		"flac",
		"opus",
		"wma",
	]);

	if (imageExtensions.has(extension)) return "image";
	if (videoExtensions.has(extension)) return "video";
	if (audioExtensions.has(extension)) return "audio";

	return null;
};
