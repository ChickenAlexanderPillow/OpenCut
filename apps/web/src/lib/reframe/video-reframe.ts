import type {
	Transform,
	TimelineTrack,
	VideoElement,
	VideoReframePreset,
	VideoReframeSwitch,
	VideoSplitScreen,
	VideoSplitScreenSlotTransformAdjustment,
	VideoSplitScreenViewportBalance,
	VideoSplitScreenLayoutPreset,
	VideoSplitScreenSection,
	VideoSplitScreenSlotBinding,
} from "@/types/timeline";
import { generateUUID } from "@/utils/id";

const REFRAME_SWITCH_TIME_EPSILON = 1 / 1000;
const DEFAULT_SPLIT_LAYOUT_PRESET: VideoSplitScreenLayoutPreset = "top-bottom";
const DEFAULT_SPLIT_VIEWPORT_BALANCE: VideoSplitScreenViewportBalance =
	"balanced";
const UNBALANCED_TOP_SPLIT_RATIO = 1 / 3;
const SPLIT_DIVIDER_THICKNESS = 2;

const SPLIT_LAYOUT_SLOTS: Record<VideoSplitScreenLayoutPreset, string[]> = {
	"top-bottom": ["top", "bottom"],
};

export function getVideoSplitScreenVariantKey({
	slotId,
	viewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
}: {
	slotId: string;
	viewportBalance?: VideoSplitScreenViewportBalance;
}): string {
	return `${viewportBalance}:${slotId}`;
}

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
	transformOverridesBySlotId?: VideoSplitScreenSlotBinding["transformOverridesBySlotId"];
	transformAdjustmentsBySlotId?: VideoSplitScreenSlotBinding["transformAdjustmentsBySlotId"];
}

export interface VideoSplitScreenViewport {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface VideoSplitScreenDivider {
	x: number;
	y: number;
	width: number;
	height: number;
}

function normalizeSplitSlotTransformOverride(
	override: VideoSplitScreenSlotBinding["transformOverride"],
): VideoSplitScreenSlotBinding["transformOverride"] {
	if (
		!override ||
		!Number.isFinite(override.position.x) ||
		!Number.isFinite(override.position.y) ||
		!Number.isFinite(override.scale) ||
		override.scale <= 0
	) {
		return null;
	}
	return {
		position: {
			x: override.position.x,
			y: override.position.y,
		},
		scale: override.scale,
	};
}

function normalizeSplitSlotTransformOverridesBySlotId(
	overrides: VideoSplitScreenSlotBinding["transformOverridesBySlotId"],
): VideoSplitScreenSlotBinding["transformOverridesBySlotId"] | undefined {
	if (!overrides) return undefined;
	const normalized = Object.fromEntries(
		Object.entries(overrides).flatMap(([slotId, override]) => {
			const normalizedOverride = normalizeSplitSlotTransformOverride(override);
			return normalizedOverride ? [[slotId, normalizedOverride]] : [];
		}),
	);
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeSplitSlotTransformAdjustment(
	adjustment: VideoSplitScreenSlotTransformAdjustment | null | undefined,
): VideoSplitScreenSlotTransformAdjustment | null {
	if (
		!adjustment ||
		!Number.isFinite(adjustment.sourceCenterOffset.x) ||
		!Number.isFinite(adjustment.sourceCenterOffset.y) ||
		!Number.isFinite(adjustment.scaleMultiplier) ||
		adjustment.scaleMultiplier <= 0
	) {
		return null;
	}
	return {
		sourceCenterOffset: {
			x: adjustment.sourceCenterOffset.x,
			y: adjustment.sourceCenterOffset.y,
		},
		scaleMultiplier: adjustment.scaleMultiplier,
	};
}

function normalizeSplitSlotTransformAdjustmentsBySlotId(
	adjustments: VideoSplitScreenSlotBinding["transformAdjustmentsBySlotId"],
): VideoSplitScreenSlotBinding["transformAdjustmentsBySlotId"] | undefined {
	if (!adjustments) return undefined;
	const normalized = Object.fromEntries(
		Object.entries(adjustments).flatMap(([slotId, adjustment]) => {
			const normalizedAdjustment =
				normalizeSplitSlotTransformAdjustment(adjustment);
			return normalizedAdjustment ? [[slotId, normalizedAdjustment]] : [];
		}),
	);
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function getEffectiveVideoSplitScreenSlotTransformOverride({
	slot,
}: {
	slot: Pick<
		VideoSplitScreenSlotBinding,
		"transformOverride" | "transformOverridesBySlotId"
	> & { slotId?: string };
}): VideoSplitScreenSlotBinding["transformOverride"] {
	return (
		(slot.slotId
			? (slot.transformOverridesBySlotId?.[slot.slotId] ?? null)
			: null) ??
		slot.transformOverride ??
		null
	);
}

export function getEffectiveVideoSplitScreenSlotTransformAdjustment({
	slot,
	viewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
}: {
	slot: Pick<VideoSplitScreenSlotBinding, "transformAdjustmentsBySlotId"> & {
		slotId?: string;
	};
	viewportBalance?: VideoSplitScreenViewportBalance;
}): VideoSplitScreenSlotTransformAdjustment | null {
	if (!slot.slotId) return null;
	const variantKey = getVideoSplitScreenVariantKey({
		slotId: slot.slotId,
		viewportBalance,
	});
	return (
		slot.transformAdjustmentsBySlotId?.[variantKey] ??
		slot.transformAdjustmentsBySlotId?.[slot.slotId] ??
		null
	);
}

function getFitBaseScale({
	rendererWidth,
	rendererHeight,
	sourceWidth,
	sourceHeight,
	fitMode,
}: {
	rendererWidth: number;
	rendererHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	fitMode: "contain" | "cover";
}): number {
	const widthRatio = rendererWidth / Math.max(1, sourceWidth);
	const heightRatio = rendererHeight / Math.max(1, sourceHeight);
	return fitMode === "cover"
		? Math.max(widthRatio, heightRatio)
		: Math.min(widthRatio, heightRatio);
}

function getSourceCenterForTransform({
	transform,
	baseScale,
	sourceWidth,
	sourceHeight,
}: {
	transform: Pick<Transform, "position" | "scale">;
	baseScale: number;
	sourceWidth: number;
	sourceHeight: number;
}): { x: number; y: number } {
	const totalScale = Math.max(1e-6, baseScale * transform.scale);
	return {
		x: sourceWidth / 2 - transform.position.x / totalScale,
		y: sourceHeight / 2 - transform.position.y / totalScale,
	};
}

function buildTransformForSourceCenter({
	sourceCenter,
	scale,
	baseScale,
	sourceWidth,
	sourceHeight,
	rotate = 0,
}: {
	sourceCenter: { x: number; y: number };
	scale: number;
	baseScale: number;
	sourceWidth: number;
	sourceHeight: number;
	rotate?: number;
}): Transform {
	const totalScale = baseScale * scale;
	return {
		position: {
			x: -((sourceCenter.x - sourceWidth / 2) * totalScale),
			y: -((sourceCenter.y - sourceHeight / 2) * totalScale),
		},
		scale,
		rotate,
	};
}

function getSplitViewportCoverBaseScale({
	viewport,
	sourceWidth,
	sourceHeight,
}: {
	viewport: VideoSplitScreenViewport;
	sourceWidth?: number;
	sourceHeight?: number;
}): number {
	if (
		!Number.isFinite(sourceWidth) ||
		!Number.isFinite(sourceHeight) ||
		(sourceWidth ?? 0) <= 0 ||
		(sourceHeight ?? 0) <= 0
	) {
		return viewport.height;
	}
	return Math.max(
		viewport.width / Math.max(1, sourceWidth ?? 0),
		viewport.height / Math.max(1, sourceHeight ?? 0),
	);
}

export interface VideoAngleSection {
	startTime: number;
	endTime: number;
	presetId: string | null;
	switchId: string | null;
	splitSectionId: string | null;
	isSplit: boolean;
}

export function rebuildVideoReframeStateFromAngleSections({
	element,
	sections,
}: {
	element: VideoElement;
	sections: VideoAngleSection[];
}): Pick<
	VideoElement,
	"defaultReframePresetId" | "reframeSwitches" | "splitScreen"
> {
	const normalized = normalizeVideoReframeState({ element });
	if (sections.length === 0) {
		return {
			defaultReframePresetId: normalized.defaultReframePresetId ?? null,
			reframeSwitches: [],
			splitScreen: normalized.splitScreen,
		};
	}

	const defaultReframePresetId = sections[0]?.presetId ?? null;
	const reframeSwitches = sections
		.slice(1)
		.reduce<NonNullable<VideoElement["reframeSwitches"]>>((result, section) => {
			return [
				...(result ?? []),
				{
					id: generateUUID(),
					time: section.startTime,
					presetId: section.presetId ?? defaultReframePresetId ?? "",
				},
			];
		}, [])
		.filter((entry) => Boolean(entry.presetId));

	const baseSplitScreen = normalized.splitScreen ?? {
		enabled: false,
		layoutPreset: DEFAULT_SPLIT_LAYOUT_PRESET,
		slots: buildDefaultVideoSplitScreenBindings({
			layoutPreset: DEFAULT_SPLIT_LAYOUT_PRESET,
			presets: normalized.reframePresets ?? [],
		}),
		sections: [],
	};

	const splitSections = sections
		.slice(1)
		.reduce<VideoSplitScreenSection[]>((result, section, index) => {
			const previousIsSplit =
				index === 0
					? (sections[0]?.isSplit ?? false)
					: (sections[index]?.isSplit ?? false);
			if (section.isSplit === previousIsSplit) {
				return result;
			}
			return [
				...result,
				{
					id: generateUUID(),
					startTime: section.startTime,
					enabled: section.isSplit,
					slots: baseSplitScreen.slots,
				},
			];
		}, []);

	return {
		defaultReframePresetId,
		reframeSwitches: reframeSwitches ?? [],
		splitScreen: {
			...baseSplitScreen,
			enabled: sections[0]?.isSplit ?? false,
			sections: splitSections,
		},
	};
}

export function splitVideoAngleSectionsAtTime({
	element,
	splitTime,
}: {
	element: VideoElement;
	splitTime: number;
}): {
	left: Pick<
		VideoElement,
		"defaultReframePresetId" | "reframeSwitches" | "splitScreen"
	>;
	right: Pick<
		VideoElement,
		"defaultReframePresetId" | "reframeSwitches" | "splitScreen"
	>;
} {
	const normalized = normalizeVideoReframeState({ element });
	const safeSplitTime = Math.max(0, Math.min(normalized.duration, splitTime));
	const leftSections = deriveVideoAngleSections({ element: normalized })
		.filter(
			(section) =>
				section.startTime < safeSplitTime - REFRAME_SWITCH_TIME_EPSILON,
		)
		.map((section) => ({
			...section,
			endTime: Math.min(section.endTime, safeSplitTime),
		}));
	const activeSection =
		getVideoReframeSectionAtTime({
			element: normalized,
			localTime: safeSplitTime,
		}) ??
		deriveVideoReframeSections({ element: normalized })[0] ??
		null;
	const activeSplit = resolveVideoSplitScreenAtTime({
		element: normalized,
		localTime: safeSplitTime,
	});
	const rightSections = deriveVideoAngleSections({ element: normalized })
		.filter(
			(section) =>
				section.endTime > safeSplitTime + REFRAME_SWITCH_TIME_EPSILON,
		)
		.map((section, index) => ({
			...section,
			startTime:
				index === 0 ? 0 : Math.max(0, section.startTime - safeSplitTime),
			endTime: Math.max(0, section.endTime - safeSplitTime),
			presetId:
				index === 0
					? (activeSection?.presetId ?? section.presetId)
					: section.presetId,
			isSplit: index === 0 ? Boolean(activeSplit) : section.isSplit,
		}));
	if (rightSections.length === 0) {
		rightSections.push({
			startTime: 0,
			endTime: Math.max(0, normalized.duration - safeSplitTime),
			presetId:
				activeSection?.presetId ?? normalized.defaultReframePresetId ?? null,
			switchId: null,
			splitSectionId: null,
			isSplit: Boolean(activeSplit),
		});
	}
	if (leftSections.length === 0) {
		leftSections.push({
			startTime: 0,
			endTime: safeSplitTime,
			presetId:
				normalized.defaultReframePresetId ?? activeSection?.presetId ?? null,
			switchId: null,
			splitSectionId: null,
			isSplit:
				deriveVideoAngleSections({ element: normalized })[0]?.isSplit ?? false,
		});
	}

	return {
		left: rebuildVideoReframeStateFromAngleSections({
			element: { ...normalized, duration: safeSplitTime },
			sections: leftSections,
		}),
		right: rebuildVideoReframeStateFromAngleSections({
			element: {
				...normalized,
				duration: Math.max(0, normalized.duration - safeSplitTime),
			},
			sections: rightSections,
		}),
	};
}

export function remapSplitSlotTransformBetweenViewports({
	transform,
	layoutPreset,
	viewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
	fromSlotId,
	toSlotId,
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
}: {
	transform: {
		position: Transform["position"];
		scale: number;
	};
	layoutPreset: VideoSplitScreenLayoutPreset;
	viewportBalance?: VideoSplitScreenViewportBalance;
	fromSlotId: string;
	toSlotId: string;
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth?: number;
	sourceHeight?: number;
}): {
	position: Transform["position"];
	scale: number;
} {
	if (fromSlotId === toSlotId) {
		return {
			position: {
				x: transform.position.x,
				y: transform.position.y,
			},
			scale: transform.scale,
		};
	}
	if (layoutPreset !== "top-bottom") {
		return {
			position: {
				x: transform.position.x,
				y: transform.position.y,
			},
			scale: transform.scale,
		};
	}
	const viewports = getVideoSplitScreenViewports({
		layoutPreset,
		viewportBalance,
		width: canvasWidth,
		height: canvasHeight,
	});
	const fromViewport = viewports.get(fromSlotId);
	const toViewport = viewports.get(toSlotId);
	if (!fromViewport || !toViewport) {
		return {
			position: {
				x: transform.position.x,
				y: transform.position.y,
			},
			scale: transform.scale,
		};
	}
	const fromCenterX = fromViewport.x + fromViewport.width / 2;
	const fromCenterY = fromViewport.y + fromViewport.height / 2;
	const toCenterX = toViewport.x + toViewport.width / 2;
	const toCenterY = toViewport.y + toViewport.height / 2;
	const canvasCenterX = canvasWidth / 2;
	const canvasCenterY = canvasHeight / 2;
	const fromBaseScale = getSplitViewportCoverBaseScale({
		viewport: fromViewport,
		sourceWidth,
		sourceHeight,
	});
	const toBaseScale = getSplitViewportCoverBaseScale({
		viewport: toViewport,
		sourceWidth,
		sourceHeight,
	});
	const scaleRatio = toBaseScale / Math.max(1e-6, fromBaseScale);
	return {
		position: {
			x:
				toCenterX -
				canvasCenterX -
				(fromCenterX - canvasCenterX - transform.position.x) * scaleRatio,
			y:
				toCenterY -
				canvasCenterY -
				(fromCenterY - canvasCenterY - transform.position.y) * scaleRatio,
		},
		scale: transform.scale,
	};
}

export function remapSplitSlotTransformBetweenViewportBalances({
	transform,
	layoutPreset,
	fromViewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
	toViewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
	slotId,
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
}: {
	transform: {
		position: Transform["position"];
		scale: number;
	};
	layoutPreset: VideoSplitScreenLayoutPreset;
	fromViewportBalance?: VideoSplitScreenViewportBalance;
	toViewportBalance?: VideoSplitScreenViewportBalance;
	slotId: string;
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth?: number;
	sourceHeight?: number;
}): {
	position: Transform["position"];
	scale: number;
} {
	if (fromViewportBalance === toViewportBalance) {
		return {
			position: {
				x: transform.position.x,
				y: transform.position.y,
			},
			scale: transform.scale,
		};
	}
	const fromViewports = getVideoSplitScreenViewports({
		layoutPreset,
		viewportBalance: fromViewportBalance,
		width: canvasWidth,
		height: canvasHeight,
	});
	const toViewports = getVideoSplitScreenViewports({
		layoutPreset,
		viewportBalance: toViewportBalance,
		width: canvasWidth,
		height: canvasHeight,
	});
	const fromViewport = fromViewports.get(slotId);
	const toViewport = toViewports.get(slotId);
	if (!fromViewport || !toViewport) {
		return {
			position: {
				x: transform.position.x,
				y: transform.position.y,
			},
			scale: transform.scale,
		};
	}
	const fromCenterX = fromViewport.x + fromViewport.width / 2;
	const fromCenterY = fromViewport.y + fromViewport.height / 2;
	const toCenterX = toViewport.x + toViewport.width / 2;
	const toCenterY = toViewport.y + toViewport.height / 2;
	const canvasCenterX = canvasWidth / 2;
	const canvasCenterY = canvasHeight / 2;
	const fromBaseScale = getSplitViewportCoverBaseScale({
		viewport: fromViewport,
		sourceWidth,
		sourceHeight,
	});
	const toBaseScale = getSplitViewportCoverBaseScale({
		viewport: toViewport,
		sourceWidth,
		sourceHeight,
	});
	const scaleRatio = toBaseScale / Math.max(1e-6, fromBaseScale);
	return {
		position: {
			x:
				toCenterX -
				canvasCenterX -
				(fromCenterX - canvasCenterX - transform.position.x) * scaleRatio,
			y:
				toCenterY -
				canvasCenterY -
				(fromCenterY - canvasCenterY - transform.position.y) * scaleRatio,
		},
		scale: transform.scale,
	};
}

export function getVideoSplitScreenViewports({
	layoutPreset,
	viewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
	width,
	height,
}: {
	layoutPreset: VideoSplitScreenLayoutPreset;
	viewportBalance?: VideoSplitScreenViewportBalance;
	width: number;
	height: number;
}): Map<string, VideoSplitScreenViewport> {
	if (layoutPreset !== "top-bottom") {
		const halfHeight = Math.max(0, (height - SPLIT_DIVIDER_THICKNESS) / 2);
		const topHeight = Math.round(halfHeight);
		const bottomY = topHeight + SPLIT_DIVIDER_THICKNESS;
		return new Map([
			["top", { x: 0, y: 0, width, height: topHeight }],
			[
				"bottom",
				{
					x: 0,
					y: bottomY,
					width,
					height: Math.max(0, height - bottomY),
				},
			],
		]);
	}
	const availableHeight = Math.max(0, height - SPLIT_DIVIDER_THICKNESS);
	const topHeight = Math.round(
		viewportBalance === "unbalanced"
			? availableHeight * UNBALANCED_TOP_SPLIT_RATIO
			: availableHeight / 2,
	);
	const bottomY = topHeight + SPLIT_DIVIDER_THICKNESS;
	return new Map([
		["top", { x: 0, y: 0, width, height: topHeight }],
		[
			"bottom",
			{ x: 0, y: bottomY, width, height: Math.max(0, height - bottomY) },
		],
	]);
}

export function getVideoSplitScreenDividers({
	layoutPreset,
	viewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
	width,
	height,
}: {
	layoutPreset: VideoSplitScreenLayoutPreset;
	viewportBalance?: VideoSplitScreenViewportBalance;
	width: number;
	height: number;
}): VideoSplitScreenDivider[] {
	if (layoutPreset !== "top-bottom") return [];
	const viewports = getVideoSplitScreenViewports({
		layoutPreset,
		viewportBalance,
		width,
		height,
	});
	const topViewport = viewports.get("top");
	const bottomViewport = viewports.get("bottom");
	if (!topViewport || !bottomViewport) return [];
	return [
		{
			x: 0,
			y: Math.round(topViewport.y + topViewport.height),
			width,
			height: Math.max(0, bottomViewport.y - (topViewport.y + topViewport.height)),
		},
	];
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
			: (presets[0]?.id ?? null);

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
				transformOverride: normalizeSplitSlotTransformOverride(
					candidate?.transformOverride,
				),
				transformOverridesBySlotId: (() => {
					const normalizedOverrides =
						normalizeSplitSlotTransformOverridesBySlotId(
							candidate?.transformOverridesBySlotId,
						) ?? {};
					const currentOverride = normalizeSplitSlotTransformOverride(
						candidate?.transformOverride,
					);
					if (currentOverride && normalizedOverrides[slotId] === undefined) {
						normalizedOverrides[slotId] = currentOverride;
					}
					return Object.keys(normalizedOverrides).length > 0
						? normalizedOverrides
						: undefined;
				})(),
				transformAdjustmentsBySlotId:
					normalizeSplitSlotTransformAdjustmentsBySlotId(
						candidate?.transformAdjustmentsBySlotId,
					),
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
		viewportBalance:
			splitScreen.viewportBalance === "unbalanced"
				? "unbalanced"
				: DEFAULT_SPLIT_VIEWPORT_BALANCE,
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

export function getActiveReframePresetIdFromState({
	defaultReframePresetId,
	reframeSwitches,
	duration,
	localTime,
}: {
	defaultReframePresetId?: string | null;
	reframeSwitches?: VideoElement["reframeSwitches"];
	duration: number;
	localTime: number;
}): string | null {
	const safeTime = Math.max(0, Math.min(duration, localTime));
	let activePresetId = defaultReframePresetId ?? null;
	for (const entry of reframeSwitches ?? []) {
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
		(element.reframePresets ?? []).some(
			(preset) => preset.id === selectedPresetId,
		)
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
	mergeAdjacent = true,
}: {
	element: VideoElement;
	mergeAdjacent?: boolean;
}): VideoAngleSection[] {
	const normalized = normalizeVideoReframeState({ element });
	const reframeSections = deriveVideoReframeSections({ element: normalized });
	const splitRanges = deriveVideoSplitScreenSectionRanges({
		element: normalized,
	});
	const enabledSplitRanges = splitRanges.filter((range) => range.enabled);
	if (enabledSplitRanges.length === 0) {
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
			splitSectionId: splitRange?.enabled ? splitRange.sectionId : null,
			isSplit: splitRange?.enabled ?? false,
		});
	}

	if (!mergeAdjacent) {
		return sections;
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

export function getVideoAngleSectionAtTime({
	element,
	localTime,
}: {
	element: VideoElement;
	localTime: number;
}): VideoAngleSection | null {
	const safeTime = Math.max(0, Math.min(element.duration, localTime));
	const sections = deriveVideoAngleSections({ element });
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

export function getVideoAngleSectionByStartTime({
	element,
	startTime,
}: {
	element: VideoElement;
	startTime: number | null | undefined;
}): VideoAngleSection | null {
	if (startTime === null || startTime === undefined) return null;
	return (
		deriveVideoAngleSections({ element }).find(
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

export function resolveVideoReframeTransformFromState({
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
	const presetId = getActiveReframePresetIdFromState({
		defaultReframePresetId,
		reframeSwitches,
		duration,
		localTime,
	});
	const preset = presetId
		? (reframePresets?.find((candidate) => candidate.id === presetId) ?? null)
		: null;
	if (!preset) {
		return baseTransform;
	}
	return {
		position: preset.transform.position,
		scale: preset.transform.scale,
		rotate: baseTransform.rotate,
	};
}

function resolveVideoSplitScreenSlotBaseTransform({
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
	slot: Pick<VideoSplitScreenSlotBinding, "presetId">;
}): Transform {
	return resolveVideoReframeTransform({
		baseTransform,
		duration,
		reframePresets,
		reframeSwitches: !slot.presetId
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
}

function resolveVideoSplitScreenSlotBaseTransformFromState({
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
	slot: Pick<VideoSplitScreenSlotBinding, "presetId">;
}): Transform {
	return resolveVideoReframeTransformFromState({
		baseTransform,
		duration,
		reframePresets,
		reframeSwitches: !slot.presetId
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
}

function deriveSplitSlotSeedTransformFromBase({
	baseTransform,
	slotId,
	layoutPreset,
	viewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
}: {
	baseTransform: Transform;
	slotId: string;
	layoutPreset: VideoSplitScreenLayoutPreset;
	viewportBalance?: VideoSplitScreenViewportBalance;
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
}): Transform {
	const viewport = getVideoSplitScreenViewports({
		layoutPreset,
		viewportBalance,
		width: canvasWidth,
		height: canvasHeight,
	}).get(slotId);
	if (!viewport) {
		return baseTransform;
	}
	const baseContainScale = getFitBaseScale({
		rendererWidth: canvasWidth,
		rendererHeight: canvasHeight,
		sourceWidth,
		sourceHeight,
		fitMode: "contain",
	});
	const slotCoverScale = getFitBaseScale({
		rendererWidth: viewport.width,
		rendererHeight: viewport.height,
		sourceWidth,
		sourceHeight,
		fitMode: "cover",
	});
	const sourceCenter = getSourceCenterForTransform({
		transform: baseTransform,
		baseScale: baseContainScale,
		sourceWidth,
		sourceHeight,
	});
	const slotScale =
		(baseContainScale * baseTransform.scale) / Math.max(1e-6, slotCoverScale);
	return buildTransformForSourceCenter({
		sourceCenter,
		scale: slotScale,
		baseScale: slotCoverScale,
		sourceWidth,
		sourceHeight,
		rotate: baseTransform.rotate,
	});
}

export function deriveVideoSplitScreenSlotAdjustmentFromTransform({
	baseTransform,
	finalTransform,
	slotId,
	layoutPreset,
	viewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
}: {
	baseTransform: Transform;
	finalTransform: Pick<Transform, "position" | "scale">;
	slotId: string;
	layoutPreset: VideoSplitScreenLayoutPreset;
	viewportBalance?: VideoSplitScreenViewportBalance;
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
}): VideoSplitScreenSlotTransformAdjustment {
	const viewport = getVideoSplitScreenViewports({
		layoutPreset,
		viewportBalance,
		width: canvasWidth,
		height: canvasHeight,
	}).get(slotId);
	if (!viewport) {
		return {
			sourceCenterOffset: { x: 0, y: 0 },
			scaleMultiplier: 1,
		};
	}
	const seedTransform = deriveSplitSlotSeedTransformFromBase({
		baseTransform,
		slotId,
		layoutPreset,
		viewportBalance,
		canvasWidth,
		canvasHeight,
		sourceWidth,
		sourceHeight,
	});
	const slotCoverScale = getFitBaseScale({
		rendererWidth: viewport.width,
		rendererHeight: viewport.height,
		sourceWidth,
		sourceHeight,
		fitMode: "cover",
	});
	const seedCenter = getSourceCenterForTransform({
		transform: seedTransform,
		baseScale: slotCoverScale,
		sourceWidth,
		sourceHeight,
	});
	const finalCenter = getSourceCenterForTransform({
		transform: finalTransform,
		baseScale: slotCoverScale,
		sourceWidth,
		sourceHeight,
	});
	return {
		sourceCenterOffset: {
			x: finalCenter.x - seedCenter.x,
			y: finalCenter.y - seedCenter.y,
		},
		scaleMultiplier: finalTransform.scale / Math.max(1e-6, seedTransform.scale),
	};
}

function resolveVideoSplitScreenSlotTransformWithViewport({
	baseResolvedTransform,
	slot,
	layoutPreset,
	viewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
}: {
	baseResolvedTransform: Transform;
	slot: Pick<
		VideoSplitScreenSlotBinding,
		| "transformOverride"
		| "transformOverridesBySlotId"
		| "transformAdjustmentsBySlotId"
	> & { slotId?: string };
	layoutPreset: VideoSplitScreenLayoutPreset;
	viewportBalance?: VideoSplitScreenViewportBalance;
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
}): Transform {
	const legacyOverride = getEffectiveVideoSplitScreenSlotTransformOverride({
		slot,
	});
	const adjustment = getEffectiveVideoSplitScreenSlotTransformAdjustment({
		slot,
		viewportBalance,
	});
	if (!slot.slotId) {
		return legacyOverride
			? {
					position: { ...legacyOverride.position },
					scale: legacyOverride.scale,
					rotate: baseResolvedTransform.rotate,
				}
			: baseResolvedTransform;
	}
	const seedTransform = deriveSplitSlotSeedTransformFromBase({
		baseTransform: baseResolvedTransform,
		slotId: slot.slotId,
		layoutPreset,
		viewportBalance,
		canvasWidth,
		canvasHeight,
		sourceWidth,
		sourceHeight,
	});
	const viewport = getVideoSplitScreenViewports({
		layoutPreset,
		viewportBalance,
		width: canvasWidth,
		height: canvasHeight,
	}).get(slot.slotId);
	if (!viewport) {
		return seedTransform;
	}
	const slotCoverScale = getFitBaseScale({
		rendererWidth: viewport.width,
		rendererHeight: viewport.height,
		sourceWidth,
		sourceHeight,
		fitMode: "cover",
	});
	const appliedAdjustment =
		adjustment ??
		(legacyOverride
			? deriveVideoSplitScreenSlotAdjustmentFromTransform({
					baseTransform: baseResolvedTransform,
					finalTransform: legacyOverride,
					slotId: slot.slotId,
					layoutPreset,
					viewportBalance,
					canvasWidth,
					canvasHeight,
					sourceWidth,
					sourceHeight,
				})
			: null);
	if (!appliedAdjustment) {
		return seedTransform;
	}
	const seedCenter = getSourceCenterForTransform({
		transform: seedTransform,
		baseScale: slotCoverScale,
		sourceWidth,
		sourceHeight,
	});
	return buildTransformForSourceCenter({
		sourceCenter: {
			x: seedCenter.x + appliedAdjustment.sourceCenterOffset.x,
			y: seedCenter.y + appliedAdjustment.sourceCenterOffset.y,
		},
		scale: seedTransform.scale * appliedAdjustment.scaleMultiplier,
		baseScale: slotCoverScale,
		sourceWidth,
		sourceHeight,
		rotate: baseResolvedTransform.rotate,
	});
}

export function resolveVideoSplitScreenSlotTransform({
	baseTransform,
	duration,
	reframePresets,
	reframeSwitches,
	defaultReframePresetId,
	localTime,
	slot,
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	layoutPreset = DEFAULT_SPLIT_LAYOUT_PRESET,
	viewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
}: {
	baseTransform: Transform;
	duration: number;
	reframePresets?: VideoElement["reframePresets"];
	reframeSwitches?: VideoElement["reframeSwitches"];
	defaultReframePresetId?: string | null;
	localTime: number;
	slot: Pick<
		VideoSplitScreenSlotBinding,
		| "presetId"
		| "transformOverride"
		| "transformOverridesBySlotId"
		| "transformAdjustmentsBySlotId"
	> & { slotId?: string };
	canvasWidth?: number;
	canvasHeight?: number;
	sourceWidth?: number;
	sourceHeight?: number;
	layoutPreset?: VideoSplitScreenLayoutPreset;
	viewportBalance?: VideoSplitScreenViewportBalance;
}): Transform {
	const resolvedTransform = resolveVideoSplitScreenSlotBaseTransform({
		baseTransform,
		duration,
		reframePresets,
		reframeSwitches,
		defaultReframePresetId,
		localTime,
		slot,
	});
	if (
		!Number.isFinite(canvasWidth) ||
		!Number.isFinite(canvasHeight) ||
		!Number.isFinite(sourceWidth) ||
		!Number.isFinite(sourceHeight) ||
		(sourceWidth ?? 0) <= 0 ||
		(sourceHeight ?? 0) <= 0
	) {
		const legacyOverride = getEffectiveVideoSplitScreenSlotTransformOverride({
			slot,
		});
		return legacyOverride
			? {
					position: { ...legacyOverride.position },
					scale: legacyOverride.scale,
					rotate: resolvedTransform.rotate,
				}
			: resolvedTransform;
	}
	const resolvedCanvasWidth = canvasWidth as number;
	const resolvedCanvasHeight = canvasHeight as number;
	const resolvedSourceWidth = sourceWidth as number;
	const resolvedSourceHeight = sourceHeight as number;
	return resolveVideoSplitScreenSlotTransformWithViewport({
		baseResolvedTransform: resolvedTransform,
		slot,
		layoutPreset,
		viewportBalance,
		canvasWidth: resolvedCanvasWidth,
		canvasHeight: resolvedCanvasHeight,
		sourceWidth: resolvedSourceWidth,
		sourceHeight: resolvedSourceHeight,
	});
}

export function resolveVideoSplitScreenSlotTransformFromState({
	baseTransform,
	duration,
	reframePresets,
	reframeSwitches,
	defaultReframePresetId,
	localTime,
	slot,
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	layoutPreset = DEFAULT_SPLIT_LAYOUT_PRESET,
	viewportBalance = DEFAULT_SPLIT_VIEWPORT_BALANCE,
}: {
	baseTransform: Transform;
	duration: number;
	reframePresets?: VideoElement["reframePresets"];
	reframeSwitches?: VideoElement["reframeSwitches"];
	defaultReframePresetId?: string | null;
	localTime: number;
	slot: Pick<
		VideoSplitScreenSlotBinding,
		| "presetId"
		| "transformOverride"
		| "transformOverridesBySlotId"
		| "transformAdjustmentsBySlotId"
	> & { slotId?: string };
	canvasWidth?: number;
	canvasHeight?: number;
	sourceWidth?: number;
	sourceHeight?: number;
	layoutPreset?: VideoSplitScreenLayoutPreset;
	viewportBalance?: VideoSplitScreenViewportBalance;
}): Transform {
	const resolvedTransform = resolveVideoSplitScreenSlotBaseTransformFromState({
		baseTransform,
		duration,
		reframePresets,
		reframeSwitches,
		defaultReframePresetId,
		localTime,
		slot,
	});
	if (
		!Number.isFinite(canvasWidth) ||
		!Number.isFinite(canvasHeight) ||
		!Number.isFinite(sourceWidth) ||
		!Number.isFinite(sourceHeight) ||
		(sourceWidth ?? 0) <= 0 ||
		(sourceHeight ?? 0) <= 0
	) {
		const legacyOverride = getEffectiveVideoSplitScreenSlotTransformOverride({
			slot,
		});
		return legacyOverride
			? {
					position: { ...legacyOverride.position },
					scale: legacyOverride.scale,
					rotate: resolvedTransform.rotate,
				}
			: resolvedTransform;
	}
	const resolvedCanvasWidth = canvasWidth as number;
	const resolvedCanvasHeight = canvasHeight as number;
	const resolvedSourceWidth = sourceWidth as number;
	const resolvedSourceHeight = sourceHeight as number;
	return resolveVideoSplitScreenSlotTransformWithViewport({
		baseResolvedTransform: resolvedTransform,
		slot,
		layoutPreset,
		viewportBalance,
		canvasWidth: resolvedCanvasWidth,
		canvasHeight: resolvedCanvasHeight,
		sourceWidth: resolvedSourceWidth,
		sourceHeight: resolvedSourceHeight,
	});
}

export function getVideoSplitScreenLayoutSlotIds({
	layoutPreset,
}: {
	layoutPreset: VideoSplitScreenLayoutPreset;
}): string[] {
	return (
		SPLIT_LAYOUT_SLOTS[layoutPreset] ??
		SPLIT_LAYOUT_SLOTS[DEFAULT_SPLIT_LAYOUT_PRESET]
	);
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
		presets.map(
			(preset) => [preset.name.trim().toLowerCase(), preset] as const,
		),
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
					normalizedName.includes("subject") &&
					normalizedName.includes("right"),
			),
	];
	const fallbackPresets = presets.filter(
		(preset) =>
			preset.id !== preferredPresets[0]?.id &&
			preset.id !== preferredPresets[1]?.id,
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
		const nextStartTime =
			splitScreen.sections[index + 1]?.startTime ?? element.duration;
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
	const effectiveEnabled = section
		? section.enabled !== false
		: splitScreen?.enabled;
	if (!splitScreen || !effectiveEnabled) return null;
	const activePresetId = getActiveReframePresetId({
		element: normalized,
		localTime,
	});
	const slotBindings = splitScreen.slots;
	const resolvedSlots: VideoSplitScreenResolvedSlot[] = slotBindings.map(
		(slot) => {
			const binding = slot;
			const presetId =
				binding.mode === "fixed-preset"
					? (binding.presetId ??
						activePresetId ??
						normalized.defaultReframePresetId ??
						null)
					: (activePresetId ?? normalized.defaultReframePresetId ?? null);
			return {
				slotId: slot.slotId,
				mode: binding.mode,
				presetId,
				transformOverride:
					getEffectiveVideoSplitScreenSlotTransformOverride({
						slot: binding,
					}) ?? null,
				transformOverridesBySlotId: binding.transformOverridesBySlotId
					? { ...binding.transformOverridesBySlotId }
					: undefined,
				transformAdjustmentsBySlotId: binding.transformAdjustmentsBySlotId
					? { ...binding.transformAdjustmentsBySlotId }
					: undefined,
			};
		},
	);
	return {
		...splitScreen,
		viewportBalance:
			splitScreen.viewportBalance ?? DEFAULT_SPLIT_VIEWPORT_BALANCE,
		slots: resolvedSlots,
	};
}

export function resolveVideoSplitScreenAtTimeFromState({
	duration,
	splitScreen,
	defaultReframePresetId,
	reframeSwitches,
	localTime,
}: {
	duration: number;
	splitScreen?: VideoElement["splitScreen"];
	defaultReframePresetId?: string | null;
	reframeSwitches?: VideoElement["reframeSwitches"];
	localTime: number;
}): VideoSplitScreen | null {
	if (!splitScreen) return null;
	const safeTime = Math.max(0, Math.min(duration, localTime));
	const sections = splitScreen.sections ?? [];
	let activeSection: VideoSplitScreenSection | null = null;
	for (let index = 0; index < sections.length; index++) {
		const section = sections[index]!;
		const nextStartTime = sections[index + 1]?.startTime ?? duration;
		const isLast = index === sections.length - 1;
		if (safeTime + REFRAME_SWITCH_TIME_EPSILON < section.startTime) continue;
		if (safeTime < nextStartTime || (isLast && safeTime <= nextStartTime)) {
			activeSection = section;
			break;
		}
	}
	const effectiveEnabled = activeSection
		? activeSection.enabled !== false
		: splitScreen.enabled;
	if (!effectiveEnabled) return null;
	const activePresetId = getActiveReframePresetIdFromState({
		defaultReframePresetId,
		reframeSwitches,
		duration,
		localTime: safeTime,
	});
	return {
		...splitScreen,
		viewportBalance:
			splitScreen.viewportBalance ?? DEFAULT_SPLIT_VIEWPORT_BALANCE,
		slots: (splitScreen.slots ?? []).map((slot) => {
			const presetId =
				slot.mode === "fixed-preset"
					? (slot.presetId ?? activePresetId ?? defaultReframePresetId ?? null)
					: (activePresetId ?? defaultReframePresetId ?? null);
			return {
				slotId: slot.slotId,
				mode: slot.mode,
				presetId,
				transformOverride:
					getEffectiveVideoSplitScreenSlotTransformOverride({
						slot,
					}) ?? null,
				transformOverridesBySlotId: slot.transformOverridesBySlotId
					? { ...slot.transformOverridesBySlotId }
					: undefined,
				transformAdjustmentsBySlotId: slot.transformAdjustmentsBySlotId
					? { ...slot.transformAdjustmentsBySlotId }
					: undefined,
			};
		}),
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

export function applyPresetToVideoAngleSection({
	element,
	sectionStartTime,
	presetId,
}: {
	element: VideoElement;
	sectionStartTime: number;
	presetId: string;
}): Pick<
	VideoElement,
	"defaultReframePresetId" | "reframeSwitches" | "splitScreen"
> {
	const normalized = normalizeVideoReframeState({ element });
	const sections = deriveVideoAngleSections({
		element: normalized,
		mergeAdjacent: false,
	});
	if (
		!sections.some(
			(section) =>
				Math.abs(section.startTime - sectionStartTime) <=
				REFRAME_SWITCH_TIME_EPSILON,
		)
	) {
		return {
			defaultReframePresetId: normalized.defaultReframePresetId,
			reframeSwitches: normalized.reframeSwitches,
			splitScreen: normalized.splitScreen,
		};
	}
	return rebuildVideoReframeStateFromAngleSections({
		element: normalized,
		sections: sections.map((section) =>
			Math.abs(section.startTime - sectionStartTime) <=
			REFRAME_SWITCH_TIME_EPSILON
				? {
						...section,
						presetId,
						isSplit: false,
					}
				: section,
		),
	});
}

export function applySplitScreenToVideoAngleSection({
	element,
	sectionStartTime,
}: {
	element: VideoElement;
	sectionStartTime: number;
}): Pick<
	VideoElement,
	"defaultReframePresetId" | "reframeSwitches" | "splitScreen"
> {
	return applySplitEnabledToVideoAngleSection({
		element,
		sectionStartTime,
		enabled: true,
	});
}

function applySplitEnabledToVideoAngleSection({
	element,
	sectionStartTime,
	enabled,
}: {
	element: VideoElement;
	sectionStartTime: number;
	enabled: boolean;
}): Pick<
	VideoElement,
	"defaultReframePresetId" | "reframeSwitches" | "splitScreen"
> {
	const normalized = normalizeVideoReframeState({ element });
	const targetSection = getVideoAngleSectionByStartTime({
		element: normalized,
		startTime: sectionStartTime,
	});
	if (!targetSection) {
		return {
			defaultReframePresetId: normalized.defaultReframePresetId,
			reframeSwitches: normalized.reframeSwitches,
			splitScreen: normalized.splitScreen,
		};
	}

	const baseSplitScreen = normalized.splitScreen ?? {
		enabled: false,
		layoutPreset: DEFAULT_SPLIT_LAYOUT_PRESET,
		slots: buildDefaultVideoSplitScreenBindings({
			layoutPreset: DEFAULT_SPLIT_LAYOUT_PRESET,
			presets: normalized.reframePresets ?? [],
		}),
		sections: [],
	};
	const previousSplitEnabled =
		targetSection.startTime <= REFRAME_SWITCH_TIME_EPSILON
			? null
			: Boolean(
					resolveVideoSplitScreenAtTime({
						element: {
							...normalized,
							splitScreen: baseSplitScreen,
						},
						localTime: Math.max(
							0,
							targetSection.startTime - REFRAME_SWITCH_TIME_EPSILON * 2,
						),
					}),
				);
	const nextSplitEnabled =
		targetSection.endTime >= normalized.duration - REFRAME_SWITCH_TIME_EPSILON
			? null
			: Boolean(
					resolveVideoSplitScreenAtTime({
						element: {
							...normalized,
							splitScreen: baseSplitScreen,
						},
						localTime: Math.min(
							normalized.duration,
							targetSection.endTime + REFRAME_SWITCH_TIME_EPSILON * 2,
						),
					}),
				);

	let splitSections = (baseSplitScreen.sections ?? []).filter(
		(section) =>
			Math.abs(section.startTime - targetSection.startTime) >
				REFRAME_SWITCH_TIME_EPSILON &&
			Math.abs(section.startTime - targetSection.endTime) >
				REFRAME_SWITCH_TIME_EPSILON,
	);

	let splitScreenEnabled = baseSplitScreen.enabled !== false;
	if (targetSection.startTime <= REFRAME_SWITCH_TIME_EPSILON) {
		splitScreenEnabled = enabled;
	} else if (previousSplitEnabled !== enabled) {
		splitSections = replaceOrInsertSplitSection({
			sections: splitSections,
			nextSection: {
				id: generateUUID(),
				startTime: targetSection.startTime,
				enabled,
				slots: baseSplitScreen.slots,
			},
			duration: normalized.duration,
		});
	}

	if (
		nextSplitEnabled !== null &&
		targetSection.endTime < normalized.duration - REFRAME_SWITCH_TIME_EPSILON &&
		nextSplitEnabled !== enabled
	) {
		splitSections = replaceOrInsertSplitSection({
			sections: splitSections,
			nextSection: {
				id: generateUUID(),
				startTime: targetSection.endTime,
				enabled: nextSplitEnabled,
				slots: baseSplitScreen.slots,
			},
			duration: normalized.duration,
		});
	}

	return {
		defaultReframePresetId: normalized.defaultReframePresetId,
		reframeSwitches: normalized.reframeSwitches,
		splitScreen: {
			...baseSplitScreen,
			enabled: splitScreenEnabled,
			sections: splitSections,
		},
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
	return (
		replaceOrInsertReframeSwitch({
			switches: normalized.reframeSwitches,
			nextSwitch: {
				id: generateUUID(),
				time: splitTime,
				presetId: section.presetId ?? normalized.defaultReframePresetId ?? "",
			},
			duration: normalized.duration,
		}) ?? []
	);
}

export function applySelectedReframePresetPreviewToTracks({
	tracks,
	selectedPresetIdByElementId,
	selectedSplitPreviewByElementId,
	selectedElementIds,
}: {
	tracks: TimelineTrack[];
	selectedPresetIdByElementId: Record<string, string | null>;
	selectedSplitPreviewByElementId?: Record<
		string,
		{
			slots: VideoSplitScreenSlotBinding[] | null;
			viewportBalance?: VideoSplitScreenViewportBalance;
		} | null
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
			const selectedSplitPreview =
				selectedSplitPreviewByElementId?.[element.id] ?? null;
			const selectedSplitPreviewSlots = selectedSplitPreview?.slots ?? null;
			if (selectedSplitPreviewSlots?.length) {
				trackChanged = true;
				hasChanges = true;
				const normalizedElement = normalizeVideoReframeState({ element });
				return {
					...normalizedElement,
					splitScreen: {
						enabled: false,
						layoutPreset: DEFAULT_SPLIT_LAYOUT_PRESET,
						viewportBalance:
							selectedSplitPreview?.viewportBalance ??
							DEFAULT_SPLIT_VIEWPORT_BALANCE,
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
			const selectedPresetId = selectedPresetIdByElementId[element.id] ?? null;
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
