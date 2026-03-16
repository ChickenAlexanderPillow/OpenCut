import { normalizeTrackAudioEffects } from "@/lib/media/track-audio-effects";
import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId, isRecord } from "./utils";

export function transformProjectV9ToV10({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	const projectId = getProjectId({ project });
	if (!projectId) {
		return { project, skipped: true, reason: "no project id" };
	}

	if (typeof project.version === "number" && project.version >= 10) {
		return { project, skipped: true, reason: "already v10" };
	}

	const scenesValue = project.scenes;
	if (!Array.isArray(scenesValue)) {
		return {
			project: { ...project, version: 10 },
			skipped: false,
		};
	}

	let changed = false;
	const nextScenes = scenesValue.map((scene) => {
		if (!isRecord(scene) || !Array.isArray(scene.tracks)) {
			return scene;
		}

		let sceneChanged = false;
		const nextTracks = scene.tracks.map((track) => {
			if (!isRecord(track)) return track;
			if (track.type !== "audio" && track.type !== "video") return track;
			const normalizedEffects = normalizeTrackAudioEffects(
				track.audioEffects as Partial<
					ReturnType<typeof normalizeTrackAudioEffects>
				> | null,
			);
			sceneChanged = true;
			return {
				...track,
				volume:
					typeof track.volume === "number" && Number.isFinite(track.volume)
						? track.volume
						: 1,
				audioEffects: normalizedEffects,
			};
		});

		if (!sceneChanged) return scene;
		changed = true;
		return {
			...scene,
			tracks: nextTracks,
		};
	});

	return {
		project: {
			...project,
			scenes: changed ? nextScenes : scenesValue,
			version: 10,
		},
		skipped: false,
	};
}
