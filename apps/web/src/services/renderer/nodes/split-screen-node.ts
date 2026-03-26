import type { CanvasRenderer } from "../canvas-renderer";
import { VideoNode, type VideoNodeParams } from "./video-node";
import type { ImageNode } from "./image-node";
import type { WebGPUVisualDrawData } from "../webgpu-types";
import {
	getEffectiveVideoSplitScreenSlotTransformOverride,
	getVideoSplitScreenDividers,
	isVideoSplitScreenExternalSourceSlot,
	resolveVideoSplitScreenAtTimeFromState,
	resolveVideoSplitScreenSlotTransformFromState,
} from "@/lib/reframe/video-reframe";

type ExternalSlotNode = ImageNode | VideoNode;

export interface SplitScreenNodeParams extends VideoNodeParams {
	externalSlotNodesByElementId: Map<string, ExternalSlotNode>;
}

export class SplitScreenNode extends VideoNode {
	private externalSlotNodesByElementId: Map<string, ExternalSlotNode>;
	private slotCanvasBySlotId = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

	constructor(params: SplitScreenNodeParams) {
		super(params);
		this.externalSlotNodesByElementId = params.externalSlotNodesByElementId;
	}

	private getExternalSlotOverride({
		slot,
	}: {
		slot: Parameters<typeof getEffectiveVideoSplitScreenSlotTransformOverride>[0]["slot"];
	}) {
		return (
			getEffectiveVideoSplitScreenSlotTransformOverride({
				slot,
			}) ?? {
				position: { x: 0, y: 0 },
				scale: 1,
			}
		);
	}

	private getExternalSlotPlacement({
		viewport,
		slot,
	}: {
		viewport: { x: number; y: number; width: number; height: number };
		slot: Parameters<typeof getEffectiveVideoSplitScreenSlotTransformOverride>[0]["slot"];
	}) {
		const override = this.getExternalSlotOverride({ slot });
		const scale = Math.max(0.05, override.scale);
		const width = viewport.width * scale;
		const height = viewport.height * scale;
		return {
			x: viewport.x + (viewport.width - width) / 2 + override.position.x,
			y: viewport.y + (viewport.height - height) / 2 + override.position.y,
			width,
			height,
		};
	}

	private getSlotCanvas({
		slotId,
		width,
		height,
	}: {
		slotId: string;
		width: number;
		height: number;
	}): OffscreenCanvas | HTMLCanvasElement {
		const existing = this.slotCanvasBySlotId.get(slotId);
		if (
			existing &&
			existing.width === Math.max(1, Math.round(width)) &&
			existing.height === Math.max(1, Math.round(height))
		) {
			return existing;
		}
		let nextCanvas: OffscreenCanvas | HTMLCanvasElement;
		try {
			nextCanvas = new OffscreenCanvas(
				Math.max(1, Math.round(width)),
				Math.max(1, Math.round(height)),
			);
		} catch {
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(width));
			canvas.height = Math.max(1, Math.round(height));
			nextCanvas = canvas;
		}
		this.slotCanvasBySlotId.set(slotId, nextCanvas);
		return nextCanvas;
	}

	async render({ renderer, time }: { renderer: CanvasRenderer; time: number }) {
		if (!this.isInRange(time)) {
			return;
		}

		const clipElapsed = this.getClipElapsedTime(time);
		const splitScreen = resolveVideoSplitScreenAtTimeFromState({
			duration: this.params.duration,
			splitScreen: this.params.splitScreen,
			defaultReframePresetId: this.params.defaultReframePresetId,
			reframeSwitches: this.params.reframeSwitches,
			localTime: clipElapsed,
		});
		const hasExternalSlot =
			splitScreen?.slots?.some((slot) =>
				isVideoSplitScreenExternalSourceSlot({ slot }),
			) ?? false;
		if (!splitScreen?.slots?.length || !hasExternalSlot) {
			await super.render({ renderer, time });
			return;
		}

		const cap = this.params.frameRateCap;
		const localTime = this.getLocalTime(time);
		const videoTime =
			typeof cap === "number" && cap > 0
				? Math.floor(localTime * cap) / cap
				: localTime;
		let frame = this.lastFrame;
		if (videoTime !== this.lastRenderedFrameTime || !frame) {
			const resolvedFrame = await this.resolveCanvasFrame({ videoTime });
			if (resolvedFrame) {
				frame = resolvedFrame;
				this.lastRenderedFrameTime = videoTime;
				this.lastFrame = resolvedFrame;
			}
		}
		if (!frame) {
			return;
		}

		const source = frame.canvas;
		const sourceWidth = frame.canvas.width;
		const sourceHeight = frame.canvas.height;
		const resolved = this.getResolvedVisualState({ time });
		const viewports = this.getSplitScreenViewports({
			layoutPreset: splitScreen.layoutPreset,
			viewportBalance: splitScreen.viewportBalance,
			rendererWidth: renderer.width,
			rendererHeight: renderer.height,
		});

		renderer.context.save();
		renderer.context.globalCompositeOperation = (
			this.params.blendMode && this.params.blendMode !== "normal"
				? this.params.blendMode
				: "source-over"
		) as GlobalCompositeOperation;
		renderer.context.globalAlpha = resolved.opacity;

		for (const slot of splitScreen.slots) {
			const viewport = viewports.get(slot.slotId);
			if (!viewport) continue;

			if (isVideoSplitScreenExternalSourceSlot({ slot })) {
				const sourceElementId = slot.sourceElementId?.trim() ?? "";
				const externalNode =
					this.externalSlotNodesByElementId.get(sourceElementId) ?? null;
				if (!externalNode) continue;
				const slotCanvas = this.getSlotCanvas({
					slotId: slot.slotId,
					width: viewport.width,
					height: viewport.height,
				});
				const slotContext = slotCanvas.getContext("2d", {
					alpha: false,
					desynchronized: true,
				});
				if (!slotContext) continue;
				slotContext.setTransform(1, 0, 0, 1, 0, 0);
				slotContext.fillStyle = "black";
				slotContext.fillRect(0, 0, slotCanvas.width, slotCanvas.height);
				const slotRenderer = {
					width: slotCanvas.width,
					height: slotCanvas.height,
					fps: renderer.fps,
					context: slotContext,
					canvas: slotCanvas,
				} as unknown as CanvasRenderer;
				await externalNode.render({
					renderer: slotRenderer,
					time,
				});
				const placement = this.getExternalSlotPlacement({
					viewport,
					slot,
				});
				renderer.context.save();
				renderer.context.beginPath();
				renderer.context.rect(
					viewport.x,
					viewport.y,
					viewport.width,
					viewport.height,
				);
				renderer.context.clip();
				renderer.context.drawImage(
					slotCanvas as CanvasImageSource,
					placement.x,
					placement.y,
					placement.width,
					placement.height,
				);
				renderer.context.restore();
				continue;
			}

			const slotTransform = resolveVideoSplitScreenSlotTransformFromState({
				baseTransform: this.params.transform,
				duration: this.params.duration,
				reframePresets: this.params.reframePresets,
				reframeSwitches: this.params.reframeSwitches,
				defaultReframePresetId: this.params.defaultReframePresetId,
				localTime: clipElapsed,
				slot,
				canvasWidth: renderer.width,
				canvasHeight: renderer.height,
				sourceWidth,
				sourceHeight,
				layoutPreset: splitScreen.layoutPreset,
				viewportBalance: splitScreen.viewportBalance,
			});
			const viewportAdjustedTransform = this.getViewportAdjustedTransform({
				transform: slotTransform,
				viewport,
				rendererWidth: renderer.width,
				rendererHeight: renderer.height,
			});
			const placement = this.getVisualPlacement({
				rendererWidth: viewport.width,
				rendererHeight: viewport.height,
				sourceWidth,
				sourceHeight,
				transform: viewportAdjustedTransform,
				offsetX: viewport.x,
				offsetY: viewport.y,
				fitMode: "cover",
			});
			renderer.context.save();
			renderer.context.beginPath();
			renderer.context.rect(
				viewport.x,
				viewport.y,
				viewport.width,
				viewport.height,
			);
			renderer.context.clip();
			if (slotTransform.rotate !== 0) {
				const centerX = placement.x + placement.width / 2;
				const centerY = placement.y + placement.height / 2;
				renderer.context.translate(centerX, centerY);
				renderer.context.rotate((slotTransform.rotate * Math.PI) / 180);
				renderer.context.translate(-centerX, -centerY);
			}
			renderer.context.drawImage(
				source,
				placement.x,
				placement.y,
				placement.width,
				placement.height,
			);
			renderer.context.restore();
		}

		renderer.context.restore();
		renderer.context.save();
		renderer.context.globalCompositeOperation = "source-over";
		renderer.context.globalAlpha = 1;
		renderer.context.fillStyle = "#000000";
		for (const divider of getVideoSplitScreenDividers({
			layoutPreset: splitScreen.layoutPreset,
			viewportBalance: splitScreen.viewportBalance,
			width: renderer.width,
			height: renderer.height,
		})) {
			renderer.context.fillRect(
				divider.x,
				divider.y,
				divider.width,
				divider.height,
			);
		}
		renderer.context.restore();
	}

	async getWebGPUDrawData({
		time,
		rendererWidth,
		rendererHeight,
	}: {
		time: number;
		rendererWidth: number;
		rendererHeight: number;
	}): Promise<WebGPUVisualDrawData[] | null> {
		if (!this.isInRange(time)) {
			return null;
		}

		const clipElapsed = this.getClipElapsedTime(time);
		const splitScreen = resolveVideoSplitScreenAtTimeFromState({
			duration: this.params.duration,
			splitScreen: this.params.splitScreen,
			defaultReframePresetId: this.params.defaultReframePresetId,
			reframeSwitches: this.params.reframeSwitches,
			localTime: clipElapsed,
		});
		const hasExternalSlot =
			splitScreen?.slots?.some((slot) =>
				isVideoSplitScreenExternalSourceSlot({ slot }),
			) ?? false;
		if (!splitScreen?.slots?.length || !hasExternalSlot) {
			return await super.getWebGPUDrawData({
				time,
				rendererWidth,
				rendererHeight,
			});
		}

		const cap = this.params.frameRateCap;
		const localTime = this.getLocalTime(time);
		const videoTime =
			typeof cap === "number" && cap > 0
				? Math.floor(localTime * cap) / cap
				: localTime;
		const gpuFrame = await this.frameCache.getGPUFrameAt({
			mediaId: this.params.mediaId,
			file: this.params.file,
			time: videoTime,
			proxyScale: this.params.previewProxyScale,
		});
		let source: GPUCopyExternalImageSource | null = gpuFrame?.frame ?? null;
		let sourceWidth = gpuFrame?.width ?? 0;
		let sourceHeight = gpuFrame?.height ?? 0;
		if (!source) {
			let frame = this.lastFrame;
			if (videoTime !== this.lastRenderedFrameTime || !frame) {
				const resolvedFrame = await this.resolveCanvasFrame({ videoTime });
				if (resolvedFrame) {
					frame = resolvedFrame;
					this.lastRenderedFrameTime = videoTime;
					this.lastFrame = resolvedFrame;
				}
			}
			if (!frame) return null;
			source = frame.canvas;
			sourceWidth = frame.canvas.width;
			sourceHeight = frame.canvas.height;
		}

		const resolved = this.getResolvedVisualState({ time });
		const viewports = this.getSplitScreenViewports({
			layoutPreset: splitScreen.layoutPreset,
			viewportBalance: splitScreen.viewportBalance,
			rendererWidth,
			rendererHeight,
		});
		const draws: WebGPUVisualDrawData[] = [];

		for (const slot of splitScreen.slots) {
			const viewport = viewports.get(slot.slotId);
			if (!viewport) continue;

			if (isVideoSplitScreenExternalSourceSlot({ slot })) {
				const sourceElementId = slot.sourceElementId?.trim() ?? "";
				const externalNode =
					this.externalSlotNodesByElementId.get(sourceElementId) ?? null;
				if (!externalNode) continue;
				const externalDraws =
					(await externalNode.getWebGPUDrawData({
						time,
						rendererWidth: viewport.width,
						rendererHeight: viewport.height,
					})) ?? [];
				const override = this.getExternalSlotOverride({
					slot,
				});
				const viewportCenterX = viewport.width / 2;
				const viewportCenterY = viewport.height / 2;
				for (const draw of externalDraws) {
					const nextWidth = draw.width * Math.max(0.05, override.scale);
					const nextHeight = draw.height * Math.max(0.05, override.scale);
					const localCenterX = draw.x + draw.width / 2;
					const localCenterY = draw.y + draw.height / 2;
					const scaledCenterX =
						viewportCenterX +
						(localCenterX - viewportCenterX) *
							Math.max(0.05, override.scale) +
						override.position.x;
					const scaledCenterY =
						viewportCenterY +
						(localCenterY - viewportCenterY) *
							Math.max(0.05, override.scale) +
						override.position.y;
					draws.push({
						...draw,
						x: viewport.x + scaledCenterX - nextWidth / 2,
						y: viewport.y + scaledCenterY - nextHeight / 2,
						width: nextWidth,
						height: nextHeight,
						clipRect: viewport,
						motionBlur: draw.motionBlur
							? {
									...draw.motionBlur,
									deltaX: draw.motionBlur.deltaX * override.scale,
									deltaY: draw.motionBlur.deltaY * override.scale,
							  }
							: undefined,
					});
				}
				continue;
			}

			const slotTransform = resolveVideoSplitScreenSlotTransformFromState({
				baseTransform: this.params.transform,
				duration: this.params.duration,
				reframePresets: this.params.reframePresets,
				reframeSwitches: this.params.reframeSwitches,
				defaultReframePresetId: this.params.defaultReframePresetId,
				localTime: clipElapsed,
				slot,
				canvasWidth: rendererWidth,
				canvasHeight: rendererHeight,
				sourceWidth,
				sourceHeight,
				layoutPreset: splitScreen.layoutPreset,
				viewportBalance: splitScreen.viewportBalance,
			});
			const viewportAdjustedTransform = this.getViewportAdjustedTransform({
				transform: slotTransform,
				viewport,
				rendererWidth,
				rendererHeight,
			});
			const placement = this.getVisualPlacement({
				rendererWidth: viewport.width,
				rendererHeight: viewport.height,
				sourceWidth,
				sourceHeight,
				transform: viewportAdjustedTransform,
				offsetX: viewport.x,
				offsetY: viewport.y,
				fitMode: "cover",
			});
			draws.push({
				source,
				sourceWidth,
				sourceHeight,
				x: placement.x,
				y: placement.y,
				width: placement.width,
				height: placement.height,
				clipRect: viewport,
				rotation: slotTransform.rotate,
				opacity: resolved.opacity,
				blendMode: this.params.blendMode,
				motionBlur:
					this.getMotionBlurForDraw({
						time,
						rendererWidth,
						rendererHeight,
						sourceWidth,
						sourceHeight,
					}) ?? undefined,
			});
		}

		for (const divider of getVideoSplitScreenDividers({
			layoutPreset: splitScreen.layoutPreset,
			viewportBalance: splitScreen.viewportBalance,
			width: rendererWidth,
			height: rendererHeight,
		})) {
			draws.push({
				solidColor: "#000000",
				x: divider.x,
				y: divider.y,
				width: divider.width,
				height: divider.height,
				rotation: 0,
				opacity: 1,
				blendMode: "normal",
			});
		}

		return draws;
	}
}
