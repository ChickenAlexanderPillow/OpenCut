import {
	applyBlueHighlightCaptionPreset,
} from "@/constants/caption-presets";
import type { TProject } from "@/types/project";
import type { TextElement, TimelineTrack } from "@/types/timeline";

function isGeneratedCaptionElement({
	element,
}: {
	element: TextElement;
}): boolean {
	return (
		(element.captionWordTimings?.length ?? 0) > 0 ||
		element.name.startsWith("Caption ") ||
		element.captionStyle?.linkedToCaptionGroup === true
	);
}

function normalizeTrackGeneratedCaptions({
	track,
}: {
	track: TimelineTrack;
}): { track: TimelineTrack; changed: boolean } {
	if (track.type !== "text") {
		return { track, changed: false };
	}

	let changed = false;
	const nextElements = track.elements.map((element) => {
		if (element.type !== "text") return element;
		if (!isGeneratedCaptionElement({ element })) return element;

		const normalized: TextElement = applyBlueHighlightCaptionPreset({ element });

		const didChange =
			JSON.stringify(normalized) !== JSON.stringify(element);
		if (didChange) changed = true;
		return normalized;
	});

	if (!changed) {
		return { track, changed: false };
	}

	return {
		track: {
			...track,
			elements: nextElements,
		},
		changed: true,
	};
}

export function normalizeGeneratedCaptionsInProject({
	project,
}: {
	project: TProject;
}): { project: TProject; changed: boolean } {
	let changed = false;

	const nextScenes = project.scenes.map((scene) => {
		let sceneChanged = false;
		const nextTracks = scene.tracks.map((track) => {
			const normalized = normalizeTrackGeneratedCaptions({ track });
			if (normalized.changed) sceneChanged = true;
			return normalized.track;
		});

		if (!sceneChanged) return scene;
		changed = true;
		return {
			...scene,
			tracks: nextTracks,
		};
	});

	if (!changed) {
		return { project, changed: false };
	}

	return {
		project: {
			...project,
			scenes: nextScenes,
		},
		changed: true,
	};
}
