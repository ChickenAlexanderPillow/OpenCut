import type { CanvasRenderer } from "../canvas-renderer";
import { VisualNode, type VisualNodeParams } from "./visual-node";
import { type VideoCache, videoCache } from "@/services/video-cache/service";
import type { WebGPUVisualDrawData } from "../webgpu-types";
import {
	resolveVideoReframeTransform,
	resolveVideoSplitScreenAtTime,
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
	private lastRenderedFrameTime = Number.NaN;
	private lastFrame: Awaited<ReturnType<typeof videoCache.getFrameAt>> = null;
	private frameCache: VideoCache;

	constructor(params: VideoNodeParams) {
		super(params);
		this.frameCache = params.videoCache ?? videoCache;
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
			frame = await this.frameCache.getFrameAt({
				mediaId: this.params.mediaId,
				file: this.params.file,
				time: videoTime,
				proxyScale: this.params.previewProxyScale,
			});
			this.lastRenderedFrameTime = videoTime;
			this.lastFrame = frame;
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
				frame = await this.frameCache.getFrameAt({
					mediaId: this.params.mediaId,
					file: this.params.file,
					time: videoTime,
					proxyScale: this.params.previewProxyScale,
				});
				this.lastRenderedFrameTime = videoTime;
				this.lastFrame = frame;
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
		const splitScreen = resolveVideoSplitScreenAtTime({
			element: {
				id: "__split__",
				type: "video",
				mediaId: "__split__",
				name: "__split__",
				startTime: 0,
				duration: this.params.duration,
				trimStart: 0,
				trimEnd: 0,
				transform: this.params.transform,
				opacity: this.params.opacity,
				reframePresets: this.params.reframePresets,
				reframeSwitches: this.params.reframeSwitches,
				defaultReframePresetId: this.params.defaultReframePresetId,
				splitScreen: this.params.splitScreen,
			},
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
			rendererWidth,
			rendererHeight,
		});

		return splitScreen.slots.flatMap((slot) => {
			const viewport = viewports.get(slot.slotId);
			if (!viewport) return [];
			const slotTransform = resolveVideoReframeTransform({
				baseTransform: this.params.transform,
				duration: this.params.duration,
				reframePresets: this.params.reframePresets,
				reframeSwitches:
					!slot.presetId
						? this.params.reframeSwitches
						: [
								{
									id: "__split-slot__",
									time: 0,
									presetId: slot.presetId,
								},
						  ],
				defaultReframePresetId: slot.presetId ?? this.params.defaultReframePresetId,
				localTime: clipElapsed,
			});
			const placement = this.getVisualPlacement({
				rendererWidth: viewport.width,
				rendererHeight: viewport.height,
				sourceWidth,
				sourceHeight,
				transform: slotTransform,
				offsetX: viewport.x,
				offsetY: viewport.y,
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
	}
}
