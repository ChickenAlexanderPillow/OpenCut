import type { CanvasRenderer } from "../canvas-renderer";
import { VisualNode, type VisualNodeParams } from "./visual-node";
import { type VideoCache, videoCache } from "@/services/video-cache/service";
import type { WebGPUVisualDrawData } from "../webgpu-types";
import {
	getVideoSplitScreenDividers,
	resolveVideoSplitScreenAtTimeFromState,
	resolveVideoSplitScreenSlotTransformFromState,
} from "@/lib/reframe/video-reframe";

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	file: File;
	mediaId: string;
	frameRateCap?: number;
	previewProxyScale?: number;
	videoCache?: VideoCache;
}

export class VideoNode extends VisualNode<VideoNodeParams> {
	private static readonly FRAME_LOOKBACK_OFFSETS_SECONDS = [
		0,
		1 / 120,
		1 / 60,
		1 / 30,
		0.1,
	] as const;
	private lastRenderedFrameTime = Number.NaN;
	private lastFrame: Awaited<ReturnType<typeof videoCache.getFrameAt>> = null;
	private frameCache: VideoCache;

	constructor(params: VideoNodeParams) {
		super(params);
		this.frameCache = params.videoCache ?? videoCache;
	}

	private async resolveCanvasFrame({
		videoTime,
	}: {
		videoTime: number;
	}): Promise<Awaited<ReturnType<typeof videoCache.getFrameAt>>> {
		for (const offset of VideoNode.FRAME_LOOKBACK_OFFSETS_SECONDS) {
			const candidateTime = Math.max(0, videoTime - offset);
			const resolvedFrame = await this.frameCache.getFrameAt({
				mediaId: this.params.mediaId,
				file: this.params.file,
				time: candidateTime,
				proxyScale: this.params.previewProxyScale,
			});
			if (resolvedFrame) {
				return resolvedFrame;
			}
		}
		return null;
	}

	async render({ renderer, time }: { renderer: CanvasRenderer; time: number }) {
		await super.render({ renderer, time });

		if (!this.isInRange(time)) {
			return;
		}

		const localTime = this.getLocalTime(time);
		const cap = this.params.frameRateCap;
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

		if (frame) {
			this.renderVisual({
				renderer,
				source: frame.canvas,
				sourceWidth: frame.canvas.width,
				sourceHeight: frame.canvas.height,
				time,
			});
		}
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
		if (!this.isInRange(time)) return null;

		const localTime = this.getLocalTime(time);
		const cap = this.params.frameRateCap;
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
		if (!gpuFrame) {
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

			const sourceWidth = frame.canvas.width;
			const sourceHeight = frame.canvas.height;
			return this.buildWebGPUDrawData({
				time,
				rendererWidth,
				rendererHeight,
				source: frame.canvas,
				sourceWidth,
				sourceHeight,
			});
		}

		const sourceWidth = gpuFrame.width;
		const sourceHeight = gpuFrame.height;
		return this.buildWebGPUDrawData({
			time,
			rendererWidth,
			rendererHeight,
			source: gpuFrame.frame,
			sourceWidth,
			sourceHeight,
		});
	}

	private buildWebGPUDrawData({
		time,
		rendererWidth,
		rendererHeight,
		source,
		sourceWidth,
		sourceHeight,
	}: {
		time: number;
		rendererWidth: number;
		rendererHeight: number;
		source: GPUCopyExternalImageSource;
		sourceWidth: number;
		sourceHeight: number;
	}): WebGPUVisualDrawData[] {
		const clipElapsed = this.getClipElapsedTime(time);
		const resolved = this.getResolvedVisualState({ time });
		const motionBlur =
			this.getMotionBlurForDraw({
				time,
				rendererWidth,
				rendererHeight,
				sourceWidth,
				sourceHeight,
			}) ?? undefined;
		const splitScreen = resolveVideoSplitScreenAtTimeFromState({
			duration: this.params.duration,
			splitScreen: this.params.splitScreen,
			defaultReframePresetId: this.params.defaultReframePresetId,
			reframeSwitches: this.params.reframeSwitches,
			localTime: clipElapsed,
		});
		if (!splitScreen?.slots?.length) {
			const placement = this.getVisualPlacement({
				rendererWidth,
				rendererHeight,
				sourceWidth,
				sourceHeight,
				transform: resolved.transform,
			});
			return [
				{
					source,
					sourceWidth,
					sourceHeight,
					x: placement.x,
					y: placement.y,
					width: placement.width,
					height: placement.height,
					rotation: resolved.transform.rotate,
					opacity: resolved.opacity,
					blendMode: this.params.blendMode,
					motionBlur,
				},
			];
		}

		const viewports = this.getSplitScreenViewports({
			layoutPreset: splitScreen.layoutPreset,
			viewportBalance: splitScreen.viewportBalance,
			rendererWidth,
			rendererHeight,
		});

		const slotDraws = splitScreen.slots.flatMap((slot) => {
			const viewport = viewports.get(slot.slotId);
			if (!viewport) return [];
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
			return [
				{
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
					motionBlur,
				},
			];
		});
		const dividerDraws = getVideoSplitScreenDividers({
			layoutPreset: splitScreen.layoutPreset,
			viewportBalance: splitScreen.viewportBalance,
			width: rendererWidth,
			height: rendererHeight,
		}).map((divider) => ({
			solidColor: "#000000",
			x: divider.x,
			y: divider.y,
			width: divider.width,
			height: divider.height,
			rotation: 0,
			opacity: 1,
			blendMode: "normal" as const,
		}));

		return [...slotDraws, ...dividerDraws];
	}
}
