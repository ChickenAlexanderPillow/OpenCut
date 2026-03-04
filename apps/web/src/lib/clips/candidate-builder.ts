import { generateUUID } from "@/utils/id";
import type { ClipCandidateDraft } from "@/types/clip-generation";
import type { TranscriptionSegment } from "@/types/transcription";

const DEFAULT_MIN_CLIP_SECONDS = 20;
const DEFAULT_MAX_CLIP_SECONDS = 65;
const DEFAULT_TARGET_CLIP_SECONDS = 36;
const DEFAULT_MAX_OUTPUT = 12;
const DEFAULT_SENTENCE_MERGE_GAP_SECONDS = 1.4;

const CONTEXT_OPENERS = new Set([
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
	"because",
	"which",
	"or",
]);

const CONNECTOR_OPENERS = new Set([
	"and",
	"but",
	"so",
	"then",
	"because",
	"which",
	"or",
	"also",
	"however",
	"like",
]);

export interface SentenceUnit {
	start: number;
	end: number;
	text: string;
	endsSentence: boolean;
	isQuestion: boolean;
	hasQuestionCue: boolean;
	allowMergeWithNext: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function roundToHundredth(value: number): number {
	return Math.round(value * 100) / 100;
}

function getWords(text: string): string[] {
	return text.match(/\S+/g) ?? [];
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

function estimateTimeAtCharOffset({
	segment,
	charOffset,
}: {
	segment: TranscriptionSegment;
	charOffset: number;
}): number {
	const duration = Math.max(0.001, segment.end - segment.start);
	const textLength = Math.max(1, segment.text.length);
	const normalizedOffset = clamp(charOffset, 0, textLength);
	return segment.start + (normalizedOffset / textLength) * duration;
}

function hasQuestionCue(text: string): boolean {
	return /\b(my question is|the question is|how do you|what is your|can you|would you|why are|how are|what changed|what do you think)\b/i.test(
		text,
	);
}

function hasAnswerCue(text: string): boolean {
	return /\b(i think|we think|our view|the answer is|because|so the|that's why|therefore|the key is|what we saw|we saw|we found|the reason is)\b/i.test(
		text,
	);
}

function isInterviewerSetup(text: string): boolean {
	return /\b(i resisted the urge|i'd like to (ask|end)|thanks for joining|you mentioned|my question is|can you maybe|if you could|looking ahead|on a positive note|how do you respond to that|what can we expect|there was a quote|in the lead up to|fair enough|could you maybe talk us through)\b/i.test(
		text,
	);
}

function isWeakLeadInText(text: string): boolean {
	const cleaned = text
		.trim()
		.toLowerCase()
		.replace(/[.,!?;:'")\]]+$/g, "");
	const words = getWords(cleaned);
	if (words.length <= 2) return true;
	if (/^(year|yeah|well|right|okay|ok|so|and|but)$/i.test(cleaned)) return true;
	if (/^(you know|and so|but so|you see|i mean)$/i.test(words.slice(0, 2).join(" "))) {
		return true;
	}
	return /^yeah[, ]+well\b/i.test(cleaned);
}

function startsWithContinuationFragment(text: string): boolean {
	return /^[a-zA-Z]{1,10}\.\s+(yeah|well|so|and|but)\b/i.test(text.trim());
}

function isWeakTailText(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	if (/[.!?]["')\]]*$/.test(trimmed)) return false;
	return true;
}

function computeFillerRatio(text: string): number {
	const lower = text.toLowerCase();
	const words = getWords(lower);
	if (words.length === 0) return 0;
	const fillerHits =
		(lower.match(/\byou know\b/g)?.length ?? 0) +
		(lower.match(/\bi mean\b/g)?.length ?? 0) +
		(lower.match(/\blike\b/g)?.length ?? 0);
	return fillerHits / Math.max(1, words.length / 10);
}

function splitSegmentIntoSentencePieces({
	segment,
}: {
	segment: TranscriptionSegment;
}): SentenceUnit[] {
	const raw = segment.text;
	const matches = [...raw.matchAll(/[^.!?,;]+[.!?,;]?/g)];
	const pieces: SentenceUnit[] = [];

	for (const match of matches) {
		const matched = match[0] ?? "";
		if (!matched) continue;
		const baseIndex = match.index ?? 0;
		const leadingWs = matched.match(/^\s*/)?.[0].length ?? 0;
		const trailingWs = matched.match(/\s*$/)?.[0].length ?? 0;
		const trimmed = matched.trim();
		if (!trimmed) continue;

		const charStart = baseIndex + leadingWs;
		const charEndExclusive = Math.max(
			charStart + 1,
			baseIndex + matched.length - trailingWs,
		);
		const precedingText = raw.slice(0, charStart);
		const startsAfterSentenceBoundary =
			charStart > 0 && /[.!?]["')\]]*\s*$/.test(precedingText);
		const start = estimateTimeAtCharOffset({
			segment,
			charOffset: charStart,
		});
		const end = estimateTimeAtCharOffset({
			segment,
			charOffset: charEndExclusive,
		});
		const adjustedStart = startsAfterSentenceBoundary
			? Math.min(
					end - 0.02,
					start + Math.min(0.14, Math.max(0.04, (end - start) * 0.25)),
			  )
			: start;
		const hasCue = hasQuestionCue(trimmed);
		const endsSentence = /[.!?]["')\]]*$/.test(trimmed);
		pieces.push({
			start: adjustedStart,
			end: Math.max(adjustedStart + 0.02, end),
			text: trimmed,
			endsSentence,
			isQuestion: /\?/.test(trimmed) || hasCue,
			hasQuestionCue: hasCue,
			allowMergeWithNext: true,
		});
	}

	if (pieces.length === 0) {
		const trimmed = raw.trim();
		if (!trimmed) return [];
		const hasCue = hasQuestionCue(trimmed);
		return [
			{
				start: segment.start,
				end: segment.end,
				text: trimmed,
				endsSentence: /[.!?]["')\]]*$/.test(trimmed),
				isQuestion: /\?/.test(trimmed) || hasCue,
				hasQuestionCue: hasCue,
				allowMergeWithNext: true,
			},
		];
	}

	return pieces;
}

function splitLongRunOnWords({
	unit,
	maxWordsPerChunk = 12,
	minDurationToSplit = 12,
}: {
	unit: SentenceUnit;
	maxWordsPerChunk?: number;
	minDurationToSplit?: number;
}): SentenceUnit[] {
	const duration = Math.max(0, unit.end - unit.start);
	const words = getWords(unit.text);
	if (
		unit.endsSentence ||
		duration < minDurationToSplit ||
		words.length <= maxWordsPerChunk + 2
	) {
		return [unit];
	}

	const chunks: SentenceUnit[] = [];
	const chunkCount = Math.ceil(words.length / maxWordsPerChunk);
	for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
		const startWord = chunkIndex * maxWordsPerChunk;
		const endWord = Math.min(words.length, startWord + maxWordsPerChunk);
		const text = words.slice(startWord, endWord).join(" ").trim();
		if (!text) continue;
		const fromRatio = startWord / words.length;
		const toRatio = endWord / words.length;
		const start = unit.start + duration * fromRatio;
		const end = unit.start + duration * toRatio;
		const isLast = chunkIndex === chunkCount - 1;
		const hasCue = hasQuestionCue(text);
		chunks.push({
			start,
			end: Math.max(start + 0.02, end),
			text,
			// Long ASR runs without punctuation need deterministic synthetic anchors.
			endsSentence: isLast ? unit.endsSentence : true,
			isQuestion: /\?/.test(text) || hasCue,
			hasQuestionCue: hasCue,
			allowMergeWithNext: false,
		});
	}
	return chunks.length > 0 ? chunks : [unit];
}

function openingWord(text: string): string {
	const match = text.trim().match(/^[("'[\]]*([A-Za-z]+)/);
	return match?.[1]?.toLowerCase() ?? "";
}

function startsLowercase(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const firstChar = trimmed[0] ?? "";
	return /[a-z]/.test(firstChar);
}

function startsLikeContinuation(text: string): boolean {
	const firstWord = openingWord(text);
	return startsLowercase(text) || CONNECTOR_OPENERS.has(firstWord);
}

export function buildSentenceUnitsFromSegments({
	segments,
	mediaDuration,
	maxMergeGapSeconds = DEFAULT_SENTENCE_MERGE_GAP_SECONDS,
}: {
	segments: TranscriptionSegment[];
	mediaDuration: number;
	maxMergeGapSeconds?: number;
}): SentenceUnit[] {
	const normalized = [...segments]
		.filter(
			(segment) =>
				Number.isFinite(segment.start) &&
				Number.isFinite(segment.end) &&
				segment.end > segment.start &&
				segment.text.trim().length > 0,
		)
		.map((segment) => ({
			...segment,
			start: clamp(segment.start, 0, mediaDuration),
			end: clamp(segment.end, 0, mediaDuration),
		}))
		.filter((segment) => segment.end > segment.start)
		.sort((a, b) => a.start - b.start);
	if (normalized.length === 0 || mediaDuration <= 0) return [];

	const flatPieces = normalized.flatMap((segment) =>
		splitSegmentIntoSentencePieces({ segment }),
	);
	if (flatPieces.length === 0) return [];
	const splitLongPieces = flatPieces.flatMap((piece) =>
		splitLongRunOnWords({
			unit: piece,
		}),
	);

	const merged: SentenceUnit[] = [];
	let current = { ...splitLongPieces[0] };
	for (let i = 1; i < splitLongPieces.length; i++) {
		const next = splitLongPieces[i];
		const gap = Math.max(0, next.start - current.end);
		const shouldMerge =
			current.allowMergeWithNext &&
			gap <= maxMergeGapSeconds &&
			!current.endsSentence;
		if (shouldMerge) {
			current = {
				start: current.start,
				end: Math.max(current.end, next.end),
				text: `${current.text} ${next.text}`.replace(/\s+/g, " ").trim(),
				endsSentence: next.endsSentence,
				isQuestion: current.isQuestion || next.isQuestion,
				hasQuestionCue: current.hasQuestionCue || next.hasQuestionCue,
				allowMergeWithNext: next.allowMergeWithNext,
			};
			continue;
		}
		merged.push(current);
		current = { ...next };
	}
	merged.push(current);

	return merged;
}

function truncateText({
	text,
	maxLength,
}: {
	text: string;
	maxLength: number;
}): string {
	if (text.length <= maxLength) return text;
	const prefix = text.slice(0, maxLength).trim();
	// Preserve complete thought boundaries for LLM scoring.
	const lastSentenceBoundary = Math.max(
		prefix.lastIndexOf("."),
		prefix.lastIndexOf("!"),
		prefix.lastIndexOf("?"),
	);
	if (lastSentenceBoundary >= Math.floor(maxLength * 0.65)) {
		return prefix.slice(0, lastSentenceBoundary + 1).trim();
	}
	const lastWhitespace = prefix.lastIndexOf(" ");
	if (lastWhitespace > 0) {
		return prefix.slice(0, lastWhitespace).trim();
	}
	return prefix;
}

function buildSnippetFromUnits({
	units,
	startIndex,
	endIndex,
}: {
	units: SentenceUnit[];
	startIndex: number;
	endIndex: number;
}): string {
	const text = units
		.slice(startIndex, endIndex + 1)
		.map((unit) => unit.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return truncateText({ text, maxLength: 1200 });
}

function hasAnswerAfterQuestion({
	units,
	startIndex,
	endIndex,
}: {
	units: SentenceUnit[];
	startIndex: number;
	endIndex: number;
}): boolean {
	let sawQuestion = false;
	for (let i = startIndex; i <= endIndex; i++) {
		const unit = units[i];
		if (!unit) continue;
		if (unit.isQuestion || unit.hasQuestionCue) {
			sawQuestion = true;
			continue;
		}
		if (sawQuestion && (hasAnswerCue(unit.text) || unit.endsSentence)) return true;
	}
	return false;
}

function hasTrailingUnansweredQuestion({
	units,
	startIndex,
	endIndex,
}: {
	units: SentenceUnit[];
	startIndex: number;
	endIndex: number;
}): boolean {
	let lastQuestionIndex = -1;
	for (let i = startIndex; i <= endIndex; i++) {
		if (units[i]?.isQuestion || units[i]?.hasQuestionCue) {
			lastQuestionIndex = i;
		}
	}
	if (lastQuestionIndex === -1) return false;
	for (let i = lastQuestionIndex + 1; i <= endIndex; i++) {
		if (!units[i]?.isQuestion && !units[i]?.hasQuestionCue) return false;
	}
	return true;
}

function getLastQuestionIndex({
	units,
	startIndex,
	endIndex,
}: {
	units: SentenceUnit[];
	startIndex: number;
	endIndex: number;
}): number {
	let lastQuestionIndex = -1;
	for (let i = startIndex; i <= endIndex; i++) {
		const unit = units[i];
		if (unit?.isQuestion || unit?.hasQuestionCue) {
			lastQuestionIndex = i;
		}
	}
	return lastQuestionIndex;
}

function answerDurationAfterLastQuestion({
	units,
	startIndex,
	endIndex,
}: {
	units: SentenceUnit[];
	startIndex: number;
	endIndex: number;
}): number {
	const lastQuestionIndex = getLastQuestionIndex({
		units,
		startIndex,
		endIndex,
	});
	if (lastQuestionIndex < 0) {
		return Math.max(0, (units[endIndex]?.end ?? 0) - (units[startIndex]?.start ?? 0));
	}

	let answerDuration = 0;
	for (let i = lastQuestionIndex + 1; i <= endIndex; i++) {
		const unit = units[i];
		if (!unit) continue;
		if (unit.isQuestion || unit.hasQuestionCue) continue;
		answerDuration += Math.max(0, unit.end - unit.start);
	}
	return answerDuration;
}

function containsQuestionCue(text: string): boolean {
	return hasQuestionCue(text);
}

function containsAnalogy(text: string): boolean {
	return /\btulip\b|\banalogy\b|\bmetaphor\b|\blike\b.+\b(in|as)\b/i.test(text);
}

function containsConsequenceChain(text: string): boolean {
	const normalized = text.toLowerCase();
	const causalHits =
		(normalized.match(/\b(as a result|which means|that's why|therefore|because)\b/g)
			?.length ?? 0) +
		(normalized.match(/\b(going to|will|leads to|results in|causes)\b/g)?.length ?? 0);
	const impactHits =
		(normalized.match(/\b(bad for|good for|harmful|benefit|hurts?|helps?|risk)\b/g)
			?.length ?? 0) +
		(normalized.match(/\b(customer|consumer|market|industry|treasury|sports|jobs)\b/g)
			?.length ?? 0);
	return causalHits >= 2 || (causalHits >= 1 && impactHits >= 2);
}

function hasStrongStanceLanguage(text: string): boolean {
	return /\b(i (think|believe|simply don't understand)|we need|must|no longer the case|the reality is|the decision)\b/i.test(
		text,
	);
}

function hasStrongLeadDespiteFiller(text: string): boolean {
	return containsConsequenceChain(text) || hasStrongStanceLanguage(text);
}

function reanchorWindow({
	units,
	startIndex,
	endIndex,
	minClipSeconds,
	maxClipSeconds,
}: {
	units: SentenceUnit[];
	startIndex: number;
	endIndex: number;
	minClipSeconds: number;
	maxClipSeconds: number;
}): { startIndex: number; endIndex: number } | null {
	let start = startIndex;
	let end = endIndex;
	for (let guard = 0; guard < 24; guard++) {
		const first = units[start];
		const last = units[end];
		if (!first || !last) return null;
		const duration = Math.max(0, last.end - first.start);
		if (duration < minClipSeconds) return null;
		const trimStart =
			start < end &&
			(startsLikeContinuation(first.text) ||
				isWeakLeadInText(first.text) ||
				startsWithContinuationFragment(first.text) ||
				isInterviewerSetup(first.text));
		const trimEnd =
			start < end && (!last.endsSentence || isWeakTailText(last.text));
		if (!trimStart && !trimEnd) {
			return { startIndex: start, endIndex: end };
		}
		if (trimStart && start > 0) {
			const expandedDuration = Math.max(
				0,
				(units[end]?.end ?? 0) - (units[start - 1]?.start ?? 0),
			);
			if (expandedDuration >= minClipSeconds && expandedDuration <= maxClipSeconds) {
				start -= 1;
				continue;
			}
		}
		if (trimEnd && end < units.length - 1) {
			const expandedDuration = Math.max(
				0,
				(units[end + 1]?.end ?? 0) - (units[start]?.start ?? 0),
			);
			if (expandedDuration >= minClipSeconds && expandedDuration <= maxClipSeconds) {
				end += 1;
				continue;
			}
		}
		if (trimStart) {
			const nextStart = start + 1;
			const nextDuration = Math.max(
				0,
				(units[end]?.end ?? 0) - (units[nextStart]?.start ?? 0),
			);
			if (nextStart <= end && nextDuration >= minClipSeconds) {
				start = nextStart;
				continue;
			}
		}
		if (trimEnd) {
			const nextEnd = end - 1;
			const nextDuration = Math.max(
				0,
				(units[nextEnd]?.end ?? 0) - (units[start]?.start ?? 0),
			);
			if (nextEnd >= start && nextDuration >= minClipSeconds) {
				end = nextEnd;
				continue;
			}
		}
		break;
	}
	return null;
}

function buildLocalWindowScore({
	units,
	startIndex,
	endIndex,
	duration,
	targetClipSeconds,
}: {
	units: SentenceUnit[];
	startIndex: number;
	endIndex: number;
	duration: number;
	targetClipSeconds: number;
}): number {
	const selected = units.slice(startIndex, endIndex + 1);
	const text = selected.map((unit) => unit.text).join(" ");
	const words = text.match(/\S+/g) ?? [];
	const wordsPerSecond = words.length / Math.max(1, duration);
	const first = selected[0];
	const last = selected[selected.length - 1];
	const fillerRatio = computeFillerRatio(text);

	let score = 40;
	score += Math.min(18, wordsPerSecond * 5.5);
	score += Math.max(0, 12 - Math.abs(duration - targetClipSeconds) * 0.5);

	const opener = openingWord(first?.text ?? "");
	if (startsLowercase(first?.text ?? "")) score -= 30;
	if (CONTEXT_OPENERS.has(opener)) score -= 22;
	if (!last?.endsSentence) score -= 34;
	if (/\b(and|but|so|then|because|which|or)\s*$/i.test(last?.text ?? "")) {
		score -= 24;
	}

	const hasQuestion = selected.some((unit) => unit.isQuestion || unit.hasQuestionCue);
	const hasAnswer = hasAnswerAfterQuestion({
		units,
		startIndex,
		endIndex,
	});
	const trailingUnanswered = hasTrailingUnansweredQuestion({
		units,
		startIndex,
		endIndex,
	});
	const lateUnits = selected.slice(Math.max(0, selected.length - 2));
	const hasLateQuestionCue = lateUnits.some((unit) =>
		containsQuestionCue(unit.text),
	);
	const tailHasInterviewerSetup = lateUnits.some((unit) =>
		isInterviewerSetup(unit.text),
	);
	const answerAfterLastQuestionDuration = answerDurationAfterLastQuestion({
		units,
		startIndex,
		endIndex,
	});
	if (hasQuestion && !hasAnswer) score -= 45;
	if ((first?.isQuestion || first?.hasQuestionCue) && !hasAnswer) score -= 18;
	if (trailingUnanswered) score -= 40;
	if (hasLateQuestionCue && !hasAnswer) score -= 30;
	if (hasLateQuestionCue && answerAfterLastQuestionDuration < 6) score -= 20;
	if (tailHasInterviewerSetup) score -= 22;
	if (containsQuestionCue(text) && !hasAnswer) score -= 45;
	if (isInterviewerSetup(first?.text ?? "")) score -= 22;
	if (fillerRatio > 1.6) score -= 14;
	if (fillerRatio > 2.3) score -= 18;

	const hasContrast = /\b(but|however|that said|and so|so)\b/i.test(text);
	if (hasContrast) score += 6;
	if (containsAnalogy(text)) score += 22;
	if (containsConsequenceChain(text)) score += 14;
	if (hasStrongStanceLanguage(text)) score += 8;
	if (containsConsequenceChain(text) && hasStrongStanceLanguage(text)) score += 8;

	return clamp(score, 0, 100);
}

function buildWindowCandidatesFromSentenceUnits({
	units,
	minClipSeconds,
	maxClipSeconds,
	targetClipSeconds,
}: {
	units: SentenceUnit[];
	minClipSeconds: number;
	maxClipSeconds: number;
	targetClipSeconds: number;
}): Array<{
	startIndex: number;
	endIndex: number;
	startTime: number;
	endTime: number;
	duration: number;
	localScore: number;
	transcriptSnippet: string;
}> {
	const candidates: Array<{
		startIndex: number;
		endIndex: number;
		startTime: number;
		endTime: number;
		duration: number;
		localScore: number;
		transcriptSnippet: string;
	}> = [];
	const seenWindowKeys = new Set<string>();

	for (let i = 0; i < units.length; i++) {
		let bestForStart:
			| {
					startIndex: number;
					endIndex: number;
					startTime: number;
					endTime: number;
					duration: number;
					localScore: number;
					transcriptSnippet: string;
			  }
			| null = null;

		for (let j = i; j < units.length; j++) {
			const anchored = reanchorWindow({
				units,
				startIndex: i,
				endIndex: j,
				minClipSeconds,
				maxClipSeconds,
			});
			if (!anchored) continue;
			const key = `${anchored.startIndex}:${anchored.endIndex}`;
			if (seenWindowKeys.has(key)) continue;
			seenWindowKeys.add(key);

			const first = units[anchored.startIndex];
			const last = units[anchored.endIndex];
			if (!first || !last) continue;
			if (startsLikeContinuation(first.text)) continue;
			if (!last.endsSentence) continue;
			if (isInterviewerSetup(first.text)) continue;

			const startTime = first.start;
			const endTime = last.end;
			const duration = Math.max(0, endTime - startTime);
			if (duration < minClipSeconds) continue;
			if (duration > maxClipSeconds) break;

			const selected = units.slice(anchored.startIndex, anchored.endIndex + 1);
			const questionCount = selected.filter(
				(unit) => unit.isQuestion || unit.hasQuestionCue,
			).length;
			const hasAnswer = hasAnswerAfterQuestion({
				units,
				startIndex: anchored.startIndex,
				endIndex: anchored.endIndex,
			});
			const trailingUnanswered = hasTrailingUnansweredQuestion({
				units,
				startIndex: anchored.startIndex,
				endIndex: anchored.endIndex,
			});
			const hasLateQuestionCue = selected
				.slice(Math.max(0, selected.length - 2))
				.some((unit) => containsQuestionCue(unit.text));
			const tailHasInterviewerSetup = selected
				.slice(Math.max(0, selected.length - 2))
				.some((unit) => isInterviewerSetup(unit.text));
			const answerAfterLastQuestionDuration = answerDurationAfterLastQuestion({
				units,
				startIndex: anchored.startIndex,
				endIndex: anchored.endIndex,
			});
			const snippetText = selected.map((unit) => unit.text).join(" ");
			if (isWeakLeadInText(first.text) && !hasStrongLeadDespiteFiller(snippetText)) {
				continue;
			}
			if (questionCount > 0 && !hasAnswer) {
				continue;
			}
			if (trailingUnanswered) {
				continue;
			}
			if (hasLateQuestionCue && !hasAnswer) {
				continue;
			}
			if (hasLateQuestionCue && answerAfterLastQuestionDuration < 6) {
				continue;
			}
			if (tailHasInterviewerSetup) {
				continue;
			}
			if (
				containsQuestionCue(snippetText) &&
				/\b(how do|what is|can you|my question is)\s*$/i.test(snippetText)
			) {
				continue;
			}
			if (selected.some((unit) => isInterviewerSetup(unit.text)) && !hasAnswer) {
				continue;
			}
			if (computeFillerRatio(snippetText) > 2.8) {
				continue;
			}

			const localScore = buildLocalWindowScore({
				units,
				startIndex: anchored.startIndex,
				endIndex: anchored.endIndex,
				duration,
				targetClipSeconds,
			});
			const transcriptSnippet = buildSnippetFromUnits({
				units,
				startIndex: anchored.startIndex,
				endIndex: anchored.endIndex,
			});
			const candidate = {
				startIndex: anchored.startIndex,
				endIndex: anchored.endIndex,
				startTime,
				endTime,
				duration,
				localScore,
				transcriptSnippet,
			};
			if (!bestForStart) {
				bestForStart = candidate;
				continue;
			}
			const betterScore = candidate.localScore > bestForStart.localScore + 0.5;
			const scoreTie =
				Math.abs(candidate.localScore - bestForStart.localScore) <= 0.5;
			const closerToTarget =
				Math.abs(candidate.duration - targetClipSeconds) <
				Math.abs(bestForStart.duration - targetClipSeconds);
			if (betterScore || (scoreTie && closerToTarget)) {
				bestForStart = candidate;
			}
		}

		if (bestForStart) {
			candidates.push(bestForStart);
		}
	}

	return candidates;
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
	const units = buildSentenceUnitsFromSegments({
		segments,
		mediaDuration,
	});
	if (units.length === 0) return [];

	const rawCandidates = buildWindowCandidatesFromSentenceUnits({
		units,
		minClipSeconds,
		maxClipSeconds,
		targetClipSeconds,
	});
	if (rawCandidates.length === 0) return [];

	const deduped: ClipCandidateDraft[] = [];
	for (const candidate of rawCandidates.sort((a, b) => b.localScore - a.localScore)) {
		const duplicate = deduped.some(
			(existing) =>
				overlapRatio({
					aStart: candidate.startTime,
					aEnd: candidate.endTime,
					bStart: existing.startTime,
					bEnd: existing.endTime,
				}) > 0.9,
		);
		if (duplicate) continue;
		deduped.push({
			id: generateUUID(),
			startTime: roundToHundredth(candidate.startTime),
			endTime: roundToHundredth(candidate.endTime),
			duration: roundToHundredth(candidate.duration),
			transcriptSnippet: candidate.transcriptSnippet,
			localScore: candidate.localScore,
		});
		if (deduped.length >= maxOutput) break;
	}

	return deduped;
}
