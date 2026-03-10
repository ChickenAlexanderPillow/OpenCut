import { BatchCommand, type Command } from "@/lib/commands";
import {
	RemoveKeyframeCommand,
	UpdateElementCommand,
	UpsertKeyframeCommand,
} from "@/lib/commands/timeline/element";
import {
	buildTransitionKeyframeSpecs,
	getTransitionPreset,
	type TransitionSide,
} from "@/lib/transitions/presets";
import {
	getElementBaseValueForProperty,
	resolveNumberAtTime,
} from "@/lib/animation";
import type {
	AnimationInterpolation,
	AnimationPropertyPath,
} from "@/types/animation";
import type { VisualElement } from "@/types/timeline";

type TransitionTarget = {
	trackId: string;
	element: VisualElement;
};

function asSingleCommand(commands: Command[]): Command | null {
	if (commands.length === 0) return null;
	return commands.length === 1 ? commands[0] : new BatchCommand(commands);
}

export function buildApplyTransitionCommand({
	targets,
	side,
	presetId,
	durationSeconds,
	generateId,
	appliedAt,
}: {
	targets: TransitionTarget[];
	side: TransitionSide;
	presetId: string;
	durationSeconds?: number;
	generateId: () => string;
	appliedAt: string;
}): Command | null {
	const preset = getTransitionPreset({ presetId });
	if (!preset || targets.length === 0) {
		return null;
	}

	const commands: Command[] = [];

	for (const { trackId, element } of targets) {
		for (const owned of element.transitions?.[side]?.ownedKeyframes ?? []) {
			commands.push(
				new RemoveKeyframeCommand({
					trackId,
					elementId: element.id,
					propertyPath: owned.propertyPath,
					keyframeId: owned.keyframeId,
				}),
			);
		}

		const resolvedDuration = Math.max(
			0.04,
			Math.min(durationSeconds ?? preset.defaultDuration, element.duration),
		);
		const specs = buildTransitionKeyframeSpecs({
			element,
			preset,
			side,
			duration: resolvedDuration,
			getBaseValueForPath: ({ propertyPath, time }) => {
				const baseValue = getElementBaseValueForProperty({
					element,
					propertyPath,
				});
				if (typeof baseValue !== "number") return null;
				return resolveNumberAtTime({
					baseValue,
					animations: element.animations,
					propertyPath,
					localTime: time,
				});
			},
		});
		const ownedKeyframes = specs.map((spec) => ({
			propertyPath: spec.propertyPath,
			keyframeId: generateId(),
		}));
		for (let index = 0; index < specs.length; index++) {
			const spec = specs[index];
			const keyframeId = ownedKeyframes[index]?.keyframeId;
			if (!spec || !keyframeId) continue;
			commands.push(
				new UpsertKeyframeCommand({
					trackId,
					elementId: element.id,
					propertyPath: spec.propertyPath,
					time: spec.time,
					value: spec.value,
					interpolation: spec.interpolation,
					keyframeId,
				}),
			);
		}

		commands.push(
			new UpdateElementCommand(trackId, element.id, {
				transitions: {
					...(element.transitions ?? {}),
					[side]: {
						presetId: preset.id,
						duration: resolvedDuration,
						ownedKeyframes,
						appliedAt,
					},
				},
			}),
		);
	}

	return asSingleCommand(commands);
}

export function buildRemoveTransitionCommand({
	targets,
	side,
}: {
	targets: TransitionTarget[];
	side: TransitionSide;
}): Command | null {
	const commands: Command[] = [];

	for (const { trackId, element } of targets) {
		for (const owned of element.transitions?.[side]?.ownedKeyframes ?? []) {
			commands.push(
				new RemoveKeyframeCommand({
					trackId,
					elementId: element.id,
					propertyPath: owned.propertyPath,
					keyframeId: owned.keyframeId,
				}),
			);
		}

		const nextTransitions = {
			...(element.transitions ?? {}),
		};
		delete nextTransitions[side];
		commands.push(
			new UpdateElementCommand(trackId, element.id, {
				transitions: nextTransitions,
			}),
		);
	}

	return asSingleCommand(commands);
}

export type TransitionCommandSpec = {
	propertyPath: AnimationPropertyPath;
	time: number;
	value: number;
	interpolation?: AnimationInterpolation;
};
