import type { VideoElement } from "@/types/timeline";
import type { TranscriptEditWord } from "@/types/transcription";

const SEGMENT_GAP_SECONDS = 1.15;

function endsSentence(text: string): boolean {
	return /[.!?]["')\]]*$/.test(text.trim());
}

export function formatSpeakerLabel({
	speakerId,
}: {
	speakerId?: string;
}): string | undefined {
	if (typeof speakerId !== "string" || speakerId.trim().length === 0) {
		return undefined;
	}
	const normalized = speakerId.trim();
	const trailingNumberMatch = normalized.match(/(\d+)$/);
	if (trailingNumberMatch) {
		return `Speaker ${Number.parseInt(trailingNumberMatch[1] ?? "0", 10) + 1}`;
	}
	return normalized
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());
}

export function buildDefaultTranscriptSegmentsUi({
	elementId,
	words,
}: {
	elementId: string;
	words: NonNullable<VideoElement["transcriptDraft"]>["words"];
}): NonNullable<VideoElement["transcriptDraft"]>["segmentsUi"] {
	if (words.length === 0) return [];
	const segments: Array<{
		wordStartIndex: number;
		wordEndIndex: number;
		label?: string;
	}> = [];
	let segmentStart = 0;

	for (let index = 0; index < words.length - 1; index++) {
		const current = words[index];
		const next = words[index + 1];
		if (!current || !next) continue;
		const gap = Math.max(0, next.startTime - current.endTime);
		const speakerChanged =
			typeof current.speakerId === "string" &&
			typeof next.speakerId === "string" &&
			current.speakerId.trim().length > 0 &&
			next.speakerId.trim().length > 0 &&
			current.speakerId !== next.speakerId;
		if (gap >= SEGMENT_GAP_SECONDS || endsSentence(current.text) || speakerChanged) {
			segments.push({
				wordStartIndex: segmentStart,
				wordEndIndex: index,
				label: formatSpeakerLabel({
					speakerId: words[segmentStart]?.speakerId,
				}),
			});
			segmentStart = index + 1;
		}
	}

	segments.push({
		wordStartIndex: segmentStart,
		wordEndIndex: words.length - 1,
		label: formatSpeakerLabel({
			speakerId: words[segmentStart]?.speakerId,
		}),
	});

	return segments.map((segment, index) => ({
		id: `${elementId}:seg:${index}`,
		wordStartIndex: segment.wordStartIndex,
		wordEndIndex: segment.wordEndIndex,
		label: segment.label,
	}));
}

export function buildDefaultTranscriptWordGroups({
	words,
}: {
	words: TranscriptEditWord[];
}): Array<{
	id: string;
	words: TranscriptEditWord[];
	label?: string;
	speakerId?: string;
}> {
	const segmentsUi =
		buildDefaultTranscriptSegmentsUi({
			elementId: "auto",
			words,
		}) ?? [];
	return segmentsUi
		.map((segment) => ({
			id: segment.id,
			label: segment.label,
			speakerId: words[segment.wordStartIndex]?.speakerId,
			words: words.slice(segment.wordStartIndex, segment.wordEndIndex + 1),
		}))
		.filter((group) => group.words.length > 0);
}
