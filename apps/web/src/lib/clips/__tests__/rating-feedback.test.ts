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
});
