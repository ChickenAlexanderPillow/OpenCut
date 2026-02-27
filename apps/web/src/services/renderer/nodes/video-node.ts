import type { CanvasRenderer } from "../canvas-renderer";
import { VisualNode, type VisualNodeParams } from "./visual-node";
import { videoCache } from "@/services/video-cache/service";

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	file: File;
	mediaId: string;
	previewFrameRateCap?: number;
	previewProxyScale?: number;
}

export class VideoNode extends VisualNode<VideoNodeParams> {
	private lastRenderedFrameTime = Number.NaN;
	private lastFrame: Awaited<ReturnType<typeof videoCache.getFrameAt>> = null;

	async render({ renderer, time }: { renderer: CanvasRenderer; time: number }) {
		await super.render({ renderer, time });

		if (!this.isInRange(time)) {
			return;
		}

		const localTime = this.getLocalTime(time);
		const cap = this.params.previewFrameRateCap;
		const videoTime =
			typeof cap === "number" && cap > 0
				? Math.floor(localTime * cap) / cap
				: localTime;

		let frame = this.lastFrame;
		if (videoTime !== this.lastRenderedFrameTime || !frame) {
			frame = await videoCache.getFrameAt({
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
			});
		}
	}
}
