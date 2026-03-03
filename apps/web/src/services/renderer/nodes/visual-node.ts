import type { CanvasRenderer } from "../canvas-renderer";
import { BaseNode } from "./base-node";
import type { BlendMode } from "@/types/rendering";
import type { Transform } from "@/types/timeline";
import type { ElementAnimations } from "@/types/animation";
import { resolveOpacityAtTime, resolveTransformAtTime } from "@/lib/animation";

const VISUAL_EPSILON = 1 / 1000;

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	animations?: ElementAnimations;
}

export interface VisualPlacement {
	x: number;
	y: number;
	width: number;
	height: number;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
> extends BaseNode<Params> {
	protected getLocalTime(time: number): number {
		return time - this.params.timeOffset + this.params.trimStart;
	}

	protected isInRange(time: number): boolean {
		const localTime = this.getLocalTime(time);
		return (
			localTime >= this.params.trimStart - VISUAL_EPSILON &&
			localTime < this.params.trimStart + this.params.duration
		);
	}

	protected renderVisual({
		renderer,
		source,
		sourceWidth,
		sourceHeight,
		time,
	}: {
		renderer: CanvasRenderer;
		source: CanvasImageSource;
		sourceWidth: number;
		sourceHeight: number;
		time: number;
	}): void {
		renderer.context.save();

		const localTime = this.getLocalTime(time);
		const transform = resolveTransformAtTime({
			baseTransform: this.params.transform,
			animations: this.params.animations,
			localTime,
		});
		const opacity = resolveOpacityAtTime({
			baseOpacity: this.params.opacity,
			animations: this.params.animations,
			localTime,
		});
		const placement = this.getVisualPlacement({
			rendererWidth: renderer.width,
			rendererHeight: renderer.height,
			sourceWidth,
			sourceHeight,
		});

		renderer.context.globalCompositeOperation = (
			this.params.blendMode && this.params.blendMode !== "normal"
				? this.params.blendMode
				: "source-over"
		) as GlobalCompositeOperation;
		renderer.context.globalAlpha = opacity;

		if (transform.rotate !== 0) {
			const centerX = placement.x + placement.width / 2;
			const centerY = placement.y + placement.height / 2;
			renderer.context.translate(centerX, centerY);
			renderer.context.rotate((transform.rotate * Math.PI) / 180);
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

	protected getResolvedVisualState({
		time,
	}: {
		time: number;
	}): { transform: Transform; opacity: number } {
		const localTime = this.getLocalTime(time);
		return {
			transform: resolveTransformAtTime({
				baseTransform: this.params.transform,
				animations: this.params.animations,
				localTime,
			}),
			opacity: resolveOpacityAtTime({
				baseOpacity: this.params.opacity,
				animations: this.params.animations,
				localTime,
			}),
		};
	}

	protected getVisualPlacement({
		rendererWidth,
		rendererHeight,
		sourceWidth,
		sourceHeight,
	}: {
		rendererWidth: number;
		rendererHeight: number;
		sourceWidth: number;
		sourceHeight: number;
	}): VisualPlacement {
		const containScale = Math.min(
			rendererWidth / sourceWidth,
			rendererHeight / sourceHeight,
		);
		const scaledWidth =
			sourceWidth * containScale * this.params.transform.scale;
		const scaledHeight =
			sourceHeight * containScale * this.params.transform.scale;
		const x =
			rendererWidth / 2 + this.params.transform.position.x - scaledWidth / 2;
		const y =
			rendererHeight / 2 + this.params.transform.position.y - scaledHeight / 2;

		return {
			x,
			y,
			width: scaledWidth,
			height: scaledHeight,
		};
	}
}
