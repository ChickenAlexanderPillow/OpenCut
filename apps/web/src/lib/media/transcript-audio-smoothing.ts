import {
	TRANSCRIPT_CUT_AUDIO_FADE_IN_SECONDS,
	TRANSCRIPT_CUT_AUDIO_FADE_OUT_SECONDS,
} from "@/lib/transcript-editor/constants";

export function getTranscriptBoundaryMicroFadeGain({
	compressedTime,
	boundaries,
	fadeInSeconds = TRANSCRIPT_CUT_AUDIO_FADE_IN_SECONDS,
	fadeOutSeconds = TRANSCRIPT_CUT_AUDIO_FADE_OUT_SECONDS,
	boundaryIndex,
}: {
	compressedTime: number;
	boundaries: number[];
	fadeInSeconds?: number;
	fadeOutSeconds?: number;
	boundaryIndex: number;
}): { gain: number; boundaryIndex: number } {
	if (
		boundaries.length === 0 ||
		(fadeInSeconds <= 0 && fadeOutSeconds <= 0)
	) {
		return { gain: 1, boundaryIndex };
	}

	let nextBoundaryIndex = Math.max(0, boundaryIndex);
	while (
		nextBoundaryIndex < boundaries.length &&
		compressedTime > boundaries[nextBoundaryIndex]
	) {
		nextBoundaryIndex += 1;
	}

	const previousBoundary =
		nextBoundaryIndex > 0 ? boundaries[nextBoundaryIndex - 1] : undefined;
	const upcomingBoundary =
		nextBoundaryIndex < boundaries.length
			? boundaries[nextBoundaryIndex]
			: undefined;

	let gain = 1;

	if (
		typeof previousBoundary === "number" &&
		fadeInSeconds > 0 &&
		compressedTime >= previousBoundary
	) {
		const elapsedSinceBoundary = compressedTime - previousBoundary;
		if (elapsedSinceBoundary < fadeInSeconds) {
			gain = Math.min(gain, Math.max(0, elapsedSinceBoundary / fadeInSeconds));
		}
	}

	if (
		typeof upcomingBoundary === "number" &&
		fadeOutSeconds > 0 &&
		compressedTime <= upcomingBoundary
	) {
		const timeUntilBoundary = upcomingBoundary - compressedTime;
		if (timeUntilBoundary < fadeOutSeconds) {
			gain = Math.min(gain, Math.max(0, timeUntilBoundary / fadeOutSeconds));
		}
	}

	return { gain, boundaryIndex: nextBoundaryIndex };
}
