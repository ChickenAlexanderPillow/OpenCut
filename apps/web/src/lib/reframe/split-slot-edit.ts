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
}

export function resolveEditableSplitSlotState({
	element,
	localTime,
	splitPreview,
}: {
	element: VideoElement;
	localTime: number;
	splitPreview?: SplitPreviewStateInput | null;
}): EditableSplitSlotState | null {
	const normalizedElement = normalizeVideoReframeState({ element });
	const previewSlots = splitPreview?.slots ?? null;
	const previewViewportBalance =
		splitPreview?.viewportBalance ??
		normalizedElement.splitScreen?.viewportBalance ??
		"balanced";
	const splitScreen: VideoSplitScreen | undefined = previewSlots?.length
		? {
				enabled: false,
				layoutPreset:
					normalizedElement.splitScreen?.layoutPreset ?? "top-bottom",
				viewportBalance: previewViewportBalance,
				slots: previewSlots,
				sections: [
					{
						id: "__preview-selected-split__",
						startTime: 0,
						enabled: true,
						slots: previewSlots,
					},
				],
			}
		: normalizedElement.splitScreen;
	if (!splitScreen) return null;
	const resolved = resolveVideoSplitScreenAtTimeFromState({
		duration: normalizedElement.duration,
		splitScreen,
		defaultReframePresetId: normalizedElement.defaultReframePresetId,
		reframeSwitches: normalizedElement.reframeSwitches,
		localTime,
	});
	if (!resolved) return null;
	return {
		element: normalizedElement,
		layoutPreset: resolved.layoutPreset,
		viewportBalance: resolved.viewportBalance ?? "balanced",
		slots: resolved.slots as VideoSplitScreenSlotBinding[],
	};
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
		const baseResolvedTransform = resolveVideoSplitScreenSlotTransformFromState({
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
		});
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
