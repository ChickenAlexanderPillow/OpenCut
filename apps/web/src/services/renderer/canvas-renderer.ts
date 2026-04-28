import type { BaseNode } from "./nodes/base-node";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: number;
	alpha?: boolean;
};

export class CanvasRenderer {
	canvas: OffscreenCanvas | HTMLCanvasElement;
	context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
	width: number;
	height: number;
	fps: number;
	alpha: boolean;

	constructor({ width, height, fps, alpha = false }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;
		this.alpha = alpha;

		try {
			this.canvas = new OffscreenCanvas(width, height);
		} catch {
			this.canvas = document.createElement("canvas");
			this.canvas.width = width;
			this.canvas.height = height;
		}

		const context = this.canvas.getContext("2d", {
			alpha: this.alpha,
			desynchronized: true,
		});
		if (!context) {
			throw new Error("Failed to get canvas context");
		}

		this.context = context as
			| OffscreenCanvasRenderingContext2D
			| CanvasRenderingContext2D;
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;

		if (this.canvas instanceof OffscreenCanvas) {
			this.canvas = new OffscreenCanvas(width, height);
		} else {
			this.canvas.width = width;
			this.canvas.height = height;
		}

		const context = this.canvas.getContext("2d", {
			alpha: this.alpha,
			desynchronized: true,
		});
		if (!context) {
			throw new Error("Failed to get canvas context");
		}
		this.context = context as
			| OffscreenCanvasRenderingContext2D
			| CanvasRenderingContext2D;
	}

	private clear() {
		this.context.setTransform(1, 0, 0, 1, 0, 0);
		if (this.alpha) {
			this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
			return;
		}
		this.context.fillStyle = "black";
		this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
	}

	async render({ node, time }: { node: BaseNode; time: number }) {
		this.clear();
		await node.render({ renderer: this, time });
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: BaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		await this.render({ node, time });

		const ctx = targetCanvas.getContext("2d", {
			alpha: false,
			desynchronized: true,
		});
		if (!ctx) {
			throw new Error("Failed to get target canvas context");
		}

		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(this.canvas, 0, 0, targetCanvas.width, targetCanvas.height);
	}
}
