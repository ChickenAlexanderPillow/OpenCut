import type { CanvasRenderer } from "../canvas-renderer";
import { BaseNode } from "./base-node";
import type { BlendMode } from "@/types/rendering";
import type {
	ElementTransitions,
	Transform,
	VideoReframePreset,
	VideoReframeSwitch,
	VideoSplitScreen,
} from "@/types/timeline";
import type { ElementAnimations } from "@/types/animation";
import {
	resolveOpacityAtTime,
	resolveTransformAtTime,
} from "@/lib/animation";
import {
	buildCompressedCutBoundaryTimes,
	mapCompressedTimeToSourceTime,
} from "@/lib/transcript-editor/core";
import { TRANSCRIPT_CUT_VISUAL_BOUNDARY_GUARD_SECONDS } from "@/lib/transcript-editor/constants";
import type { TranscriptEditCutRange } from "@/types/transcription";
import {
	resolveVideoReframeTransformFromState,
	resolveVideoSplitScreenSlotTransformFromState,
	resolveVideoSplitScreenAtTimeFromState,
} from "@/lib/reframe/video-reframe";

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
	transitions?: ElementTransitions;
	reframePresets?: VideoReframePreset[];
	reframeSwitches?: VideoReframeSwitch[];
	defaultReframePresetId?: string | null;
	splitScreen?: VideoSplitScreen;
}

export interface VisualPlacement {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface SplitViewport {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface ViewportAdjustedTransformParams {
	transform: Transform;
	viewport: SplitViewport;
	rendererWidth: number;
	rendererHeight: number;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
> extends BaseNode<Params> {
	private static readonly MOTION_BLUR_FRAME_WINDOW_SECONDS = 1 / 18;
	private static readonly MOTION_BLUR_SAMPLES = 16;
	private static readonly MOTION_BLUR_TRAIL_OPACITY_FACTOR = 0.52;
	private static readonly MOTION_BLUR_MAX_FILTER_PX = 18;
	private static readonly TRANSCRIPT_BOUNDARY_GUARD_SECONDS =
		TRANSCRIPT_CUT_VISUAL_BOUNDARY_GUARD_SECONDS;

	private static clamp01(value: number): number {
		return Math.max(0, Math.min(1, value));
	}

	private static smoothstep(value: number): number {
		const t = VisualNode.clamp01(value);
		return t * t * (3 - 2 * t);
	}

	protected getClipElapsedTime(time: number): number {
		return Math.max(0, Math.min(this.params.duration, time - this.params.timeOffset));
	}

	private getActiveMotionBlurSide({
		elapsed,
	}: {
		elapsed: number;
	}): "in" | "out" | null {
		const inTransition = this.params.transitions?.in;
		if (
			inTransition &&
			inTransition.presetId.includes("motion-blur") &&
			elapsed <= inTransition.duration
		) {
			return "in";
		}
		const outTransition = this.params.transitions?.out;
		if (
			outTransition &&
			outTransition.presetId.includes("motion-blur") &&
			elapsed >= Math.max(0, this.params.duration - outTransition.duration)
		) {
			return "out";
		}
		return null;
	}

	private crossesTranscriptBoundary({
		startElapsed,
		endElapsed,
	}: {
		startElapsed: number;
		endElapsed: number;
	}): boolean {
		const transcriptCuts = this.params.transcriptCuts ?? [];
		if (transcriptCuts.length === 0) return false;
		const minElapsed = Math.min(startElapsed, endElapsed);
		const maxElapsed = Math.max(startElapsed, endElapsed);
		const guard = VisualNode.TRANSCRIPT_BOUNDARY_GUARD_SECONDS;
		const boundaries = buildCompressedCutBoundaryTimes({
			cuts: transcriptCuts,
		});
		return boundaries.some((boundary) => {
			if (Math.abs(boundary - minElapsed) <= guard) return true;
			if (Math.abs(boundary - maxElapsed) <= guard) return true;
			return boundary > minElapsed && boundary < maxElapsed;
		});
	}

	protected getMotionBlurForDraw({
		time,
		rendererWidth,
		rendererHeight,
		sourceWidth,
		sourceHeight,
	}: {
		time: number;
		rendererWidth: number;
		rendererHeight: number;
		sourceWidth: number;
		sourceHeight: number;
	}): {
		deltaX: number;
		deltaY: number;
		deltaRotation: number;
		deltaScaleRatio: number;
		samples: number;
	} | null {
		const elapsed = this.getClipElapsedTime(time);
		const blurSide = this.getActiveMotionBlurSide({ elapsed });
		if (!blurSide) return null;
		const previousElapsed = this.getClipElapsedTime(
			Math.max(this.params.timeOffset, time - VisualNode.MOTION_BLUR_FRAME_WINDOW_SECONDS),
		);
		if (
			this.crossesTranscriptBoundary({
				startElapsed: previousElapsed,
				endElapsed: elapsed,
			})
		) {
			return null;
		}

		const localNow = this.getLocalTime(time);
		const prevTime = Math.max(
			this.params.timeOffset,
			time - VisualNode.MOTION_BLUR_FRAME_WINDOW_SECONDS,
		);
		const localPrev = this.getLocalTime(prevTime);
		let localA = localPrev;
		let localB = localNow;
		if (Math.abs(localNow - localPrev) <= VISUAL_EPSILON) {
			if (blurSide === "in") {
				// At the very first frame we have no previous sample yet.
				// Use a forward sample so blur is visible from frame 1.
				const nextTime = Math.min(
					this.params.timeOffset + this.params.duration,
					time + VisualNode.MOTION_BLUR_FRAME_WINDOW_SECONDS,
				);
				const localNext = this.getLocalTime(nextTime);
				if (Math.abs(localNext - localNow) <= VISUAL_EPSILON) {
					return null;
				}
				localA = localNow;
				localB = localNext;
			} else {
				return null;
			}
		}

		const transformA = resolveTransformAtTime({
			baseTransform: this.params.transform,
			animations: this.params.animations,
			localTime: localA,
		});
		const transformB = resolveTransformAtTime({
			baseTransform: this.params.transform,
			animations: this.params.animations,
			localTime: localB,
		});
		const placementA = this.getVisualPlacement({
			rendererWidth,
			rendererHeight,
			sourceWidth,
			sourceHeight,
			transform: transformA,
		});
		const placementB = this.getVisualPlacement({
			rendererWidth,
			rendererHeight,
			sourceWidth,
			sourceHeight,
			transform: transformB,
		});
		let strength = 1;
		if (blurSide === "in") {
			const inDuration = Math.max(
				VISUAL_EPSILON,
				this.params.transitions?.in?.duration ?? VISUAL_EPSILON,
			);
			const inProgress = VisualNode.clamp01(elapsed / inDuration);
			// Reverse smoothstep so blur falls off smoothly toward transition end.
			strength = VisualNode.smoothstep(1 - inProgress);
		} else {
			const outDuration = Math.max(
				VISUAL_EPSILON,
				this.params.transitions?.out?.duration ?? VISUAL_EPSILON,
			);
			const outStart = Math.max(0, this.params.duration - outDuration);
			const outProgress = VisualNode.clamp01((elapsed - outStart) / outDuration);
			// Ease blur up smoothly near transition-out instead of abrupt full strength.
			strength = VisualNode.smoothstep(outProgress);
		}
		if (strength <= VISUAL_EPSILON) return null;

		return {
			deltaX: (placementB.x - placementA.x) * strength,
			deltaY: (placementB.y - placementA.y) * strength,
			deltaRotation: (transformB.rotate - transformA.rotate) * strength,
			deltaScaleRatio:
				((transformB.scale - transformA.scale) /
					Math.max(VISUAL_EPSILON, transformB.scale)) *
				strength,
			samples: VisualNode.MOTION_BLUR_SAMPLES,
		};
	}

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
		const clipElapsed = this.getClipElapsedTime(time);
		const splitScreen = resolveVideoSplitScreenAtTimeFromState({
			duration: this.params.duration,
			splitScreen: this.params.splitScreen,
			defaultReframePresetId: this.params.defaultReframePresetId,
			reframeSwitches: this.params.reframeSwitches,
			localTime: clipElapsed,
		});
		const baseTransform = this.getBaseTransformForTime({
			clipElapsed,
		});
		const transform = resolveTransformAtTime({
			baseTransform,
			animations: this.params.animations,
			localTime,
		});
		const opacity = resolveOpacityAtTime({
			baseOpacity: this.params.opacity,
			animations: this.params.animations,
			localTime,
		});
		renderer.context.globalCompositeOperation = (
			this.params.blendMode && this.params.blendMode !== "normal"
				? this.params.blendMode
				: "source-over"
		) as GlobalCompositeOperation;
		renderer.context.globalAlpha = opacity;
		if (splitScreen?.slots?.length) {
			const viewports = this.getSplitScreenViewports({
				layoutPreset: splitScreen.layoutPreset,
				rendererWidth: renderer.width,
				rendererHeight: renderer.height,
			});
			for (const slot of splitScreen.slots) {
				const viewport = viewports.get(slot.slotId);
				if (!viewport) continue;
				const slotTransform = resolveVideoSplitScreenSlotTransformFromState({
					baseTransform: this.params.transform,
					duration: this.params.duration,
					reframePresets: this.params.reframePresets,
					reframeSwitches: this.params.reframeSwitches,
					defaultReframePresetId: this.params.defaultReframePresetId,
					localTime: clipElapsed,
					slot,
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
			return;
		}
		const placement = this.getVisualPlacement({
			rendererWidth: renderer.width,
			rendererHeight: renderer.height,
			sourceWidth,
			sourceHeight,
			transform,
		});
		const motionBlur = this.getMotionBlurForDraw({
			time,
			rendererWidth: renderer.width,
			rendererHeight: renderer.height,
			sourceWidth,
			sourceHeight,
		});
		if (!motionBlur || motionBlur.samples <= 1) {
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
			return;
		}

		const sampleCount = Math.max(2, motionBlur.samples);
		const trailSampleCount = Math.max(1, sampleCount - 1);
		const trailOpacity =
			opacity * VisualNode.MOTION_BLUR_TRAIL_OPACITY_FACTOR;
		const baseCompositeOperation = renderer.context.globalCompositeOperation;
		const baseFilter = renderer.context.filter;
		const trailWeights = Array.from({ length: trailSampleCount }, (_, index) => {
			const progress = (index + 1) / (trailSampleCount + 1);
			return (1 - progress) ** 1.15;
		});
		const totalTrailWeight = Math.max(
			VISUAL_EPSILON,
			trailWeights.reduce((sum, weight) => sum + weight, 0),
		);
		renderer.context.globalCompositeOperation = "lighter";

		// Draw trails first; render the current frame last at full opacity.
		for (let sampleIndex = 0; sampleIndex < trailSampleCount; sampleIndex++) {
			const progress = (sampleIndex + 1) / (trailSampleCount + 1);
			const trailFactor = 1 - progress;
			const scaleRatio = Math.max(
				VISUAL_EPSILON,
				1 - motionBlur.deltaScaleRatio * trailFactor,
			);
			const sampleWidth = placement.width * scaleRatio;
			const sampleHeight = placement.height * scaleRatio;
			const sampleCenterX =
				placement.x + placement.width / 2 - motionBlur.deltaX * trailFactor;
			const sampleCenterY =
				placement.y + placement.height / 2 - motionBlur.deltaY * trailFactor;
			const sampleX = sampleCenterX - sampleWidth / 2;
			const sampleY = sampleCenterY - sampleHeight / 2;
			const sampleRotation =
				transform.rotate - motionBlur.deltaRotation * trailFactor;
			const sampleWeight = trailWeights[sampleIndex] ?? 0;
			const blurStrengthPx = Math.min(
				VisualNode.MOTION_BLUR_MAX_FILTER_PX,
				Math.max(
					0.6,
					Math.abs(motionBlur.deltaScaleRatio) *
						Math.max(placement.width, placement.height) *
						0.035 *
						(0.35 + trailFactor),
				),
			);
			renderer.context.globalAlpha =
				trailOpacity * (sampleWeight / totalTrailWeight);
			renderer.context.filter = `blur(${blurStrengthPx.toFixed(2)}px)`;
			if (sampleRotation !== 0) {
				const centerX = sampleX + placement.width / 2;
				const centerY = sampleY + placement.height / 2;
				renderer.context.save();
				renderer.context.translate(centerX, centerY);
				renderer.context.rotate((sampleRotation * Math.PI) / 180);
				renderer.context.translate(-centerX, -centerY);
				renderer.context.drawImage(
					source,
					sampleX,
					sampleY,
					sampleWidth,
					sampleHeight,
				);
				renderer.context.restore();
				continue;
			}
			renderer.context.drawImage(
				source,
				sampleX,
				sampleY,
				sampleWidth,
				sampleHeight,
			);
		}
		renderer.context.globalCompositeOperation = baseCompositeOperation;
		renderer.context.filter = baseFilter;

		if (transform.rotate !== 0) {
			const centerX = placement.x + placement.width / 2;
			const centerY = placement.y + placement.height / 2;
			renderer.context.save();
			renderer.context.translate(centerX, centerY);
			renderer.context.rotate((transform.rotate * Math.PI) / 180);
			renderer.context.translate(-centerX, -centerY);
			renderer.context.globalAlpha = opacity;
			renderer.context.drawImage(
				source,
				placement.x,
				placement.y,
				placement.width,
				placement.height,
			);
			renderer.context.restore();
		} else {
			renderer.context.globalAlpha = opacity;
			renderer.context.drawImage(
				source,
				placement.x,
				placement.y,
				placement.width,
				placement.height,
			);
		}
		renderer.context.restore();
	}

	protected getResolvedVisualState({ time }: { time: number }): {
		transform: Transform;
		opacity: number;
	} {
		const localTime = this.getLocalTime(time);
		const clipElapsed = this.getClipElapsedTime(time);
		return {
			transform: resolveTransformAtTime({
				baseTransform: this.getBaseTransformForTime({ clipElapsed }),
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

	private getBaseTransformForTime({
		clipElapsed,
	}: {
		clipElapsed: number;
	}): Transform {
		return resolveVideoReframeTransformFromState({
			baseTransform: this.params.transform,
			duration: this.params.duration,
			reframePresets: this.params.reframePresets,
			reframeSwitches: this.params.reframeSwitches,
			defaultReframePresetId: this.params.defaultReframePresetId,
			localTime: clipElapsed,
		});
	}

	protected getVisualPlacement({
		rendererWidth,
		rendererHeight,
		sourceWidth,
		sourceHeight,
		transform = this.params.transform,
		offsetX = 0,
		offsetY = 0,
	}: {
		rendererWidth: number;
		rendererHeight: number;
		sourceWidth: number;
		sourceHeight: number;
		transform?: Transform;
		offsetX?: number;
		offsetY?: number;
	}): VisualPlacement {
		const containScale = Math.min(
			rendererWidth / sourceWidth,
			rendererHeight / sourceHeight,
		);
		const scaledWidth = sourceWidth * containScale * transform.scale;
		const scaledHeight = sourceHeight * containScale * transform.scale;
		const x =
			offsetX + rendererWidth / 2 + transform.position.x - scaledWidth / 2;
		const y =
			offsetY + rendererHeight / 2 + transform.position.y - scaledHeight / 2;

		return {
			x,
			y,
			width: scaledWidth,
			height: scaledHeight,
		};
	}

	protected getViewportAdjustedTransform({
		transform,
		viewport,
		rendererWidth,
		rendererHeight,
	}: ViewportAdjustedTransformParams): Transform {
		const viewportCenterX = viewport.x + viewport.width / 2;
		const viewportCenterY = viewport.y + viewport.height / 2;
		return {
			...transform,
			position: {
				x: transform.position.x + rendererWidth / 2 - viewportCenterX,
				y: transform.position.y + rendererHeight / 2 - viewportCenterY,
			},
		};
	}

	protected getSplitScreenViewports({
		layoutPreset,
		rendererWidth,
		rendererHeight,
	}: {
		layoutPreset: "top-bottom";
		rendererWidth: number;
		rendererHeight: number;
	}): Map<string, SplitViewport> {
		return new Map([
			[
				"top",
				{ x: 0, y: 0, width: rendererWidth, height: rendererHeight / 2 },
			],
			[
				"bottom",
				{
					x: 0,
					y: rendererHeight / 2,
					width: rendererWidth,
					height: rendererHeight / 2,
				},
			],
		]);
	}
}
