import type { CanvasRenderer } from "../canvas-renderer";
import { BaseNode } from "./base-node";
import type { BlendMode } from "@/types/rendering";
import type { Transform } from "@/types/timeline";
import type { ElementAnimations } from "@/types/animation";
import { resolveOpacityAtTime, resolveTransformAtTime } from "@/lib/animation";
import { mapCompressedTimeToSourceTime } from "@/lib/transcript-editor/core";
import type { TranscriptEditCutRange } from "@/types/transcription";

const VISUAL_EPSILON = 1 / 1000;

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	transcriptCuts?: TranscriptEditCutRange[];
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
		const elapsed = Math.max(0, time - this.params.timeOffset);
		const mappedElapsed =
			(this.params.transcriptCuts?.length ?? 0) > 0
				? mapCompressedTimeToSourceTime({
						compressedTime: elapsed,
						cuts: this.params.transcriptCuts ?? [],
					})
				: elapsed;
		return mappedElapsed + this.params.trimStart;
	}

	protected isInRange(time: number): boolean {
		const elapsed = time - this.params.timeOffset;
		return elapsed >= -VISUAL_EPSILON && elapsed < this.params.duration;
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
			transform,
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

	protected getResolvedVisualState({ time }: { time: number }): {
		transform: Transform;
		opacity: number;
	} {
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
		transform = this.params.transform,
	}: {
		rendererWidth: number;
		rendererHeight: number;
		sourceWidth: number;
		sourceHeight: number;
		transform?: Transform;
	}): VisualPlacement {
		const containScale = Math.min(
			rendererWidth / sourceWidth,
			rendererHeight / sourceHeight,
		);
		const scaledWidth = sourceWidth * containScale * transform.scale;
		const scaledHeight = sourceHeight * containScale * transform.scale;
		const x = rendererWidth / 2 + transform.position.x - scaledWidth / 2;
		const y = rendererHeight / 2 + transform.position.y - scaledHeight / 2;

		return {
			x,
			y,
			width: scaledWidth,
			height: scaledHeight,
		};
	}
}
