type CaptionWordTiming = {
	word: string;
	startTime: number;
	endTime: number;
	hidden?: boolean;
};

const RELATIVE_TOLERANCE_SECONDS = 0.25;

export function isCaptionTimingRelativeToElement({
	timings,
	elementDuration,
}: {
	timings: Array<{ startTime: number; endTime: number }>;
	elementDuration: number;
}): boolean {
	if (timings.length === 0) return false;
	const safeDuration = Math.max(0, elementDuration);
	const maxAllowedEnd = safeDuration + RELATIVE_TOLERANCE_SECONDS;
	const minAllowedStart = -RELATIVE_TOLERANCE_SECONDS;
	let validCount = 0;
	for (const timing of timings) {
		if (
			!Number.isFinite(timing.startTime) ||
			!Number.isFinite(timing.endTime)
		) {
			continue;
		}
		if (timing.endTime <= timing.startTime) continue;
		validCount += 1;
		if (timing.startTime < minAllowedStart || timing.endTime > maxAllowedEnd) {
			return false;
		}
	}
	return validCount > 0;
}

export function toTimelineCaptionWordTimings({
	timings,
	elementStartTime,
	elementDuration,
}: {
	timings: CaptionWordTiming[];
	elementStartTime: number;
	elementDuration: number;
}): CaptionWordTiming[] {
	if (timings.length === 0) return [];
	const isRelative = isCaptionTimingRelativeToElement({
		timings,
		elementDuration,
	});
	if (!isRelative) return timings;
	return timings.map((timing) => ({
		...timing,
		startTime: elementStartTime + timing.startTime,
		endTime: elementStartTime + timing.endTime,
	}));
}

export function toElementLocalCaptionTime({
	time,
	elementStartTime,
	timings,
	elementDuration,
}: {
	time: number;
	elementStartTime: number;
	timings: Array<{ startTime: number; endTime: number }>;
	elementDuration: number;
}): number {
	const isRelative = isCaptionTimingRelativeToElement({
		timings,
		elementDuration,
	});
	return isRelative ? time : time - elementStartTime;
}
