import type { AnimationPropertyPath } from "@/types/animation";
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
		description: "Motion-blur style zoom (blur pipeline pending).",
		defaultDuration: 0.45,
		category: "zoom",
		motionBlurHint: true,
		channels: {
			"transform.scale": {
				in: { from: 1.18, to: 1 },
				out: { from: 1, to: 1.18 },
			},
			opacity: {
				in: { from: 0.92, to: 1 },
				out: { from: 1, to: 0.92 },
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
}: {
	element: VisualElement;
	preset: TransitionPreset;
	side: TransitionSide;
	duration: number;
}): Array<{
	propertyPath: AnimationPropertyPath;
	time: number;
	value: number;
}> {
	const clampedDuration = Math.max(0.04, Math.min(duration, element.duration));
	const startTime = side === "in" ? 0 : Math.max(0, element.duration - clampedDuration);
	const endTime = side === "in" ? clampedDuration : element.duration;
	const result: Array<{
		propertyPath: AnimationPropertyPath;
		time: number;
		value: number;
	}> = [];

	for (const [path, sideSpec] of Object.entries(preset.channels) as Array<
		[
			NumericTransitionPath,
			{
				in?: { from: number; to: number };
				out?: { from: number; to: number };
			},
		]
	>) {
		const channelSpec = sideSpec[side];
		if (!channelSpec) continue;
		const base = getBaseNumericValueForPath({ element, propertyPath: path });
		result.push({
			propertyPath: path,
			time: startTime,
			value: toAbsoluteValue({
				base,
				normalized: channelSpec.from,
				propertyPath: path,
			}),
		});
		result.push({
			propertyPath: path,
			time: endTime,
			value: toAbsoluteValue({
				base,
				normalized: channelSpec.to,
				propertyPath: path,
			}),
		});
	}

	return result;
}
