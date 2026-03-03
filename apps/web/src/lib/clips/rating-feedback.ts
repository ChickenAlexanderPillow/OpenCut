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

export function buildClipRatingFeedbackModel({
	candidates,
}: {
	candidates: ClipCandidate[];
}): ClipRatingFeedbackModel | null {
	const rated = candidates.filter(
		(candidate): candidate is ClipCandidate & { userRating: -1 | 1 } =>
			candidate.userRating === 1 || candidate.userRating === -1,
	);
	if (rated.length === 0) return null;

	const up = rated.filter((candidate) => candidate.userRating === 1);
	const down = rated.filter((candidate) => candidate.userRating === -1);

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
			rating: candidate.userRating,
		})),
	};
}

export function getCandidateScoreWithRatingFeedback({
	candidate,
	feedbackModel,
}: {
	candidate: ClipCandidate;
	feedbackModel: ClipRatingFeedbackModel | null;
}): number {
	const explicitRating = candidate.userRating ?? 0;
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

	return clampScore(
		candidate.scoreOverall +
			explicitAdjustment +
			factorAdjustment +
			temporalAdjustment,
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
