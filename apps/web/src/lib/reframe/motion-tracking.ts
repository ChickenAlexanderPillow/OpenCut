import type { VideoMotionTracking, VideoReframePresetTransform } from "@/types/timeline";

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export const DEFAULT_MOTION_TRACKING_STRENGTH = 0.55;

export function normalizeMotionTrackingStrength(
	trackingStrength: number | null | undefined,
): number {
	if (!Number.isFinite(trackingStrength)) {
		return DEFAULT_MOTION_TRACKING_STRENGTH;
	}
	return clamp(trackingStrength ?? DEFAULT_MOTION_TRACKING_STRENGTH, 0, 1);
}

export interface MotionTrackingTransformKeyframe {
	id: string;
	time: number;
	position: VideoReframePresetTransform["position"];
	scale: number;
	subjectCenter?: VideoReframePresetTransform["position"];
	subjectSize?: {
		width: number;
		height: number;
	};
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
		subjectCenter:
			pair.left.subjectCenter && pair.right.subjectCenter
				? {
						x: lerp(
							pair.left.subjectCenter.x,
							pair.right.subjectCenter.x,
							pair.progress,
						),
						y: lerp(
							pair.left.subjectCenter.y,
							pair.right.subjectCenter.y,
							pair.progress,
						),
				  }
				: pair.left.subjectCenter
					? {
							x: pair.left.subjectCenter.x,
							y: pair.left.subjectCenter.y,
					  }
					: pair.right.subjectCenter
						? {
								x: pair.right.subjectCenter.x,
								y: pair.right.subjectCenter.y,
						  }
						: undefined,
		subjectSize:
			pair.left.subjectSize && pair.right.subjectSize
				? {
						width: lerp(
							pair.left.subjectSize.width,
							pair.right.subjectSize.width,
							pair.progress,
						),
						height: lerp(
							pair.left.subjectSize.height,
							pair.right.subjectSize.height,
							pair.progress,
						),
				  }
				: pair.left.subjectSize
					? {
							width: pair.left.subjectSize.width,
							height: pair.left.subjectSize.height,
					  }
					: pair.right.subjectSize
						? {
								width: pair.right.subjectSize.width,
								height: pair.right.subjectSize.height,
						  }
						: undefined,
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
	const lockedTrackedScale = keyframes[0]?.scale ?? baseTransform.scale;
	const interpolatedScale = motionTracking.animateScale
		? lerp(pair.left.scale, pair.right.scale, pair.progress)
		: lockedTrackedScale;
	return {
		position: interpolatedPosition,
		scale: interpolatedScale,
	};
}

export function resolveMotionTrackedSubjectCenter({
	motionTracking,
	localTime,
}: {
	motionTracking: VideoMotionTracking | undefined;
	localTime: number;
}): { x: number; y: number } | null {
	if (!motionTracking?.enabled || (motionTracking.keyframes?.length ?? 0) === 0) {
		return null;
	}
	const keyframes = [...motionTracking.keyframes].sort(
		(left, right) => left.time - right.time,
	);
	const tracked = resolveTrackedKeyframeAtTime({
		keyframes,
		localTime,
	});
	return tracked?.subjectCenter
		? {
				x: tracked.subjectCenter.x,
				y: tracked.subjectCenter.y,
		  }
		: null;
}

export function resolveMotionTrackedSubjectFrame({
	motionTracking,
	localTime,
}: {
	motionTracking: VideoMotionTracking | undefined;
	localTime: number;
}):
	| {
			center: { x: number; y: number };
			size: { width: number; height: number } | null;
	  }
	| null {
	if (!motionTracking?.enabled || (motionTracking.keyframes?.length ?? 0) === 0) {
		return null;
	}
	const keyframes = [...motionTracking.keyframes].sort(
		(left, right) => left.time - right.time,
	);
	const tracked = resolveTrackedKeyframeAtTime({
		keyframes,
		localTime,
	});
	if (!tracked?.subjectCenter) return null;
	const resolvedSubjectSize = motionTracking.animateScale
		? tracked.subjectSize
		: keyframes.find((keyframe) => keyframe.subjectSize)?.subjectSize;
	return {
		center: {
			x: tracked.subjectCenter.x,
			y: tracked.subjectCenter.y,
		},
		size: resolvedSubjectSize
			? {
					width: resolvedSubjectSize.width,
					height: resolvedSubjectSize.height,
			  }
			: null,
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
