import type { MediaAsset } from "@/types/assets";
import type {
	VideoElement,
	VideoReframePreset,
	VideoReframeSubjectSeed,
	VideoReframePresetTransform,
	VideoReframeSwitch,
} from "@/types/timeline";
import { generateUUID } from "@/utils/id";
import {
	DEFAULT_MOTION_TRACKING_STRENGTH,
	normalizeMotionTrackingStrength,
} from "./motion-tracking";
import { buildVideoReframePreset } from "./video-reframe";
import type { MotionTrackingTransformKeyframe } from "./motion-tracking";

const MEDIAPIPE_WASM_BASE =
	"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const FACE_MODEL_PATH =
	"https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const POSE_MODEL_PATH =
	"https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

type SubjectBox = {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	anchorX?: number;
	anchorY?: number;
	fitWidth?: number;
	fitHeight?: number;
};

type SubjectObservation = {
	time: number;
	boxes: SubjectBox[];
};

type SubjectTrackingObservation = {
	time: number;
	box: SubjectBox | null;
};

type AutoSectionKind = "Subject" | "Subject Left" | "Subject Right";
type TrackingSubjectHint = "left" | "right" | "center";
type SourceViewportBounds = {
	left: number;
	right: number;
	top: number;
	bottom: number;
};

function buildSubjectSeed({
	box,
	identity,
}: {
	box: SubjectBox;
	identity: VideoReframeSubjectSeed["identity"];
}): VideoReframeSubjectSeed {
	return {
		center: {
			x: box.anchorX ?? box.centerX,
			y: box.anchorY ?? box.centerY,
		},
		size: {
			width: box.fitWidth ?? box.width,
			height: box.fitHeight ?? box.height,
		},
		identity,
	};
}

type VisionRuntime = Awaited<ReturnType<typeof loadVisionRuntime>>;

let runtimePromise: Promise<VisionRuntime> | null = null;
let suppressedVisionConsoleErrorDepth = 0;
let restoreVisionConsoleError: (() => void) | null = null;
let lastFaceDetectorTimestampMs = 0;
let lastPoseLandmarkerTimestampMs = 0;

function createAbortError(): Error {
	const error = new Error("Analysis aborted");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw createAbortError();
	}
}

function shouldSuppressVisionConsoleMessage(args: unknown[]): boolean {
	return args.some((value) => {
		const message =
			value instanceof Error
				? value.message
				: typeof value === "string"
					? value
					: "";
		const normalizedMessage = message.trim().toLowerCase();
		return (
			normalizedMessage.startsWith(
				"info: created tensorflow lite xnnpack delegate",
			) ||
			normalizedMessage.includes("xnnpack delegate for cpu") ||
			normalizedMessage.includes("packet timestamp mismatch")
		);
	});
}

function getMonotonicVisionTimestampMs({
	kind,
	candidateMs,
}: {
	kind: "face" | "pose";
	candidateMs: number;
}): number {
	if (kind === "face") {
		lastFaceDetectorTimestampMs = Math.max(
			lastFaceDetectorTimestampMs + 1,
			Math.round(candidateMs),
		);
		return lastFaceDetectorTimestampMs;
	}
	lastPoseLandmarkerTimestampMs = Math.max(
		lastPoseLandmarkerTimestampMs + 1,
		Math.round(candidateMs),
	);
	return lastPoseLandmarkerTimestampMs;
}

function beginSuppressingVisionConsoleErrors(): void {
	if (typeof window === "undefined") {
		return;
	}
	if (suppressedVisionConsoleErrorDepth === 0) {
		const originalConsoleError = console.error.bind(console);
		console.error = (...args: unknown[]) => {
			if (shouldSuppressVisionConsoleMessage(args)) {
				return;
			}
			originalConsoleError(...args);
		};
		restoreVisionConsoleError = () => {
			console.error = originalConsoleError;
		};
	}
	suppressedVisionConsoleErrorDepth += 1;
}

function endSuppressingVisionConsoleErrors(): void {
	if (
		typeof window === "undefined" ||
		suppressedVisionConsoleErrorDepth === 0
	) {
		return;
	}
	suppressedVisionConsoleErrorDepth -= 1;
	if (suppressedVisionConsoleErrorDepth === 0) {
		restoreVisionConsoleError?.();
		restoreVisionConsoleError = null;
	}
}

function withSuppressedVisionConsoleErrors<T>(action: () => T): T {
	beginSuppressingVisionConsoleErrors();
	try {
		return action();
	} finally {
		endSuppressingVisionConsoleErrors();
	}
}

async function withSuppressedVisionConsoleErrorsAsync<T>(
	action: () => Promise<T>,
): Promise<T> {
	beginSuppressingVisionConsoleErrors();
	try {
		return await action();
	} finally {
		endSuppressingVisionConsoleErrors();
	}
}

async function loadVisionRuntime() {
	return withSuppressedVisionConsoleErrorsAsync(async () => {
		const { FaceDetector, FilesetResolver, PoseLandmarker } = await import(
			"@mediapipe/tasks-vision"
		);
		const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
		const [faceDetector, poseLandmarker] = await Promise.all([
			FaceDetector.createFromOptions(vision, {
				baseOptions: {
					modelAssetPath: FACE_MODEL_PATH,
				},
				runningMode: "VIDEO",
				minDetectionConfidence: 0.45,
			}),
			PoseLandmarker.createFromOptions(vision, {
				baseOptions: {
					modelAssetPath: POSE_MODEL_PATH,
				},
				runningMode: "VIDEO",
				numPoses: 2,
				minPoseDetectionConfidence: 0.35,
				minPosePresenceConfidence: 0.3,
				minTrackingConfidence: 0.3,
			}),
		]);
		return { faceDetector, poseLandmarker };
	});
}

async function getVisionRuntime(): Promise<VisionRuntime> {
	if (!runtimePromise) {
		runtimePromise = loadVisionRuntime();
	}
	return runtimePromise;
}

async function loadVideo({
	asset,
	signal,
}: {
	asset: MediaAsset;
	signal?: AbortSignal;
}): Promise<{ video: HTMLVideoElement; cleanup: () => void }> {
	throwIfAborted(signal);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	const objectUrl = asset.url ?? URL.createObjectURL(asset.file);
	video.src = objectUrl;
	await new Promise<void>((resolve, reject) => {
		const onLoaded = () => {
			cleanupListeners();
			resolve();
		};
		const onError = () => {
			cleanupListeners();
			reject(new Error(`Failed to load video for reframing: ${asset.name}`));
		};
		const onAbort = () => {
			cleanupListeners();
			reject(createAbortError());
		};
		const cleanupListeners = () => {
			video.removeEventListener("loadedmetadata", onLoaded);
			video.removeEventListener("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		video.addEventListener("loadedmetadata", onLoaded);
		video.addEventListener("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		throwIfAborted(signal);
	});
	return {
		video,
		cleanup: () => {
			video.pause();
			video.removeAttribute("src");
			video.load();
			if (!asset.url) {
				URL.revokeObjectURL(objectUrl);
			}
		},
	};
}

async function seekVideo({
	video,
	time,
	signal,
}: {
	video: HTMLVideoElement;
	time: number;
	signal?: AbortSignal;
}) {
	throwIfAborted(signal);
	const targetTime = Math.max(0, time);
	if (Math.abs(video.currentTime - targetTime) <= 1 / 240 && !video.seeking) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const timeout = window.setTimeout(() => {
			cleanup();
			reject(new Error("Timed out seeking video for subject-aware analysis"));
		}, 1500);
		const onSeeked = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error("Failed to seek video for subject-aware reframing"));
		};
		const onAbort = () => {
			cleanup();
			reject(createAbortError());
		};
		const cleanup = () => {
			window.clearTimeout(timeout);
			video.removeEventListener("seeked", onSeeked);
			video.removeEventListener("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		video.addEventListener("seeked", onSeeked);
		video.addEventListener("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		throwIfAborted(signal);
		video.currentTime = targetTime;
	});
}

async function waitForVideoFrameReady({
	video,
	signal,
}: {
	video: HTMLVideoElement;
	signal?: AbortSignal;
}) {
	throwIfAborted(signal);
	if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error("Timed out waiting for video frame data"));
			}, 2000);
			const onReady = () => {
				if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
					return;
				}
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("Video failed while waiting for frame data"));
			};
			const onAbort = () => {
				cleanup();
				reject(createAbortError());
			};
			const cleanup = () => {
				clearTimeout(timeout);
				video.removeEventListener("loadeddata", onReady);
				video.removeEventListener("canplay", onReady);
				video.removeEventListener("timeupdate", onReady);
				video.removeEventListener("error", onError);
				signal?.removeEventListener("abort", onAbort);
			};
			video.addEventListener("loadeddata", onReady);
			video.addEventListener("canplay", onReady);
			video.addEventListener("timeupdate", onReady);
			video.addEventListener("error", onError);
			signal?.addEventListener("abort", onAbort, { once: true });
			throwIfAborted(signal);
			onReady();
		});
	}

	if ("requestVideoFrameCallback" in video) {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				reject(createAbortError());
			};
			const timeout = setTimeout(finish, 250);
			signal?.addEventListener("abort", onAbort, { once: true });
			throwIfAborted(signal);
			(
				video as HTMLVideoElement & {
					requestVideoFrameCallback?: (callback: () => void) => number;
				}
			).requestVideoFrameCallback?.(() => {
				clearTimeout(timeout);
				finish();
			});
		});
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const frame = requestAnimationFrame(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		});
		const onAbort = () => {
			cancelAnimationFrame(frame);
			signal?.removeEventListener("abort", onAbort);
			reject(createAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		throwIfAborted(signal);
	});
	await new Promise<void>((resolve, reject) => {
		const frame = requestAnimationFrame(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		});
		const onAbort = () => {
			cancelAnimationFrame(frame);
			signal?.removeEventListener("abort", onAbort);
			reject(createAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		throwIfAborted(signal);
	});
}

function canAnalyzeCurrentVideoFrame({ video }: { video: HTMLVideoElement }) {
	return (
		Number.isFinite(video.currentTime) &&
		!video.seeking &&
		video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
		video.videoWidth > 0 &&
		video.videoHeight > 0
	);
}

function isIgnorableVisionRuntimeMessage(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	const normalizedMessage = message.trim().toLowerCase();
	return (
		normalizedMessage.startsWith("info:") ||
		normalizedMessage.includes("xnnpack delegate for cpu")
	);
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
	}
	return sorted[middle] ?? 0;
}

function quantile(values: number[], percentile: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.max(
		0,
		Math.min(sorted.length - 1, Math.round((sorted.length - 1) * percentile)),
	);
	return sorted[index] ?? 0;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function getSourceCenterForTransform({
	transform,
	canvasSize,
	sourceWidth,
	sourceHeight,
}: {
	transform: VideoReframePresetTransform;
	canvasSize: { width: number; height: number };
	sourceWidth: number;
	sourceHeight: number;
}): { x: number; y: number } {
	const containScale = Math.min(
		canvasSize.width / Math.max(1, sourceWidth),
		canvasSize.height / Math.max(1, sourceHeight),
	);
	const totalScale = Math.max(1e-6, containScale * transform.scale);
	return {
		x: sourceWidth / 2 - transform.position.x / totalScale,
		y: sourceHeight / 2 - transform.position.y / totalScale,
	};
}

function getSourceViewportBoundsForTransform({
	transform,
	canvasSize,
	sourceWidth,
	sourceHeight,
}: {
	transform: VideoReframePresetTransform;
	canvasSize: { width: number; height: number };
	sourceWidth: number;
	sourceHeight: number;
}): SourceViewportBounds {
	const containScale = Math.min(
		canvasSize.width / Math.max(1, sourceWidth),
		canvasSize.height / Math.max(1, sourceHeight),
	);
	const totalScale = Math.max(1e-6, containScale * transform.scale);
	const center = getSourceCenterForTransform({
		transform,
		canvasSize,
		sourceWidth,
		sourceHeight,
	});
	const halfWidth = canvasSize.width / (2 * totalScale);
	const halfHeight = canvasSize.height / (2 * totalScale);
	return {
		left: center.x - halfWidth,
		right: center.x + halfWidth,
		top: center.y - halfHeight,
		bottom: center.y + halfHeight,
	};
}

function buildObservationSampleTimes({
	startTime,
	duration,
}: {
	startTime: number;
	duration: number;
}): number[] {
	const endTime = startTime + duration;
	const earlyOffsets = [0, 1 / 30, 2 / 30, 3 / 30, 5 / 30]
		.map((offset) => startTime + offset)
		.filter((time, index, values) => {
			if (time > endTime) return false;
			return index === 0 || Math.abs(time - (values[index - 1] ?? 0)) > 1 / 300;
		});
	const sampleCount = clamp(Math.round(duration * 4), 12, 36);
	const uniformTimes = Array.from(
		{ length: sampleCount },
		(_, index) => startTime + (duration * index) / Math.max(1, sampleCount - 1),
	);
	return [...earlyOffsets, ...uniformTimes]
		.sort((left, right) => left - right)
		.filter((time, index, values) => {
			if (time < startTime || time > endTime) return false;
			return index === 0 || Math.abs(time - (values[index - 1] ?? 0)) > 1 / 120;
		});
}

function buildMotionTrackingSampleTimes({
	startTime,
	duration,
}: {
	startTime: number;
	duration: number;
}): number[] {
	const endTime = startTime + duration;
	const targetSamplesPerSecond = duration > 18 ? 5 : 6;
	const maxSamples = duration > 18 ? 84 : 96;
	const minSamples = 10;
	const sampleCount = clamp(
		Math.round(duration * targetSamplesPerSecond) + 1,
		minSamples,
		maxSamples,
	);
	return Array.from(
		{ length: sampleCount },
		(_, index) => startTime + (duration * index) / Math.max(1, sampleCount - 1),
	).filter((time, index, values) => {
		if (time < startTime || time > endTime) return false;
		return index === 0 || Math.abs(time - (values[index - 1] ?? 0)) > 1 / 240;
	});
}

function lerpMotionTrackingSetting(
	min: number,
	max: number,
	trackingStrength: number,
): number {
	return min + (max - min) * normalizeMotionTrackingStrength(trackingStrength);
}

function smoothObservationSegment({
	observations,
	trackingStrength = DEFAULT_MOTION_TRACKING_STRENGTH,
}: {
	observations: SubjectTrackingObservation[];
	trackingStrength?: number;
}): SubjectTrackingObservation[] {
	if (observations.length <= 1)
		return observations.map((observation) => ({
			time: observation.time,
			box: observation.box ? { ...observation.box } : null,
		}));

	const normalizedStrength = normalizeMotionTrackingStrength(trackingStrength);
	const positionBlend = lerpMotionTrackingSetting(
		0.14,
		0.5,
		normalizedStrength,
	);
	const sizeBlend = lerpMotionTrackingSetting(0.08, 0.26, normalizedStrength);
	const fitBlend = lerpMotionTrackingSetting(0.12, 0.34, normalizedStrength);

	const forward: SubjectTrackingObservation[] = [];
	let previousForward: SubjectBox | null = null;
	for (const observation of observations) {
		const currentBox = observation.box;
		if (!currentBox) {
			forward.push({ time: observation.time, box: null });
			previousForward = null;
			continue;
		}
		if (!previousForward) {
			forward.push({ time: observation.time, box: { ...currentBox } });
			previousForward = { ...currentBox };
			continue;
		}
		const nextBox: SubjectBox = {
			centerX:
				previousForward.centerX +
				(currentBox.centerX - previousForward.centerX) * positionBlend,
			centerY:
				previousForward.centerY +
				(currentBox.centerY - previousForward.centerY) * positionBlend,
			width:
				previousForward.width +
				(currentBox.width - previousForward.width) * sizeBlend,
			height:
				previousForward.height +
				(currentBox.height - previousForward.height) * sizeBlend,
			anchorX:
				(previousForward.anchorX ?? previousForward.centerX) +
				((currentBox.anchorX ?? currentBox.centerX) -
					(previousForward.anchorX ?? previousForward.centerX)) *
					positionBlend,
			anchorY:
				(previousForward.anchorY ?? previousForward.centerY) +
				((currentBox.anchorY ?? currentBox.centerY) -
					(previousForward.anchorY ?? previousForward.centerY)) *
					positionBlend,
			fitWidth:
				(previousForward.fitWidth ?? previousForward.width) +
				((currentBox.fitWidth ?? currentBox.width) -
					(previousForward.fitWidth ?? previousForward.width)) *
					fitBlend,
			fitHeight:
				(previousForward.fitHeight ?? previousForward.height) +
				((currentBox.fitHeight ?? currentBox.height) -
					(previousForward.fitHeight ?? previousForward.height)) *
					fitBlend,
		};
		forward.push({ time: observation.time, box: nextBox });
		previousForward = nextBox;
	}

	const backward = [...forward].reverse();
	const smoothedReverse: SubjectTrackingObservation[] = [];
	let previousBackward: SubjectBox | null = null;
	for (const observation of backward) {
		const currentBox = observation.box;
		if (!currentBox) {
			smoothedReverse.push({ time: observation.time, box: null });
			previousBackward = null;
			continue;
		}
		if (!previousBackward) {
			smoothedReverse.push({ time: observation.time, box: { ...currentBox } });
			previousBackward = { ...currentBox };
			continue;
		}
		const nextBox: SubjectBox = {
			centerX:
				previousBackward.centerX +
				(currentBox.centerX - previousBackward.centerX) * positionBlend,
			centerY:
				previousBackward.centerY +
				(currentBox.centerY - previousBackward.centerY) * positionBlend,
			width:
				previousBackward.width +
				(currentBox.width - previousBackward.width) * sizeBlend,
			height:
				previousBackward.height +
				(currentBox.height - previousBackward.height) * sizeBlend,
			anchorX:
				(previousBackward.anchorX ?? previousBackward.centerX) +
				((currentBox.anchorX ?? currentBox.centerX) -
					(previousBackward.anchorX ?? previousBackward.centerX)) *
					positionBlend,
			anchorY:
				(previousBackward.anchorY ?? previousBackward.centerY) +
				((currentBox.anchorY ?? currentBox.centerY) -
					(previousBackward.anchorY ?? previousBackward.centerY)) *
					positionBlend,
			fitWidth:
				(previousBackward.fitWidth ?? previousBackward.width) +
				((currentBox.fitWidth ?? currentBox.width) -
					(previousBackward.fitWidth ?? previousBackward.width)) *
					fitBlend,
			fitHeight:
				(previousBackward.fitHeight ?? previousBackward.height) +
				((currentBox.fitHeight ?? currentBox.height) -
					(previousBackward.fitHeight ?? previousBackward.height)) *
					fitBlend,
		};
		smoothedReverse.push({ time: observation.time, box: nextBox });
		previousBackward = nextBox;
	}

	return smoothedReverse.reverse().map((observation, index) => {
		const pairedForward = forward[index];
		if (!observation.box || !pairedForward?.box) {
			return {
				time: observation.time,
				box: observation.box ? { ...observation.box } : null,
			};
		}
		return {
			time: observation.time,
			box: {
				centerX: (observation.box.centerX + pairedForward.box.centerX) / 2,
				centerY: (observation.box.centerY + pairedForward.box.centerY) / 2,
				width: (observation.box.width + pairedForward.box.width) / 2,
				height: (observation.box.height + pairedForward.box.height) / 2,
				anchorX:
					((observation.box.anchorX ?? observation.box.centerX) +
						(pairedForward.box.anchorX ?? pairedForward.box.centerX)) /
					2,
				anchorY:
					((observation.box.anchorY ?? observation.box.centerY) +
						(pairedForward.box.anchorY ?? pairedForward.box.centerY)) /
					2,
				fitWidth:
					((observation.box.fitWidth ?? observation.box.width) +
						(pairedForward.box.fitWidth ?? pairedForward.box.width)) /
					2,
				fitHeight:
					((observation.box.fitHeight ?? observation.box.height) +
						(pairedForward.box.fitHeight ?? pairedForward.box.height)) /
					2,
			},
		};
	});
}

function buildFallbackSubjectPreset({ baseScale }: { baseScale: number }) {
	return buildVideoReframePreset({
		name: "Subject",
		autoSeeded: true,
		transform: {
			position: { x: 0, y: 0 },
			scale: Math.max(1, baseScale),
		},
	});
}

function derivePresetTransform({
	box,
	canvasSize,
	sourceWidth,
	sourceHeight,
	baseScale,
	tightness = 0.42,
}: {
	box: SubjectBox;
	canvasSize: { width: number; height: number };
	sourceWidth: number;
	sourceHeight: number;
	baseScale: number;
	tightness?: number;
}) {
	const containScale = Math.min(
		canvasSize.width / sourceWidth,
		canvasSize.height / sourceHeight,
	);
	const targetViewportWidthShare = clamp(tightness, 0.32, 0.62);
	const targetViewportHeightShare = clamp(
		Math.max(0.46, targetViewportWidthShare * 1.45),
		0.46,
		0.74,
	);
	const horizontalMarginRatio = 0.14;
	const verticalMarginRatio = 0.16;
	const effectiveSubjectWidth = box.width * (1 + horizontalMarginRatio * 2);
	const effectiveSubjectHeight = box.height * (1 + verticalMarginRatio * 2);
	const desiredWidthPx = canvasSize.width * targetViewportWidthShare;
	const desiredHeightPx = canvasSize.height * targetViewportHeightShare;
	const scaleForWidth =
		desiredWidthPx / Math.max(1, effectiveSubjectWidth * containScale);
	const scaleForHeight =
		desiredHeightPx / Math.max(1, effectiveSubjectHeight * containScale);
	const scale = clamp(
		Math.max(baseScale, scaleForWidth, scaleForHeight),
		baseScale,
		baseScale * 3.2,
	);
	const visibleHalfWidthInSource =
		canvasSize.width / Math.max(1, containScale * scale * 2);
	const visibleHalfHeightInSource =
		canvasSize.height / Math.max(1, containScale * scale * 2);
	const horizontalMarginInSource = Math.max(
		box.width * horizontalMarginRatio,
		visibleHalfWidthInSource * 0.08,
	);
	const verticalMarginInSource = Math.max(
		box.height * verticalMarginRatio,
		visibleHalfHeightInSource * 0.06,
	);
	const minViewportCenterX =
		box.centerX +
		box.width / 2 +
		horizontalMarginInSource -
		visibleHalfWidthInSource;
	const maxViewportCenterX =
		box.centerX -
		box.width / 2 -
		horizontalMarginInSource +
		visibleHalfWidthInSource;
	const minViewportCenterY =
		box.centerY +
		box.height / 2 +
		verticalMarginInSource -
		visibleHalfHeightInSource;
	const maxViewportCenterY =
		box.centerY -
		box.height / 2 -
		verticalMarginInSource +
		visibleHalfHeightInSource;
	const desiredViewportCenterX = clamp(
		box.anchorX ?? box.centerX,
		visibleHalfWidthInSource,
		Math.max(visibleHalfWidthInSource, sourceWidth - visibleHalfWidthInSource),
	);
	const desiredViewportCenterY = clamp(
		box.centerY,
		visibleHalfHeightInSource,
		Math.max(
			visibleHalfHeightInSource,
			sourceHeight - visibleHalfHeightInSource,
		),
	);
	const viewportCenterX =
		minViewportCenterX <= maxViewportCenterX
			? clamp(desiredViewportCenterX, minViewportCenterX, maxViewportCenterX)
			: desiredViewportCenterX;
	const viewportCenterY =
		minViewportCenterY <= maxViewportCenterY
			? clamp(desiredViewportCenterY, minViewportCenterY, maxViewportCenterY)
			: desiredViewportCenterY;
	return {
		position: {
			x: -((viewportCenterX - sourceWidth / 2) * containScale * scale),
			y: -((viewportCenterY - sourceHeight / 2) * containScale * scale),
		},
		scale,
	};
}

function extractPoseBox({
	landmarks,
	sourceWidth,
	sourceHeight,
}: {
	landmarks: Array<{ x: number; y: number }>;
	sourceWidth: number;
	sourceHeight: number;
}): SubjectBox | null {
	const valid = landmarks.filter(
		(entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y),
	);
	if (valid.length === 0) return null;
	const xs = valid.map((entry) => entry.x * sourceWidth);
	const ys = valid.map((entry) => entry.y * sourceHeight);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	return {
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2,
		width: Math.max(1, (maxX - minX) * 1.2),
		height: Math.max(1, (maxY - minY) * 1.25),
		anchorX: (minX + maxX) / 2,
		anchorY: minY + (maxY - minY) * 0.28,
		fitWidth: Math.max(1, (maxX - minX) * 0.78),
		fitHeight: Math.max(1, (maxY - minY) * 0.5),
	};
}

function dedupePresetNames(
	presets: VideoReframePreset[],
): VideoReframePreset[] {
	const seen = new Set<string>();
	return presets.filter((preset) => {
		if (seen.has(preset.name)) return false;
		seen.add(preset.name);
		return true;
	});
}

function getBoxArea(box: SubjectBox): number {
	return (
		Math.max(1, box.fitWidth ?? box.width) *
		Math.max(1, box.fitHeight ?? box.height)
	);
}

function getBoxDistance(left: SubjectBox, right: SubjectBox): number {
	return Math.hypot(left.centerX - right.centerX, left.centerY - right.centerY);
}

function getBoxIoU(left: SubjectBox, right: SubjectBox): number {
	const leftComparableWidth = left.fitWidth ?? left.width;
	const leftComparableHeight = left.fitHeight ?? left.height;
	const rightComparableWidth = right.fitWidth ?? right.width;
	const rightComparableHeight = right.fitHeight ?? right.height;
	const leftLeft = left.centerX - leftComparableWidth / 2;
	const leftRight = left.centerX + leftComparableWidth / 2;
	const leftTop = left.centerY - leftComparableHeight / 2;
	const leftBottom = left.centerY + leftComparableHeight / 2;
	const rightLeft = right.centerX - rightComparableWidth / 2;
	const rightRight = right.centerX + rightComparableWidth / 2;
	const rightTop = right.centerY - rightComparableHeight / 2;
	const rightBottom = right.centerY + rightComparableHeight / 2;
	const intersectionWidth = Math.max(
		0,
		Math.min(leftRight, rightRight) - Math.max(leftLeft, rightLeft),
	);
	const intersectionHeight = Math.max(
		0,
		Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop),
	);
	const intersectionArea = intersectionWidth * intersectionHeight;
	const unionArea = getBoxArea(left) + getBoxArea(right) - intersectionArea;
	return unionArea > 0 ? intersectionArea / unionArea : 0;
}

function getBoxOverlapWithViewport(
	box: SubjectBox,
	viewportBounds: SourceViewportBounds,
): number {
	const comparableWidth = box.fitWidth ?? box.width;
	const comparableHeight = box.fitHeight ?? box.height;
	const left = box.centerX - comparableWidth / 2;
	const right = box.centerX + comparableWidth / 2;
	const top = box.centerY - comparableHeight / 2;
	const bottom = box.centerY + comparableHeight / 2;
	const intersectionWidth = Math.max(
		0,
		Math.min(right, viewportBounds.right) - Math.max(left, viewportBounds.left),
	);
	const intersectionHeight = Math.max(
		0,
		Math.min(bottom, viewportBounds.bottom) - Math.max(top, viewportBounds.top),
	);
	const intersectionArea = intersectionWidth * intersectionHeight;
	return intersectionArea / Math.max(1, comparableWidth * comparableHeight);
}

export function choosePrimarySubjectBox({
	candidates,
	previousBox,
	sourceWidth,
	sourceHeight,
	targetCenterHint,
	targetSubjectHint,
	targetViewportBounds,
	targetSubjectSeed,
}: {
	candidates: SubjectBox[];
	previousBox: SubjectBox | null;
	sourceWidth: number;
	sourceHeight: number;
	targetCenterHint?: { x: number; y: number } | null;
	targetSubjectHint?: TrackingSubjectHint | null;
	targetViewportBounds?: SourceViewportBounds | null;
	targetSubjectSeed?: VideoReframeSubjectSeed | null;
}): SubjectBox | null {
	if (candidates.length === 0) return null;
	if (targetSubjectHint === "center" && candidates.length > 1) {
		const viewportMatchedCandidates = targetViewportBounds
			? candidates.filter(
					(candidate) =>
						getBoxOverlapWithViewport(candidate, targetViewportBounds) >= 0.12,
				)
			: [];
		return buildSubjectBoxFromDetections(
			viewportMatchedCandidates.length > 0
				? viewportMatchedCandidates
				: candidates,
		);
	}
	if (!previousBox) {
		const frameCenterX = targetCenterHint?.x ?? sourceWidth / 2;
		const frameCenterY = targetCenterHint?.y ?? sourceHeight / 2;
		const sideWeight =
			targetSubjectHint === "left" || targetSubjectHint === "right" ? 0.45 : 0;
		const viewportMatchedCandidates = targetViewportBounds
			? candidates.filter(
					(candidate) =>
						getBoxOverlapWithViewport(candidate, targetViewportBounds) >= 0.18,
				)
			: [];
		const initialCandidates =
			viewportMatchedCandidates.length > 0
				? viewportMatchedCandidates
				: candidates;
		const scoredInitialCandidates = initialCandidates.map((candidate) => {
			const centerPenalty =
				Math.hypot(
					candidate.centerX - frameCenterX,
					candidate.centerY - frameCenterY,
				) / Math.max(1, Math.hypot(frameCenterX, frameCenterY));
			const viewportOverlap = targetViewportBounds
				? getBoxOverlapWithViewport(candidate, targetViewportBounds)
				: 0;
			const seedDistancePenalty = targetSubjectSeed
				? Math.hypot(
						(candidate.anchorX ?? candidate.centerX) -
							targetSubjectSeed.center.x,
						(candidate.anchorY ?? candidate.centerY) -
							targetSubjectSeed.center.y,
					) / Math.max(1, Math.hypot(sourceWidth, sourceHeight))
				: 0;
			const seedAreaScore = targetSubjectSeed?.size
				? 1 -
					Math.abs(
						getBoxArea(candidate) -
							targetSubjectSeed.size.width * targetSubjectSeed.size.height,
					) /
						Math.max(
							getBoxArea(candidate),
							targetSubjectSeed.size.width * targetSubjectSeed.size.height,
							1,
						)
				: 0;
			const sidePreference =
				targetSubjectHint === "left"
					? 1 - candidate.centerX / Math.max(1, sourceWidth)
					: targetSubjectHint === "right"
						? candidate.centerX / Math.max(1, sourceWidth)
						: 0;
			const score =
				getBoxArea(candidate) *
					(1 +
						sidePreference * sideWeight +
						viewportOverlap * 0.9 +
						(targetSubjectSeed ? seedAreaScore * 0.45 : 0)) -
				centerPenalty * getBoxArea(candidate) * 0.2 -
				seedDistancePenalty * getBoxArea(candidate) * 0.75;
			return {
				candidate,
				score,
				viewportOverlap,
			};
		});
		const bestInitialScore = Math.max(
			...scoredInitialCandidates.map((entry) => entry.score),
		);
		const viableInitialCandidates = scoredInitialCandidates.filter(
			(entry) => entry.score >= bestInitialScore * 0.9,
		);
		if (targetSubjectHint === "left") {
			return (
				[...viableInitialCandidates].sort((left, right) => {
					if (
						Math.abs(left.candidate.centerX - right.candidate.centerX) > 1e-3
					) {
						return left.candidate.centerX - right.candidate.centerX;
					}
					return right.score - left.score;
				})[0]?.candidate ?? null
			);
		}
		if (targetSubjectHint === "right") {
			return (
				[...viableInitialCandidates].sort((left, right) => {
					if (
						Math.abs(left.candidate.centerX - right.candidate.centerX) > 1e-3
					) {
						return right.candidate.centerX - left.candidate.centerX;
					}
					return right.score - left.score;
				})[0]?.candidate ?? null
			);
		}
		return [...scoredInitialCandidates].sort((left, right) => {
			const leftCenterPenalty =
				Math.hypot(
					left.candidate.centerX - frameCenterX,
					left.candidate.centerY - frameCenterY,
				) / Math.max(1, Math.hypot(frameCenterX, frameCenterY));
			const rightCenterPenalty =
				Math.hypot(
					right.candidate.centerX - frameCenterX,
					right.candidate.centerY - frameCenterY,
				) / Math.max(1, Math.hypot(frameCenterX, frameCenterY));
			const leftScore =
				getBoxArea(left.candidate) * (1 + left.viewportOverlap * 0.9) -
				leftCenterPenalty * getBoxArea(left.candidate) * 0.2;
			const rightScore =
				getBoxArea(right.candidate) * (1 + right.viewportOverlap * 0.9) -
				rightCenterPenalty * getBoxArea(right.candidate) * 0.2;
			return rightScore - leftScore;
		})[0]!.candidate;
	}

	const frameDiagonal = Math.max(1, Math.hypot(sourceWidth, sourceHeight));
	const scoredCandidates = candidates.map((candidate) => {
		const overlapScore = getBoxIoU(candidate, previousBox) * 5;
		const distanceScore =
			(1 - getBoxDistance(candidate, previousBox) / frameDiagonal) * 2.5;
		const areaScore =
			1 -
			Math.abs(getBoxArea(candidate) - getBoxArea(previousBox)) /
				Math.max(getBoxArea(candidate), getBoxArea(previousBox), 1);
		return {
			candidate,
			score: overlapScore + distanceScore + areaScore,
			distanceRatio: getBoxDistance(candidate, previousBox) / frameDiagonal,
			overlap: getBoxIoU(candidate, previousBox),
			areaScore,
		};
	});
	const bestMatch = [...scoredCandidates].sort(
		(left, right) => right.score - left.score,
	)[0];
	if (!bestMatch) return null;
	const maxReacquireDistancePx = Math.max(
		sourceWidth * 0.11,
		(previousBox.fitWidth ?? previousBox.width) * 1.45,
	);
	const maxReacquireVerticalDistancePx = Math.max(
		sourceHeight * 0.12,
		(previousBox.fitHeight ?? previousBox.height) * 0.85,
	);
	const bestHorizontalDistance = Math.abs(
		bestMatch.candidate.centerX - previousBox.centerX,
	);
	const bestVerticalDistance = Math.abs(
		bestMatch.candidate.centerY - previousBox.centerY,
	);
	const isWeakMatch =
		bestMatch.overlap < 0.1 &&
		bestMatch.distanceRatio > 0.16 &&
		bestMatch.areaScore < 0.72;
	const isOutsideReacquireWindow =
		bestHorizontalDistance > maxReacquireDistancePx ||
		bestVerticalDistance > maxReacquireVerticalDistancePx;
	return isWeakMatch || isOutsideReacquireWindow ? null : bestMatch.candidate;
}

function smoothTrackedObservations({
	observations,
	trackingStrength = DEFAULT_MOTION_TRACKING_STRENGTH,
}: {
	observations: SubjectTrackingObservation[];
	trackingStrength?: number;
}): SubjectTrackingObservation[] {
	if (observations.length === 0) return [];
	const normalizedStrength = normalizeMotionTrackingStrength(trackingStrength);
	const maxHoldSeconds = lerpMotionTrackingSetting(
		1.4,
		0.45,
		normalizedStrength,
	);
	const heldObservations: SubjectTrackingObservation[] = [];
	let previousTracked: SubjectTrackingObservation | null = null;
	for (const observation of observations) {
		if (observation.box) {
			heldObservations.push(observation);
			previousTracked = observation;
			continue;
		}
		if (
			previousTracked &&
			observation.time - previousTracked.time <= maxHoldSeconds
		) {
			heldObservations.push({
				time: observation.time,
				box: { ...previousTracked.box! },
			});
			continue;
		}
		heldObservations.push(observation);
		previousTracked = null;
	}

	const smoothed: SubjectTrackingObservation[] = [];
	let segment: SubjectTrackingObservation[] = [];
	for (const observation of heldObservations) {
		if (!observation.box) {
			if (segment.length > 0) {
				smoothed.push(
					...smoothObservationSegment({
						observations: segment,
						trackingStrength: normalizedStrength,
					}),
				);
				segment = [];
			}
			smoothed.push(observation);
			continue;
		}
		segment.push(observation);
	}
	if (segment.length > 0) {
		smoothed.push(
			...smoothObservationSegment({
				observations: segment,
				trackingStrength: normalizedStrength,
			}),
		);
	}
	return smoothed;
}

function coalesceMotionTrackingKeyframes({
	trackedTransforms,
	animateScale,
	trackingStrength = DEFAULT_MOTION_TRACKING_STRENGTH,
}: {
	trackedTransforms: Array<
		SubjectTrackingObservation & {
			transform: ReturnType<typeof derivePresetTransform>;
		}
	>;
	animateScale: boolean;
	trackingStrength?: number;
}): MotionTrackingTransformKeyframe[] {
	if (trackedTransforms.length === 0) return [];
	const keyframes: MotionTrackingTransformKeyframe[] = [];
	let previousTracked: MotionTrackingTransformKeyframe | null = null;
	const normalizedStrength = normalizeMotionTrackingStrength(trackingStrength);
	const forcedSpacingSeconds = lerpMotionTrackingSetting(
		1.15,
		0.35,
		normalizedStrength,
	);
	const positionThresholdPx = lerpMotionTrackingSetting(
		12,
		3,
		normalizedStrength,
	);
	const scaleThreshold = lerpMotionTrackingSetting(
		0.05,
		0.012,
		normalizedStrength,
	);

	for (const [observationIndex, observation] of trackedTransforms.entries()) {
		const isFirst = observationIndex === 0;
		const isLast = observationIndex === trackedTransforms.length - 1;
		const nextScale = animateScale
			? observation.transform.scale
			: (previousTracked?.scale ?? trackedTransforms[0]!.transform.scale);
		const shouldInsert =
			!previousTracked ||
			isFirst ||
			isLast ||
			Math.abs(observation.transform.position.x - previousTracked.position.x) >=
				positionThresholdPx ||
			Math.abs(observation.transform.position.y - previousTracked.position.y) >=
				positionThresholdPx ||
			(animateScale &&
				Math.abs(nextScale - previousTracked.scale) >= scaleThreshold) ||
			observation.time - previousTracked.time >= forcedSpacingSeconds;
		if (!shouldInsert) continue;
		keyframes.push({
			id: generateUUID(),
			time: Math.max(0, observation.time + observationIndex * 1e-6),
			position: {
				x: observation.transform.position.x,
				y: observation.transform.position.y,
			},
			scale: nextScale,
		});
		previousTracked = keyframes[keyframes.length - 1] ?? null;
	}

	return keyframes;
}

function smoothTrackedTransformScales({
	trackedTransforms,
	animateScale,
	trackingStrength = DEFAULT_MOTION_TRACKING_STRENGTH,
}: {
	trackedTransforms: Array<
		SubjectTrackingObservation & {
			transform: ReturnType<typeof derivePresetTransform>;
		}
	>;
	animateScale: boolean;
	trackingStrength?: number;
}): Array<
	SubjectTrackingObservation & {
		transform: ReturnType<typeof derivePresetTransform>;
	}
> {
	if (!animateScale || trackedTransforms.length <= 1) {
		return trackedTransforms.map((entry) => ({
			...entry,
			transform: {
				...entry.transform,
			},
		}));
	}
	const normalizedStrength = normalizeMotionTrackingStrength(trackingStrength);
	const maxScaleStep = lerpMotionTrackingSetting(
		0.018,
		0.07,
		normalizedStrength,
	);
	const smoothing = lerpMotionTrackingSetting(0.08, 0.4, normalizedStrength);
	let previousScale = trackedTransforms[0]!.transform.scale;
	return trackedTransforms.map((entry, index) => {
		if (index === 0) {
			return {
				...entry,
				transform: {
					...entry.transform,
				},
			};
		}
		const targetScale = entry.transform.scale;
		const smoothedTarget =
			previousScale + (targetScale - previousScale) * smoothing;
		const nextScale = clamp(
			smoothedTarget,
			previousScale - maxScaleStep,
			previousScale + maxScaleStep,
		);
		previousScale = nextScale;
		return {
			...entry,
			transform: {
				...entry.transform,
				scale: nextScale,
			},
		};
	});
}

export function buildMotionTrackingKeyframesFromObservations({
	observations,
	canvasSize,
	sourceWidth,
	sourceHeight,
	baseScale,
	animateScale,
	trackingStrength = DEFAULT_MOTION_TRACKING_STRENGTH,
}: {
	observations: SubjectTrackingObservation[];
	canvasSize: { width: number; height: number };
	sourceWidth: number;
	sourceHeight: number;
	baseScale: number;
	animateScale: boolean;
	trackingStrength?: number;
}): {
	keyframes: MotionTrackingTransformKeyframe[];
	sampleCount: number;
	trackedSampleCount: number;
} {
	const normalizedStrength = normalizeMotionTrackingStrength(trackingStrength);
	const smoothedObservations = smoothTrackedObservations({
		observations,
		trackingStrength: normalizedStrength,
	});
	const trackedTransforms = smoothedObservations.flatMap((observation) => {
		if (!observation.box) return [];
		return [
			{
				...observation,
				transform: derivePresetTransform({
					box: observation.box,
					canvasSize,
					sourceWidth,
					sourceHeight,
					baseScale,
				}),
			},
		];
	});
	const smoothedTrackedTransforms = smoothTrackedTransformScales({
		trackedTransforms,
		animateScale,
		trackingStrength: normalizedStrength,
	});
	const coalescedKeyframes = coalesceMotionTrackingKeyframes({
		trackedTransforms: smoothedTrackedTransforms,
		animateScale,
		trackingStrength: normalizedStrength,
	});
	const anchoredKeyframes =
		coalescedKeyframes.length > 0 && coalescedKeyframes[0]!.time > 1e-6
			? [
					{
						...coalescedKeyframes[0]!,
						id: `${coalescedKeyframes[0]!.id}:start`,
						time: 0,
					},
					...coalescedKeyframes,
				]
			: coalescedKeyframes;
	return {
		keyframes: anchoredKeyframes.map((keyframe) => {
			const observation =
				smoothedTrackedTransforms.find(
					(entry) =>
						Math.abs(
							entry.time - (keyframe.time <= 1e-6 ? 0 : keyframe.time),
						) <= 1e-3,
				) ??
				smoothedTrackedTransforms[0] ??
				null;
			return {
				...keyframe,
				scale: animateScale
					? keyframe.scale
					: (smoothedTrackedTransforms[0]?.transform.scale ?? baseScale),
				subjectCenter: observation?.box
					? {
							x: observation.box.anchorX ?? observation.box.centerX,
							y: observation.box.anchorY ?? observation.box.centerY,
						}
					: undefined,
				subjectSize: observation?.box
					? {
							width: observation.box.fitWidth ?? observation.box.width,
							height: observation.box.fitHeight ?? observation.box.height,
						}
					: undefined,
			};
		}),
		sampleCount: observations.length,
		trackedSampleCount: smoothedTrackedTransforms.length,
	};
}

function buildSubjectBoxFromDetections(detections: SubjectBox[]): SubjectBox {
	return {
		centerX: median(detections.map((entry) => entry.centerX)),
		centerY: median(detections.map((entry) => entry.centerY)),
		width: median(detections.map((entry) => entry.width)),
		height: median(detections.map((entry) => entry.height)),
		anchorX: median(detections.map((entry) => entry.anchorX ?? entry.centerX)),
		anchorY: median(detections.map((entry) => entry.anchorY ?? entry.centerY)),
		fitWidth: median(detections.map((entry) => entry.fitWidth ?? entry.width)),
		fitHeight: median(
			detections.map((entry) => entry.fitHeight ?? entry.height),
		),
	};
}

function sortDetectionsLeftToRight(detections: SubjectBox[]): SubjectBox[] {
	return [...detections].sort((left, right) => left.centerX - right.centerX);
}

function buildHorizontalSubjectClusters({
	detections,
	sourceWidth,
}: {
	detections: SubjectBox[];
	sourceWidth: number;
}): SubjectBox[][] {
	if (detections.length === 0) return [];
	const sorted = sortDetectionsLeftToRight(detections);
	const clusters: SubjectBox[][] = [];
	const minClusterGap = Math.max(
		sourceWidth * 0.12,
		median(sorted.map((entry) => entry.width)) * 0.9,
	);

	for (const detection of sorted) {
		const lastCluster = clusters[clusters.length - 1];
		const lastCenter = lastCluster
			? median(lastCluster.map((entry) => entry.centerX))
			: null;
		if (
			lastCluster &&
			lastCenter !== null &&
			Math.abs(detection.centerX - lastCenter) <= minClusterGap
		) {
			lastCluster.push(detection);
			continue;
		}
		clusters.push([detection]);
	}

	return clusters
		.filter((cluster) => cluster.length > 0)
		.sort((left, right) => left[0]!.centerX - right[0]!.centerX);
}

function buildTwoSubjectClusters({
	detections,
	sourceWidth,
}: {
	detections: SubjectBox[];
	sourceWidth: number;
}): SubjectBox[][] {
	if (detections.length < 4) {
		return buildHorizontalSubjectClusters({ detections, sourceWidth });
	}

	const xs = detections.map((entry) => entry.centerX);
	const leftSeed = quantile(xs, 0.2);
	const rightSeed = quantile(xs, 0.8);
	let leftCenter = leftSeed;
	let rightCenter = rightSeed;

	for (let iteration = 0; iteration < 8; iteration++) {
		const leftCluster: SubjectBox[] = [];
		const rightCluster: SubjectBox[] = [];
		for (const detection of detections) {
			if (
				Math.abs(detection.centerX - leftCenter) <=
				Math.abs(detection.centerX - rightCenter)
			) {
				leftCluster.push(detection);
			} else {
				rightCluster.push(detection);
			}
		}
		if (leftCluster.length === 0 || rightCluster.length === 0) {
			break;
		}
		leftCenter = median(leftCluster.map((entry) => entry.centerX));
		rightCenter = median(rightCluster.map((entry) => entry.centerX));
	}

	const finalLeft: SubjectBox[] = [];
	const finalRight: SubjectBox[] = [];
	for (const detection of detections) {
		if (
			Math.abs(detection.centerX - leftCenter) <=
			Math.abs(detection.centerX - rightCenter)
		) {
			finalLeft.push(detection);
		} else {
			finalRight.push(detection);
		}
	}

	if (finalLeft.length === 0 || finalRight.length === 0) {
		return buildHorizontalSubjectClusters({ detections, sourceWidth });
	}

	const leftBox = buildSubjectBoxFromDetections(finalLeft);
	const rightBox = buildSubjectBoxFromDetections(finalRight);
	const separation = Math.abs(rightBox.centerX - leftBox.centerX);
	const medianWidth = median(detections.map((entry) => entry.width));
	const minObservationsPerCluster = Math.max(
		2,
		Math.floor(detections.length * 0.18),
	);
	if (
		separation < Math.max(sourceWidth * 0.14, medianWidth * 1.35) ||
		finalLeft.length < minObservationsPerCluster ||
		finalRight.length < minObservationsPerCluster
	) {
		return buildHorizontalSubjectClusters({ detections, sourceWidth });
	}

	return [finalLeft, finalRight].sort(
		(left, right) =>
			buildSubjectBoxFromDetections(left).centerX -
			buildSubjectBoxFromDetections(right).centerX,
	);
}

function filterCandidatesByIdentityCluster({
	candidates,
	clusters,
	targetIdentity,
}: {
	candidates: SubjectBox[];
	clusters: SubjectBox[][];
	targetIdentity: "left" | "right";
}): SubjectBox[] {
	if (candidates.length === 0 || clusters.length < 2) {
		return candidates;
	}
	const leftCenter = buildSubjectBoxFromDetections(clusters[0]!).centerX;
	const rightCenter = buildSubjectBoxFromDetections(
		clusters[clusters.length - 1]!,
	).centerX;
	const filtered = candidates.filter((candidate) => {
		const isLeftCluster =
			Math.abs(candidate.centerX - leftCenter) <=
			Math.abs(candidate.centerX - rightCenter);
		return targetIdentity === "left" ? isLeftCluster : !isLeftCluster;
	});
	return filtered.length > 0 ? filtered : candidates;
}

function getClusterCenterXs(clusters: SubjectBox[][]): {
	left: number;
	right: number;
} | null {
	if (clusters.length < 2) return null;
	return {
		left: buildSubjectBoxFromDetections(clusters[0]!).centerX,
		right: buildSubjectBoxFromDetections(clusters[clusters.length - 1]!)
			.centerX,
	};
}

function classifyBoxIdentity({
	box,
	clusters,
}: {
	box: SubjectBox;
	clusters: SubjectBox[][];
}): "left" | "right" | "subject" {
	const clusterCenters = getClusterCenterXs(clusters);
	if (!clusterCenters) return "subject";
	return Math.abs(box.centerX - clusterCenters.left) <=
		Math.abs(box.centerX - clusterCenters.right)
		? "left"
		: "right";
}

function getInitialSeedBoxForIdentity({
	observations,
	clusters,
	targetIdentity,
}: {
	observations: SubjectObservation[];
	clusters: SubjectBox[][];
	targetIdentity: "subject" | "left" | "right";
}): SubjectBox | null {
	const sortedObservations = [...observations].sort(
		(left, right) => left.time - right.time,
	);
	for (const observation of sortedObservations) {
		if (observation.boxes.length === 0) continue;
		if (targetIdentity === "subject") {
			return observation.boxes.length === 1
				? { ...observation.boxes[0]! }
				: buildSubjectBoxFromDetections(observation.boxes);
		}
		const matches = observation.boxes.filter(
			(box) => classifyBoxIdentity({ box, clusters }) === targetIdentity,
		);
		if (matches.length > 0) {
			const clusterCenters = getClusterCenterXs(clusters);
			if (!clusterCenters) {
				return { ...matches[0]! };
			}
			const targetCenter =
				targetIdentity === "left" ? clusterCenters.left : clusterCenters.right;
			return {
				...[...matches].sort(
					(left, right) =>
						Math.abs(left.centerX - targetCenter) -
						Math.abs(right.centerX - targetCenter),
				)[0]!,
			};
		}
	}
	return null;
}

function classifyObservationPresetName({
	observation,
	clusters,
}: {
	observation: SubjectObservation;
	clusters: SubjectBox[][];
}): AutoSectionKind | null {
	if (observation.boxes.length === 0) return null;
	if (clusters.length < 2) {
		return "Subject";
	}
	if (observation.boxes.length === 1) {
		return classifyBoxIdentity({
			box: observation.boxes[0]!,
			clusters,
		}) === "left"
			? "Subject Left"
			: "Subject Right";
	}
	if (observation.boxes.length >= 2) {
		let hasLeft = false;
		let hasRight = false;
		for (const box of observation.boxes) {
			if (classifyBoxIdentity({ box, clusters }) === "left") {
				hasLeft = true;
			} else {
				hasRight = true;
			}
		}
		if (hasLeft && hasRight) {
			return "Subject Left";
		}
	}

	return "Subject";
}

function smoothObservationStates(
	observations: Array<SubjectObservation & { presetName: AutoSectionKind }>,
) {
	if (observations.length < 3) return observations;
	const next = [...observations];
	for (let index = 1; index < next.length - 1; index++) {
		const previous = next[index - 1];
		const current = next[index];
		const following = next[index + 1];
		if (
			previous &&
			current &&
			following &&
			previous.presetName === following.presetName &&
			current.presetName !== previous.presetName
		) {
			next[index] = {
				...current,
				presetName: previous.presetName,
			};
		}
	}
	return next;
}

function buildAutoSectionSwitches({
	observations,
	presetIdByName,
}: {
	observations: SubjectObservation[];
	presetIdByName: Partial<Record<AutoSectionKind, string>>;
}): { defaultPresetId: string | null; switches: VideoReframeSwitch[] } {
	const classified = smoothObservationStates(
		observations
			.sort((left, right) => left.time - right.time)
			.map((observation) => ({
				...observation,
				presetName:
					(
						observation as SubjectObservation & {
							presetName?: AutoSectionKind;
						}
					).presetName ?? "Subject",
			}))
			.filter(
				(
					observation,
				): observation is SubjectObservation & {
					presetName: AutoSectionKind;
				} => Boolean(observation.presetName),
			),
	);
	if (classified.length === 0) {
		return {
			defaultPresetId: presetIdByName["Subject"] ?? null,
			switches: [],
		};
	}

	const minSectionSeconds = 0.85;
	const runs: Array<{
		presetName: AutoSectionKind;
		startTime: number;
		endTime: number;
	}> = [];
	for (let index = 0; index < classified.length; index++) {
		const observation = classified[index]!;
		const nextObservationTime =
			classified[index + 1]?.time ?? observation.time + minSectionSeconds;
		const lastRun = runs[runs.length - 1];
		if (!lastRun || lastRun.presetName !== observation.presetName) {
			runs.push({
				presetName: observation.presetName,
				startTime: observation.time,
				endTime: nextObservationTime,
			});
			continue;
		}
		lastRun.endTime = nextObservationTime;
	}

	const mergedRuns: typeof runs = [];
	const minOpeningSectionSeconds = 0.08;
	for (const run of runs) {
		const duration = Math.max(0, run.endTime - run.startTime);
		const previous = mergedRuns[mergedRuns.length - 1];
		const isOpeningRun =
			mergedRuns.length === 0 &&
			run.startTime <= 1 / 120 &&
			run.presetName === "Subject" &&
			duration >= minOpeningSectionSeconds;
		if (
			!isOpeningRun &&
			duration < minSectionSeconds &&
			previous &&
			previous.presetName !== run.presetName
		) {
			previous.endTime = run.endTime;
			continue;
		}
		mergedRuns.push({ ...run });
	}

	const defaultPresetId =
		presetIdByName[mergedRuns[0]?.presetName ?? "Subject"] ?? null;
	const switches = mergedRuns.slice(1).flatMap((run) => {
		const presetId = presetIdByName[run.presetName];
		if (!presetId) return [];
		return [
			{
				id: generateUUID(),
				time: run.startTime,
				presetId,
			},
		];
	});
	return { defaultPresetId, switches };
}

export function getVideoElementSourceRange({
	element,
	asset,
}: {
	element: Pick<VideoElement, "trimStart" | "trimEnd" | "duration">;
	asset?: Pick<MediaAsset, "duration"> | null;
}): { startTime: number; endTime: number } {
	const startTime = Math.max(0, element.trimStart);
	const inferredEndTime = startTime + Math.max(0.1, element.duration);
	const assetDuration =
		asset &&
		typeof asset.duration === "number" &&
		Number.isFinite(asset.duration)
			? asset.duration
			: null;
	const trimmedEndTime =
		assetDuration !== null
			? Math.max(startTime, assetDuration - Math.max(0, element.trimEnd))
			: inferredEndTime;
	return {
		startTime,
		endTime: Math.max(startTime + 0.1, trimmedEndTime),
	};
}

export function buildAutoReframePresetsFromDetections({
	detections,
	observations = [],
	canvasSize,
	sourceWidth,
	sourceHeight,
	baseScale,
}: {
	detections: SubjectBox[];
	observations?: SubjectObservation[];
	canvasSize: { width: number; height: number };
	sourceWidth: number;
	sourceHeight: number;
	baseScale: number;
}): {
	presets: VideoReframePreset[];
	switches: VideoReframeSwitch[];
	defaultPresetId: string | null;
	detectionCount: number;
	subjectClusterCount: number;
} {
	const subjectPreset = buildFallbackSubjectPreset({ baseScale });
	if (detections.length === 0) {
		return {
			presets: [subjectPreset],
			switches: [],
			defaultPresetId: subjectPreset.id,
			detectionCount: 0,
			subjectClusterCount: 0,
		};
	}

	const centerXs = detections.map((entry) => entry.centerX);
	const centerBox = buildSubjectBoxFromDetections(detections);
	const clusters = buildTwoSubjectClusters({
		detections,
		sourceWidth,
	});
	const initialSubjectBox =
		getInitialSeedBoxForIdentity({
			observations,
			clusters,
			targetIdentity: "subject",
		}) ?? centerBox;
	const presets: VideoReframePreset[] = [];
	let switches: VideoReframeSwitch[] = [];
	let defaultPresetId: string | null = null;

	if (clusters.length >= 2) {
		const leftClusterBox = buildSubjectBoxFromDetections(clusters[0]!);
		const rightClusterBox = buildSubjectBoxFromDetections(
			clusters[clusters.length - 1]!,
		);
		presets.push(
			buildVideoReframePreset({
				name: "Subject Left",
				autoSeeded: true,
				subjectSeed: buildSubjectSeed({
					box: leftClusterBox,
					identity: "left",
				}),
				transform: derivePresetTransform({
					box: leftClusterBox,
					canvasSize,
					sourceWidth,
					sourceHeight,
					baseScale,
					tightness: 0.36,
				}),
			}),
			buildVideoReframePreset({
				name: "Subject Right",
				autoSeeded: true,
				subjectSeed: buildSubjectSeed({
					box: rightClusterBox,
					identity: "right",
				}),
				transform: derivePresetTransform({
					box: rightClusterBox,
					canvasSize,
					sourceWidth,
					sourceHeight,
					baseScale,
					tightness: 0.36,
				}),
			}),
		);
		defaultPresetId = presets[0]?.id ?? null;
	} else {
		presets.push(
			buildVideoReframePreset({
				name: "Subject",
				autoSeeded: true,
				subjectSeed: buildSubjectSeed({
					box: initialSubjectBox,
					identity: "subject",
				}),
				transform: derivePresetTransform({
					box: initialSubjectBox,
					canvasSize,
					sourceWidth,
					sourceHeight,
					baseScale,
				}),
			}),
		);
		defaultPresetId = presets[0]?.id ?? null;
	}

	const dedupedPresets = dedupePresetNames(presets);
	const presetIdByName = Object.fromEntries(
		dedupedPresets.map((preset) => [preset.name as AutoSectionKind, preset.id]),
	) as Partial<Record<AutoSectionKind, string>>;
	const classifiedObservations = observations
		.map((observation) => {
			const presetName = classifyObservationPresetName({
				observation,
				clusters,
			});
			return presetName ? { ...observation, presetName } : null;
		})
		.filter(
			(
				observation,
			): observation is SubjectObservation & { presetName: AutoSectionKind } =>
				Boolean(observation),
		);
	const autoSections = buildAutoSectionSwitches({
		observations: classifiedObservations,
		presetIdByName,
	});
	const resolvedDefaultPresetId =
		autoSections.defaultPresetId ??
		dedupedPresets.find((preset) => preset.id === defaultPresetId)?.id ??
		dedupedPresets[0]?.id ??
		null;
	return {
		presets: dedupedPresets,
		switches:
			autoSections.switches.length > 0 ? autoSections.switches : switches,
		defaultPresetId: resolvedDefaultPresetId,
		detectionCount: detections.length,
		subjectClusterCount: clusters.length,
	};
}

export async function analyzeGeneratedClipReframes({
	asset,
	startTime,
	endTime,
	canvasSize,
	baseScale,
	signal,
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
	canvasSize: { width: number; height: number };
	baseScale: number;
	signal?: AbortSignal;
}): Promise<{
	presets: VideoReframePreset[];
	switches: VideoReframeSwitch[];
	defaultPresetId: string | null;
	detectionCount: number;
	subjectClusterCount: number;
}> {
	if (typeof document === "undefined" || asset.type !== "video") {
		const subject = buildFallbackSubjectPreset({ baseScale });
		return {
			presets: [subject],
			switches: [],
			defaultPresetId: subject.id,
			detectionCount: 0,
			subjectClusterCount: 0,
		};
	}

	const sourceWidth = asset.width ?? 0;
	const sourceHeight = asset.height ?? 0;
	if (sourceWidth <= 0 || sourceHeight <= 0) {
		const subject = buildFallbackSubjectPreset({ baseScale });
		return {
			presets: [subject],
			switches: [],
			defaultPresetId: subject.id,
			detectionCount: 0,
			subjectClusterCount: 0,
		};
	}

	const subjectPreset = buildFallbackSubjectPreset({ baseScale });

	try {
		throwIfAborted(signal);
		const [{ faceDetector, poseLandmarker }, { video, cleanup }] =
			await Promise.all([getVisionRuntime(), loadVideo({ asset, signal })]);
		try {
			const duration = Math.max(0.2, endTime - startTime);
			const detections: SubjectBox[] = [];
			const observations: SubjectObservation[] = [];
			const sampleTimes = buildObservationSampleTimes({
				startTime,
				duration,
			});

			for (const t of sampleTimes) {
				throwIfAborted(signal);
				await seekVideo({
					video,
					time: clamp(t, startTime, Math.max(startTime, endTime - 0.04)),
					signal,
				});
				await waitForVideoFrameReady({ video, signal });
				throwIfAborted(signal);
				if (!canAnalyzeCurrentVideoFrame({ video })) {
					continue;
				}
				const frameTimestampMs = Math.round(video.currentTime * 1000);
				try {
					const faceResult = withSuppressedVisionConsoleErrors(() =>
						faceDetector.detectForVideo(
							video,
							getMonotonicVisionTimestampMs({
								kind: "face",
								candidateMs: frameTimestampMs,
							}),
						),
					);
					const faceDetections = (faceResult.detections ?? [])
						.map((detection) => detection.boundingBox)
						.filter((box): box is NonNullable<typeof box> => Boolean(box));
					if (faceDetections.length > 0) {
						const boxes: SubjectBox[] = [];
						for (const faceBox of faceDetections) {
							const nextBox = {
								centerX: faceBox.originX + faceBox.width / 2,
								centerY: faceBox.originY + faceBox.height / 2,
								width: Math.max(1, faceBox.width * 2.4),
								height: Math.max(1, faceBox.height * 3.4),
								anchorX: faceBox.originX + faceBox.width / 2,
								anchorY: faceBox.originY + faceBox.height * 0.42,
								fitWidth: Math.max(1, faceBox.width * 1.35),
								fitHeight: Math.max(1, faceBox.height * 1.75),
							};
							detections.push(nextBox);
							boxes.push(nextBox);
						}
						observations.push({ time: Math.max(0, t - startTime), boxes });
						continue;
					}

					const poseResult = withSuppressedVisionConsoleErrors(() =>
						poseLandmarker.detectForVideo(
							video,
							getMonotonicVisionTimestampMs({
								kind: "pose",
								candidateMs: frameTimestampMs,
							}),
						),
					);
					const boxes: SubjectBox[] = [];
					for (const pose of poseResult.landmarks ?? []) {
						const poseBox = extractPoseBox({
							landmarks: pose,
							sourceWidth,
							sourceHeight,
						});
						if (poseBox) {
							detections.push(poseBox);
							boxes.push(poseBox);
						}
					}
					if (boxes.length > 0) {
						observations.push({ time: Math.max(0, t - startTime), boxes });
					}
				} catch (sampleError) {
					if (!isIgnorableVisionRuntimeMessage(sampleError)) {
						console.warn(
							"Subject-aware reframing skipped a sampled frame after detector failure.",
							sampleError,
						);
					}
				}
			}

			return buildAutoReframePresetsFromDetections({
				detections,
				observations,
				canvasSize,
				sourceWidth,
				sourceHeight,
				baseScale,
			});
		} finally {
			cleanup();
		}
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}
		if (!isIgnorableVisionRuntimeMessage(error)) {
			console.warn(
				"Subject-aware reframing failed; using centered subject fallback.",
				error,
			);
		}
		return {
			presets: [subjectPreset],
			switches: [],
			defaultPresetId: subjectPreset.id,
			detectionCount: 0,
			subjectClusterCount: 0,
		};
	}
}

export async function analyzeGeneratedClipMotionTracking({
	asset,
	startTime,
	endTime,
	canvasSize,
	baseScale,
	targetTransform,
	targetSubjectHint,
	targetSubjectSeed,
	animateScale = false,
	trackingStrength = DEFAULT_MOTION_TRACKING_STRENGTH,
	onProgress,
	signal,
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
	canvasSize: { width: number; height: number };
	baseScale: number;
	targetTransform?: VideoReframePresetTransform;
	targetSubjectHint?: TrackingSubjectHint | null;
	targetSubjectSeed?: VideoReframeSubjectSeed | null;
	animateScale?: boolean;
	trackingStrength?: number;
	onProgress?: (progress: {
		completedSamples: number;
		totalSamples: number;
		progress: number;
		message: string;
	}) => void;
	signal?: AbortSignal;
}): Promise<{
	keyframes: MotionTrackingTransformKeyframe[];
	sampleCount: number;
	trackedSampleCount: number;
	detectionCount: number;
}> {
	if (typeof document === "undefined" || asset.type !== "video") {
		return {
			keyframes: [],
			sampleCount: 0,
			trackedSampleCount: 0,
			detectionCount: 0,
		};
	}

	const sourceWidth = asset.width ?? 0;
	const sourceHeight = asset.height ?? 0;
	const targetCenterHint =
		targetTransform && sourceWidth > 0 && sourceHeight > 0
			? getSourceCenterForTransform({
					transform: targetTransform,
					canvasSize,
					sourceWidth,
					sourceHeight,
				})
			: null;
	const targetViewportBounds =
		targetTransform && sourceWidth > 0 && sourceHeight > 0
			? getSourceViewportBoundsForTransform({
					transform: targetTransform,
					canvasSize,
					sourceWidth,
					sourceHeight,
				})
			: null;
	if (sourceWidth <= 0 || sourceHeight <= 0) {
		return {
			keyframes: [],
			sampleCount: 0,
			trackedSampleCount: 0,
			detectionCount: 0,
		};
	}

	try {
		throwIfAborted(signal);
		const [{ faceDetector, poseLandmarker }, { video, cleanup }] =
			await Promise.all([getVisionRuntime(), loadVideo({ asset, signal })]);
		try {
			const duration = Math.max(0.2, endTime - startTime);
			const sampleTimes = buildMotionTrackingSampleTimes({
				startTime,
				duration,
			});
			onProgress?.({
				completedSamples: 0,
				totalSamples: sampleTimes.length,
				progress: sampleTimes.length === 0 ? 100 : 0,
				message: "Sampling motion tracking frames...",
			});
			const sampledFrames: Array<{
				time: number;
				faceCandidates: SubjectBox[];
				poseCandidates: SubjectBox[];
			}> = [];
			const identityDetections: SubjectBox[] = [];
			let detectionCount = 0;

			for (const sampledTime of sampleTimes) {
				throwIfAborted(signal);
				await seekVideo({
					video,
					time: clamp(
						sampledTime,
						startTime,
						Math.max(startTime, endTime - 0.04),
					),
					signal,
				});
				await waitForVideoFrameReady({ video, signal });
				throwIfAborted(signal);
				if (!canAnalyzeCurrentVideoFrame({ video })) {
					sampledFrames.push({
						time: Math.max(0, sampledTime - startTime),
						faceCandidates: [],
						poseCandidates: [],
					});
					continue;
				}

				const frameTimestampMs = Math.round(video.currentTime * 1000);
				let faceCandidates: SubjectBox[] = [];
				let poseCandidates: SubjectBox[] = [];
				try {
					const faceResult = withSuppressedVisionConsoleErrors(() =>
						faceDetector.detectForVideo(
							video,
							getMonotonicVisionTimestampMs({
								kind: "face",
								candidateMs: frameTimestampMs,
							}),
						),
					);
					faceCandidates = (faceResult.detections ?? [])
						.map((detection) => detection.boundingBox)
						.filter((box): box is NonNullable<typeof box> => Boolean(box))
						.map((faceBox) => ({
							centerX: faceBox.originX + faceBox.width / 2,
							centerY: faceBox.originY + faceBox.height / 2,
							width: Math.max(1, faceBox.width * 2.4),
							height: Math.max(1, faceBox.height * 3.4),
							anchorX: faceBox.originX + faceBox.width / 2,
							anchorY: faceBox.originY + faceBox.height * 0.42,
							fitWidth: Math.max(1, faceBox.width * 1.35),
							fitHeight: Math.max(1, faceBox.height * 1.75),
						}));
					if (faceCandidates.length > 0) {
						identityDetections.push(...faceCandidates);
					}
					if (faceCandidates.length === 0) {
						const poseResult = withSuppressedVisionConsoleErrors(() =>
							poseLandmarker.detectForVideo(
								video,
								getMonotonicVisionTimestampMs({
									kind: "pose",
									candidateMs: frameTimestampMs,
								}),
							),
						);
						poseCandidates = (poseResult.landmarks ?? []).flatMap((pose) => {
							const poseBox = extractPoseBox({
								landmarks: pose,
								sourceWidth,
								sourceHeight,
							});
							return poseBox ? [poseBox] : [];
						});
					}
				} catch (sampleError) {
					if (!isIgnorableVisionRuntimeMessage(sampleError)) {
						console.warn(
							"Subject motion tracking skipped a sampled frame after detector failure.",
							sampleError,
						);
					}
				}

				detectionCount += faceCandidates.length + poseCandidates.length;
				sampledFrames.push({
					time: Math.max(0, sampledTime - startTime),
					faceCandidates,
					poseCandidates,
				});
				onProgress?.({
					completedSamples: sampledFrames.length,
					totalSamples: sampleTimes.length,
					progress:
						sampleTimes.length === 0
							? 100
							: (sampledFrames.length / sampleTimes.length) * 100,
					message: `Tracking subject motion ${Math.min(
						100,
						Math.round(
							sampleTimes.length === 0
								? 100
								: (sampledFrames.length / sampleTimes.length) * 100,
						),
					)}%`,
				});
			}

			const observations: SubjectTrackingObservation[] = [];
			let previousTrackedBox: SubjectBox | null = null;
			const identityClusters =
				identityDetections.length >= 2
					? buildTwoSubjectClusters({
							detections: identityDetections,
							sourceWidth,
						})
					: [];
			const targetIdentity =
				targetSubjectSeed?.identity === "left" ||
				targetSubjectSeed?.identity === "right"
					? targetSubjectSeed.identity
					: targetSubjectHint === "left" || targetSubjectHint === "right"
						? targetSubjectHint
						: null;
			for (const frame of sampledFrames) {
				const clusteredFaceCandidates =
					targetIdentity && identityClusters.length >= 2
						? filterCandidatesByIdentityCluster({
								candidates: frame.faceCandidates,
								clusters: identityClusters,
								targetIdentity,
							})
						: frame.faceCandidates;
				const candidates =
					clusteredFaceCandidates.length > 0
						? clusteredFaceCandidates
						: previousTrackedBox
							? []
							: frame.poseCandidates;
				const trackedBox = choosePrimarySubjectBox({
					candidates,
					previousBox: previousTrackedBox,
					sourceWidth,
					sourceHeight,
					targetCenterHint,
					targetSubjectHint,
					targetViewportBounds,
					targetSubjectSeed,
				});
				observations.push({
					time: frame.time,
					box: trackedBox ? { ...trackedBox } : null,
				});
				previousTrackedBox = trackedBox ?? previousTrackedBox;
			}

			const result = buildMotionTrackingKeyframesFromObservations({
				observations,
				canvasSize,
				sourceWidth,
				sourceHeight,
				baseScale,
				animateScale,
				trackingStrength,
			});
			onProgress?.({
				completedSamples: sampleTimes.length,
				totalSamples: sampleTimes.length,
				progress: 100,
				message: "Baking tracking keyframes...",
			});
			return {
				keyframes: result.keyframes,
				sampleCount: result.sampleCount,
				trackedSampleCount: result.trackedSampleCount,
				detectionCount,
			};
		} finally {
			cleanup();
		}
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}
		if (!isIgnorableVisionRuntimeMessage(error)) {
			console.warn(
				"Subject motion tracking failed; leaving clip transform unchanged.",
				error,
			);
		}
		return {
			keyframes: [],
			sampleCount: 0,
			trackedSampleCount: 0,
			detectionCount: 0,
		};
	}
}
