import type { TranscriptionSegment } from "@/types/transcription";

export type ViralityFactor =
	| "hook"
	| "emotion"
	| "shareability"
	| "clarity"
	| "momentum";

export interface ViralityBreakdown {
	hook: number;
	emotion: number;
	shareability: number;
	clarity: number;
	momentum: number;
}

export interface ClipQaDiagnostics {
	startsClean: boolean;
	endsClean: boolean;
	hasTailQuestionSetup: boolean;
	hasConsequenceChain: boolean;
	hasStrongStance: boolean;
	repetitionRisk: "low" | "medium" | "high";
	infoDensity: "low" | "medium" | "high";
}

export interface ClipUserFeedback {
	rating: -1 | 0 | 1;
	comment?: string;
	updatedAt: string;
}

export interface ClipCandidateDraft {
	id: string;
	startTime: number;
	endTime: number;
	duration: number;
	transcriptSnippet: string;
	localScore: number;
}

export interface ClipCandidate {
	id: string;
	startTime: number;
	endTime: number;
	duration: number;
	title: string;
	rationale: string;
	transcriptSnippet: string;
	scoreOverall: number;
	scoreBreakdown: ViralityBreakdown;
	failureFlags?: string[];
	userRating?: -1 | 0 | 1;
	userComment?: string;
	qaDiagnostics?: ClipQaDiagnostics;
	userFeedback?: ClipUserFeedback;
}

export interface ClipTranscriptRef {
	cacheKey: string;
	modelId: string;
	language: string;
	updatedAt: string;
}

export type ClipGenerationStatus =
	| "idle"
	| "extracting"
	| "transcribing"
	| "scoring"
	| "ready"
	| "error";

export interface ClipGenerationSession {
	sourceMediaId: string | null;
	status: ClipGenerationStatus;
	progress: number | null;
	progressMessage: string | null;
	error: string | null;
	candidates: ClipCandidate[];
	selectedCandidateIds: string[];
	transcriptRef: ClipTranscriptRef | null;
}

export interface ClipGenerationProjectCacheEntry {
	sourceMediaId: string;
	candidates: ClipCandidate[];
	transcriptRef: ClipTranscriptRef | null;
	error: string | null;
	updatedAt: string;
}

export interface ClipTranscriptCacheEntry {
	cacheVersion?: number;
	mediaId: string;
	fingerprint: string;
	language: string;
	modelId: string;
	text: string;
	segments: TranscriptionSegment[];
	updatedAt: string;
}
