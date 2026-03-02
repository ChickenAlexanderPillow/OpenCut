import { generateUUID } from "@/utils/id";
import type { ClipCandidateDraft } from "@/types/clip-generation";
import type { TranscriptionSegment } from "@/types/transcription";

const DEFAULT_MIN_CLIP_SECONDS = 30;
const DEFAULT_MAX_CLIP_SECONDS = 60;
const DEFAULT_TARGET_CLIP_SECONDS = 45;
const DEFAULT_MAX_OUTPUT = 12;
const CLUSTER_GAP_SECONDS = 6;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function roundToHundredth(value: number): number {
	return Math.round(value * 100) / 100;
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

function truncateText({ text, maxLength }: { text: string; maxLength: number }): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1).trim()}…`;
}

function buildSnippet({
	segments,
	startTime,
	endTime,
}: {
	segments: TranscriptionSegment[];
	startTime: number;
	endTime: number;
}): string {
	const text = segments
		.filter((segment) => segment.end > startTime && segment.start < endTime)
		.map((segment) => segment.text.trim())
		.filter(Boolean)
		.join(" ");
	return truncateText({ text, maxLength: 220 });
}

function buildClusters({
	segments,
}: {
	segments: TranscriptionSegment[];
}): Array<{ start: number; end: number; segments: TranscriptionSegment[] }> {
	if (segments.length === 0) return [];
	const clusters: Array<{ start: number; end: number; segments: TranscriptionSegment[] }> = [];
	let current = {
		start: segments[0].start,
		end: segments[0].end,
		segments: [segments[0]],
	};

	for (let i = 1; i < segments.length; i++) {
		const segment = segments[i];
		if (segment.start - current.end <= CLUSTER_GAP_SECONDS) {
			current.end = Math.max(current.end, segment.end);
			current.segments.push(segment);
			continue;
		}
		clusters.push(current);
		current = {
			start: segment.start,
			end: segment.end,
			segments: [segment],
		};
	}

	clusters.push(current);
	return clusters;
}

function buildClipDraft({
	startTime,
	endTime,
	segments,
}: {
	startTime: number;
	endTime: number;
	segments: TranscriptionSegment[];
}): ClipCandidateDraft | null {
	const duration = endTime - startTime;
	if (duration <= 0) return null;

	const overlappingSegments = segments.filter(
		(segment) => segment.end > startTime && segment.start < endTime,
	);
	if (overlappingSegments.length === 0) return null;

	const spokenDuration = overlappingSegments.reduce((sum, segment) => {
		const clippedStart = Math.max(startTime, segment.start);
		const clippedEnd = Math.min(endTime, segment.end);
		return sum + Math.max(0, clippedEnd - clippedStart);
	}, 0);
	const density = spokenDuration / duration;
	const wordCount = overlappingSegments
		.flatMap((segment) => segment.text.match(/\S+/g) ?? [])
		.length;
	const localScore = density * 80 + Math.min(20, wordCount / 2);

	return {
		id: generateUUID(),
		startTime: roundToHundredth(startTime),
		endTime: roundToHundredth(endTime),
		duration: roundToHundredth(duration),
		transcriptSnippet: buildSnippet({ segments, startTime, endTime }),
		localScore,
	};
}

export function buildClipCandidatesFromTranscript({
	segments,
	mediaDuration,
	minClipSeconds = DEFAULT_MIN_CLIP_SECONDS,
	maxClipSeconds = DEFAULT_MAX_CLIP_SECONDS,
	targetClipSeconds = DEFAULT_TARGET_CLIP_SECONDS,
	maxOutput = DEFAULT_MAX_OUTPUT,
}: {
	segments: TranscriptionSegment[];
	mediaDuration: number;
	minClipSeconds?: number;
	maxClipSeconds?: number;
	targetClipSeconds?: number;
	maxOutput?: number;
}): ClipCandidateDraft[] {
	const normalizedSegments = [...segments]
		.filter(
			(segment) =>
				Number.isFinite(segment.start) &&
				Number.isFinite(segment.end) &&
				segment.end > segment.start,
		)
		.map((segment) => ({
			...segment,
			start: clamp(segment.start, 0, mediaDuration),
			end: clamp(segment.end, 0, mediaDuration),
		}))
		.filter((segment) => segment.end > segment.start)
		.sort((a, b) => a.start - b.start);

	if (mediaDuration <= 0 || normalizedSegments.length === 0) return [];

	const clusters = buildClusters({ segments: normalizedSegments });
	const candidates: ClipCandidateDraft[] = [];

	for (const cluster of clusters) {
		const clusterCenter = (cluster.start + cluster.end) / 2;
		let startTime = clamp(
			clusterCenter - targetClipSeconds / 2,
			0,
			Math.max(0, mediaDuration - minClipSeconds),
		);
		let endTime = clamp(startTime + targetClipSeconds, 0, mediaDuration);
		if (endTime - startTime < minClipSeconds) {
			startTime = clamp(
				endTime - minClipSeconds,
				0,
				Math.max(0, mediaDuration - minClipSeconds),
			);
			endTime = clamp(startTime + minClipSeconds, 0, mediaDuration);
		}
		if (endTime - startTime > maxClipSeconds) {
			endTime = startTime + maxClipSeconds;
		}

		const draft = buildClipDraft({
			startTime,
			endTime,
			segments: normalizedSegments,
		});
		if (draft) {
			candidates.push(draft);
		}

		const clusterDuration = cluster.end - cluster.start;
		if (clusterDuration > maxClipSeconds) {
			const step = Math.max(10, Math.floor(targetClipSeconds / 3));
			for (
				let offset = cluster.start;
				offset < cluster.end;
				offset += step
			) {
				const windowStart = clamp(offset, 0, Math.max(0, mediaDuration - minClipSeconds));
				const windowEnd = clamp(windowStart + targetClipSeconds, 0, mediaDuration);
				const splitDraft = buildClipDraft({
					startTime: windowStart,
					endTime: windowEnd,
					segments: normalizedSegments,
				});
				if (splitDraft) {
					candidates.push(splitDraft);
				}
			}
		}
	}

	const deduped: ClipCandidateDraft[] = [];
	for (const candidate of candidates.sort((a, b) => b.localScore - a.localScore)) {
		const duplicate = deduped.some(
			(existing) =>
				overlapRatio({
					aStart: candidate.startTime,
					aEnd: candidate.endTime,
					bStart: existing.startTime,
					bEnd: existing.endTime,
				}) > 0.9,
		);
		if (!duplicate) {
			deduped.push(candidate);
		}
		if (deduped.length >= maxOutput) break;
	}

	return deduped;
}
