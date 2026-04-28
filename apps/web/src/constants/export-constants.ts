import type { ExportOptions } from "@/types/export";

export const DEFAULT_EXPORT_OPTIONS = {
	format: "mp4",
	quality: "high",
	content: "full",
	aspect: "project",
	includeAudio: true,
} satisfies ExportOptions;

export const EXPORT_MIME_TYPES = {
	webm: "video/webm",
	mkv: "video/x-matroska",
	mp4: "video/mp4",
	mov: "video/quicktime",
} as const;
