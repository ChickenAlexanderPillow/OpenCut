import type { TScene } from "./timeline";
import type { TranscriptionSegment } from "./transcription";
import type {
	ClipGenerationProjectCacheEntry,
	ClipTranscriptCacheEntry,
} from "./clip-generation";
import type {
	ExternalProjectLink,
	ExternalProjectTranscriptCacheEntry,
} from "./external-projects";

export type TBackground =
	| {
			type: "color";
			color: string;
	  }
	| {
			type: "blur";
			blurIntensity: number;
			blurScale?: number;
	  };

export interface TCanvasSize {
	width: number;
	height: number;
}

export interface TProjectMetadata {
	id: string;
	name: string;
	thumbnail?: string;
	duration: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface TProjectSettings {
	fps: number;
	canvasSize: TCanvasSize;
	originalCanvasSize?: TCanvasSize | null;
	background: TBackground;
}

export interface TTimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: number;
}

export type TBrandLogoOverlayPreset =
	| "top-right"
	| "top-center"
	| "bottom-left"
	| "bottom-center"
	| "top-right-compact"
	| "bottom-right"
	| "top-left";

export interface TBrandLogoOverlayConfig {
	enabled: boolean;
	preset: TBrandLogoOverlayPreset;
	scale?: number;
	sourceUrl: string | null;
	sourceName?: string | null;
	sourceWidth?: number | null;
	sourceHeight?: number | null;
}

export interface TBrandPreset {
	id: string;
	name: string;
	builtIn?: boolean;
	logo: TBrandLogoOverlayConfig;
	createdAt: string;
	updatedAt: string;
}

export interface TBrandOverlays {
	selectedBrandId: string | null;
	logo: TBrandLogoOverlayConfig;
}

export interface TProject {
	metadata: TProjectMetadata;
	scenes: TScene[];
	currentSceneId: string;
	settings: TProjectSettings;
	brandOverlays?: TBrandOverlays;
	version: number;
	timelineViewState?: TTimelineViewState;
	transcriptionCache?: Record<string, TTranscriptionCacheEntry>;
	clipTranscriptCache?: Record<string, ClipTranscriptCacheEntry>;
	mediaTranscriptLinks?: Record<string, TMediaTranscriptLinkEntry>;
	clipWordTranscriptionCache?: Record<string, TClipWordTranscriptionCacheEntry>;
	clipGenerationCache?: Record<string, ClipGenerationProjectCacheEntry>;
	externalProjectLink?: ExternalProjectLink;
	externalMediaLinks?: Record<string, ExternalProjectLink>;
	externalTranscriptCache?: Record<string, ExternalProjectTranscriptCacheEntry>;
	waveformPeaksCache?: Record<string, TWaveformPeaksCacheEntry>;
}

export interface TMediaTranscriptLinkEntry {
	modelId: string;
	language: string;
	text: string;
	segments: TranscriptionSegment[];
	updatedAt: string;
}

export interface TWaveformPeaksCacheEntry {
	peaks: number[];
	updatedAt: string;
}

export interface TClipWordTranscriptionCacheEntry {
	modelId: string;
	mediaId: string;
	startTime: number;
	endTime: number;
	segments: TranscriptionSegment[];
	updatedAt: string;
}

export interface TTranscriptionCacheEntry {
	cacheVersion?: number;
	fingerprint: string;
	language: string;
	modelId: string;
	text: string;
	segments: TranscriptionSegment[];
	updatedAt: string;
}

export type TProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type TSortOrder = "asc" | "desc";
export type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
