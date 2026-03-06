import {
	applyCutRangesToWords,
	buildCaptionPayloadFromTranscriptWords,
	buildTranscriptCutsFromWords,
	mapCompressedTimeToSourceTime,
	mapSourceTimeToCompressedTime,
	mergeCutRanges,
	normalizeTranscriptWords,
} from "@/lib/transcript-editor/core";
import type { TextElement } from "@/types/timeline";
import type { TranscriptEditCutRange, TranscriptEditWord } from "@/types/transcription";

const MAX_SNAPSHOT_CACHE_ENTRIES = 300;
const snapshotCache = new Map<string, TranscriptTimelineSnapshot>();

function isTranscriptAlreadyTimelineAligned({
	words,
	mediaStartTime,
	mediaDuration,
}: {
	words: Array<{ startTime: number; endTime: number }>;
	mediaStartTime: number;
	mediaDuration: number;
}): boolean {
	if (words.length === 0) return false;
	const minStart = Math.min(...words.map((word) => word.startTime));
	const maxEnd = Math.max(...words.map((word) => word.endTime));
	const epsilon = 0.05;
	const durationSlack = 0.35;
	const looksLocal =
		minStart >= -epsilon && maxEnd <= mediaDuration + durationSlack;
	const looksTimeline =
		minStart >= mediaStartTime - epsilon &&
		maxEnd <= mediaStartTime + mediaDuration + durationSlack;
	return looksTimeline && !looksLocal;
}

export function resolveEffectiveTranscriptCuts({
	words,
	cuts,
}: {
	words: TranscriptEditWord[];
	cuts: TranscriptEditCutRange[];
}): TranscriptEditCutRange[] {
	const derivedWordCuts = buildTranscriptCutsFromWords({ words });
	const hasExplicitRemovedWords = words.some((word) => Boolean(word.removed));
	const legacyNonPauseCuts = hasExplicitRemovedWords
		? []
		: cuts.filter((cut) => cut.reason !== "pause");
	const pauseCuts = cuts.filter((cut) => cut.reason === "pause");
	return mergeCutRanges({
		cuts: [...derivedWordCuts, ...legacyNonPauseCuts, ...pauseCuts],
	});
}

export function getEffectiveTranscriptCutsFromTranscriptEdit({
	transcriptEdit,
}: {
	transcriptEdit?:
		| {
				words: TranscriptEditWord[];
				cuts: TranscriptEditCutRange[];
		  }
		| null;
}): TranscriptEditCutRange[] {
	if (!transcriptEdit || transcriptEdit.words.length === 0) return [];
	return resolveEffectiveTranscriptCuts({
		words: transcriptEdit.words,
		cuts: transcriptEdit.cuts,
	});
}

function getRevisionKey({
	mediaElementId,
	updatedAt,
	words,
	effectiveCuts,
}: {
	mediaElementId: string;
	updatedAt: string;
	words: TranscriptEditWord[];
	effectiveCuts: TranscriptEditCutRange[];
}): string {
	let hash = 0x811c9dc5;
	const updateHash = (value: string): void => {
		for (let index = 0; index < value.length; index++) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193);
		}
	};

	updateHash(mediaElementId);
	updateHash(updatedAt);
	updateHash(String(words.length));
	for (const word of words) {
		updateHash(word.id);
		updateHash(word.text);
		updateHash(word.startTime.toFixed(4));
		updateHash(word.endTime.toFixed(4));
		updateHash(word.removed ? "1" : "0");
	}
	updateHash(String(effectiveCuts.length));
	for (const cut of effectiveCuts) {
		updateHash(cut.start.toFixed(4));
		updateHash(cut.end.toFixed(4));
		updateHash(cut.reason);
	}
	return `${mediaElementId}:${(hash >>> 0).toString(16)}`;
}

function upsertSnapshotCache({
	key,
	snapshot,
}: {
	key: string;
	snapshot: TranscriptTimelineSnapshot;
}) {
	if (snapshotCache.has(key)) {
		snapshotCache.delete(key);
	}
	snapshotCache.set(key, snapshot);
	while (snapshotCache.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
		const oldestKey = snapshotCache.keys().next().value;
		if (!oldestKey) break;
		snapshotCache.delete(oldestKey);
	}
}

export type TranscriptTimelineSnapshot = {
	mediaElementId: string;
	updatedAt: string;
	transcriptVersion: number;
	revisionKey: string;
	words: TranscriptEditWord[];
	wordsWithCutState: TranscriptEditWord[];
	activeWords: TranscriptEditWord[];
	effectiveCuts: TranscriptEditCutRange[];
	captionPayload: {
		content: string;
		startTime: number;
		duration: number;
		wordTimings: Array<{ word: string; startTime: number; endTime: number }>;
	} | null;
	isTimelineAligned: boolean;
	timeMap: {
		toSourceTime: (compressedTime: number) => number;
		toCompressedTime: (sourceTime: number) => number;
	};
};

export function clearTranscriptTimelineSnapshotCache(): void {
	snapshotCache.clear();
}

export function buildTranscriptTimelineSnapshot({
	mediaElementId,
	transcriptVersion,
	updatedAt,
	words,
	cuts,
	mediaStartTime,
	mediaDuration,
}: {
	mediaElementId: string;
	transcriptVersion: number;
	updatedAt: string;
	words: TranscriptEditWord[];
	cuts: TranscriptEditCutRange[];
	mediaStartTime: number;
	mediaDuration: number;
}): TranscriptTimelineSnapshot {
	const normalizedWords = normalizeTranscriptWords({ words });
	const effectiveCuts = resolveEffectiveTranscriptCuts({
		words: normalizedWords,
		cuts,
	});
	const revisionKey = getRevisionKey({
		mediaElementId,
		updatedAt,
		words: normalizedWords,
		effectiveCuts,
	});
	const cached = snapshotCache.get(revisionKey);
	if (cached) {
		upsertSnapshotCache({ key: revisionKey, snapshot: cached });
		return cached;
	}

	const wordsWithCutState = applyCutRangesToWords({
		words: normalizedWords,
		cuts: effectiveCuts,
	});
	const activeWords = wordsWithCutState.filter((word) => !word.removed);
	const compressedPayload = buildCaptionPayloadFromTranscriptWords({
		words: normalizedWords,
		cuts: effectiveCuts,
	});
	const isTimelineAligned = isTranscriptAlreadyTimelineAligned({
		words: normalizedWords,
		mediaStartTime,
		mediaDuration,
	});
	const captionPayload = !compressedPayload
		? null
		: isTimelineAligned
			? compressedPayload
			: {
					content: compressedPayload.content,
					startTime: mediaStartTime + compressedPayload.startTime,
					duration: compressedPayload.duration,
					wordTimings: compressedPayload.wordTimings.map((timing) => ({
						word: timing.word,
						startTime: mediaStartTime + timing.startTime,
						endTime: mediaStartTime + timing.endTime,
					})),
				};

	const snapshot: TranscriptTimelineSnapshot = {
		mediaElementId,
		transcriptVersion,
		updatedAt,
		revisionKey,
		words: normalizedWords,
		wordsWithCutState,
		activeWords,
		effectiveCuts,
		captionPayload,
		isTimelineAligned,
		timeMap: {
			toSourceTime: (compressedTime: number) =>
				mapCompressedTimeToSourceTime({
					compressedTime,
					cuts: effectiveCuts,
				}),
			toCompressedTime: (sourceTime: number) =>
				mapSourceTimeToCompressedTime({
					sourceTime,
					cuts: effectiveCuts,
				}),
		},
	};
	upsertSnapshotCache({ key: revisionKey, snapshot });
	return snapshot;
}

export type CaptionSnapshotValidationResult =
	| { valid: true }
	| {
			valid: false;
			reason:
				| "missing-source-ref"
				| "source-ref-mismatch"
				| "content-mismatch"
				| "timing-count-mismatch"
				| "timing-mismatch"
				| "transcript-version-mismatch";
	  };

export function validateCaptionAgainstSnapshot({
	captionElement,
	snapshot,
}: {
	captionElement: TextElement;
	snapshot: TranscriptTimelineSnapshot;
}): CaptionSnapshotValidationResult {
	const sourceMediaId = captionElement.captionSourceRef?.mediaElementId;
	if (!sourceMediaId) {
		return { valid: false, reason: "missing-source-ref" };
	}
	if (sourceMediaId !== snapshot.mediaElementId) {
		return { valid: false, reason: "source-ref-mismatch" };
	}
	if (
		typeof captionElement.captionSourceRef?.transcriptVersion === "number" &&
		captionElement.captionSourceRef.transcriptVersion !== snapshot.transcriptVersion
	) {
		return { valid: false, reason: "transcript-version-mismatch" };
	}

	const expected = snapshot.captionPayload;
	if (!expected) {
		const hasCaptionData = (captionElement.captionWordTimings?.length ?? 0) > 0;
		if (hasCaptionData || captionElement.content.trim().length > 0) {
			return { valid: false, reason: "timing-count-mismatch" };
		}
		return { valid: true };
	}

	if (captionElement.content.trim() !== expected.content.trim()) {
		return { valid: false, reason: "content-mismatch" };
	}

	const actualTimings = captionElement.captionWordTimings ?? [];
	if (actualTimings.length !== expected.wordTimings.length) {
		return { valid: false, reason: "timing-count-mismatch" };
	}
	for (let index = 0; index < actualTimings.length; index++) {
		const actual = actualTimings[index];
		const expectedTiming = expected.wordTimings[index];
		if (!actual || !expectedTiming) {
			return { valid: false, reason: "timing-mismatch" };
		}
		if (actual.word !== expectedTiming.word) {
			return { valid: false, reason: "timing-mismatch" };
		}
		if (Math.abs(actual.startTime - expectedTiming.startTime) > 0.02) {
			return { valid: false, reason: "timing-mismatch" };
		}
		if (Math.abs(actual.endTime - expectedTiming.endTime) > 0.02) {
			return { valid: false, reason: "timing-mismatch" };
		}
	}

	return { valid: true };
}
