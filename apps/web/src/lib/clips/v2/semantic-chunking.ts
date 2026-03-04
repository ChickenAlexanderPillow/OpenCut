import type { TranscriptionSegment } from "@/types/transcription";

const DEFAULT_MAX_TEMPORAL_GAP_SECONDS = 6;
const DEFAULT_MIN_CHUNK_SECONDS = 10;
const DEFAULT_MAX_CHUNK_SECONDS = 95;
const DEFAULT_SEMANTIC_SPLIT_THRESHOLD = 0.14;
const DEFAULT_MIN_TOKENS_FOR_SEMANTIC_SPLIT = 4;

const TOPIC_SHIFT_OPENERS = [
	"now",
	"next",
	"moving on",
	"on another note",
	"in other news",
	"switching gears",
	"let's talk about",
	"different topic",
	"however",
	"anyway",
];

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"for",
	"from",
	"has",
	"have",
	"he",
	"her",
	"here",
	"him",
	"his",
	"i",
	"in",
	"is",
	"it",
	"its",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"she",
	"that",
	"the",
	"their",
	"them",
	"there",
	"they",
	"this",
	"to",
	"us",
	"was",
	"we",
	"were",
	"with",
	"you",
	"your",
]);

export interface SemanticTranscriptChunk {
	start: number;
	end: number;
	duration: number;
	segments: TranscriptionSegment[];
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s']/gu, " ")
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function buildSparseVector(tokens: string[]): Map<string, number> {
	const vector = new Map<string, number>();
	for (const token of tokens) {
		vector.set(token, (vector.get(token) ?? 0) + 1);
	}
	return vector;
}

function addSparseVector({
	target,
	source,
}: {
	target: Map<string, number>;
	source: Map<string, number>;
}) {
	for (const [token, count] of source) {
		target.set(token, (target.get(token) ?? 0) + count);
	}
}

function cosineSimilarity({
	a,
	b,
}: {
	a: Map<string, number>;
	b: Map<string, number>;
}): number {
	if (a.size === 0 || b.size === 0) return 0;
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (const count of a.values()) {
		magA += count * count;
	}
	for (const count of b.values()) {
		magB += count * count;
	}
	for (const [token, countA] of a) {
		const countB = b.get(token) ?? 0;
		dot += countA * countB;
	}
	if (magA <= 0 || magB <= 0) return 0;
	return dot / Math.sqrt(magA * magB);
}

function startsWithTopicShiftCue(text: string): boolean {
	const normalized = text.toLowerCase().trim();
	if (!normalized) return false;
	return TOPIC_SHIFT_OPENERS.some(
		(cue) => normalized === cue || normalized.startsWith(`${cue} `),
	);
}

function mergeTinyChunks({
	chunks,
	minChunkSeconds,
}: {
	chunks: SemanticTranscriptChunk[];
	minChunkSeconds: number;
}): SemanticTranscriptChunk[] {
	if (chunks.length <= 1) return chunks;
	const merged: SemanticTranscriptChunk[] = [];

	for (const chunk of chunks) {
		const isTiny = chunk.duration < minChunkSeconds * 0.5;
		if (!isTiny || merged.length === 0) {
			merged.push(chunk);
			continue;
		}

		const previous = merged[merged.length - 1];
		if (!previous) {
			merged.push(chunk);
			continue;
		}

		merged[merged.length - 1] = {
			start: previous.start,
			end: Math.max(previous.end, chunk.end),
			duration: Math.max(previous.end, chunk.end) - previous.start,
			segments: [...previous.segments, ...chunk.segments],
		};
	}

	return merged;
}

export function buildSemanticChunksFromTranscript({
	segments,
	mediaDuration,
	maxTemporalGapSeconds = DEFAULT_MAX_TEMPORAL_GAP_SECONDS,
	minChunkSeconds = DEFAULT_MIN_CHUNK_SECONDS,
	maxChunkSeconds = DEFAULT_MAX_CHUNK_SECONDS,
	semanticSplitThreshold = DEFAULT_SEMANTIC_SPLIT_THRESHOLD,
	minTokensForSemanticSplit = DEFAULT_MIN_TOKENS_FOR_SEMANTIC_SPLIT,
}: {
	segments: TranscriptionSegment[];
	mediaDuration: number;
	maxTemporalGapSeconds?: number;
	minChunkSeconds?: number;
	maxChunkSeconds?: number;
	semanticSplitThreshold?: number;
	minTokensForSemanticSplit?: number;
}): SemanticTranscriptChunk[] {
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

	const chunks: SemanticTranscriptChunk[] = [];
	let currentSegments: TranscriptionSegment[] = [normalized[0]];
	let currentStart = normalized[0].start;
	let currentEnd = normalized[0].end;
	let currentVector = buildSparseVector(tokenize(normalized[0].text));

	for (let i = 1; i < normalized.length; i++) {
		const next = normalized[i];
		const nextTokens = tokenize(next.text);
		const nextVector = buildSparseVector(nextTokens);
		const gapSeconds = Math.max(0, next.start - currentEnd);
		const currentDuration = Math.max(0, currentEnd - currentStart);
		const lexicalSimilarity = cosineSimilarity({ a: currentVector, b: nextVector });

		const splitByTemporalGap = gapSeconds > maxTemporalGapSeconds;
		const splitByLength = currentDuration >= maxChunkSeconds;
		const splitBySemantics =
			currentDuration >= minChunkSeconds &&
			nextTokens.length >= minTokensForSemanticSplit &&
			lexicalSimilarity < semanticSplitThreshold;
		const splitByShiftCue =
			currentDuration >= minChunkSeconds &&
			startsWithTopicShiftCue(next.text) &&
			lexicalSimilarity < semanticSplitThreshold + 0.08;

		if (splitByTemporalGap || splitByLength || splitBySemantics || splitByShiftCue) {
			chunks.push({
				start: currentStart,
				end: currentEnd,
				duration: Math.max(0, currentEnd - currentStart),
				segments: currentSegments,
			});
			currentSegments = [next];
			currentStart = next.start;
			currentEnd = next.end;
			currentVector = nextVector;
			continue;
		}

		currentSegments.push(next);
		currentEnd = Math.max(currentEnd, next.end);
		addSparseVector({
			target: currentVector,
			source: nextVector,
		});
	}

	chunks.push({
		start: currentStart,
		end: currentEnd,
		duration: Math.max(0, currentEnd - currentStart),
		segments: currentSegments,
	});

	return mergeTinyChunks({
		chunks,
		minChunkSeconds,
	});
}

