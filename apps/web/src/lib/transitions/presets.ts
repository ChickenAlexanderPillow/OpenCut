import type { AnimationInterpolation, AnimationPropertyPath } from "@/types/animation";
import type { VisualElement } from "@/types/timeline";

export type TransitionSide = "in" | "out";

type NumericTransitionPath =
	| "opacity"
	| "transform.scale"
	| "transform.position.x"
	| "transform.position.y";

type TransitionChannelSpec = Partial<
	Record<
		NumericTransitionPath,
		{
			in?: { from: number; to: number };
			out?: { from: number; to: number };
		}
	>
>;

export interface TransitionPreset {
	id: string;
	name: string;
	description: string;
	defaultDuration: number;
	category: "fade" | "scale" | "zoom" | "combo";
	motionBlurHint?: boolean;
	channels: TransitionChannelSpec;
}

export const TRANSITION_PRESETS: TransitionPreset[] = [
	{
		id: "fade",
		name: "Fade",
		description: "Smooth opacity fade in or out.",
		defaultDuration: 0.35,
		category: "fade",
		channels: {
			opacity: {
				in: { from: 0, to: 1 },
				out: { from: 1, to: 0 },
			},
		},
	},
	{
		id: "scale",
		name: "Scale",
		description: "Gentle scale pop at clip edges.",
		defaultDuration: 0.4,
		category: "scale",
		channels: {
			"transform.scale": {
				in: { from: 1.08, to: 1 },
				out: { from: 1, to: 0.92 },
			},
		},
	},
	{
		id: "zoom",
		name: "Zoom",
		description: "Push-in or pull-out transition.",
		defaultDuration: 0.45,
		category: "zoom",
		channels: {
			"transform.scale": {
				in: { from: 1.2, to: 1 },
				out: { from: 1, to: 1.2 },
			},
			opacity: {
				in: { from: 0.9, to: 1 },
				out: { from: 1, to: 0.9 },
			},
		},
	},
	{
		id: "fade-zoom",
		name: "Fade + Zoom",
		description: "Opacity and zoom combined.",
		defaultDuration: 0.45,
		category: "combo",
		channels: {
			opacity: {
				in: { from: 0, to: 1 },
				out: { from: 1, to: 0 },
			},
			"transform.scale": {
				in: { from: 1.15, to: 1 },
				out: { from: 1, to: 1.15 },
			},
		},
	},
	{
		id: "motion-blur-zoom",
		name: "Motion Blur Zoom",
		description: "Fast zoom with motion blur trail.",
		defaultDuration: 0.2,
		category: "zoom",
		motionBlurHint: true,
		channels: {
			"transform.scale": {
				in: { from: 1.5, to: 1 },
				out: { from: 1, to: 1.5 },
			},
		},
	},
];

export function getTransitionPreset({
	presetId,
}: {
	presetId: string;
}): TransitionPreset | null {
	return TRANSITION_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

function getBaseNumericValueForPath({
	element,
	propertyPath,
}: {
	element: VisualElement;
	propertyPath: NumericTransitionPath;
}): number {
	if (propertyPath === "opacity") return element.opacity;
	if (propertyPath === "transform.scale") return element.transform.scale;
	if (propertyPath === "transform.position.x") return element.transform.position.x;
	return element.transform.position.y;
}

function toAbsoluteValue({
	base,
	normalized,
	propertyPath,
}: {
	base: number;
	normalized: number;
	propertyPath: NumericTransitionPath;
}): number {
	if (propertyPath === "opacity") {
		return Math.max(0, Math.min(1, normalized));
	}
	return base * normalized;
}

export function buildTransitionKeyframeSpecs({
	element,
	preset,
	side,
	duration,
	getBaseValueForPath,
}: {
	element: VisualElement;
	preset: TransitionPreset;
	side: TransitionSide;
	duration: number;
	getBaseValueForPath?: (params: {
		propertyPath: NumericTransitionPath;
		time: number;
	}) => number | null;
}): Array<{
	propertyPath: AnimationPropertyPath;
	time: number;
	value: number;
	interpolation: AnimationInterpolation;
}> {
	const clampedDuration = Math.max(0.04, Math.min(duration, element.duration));
	const startTime = side === "in" ? 0 : Math.max(0, element.duration - clampedDuration);
	const endTime = side === "in" ? clampedDuration : element.duration;
	const result: Array<{
		propertyPath: AnimationPropertyPath;
		time: number;
		value: number;
		interpolation: AnimationInterpolation;
	}> = [];
	const anchorTime = side === "in" ? endTime : startTime;

	for (const [path, sideSpec] of Object.entries(preset.channels) as Array<
		[
			NumericTransitionPath,
			{
				in?: { from: number; to: number };
				out?: { from: number; to: number };
			},
		]
	>) {
		// Motion blur zoom should be transform-only; never generate opacity keyframes.
		if (preset.id === "motion-blur-zoom" && path === "opacity") {
			continue;
		}
		const channelSpec = sideSpec[side];
		if (!channelSpec) continue;
		const resolvedBase =
			getBaseValueForPath?.({ propertyPath: path, time: anchorTime }) ?? null;
		const base =
			typeof resolvedBase === "number"
				? resolvedBase
				: getBaseNumericValueForPath({ element, propertyPath: path });
		if (preset.id === "motion-blur-zoom" && path === "transform.scale") {
			if (side === "in") {
				const midTime = startTime + clampedDuration * 0.72;
				result.push({
					propertyPath: path,
					time: startTime,
					value: base * 1.5,
					interpolation: "ease-out",
				});
				result.push({
					propertyPath: path,
					time: midTime,
					value: base * 0.94,
					interpolation: "ease-in-out",
				});
				result.push({
					propertyPath: path,
					time: endTime,
					value: base,
					interpolation: "ease-in-out",
				});
				continue;
			}
			const slingshotPullTime = startTime + clampedDuration * 0.2;
			result.push({
				propertyPath: path,
				time: startTime,
				value: base,
				interpolation: "ease-in-out",
			});
			result.push({
				propertyPath: path,
				time: slingshotPullTime,
				value: base * 0.93,
				interpolation: "ease-in",
			});
			result.push({
				propertyPath: path,
				time: endTime,
				value: base * 1.5,
				interpolation: "ease-in",
			});
			continue;
		}
		const interpolation: AnimationInterpolation =
			preset.motionBlurHint && path === "transform.scale"
				? "ease-in-out"
				: side === "in"
					? "ease-out"
					: "ease-in";
		result.push({
			propertyPath: path,
			time: startTime,
			value: toAbsoluteValue({
				base,
				normalized: channelSpec.from,
				propertyPath: path,
			}),
			interpolation,
		});
		result.push({
			propertyPath: path,
			time: endTime,
			value: toAbsoluteValue({
				base,
				normalized: channelSpec.to,
				propertyPath: path,
			}),
			interpolation,
		});
	}

	return result;
}
