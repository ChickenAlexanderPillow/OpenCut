import type { CanvasRenderer } from "../canvas-renderer";
import { VisualNode, type VisualNodeParams } from "./visual-node";
import { type VideoCache, videoCache } from "@/services/video-cache/service";
import type { WebGPUVisualDrawData } from "../webgpu-types";

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
	}): Promise<WebGPUVisualDrawData | null> {
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
		const placement = this.getVisualPlacement({
			rendererWidth,
			rendererHeight,
			sourceWidth,
			sourceHeight,
		});
		const resolved = this.getResolvedVisualState({ time });

		return {
			source: frame.canvas,
			sourceWidth,
			sourceHeight,
			x: placement.x,
			y: placement.y,
			width: placement.width,
			height: placement.height,
			rotation: resolved.transform.rotate,
			opacity: resolved.opacity,
			blendMode: this.params.blendMode,
		};
		}

		const sourceWidth = gpuFrame.width;
		const sourceHeight = gpuFrame.height;
		const placement = this.getVisualPlacement({
			rendererWidth,
			rendererHeight,
			sourceWidth,
			sourceHeight,
		});
		const resolved = this.getResolvedVisualState({ time });

		return {
			source: gpuFrame.frame,
			sourceWidth,
			sourceHeight,
			x: placement.x,
			y: placement.y,
			width: placement.width,
			height: placement.height,
			rotation: resolved.transform.rotate,
			opacity: resolved.opacity,
			blendMode: this.params.blendMode,
		};
	}
}
