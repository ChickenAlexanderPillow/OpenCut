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
		"Score each candidate for virality potential from 0 to 100.",
		"Prioritize clips that are likely to retain viewers, trigger comments/shares, and stand alone without extra context.",
		"Return strict JSON only in this format:",
		'{"candidates":[{"id":"string","title":"string","rationale":"string","scoreOverall":0,"confidence":0,"failureFlags":["string"],"scoreBreakdown":{"hook":0,"emotion":0,"shareability":0,"clarity":0,"momentum":0}}]}',
		"Rubric:",
		"- hook: first-second attention and curiosity",
		"- emotion: emotional charge and intensity",
		"- shareability: quotable/repost likelihood",
		"- clarity: easy to understand quickly",
		"- momentum: narrative progression and payoff",
		"Hard penalties (apply aggressively):",
		"- Mid-thought starts/ends or abrupt cutoff ending",
		"- Heavy dependence on missing context",
		"- Openings that start with unresolved references (e.g. it/this/that/they without clear antecedent)",
		"- Redundant/repetitive phrasing with weak payoff",
		"- Low information density or long filler stretches",
		"Scoring anchors:",
		"- 85-100: exceptional hook + clear payoff + high quoteability",
		"- 70-84: strong and useful, minor weaknesses",
		"- 60-69: usable but average; limited viral upside",
		"- <60: weak viral potential or quality issues",
		"Set failureFlags from: ['cutoff_start','cutoff_end','context_missing','low_density','repetitive','weak_payoff']. Use [] when none.",
		`Reference examples (style anchors, not exact matches):\n${JSON.stringify(VIRALITY_PROMPT_EXAMPLES)}`,
		"Generalization rule: do not reward candidates for matching specific domains (e.g. B2B/sales/payroll/SEO). Score only on transferable virality patterns: hook strength, clarity, emotional charge, shareability, and payoff.",
		"Do not invent timings or IDs. Use the given candidate IDs.",
		"Prefer distinct moments over semantically duplicate moments.",
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
	const parsed = parseScoredCandidatesFromText({ text: scoredText });
	const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
	const merged: ClipCandidate[] = [];

	for (const scored of parsed.candidates) {
		const draft = draftById.get(scored.id);
		if (!draft) continue;
		const scoreBreakdown = normalizeBreakdown({
			breakdown: scored.scoreBreakdown,
		});
		merged.push({
			id: draft.id,
			startTime: draft.startTime,
			endTime: draft.endTime,
			duration: draft.duration,
			transcriptSnippet: draft.transcriptSnippet,
			title: scored.title.trim(),
			rationale: scored.rationale.trim(),
			scoreOverall: clampScore(scored.scoreOverall),
			scoreBreakdown,
		});
	}

	return merged.sort((a, b) => {
		if (b.scoreOverall !== a.scoreOverall) {
			return b.scoreOverall - a.scoreOverall;
		}
		if (b.scoreBreakdown.hook !== a.scoreBreakdown.hook) {
			return b.scoreBreakdown.hook - a.scoreBreakdown.hook;
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
}: {
	candidates: ClipCandidate[];
	minScore?: number;
	maxOverlapRatio?: number;
	maxCount?: number;
}): ClipCandidate[] {
	const selected: ClipCandidate[] = [];
	for (const candidate of candidates) {
		if (candidate.scoreOverall < minScore) continue;
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
