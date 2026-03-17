import type {
	Transform,
	TimelineTrack,
	VideoElement,
	VideoReframePreset,
	VideoReframeSwitch,
	VideoSplitScreen,
	VideoSplitScreenLayoutPreset,
	VideoSplitScreenSection,
	VideoSplitScreenSlotBinding,
} from "@/types/timeline";
import { generateUUID } from "@/utils/id";

const REFRAME_SWITCH_TIME_EPSILON = 1 / 1000;
const DEFAULT_SPLIT_LAYOUT_PRESET: VideoSplitScreenLayoutPreset = "top-bottom";

const SPLIT_LAYOUT_SLOTS: Record<VideoSplitScreenLayoutPreset, string[]> = {
	"top-bottom": ["top", "bottom"],
};

export interface VideoReframeSection {
	startTime: number;
	endTime: number;
	presetId: string | null;
	switchId: string | null;
}

export interface VideoSplitScreenSectionRange {
	startTime: number;
	endTime: number;
	sectionId: string | null;
	enabled: boolean;
}

export interface VideoSplitScreenResolvedSlot {
	slotId: string;
	mode: VideoSplitScreenSlotBinding["mode"];
	presetId: string | null;
	transformOverride: VideoSplitScreenSlotBinding["transformOverride"] | null;
}

export interface VideoAngleSection {
	startTime: number;
	endTime: number;
	presetId: string | null;
	switchId: string | null;
	splitSectionId: string | null;
	isSplit: boolean;
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
		splitScreen: normalizeVideoSplitScreenState({
			splitScreen: element.splitScreen,
			duration: element.duration,
			defaultPresetId: defaultReframePresetId,
			presetIds,
		}),
	};
}

function normalizeVideoSplitScreenState({
	splitScreen,
	duration,
	defaultPresetId,
	presetIds,
}: {
	splitScreen: VideoElement["splitScreen"];
	duration: number;
	defaultPresetId: string | null;
	presetIds: Set<string>;
}): VideoSplitScreen | undefined {
	if (!splitScreen) return undefined;
	const layoutPreset = SPLIT_LAYOUT_SLOTS[splitScreen.layoutPreset]
		? splitScreen.layoutPreset
		: DEFAULT_SPLIT_LAYOUT_PRESET;
	const slotIds = SPLIT_LAYOUT_SLOTS[layoutPreset];
	const normalizeSlotBindings = (
		bindings: VideoSplitScreenSlotBinding[] | undefined,
	): VideoSplitScreenSlotBinding[] =>
		slotIds.map((slotId, index) => {
			const candidate =
				bindings?.find((binding) => binding.slotId === slotId) ??
				bindings?.[index] ??
				null;
			const requestedPresetId = candidate?.presetId ?? null;
			const normalizedPresetId =
				requestedPresetId && presetIds.has(requestedPresetId)
					? requestedPresetId
					: defaultPresetId;
			const mode =
				candidate?.mode === "fixed-preset" && normalizedPresetId
					? "fixed-preset"
					: "follow-active";
			return {
				slotId,
				mode,
				presetId: mode === "fixed-preset" ? normalizedPresetId : null,
				transformOverride:
					candidate?.transformOverride &&
					Number.isFinite(candidate.transformOverride.position.x) &&
					Number.isFinite(candidate.transformOverride.position.y) &&
					Number.isFinite(candidate.transformOverride.scale) &&
					candidate.transformOverride.scale > 0
						? {
								position: {
									x: candidate.transformOverride.position.x,
									y: candidate.transformOverride.position.y,
								},
								scale: candidate.transformOverride.scale,
						  }
						: null,
			};
		});

	const sections = (splitScreen.sections ?? [])
		.filter(
			(section): section is NonNullable<typeof section> =>
				Boolean(section) && Number.isFinite(section.startTime),
		)
		.map((section) => ({
			id: section.id || generateUUID(),
			startTime: Math.max(0, Math.min(duration, section.startTime)),
			enabled: section.enabled !== false,
			slots: normalizeSlotBindings(section.slots),
		}))
		.sort((left, right) => left.startTime - right.startTime)
		.filter(
			(section, index, list) =>
				index === 0 ||
				Math.abs(section.startTime - list[index - 1]!.startTime) >
					REFRAME_SWITCH_TIME_EPSILON,
		);

	return {
		enabled: splitScreen.enabled !== false,
		layoutPreset,
		slots: normalizeSlotBindings(splitScreen.slots),
		sections,
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

export function deriveVideoAngleSections({
	element,
}: {
	element: VideoElement;
}): VideoAngleSection[] {
	const normalized = normalizeVideoReframeState({ element });
	const reframeSections = deriveVideoReframeSections({ element: normalized });
	const splitRanges = deriveVideoSplitScreenSectionRanges({
		element: normalized,
	}).filter((range) => range.enabled);
	if (splitRanges.length === 0) {
		return reframeSections.map((section) => ({
			...section,
			splitSectionId: null,
			isSplit: false,
		}));
	}

	const boundaries = new Set<number>([0, normalized.duration]);
	for (const section of reframeSections) {
		boundaries.add(section.startTime);
		boundaries.add(section.endTime);
	}
	for (const range of splitRanges) {
		boundaries.add(range.startTime);
		boundaries.add(range.endTime);
	}
	const sortedBoundaries = [...boundaries]
		.filter((time) => Number.isFinite(time))
		.sort((left, right) => left - right);

	const sections: VideoAngleSection[] = [];
	for (let index = 0; index < sortedBoundaries.length - 1; index++) {
		const startTime = sortedBoundaries[index]!;
		const endTime = sortedBoundaries[index + 1]!;
		if (endTime - startTime <= REFRAME_SWITCH_TIME_EPSILON) {
			continue;
		}
		const sampleTime = Math.min(
			normalized.duration,
			startTime + (endTime - startTime) / 2,
		);
		const reframeSection = getVideoReframeSectionAtTime({
			element: normalized,
			localTime: sampleTime,
		});
		const splitRange =
			splitRanges.find(
				(range) =>
					sampleTime + REFRAME_SWITCH_TIME_EPSILON >= range.startTime &&
					sampleTime <
						range.endTime +
							(index === sortedBoundaries.length - 2
								? REFRAME_SWITCH_TIME_EPSILON
								: 0),
			) ?? null;
		sections.push({
			startTime,
			endTime,
			presetId: reframeSection?.presetId ?? null,
			switchId: reframeSection?.switchId ?? null,
			splitSectionId: splitRange?.sectionId ?? null,
			isSplit: Boolean(splitRange),
		});
	}

	return sections.reduce<VideoAngleSection[]>((result, section) => {
		const previous = result[result.length - 1];
		if (
			previous &&
			previous.isSplit === section.isSplit &&
			previous.presetId === section.presetId &&
			previous.switchId === section.switchId &&
			previous.splitSectionId === section.splitSectionId &&
			Math.abs(previous.endTime - section.startTime) <=
				REFRAME_SWITCH_TIME_EPSILON
		) {
			previous.endTime = section.endTime;
			return result;
		}
		result.push({ ...section });
		return result;
	}, []);
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

export function resolveVideoSplitScreenSlotTransform({
	baseTransform,
	duration,
	reframePresets,
	reframeSwitches,
	defaultReframePresetId,
	localTime,
	slot,
}: {
	baseTransform: Transform;
	duration: number;
	reframePresets?: VideoElement["reframePresets"];
	reframeSwitches?: VideoElement["reframeSwitches"];
	defaultReframePresetId?: string | null;
	localTime: number;
	slot: Pick<
		VideoSplitScreenSlotBinding,
		"presetId" | "transformOverride"
	>;
}): Transform {
	const resolvedTransform = resolveVideoReframeTransform({
		baseTransform,
		duration,
		reframePresets,
		reframeSwitches:
			!slot.presetId
				? reframeSwitches
				: [
						{
							id: "__split-slot__",
							time: 0,
							presetId: slot.presetId,
						},
				  ],
		defaultReframePresetId: slot.presetId ?? defaultReframePresetId,
		localTime,
	});
	if (!slot.transformOverride) {
		return resolvedTransform;
	}
	return {
		position: {
			x: slot.transformOverride.position.x,
			y: slot.transformOverride.position.y,
		},
		scale: slot.transformOverride.scale,
		rotate: resolvedTransform.rotate,
	};
}

export function getVideoSplitScreenLayoutSlotIds({
	layoutPreset,
}: {
	layoutPreset: VideoSplitScreenLayoutPreset;
}): string[] {
	return SPLIT_LAYOUT_SLOTS[layoutPreset] ?? SPLIT_LAYOUT_SLOTS[DEFAULT_SPLIT_LAYOUT_PRESET];
}

export function buildDefaultVideoSplitScreenBindings({
	layoutPreset,
	presets,
}: {
	layoutPreset: VideoSplitScreenLayoutPreset;
	presets: VideoReframePreset[];
}): VideoSplitScreenSlotBinding[] {
	const slotIds = getVideoSplitScreenLayoutSlotIds({ layoutPreset });
	const matchPreset = (matcher: (normalizedName: string) => boolean) =>
		presets.find((preset) => matcher(preset.name.trim().toLowerCase())) ?? null;
	const normalizedPresetByName = new Map(
		presets.map((preset) => [preset.name.trim().toLowerCase(), preset] as const),
	);
	const preferredPresets = [
		normalizedPresetByName.get("subject left") ??
			matchPreset(
				(normalizedName) =>
					normalizedName.includes("subject") && normalizedName.includes("left"),
			),
		normalizedPresetByName.get("subject right") ??
			matchPreset(
				(normalizedName) =>
					normalizedName.includes("subject") && normalizedName.includes("right"),
			),
	];
	const fallbackPresets = presets.filter(
		(preset) =>
			preset.id !== preferredPresets[0]?.id && preset.id !== preferredPresets[1]?.id,
	);

	return slotIds.map((slotId, index) => {
		const preset = preferredPresets[index] ?? fallbackPresets[index] ?? null;
		return {
			slotId,
			mode: preset ? "fixed-preset" : "follow-active",
			presetId: preset?.id ?? null,
		};
	});
}

export function getVideoSplitScreenSectionAtTime({
	element,
	localTime,
}: {
	element: VideoElement;
	localTime: number;
}): VideoSplitScreenSection | null {
	const splitScreen = normalizeVideoReframeState({ element }).splitScreen;
	if (!splitScreen?.sections?.length) return null;
	const safeTime = Math.max(0, Math.min(element.duration, localTime));
	const sections = splitScreen.sections;
	for (let index = 0; index < sections.length; index++) {
		const section = sections[index]!;
		const nextStartTime = sections[index + 1]?.startTime ?? element.duration;
		const isLast = index === sections.length - 1;
		if (safeTime + REFRAME_SWITCH_TIME_EPSILON < section.startTime) continue;
		if (safeTime < nextStartTime || (isLast && safeTime <= nextStartTime)) {
			return section;
		}
	}
	return null;
}

export function getVideoSplitScreenSectionByStartTime({
	element,
	startTime,
}: {
	element: VideoElement;
	startTime: number | null | undefined;
}): VideoSplitScreenSection | null {
	if (startTime === null || startTime === undefined) return null;
	return (
		normalizeVideoReframeState({ element }).splitScreen?.sections?.find(
			(section) =>
				Math.abs(section.startTime - startTime) <= REFRAME_SWITCH_TIME_EPSILON,
		) ?? null
	);
}

export function deriveVideoSplitScreenSectionRanges({
	element,
}: {
	element: VideoElement;
}): VideoSplitScreenSectionRange[] {
	const splitScreen = normalizeVideoReframeState({ element }).splitScreen;
	if (!splitScreen?.sections?.length) {
		return [
			{
				startTime: 0,
				endTime: element.duration,
				sectionId: null,
				enabled: splitScreen?.enabled ?? false,
			},
		];
	}
	const ranges: VideoSplitScreenSectionRange[] = [];
	let currentStart = 0;
	for (let index = 0; index < splitScreen.sections.length; index++) {
		const section = splitScreen.sections[index]!;
		if (section.startTime > currentStart + REFRAME_SWITCH_TIME_EPSILON) {
			ranges.push({
				startTime: currentStart,
				endTime: section.startTime,
				sectionId: null,
				enabled: splitScreen.enabled,
			});
		}
		const nextStartTime = splitScreen.sections[index + 1]?.startTime ?? element.duration;
		ranges.push({
			startTime: section.startTime,
			endTime: nextStartTime,
			sectionId: section.id,
			enabled: section.enabled !== false,
		});
		currentStart = nextStartTime;
	}
	if (currentStart < element.duration - REFRAME_SWITCH_TIME_EPSILON) {
		ranges.push({
			startTime: currentStart,
			endTime: element.duration,
			sectionId: null,
			enabled: splitScreen.enabled,
		});
	}
	return ranges;
}

export function resolveVideoSplitScreenAtTime({
	element,
	localTime,
}: {
	element: VideoElement;
	localTime: number;
}): VideoSplitScreen | null {
	const normalized = normalizeVideoReframeState({ element });
	const splitScreen = normalized.splitScreen;
	const section = getVideoSplitScreenSectionAtTime({
		element: normalized,
		localTime,
	});
	const effectiveEnabled = section ? section.enabled !== false : splitScreen?.enabled;
	if (!splitScreen || !effectiveEnabled) return null;
	const activePresetId = getActiveReframePresetId({
		element: normalized,
		localTime,
	});
	const slotBindings = section?.slots ?? splitScreen.slots;
	const resolvedSlots: VideoSplitScreenResolvedSlot[] = slotBindings.map((slot) => {
		const sectionSlot =
			section?.slots.find((candidate) => candidate.slotId === slot.slotId) ?? null;
		const binding = sectionSlot ?? slot;
		const presetId =
			binding.mode === "fixed-preset"
				? binding.presetId ??
					activePresetId ??
					normalized.defaultReframePresetId ??
					null
				: activePresetId ?? normalized.defaultReframePresetId ?? null;
		return {
			slotId: slot.slotId,
			mode: binding.mode,
			presetId,
			transformOverride: binding.transformOverride ?? null,
		};
	});
	return {
		...splitScreen,
		slots: resolvedSlots,
	};
}

export function replaceOrInsertSplitSection({
	sections,
	nextSection,
	duration,
}: {
	sections: VideoSplitScreen["sections"];
	nextSection: VideoSplitScreenSection;
	duration: number;
}): VideoSplitScreenSection[] {
	const clampedTime = Math.max(0, Math.min(duration, nextSection.startTime));
	const incoming = { ...nextSection, startTime: clampedTime };
	const filtered = (sections ?? []).filter(
		(section) =>
			Math.abs(section.startTime - clampedTime) > REFRAME_SWITCH_TIME_EPSILON,
	);
	return [...filtered, incoming].sort(
		(left, right) => left.startTime - right.startTime,
	);
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
	selectedSplitPreviewSlotsByElementId,
	selectedElementIds,
}: {
	tracks: TimelineTrack[];
	selectedPresetIdByElementId: Record<string, string | null>;
	selectedSplitPreviewSlotsByElementId?: Record<
		string,
		VideoSplitScreenSlotBinding[] | null
	>;
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
			const selectedSplitPreviewSlots =
				selectedSplitPreviewSlotsByElementId?.[element.id] ?? null;
			if (selectedSplitPreviewSlots?.length) {
				trackChanged = true;
				hasChanges = true;
				const normalizedElement = normalizeVideoReframeState({ element });
				return {
					...normalizedElement,
					splitScreen: {
						enabled: false,
						layoutPreset: DEFAULT_SPLIT_LAYOUT_PRESET,
						slots: selectedSplitPreviewSlots,
						sections: [
							{
								id: "__preview-selected-split__",
								startTime: 0,
								enabled: true,
								slots: selectedSplitPreviewSlots,
							},
						],
					},
				};
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
				splitScreen: undefined,
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
