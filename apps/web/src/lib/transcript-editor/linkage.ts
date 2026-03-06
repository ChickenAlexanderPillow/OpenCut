import type { TimelineElement } from "@/types/timeline";

const WORD_ID_MARKER = ":word:";

function remapWordIdPrefix({
	wordId,
	newMediaElementId,
}: {
	wordId: string;
	newMediaElementId: string;
}): string {
	const markerIndex = wordId.indexOf(WORD_ID_MARKER);
	if (markerIndex <= 0) return wordId;
	return `${newMediaElementId}${wordId.slice(markerIndex)}`;
}

export function remapTranscriptEditForClonedMedia({
	transcriptEdit,
	newMediaElementId,
}: {
	transcriptEdit:
		| {
				version: 1;
				source: "word-level";
				words: Array<{
					id: string;
					text: string;
					startTime: number;
					endTime: number;
					removed?: boolean;
					segmentId?: string;
				}>;
				cuts: Array<{ start: number; end: number; reason: "manual" | "filler" | "pause" }>;
				cutTimeDomain?: "clip-local-source" | "source-absolute";
				projectionSource?: {
					words: Array<{
						id: string;
						text: string;
						startTime: number;
						endTime: number;
						removed?: boolean;
						segmentId?: string;
					}>;
					cuts: Array<{ start: number; end: number; reason: "manual" | "filler" | "pause" }>;
					updatedAt: string;
					baseTrimStart: number;
				};
				segmentsUi?: Array<{
					id: string;
					wordStartIndex: number;
					wordEndIndex: number;
					label?: string;
				}>;
				updatedAt: string;
		  }
		| undefined;
	newMediaElementId: string;
}): typeof transcriptEdit {
	if (!transcriptEdit) return transcriptEdit;
	return {
		...transcriptEdit,
		cutTimeDomain: "clip-local-source",
		words: transcriptEdit.words.map((word) => ({
			...word,
			id: remapWordIdPrefix({
				wordId: word.id,
				newMediaElementId,
			}),
		})),
		projectionSource: transcriptEdit.projectionSource
			? {
					...transcriptEdit.projectionSource,
					words: transcriptEdit.projectionSource.words.map((word) => ({
						...word,
						id: remapWordIdPrefix({
							wordId: word.id,
							newMediaElementId,
						}),
					})),
			  }
			: transcriptEdit.projectionSource,
	};
}

export function remapLinkedReferencesForClonedElement({
	element,
	newElementId,
	clonedIdMap,
}: {
	element: TimelineElement;
	newElementId: string;
	clonedIdMap: Map<string, string>;
}): TimelineElement {
	if (element.type === "audio" || element.type === "video") {
		return {
			...element,
			id: newElementId,
			transcriptEdit: remapTranscriptEditForClonedMedia({
				transcriptEdit: element.transcriptEdit,
				newMediaElementId: newElementId,
			}),
		};
	}

	if (element.type === "text") {
		const linkedMediaId = element.captionSourceRef?.mediaElementId;
		const remappedMediaId = linkedMediaId
			? clonedIdMap.get(linkedMediaId)
			: undefined;
		return {
			...element,
			id: newElementId,
			captionSourceRef:
				linkedMediaId && remappedMediaId
					? {
							mediaElementId: remappedMediaId,
							transcriptVersion:
								element.captionSourceRef?.transcriptVersion ?? 1,
					  }
					: element.captionSourceRef,
		};
	}

	return {
		...element,
		id: newElementId,
	};
}
