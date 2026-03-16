import type { AudioClipSource } from "@/lib/media/audio";
import { getTrackAudioEffectsFingerprint } from "@/lib/media/track-audio-effects";

export interface AudioGraphRevision {
	fingerprint: string;
	clipSignatures: Map<string, string>;
}

export interface AudioGraphDiff {
	addedClipIds: Set<string>;
	removedClipIds: Set<string>;
	updatedClipIds: Set<string>;
	changedClipIds: Set<string>;
	structuralChangedClipIds: Set<string>;
	gainOnlyClipIds: Set<string>;
}

function hashString(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function buildClipSignature(clip: AudioClipSource): string {
	return [
		clip.id,
		clip.trackId,
		clip.sourceKey,
		clip.mediaIdentity.id,
		clip.mediaIdentity.type,
		clip.mediaIdentity.size,
		clip.mediaIdentity.lastModified,
		clip.startTime.toFixed(4),
		clip.duration.toFixed(4),
		clip.trimStart.toFixed(4),
		clip.trimEnd.toFixed(4),
		clip.muted ? "1" : "0",
		clip.gain.toFixed(4),
		clip.trackGain.toFixed(4),
		getTrackAudioEffectsFingerprint(clip.trackAudioEffects),
		clip.transcriptRevision,
	]
		.map((part) => String(part))
		.join("|");
}

export function buildAudioGraphRevision({
	clips,
}: {
	clips: AudioClipSource[];
}): AudioGraphRevision {
	const clipSignatures = new Map<string, string>();
	for (const clip of clips) {
		clipSignatures.set(clip.id, buildClipSignature(clip));
	}
	const aggregate = Array.from(clipSignatures.entries())
		.sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
		.map(([id, signature]) => `${id}:${signature}`)
		.join("||");

	return {
		fingerprint: `${clips.length}:${hashString(aggregate)}`,
		clipSignatures,
	};
}

export function diffAudioGraphRevisions({
	previous,
	next,
}: {
	previous: AudioGraphRevision | null;
	next: AudioGraphRevision;
}): AudioGraphDiff {
	const addedClipIds = new Set<string>();
	const removedClipIds = new Set<string>();
	const updatedClipIds = new Set<string>();

	if (!previous) {
		for (const clipId of next.clipSignatures.keys()) {
			addedClipIds.add(clipId);
		}
		return {
			addedClipIds,
			removedClipIds,
			updatedClipIds,
			changedClipIds: new Set(addedClipIds),
			structuralChangedClipIds: new Set(addedClipIds),
			gainOnlyClipIds: new Set(),
		};
	}

	for (const [clipId, signature] of next.clipSignatures.entries()) {
		const previousSignature = previous.clipSignatures.get(clipId);
		if (!previousSignature) {
			addedClipIds.add(clipId);
			continue;
		}
		if (previousSignature !== signature) {
			updatedClipIds.add(clipId);
		}
	}

	for (const clipId of previous.clipSignatures.keys()) {
		if (!next.clipSignatures.has(clipId)) {
			removedClipIds.add(clipId);
		}
	}

	const changedClipIds = new Set<string>([
		...addedClipIds,
		...removedClipIds,
		...updatedClipIds,
	]);
	return {
		addedClipIds,
		removedClipIds,
		updatedClipIds,
		changedClipIds,
		structuralChangedClipIds: new Set(changedClipIds),
		gainOnlyClipIds: new Set(),
	};
}
