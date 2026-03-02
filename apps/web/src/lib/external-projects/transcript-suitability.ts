import type { TranscriptionSegment } from "@/types/transcription";

const MIN_TRANSCRIPT_CHARS = 120;
const MIN_SEGMENT_COUNT = 5;
const MIN_SPEECH_COVERAGE = 0.15;

export interface TranscriptSuitabilityResult {
	isSuitable: boolean;
	reasons: string[];
	speechCoverage: number;
	segmentCount: number;
	charCount: number;
}

function mergeIntervals(
	segments: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
	const sorted = [...segments]
		.filter((segment) => segment.end > segment.start)
		.sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const segment of sorted) {
		const prev = merged[merged.length - 1];
		if (!prev || segment.start > prev.end) {
			merged.push({ ...segment });
			continue;
		}
		prev.end = Math.max(prev.end, segment.end);
	}
	return merged;
}

export function hasValidMonotonicSegments({
	segments,
}: {
	segments: TranscriptionSegment[];
}): boolean {
	let lastStart = -Infinity;
	let lastEnd = -Infinity;
	for (const segment of segments) {
		if (
			!Number.isFinite(segment.start) ||
			!Number.isFinite(segment.end) ||
			segment.start < 0 ||
			segment.end <= segment.start
		) {
			return false;
		}
		if (segment.start < lastStart || segment.end < lastEnd) {
			return false;
		}
		lastStart = segment.start;
		lastEnd = segment.end;
	}
	return true;
}

export function evaluateTranscriptSuitability({
	transcriptText,
	segments,
	audioDurationSeconds,
}: {
	transcriptText: string;
	segments: TranscriptionSegment[];
	audioDurationSeconds: number | null;
}): TranscriptSuitabilityResult {
	const reasons: string[] = [];
	const charCount = transcriptText.trim().length;
	if (charCount < MIN_TRANSCRIPT_CHARS) {
		reasons.push(`transcript too short (${charCount} chars)`);
	}

	if (segments.length < MIN_SEGMENT_COUNT) {
		reasons.push(`insufficient segments (${segments.length})`);
	}

	if (!hasValidMonotonicSegments({ segments })) {
		reasons.push("segments contain invalid or non-monotonic timings");
	}

	const merged = mergeIntervals(segments);
	const speechSeconds = merged.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
	const inferredDuration = segments[segments.length - 1]?.end ?? 0;
	const durationSeconds = Math.max(
		audioDurationSeconds ?? 0,
		Number.isFinite(inferredDuration) ? inferredDuration : 0,
	);
	const speechCoverage = durationSeconds > 0 ? speechSeconds / durationSeconds : 0;
	if (speechCoverage < MIN_SPEECH_COVERAGE) {
		reasons.push(`speech coverage too low (${(speechCoverage * 100).toFixed(1)}%)`);
	}

	return {
		isSuitable: reasons.length === 0,
		reasons,
		speechCoverage,
		segmentCount: segments.length,
		charCount,
	};
}
