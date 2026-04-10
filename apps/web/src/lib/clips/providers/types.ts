import type { ClipCandidateDraft } from "@/types/clip-generation";

export interface ScoreCandidatesParams {
	transcript?: string;
	candidates: ClipCandidateDraft[];
}

export interface ViralityScoringProvider {
	scoreCandidates(params: ScoreCandidatesParams): Promise<string>;
}
