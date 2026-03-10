import { normalizeTranscriptWords } from "@/lib/transcript-editor/core";
import type { TranscriptEditWord } from "@/types/transcription";

export function buildTranscriptWordsFromCaptionTimings({
	mediaElementId,
	mediaStartTime,
	timings,
	idPrefix = "word",
}: {
	mediaElementId: string;
	mediaStartTime: number;
	timings: Array<{
		word: string;
		startTime: number;
		endTime: number;
		hidden?: boolean;
	}>;
	idPrefix?: string;
}): TranscriptEditWord[] {
	return normalizeTranscriptWords({
		words: timings.map((timing, index) => ({
			id: `${mediaElementId}:${idPrefix}:${index}:${timing.startTime.toFixed(3)}`,
			text: timing.word,
			// Caption timings are timeline absolute; transcript edit words are clip-local.
			startTime: Math.max(0, timing.startTime - mediaStartTime),
			endTime: Math.max(0.01, timing.endTime - mediaStartTime),
			removed: false,
			hidden: Boolean(timing.hidden),
		})),
	});
}
