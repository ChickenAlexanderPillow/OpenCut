import { normalizeVideoReframeState } from "@/lib/reframe/video-reframe";
import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId, isRecord } from "./utils";

export function transformProjectV10ToV11({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	const projectId = getProjectId({ project });
	if (!projectId) {
		return { project, skipped: true, reason: "no project id" };
	}

	if (typeof project.version === "number" && project.version >= 11) {
		return { project, skipped: true, reason: "already v11" };
	}

	const scenesValue = project.scenes;
	if (!Array.isArray(scenesValue)) {
		return {
			project: { ...project, version: 11 },
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
			if (!isRecord(track) || !Array.isArray(track.elements)) {
				return track;
			}

			let trackChanged = false;
			const nextElements = track.elements.map((element) => {
				if (!isRecord(element) || element.type !== "video") {
					return element;
				}
				trackChanged = true;
				return normalizeVideoReframeState({
					element: element as never,
				});
			});
			if (!trackChanged) return track;
			sceneChanged = true;
			return {
				...track,
				elements: nextElements,
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
			version: 11,
		},
		skipped: false,
	};
}
