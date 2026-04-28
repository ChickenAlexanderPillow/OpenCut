import {
	getVideoSplitScreenViewports,
} from "@/lib/reframe/video-reframe";
import { getVideoCoverScaleMultiplier } from "@/lib/timeline/video-cover-fit";
import type {
	TimelineTrack,
	VideoReframeTransformAdjustment,
	VideoSplitScreenSlotBinding,
	VideoSplitScreenViewportBalance,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { isGeneratedCaptionElement } from "@/lib/captions/caption-track";

export const PORTRAIT_PREVIEW_SIZE = { width: 1080, height: 1920 } as const;

export type PreviewFormatVariant = "project" | "square" | "portrait";

function remapTransformByScaleDivisor({
	position,
	scale,
	scaleDivisor,
}: {
	position: { x: number; y: number };
	scale: number;
	scaleDivisor: number;
}): { position: { x: number; y: number }; scale: number } {
	if (!Number.isFinite(scaleDivisor) || scaleDivisor <= 1.0001) {
		return {
			position,
			scale,
		};
	}
	return {
		position: {
			x: position.x / scaleDivisor,
			y: position.y / scaleDivisor,
		},
		scale: scale / scaleDivisor,
	};
}

function remapSlotTransformOverrideByScaleDivisor({
	override,
	scaleDivisor,
}: {
	override: VideoSplitScreenSlotBinding["transformOverride"];
	scaleDivisor: number;
}): VideoSplitScreenSlotBinding["transformOverride"] {
	if (!override) return override;
	return remapTransformByScaleDivisor({
		position: override.position,
		scale: override.scale,
		scaleDivisor,
	});
}

function remapSlotTransformOverridesByScaleDivisor({
	overrides,
	scaleDivisor,
}: {
	overrides: VideoSplitScreenSlotBinding["transformOverridesBySlotId"];
	scaleDivisor: number;
}): VideoSplitScreenSlotBinding["transformOverridesBySlotId"] {
	if (!overrides) return overrides;
	return Object.fromEntries(
		Object.entries(overrides).map(([key, override]) => [
			key,
			remapSlotTransformOverrideByScaleDivisor({
				override,
				scaleDivisor,
			}),
		]),
	);
}

export function resolveSquarePreviewStrategy({
	tracks,
	mediaAssets,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
}): {
	backgroundMode: "project" | "blur" | "black";
	remapVideoAdjustments: boolean;
} {
	const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	let hasLandscapeVideoSource = false;
	let hasSquareVideoSource = false;

	for (const track of tracks) {
		if (track.type !== "video") continue;
		for (const element of track.elements) {
			if (element.type !== "video") continue;
			const asset = mediaById.get(element.mediaId);
			if (!asset) continue;
			const width = Math.max(0, asset.width ?? 0);
			const height = Math.max(0, asset.height ?? 0);
			if (width <= 0 || height <= 0) continue;
			if (width > height) {
				hasLandscapeVideoSource = true;
				continue;
			}
			if (width === height) {
				hasSquareVideoSource = true;
			}
		}
	}

	if (hasLandscapeVideoSource) {
		return {
			backgroundMode: "black",
			remapVideoAdjustments: true,
		};
	}
	if (hasSquareVideoSource) {
		return {
			backgroundMode: "project",
			remapVideoAdjustments: false,
		};
	}
	return {
		backgroundMode: "blur",
		remapVideoAdjustments: false,
	};
}

export function getPreviewCanvasSize({
	projectWidth,
	projectHeight,
	previewFormatVariant,
}: {
	projectWidth: number;
	projectHeight: number;
	previewFormatVariant: PreviewFormatVariant;
}): { width: number; height: number } {
	if (previewFormatVariant === "square") {
		const side = Math.max(1, Math.min(projectWidth, projectHeight));
		return { width: side, height: side };
	}
	if (previewFormatVariant === "portrait") {
		return { ...PORTRAIT_PREVIEW_SIZE };
	}
	return { width: projectWidth, height: projectHeight };
}

export function remapCaptionTransformsForPreviewVariant({
	tracks,
	sourceCanvas,
	previewCanvas,
}: {
	tracks: TimelineTrack[];
	sourceCanvas: { width: number; height: number };
	previewCanvas: { width: number; height: number };
}): TimelineTrack[] {
	const scaleX = previewCanvas.width / Math.max(1, sourceCanvas.width);
	const scaleY = previewCanvas.height / Math.max(1, sourceCanvas.height);
	if (Math.abs(scaleX - 1) < 0.0001 && Math.abs(scaleY - 1) < 0.0001) {
		return tracks;
	}

	return tracks.map((track) => {
		if (track.type !== "text") return track;
		return {
			...track,
			elements: track.elements.map((element) => {
				if (isGeneratedCaptionElement(element)) {
					return element;
				}
				return {
					...element,
					transform: {
						...element.transform,
						position: {
							x: element.transform.position.x * scaleX,
							y: element.transform.position.y * scaleY,
						},
					},
				};
			}),
		};
	});
}

export function remapSquareSourceVideoTransformsForSquarePreview({
	tracks,
	mediaAssets,
	sourceCanvas,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	sourceCanvas: { width: number; height: number };
}): TimelineTrack[] {
	const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));

	return tracks.map((track) => {
		if (track.type !== "video") return track;
		return {
			...track,
			elements: track.elements.map((element) => {
				if (element.type !== "video") return element;
				const asset = mediaById.get(element.mediaId);
				if (asset?.type !== "video") return element;
				if ((asset.width ?? 0) <= 0 || (asset.height ?? 0) <= 0) return element;
				if (asset.width !== asset.height) return element;

				const coverScaleDivisor = getVideoCoverScaleMultiplier({
					canvasSize: sourceCanvas,
					sourceWidth: asset.width,
					sourceHeight: asset.height,
				});
				if (coverScaleDivisor <= 1.0001) return element;

				const remappedTransform = remapTransformByScaleDivisor({
					position: element.transform.position,
					scale: element.transform.scale,
					scaleDivisor: coverScaleDivisor,
				});

				return {
					...element,
					transform: {
						...element.transform,
						position: remappedTransform.position,
						scale: remappedTransform.scale,
					},
					reframePresets: element.reframePresets?.map((preset) => {
						const remappedPresetTransform = remapTransformByScaleDivisor({
							position: preset.transform.position,
							scale: preset.transform.scale,
							scaleDivisor: coverScaleDivisor,
						});
						return {
							...preset,
							transform: remappedPresetTransform,
						};
					}),
					splitScreen: element.splitScreen
						? {
								...element.splitScreen,
								slots: element.splitScreen.slots.map((slot) => ({
									...slot,
									transformOverride: remapSlotTransformOverrideByScaleDivisor({
										override: slot.transformOverride,
										scaleDivisor: coverScaleDivisor,
									}),
									transformOverridesBySlotId:
										remapSlotTransformOverridesByScaleDivisor({
											overrides: slot.transformOverridesBySlotId,
											scaleDivisor: coverScaleDivisor,
										}),
								})),
								sections: element.splitScreen.sections?.map((section) => ({
									...section,
									slots: section.slots.map((slot) => ({
										...slot,
										transformOverride: remapSlotTransformOverrideByScaleDivisor({
											override: slot.transformOverride,
											scaleDivisor: coverScaleDivisor,
										}),
										transformOverridesBySlotId:
											remapSlotTransformOverridesByScaleDivisor({
												overrides: slot.transformOverridesBySlotId,
												scaleDivisor: coverScaleDivisor,
											}),
									})),
								})),
							}
						: element.splitScreen,
				};
			}),
		};
	});
}

function scaleAdjustmentPosition({
	adjustment,
	scaleX,
	scaleY,
}: {
	adjustment: VideoReframeTransformAdjustment | null | undefined;
	scaleX: number;
	scaleY: number;
}): VideoReframeTransformAdjustment | undefined {
	if (!adjustment) return undefined;
	return {
		...adjustment,
		positionOffset: {
			x: adjustment.positionOffset.x * scaleX,
			y: adjustment.positionOffset.y * scaleY,
		},
	};
}

function scaleTransformOverride({
	override,
	scaleX,
	scaleY,
}: {
	override: VideoSplitScreenSlotBinding["transformOverride"];
	scaleX: number;
	scaleY: number;
}): VideoSplitScreenSlotBinding["transformOverride"] {
	if (!override) return null;
	return {
		...override,
		position: {
			x: override.position.x * scaleX,
			y: override.position.y * scaleY,
		},
	};
}

function resolveViewportScaleForSlotAdjustment({
	key,
	splitViewportBalance,
	projectCanvas,
	previewCanvas,
}: {
	key: string;
	splitViewportBalance?: VideoSplitScreenViewportBalance;
	projectCanvas: { width: number; height: number };
	previewCanvas: { width: number; height: number };
}): { scaleX: number; scaleY: number } {
	const [variantOrSlotId, maybeSlotId] = key.split(":");
	const viewportBalance =
		maybeSlotId === "top" || maybeSlotId === "bottom"
			? ((variantOrSlotId as VideoSplitScreenViewportBalance) ?? "balanced")
			: (splitViewportBalance ?? "balanced");
	const slotId = maybeSlotId ?? variantOrSlotId;
	const projectViewport = getVideoSplitScreenViewports({
		layoutPreset: "top-bottom",
		viewportBalance,
		width: projectCanvas.width,
		height: projectCanvas.height,
	}).get(slotId);
	const previewViewport = getVideoSplitScreenViewports({
		layoutPreset: "top-bottom",
		viewportBalance,
		width: previewCanvas.width,
		height: previewCanvas.height,
	}).get(slotId);
	if (!projectViewport || !previewViewport) {
		return { scaleX: 1, scaleY: 1 };
	}
	return {
		scaleX: previewViewport.width / Math.max(1, projectViewport.width),
		scaleY: previewViewport.height / Math.max(1, projectViewport.height),
	};
}

function remapSplitSlotBindingAdjustments({
	binding,
	splitViewportBalance,
	projectCanvas,
	previewCanvas,
}: {
	binding: VideoSplitScreenSlotBinding;
	splitViewportBalance?: VideoSplitScreenViewportBalance;
	projectCanvas: { width: number; height: number };
	previewCanvas: { width: number; height: number };
}): VideoSplitScreenSlotBinding {
	const { scaleX: slotScaleX, scaleY: slotScaleY } =
		resolveViewportScaleForSlotAdjustment({
			key: binding.slotId,
			splitViewportBalance,
			projectCanvas,
			previewCanvas,
		});
	const remappedAdjustments = binding.transformAdjustmentsBySlotId
		? Object.fromEntries(
				Object.entries(binding.transformAdjustmentsBySlotId).map(
					([key, adjustment]) => {
						if (!adjustment?.positionOffset) {
							return [key, adjustment];
						}
						const { scaleX, scaleY } = resolveViewportScaleForSlotAdjustment({
							key,
							splitViewportBalance,
							projectCanvas,
							previewCanvas,
						});
						return [
							key,
							{
								...adjustment,
								positionOffset: {
									x: adjustment.positionOffset.x * scaleX,
									y: adjustment.positionOffset.y * scaleY,
								},
							},
						];
					},
				),
			)
		: undefined;
	const remappedOverrides = binding.transformOverridesBySlotId
		? Object.fromEntries(
				Object.entries(binding.transformOverridesBySlotId).map(
					([key, override]) => {
						if (!override) {
							return [key, override];
						}
						const { scaleX, scaleY } = resolveViewportScaleForSlotAdjustment({
							key,
							splitViewportBalance,
							projectCanvas,
							previewCanvas,
						});
						return [
							key,
							scaleTransformOverride({
								override,
								scaleX,
								scaleY,
							}),
						];
					},
				),
			)
		: undefined;
	if (
		!remappedAdjustments &&
		!remappedOverrides &&
		!binding.transformOverride
	) {
		return binding;
	}
	return {
		...binding,
		transformOverride: scaleTransformOverride({
			override: binding.transformOverride,
			scaleX: slotScaleX,
			scaleY: slotScaleY,
		}),
		transformAdjustmentsBySlotId: remappedAdjustments,
		transformOverridesBySlotId: remappedOverrides,
	};
}

export function remapVideoAdjustmentsForPreviewVariant({
	tracks,
	sourceCanvas,
	previewCanvas,
}: {
	tracks: TimelineTrack[];
	sourceCanvas: { width: number; height: number };
	previewCanvas: { width: number; height: number };
}): TimelineTrack[] {
	const scaleX = previewCanvas.width / Math.max(1, sourceCanvas.width);
	const scaleY = previewCanvas.height / Math.max(1, sourceCanvas.height);
	if (Math.abs(scaleX - 1) < 0.0001 && Math.abs(scaleY - 1) < 0.0001) {
		return tracks;
	}

	return tracks.map((track) => {
		if (track.type !== "video") return track;
		return {
			...track,
			elements: track.elements.map((element) => {
				if (element.type !== "video") return element;
				return {
					...element,
					reframePresets: element.reframePresets?.map((preset) => ({
						...preset,
						transformAdjustment: scaleAdjustmentPosition({
							adjustment: preset.transformAdjustment,
							scaleX,
							scaleY,
						}),
						manualTransformAdjustment: scaleAdjustmentPosition({
							adjustment: preset.manualTransformAdjustment,
							scaleX,
							scaleY,
						}),
					})),
					splitScreen: element.splitScreen
						? {
								...element.splitScreen,
								slots: element.splitScreen.slots.map((slot) =>
									remapSplitSlotBindingAdjustments({
										binding: slot,
										splitViewportBalance: element.splitScreen?.viewportBalance,
										projectCanvas: sourceCanvas,
										previewCanvas,
									}),
								),
								sections: element.splitScreen.sections?.map((section) => ({
									...section,
									slots: section.slots.map((slot) =>
										remapSplitSlotBindingAdjustments({
											binding: slot,
											splitViewportBalance:
												element.splitScreen?.viewportBalance,
											projectCanvas: sourceCanvas,
											previewCanvas,
										}),
									),
								})),
							}
						: element.splitScreen,
				};
			}),
		};
	});
}
