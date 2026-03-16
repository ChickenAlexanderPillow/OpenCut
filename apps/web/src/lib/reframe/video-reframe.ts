import type {
	Transform,
	TimelineTrack,
	VideoElement,
	VideoReframePreset,
	VideoReframeSwitch,
} from "@/types/timeline";
import { generateUUID } from "@/utils/id";

const REFRAME_SWITCH_TIME_EPSILON = 1 / 1000;

export interface VideoReframeSection {
	startTime: number;
	endTime: number;
	presetId: string | null;
	switchId: string | null;
}

export function buildVideoReframePreset({
	name,
	transform,
	autoSeeded = false,
}: {
	name: string;
	transform: {
		position: Transform["position"];
		scale: number;
	};
	autoSeeded?: boolean;
}): VideoReframePreset {
	return {
		id: generateUUID(),
		name,
		transform: {
			position: {
				x: Number.isFinite(transform.position.x) ? transform.position.x : 0,
				y: Number.isFinite(transform.position.y) ? transform.position.y : 0,
			},
			scale:
				Number.isFinite(transform.scale) && transform.scale > 0
					? transform.scale
					: 1,
		},
		autoSeeded,
	};
}

export function normalizeVideoReframeState({
	element,
}: {
	element: VideoElement;
}): VideoElement {
	const presets = (element.reframePresets ?? [])
		.filter((preset): preset is NonNullable<typeof preset> => Boolean(preset))
		.map((preset) => ({
			...preset,
			transform: {
				position: {
					x: Number.isFinite(preset.transform?.position?.x)
						? preset.transform.position.x
						: 0,
					y: Number.isFinite(preset.transform?.position?.y)
						? preset.transform.position.y
						: 0,
				},
				scale:
					Number.isFinite(preset.transform?.scale) &&
					(preset.transform.scale ?? 0) > 0
						? preset.transform.scale
						: Math.max(1, element.transform.scale),
			},
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
	const presetIds = new Set(presets.map((preset) => preset.id));
	const switches = (element.reframeSwitches ?? [])
		.filter(
			(entry): entry is NonNullable<typeof entry> =>
				Boolean(entry) &&
				presetIds.has(entry.presetId) &&
				Number.isFinite(entry.time),
		)
		.map((entry) => ({
			...entry,
			time: Math.max(0, Math.min(element.duration, entry.time)),
		}))
		.sort((left, right) => left.time - right.time);
	const defaultReframePresetId =
		typeof element.defaultReframePresetId === "string" &&
		presetIds.has(element.defaultReframePresetId)
			? element.defaultReframePresetId
			: presets[0]?.id ?? null;

	return {
		...element,
		reframePresets: presets,
		reframeSwitches: switches,
		defaultReframePresetId,
	};
}

export function hasReframePresets({
	element,
}: {
	element: VideoElement;
}): boolean {
	return (element.reframePresets?.length ?? 0) > 0;
}

export function getReframePresetById({
	element,
	presetId,
}: {
	element: VideoElement;
	presetId: string | null | undefined;
}): VideoReframePreset | null {
	if (!presetId) return null;
	return (
		element.reframePresets?.find((preset) => preset.id === presetId) ?? null
	);
}

export function getActiveReframePresetId({
	element,
	localTime,
}: {
	element: VideoElement;
	localTime: number;
}): string | null {
	if (!hasReframePresets({ element })) {
		return null;
	}

	const safeTime = Math.max(0, Math.min(element.duration, localTime));
	let activePresetId = element.defaultReframePresetId ?? null;
	for (const entry of element.reframeSwitches ?? []) {
		if (entry.time - safeTime > REFRAME_SWITCH_TIME_EPSILON) {
			break;
		}
		activePresetId = entry.presetId;
	}
	return activePresetId;
}

export function getSelectedOrActiveReframePresetId({
	element,
	localTime,
	selectedPresetId,
}: {
	element: VideoElement;
	localTime: number;
	selectedPresetId?: string | null;
}): string | null {
	if (
		selectedPresetId &&
		(element.reframePresets ?? []).some((preset) => preset.id === selectedPresetId)
	) {
		return selectedPresetId;
	}
	return getActiveReframePresetId({ element, localTime });
}

export function deriveVideoReframeSections({
	element,
}: {
	element: VideoElement;
}): VideoReframeSection[] {
	const normalized = normalizeVideoReframeState({ element });
	const sections: VideoReframeSection[] = [];
	let currentStart = 0;
	let currentPresetId = normalized.defaultReframePresetId ?? null;
	let currentSwitchId: string | null = null;

	for (const entry of normalized.reframeSwitches ?? []) {
		sections.push({
			startTime: currentStart,
			endTime: entry.time,
			presetId: currentPresetId,
			switchId: currentSwitchId,
		});
		currentStart = entry.time;
		currentPresetId = entry.presetId;
		currentSwitchId = entry.id;
	}

	sections.push({
		startTime: currentStart,
		endTime: normalized.duration,
		presetId: currentPresetId,
		switchId: currentSwitchId,
	});

	return sections.filter(
		(section) =>
			section.endTime - section.startTime >= -REFRAME_SWITCH_TIME_EPSILON,
	);
}

export function getVideoReframeSectionAtTime({
	element,
	localTime,
}: {
	element: VideoElement;
	localTime: number;
}): VideoReframeSection | null {
	const safeTime = Math.max(0, Math.min(element.duration, localTime));
	const sections = deriveVideoReframeSections({ element });
	for (let index = 0; index < sections.length; index++) {
		const section = sections[index]!;
		const isLast = index === sections.length - 1;
		if (safeTime + REFRAME_SWITCH_TIME_EPSILON < section.startTime) {
			continue;
		}
		if (safeTime < section.endTime || (isLast && safeTime <= section.endTime)) {
			return section;
		}
	}
	return sections[sections.length - 1] ?? null;
}

export function getVideoReframeSectionByStartTime({
	element,
	startTime,
}: {
	element: VideoElement;
	startTime: number | null | undefined;
}): VideoReframeSection | null {
	if (startTime === null || startTime === undefined) return null;
	return (
		deriveVideoReframeSections({ element }).find(
			(section) =>
				Math.abs(section.startTime - startTime) <= REFRAME_SWITCH_TIME_EPSILON,
		) ?? null
	);
}

export function resolveVideoBaseTransformAtTime({
	element,
	localTime,
}: {
	element: VideoElement;
	localTime: number;
}): Transform {
	return resolveVideoReframeTransform({
		baseTransform: element.transform,
		duration: element.duration,
		reframePresets: element.reframePresets,
		reframeSwitches: element.reframeSwitches,
		defaultReframePresetId: element.defaultReframePresetId,
		localTime,
	});
}

export function resolveVideoReframeTransform({
	baseTransform,
	duration,
	reframePresets,
	reframeSwitches,
	defaultReframePresetId,
	localTime,
}: {
	baseTransform: Transform;
	duration: number;
	reframePresets?: VideoElement["reframePresets"];
	reframeSwitches?: VideoElement["reframeSwitches"];
	defaultReframePresetId?: string | null;
	localTime: number;
}): Transform {
	const normalizedElement = normalizeVideoReframeState({
		element: {
			id: "__reframe__",
			type: "video",
			mediaId: "__reframe__",
			name: "__reframe__",
			startTime: 0,
			duration,
			trimStart: 0,
			trimEnd: 0,
			muted: false,
			hidden: false,
			transform: baseTransform,
			opacity: 1,
			reframePresets,
			reframeSwitches,
			defaultReframePresetId,
		},
	});
	const preset = getReframePresetById({
		element: normalizedElement,
		presetId: getActiveReframePresetId({
			element: normalizedElement,
			localTime,
		}),
	});

	if (!preset) {
		return normalizedElement.transform;
	}

	return {
		position: preset.transform.position,
		scale: preset.transform.scale,
		rotate: normalizedElement.transform.rotate,
	};
}

export function replaceOrInsertReframeSwitch({
	switches,
	nextSwitch,
	duration,
}: {
	switches: VideoElement["reframeSwitches"];
	nextSwitch: NonNullable<VideoElement["reframeSwitches"]>[number];
	duration: number;
}) {
	const clampedTime = Math.max(0, Math.min(duration, nextSwitch.time));
	const incoming = { ...nextSwitch, time: clampedTime };
	const filtered = (switches ?? []).filter(
		(entry) => Math.abs(entry.time - clampedTime) > REFRAME_SWITCH_TIME_EPSILON,
	);
	return [...filtered, incoming].sort((left, right) => left.time - right.time);
}

export function applyPresetToVideoReframeSection({
	element,
	sectionStartTime,
	presetId,
}: {
	element: VideoElement;
	sectionStartTime: number;
	presetId: string;
}): Pick<VideoElement, "defaultReframePresetId" | "reframeSwitches"> {
	const normalized = normalizeVideoReframeState({ element });
	const section = getVideoReframeSectionByStartTime({
		element: normalized,
		startTime: sectionStartTime,
	});
	if (!section) {
		return {
			defaultReframePresetId: normalized.defaultReframePresetId,
			reframeSwitches: normalized.reframeSwitches,
		};
	}

	if (section.switchId) {
		return {
			defaultReframePresetId: normalized.defaultReframePresetId,
			reframeSwitches: (normalized.reframeSwitches ?? []).map((entry) =>
				entry.id === section.switchId ? { ...entry, presetId } : entry,
			),
		};
	}

	return {
		defaultReframePresetId: presetId,
		reframeSwitches: normalized.reframeSwitches,
	};
}

export function splitVideoReframeSectionAtTime({
	element,
	localTime,
}: {
	element: VideoElement;
	localTime: number;
}): VideoReframeSwitch[] {
	const normalized = normalizeVideoReframeState({ element });
	const section = getVideoReframeSectionAtTime({
		element: normalized,
		localTime,
	});
	if (!section) {
		return normalized.reframeSwitches ?? [];
	}
	const splitTime = Math.max(0, Math.min(normalized.duration, localTime));
	if (
		Math.abs(splitTime - section.startTime) <= REFRAME_SWITCH_TIME_EPSILON ||
		Math.abs(splitTime - section.endTime) <= REFRAME_SWITCH_TIME_EPSILON
	) {
		return normalized.reframeSwitches ?? [];
	}
	return replaceOrInsertReframeSwitch({
		switches: normalized.reframeSwitches,
		nextSwitch: {
			id: generateUUID(),
			time: splitTime,
			presetId: section.presetId ?? normalized.defaultReframePresetId ?? "",
		},
		duration: normalized.duration,
	}) ?? [];
}

export function applySelectedReframePresetPreviewToTracks({
	tracks,
	selectedPresetIdByElementId,
	selectedElementIds,
}: {
	tracks: TimelineTrack[];
	selectedPresetIdByElementId: Record<string, string | null>;
	selectedElementIds?: Set<string>;
}): TimelineTrack[] {
	let hasChanges = false;
	const nextTracks = tracks.map((track) => {
		if (track.type !== "video") return track;
		let trackChanged = false;
		const nextElements = track.elements.map((element) => {
			if (element.type !== "video") return element;
			if (selectedElementIds && !selectedElementIds.has(element.id)) {
				return element;
			}
			const selectedPresetId =
				selectedPresetIdByElementId[element.id] ?? null;
			if (!selectedPresetId) return element;

			const normalizedElement = normalizeVideoReframeState({ element });
			const selectedPreset = getReframePresetById({
				element: normalizedElement,
				presetId: selectedPresetId,
			});
			if (!selectedPreset) return element;

			trackChanged = true;
			hasChanges = true;
			return {
				...normalizedElement,
				defaultReframePresetId: selectedPreset.id,
				reframeSwitches: [
					{
						id: "__preview-selected-reframe__",
						time: 0,
						presetId: selectedPreset.id,
					},
				],
			};
		});

		if (!trackChanged) return track;
		return {
			...track,
			elements: nextElements,
		};
	});

	return hasChanges ? nextTracks : tracks;
}
