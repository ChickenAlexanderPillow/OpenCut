import { buildClipCandidatesFromTranscript } from "@/lib/clips/candidate-builder";
import {
	buildSemanticChunksFromTranscript,
	type SemanticTranscriptChunk,
} from "@/lib/clips/v2/semantic-chunking";
import type { ClipCandidateDraft } from "@/types/clip-generation";
import type { TranscriptionSegment } from "@/types/transcription";

const DEFAULT_MAX_OUTPUT = 18;
const DEFAULT_GLOBAL_POOL_MULTIPLIER = 6;
const V2_INTERNAL_MAX_OVERLAP_RATIO = 0.72;

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

function chunkCoverageScore({
	chunk,
	startTime,
	endTime,
}: {
	chunk: SemanticTranscriptChunk;
	startTime: number;
	endTime: number;
}): number {
	const intersection = Math.max(
		0,
		Math.min(endTime, chunk.end) - Math.max(startTime, chunk.start),
	);
	const duration = Math.max(0.001, endTime - startTime);
	return intersection / duration;
}

function midpoint(startTime: number, endTime: number): number {
	return startTime + (endTime - startTime) / 2;
}

function getChunkIndexForCandidate({
	chunks,
	startTime,
	endTime,
}: {
	chunks: SemanticTranscriptChunk[];
	startTime: number;
	endTime: number;
}): number {
	const mid = midpoint(startTime, endTime);
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (mid >= chunk.start && mid <= chunk.end) return i;
	}
	return -1;
}

export function buildClipCandidatesFromTranscriptV2({
	segments,
	mediaDuration,
	minClipSeconds = 20,
	maxClipSeconds = 65,
	targetClipSeconds = 36,
	maxOutput = DEFAULT_MAX_OUTPUT,
}: {
	segments: TranscriptionSegment[];
	mediaDuration: number;
	minClipSeconds?: number;
	maxClipSeconds?: number;
	targetClipSeconds?: number;
	maxOutput?: number;
}): ClipCandidateDraft[] {
	const poolSize = Math.max(
		maxOutput,
		Math.max(40, maxOutput * DEFAULT_GLOBAL_POOL_MULTIPLIER),
	);
	const globalCandidates = buildClipCandidatesFromTranscript({
		segments,
		mediaDuration,
		minClipSeconds,
		maxClipSeconds,
		targetClipSeconds,
		maxOutput: poolSize,
	});
	if (globalCandidates.length === 0) return [];

	const chunks = buildSemanticChunksFromTranscript({
		segments,
		mediaDuration,
	});
	if (chunks.length === 0) {
		return globalCandidates.slice(0, maxOutput);
	}

	const maxPerChunk = Math.max(2, Math.ceil(maxOutput / 2));
	const ranked = globalCandidates
		.map((candidate) => {
			const chunkIndex = getChunkIndexForCandidate({
				chunks,
				startTime: candidate.startTime,
				endTime: candidate.endTime,
			});
			const chunk = chunkIndex >= 0 ? chunks[chunkIndex] : null;
			const coverage = chunk
				? chunkCoverageScore({
						chunk,
						startTime: candidate.startTime,
						endTime: candidate.endTime,
					})
				: 0;
			const coherenceBoost = Math.round(coverage * 10);
			const coherencePenalty = coverage < 0.72 ? 8 : 0;
			return {
				...candidate,
				_rankScore: candidate.localScore + coherenceBoost - coherencePenalty,
				_chunkIndex: chunkIndex,
			};
		})
		.sort((a, b) => {
			if (b._rankScore !== a._rankScore) return b._rankScore - a._rankScore;
			if (b.localScore !== a.localScore) return b.localScore - a.localScore;
			return a.startTime - b.startTime;
		});

	const selected: ClipCandidateDraft[] = [];
	const countByChunk = new Map<number, number>();
	const selectedIds = new Set<string>();

	// Coverage pass: keep at least one strong candidate from each semantic chunk.
	const bestByChunk = new Map<number, (typeof ranked)[number]>();
	for (const candidate of ranked) {
		if (candidate._chunkIndex < 0) continue;
		const existing = bestByChunk.get(candidate._chunkIndex);
		if (!existing) {
			bestByChunk.set(candidate._chunkIndex, candidate);
			continue;
		}
		if (candidate._rankScore > existing._rankScore) {
			bestByChunk.set(candidate._chunkIndex, candidate);
		}
	}
	const coverageSeeds = Array.from(bestByChunk.values()).sort((a, b) => {
		if (b._rankScore !== a._rankScore) return b._rankScore - a._rankScore;
		if (b.localScore !== a.localScore) return b.localScore - a.localScore;
		return a.startTime - b.startTime;
	});

	for (const candidate of coverageSeeds) {
		const overlap = selected.some(
			(existing) =>
				overlapRatio({
					aStart: candidate.startTime,
					aEnd: candidate.endTime,
					bStart: existing.startTime,
					bEnd: existing.endTime,
				}) > V2_INTERNAL_MAX_OVERLAP_RATIO,
		);
		if (overlap) continue;
		selected.push({
			id: candidate.id,
			startTime: candidate.startTime,
			endTime: candidate.endTime,
			duration: candidate.duration,
			transcriptSnippet: candidate.transcriptSnippet,
			localScore: candidate._rankScore,
		});
		selectedIds.add(candidate.id);
		const chunkCount = countByChunk.get(candidate._chunkIndex) ?? 0;
		countByChunk.set(candidate._chunkIndex, chunkCount + 1);
		if (selected.length >= maxOutput) break;
	}

	for (const candidate of ranked) {
		if (selectedIds.has(candidate.id)) continue;
		const overlap = selected.some(
			(existing) =>
				overlapRatio({
					aStart: candidate.startTime,
					aEnd: candidate.endTime,
					bStart: existing.startTime,
					bEnd: existing.endTime,
				}) > V2_INTERNAL_MAX_OVERLAP_RATIO,
		);
		if (overlap) continue;
		const chunkCount = countByChunk.get(candidate._chunkIndex) ?? 0;
		if (candidate._chunkIndex >= 0 && chunkCount >= maxPerChunk) continue;
		selected.push({
			id: candidate.id,
			startTime: candidate.startTime,
			endTime: candidate.endTime,
			duration: candidate.duration,
			transcriptSnippet: candidate.transcriptSnippet,
			localScore: candidate._rankScore,
		});
		selectedIds.add(candidate.id);
		if (candidate._chunkIndex >= 0) {
			countByChunk.set(candidate._chunkIndex, chunkCount + 1);
		}
		if (selected.length >= maxOutput) break;
	}

	if (selected.length > 0) return selected;
	return globalCandidates.slice(0, maxOutput);
}
