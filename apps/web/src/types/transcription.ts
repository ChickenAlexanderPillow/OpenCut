import type { LanguageCode } from "./language";

export type TranscriptionLanguage = LanguageCode | "auto";

export interface TranscriptionSegment {
	text: string;
	start: number;
	end: number;
}

export interface TranscriptEditWord {
	id: string;
	text: string;
	startTime: number;
	endTime: number;
	removed?: boolean;
	hidden?: boolean;
	segmentId?: string;
}

export interface TranscriptEditCutRange {
	start: number;
	end: number;
	reason: "manual" | "filler" | "pause";
}

export type TranscriptCutTimeDomain = "clip-local-source" | "source-absolute";

export interface TranscriptSegmentUi {
	id: string;
	wordStartIndex: number;
	wordEndIndex: number;
	label?: string;
}

export interface TranscriptProjectionSource {
	words: TranscriptEditWord[];
	cuts: TranscriptEditCutRange[];
	updatedAt: string;
	baseTrimStart: number;
}

export interface TranscriptDraftState {
	version: 1;
	source: "word-level";
	words: TranscriptEditWord[];
	cuts: TranscriptEditCutRange[];
	cutTimeDomain?: TranscriptCutTimeDomain;
	projectionSource?: TranscriptProjectionSource;
	segmentsUi?: TranscriptSegmentUi[];
	updatedAt: string;
}

export interface CompiledCaptionWordTiming {
	word: string;
	startTime: number;
	endTime: number;
	hidden?: boolean;
}

export interface CompiledCaptionPayload {
	content: string;
	startTime: number;
	duration: number;
	wordTimings: CompiledCaptionWordTiming[];
}

export interface TranscriptAppliedSegment {
	start: number;
	end: number;
	duration: number;
}

export interface TranscriptAppliedTimeMap {
	cutBoundaries: number[];
	sourceDuration: number;
	playableDuration: number;
}

export interface TranscriptAppliedState {
	version: 1;
	revisionKey: string;
	updatedAt: string;
	removedRanges: TranscriptEditCutRange[];
	keptSegments: TranscriptAppliedSegment[];
	timeMap: TranscriptAppliedTimeMap;
	captionPayload: CompiledCaptionPayload | null;
}

export type TranscriptCompileState =
	| { status: "idle"; updatedAt?: string }
	| { status: "compiling"; updatedAt: string }
	| { status: "failed"; updatedAt: string; error: string };

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	language: string;
}

export type TranscriptionStatus =
	| "idle"
	| "loading-model"
	| "transcribing"
	| "complete"
	| "error";

export interface TranscriptionProgress {
	status: TranscriptionStatus;
	progress: number;
	message?: string;
}

export type TranscriptionModelId =
	| "whisper-tiny"
	| "whisper-small"
	| "whisper-medium"
	| "whisper-large-v3-turbo";

export interface TranscriptionModel {
	id: TranscriptionModelId;
	name: string;
	huggingFaceId: string;
	description: string;
}

export interface CaptionChunk {
	text: string;
	startTime: number;
	duration: number;
	wordTimings: Array<{
		word: string;
		startTime: number;
		endTime: number;
		hidden?: boolean;
	}>;
}
