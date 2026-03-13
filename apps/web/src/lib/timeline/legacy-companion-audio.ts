import type {
	AudioElement,
	UploadAudioElement,
	TScene,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";
import {
	compileTranscriptDraft,
	getTranscriptDraft,
	withTranscriptState,
} from "@/lib/transcript-editor/state";

const COMPANION_TOLERANCE_SECONDS = 0.05;

type CompanionMatch = {
	audioTrackIndex: number;
	audioElementIndex: number;
	videoTrackIndex: number;
	videoElementIndex: number;
};

function isUploadAudioElement(element: unknown): element is UploadAudioElement {
	return (
		typeof element === "object" &&
		element !== null &&
		"type" in element &&
		(element as { type?: unknown }).type === "audio" &&
		"sourceType" in element &&
		(element as { sourceType?: unknown }).sourceType === "upload"
	);
}

function isVideoElement(element: unknown): element is VideoElement {
	return (
		typeof element === "object" &&
		element !== null &&
		"type" in element &&
		(element as { type?: unknown }).type === "video"
	);
}

function isAlignedCompanionPair({
	videoElement,
	audioElement,
}: {
	videoElement: VideoElement;
	audioElement: AudioElement;
}): boolean {
	return (
		Math.abs(videoElement.startTime - audioElement.startTime) <=
			COMPANION_TOLERANCE_SECONDS &&
		Math.abs(videoElement.duration - audioElement.duration) <=
			COMPANION_TOLERANCE_SECONDS &&
		Math.abs(videoElement.trimStart - audioElement.trimStart) <=
			COMPANION_TOLERANCE_SECONDS &&
		Math.abs(videoElement.trimEnd - audioElement.trimEnd) <=
			COMPANION_TOLERANCE_SECONDS
	);
}

function findCompanionMatches({
	tracks,
}: {
	tracks: TimelineTrack[];
}): CompanionMatch[] {
	const matches: CompanionMatch[] = [];

	for (let audioTrackIndex = 0; audioTrackIndex < tracks.length; audioTrackIndex++) {
		const audioTrack = tracks[audioTrackIndex];
		if (audioTrack.type !== "audio") continue;

		for (
			let audioElementIndex = 0;
			audioElementIndex < audioTrack.elements.length;
			audioElementIndex++
		) {
			const audioElement = audioTrack.elements[audioElementIndex];
			if (!isUploadAudioElement(audioElement)) continue;

			for (let videoTrackIndex = 0; videoTrackIndex < tracks.length; videoTrackIndex++) {
				const videoTrack = tracks[videoTrackIndex];
				if (videoTrack.type !== "video") continue;

				for (
					let videoElementIndex = 0;
					videoElementIndex < videoTrack.elements.length;
					videoElementIndex++
				) {
					const videoElement = videoTrack.elements[videoElementIndex];
					if (!isVideoElement(videoElement)) continue;
					if (videoElement.mediaId !== audioElement.mediaId) continue;
					if (!isAlignedCompanionPair({ videoElement, audioElement })) continue;
					matches.push({
						audioTrackIndex,
						audioElementIndex,
						videoTrackIndex,
						videoElementIndex,
					});
					videoElementIndex = videoTrack.elements.length;
					videoTrackIndex = tracks.length;
				}
			}
		}
	}

	return matches;
}

export function normalizeLegacyCompanionAudioInScene({
	scene,
}: {
	scene: TScene;
}): { scene: TScene; changed: boolean } {
	const matches = findCompanionMatches({ tracks: scene.tracks });
	if (matches.length === 0) return { scene, changed: false };

	const nextTracks = scene.tracks.map((track) => ({ ...track }));

	for (const match of matches) {
		const videoTrack = nextTracks[match.videoTrackIndex];
		const audioTrack = nextTracks[match.audioTrackIndex];
		if (!videoTrack || !audioTrack) continue;
		if (videoTrack.type !== "video" || audioTrack.type !== "audio") continue;

		const videoElement = videoTrack.elements[match.videoElementIndex];
		const audioElement = audioTrack.elements[match.audioElementIndex];
		if (!isVideoElement(videoElement) || !isUploadAudioElement(audioElement)) continue;

		videoTrack.elements = videoTrack.elements.map((candidate, index) => {
			if (index !== match.videoElementIndex || !isVideoElement(candidate)) return candidate;
			const transcriptDraft =
				getTranscriptDraft(candidate) ?? getTranscriptDraft(audioElement);
			if (!transcriptDraft) {
				return {
					...candidate,
					muted: false,
				};
			}
			return withTranscriptState({
				element: {
					...candidate,
					muted: false,
				},
				draft: transcriptDraft,
				applied: compileTranscriptDraft({
					mediaElementId: candidate.id,
					draft: transcriptDraft,
					mediaStartTime: candidate.startTime,
					mediaDuration: candidate.duration,
				}),
				compileState: {
					status: "idle",
					updatedAt: transcriptDraft.updatedAt,
				},
			});
		});
	}

	const removalsByTrack = new Map<number, Set<number>>();
	for (const match of matches) {
		const existing = removalsByTrack.get(match.audioTrackIndex) ?? new Set<number>();
		existing.add(match.audioElementIndex);
		removalsByTrack.set(match.audioTrackIndex, existing);
	}

	const filteredTracks = nextTracks
		.map((track, trackIndex) => {
			if (track.type !== "audio") return track;
			const removals = removalsByTrack.get(trackIndex);
			if (!removals || removals.size === 0) return track;
			return {
				...track,
				elements: track.elements.filter((_, elementIndex) => !removals.has(elementIndex)),
			};
		})
		.filter((track) => (track.type === "audio" ? track.elements.length > 0 : true));

	return {
		scene: {
			...scene,
			tracks: filteredTracks,
		},
		changed: true,
	};
}

export function normalizeLegacyCompanionAudioInScenes({
	scenes,
}: {
	scenes: TScene[];
}): { scenes: TScene[]; changed: boolean } {
	let changed = false;
	const nextScenes = scenes.map((scene) => {
		const normalized = normalizeLegacyCompanionAudioInScene({ scene });
		if (normalized.changed) changed = true;
		return normalized.scene;
	});
	return { scenes: nextScenes, changed };
}
