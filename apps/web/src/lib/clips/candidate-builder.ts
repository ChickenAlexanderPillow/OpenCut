import { generateUUID } from "@/utils/id";
import type { ClipCandidateDraft } from "@/types/clip-generation";
import type { TranscriptionSegment } from "@/types/transcription";

const DEFAULT_MIN_CLIP_SECONDS = 20;
const DEFAULT_MAX_CLIP_SECONDS = 90;
const DEFAULT_TARGET_CLIP_SECONDS = 45;
const DEFAULT_MAX_OUTPUT = 12;
const CLUSTER_GAP_SECONDS = 6;
const CONTEXT_DEPENDENT_OPENING_WORDS = new Set([
	"it",
	"this",
	"that",
	"these",
	"those",
	"they",
	"them",
	"he",
	"she",
	"there",
	"here",
	"and",
	"but",
	"so",
	"then",
	"also",
]);

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
	const intersection = Math.max(
		0,
		Math.min(aEnd, bEnd) - Math.max(aStart, bStart),
	);
	const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
	if (union <= 0) return 0;
	return intersection / union;
}

function truncateText({
	text,
	maxLength,
}: {
	text: string;
	maxLength: number;
}): string {
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

function getOpeningWord(text: string): string | null {
	const match = text.trim().match(/^[("'[\]]*([A-Za-z]+)/);
	return match?.[1]?.toLowerCase() ?? null;
}

function startsWithContextDependentReference(text: string): boolean {
	const openingWord = getOpeningWord(text);
	if (!openingWord) return false;
	return CONTEXT_DEPENDENT_OPENING_WORDS.has(openingWord);
}

function isQuestionSegment(text: string): boolean {
	return /\?/.test(text);
}

function hasMeaningfulAnswerAfterQuestion({
	segments,
	questionIndex,
	lastIndex,
}: {
	segments: TranscriptionSegment[];
	questionIndex: number;
	lastIndex: number;
}): boolean {
	for (let i = questionIndex + 1; i <= lastIndex; i++) {
		const segment = segments[i];
		if (!segment) continue;
		if (isQuestionSegment(segment.text)) continue;
		const duration = Math.max(0, segment.end - segment.start);
		const words = segment.text.match(/\S+/g) ?? [];
		if (duration >= 0.75 && words.length >= 2) {
			return true;
		}
	}
	return false;
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
		.map((segment) => {
			const fullText = segment.text.trim();
			if (!fullText) return "";
			const overlapStart = Math.max(startTime, segment.start);
			const overlapEnd = Math.min(endTime, segment.end);
			const overlapDuration = Math.max(0, overlapEnd - overlapStart);
			const segmentDuration = Math.max(0.001, segment.end - segment.start);
			if (overlapDuration <= 0) return "";
			if (overlapDuration >= segmentDuration * 0.95 || segmentDuration <= 0.2) {
				return fullText;
			}

			const words = fullText.match(/\S+/g) ?? [];
			if (words.length <= 1) return fullText;
			const fromRatio = (overlapStart - segment.start) / segmentDuration;
			const toRatio = (overlapEnd - segment.start) / segmentDuration;
			const startIndex = Math.max(
				0,
				Math.min(words.length - 1, Math.floor(fromRatio * words.length)),
			);
			const endIndexExclusive = Math.max(
				startIndex + 1,
				Math.min(words.length, Math.ceil(toRatio * words.length)),
			);
			return words.slice(startIndex, endIndexExclusive).join(" ").trim();
		})
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
	const clusters: Array<{
		start: number;
		end: number;
		segments: TranscriptionSegment[];
	}> = [];
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

function findLastSentenceEndAtOrBefore({
	segments,
	startIndex,
	endIndex,
	limitEndTime,
	minEndTime,
}: {
	segments: TranscriptionSegment[];
	startIndex: number;
	endIndex: number;
	limitEndTime: number;
	minEndTime: number;
}): number | null {
	let best: number | null = null;
	for (let i = startIndex; i <= endIndex; i++) {
		const segment = segments[i];
		if (!segment) continue;
		if (segment.end > limitEndTime) break;
		if (segment.end < minEndTime) continue;
		if (endsSentence(segment.text)) {
			best = segment.end;
		}
	}
	return best;
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
	const shouldBacktrackForContextStart =
		firstSegment &&
		(startsLikelyContinuation(firstSegment.text) ||
			startsWithContextDependentReference(firstSegment.text));
	if (firstSegment && shouldBacktrackForContextStart) {
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
			adjustedEnd = current.end;
			if (endsSentence(current.text)) break;
		}
	}

	let cutForFollowUpQuestion = false;
	const updatedOverlap = getOverlapBounds({
		segments,
		startTime: adjustedStart,
		endTime: adjustedEnd,
	});
	if (updatedOverlap) {
		const questionIndices: number[] = [];
		for (let i = updatedOverlap.first; i <= updatedOverlap.last; i++) {
			if (isQuestionSegment(segments[i]?.text ?? "")) {
				questionIndices.push(i);
				if (questionIndices.length >= 2) break;
			}
		}
		if (questionIndices.length >= 2) {
			const secondQuestionIndex = questionIndices.at(1);
			if (secondQuestionIndex != null) {
				const secondQuestion = segments[secondQuestionIndex];
				const prior = segments[secondQuestionIndex - 1];
				const cutoffAt = prior
					? Math.max(prior.end, secondQuestion.start)
					: secondQuestion.start;
				if (Number.isFinite(cutoffAt) && cutoffAt > adjustedStart + 0.5) {
					adjustedEnd = Math.min(adjustedEnd, cutoffAt);
					cutForFollowUpQuestion = true;
				}
			}
		}

		const refreshedOverlap = getOverlapBounds({
			segments,
			startTime: adjustedStart,
			endTime: adjustedEnd,
		});
		if (refreshedOverlap) {
			for (let i = refreshedOverlap.last; i >= refreshedOverlap.first; i--) {
				const segment = segments[i];
				if (!segment) continue;
				if (!isQuestionSegment(segment.text)) continue;
				const hasAnswer = hasMeaningfulAnswerAfterQuestion({
					segments,
					questionIndex: i,
					lastIndex: refreshedOverlap.last,
				});
				if (hasAnswer) break;
				const prior = segments[i - 1];
				const cutoffAt = prior
					? Math.max(prior.end, segment.start)
					: segment.start;
				if (Number.isFinite(cutoffAt) && cutoffAt > adjustedStart + 0.5) {
					adjustedEnd = Math.min(adjustedEnd, cutoffAt);
					cutForFollowUpQuestion = true;
				}
				break;
			}
		}
	}

	if (adjustedEnd - adjustedStart < minClipSeconds) {
		if (cutForFollowUpQuestion) {
			adjustedStart = Math.max(0, adjustedEnd - minClipSeconds);
		} else {
			const minEndTarget = Math.min(
				mediaDuration,
				adjustedStart + minClipSeconds,
			);
			const overlapForMin = getOverlapBounds({
				segments,
				startTime: adjustedStart,
				endTime: minEndTarget + CLUSTER_GAP_SECONDS,
			});
			if (overlapForMin) {
				const sentenceEnd = findLastSentenceEndAtOrBefore({
					segments,
					startIndex: overlapForMin.first,
					endIndex: overlapForMin.last,
					limitEndTime: minEndTarget + CLUSTER_GAP_SECONDS,
					minEndTime: minEndTarget,
				});
				adjustedEnd = sentenceEnd ?? minEndTarget;
			} else {
				adjustedEnd = minEndTarget;
			}
		}
	}
	// Intentionally allow exceeding maxClipSeconds when needed to finish a sentence.

	return {
		startTime: clamp(adjustedStart, 0, mediaDuration),
		endTime: clamp(adjustedEnd, 0, mediaDuration),
	};
}

function hasUnresolvedContextAtStart({
	segments,
	startTime,
	endTime,
}: {
	segments: TranscriptionSegment[];
	startTime: number;
	endTime: number;
}): boolean {
	const overlap = getOverlapBounds({ segments, startTime, endTime });
	if (!overlap) return false;

	const firstSegment = segments[overlap.first];
	if (!firstSegment) return false;
	const openingText =
		buildSnippet({
			segments,
			startTime,
			endTime: Math.min(endTime, startTime + 4),
		}).trim() || firstSegment.text.trim();
	if (!startsWithContextDependentReference(openingText)) return false;

	const isNearMediaStart = overlap.first === 0 && startTime <= 1.5;
	return !isNearMediaStart;
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
			segment.end > snappedWindow.startTime &&
			segment.start < snappedWindow.endTime,
	);
	if (overlappingSegments.length === 0) return null;
	if (
		hasUnresolvedContextAtStart({
			segments,
			startTime: snappedWindow.startTime,
			endTime: snappedWindow.endTime,
		})
	) {
		return null;
	}

	const spokenDuration = overlappingSegments.reduce((sum, segment) => {
		const clippedStart = Math.max(snappedWindow.startTime, segment.start);
		const clippedEnd = Math.min(snappedWindow.endTime, segment.end);
		return sum + Math.max(0, clippedEnd - clippedStart);
	}, 0);
	const density = spokenDuration / duration;
	const wordCount = overlappingSegments.flatMap(
		(segment) => segment.text.match(/\S+/g) ?? [],
	).length;
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
				const windowStart = clamp(
					offset,
					0,
					Math.max(0, mediaDuration - minClipSeconds),
				);
				const windowEnd = clamp(
					windowStart + targetClipSeconds,
					0,
					mediaDuration,
				);
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
	for (const candidate of candidates.sort(
		(a, b) => b.localScore - a.localScore,
	)) {
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
