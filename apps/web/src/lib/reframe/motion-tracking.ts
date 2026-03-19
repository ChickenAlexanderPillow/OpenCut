import type { VideoMotionTracking, VideoReframePresetTransform } from "@/types/timeline";

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export interface MotionTrackingTransformKeyframe {
	id: string;
	time: number;
	position: VideoReframePresetTransform["position"];
	scale: number;
}

function resolveTrackedKeyframeAtTime({
	keyframes,
	localTime,
}: {
	keyframes: MotionTrackingTransformKeyframe[];
	localTime: number;
}): MotionTrackingTransformKeyframe | null {
	const pair = getKeyframePair({ keyframes, localTime });
	if (!pair) return null;
	return {
		id: `${pair.left.id}:${pair.right.id}:${localTime.toFixed(4)}`,
		time: Math.max(0, localTime),
		position: {
			x: lerp(pair.left.position.x, pair.right.position.x, pair.progress),
			y: lerp(pair.left.position.y, pair.right.position.y, pair.progress),
		},
		scale: lerp(pair.left.scale, pair.right.scale, pair.progress),
	};
}

function getKeyframePair({
	keyframes,
	localTime,
}: {
	keyframes: MotionTrackingTransformKeyframe[];
	localTime: number;
}): {
	left: MotionTrackingTransformKeyframe;
	right: MotionTrackingTransformKeyframe;
	progress: number;
} | null {
	if (keyframes.length === 0) return null;
	if (keyframes.length === 1) {
		return {
			left: keyframes[0]!,
			right: keyframes[0]!,
			progress: 1,
		};
	}
	const safeTime = Math.max(0, localTime);
	if (safeTime <= keyframes[0]!.time) {
		return {
			left: keyframes[0]!,
			right: keyframes[0]!,
			progress: 1,
		};
	}
	for (let index = 0; index < keyframes.length - 1; index++) {
		const left = keyframes[index]!;
		const right = keyframes[index + 1]!;
		if (safeTime <= right.time) {
			const span = Math.max(1e-6, right.time - left.time);
			return {
				left,
				right,
				progress: clamp((safeTime - left.time) / span, 0, 1),
			};
		}
	}
	const last = keyframes[keyframes.length - 1]!;
	return {
		left: last,
		right: last,
		progress: 1,
	};
}

function lerp(left: number, right: number, progress: number): number {
	return left + (right - left) * progress;
}

export function resolveMotionTrackedReframeTransform({
	baseTransform,
	motionTracking,
	localTime,
}: {
	baseTransform: VideoReframePresetTransform;
	motionTracking: VideoMotionTracking | undefined;
	localTime: number;
}): VideoReframePresetTransform {
	if (!motionTracking?.enabled || (motionTracking.keyframes?.length ?? 0) === 0) {
		return baseTransform;
	}
	const keyframes = [...motionTracking.keyframes].sort(
		(left, right) => left.time - right.time,
	);
	const pair = getKeyframePair({
		keyframes,
		localTime,
	});
	if (!pair) return baseTransform;
	const interpolatedPosition = {
		x: lerp(pair.left.position.x, pair.right.position.x, pair.progress),
		y: lerp(pair.left.position.y, pair.right.position.y, pair.progress),
	};
	const interpolatedScale = motionTracking.animateScale
		? lerp(pair.left.scale, pair.right.scale, pair.progress)
		: baseTransform.scale;
	return {
		position: interpolatedPosition,
		scale: interpolatedScale,
	};
}

export function clampMotionTrackingToDuration({
	motionTracking,
	duration,
}: {
	motionTracking: VideoMotionTracking | undefined;
	duration: number;
}): VideoMotionTracking | undefined {
	if (!motionTracking) return undefined;
	const keyframes = (motionTracking.keyframes ?? []).filter(
		(keyframe) => keyframe.time >= 0 && keyframe.time <= duration,
	);
	return keyframes.length > 0
		? {
				...motionTracking,
				keyframes,
		  }
		: undefined;
}

export function offsetMotionTrackingKeyframes({
	keyframes,
	timeOffset,
}: {
	keyframes: MotionTrackingTransformKeyframe[];
	timeOffset: number;
}): MotionTrackingTransformKeyframe[] {
	return keyframes.map((keyframe) => ({
		...keyframe,
		time: Math.max(0, keyframe.time + timeOffset),
	}));
}

export function mergeMotionTrackingKeyframes({
	baseKeyframes,
	appendedKeyframes,
}: {
	baseKeyframes: MotionTrackingTransformKeyframe[];
	appendedKeyframes: MotionTrackingTransformKeyframe[];
}): MotionTrackingTransformKeyframe[] {
	const merged = [...baseKeyframes];
	for (const keyframe of appendedKeyframes) {
		if (
			merged.some(
				(existing) => Math.abs(existing.time - keyframe.time) <= 1e-6,
			)
		) {
			continue;
		}
		merged.push(keyframe);
	}
	return merged.sort((left, right) => left.time - right.time);
}

export function splitMotionTrackingAtTime({
	motionTracking,
	splitTime,
	rightBoundaryStrategy = "interpolate",
}: {
	motionTracking: VideoMotionTracking | undefined;
	splitTime: number;
	rightBoundaryStrategy?: "interpolate" | "hold-next-keyframe";
}): {
	left: VideoMotionTracking | undefined;
	right: VideoMotionTracking | undefined;
} {
	if (!motionTracking) {
		return { left: undefined, right: undefined };
	}
	const boundaryKeyframe = resolveTrackedKeyframeAtTime({
		keyframes: motionTracking.keyframes ?? [],
		localTime: splitTime,
	});
	const leftKeyframes = (motionTracking.keyframes ?? []).filter(
		(keyframe) => keyframe.time <= splitTime,
	);
	if (
		boundaryKeyframe &&
		!leftKeyframes.some((keyframe) => Math.abs(keyframe.time - splitTime) <= 1e-6)
	) {
		leftKeyframes.push(boundaryKeyframe);
	}
	const rightKeyframes = (motionTracking.keyframes ?? [])
		.filter((keyframe) => keyframe.time >= splitTime)
		.map((keyframe) => ({
			...keyframe,
			time: Math.max(0, keyframe.time - splitTime),
		}));
	const firstRetainedRightKeyframe = rightKeyframes[0];
	if (
		boundaryKeyframe &&
		!rightKeyframes.some((keyframe) => Math.abs(keyframe.time) <= 1e-6)
	) {
		rightKeyframes.unshift(
			rightBoundaryStrategy === "hold-next-keyframe" && firstRetainedRightKeyframe
				? {
						...firstRetainedRightKeyframe,
						id: `${firstRetainedRightKeyframe.id}:split-start`,
						time: 0,
				  }
				: {
						...boundaryKeyframe,
						id: `${boundaryKeyframe.id}:right`,
						time: 0,
				  },
		);
	}
	return {
		left:
			leftKeyframes.length > 0
				? {
						...motionTracking,
						cacheKey: undefined,
						keyframes: leftKeyframes,
				  }
				: undefined,
		right:
			rightKeyframes.length > 0
				? {
						...motionTracking,
						cacheKey: undefined,
						keyframes: rightKeyframes,
				  }
				: undefined,
	};
}
