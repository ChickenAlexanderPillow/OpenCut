import { generateUUID } from "@/utils/id";
import type { ClipCandidateDraft } from "@/types/clip-generation";
import type { TranscriptionSegment } from "@/types/transcription";

const DEFAULT_MIN_CLIP_SECONDS = 30;
const DEFAULT_MAX_CLIP_SECONDS = 90;
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
	return `${text.slice(0, maxLength - 3).trim()}...`;
}

function endsSentence(text: string): boolean {
	return /[.!?]["')\]]*\s*$/.test(text.trim());
}

function startsLikelyContinuation(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const firstChar = trimmed[0] ?? "";
	return /[a-z]/.test(firstChar);
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

function getOverlapBounds({
	segments,
	startTime,
	endTime,
}: {
	segments: TranscriptionSegment[];
	startTime: number;
	endTime: number;
}): { first: number; last: number } | null {
	let first = -1;
	let last = -1;
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (segment.end > startTime && segment.start < endTime) {
			if (first === -1) first = i;
			last = i;
		}
	}
	if (first === -1 || last === -1) return null;
	return { first, last };
}

function snapWindowToSentenceBoundaries({
	segments,
	startTime,
	endTime,
	minClipSeconds,
	maxClipSeconds,
	mediaDuration,
}: {
	segments: TranscriptionSegment[];
	startTime: number;
	endTime: number;
	minClipSeconds: number;
	maxClipSeconds: number;
	mediaDuration: number;
}): { startTime: number; endTime: number } {
	const overlap = getOverlapBounds({ segments, startTime, endTime });
	if (!overlap) return { startTime, endTime };

	let adjustedStart = startTime;
	let adjustedEnd = endTime;

	const firstSegment = segments[overlap.first];
	if (firstSegment && startsLikelyContinuation(firstSegment.text)) {
		for (let i = overlap.first - 1; i >= 0; i--) {
			const current = segments[i];
			const next = segments[i + 1];
			if (!current || !next) break;
			if (next.start - current.end > CLUSTER_GAP_SECONDS) break;
			const candidateStart = current.start;
			if (adjustedEnd - candidateStart > maxClipSeconds) continue;
			adjustedStart = candidateStart;
			const previous = segments[i - 1];
			if (!previous || endsSentence(previous.text)) break;
		}
	}

	const lastSegment = segments[overlap.last];
	if (lastSegment && !endsSentence(lastSegment.text)) {
		for (let i = overlap.last + 1; i < segments.length; i++) {
			const previous = segments[i - 1];
			const current = segments[i];
			if (!previous || !current) break;
			if (current.start - previous.end > CLUSTER_GAP_SECONDS) break;
			if (current.end - adjustedStart > maxClipSeconds) break;
			adjustedEnd = current.end;
			if (endsSentence(current.text)) break;
		}
	}

	if (adjustedEnd - adjustedStart < minClipSeconds) {
		adjustedEnd = Math.min(mediaDuration, adjustedStart + minClipSeconds);
	}
	if (adjustedEnd - adjustedStart > maxClipSeconds) {
		adjustedEnd = adjustedStart + maxClipSeconds;
	}

	return {
		startTime: clamp(adjustedStart, 0, mediaDuration),
		endTime: clamp(adjustedEnd, 0, mediaDuration),
	};
}

function buildClipDraft({
	startTime,
	endTime,
	segments,
	minClipSeconds,
	maxClipSeconds,
	mediaDuration,
}: {
	startTime: number;
	endTime: number;
	segments: TranscriptionSegment[];
	minClipSeconds: number;
	maxClipSeconds: number;
	mediaDuration: number;
}): ClipCandidateDraft | null {
	const snappedWindow = snapWindowToSentenceBoundaries({
		segments,
		startTime,
		endTime,
		minClipSeconds,
		maxClipSeconds,
		mediaDuration,
	});
	const duration = snappedWindow.endTime - snappedWindow.startTime;
	if (duration <= 0) return null;

	const overlappingSegments = segments.filter(
		(segment) =>
			segment.end > snappedWindow.startTime && segment.start < snappedWindow.endTime,
	);
	if (overlappingSegments.length === 0) return null;

	const spokenDuration = overlappingSegments.reduce((sum, segment) => {
		const clippedStart = Math.max(snappedWindow.startTime, segment.start);
		const clippedEnd = Math.min(snappedWindow.endTime, segment.end);
		return sum + Math.max(0, clippedEnd - clippedStart);
	}, 0);
	const density = spokenDuration / duration;
	const wordCount = overlappingSegments
		.flatMap((segment) => segment.text.match(/\S+/g) ?? [])
		.length;
	const localScore = density * 80 + Math.min(20, wordCount / 2);

	return {
		id: generateUUID(),
		startTime: roundToHundredth(snappedWindow.startTime),
		endTime: roundToHundredth(snappedWindow.endTime),
		duration: roundToHundredth(duration),
		transcriptSnippet: buildSnippet({
			segments,
			startTime: snappedWindow.startTime,
			endTime: snappedWindow.endTime,
		}),
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
			minClipSeconds,
			maxClipSeconds,
			mediaDuration,
		});
		if (draft) {
			candidates.push(draft);
		}

		const clusterDuration = cluster.end - cluster.start;
		if (clusterDuration > maxClipSeconds) {
			const step = Math.max(10, Math.floor(targetClipSeconds / 3));
			for (let offset = cluster.start; offset < cluster.end; offset += step) {
				const windowStart = clamp(offset, 0, Math.max(0, mediaDuration - minClipSeconds));
				const windowEnd = clamp(windowStart + targetClipSeconds, 0, mediaDuration);
				const splitDraft = buildClipDraft({
					startTime: windowStart,
					endTime: windowEnd,
					segments: normalizedSegments,
					minClipSeconds,
					maxClipSeconds,
					mediaDuration,
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
