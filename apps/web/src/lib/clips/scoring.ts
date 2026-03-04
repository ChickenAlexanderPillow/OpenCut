import { z } from "zod";
import { VIRALITY_PROMPT_EXAMPLES } from "@/lib/clips/virality-examples";
import type {
	ClipCandidate,
	ClipCandidateDraft,
	ViralityBreakdown,
} from "@/types/clip-generation";

const scoredCandidateSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	rationale: z.string().min(1),
	scoreOverall: z.number(),
	confidence: z.number().optional(),
	failureFlags: z.array(z.string()).optional(),
	scoreBreakdown: z.object({
		hook: z.number(),
		emotion: z.number(),
		shareability: z.number(),
		clarity: z.number(),
		momentum: z.number(),
	}),
});

const scoredCandidatesResponseSchema = z.object({
	candidates: z.array(scoredCandidateSchema),
});

function clampScore(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

const FAILURE_FLAG_PENALTY_BY_FLAG: Record<string, number> = {
	cutoff_start: 12,
	cutoff_end: 12,
	context_missing: 14,
	low_density: 10,
	repetitive: 8,
	weak_payoff: 10,
	duration_mismatch: 10,
};

function startsWithContextDependentPronoun(text: string): boolean {
	const cleaned = text.trim().replace(/^[("'[\]]+/, "");
	const openingWord = cleaned.split(/\s+/)[0]?.toLowerCase() ?? "";
	return [
		"it",
		"this",
		"that",
		"these",
		"those",
		"they",
		"them",
		"he",
		"she",
		"there",
		"here",
	].includes(openingWord);
}

function startsLikelyMidSentence(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const firstChar = trimmed[0] ?? "";
	if (/[a-z]/.test(firstChar)) return true;
	const openingWord = trimmed
		.replace(/^[("'[\]]+/, "")
		.split(/\s+/)[0]
		?.toLowerCase();
	return [
		"and",
		"but",
		"so",
		"then",
		"because",
		"which",
		"or",
		"if",
	].includes(openingWord ?? "");
}

function endsAbruptly(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (/[.!?]["')\]]*$/.test(trimmed)) return false;
	return /(\b(and|but|so|then|because|which|that)\s*)$/i.test(trimmed) || trimmed.endsWith(",");
}

function computeDeterministicPenalty({
	draft,
	failureFlags,
}: {
	draft: ClipCandidateDraft;
	failureFlags?: string[];
}): number {
	let penalty = 0;

	for (const flag of failureFlags ?? []) {
		penalty += FAILURE_FLAG_PENALTY_BY_FLAG[flag] ?? 0;
	}

	if (draft.duration > 75) {
		penalty += Math.min(30, Math.round((draft.duration - 75) * 0.6));
	} else if (draft.duration > 65) {
		penalty += Math.min(12, Math.round((draft.duration - 65) * 1.2));
	}
	if (draft.duration < 15) {
		penalty += Math.min(10, Math.round((15 - draft.duration) * 1.5));
	}

	return Math.max(0, penalty);
}

function computeLocalBoundaryPenalty({
	draft,
}: {
	draft: ClipCandidateDraft;
}): number {
	let penalty = 0;
	if (startsWithContextDependentPronoun(draft.transcriptSnippet)) {
		penalty += 3;
	}
	if (startsLikelyMidSentence(draft.transcriptSnippet)) {
		penalty += 6;
	}
	if (endsAbruptly(draft.transcriptSnippet)) {
		penalty += 5;
	}
	return Math.max(0, penalty);
}

function normalizeBreakdown({
	breakdown,
}: {
	breakdown: ViralityBreakdown;
}): ViralityBreakdown {
	return {
		hook: clampScore(breakdown.hook),
		emotion: clampScore(breakdown.emotion),
		shareability: clampScore(breakdown.shareability),
		clarity: clampScore(breakdown.clarity),
		momentum: clampScore(breakdown.momentum),
	};
}

export function extractJsonPayload({ text }: { text: string }): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		// Fall through to fenced/block extraction.
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		const possibleJson = trimmed.slice(firstBrace, lastBrace + 1);
		return JSON.parse(possibleJson);
	}

	throw new Error("Scoring response did not contain valid JSON");
}

export function parseScoredCandidatesFromText({
	text,
}: {
	text: string;
}): z.infer<typeof scoredCandidatesResponseSchema> {
	const payload = extractJsonPayload({ text });
	return scoredCandidatesResponseSchema.parse(payload);
}

export function buildScoringPrompt({
	transcript,
	candidates,
}: {
	transcript: string;
	candidates: ClipCandidateDraft[];
}): string {
	return [
		"You are a social video clipping analyst.",
		"Score each candidate for short-form virality potential from 0 to 100.",
		"Prioritize clips likely to maximize completion rate, rewatches, comments, and shares while still being understandable as standalone moments.",
		"Return strict JSON only in this format:",
		'{"candidates":[{"id":"string","title":"string","rationale":"string","scoreOverall":0,"confidence":0,"failureFlags":["string"],"scoreBreakdown":{"hook":0,"emotion":0,"shareability":0,"clarity":0,"momentum":0}}]}',
		"Output contract:",
		"- Return every input candidate exactly once",
		"- Keep each title <= 9 words, concrete, and curiosity-forward",
		"- Keep rationale <= 220 chars and mention both hook and payoff quality",
		"- Prefer titles that imply stakes, conflict, or surprise (not generic summaries)",
		"Rubric:",
		"- hook: first-second attention and curiosity",
		"- emotion: emotional charge and intensity",
		"- shareability: quotable/repost likelihood",
		"- clarity: easy to understand quickly",
		"- momentum: narrative progression and payoff",
		"Interestingness guidance (reward heavily):",
		"- Contrarian or surprising claims",
		"- Clear stakes, tension, disagreement, or risk",
		"- Concrete examples, numbers, named entities, vivid specifics",
		"- Strong before/after or cause/effect payoff",
		"- Compact thesis followed by explicit downstream consequences",
		"- Strong speaker POV/conviction when paired with evidence or concrete impacts",
		"Interestingness guidance (penalize):",
		"- Generic recap language (e.g., broad year-in-review summaries)",
		"- Safe but bland statements with low novelty",
		"- Clips that are only informative but not emotionally or socially compelling",
		"Hard penalties (apply aggressively):",
		"- Mid-thought starts/ends or abrupt cutoff ending",
		"- Long interviewer question setup with only a tiny answer tail",
		"- Tail sections that pivot into a new host setup/topic without resolving it",
		"- Heavy dependence on missing context",
		"- Openings that start with unresolved references (e.g. it/this/that/they without clear antecedent)",
		"- Redundant/repetitive phrasing with weak payoff",
		"- Low information density or long filler stretches",
		"- Duration mismatch for short-form use (ideal 20-60s, penalize >75s)",
		"Scoring anchors:",
		"- 85-100: exceptional hook + clear payoff + high quoteability",
		"- 70-84: strong and useful, minor weaknesses",
		"- 60-69: usable but average; limited viral upside or low novelty",
		"- <60: weak viral potential or quality issues",
		"Set failureFlags from: ['cutoff_start','cutoff_end','context_missing','low_density','repetitive','weak_payoff','duration_mismatch']. Use [] when none.",
		`Reference examples (style anchors, not exact matches):\n${JSON.stringify(VIRALITY_PROMPT_EXAMPLES)}`,
		"Generalization rule: do not reward candidates for matching specific domains (e.g. B2B/sales/payroll/SEO). Score only on transferable virality patterns: hook strength, clarity, emotional charge, shareability, and payoff.",
		"Do not invent timings or IDs. Use the given candidate IDs.",
		"Prefer distinct moments over semantically duplicate moments.",
		"If two candidates are similar quality, choose the one with higher novelty and stronger social-comment potential.",
		`Transcript:\n${transcript}`,
		`Candidates:\n${JSON.stringify(
			candidates.map((candidate) => ({
				id: candidate.id,
				startTime: candidate.startTime,
				endTime: candidate.endTime,
				duration: candidate.duration,
				transcriptSnippet: candidate.transcriptSnippet,
			})),
		)}`,
	].join("\n");
}

export function mergeScoredCandidates({
	drafts,
	scoredText,
}: {
	drafts: ClipCandidateDraft[];
	scoredText: string;
}): ClipCandidate[] {
	const parsed = (() => {
		try {
			return parseScoredCandidatesFromText({ text: scoredText });
		} catch {
			return {
				candidates: drafts.map((draft) => ({
					id: draft.id,
					title: draft.transcriptSnippet
						.split(/\s+/)
						.slice(0, 6)
						.join(" ")
						.trim() || "Clip candidate",
					rationale:
						"LLM scoring parse failed; used deterministic local ranking fallback.",
					scoreOverall: clampScore(draft.localScore),
					scoreBreakdown: {
						hook: clampScore(draft.localScore),
						emotion: clampScore(draft.localScore * 0.8),
						shareability: clampScore(draft.localScore * 0.85),
						clarity: clampScore(draft.localScore * 0.9),
						momentum: clampScore(draft.localScore * 0.85),
					},
				})),
			};
		}
	})();
	const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
	const merged: ClipCandidate[] = [];

	for (const scored of parsed.candidates) {
		const draft = draftById.get(scored.id);
		if (!draft) continue;
		const scoreBreakdown = normalizeBreakdown({
			breakdown: scored.scoreBreakdown,
		});
		const localSignalScore = clampScore(draft.localScore);
		const llmScore = clampScore(scored.scoreOverall);
		const localPriorAdjustment = Math.max(
			-3,
			Math.min(3, Math.round((localSignalScore - 50) * 0.06)),
		);
		const failureFlags = scored.failureFlags ?? [];
		const llmFailurePenalty = computeDeterministicPenalty({
			draft,
			failureFlags,
		});
		const localBoundaryPenalty = computeLocalBoundaryPenalty({
			draft,
		});
		// LLM score is the primary ranking signal; heuristics are light priors only.
		const finalScore = clampScore(
			llmScore + localPriorAdjustment - llmFailurePenalty - localBoundaryPenalty,
		);
		merged.push({
			id: draft.id,
			startTime: draft.startTime,
			endTime: draft.endTime,
			duration: draft.duration,
			transcriptSnippet: draft.transcriptSnippet,
			title: scored.title.trim(),
			rationale: scored.rationale.trim(),
			scoreOverall: finalScore,
			scoreBreakdown,
			failureFlags,
		});
	}

	return merged.sort((a, b) => {
		if (b.scoreOverall !== a.scoreOverall) {
			return b.scoreOverall - a.scoreOverall;
		}
		return a.startTime - b.startTime;
	});
}

function overlapRatio({
	a,
	b,
}: {
	a: ClipCandidate;
	b: ClipCandidate;
}): number {
	const intersection = Math.max(
		0,
		Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime),
	);
	const union =
		Math.max(a.endTime, b.endTime) - Math.min(a.startTime, b.startTime);
	if (union <= 0) return 0;
	return intersection / union;
}

function hasTemporalOverlap({
	a,
	b,
	epsilon = 1e-6,
}: {
	a: ClipCandidate;
	b: ClipCandidate;
	epsilon?: number;
}): boolean {
	const intersection =
		Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime);
	return intersection > epsilon;
}

export function selectTopCandidatesWithQualityGate({
	candidates,
	minScore = 60,
	maxOverlapRatio = 0,
	maxCount = 5,
	excludeFailureFlags = ["cutoff_start", "cutoff_end"],
}: {
	candidates: ClipCandidate[];
	minScore?: number;
	maxOverlapRatio?: number;
	maxCount?: number;
	excludeFailureFlags?: string[];
}): ClipCandidate[] {
	const selected: ClipCandidate[] = [];
	for (const candidate of candidates) {
		if (candidate.scoreOverall < minScore) continue;
		const candidateFailureFlags = candidate.failureFlags ?? [];
		if (
			excludeFailureFlags.length > 0 &&
			candidateFailureFlags.some((flag) => excludeFailureFlags.includes(flag))
		) {
			continue;
		}
		const overlaps = selected.some((existing) => {
			if (!hasTemporalOverlap({ a: candidate, b: existing })) return false;
			return overlapRatio({ a: candidate, b: existing }) > maxOverlapRatio;
		});
		if (!overlaps) {
			selected.push(candidate);
		}
		if (selected.length >= maxCount) {
			break;
		}
	}
	return selected;
}

export const scoredCandidatesResponseZodSchema = scoredCandidatesResponseSchema;
