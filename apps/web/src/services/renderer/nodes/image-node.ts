import type { CanvasRenderer } from "../canvas-renderer";
import { VisualNode, type VisualNodeParams } from "./visual-node";
import type { WebGPUVisualDrawData } from "../webgpu-types";

export interface ImageNodeParams extends VisualNodeParams {
	url: string;
	maxSourceSize?: number;
}

interface CachedImageSource {
	source: HTMLImageElement | OffscreenCanvas;
	width: number;
	height: number;
}

const imageSourceCache = new Map<string, Promise<CachedImageSource>>();

export function clearImageSourceCache(): void {
	imageSourceCache.clear();
}

function loadImageSource(
	url: string,
	maxSourceSize?: number,
): Promise<CachedImageSource> {
	const cacheKey = `${url}::${maxSourceSize ?? "full"}`;

	const cached = imageSourceCache.get(cacheKey);
	if (cached) return cached;

	const promise = (async (): Promise<CachedImageSource> => {
		const image = new Image();

		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error("Image load failed"));
			image.src = url;
		});

		const naturalWidth = image.naturalWidth;
		const naturalHeight = image.naturalHeight;
		const exceedsLimit =
			maxSourceSize &&
			(naturalWidth > maxSourceSize || naturalHeight > maxSourceSize);

		if (exceedsLimit) {
			const scale = Math.min(
				maxSourceSize / naturalWidth,
				maxSourceSize / naturalHeight,
			);
			const scaledWidth = Math.round(naturalWidth * scale);
			const scaledHeight = Math.round(naturalHeight * scale);

			const offscreen = new OffscreenCanvas(scaledWidth, scaledHeight);
			const ctx = offscreen.getContext("2d");

			if (ctx) {
				ctx.drawImage(image, 0, 0, scaledWidth, scaledHeight);
				return { source: offscreen, width: scaledWidth, height: scaledHeight };
			}
		}

		return { source: image, width: naturalWidth, height: naturalHeight };
	})();

	imageSourceCache.set(cacheKey, promise);
	return promise;
}

export class ImageNode extends VisualNode<ImageNodeParams> {
	private cachedSource: Promise<CachedImageSource>;

	constructor(params: ImageNodeParams) {
		super(params);
		this.cachedSource = loadImageSource(params.url, params.maxSourceSize);
	}

	async render({ renderer, time }: { renderer: CanvasRenderer; time: number }) {
		await super.render({ renderer, time });

		if (!this.isInRange(time)) {
			return;
		}

		const { source, width, height } = await this.cachedSource;

		this.renderVisual({
			renderer,
			source,
			sourceWidth: width || renderer.width,
			sourceHeight: height || renderer.height,
			time,
		});
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

		const { source, width, height } = await this.cachedSource;
		const sourceWidth = width || rendererWidth;
		const sourceHeight = height || rendererHeight;
		const resolved = this.getResolvedVisualState({ time });
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
				motionBlur: this.getMotionBlurForDraw({
					time,
					rendererWidth,
					rendererHeight,
					sourceWidth,
					sourceHeight,
				}) ?? undefined,
			},
		];
	}
}
