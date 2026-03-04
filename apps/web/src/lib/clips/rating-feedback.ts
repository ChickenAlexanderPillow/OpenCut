import type { ClipCandidate, ViralityFactor } from "@/types/clip-generation";

const FACTOR_KEYS: ViralityFactor[] = [
	"hook",
	"emotion",
	"shareability",
	"clarity",
	"momentum",
];

const MAX_EXPLICIT_RATING_BOOST = 10;
const MAX_FACTOR_MODEL_BOOST = 12;
const MAX_TEMPORAL_MODEL_BOOST = 18;

type RatedWindow = {
	startTime: number;
	endTime: number;
	rating: -1 | 1;
};

export type ClipRatingFeedbackModel = {
	ratedCount: number;
	confidence: number;
	factorPreference: Record<ViralityFactor, number>;
	ratedWindows: RatedWindow[];
	positiveTerms: string[];
	negativeTerms: string[];
};

function clampScore(score: number): number {
	return Math.max(0, Math.min(100, Math.round(score)));
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function overlapRatio({
	aStart,
	aEnd,
	bStart,
	bEnd,
}: {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
}): number {
	const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
	const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
	if (union <= 0) return 0;
	return intersection / union;
}

function tokenizeFeedbackTerms(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s']/g, " ")
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 4);
}

function extractTermPreferences({
	candidates,
}: {
	candidates: ClipCandidate[];
}): { positiveTerms: string[]; negativeTerms: string[] } {
	const termScore = new Map<string, number>();
	for (const candidate of candidates) {
		const rating = candidate.userFeedback?.rating ?? candidate.userRating ?? 0;
		const comment = (
			candidate.userComment ??
			candidate.userFeedback?.comment ??
			""
		).trim();
		if (!comment || rating === 0) continue;
		const terms = tokenizeFeedbackTerms(comment);
		for (const term of terms) {
			termScore.set(term, (termScore.get(term) ?? 0) + rating);
		}
	}
	const ranked = Array.from(termScore.entries()).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
	return {
		positiveTerms: ranked.filter(([, score]) => score > 0).slice(0, 12).map(([term]) => term),
		negativeTerms: ranked.filter(([, score]) => score < 0).slice(0, 12).map(([term]) => term),
	};
}

function lexicalCommentAdjustment({
	candidate,
	feedbackModel,
}: {
	candidate: ClipCandidate;
	feedbackModel: ClipRatingFeedbackModel;
}): number {
	const haystack = `${candidate.title} ${candidate.rationale} ${candidate.transcriptSnippet}`.toLowerCase();
	const upHits = feedbackModel.positiveTerms.filter((term) => haystack.includes(term)).length;
	const downHits = feedbackModel.negativeTerms.filter((term) => haystack.includes(term)).length;
	if (upHits === 0 && downHits === 0) return 0;
	return (upHits - downHits) * 2 * feedbackModel.confidence;
}

export function buildClipRatingFeedbackModel({
	candidates,
}: {
	candidates: ClipCandidate[];
}): ClipRatingFeedbackModel | null {
	const rated = candidates.filter(
		(
			candidate,
		): candidate is ClipCandidate & {
			userRating?: -1 | 0 | 1;
			userFeedback?: { rating: -1 | 1 };
		} => {
			const rating = candidate.userFeedback?.rating ?? candidate.userRating ?? 0;
			return rating === 1 || rating === -1;
		},
	);
	if (rated.length === 0) return null;

	const up = rated.filter(
		(candidate) =>
			(candidate.userFeedback?.rating ?? candidate.userRating ?? 0) === 1,
	);
	const down = rated.filter(
		(candidate) =>
			(candidate.userFeedback?.rating ?? candidate.userRating ?? 0) === -1,
	);

	const factorPreference = Object.fromEntries(
		FACTOR_KEYS.map((factor) => {
			const upMean = mean(up.map((candidate) => candidate.scoreBreakdown[factor]));
			const downMean = mean(down.map((candidate) => candidate.scoreBreakdown[factor]));
			const normalizedPreference =
				up.length > 0 && down.length > 0
					? (upMean - downMean) / 50
					: up.length > 0
						? (upMean - 50) / 50
						: (50 - downMean) / 50;
			return [factor, Math.max(-1, Math.min(1, normalizedPreference))];
		}),
	) as Record<ViralityFactor, number>;

	return {
		ratedCount: rated.length,
		confidence: Math.max(0.2, Math.min(1, rated.length / 6)),
		factorPreference,
		ratedWindows: rated.map((candidate) => ({
			startTime: candidate.startTime,
			endTime: candidate.endTime,
			rating:
				(candidate.userFeedback?.rating ?? candidate.userRating ?? 0) === 1
					? 1
					: -1,
		})),
		...extractTermPreferences({
			candidates,
		}),
	};
}

export function getCandidateScoreWithRatingFeedback({
	candidate,
	feedbackModel,
}: {
	candidate: ClipCandidate;
	feedbackModel: ClipRatingFeedbackModel | null;
}): number {
	const explicitRating = candidate.userFeedback?.rating ?? candidate.userRating ?? 0;
	const explicitAdjustment = explicitRating * MAX_EXPLICIT_RATING_BOOST;

	if (!feedbackModel) {
		return clampScore(candidate.scoreOverall + explicitAdjustment);
	}

	const factorAlignment = mean(
		FACTOR_KEYS.map((factor) => {
			const normalizedValue = (candidate.scoreBreakdown[factor] - 50) / 50;
			return normalizedValue * feedbackModel.factorPreference[factor];
		}),
	);
	const factorAdjustment =
		factorAlignment * MAX_FACTOR_MODEL_BOOST * feedbackModel.confidence;

	let maxUpOverlap = 0;
	let maxDownOverlap = 0;
	for (const ratedWindow of feedbackModel.ratedWindows) {
		const overlap = overlapRatio({
			aStart: candidate.startTime,
			aEnd: candidate.endTime,
			bStart: ratedWindow.startTime,
			bEnd: ratedWindow.endTime,
		});
		if (ratedWindow.rating === 1) {
			maxUpOverlap = Math.max(maxUpOverlap, overlap);
		} else {
			maxDownOverlap = Math.max(maxDownOverlap, overlap);
		}
	}
	const temporalAdjustment =
		(maxUpOverlap - maxDownOverlap) *
		MAX_TEMPORAL_MODEL_BOOST *
		feedbackModel.confidence;
	const lexicalAdjustment = lexicalCommentAdjustment({
		candidate,
		feedbackModel,
	});

	return clampScore(
		candidate.scoreOverall +
			explicitAdjustment +
			factorAdjustment +
			temporalAdjustment +
			lexicalAdjustment,
	);
}

export function rankCandidatesWithRatingFeedback({
	candidates,
	feedbackModel,
}: {
	candidates: ClipCandidate[];
	feedbackModel: ClipRatingFeedbackModel | null;
}): ClipCandidate[] {
	const adjusted = candidates.map((candidate) => ({
		...candidate,
		scoreOverall: getCandidateScoreWithRatingFeedback({
			candidate,
			feedbackModel,
		}),
	}));

	return adjusted.sort((a, b) => {
		if (b.scoreOverall !== a.scoreOverall) return b.scoreOverall - a.scoreOverall;
		if (b.scoreBreakdown.hook !== a.scoreBreakdown.hook) {
			return b.scoreBreakdown.hook - a.scoreBreakdown.hook;
		}
		return a.startTime - b.startTime;
	});
}
