export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm", "mkv", "mov"] as const;
export const EXPORT_CONTENT_VALUES = [
	"full",
	"captions_only_transparent",
] as const;
export const EXPORT_ASPECT_VALUES = ["project", "square"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];
export type ExportContent = (typeof EXPORT_CONTENT_VALUES)[number];
export type ExportAspect = (typeof EXPORT_ASPECT_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	content: ExportContent;
	aspect: ExportAspect;
	fps?: number;
	includeAudio?: boolean;
	startTime?: number;
	endTime?: number;
	onProgress?: ({ progress }: { progress: number }) => void;
	onCancel?: () => boolean;
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	error?: string;
	cancelled?: boolean;
}
