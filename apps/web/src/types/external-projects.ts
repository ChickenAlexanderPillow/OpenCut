import type { TranscriptionSegment } from "@/types/transcription";

export type ExternalSourceSystem = "thumbnail_decoupled";

export interface ExternalProjectLink {
	sourceSystem: ExternalSourceSystem;
	externalProjectId: string;
	opencutProjectId?: string;
	relativeKey?: string;
	linkedAt: string;
}

export interface ExternalProjectTranscriptCacheEntry {
	sourceSystem: ExternalSourceSystem;
	externalProjectId: string;
	transcriptText: string;
	segments: TranscriptionSegment[];
	segmentsCount: number;
	audioDurationSeconds: number | null;
	qualityMeta?: Record<string, unknown>;
	updatedAt: string;
}
