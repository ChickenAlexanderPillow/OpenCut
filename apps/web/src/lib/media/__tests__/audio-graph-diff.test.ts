import { describe, expect, test } from "bun:test";
import {
	buildAudioGraphRevision,
	diffAudioGraphRevisions,
} from "@/lib/media/audio-graph-diff";
import type { AudioClipSource } from "@/lib/media/audio";
import { cloneDefaultTrackAudioEffects } from "@/lib/media/track-audio-effects";

function createClip(partial: Partial<AudioClipSource> & { id: string }): AudioClipSource {
	return {
		id: partial.id,
		sourceKey: partial.sourceKey ?? partial.id,
		trackId: partial.trackId ?? "track-1",
		file: partial.file ?? new File([new Uint8Array([1, 2, 3])], `${partial.id}.mp3`),
		mediaIdentity: partial.mediaIdentity ?? {
			id: partial.id,
			type: "audio",
			size: 3,
			lastModified: 1,
		},
		startTime: partial.startTime ?? 0,
		duration: partial.duration ?? 2,
		trimStart: partial.trimStart ?? 0,
		trimEnd: partial.trimEnd ?? 0,
		muted: partial.muted ?? false,
		gain: partial.gain ?? 1,
		trackGain: partial.trackGain ?? 1,
		trackAudioEffects: partial.trackAudioEffects ?? cloneDefaultTrackAudioEffects(),
		transcriptRevision: partial.transcriptRevision ?? "",
		transcriptCuts: partial.transcriptCuts ?? [],
	};
}

describe("audio graph diff", () => {
	test("marks mute toggles as targeted updates", () => {
		const before = buildAudioGraphRevision({
			clips: [createClip({ id: "clip-1", muted: false })],
		});
		const after = buildAudioGraphRevision({
			clips: [createClip({ id: "clip-1", muted: true })],
		});

		const diff = diffAudioGraphRevisions({ previous: before, next: after });
		expect(diff.addedClipIds.size).toBe(0);
		expect(diff.removedClipIds.size).toBe(0);
		expect(diff.updatedClipIds.has("clip-1")).toBe(true);
		expect(diff.changedClipIds.has("clip-1")).toBe(true);
	});

	test("marks transcript revision changes as targeted updates", () => {
		const before = buildAudioGraphRevision({
			clips: [createClip({ id: "clip-1", transcriptRevision: "rev-1" })],
		});
		const after = buildAudioGraphRevision({
			clips: [createClip({ id: "clip-1", transcriptRevision: "rev-2" })],
		});

		const diff = diffAudioGraphRevisions({ previous: before, next: after });
		expect(diff.updatedClipIds.has("clip-1")).toBe(true);
		expect(diff.changedClipIds.size).toBe(1);
	});
});
