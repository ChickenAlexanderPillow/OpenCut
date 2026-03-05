import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId, isRecord } from "./utils";

const COMPANION_TOLERANCE_SECONDS = 0.05;

type MatchedCompanion = {
	audioTrackIndex: number;
	audioElementIndex: number;
	videoTrackIndex: number;
	videoElementIndex: number;
};

type CompanionVideoElement = {
	type: "video";
	mediaId: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	muted?: boolean;
	transcriptEdit?: unknown;
};

type CompanionAudioElement = {
	type: "audio";
	sourceType: "upload";
	mediaId: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	transcriptEdit?: unknown;
};

export function transformProjectV8ToV9({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	const projectId = getProjectId({ project });
	if (!projectId) {
		return { project, skipped: true, reason: "no project id" };
	}

	if (isV9Project({ project })) {
		return { project, skipped: true, reason: "already v9" };
	}

	const migratedProject = migrateProjectScenes({ project });
	return {
		project: {
			...migratedProject,
			version: 9,
		},
		skipped: false,
	};
}

function isV9Project({ project }: { project: ProjectRecord }): boolean {
	return typeof project.version === "number" && project.version >= 9;
}

function migrateProjectScenes({ project }: { project: ProjectRecord }): ProjectRecord {
	const scenesValue = project.scenes;
	if (!Array.isArray(scenesValue)) {
		return project;
	}

	let changed = false;
	const nextScenes = scenesValue.map((scene) => {
		const migratedScene = migrateScene({ scene });
		if (migratedScene !== scene) changed = true;
		return migratedScene;
	});

	if (!changed) return project;
	return { ...project, scenes: nextScenes };
}

function migrateScene({ scene }: { scene: unknown }): unknown {
	if (!isRecord(scene)) return scene;
	const tracksValue = scene.tracks;
	if (!Array.isArray(tracksValue)) return scene;

	const tracks = tracksValue.map((track) => (isRecord(track) ? { ...track } : track));
	const matches = findCompanionMatches({ tracks });
	if (matches.length === 0) return scene;

	for (const match of matches) {
		const videoTrack = tracks[match.videoTrackIndex];
		const audioTrack = tracks[match.audioTrackIndex];
		if (!isRecord(videoTrack) || !isRecord(audioTrack)) continue;
		const videoElements = Array.isArray(videoTrack.elements)
			? [...videoTrack.elements]
			: [];
		const audioElements = Array.isArray(audioTrack.elements)
			? [...audioTrack.elements]
			: [];
		const videoElement = videoElements[match.videoElementIndex];
		const audioElement = audioElements[match.audioElementIndex];
		if (!isRecord(videoElement) || !isRecord(audioElement)) continue;

		const nextVideoElement: ProjectRecord = {
			...videoElement,
			// Legacy companion clips used muted video + separate audio. Normalize to video-audio.
			muted: false,
		};
		if (!isRecord(videoElement.transcriptEdit) && isRecord(audioElement.transcriptEdit)) {
			nextVideoElement.transcriptEdit = audioElement.transcriptEdit;
		}
		videoElements[match.videoElementIndex] = nextVideoElement;
		tracks[match.videoTrackIndex] = {
			...videoTrack,
			elements: videoElements,
		};
	}

	const removalsByTrack = new Map<number, Set<number>>();
	for (const match of matches) {
		const existing = removalsByTrack.get(match.audioTrackIndex) ?? new Set<number>();
		existing.add(match.audioElementIndex);
		removalsByTrack.set(match.audioTrackIndex, existing);
	}

	const nextTracks = tracks
		.map((track, trackIndex) => {
			if (!isRecord(track)) return track;
			const removals = removalsByTrack.get(trackIndex);
			if (!removals || !Array.isArray(track.elements)) return track;
			const nextElements = track.elements.filter(
				(_, elementIndex) => !removals.has(elementIndex),
			);
			return { ...track, elements: nextElements };
		})
		.filter((track) => {
			if (!isRecord(track)) return true;
			if (track.type !== "audio") return true;
			if (!Array.isArray(track.elements)) return true;
			return track.elements.length > 0;
		});

	return {
		...scene,
		tracks: nextTracks,
	};
}

function findCompanionMatches({
	tracks,
}: {
	tracks: unknown[];
}): MatchedCompanion[] {
	const matches: MatchedCompanion[] = [];

	for (let audioTrackIndex = 0; audioTrackIndex < tracks.length; audioTrackIndex++) {
		const audioTrack = tracks[audioTrackIndex];
		if (!isRecord(audioTrack) || audioTrack.type !== "audio") continue;
		if (!Array.isArray(audioTrack.elements) || audioTrack.elements.length === 0) {
			continue;
		}
		for (
			let audioElementIndex = 0;
			audioElementIndex < audioTrack.elements.length;
			audioElementIndex++
		) {
			const audioElement = audioTrack.elements[audioElementIndex];
			if (!isCompanionAudioElement(audioElement)) continue;

			const audioMediaId = audioElement.mediaId;
			for (let videoTrackIndex = 0; videoTrackIndex < tracks.length; videoTrackIndex++) {
				const videoTrack = tracks[videoTrackIndex];
				if (!isRecord(videoTrack) || videoTrack.type !== "video") continue;
				if (!Array.isArray(videoTrack.elements)) continue;

				for (
					let videoElementIndex = 0;
					videoElementIndex < videoTrack.elements.length;
					videoElementIndex++
				) {
					const videoElement = videoTrack.elements[videoElementIndex];
					if (!isCompanionVideoElement(videoElement)) continue;
					if (videoElement.mediaId !== audioMediaId) continue;
					if (
						!isAlignedCompanionPair({
							videoElement,
							audioElement,
						})
					) {
						continue;
					}
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

function isCompanionVideoElement(
	element: unknown,
): element is CompanionVideoElement {
	if (!isRecord(element)) return false;
	return (
		element.type === "video" &&
		typeof element.mediaId === "string" &&
		typeof element.startTime === "number" &&
		typeof element.duration === "number" &&
		typeof element.trimStart === "number" &&
		typeof element.trimEnd === "number"
	);
}

function isCompanionAudioElement(
	element: unknown,
): element is CompanionAudioElement {
	if (!isRecord(element)) return false;
	return (
		element.type === "audio" &&
		element.sourceType === "upload" &&
		typeof element.mediaId === "string" &&
		typeof element.startTime === "number" &&
		typeof element.duration === "number" &&
		typeof element.trimStart === "number" &&
		typeof element.trimEnd === "number"
	);
}

function isAlignedCompanionPair({
	videoElement,
	audioElement,
}: {
	videoElement: {
		startTime: number;
		duration: number;
		trimStart: number;
		trimEnd: number;
	};
	audioElement: {
		startTime: number;
		duration: number;
		trimStart: number;
		trimEnd: number;
	};
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
