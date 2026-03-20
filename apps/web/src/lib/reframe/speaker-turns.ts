import type { VideoElement, VideoReframeSwitch } from "@/types/timeline";
import type { TranscriptEditWord } from "@/types/transcription";
import { generateUUID } from "@/utils/id";

type SpeakerTurn = {
	speakerId: string;
	startTime: number;
	endTime: number;
};

const MIN_TURN_DURATION_SECONDS = 0.45;
const MERGE_GAP_SECONDS = 0.2;

function findPresetIdByIdentity({
	element,
	identity,
}: {
	element: VideoElement;
	identity: "left" | "right";
}): string | null {
	return (
		element.reframePresets?.find(
			(preset) => preset.subjectSeed?.identity === identity,
		)?.id ?? null
	);
}

function buildSpeakerTurns({
	words,
}: {
	words: TranscriptEditWord[];
}): SpeakerTurn[] {
	const relevantWords = words
		.filter(
			(word) =>
				!word.removed &&
				typeof word.speakerId === "string" &&
				word.speakerId.trim().length > 0,
		)
		.map((word) => ({
			speakerId: word.speakerId?.trim() ?? "",
			startTime: word.startTime,
			endTime: word.endTime,
		}))
		.sort((left, right) => left.startTime - right.startTime);
	if (relevantWords.length === 0) return [];
	const turns: SpeakerTurn[] = [];
	for (const word of relevantWords) {
		const previous = turns[turns.length - 1];
		if (
			previous &&
			previous.speakerId === word.speakerId &&
			word.startTime - previous.endTime <= MERGE_GAP_SECONDS
		) {
			previous.endTime = Math.max(previous.endTime, word.endTime);
			continue;
		}
		turns.push({ ...word });
	}
	return turns.filter(
		(turn) => turn.endTime - turn.startTime >= MIN_TURN_DURATION_SECONDS,
	);
}

export function buildSpeakerTurnReframeSwitches({
	element,
}: {
	element: VideoElement;
}): {
	switches: VideoReframeSwitch[];
	speakerOrder: string[];
	defaultPresetId: string;
} | null {
	const transcriptWords =
		element.transcriptDraft?.words ?? element.transcriptEdit?.words;
	if (!transcriptWords || transcriptWords.length === 0) return null;
	const leftPresetId = findPresetIdByIdentity({ element, identity: "left" });
	const rightPresetId = findPresetIdByIdentity({ element, identity: "right" });
	if (!leftPresetId || !rightPresetId) return null;
	const turns = buildSpeakerTurns({ words: transcriptWords });
	if (turns.length === 0) return null;
	const speakerOrder = Array.from(new Set(turns.map((turn) => turn.speakerId)));
	if (speakerOrder.length < 2) return null;
	const primarySpeakerId = speakerOrder[0];
	const secondarySpeakerId = speakerOrder[1];
	const firstTurn = turns[0];
	if (!primarySpeakerId || !secondarySpeakerId || !firstTurn) return null;
	const speakerToPresetId = new Map<string, string>([
		[primarySpeakerId, leftPresetId],
		[secondarySpeakerId, rightPresetId],
	]);
	const switches: VideoReframeSwitch[] = [];
	let activePresetId = speakerToPresetId.get(firstTurn.speakerId) ?? null;
	for (let index = 1; index < turns.length; index += 1) {
		const turn = turns[index];
		if (!turn) continue;
		const nextPresetId = speakerToPresetId.get(turn.speakerId) ?? null;
		if (!nextPresetId || nextPresetId === activePresetId) {
			continue;
		}
		switches.push({
			id: generateUUID(),
			time: Math.max(0, Math.min(element.duration, turn.startTime)),
			presetId: nextPresetId,
		});
		activePresetId = nextPresetId;
	}
	return {
		switches,
		speakerOrder: speakerOrder.slice(0, 2),
		defaultPresetId: speakerToPresetId.get(firstTurn.speakerId) ?? leftPresetId,
	};
}
