import { describe, expect, test } from "bun:test";
import {
	buildClipRatingFeedbackModel,
	getCandidateScoreWithRatingFeedback,
	rankCandidatesWithRatingFeedback,
} from "@/lib/clips/rating-feedback";
import type { ClipCandidate } from "@/types/clip-generation";

function makeCandidate({
	id,
	startTime,
	endTime,
	scoreOverall,
	hook,
	emotion,
	shareability,
	clarity,
	momentum,
	userRating,
}: {
	id: string;
	startTime: number;
	endTime: number;
	scoreOverall: number;
	hook: number;
	emotion: number;
	shareability: number;
	clarity: number;
	momentum: number;
	userRating?: -1 | 0 | 1;
}): ClipCandidate {
	return {
		id,
		title: id,
		rationale: id,
		transcriptSnippet: id,
		duration: endTime - startTime,
		startTime,
		endTime,
		scoreOverall,
		scoreBreakdown: { hook, emotion, shareability, clarity, momentum },
		userRating,
	};
}

describe("clip rating feedback", () => {
	test("up/down ratings create a model and adjust scores", () => {
		const ratedCandidates: ClipCandidate[] = [
			makeCandidate({
				id: "up",
				startTime: 10,
				endTime: 40,
				scoreOverall: 80,
				hook: 92,
				emotion: 78,
				shareability: 84,
				clarity: 75,
				momentum: 80,
				userRating: 1,
			}),
			makeCandidate({
				id: "down",
				startTime: 120,
				endTime: 150,
				scoreOverall: 82,
				hook: 58,
				emotion: 48,
				shareability: 51,
				clarity: 62,
				momentum: 55,
				userRating: -1,
			}),
		];

		const model = buildClipRatingFeedbackModel({ candidates: ratedCandidates });
		expect(model).not.toBeNull();
		expect(model?.ratedCount).toBe(2);

		const similarToUp = makeCandidate({
			id: "cand-a",
			startTime: 15,
			endTime: 42,
			scoreOverall: 78,
			hook: 90,
			emotion: 74,
			shareability: 83,
			clarity: 72,
			momentum: 77,
		});
		const similarToDown = makeCandidate({
			id: "cand-b",
			startTime: 118,
			endTime: 152,
			scoreOverall: 78,
			hook: 56,
			emotion: 46,
			shareability: 52,
			clarity: 63,
			momentum: 54,
		});

		const scoreA = getCandidateScoreWithRatingFeedback({
			candidate: similarToUp,
			feedbackModel: model,
		});
		const scoreB = getCandidateScoreWithRatingFeedback({
			candidate: similarToDown,
			feedbackModel: model,
		});
		expect(scoreA).toBeGreaterThan(scoreB);
	});

	test("ranking uses adjusted scores, not raw scoreOverall only", () => {
		const baseline: ClipCandidate[] = [
			makeCandidate({
				id: "rated-up",
				startTime: 0,
				endTime: 30,
				scoreOverall: 70,
				hook: 90,
				emotion: 85,
				shareability: 88,
				clarity: 82,
				momentum: 84,
				userRating: 1,
			}),
			makeCandidate({
				id: "high-raw",
				startTime: 40,
				endTime: 70,
				scoreOverall: 78,
				hook: 62,
				emotion: 58,
				shareability: 60,
				clarity: 66,
				momentum: 61,
			}),
		];

		const model = buildClipRatingFeedbackModel({ candidates: baseline });
		const ranked = rankCandidatesWithRatingFeedback({
			candidates: baseline,
			feedbackModel: model,
		});
		expect(ranked[0]?.id).toBe("rated-up");
	});

	test("learns lexical preferences from feedback comments", () => {
		const candidates: ClipCandidate[] = [
			{
				...makeCandidate({
					id: "rated-up",
					startTime: 0,
					endTime: 30,
					scoreOverall: 76,
					hook: 84,
					emotion: 74,
					shareability: 80,
					clarity: 78,
					momentum: 76,
				}),
				userFeedback: {
					rating: 1,
					comment: "Loved the concrete consequences and stakes",
					updatedAt: "2026-03-04T00:00:00.000Z",
				},
			},
			{
				...makeCandidate({
					id: "rated-down",
					startTime: 60,
					endTime: 90,
					scoreOverall: 74,
					hook: 70,
					emotion: 66,
					shareability: 62,
					clarity: 80,
					momentum: 69,
				}),
				userFeedback: {
					rating: -1,
					comment: "Too generic recap and bland summary",
					updatedAt: "2026-03-04T00:00:00.000Z",
				},
			},
		];
		const model = buildClipRatingFeedbackModel({ candidates });
		expect(model).not.toBeNull();

		const consequenceClip = makeCandidate({
			id: "consequence",
			startTime: 95,
			endTime: 125,
			scoreOverall: 70,
			hook: 74,
			emotion: 70,
			shareability: 71,
			clarity: 73,
			momentum: 74,
		});
		consequenceClip.title = "Concrete consequences for the market";
		const genericClip = makeCandidate({
			id: "generic",
			startTime: 130,
			endTime: 160,
			scoreOverall: 70,
			hook: 74,
			emotion: 70,
			shareability: 71,
			clarity: 73,
			momentum: 74,
		});
		genericClip.title = "Generic recap of quarterly update";

		const boosted = getCandidateScoreWithRatingFeedback({
			candidate: consequenceClip,
			feedbackModel: model,
		});
		const reduced = getCandidateScoreWithRatingFeedback({
			candidate: genericClip,
			feedbackModel: model,
		});
		expect(boosted).toBeGreaterThan(reduced);
	});
});
