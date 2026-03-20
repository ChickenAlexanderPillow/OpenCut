import {
	buildTranscriptGapCuts,
	buildCompressedCutBoundaryTimes,
	buildTranscriptCutsFromWords,
	computeKeepDuration,
	mergeCutRanges,
	normalizeTranscriptWords,
	type TranscriptEditState,
} from "@/lib/transcript-editor/core";
import {
	buildTranscriptTimelineSnapshot,
	type TranscriptTimelineSnapshot,
} from "@/lib/transcript-editor/snapshot";
import type { AudioElement, VideoElement } from "@/types/timeline";
import type {
	TranscriptAppliedSegment,
	TranscriptAppliedState,
	TranscriptCompileState,
	TranscriptDraftState,
	TranscriptEditCutRange,
	TranscriptEditWord,
} from "@/types/transcription";

type TranscriptEditableElement = VideoElement | AudioElement;

function getLegacyTranscriptDraft(
	element: TranscriptEditableElement,
): TranscriptDraftState | undefined {
	const legacy = element.transcriptEdit;
	if (!legacy) return undefined;
	return {
		version: 1,
		source: "word-level",
		words: legacy.words,
		cuts: legacy.cuts,
		cutTimeDomain: legacy.cutTimeDomain,
		projectionSource: legacy.projectionSource,
		segmentsUi: legacy.segmentsUi,
		speakerLabels: legacy.speakerLabels,
		gapEdits: legacy.gapEdits,
		updatedAt: legacy.updatedAt,
	};
}

export function getTranscriptDraft(
	element: TranscriptEditableElement,
): TranscriptDraftState | undefined {
	return element.transcriptDraft ?? getLegacyTranscriptDraft(element);
}

export function getTranscriptCompileState(
	element: TranscriptEditableElement,
): TranscriptCompileState {
	return (
		element.transcriptCompileState ?? {
			status: "idle",
			updatedAt: element.transcriptApplied?.updatedAt ?? element.transcriptDraft?.updatedAt,
		}
	);
}

export function getTranscriptApplied(
	element: TranscriptEditableElement,
): TranscriptAppliedState | undefined {
	const draft = getTranscriptDraft(element);
	const applied = element.transcriptApplied;
	if (
		applied &&
		draft &&
		applied.updatedAt === draft.updatedAt &&
		applied.version === draft.version
	) {
		return applied;
	}
	if (applied && !draft) return applied;
	if (!draft || draft.words.length === 0) return undefined;
	return compileTranscriptDraft({
		mediaElementId: element.id,
		draft,
		mediaStartTime: element.startTime,
		mediaDuration: element.duration,
	});
}

export function getTranscriptRemovedRanges(
	element: TranscriptEditableElement,
): TranscriptEditCutRange[] {
	return getTranscriptApplied(element)?.removedRanges ?? [];
}

export function getTranscriptRevisionKey(
	element: TranscriptEditableElement,
): string {
	return getTranscriptApplied(element)?.revisionKey ?? "";
}

export function getTranscriptAudioRevisionKey(
	element: TranscriptEditableElement,
): string {
	const applied = getTranscriptApplied(element);
	if (!applied) return "";
	const parts = [String(applied.version), String(applied.removedRanges.length)];
	for (const cut of applied.removedRanges) {
		parts.push(cut.start.toFixed(4), cut.end.toFixed(4), cut.reason);
	}
	return parts.join("|");
}

function buildKeptSegments({
	sourceDuration,
	removedRanges,
}: {
	sourceDuration: number;
	removedRanges: TranscriptEditCutRange[];
}): TranscriptAppliedSegment[] {
	const merged = mergeCutRanges({ cuts: removedRanges });
	const segments: TranscriptAppliedSegment[] = [];
	let cursor = 0;
	for (const cut of merged) {
		if (cut.start > cursor) {
			segments.push({
				start: cursor,
				end: cut.start,
				duration: cut.start - cursor,
			});
		}
		cursor = Math.max(cursor, cut.end);
	}
	if (sourceDuration > cursor) {
		segments.push({
			start: cursor,
			end: sourceDuration,
			duration: sourceDuration - cursor,
		});
	}
	return segments.filter((segment) => segment.duration > 0.0001);
}

function getSourceDuration({
	words,
	fallbackDuration,
}: {
	words: TranscriptEditWord[];
	fallbackDuration: number;
}): number {
	const lastWordEnd = words[words.length - 1]?.endTime ?? 0;
	return Math.max(fallbackDuration, lastWordEnd);
}

export function compileTranscriptDraft({
	mediaElementId,
	draft,
	mediaStartTime,
	mediaDuration,
}: {
	mediaElementId: string;
	draft: TranscriptDraftState;
	mediaStartTime: number;
	mediaDuration: number;
}): TranscriptAppliedState {
	const normalizedWords = normalizeTranscriptWords({ words: draft.words });
	const normalizedCuts =
		draft.cuts.length > 0 || draft.gapEdits
			? mergeCutRanges({
					cuts: [
						...(draft.cuts.length > 0
							? draft.cuts
							: buildTranscriptCutsFromWords({ words: normalizedWords })),
						...buildTranscriptGapCuts({
							words: normalizedWords,
							gapEdits: draft.gapEdits,
						}),
					],
				})
			: buildTranscriptCutsFromWords({ words: normalizedWords });
	const snapshot: TranscriptTimelineSnapshot = buildTranscriptTimelineSnapshot({
		mediaElementId,
		transcriptVersion: draft.version,
		updatedAt: draft.updatedAt,
		words: normalizedWords,
		cuts: normalizedCuts,
		gapEdits: draft.gapEdits,
		mediaStartTime,
		mediaDuration,
	});
	const sourceDuration = getSourceDuration({
		words: normalizedWords,
		fallbackDuration: mediaDuration,
	});
	const playableDuration = computeKeepDuration({
		originalDuration: sourceDuration,
		cuts: snapshot.effectiveCuts,
	});
	return {
		version: 1,
		revisionKey: snapshot.revisionKey,
		updatedAt: draft.updatedAt,
		removedRanges: snapshot.effectiveCuts,
		keptSegments: buildKeptSegments({
			sourceDuration,
			removedRanges: snapshot.effectiveCuts,
		}),
		timeMap: {
			cutBoundaries: buildCompressedCutBoundaryTimes({
				cuts: snapshot.effectiveCuts,
			}),
			sourceDuration,
			playableDuration,
		},
		captionPayload: snapshot.captionPayload,
	};
}

export function withTranscriptState<
	TElement extends TranscriptEditableElement,
>({
	element,
	draft,
	applied,
	compileState,
}: {
	element: TElement;
	draft?: TranscriptDraftState;
	applied?: TranscriptAppliedState;
	compileState?: TranscriptCompileState;
}): TElement {
	return {
		...element,
		transcriptDraft: draft,
		transcriptApplied: applied,
		transcriptCompileState: compileState,
		transcriptEdit: draft
			? ({
					version: draft.version,
					source: draft.source,
					words: draft.words,
					cuts: draft.cuts,
					cutTimeDomain: draft.cutTimeDomain,
					projectionSource: draft.projectionSource,
					segmentsUi: draft.segmentsUi,
					speakerLabels: draft.speakerLabels,
					gapEdits: draft.gapEdits,
					updatedAt: draft.updatedAt,
			  } satisfies TranscriptEditState)
			: undefined,
	};
}
