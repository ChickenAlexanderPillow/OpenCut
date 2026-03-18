import type {
	Transform,
	VideoElement,
	VideoSplitScreen,
	VideoSplitScreenLayoutPreset,
	VideoSplitScreenSlotBinding,
	VideoSplitScreenViewportBalance,
} from "@/types/timeline";
import {
	buildDefaultVideoSplitScreenBindings,
	deriveVideoSplitScreenSlotAdjustmentFromTransform,
	getActiveReframePresetIdFromState,
	getVideoSplitScreenViewports,
	normalizeVideoReframeState,
	resolveVideoSplitScreenAtTimeFromState,
	resolveVideoSplitScreenSlotTransformFromState,
} from "@/lib/reframe/video-reframe";

export interface SplitPreviewStateInput {
	slots: VideoSplitScreenSlotBinding[] | null;
	viewportBalance?: VideoSplitScreenViewportBalance;
}

export interface EditableSplitSlotState {
	element: VideoElement;
	layoutPreset: VideoSplitScreenLayoutPreset;
	viewportBalance: VideoSplitScreenViewportBalance;
	slots: VideoSplitScreenSlotBinding[];
	isSplitActive: boolean;
	singleViewSlotId: string | null;
}

function getDefaultSplitScreen({
	element,
	viewportBalance,
}: {
	element: VideoElement;
	viewportBalance: VideoSplitScreenViewportBalance;
}): VideoSplitScreen {
	return {
		enabled: false,
		layoutPreset: "top-bottom",
		viewportBalance,
		slots: buildDefaultVideoSplitScreenBindings({
			layoutPreset: "top-bottom",
			presets: element.reframePresets ?? [],
		}),
		sections: [],
	};
}

function resolveSingleViewSlotId({
	slots,
	duration,
	defaultReframePresetId,
	reframeSwitches,
	localTime,
	preferredSlotId,
}: {
	slots: VideoSplitScreenSlotBinding[];
	duration: number;
	defaultReframePresetId?: string | null;
	reframeSwitches?: VideoElement["reframeSwitches"];
	localTime: number;
	preferredSlotId?: string | null;
}): string | null {
	if (slots.length === 0) return null;
	if (
		preferredSlotId &&
		slots.some((slot) => slot.slotId === preferredSlotId)
	) {
		return preferredSlotId;
	}
	const activePresetId = getActiveReframePresetIdFromState({
		defaultReframePresetId,
		reframeSwitches,
		duration,
		localTime,
	});
	const fixedMatch =
		slots.find(
			(slot) =>
				slot.mode === "fixed-preset" &&
				slot.presetId &&
				slot.presetId === activePresetId,
		)?.slotId ?? null;
	if (fixedMatch) return fixedMatch;
	const followActive = slots.find((slot) => slot.mode === "follow-active");
	return followActive?.slotId ?? slots[0]?.slotId ?? null;
}

export function resolveEditableSplitSlotState({
	element,
	localTime,
	splitPreview,
	preferredSlotId,
}: {
	element: VideoElement;
	localTime: number;
	splitPreview?: SplitPreviewStateInput | null;
	preferredSlotId?: string | null;
}): EditableSplitSlotState | null {
	const normalizedElement = normalizeVideoReframeState({ element });
	const previewSlots = splitPreview?.slots ?? null;
	const previewViewportBalance =
		splitPreview?.viewportBalance ??
		normalizedElement.splitScreen?.viewportBalance ??
		"balanced";
	const baseSplitScreen =
		normalizedElement.splitScreen ??
		getDefaultSplitScreen({
			element: normalizedElement,
			viewportBalance: previewViewportBalance,
		});
	const splitScreen: VideoSplitScreen = previewSlots?.length
		? {
				...baseSplitScreen,
				viewportBalance: previewViewportBalance,
				slots: previewSlots,
				sections: (baseSplitScreen.sections ?? []).map((section) =>
					section.enabled === false
						? section
						: {
								...section,
								slots: previewSlots,
							},
				),
			}
		: baseSplitScreen;
	const resolved = resolveVideoSplitScreenAtTimeFromState({
		duration: normalizedElement.duration,
		splitScreen,
		defaultReframePresetId: normalizedElement.defaultReframePresetId,
		reframeSwitches: normalizedElement.reframeSwitches,
		localTime,
	});
	const effectiveSlots =
		(resolved?.slots as VideoSplitScreenSlotBinding[] | undefined) ??
		splitScreen.slots;
	const singleViewSlotId = resolveSingleViewSlotId({
		slots: effectiveSlots,
		duration: normalizedElement.duration,
		defaultReframePresetId: normalizedElement.defaultReframePresetId,
		reframeSwitches: normalizedElement.reframeSwitches,
		localTime,
		preferredSlotId,
	});
	return {
		element: normalizedElement,
		layoutPreset: resolved?.layoutPreset ?? splitScreen.layoutPreset,
		viewportBalance:
			resolved?.viewportBalance ?? splitScreen.viewportBalance ?? "balanced",
		slots: effectiveSlots,
		isSplitActive: Boolean(resolved),
		singleViewSlotId,
	};
}

export function getEditableSplitSlotRegions({
	editableState,
	canvasWidth,
	canvasHeight,
}: {
	editableState: EditableSplitSlotState;
	canvasWidth: number;
	canvasHeight: number;
}): Array<{
	slotId: string;
	bounds: {
		cx: number;
		cy: number;
		width: number;
		height: number;
		rotation: number;
	};
}> {
	if (!editableState.isSplitActive) {
		if (!editableState.singleViewSlotId) return [];
		return [
			{
				slotId: editableState.singleViewSlotId,
				bounds: {
					cx: canvasWidth / 2,
					cy: canvasHeight / 2,
					width: canvasWidth,
					height: canvasHeight,
					rotation: 0,
				},
			},
		];
	}
	return editableState.slots
		.map((slot) => {
			const bounds = getSplitSlotViewportBounds({
				layoutPreset: editableState.layoutPreset,
				viewportBalance: editableState.viewportBalance,
				slotId: slot.slotId,
				canvasWidth,
				canvasHeight,
			});
			return bounds ? { slotId: slot.slotId, bounds } : null;
		})
		.filter(
			(
				region,
			): region is {
				slotId: string;
				bounds: NonNullable<typeof region>["bounds"];
			} => Boolean(region),
		);
}

export function getEditableSplitSlotIdAtCanvasPoint({
	editableState,
	canvasWidth,
	canvasHeight,
	canvasX,
	canvasY,
}: {
	editableState: EditableSplitSlotState;
	canvasWidth: number;
	canvasHeight: number;
	canvasX: number;
	canvasY: number;
}): string | null {
	const region =
		getEditableSplitSlotRegions({
			editableState,
			canvasWidth,
			canvasHeight,
		}).find(
			(candidate) =>
				canvasX >= candidate.bounds.cx - candidate.bounds.width / 2 &&
				canvasX <= candidate.bounds.cx + candidate.bounds.width / 2 &&
				canvasY >= candidate.bounds.cy - candidate.bounds.height / 2 &&
				canvasY <= candidate.bounds.cy + candidate.bounds.height / 2,
		) ?? null;
	return region?.slotId ?? null;
}

export function getSplitSlotIdAtCanvasPoint({
	layoutPreset,
	viewportBalance,
	canvasWidth,
	canvasHeight,
	canvasX,
	canvasY,
}: {
	layoutPreset: VideoSplitScreenLayoutPreset;
	viewportBalance: VideoSplitScreenViewportBalance;
	canvasWidth: number;
	canvasHeight: number;
	canvasX: number;
	canvasY: number;
}): string | null {
	const viewports = getVideoSplitScreenViewports({
		layoutPreset,
		viewportBalance,
		width: canvasWidth,
		height: canvasHeight,
	});
	for (const [slotId, viewport] of viewports.entries()) {
		if (
			canvasX >= viewport.x &&
			canvasX <= viewport.x + viewport.width &&
			canvasY >= viewport.y &&
			canvasY <= viewport.y + viewport.height
		) {
			return slotId;
		}
	}
	return null;
}

export function getSplitSlotViewportBounds({
	layoutPreset,
	viewportBalance,
	slotId,
	canvasWidth,
	canvasHeight,
}: {
	layoutPreset: VideoSplitScreenLayoutPreset;
	viewportBalance: VideoSplitScreenViewportBalance;
	slotId: string;
	canvasWidth: number;
	canvasHeight: number;
}): {
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation: number;
} | null {
	const viewport = getVideoSplitScreenViewports({
		layoutPreset,
		viewportBalance,
		width: canvasWidth,
		height: canvasHeight,
	}).get(slotId);
	if (!viewport) return null;
	return {
		cx: viewport.x + viewport.width / 2,
		cy: viewport.y + viewport.height / 2,
		width: viewport.width,
		height: viewport.height,
		rotation: 0,
	};
}

export function updateSplitSlotBindingsWithTransform({
	bindings,
	slotId,
	nextTransform,
	element,
	localTime,
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	layoutPreset,
	viewportBalance,
}: {
	bindings: VideoSplitScreenSlotBinding[];
	slotId: string;
	nextTransform: Pick<Transform, "position" | "scale">;
	element: VideoElement;
	localTime: number;
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	layoutPreset: VideoSplitScreenLayoutPreset;
	viewportBalance: VideoSplitScreenViewportBalance;
}): VideoSplitScreenSlotBinding[] {
	return bindings.map((binding) => {
		if (binding.slotId !== slotId) return binding;
		const baseResolvedTransform = resolveVideoSplitScreenSlotTransformFromState(
			{
				baseTransform: element.transform,
				duration: element.duration,
				reframePresets: element.reframePresets,
				reframeSwitches: element.reframeSwitches,
				defaultReframePresetId: element.defaultReframePresetId,
				localTime,
				slot: {
					slotId: binding.slotId,
					presetId: binding.presetId ?? null,
				},
			},
		);
		return {
			...binding,
			transformAdjustmentsBySlotId: {
				...(binding.transformAdjustmentsBySlotId ?? {}),
				[`${viewportBalance}:${binding.slotId}`]:
					deriveVideoSplitScreenSlotAdjustmentFromTransform({
						baseTransform: baseResolvedTransform,
						finalTransform: nextTransform,
						slotId: binding.slotId,
						layoutPreset,
						viewportBalance,
						canvasWidth,
						canvasHeight,
						sourceWidth,
						sourceHeight,
					}),
			},
		};
	});
}

export function buildSplitScreenUpdates({
	element,
	slots,
	viewportBalance,
}: {
	element: VideoElement;
	slots: VideoSplitScreenSlotBinding[];
	viewportBalance: VideoSplitScreenViewportBalance;
}): VideoSplitScreen {
	const baseSplitScreen =
		element.splitScreen ??
		({
			enabled: false,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			slots: buildDefaultVideoSplitScreenBindings({
				layoutPreset: "top-bottom",
				presets: element.reframePresets ?? [],
			}),
			sections: [],
		} satisfies VideoSplitScreen);
	return {
		...baseSplitScreen,
		viewportBalance,
		slots,
		sections: (baseSplitScreen.sections ?? []).map((section) =>
			section.enabled === false
				? section
				: {
						...section,
						slots,
					},
		),
	};
}
