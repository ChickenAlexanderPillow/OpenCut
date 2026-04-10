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
const FACE_LANDMARKER_MODEL_PATH =
	"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const POSE_MODEL_PATH =
	"https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const FACE_DETECTION_ANCHOR_Y_RATIO = 0.42;
const FACE_DETECTION_FIT_WIDTH_MULTIPLIER = 1.35;
const FACE_DETECTION_FIT_HEIGHT_MULTIPLIER = 1.75;
const MOTION_TRACKING_EYE_LINE_RATIO = 0.34;
const MOTION_TRACKING_TARGET_EYE_LINE_VIEWPORT_RATIO = 0.36;
const MOTION_TRACKING_TARGET_HEAD_VIEWPORT_RATIO = 0.4;
const MOTION_TRACKING_TARGET_FACE_WIDTH_VIEWPORT_RATIO = 0.24;
const MOTION_TRACKING_TARGET_FACE_HEIGHT_VIEWPORT_RATIO = 0.18;
const MIN_CONFIDENT_TRACKING_SCORE = 0.58;
const MIN_REACQUIRE_TRACKING_SCORE = 0.68;
const MIN_STRONG_TRACKING_SCORE = 0.8;
const REACQUIRE_STABLE_MATCH_COUNT = 2;

type SubjectBox = {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	anchorX?: number;
	anchorY?: number;
	fitWidth?: number;
	fitHeight?: number;
	trackingAnchorX?: number;
	trackingAnchorY?: number;
	trackingAnchorKind?: "eye" | "head";
	trackingSource?:
		| "eye"
		| "head-landmarks"
		| "head-detection"
		| "head-continuity"
		| "pose-head";
	trackingConfidence?: number;
};

type SubjectObservation = {
	time: number;
	boxes: SubjectBox[];
};

type SubjectTrackingObservation = {
	time: number;
	box: SubjectBox | null;
	lowConfidenceBox?: SubjectBox | null;
};

type MotionTrackingSample = {
	time: number;
	eyeX: number;
	eyeY: number;
	anchorKind: "eye" | "head";
	source:
		| "eye"
		| "head-landmarks"
		| "head-detection"
		| "head-continuity"
		| "pose-head";
	fitWidth: number;
	fitHeight: number;
};

type TrackingSelectionResult = {
	box: SubjectBox | null;
	lowConfidenceBox?: SubjectBox | null;
};

type AutoSectionKind = "Subject" | "Subject Left" | "Subject Right";
type TrackingSubjectHint = "left" | "right" | "center";
type SourceViewportBounds = {
	left: number;
	right: number;
	top: number;
	bottom: number;
};

type FaceDetectionLike = {
	boundingBox?: {
		originX: number;
		originY: number;
		width: number;
		height: number;
	};
	keypoints?: Array<{
		x: number;
		y: number;
		label?: string;
		score?: number;
	}>;
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

function getMedianOptional(values: Array<number | undefined>): number | undefined {
	const resolvedValues = values.filter((value): value is number =>
		Number.isFinite(value),
	);
	return resolvedValues.length > 0 ? median(resolvedValues) : undefined;
}

type VisionRuntime = Awaited<ReturnType<typeof loadVisionRuntime>>;
type FaceLandmarkerRuntime = Awaited<ReturnType<typeof loadFaceLandmarkerRuntime>>;

let runtimePromise: Promise<VisionRuntime> | null = null;
let faceLandmarkerPromise: Promise<FaceLandmarkerRuntime> | null = null;
let suppressedVisionConsoleErrorDepth = 0;
let restoreVisionConsoleError: (() => void) | null = null;
let lastFaceDetectorTimestampMs = 0;
let lastFaceLandmarkerTimestampMs = 0;
let lastPoseLandmarkerTimestampMs = 0;
let faceLandmarkIndexGroups:
	| {
			leftIris: number[];
			rightIris: number[];
			leftEye: number[];
			rightEye: number[];
	  }
	| null = null;
const DEFAULT_FACE_LANDMARK_INDEX_GROUPS = {
	leftIris: [468, 469, 470, 471, 472],
	rightIris: [473, 474, 475, 476, 477],
	leftEye: [] as number[],
	rightEye: [] as number[],
};

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
	kind: "face" | "face-landmarks" | "pose";
	candidateMs: number;
}): number {
	if (kind === "face") {
		lastFaceDetectorTimestampMs = Math.max(
			lastFaceDetectorTimestampMs + 1,
			Math.round(candidateMs),
		);
		return lastFaceDetectorTimestampMs;
	}
	if (kind === "face-landmarks") {
		lastFaceLandmarkerTimestampMs = Math.max(
			lastFaceLandmarkerTimestampMs + 1,
			Math.round(candidateMs),
		);
		return lastFaceLandmarkerTimestampMs;
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
				minDetectionConfidence: 0.3,
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

async function loadFaceLandmarkerRuntime() {
	return withSuppressedVisionConsoleErrorsAsync(async () => {
		const { FaceLandmarker, FilesetResolver } = await import(
			"@mediapipe/tasks-vision"
		);
		const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
		const uniqueConnectionIndices = (
			connections: Array<{ start: number; end: number }>,
		) =>
			[
				...new Set(connections.flatMap((connection) => [connection.start, connection.end])),
			].sort((left, right) => left - right);
		faceLandmarkIndexGroups = {
			leftIris: uniqueConnectionIndices(FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS),
			rightIris: uniqueConnectionIndices(
				FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
			),
			leftEye: uniqueConnectionIndices(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE),
			rightEye: uniqueConnectionIndices(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE),
		};
		const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
			baseOptions: {
				modelAssetPath: FACE_LANDMARKER_MODEL_PATH,
			},
			runningMode: "VIDEO",
			numFaces: 4,
			minFaceDetectionConfidence: 0.3,
			minFacePresenceConfidence: 0.3,
			minTrackingConfidence: 0.3,
			outputFaceBlendshapes: false,
			outputFacialTransformationMatrixes: false,
		}).catch((error) => {
			console.warn(
				"Face landmarker failed to initialize; motion tracking will fall back to face detection.",
				error,
			);
			faceLandmarkIndexGroups = null;
			return null;
		});
		return { faceLandmarker };
	});
}

async function getFaceLandmarkerRuntime(): Promise<FaceLandmarkerRuntime> {
	if (!faceLandmarkerPromise) {
		faceLandmarkerPromise = loadFaceLandmarkerRuntime();
	}
	return faceLandmarkerPromise;
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

function getTrackingConfidence(box: SubjectBox | null | undefined): number {
	return clamp(box?.trackingConfidence ?? 1, 0, 1);
}

function isLowConfidenceTrackingBox(
	box: SubjectBox | null | undefined,
	threshold = MIN_CONFIDENT_TRACKING_SCORE,
): boolean {
	return Boolean(box) && getTrackingConfidence(box) < threshold;
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
	const targetSamplesPerSecond = duration > 18 ? 4 : 5;
	const maxSamples = duration > 18 ? 108 : 120;
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

function getRepresentativeTrackingBox({
	faceCandidates,
	poseCandidates,
}: {
	faceCandidates: SubjectBox[];
	poseCandidates: SubjectBox[];
}): SubjectBox | null {
	if (faceCandidates.length > 0) {
		const confidentFaces = faceCandidates.filter(
			(candidate) => getTrackingConfidence(candidate) >= MIN_CONFIDENT_TRACKING_SCORE,
		);
		return buildSubjectBoxFromDetections(
			confidentFaces.length > 0 ? confidentFaces : faceCandidates,
		);
	}
	if (poseCandidates.length > 0) {
		return buildSubjectBoxFromDetections(poseCandidates);
	}
	return null;
}

function buildAdaptiveMotionTrackingRefinementTimes({
	sampledFrames,
	startTime,
	sourceWidth,
	sourceHeight,
}: {
	sampledFrames: Array<{
		time: number;
		faceCandidates: SubjectBox[];
		poseCandidates: SubjectBox[];
	}>;
	startTime: number;
	sourceWidth: number;
	sourceHeight: number;
}): number[] {
	const refinementTimes = new Set<number>();
	for (let index = 0; index < sampledFrames.length - 1; index++) {
		const left = sampledFrames[index];
		const right = sampledFrames[index + 1];
		if (!left || !right) continue;
		const gapSeconds = right.time - left.time;
		if (gapSeconds <= 0.14) continue;
		const leftBox = getRepresentativeTrackingBox(left);
		const rightBox = getRepresentativeTrackingBox(right);
		const leftConfidentFace = left.faceCandidates.some(
			(candidate) => getTrackingConfidence(candidate) >= MIN_STRONG_TRACKING_SCORE,
		);
		const rightConfidentFace = right.faceCandidates.some(
			(candidate) => getTrackingConfidence(candidate) >= MIN_STRONG_TRACKING_SCORE,
		);
		const countShift =
			left.faceCandidates.length !== right.faceCandidates.length ||
			left.poseCandidates.length !== right.poseCandidates.length;
		const missingOrWeak =
			!leftConfidentFace ||
			!rightConfidentFace ||
			!leftBox ||
			!rightBox ||
			isLowConfidenceTrackingBox(leftBox) ||
			isLowConfidenceTrackingBox(rightBox);
		const movementDistance =
			leftBox && rightBox ? getBoxDistance(leftBox, rightBox) : 0;
		const movementThreshold = Math.max(
			sourceWidth * 0.08,
			sourceHeight * 0.08,
			Math.max(
				leftBox?.fitWidth ?? leftBox?.width ?? 0,
				rightBox?.fitWidth ?? rightBox?.width ?? 0,
			) * 0.8,
		);
		const shouldRefine = missingOrWeak || countShift || movementDistance >= movementThreshold;
		if (!shouldRefine) continue;
		refinementTimes.add(startTime + left.time + gapSeconds / 2);
		if (gapSeconds >= 0.32 && (missingOrWeak || movementDistance >= movementThreshold * 1.4)) {
			refinementTimes.add(startTime + left.time + gapSeconds * 0.25);
			refinementTimes.add(startTime + left.time + gapSeconds * 0.75);
		}
	}
	return [...refinementTimes]
		.sort((left, right) => left - right)
		.filter((time, index, values) =>
			index === 0 || Math.abs(time - (values[index - 1] ?? 0)) > 1 / 240,
		);
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
	const getTrackingAnchorX = (box: SubjectBox) =>
		box.trackingAnchorX ?? box.anchorX ?? box.centerX;
	const getTrackingAnchorY = (box: SubjectBox) =>
		box.trackingAnchorY ?? box.anchorY ?? box.centerY;
	const pickTrackingAnchorKind = (
		preferred: SubjectBox,
		fallback: SubjectBox,
	): "eye" | "head" | undefined =>
		preferred.trackingAnchorKind ?? fallback.trackingAnchorKind;
	const pickTrackingSource = (
		preferred: SubjectBox,
		fallback: SubjectBox,
	):
		| "eye"
		| "head-landmarks"
		| "head-detection"
		| "head-continuity"
		| "pose-head"
		| undefined => preferred.trackingSource ?? fallback.trackingSource;

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
			trackingAnchorX:
				getTrackingAnchorX(previousForward) +
				(getTrackingAnchorX(currentBox) - getTrackingAnchorX(previousForward)) *
					positionBlend,
			trackingAnchorY:
				getTrackingAnchorY(previousForward) +
				(getTrackingAnchorY(currentBox) - getTrackingAnchorY(previousForward)) *
					positionBlend,
			trackingAnchorKind: pickTrackingAnchorKind(currentBox, previousForward),
			trackingSource: pickTrackingSource(currentBox, previousForward),
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
			trackingAnchorX:
				getTrackingAnchorX(previousBackward) +
				(getTrackingAnchorX(currentBox) -
					getTrackingAnchorX(previousBackward)) *
					positionBlend,
			trackingAnchorY:
				getTrackingAnchorY(previousBackward) +
				(getTrackingAnchorY(currentBox) -
					getTrackingAnchorY(previousBackward)) *
					positionBlend,
			trackingAnchorKind: pickTrackingAnchorKind(currentBox, previousBackward),
			trackingSource: pickTrackingSource(currentBox, previousBackward),
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
				trackingAnchorX:
					(getTrackingAnchorX(observation.box) +
						getTrackingAnchorX(pairedForward.box)) /
					2,
				trackingAnchorY:
					(getTrackingAnchorY(observation.box) +
						getTrackingAnchorY(pairedForward.box)) /
					2,
				trackingAnchorKind: pickTrackingAnchorKind(
					observation.box,
					pairedForward.box,
				),
				trackingSource: pickTrackingSource(
					observation.box,
					pairedForward.box,
				),
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

async function waitForAnalyzableVideoFrame({
	video,
	signal,
	maxAttempts = 4,
}: {
	video: HTMLVideoElement;
	signal?: AbortSignal;
	maxAttempts?: number;
}): Promise<boolean> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		await waitForVideoFrameReady({ video, signal });
		if (canAnalyzeCurrentVideoFrame({ video })) {
			return true;
		}
	}
	return false;
}

function getMotionTrackingAnchor(box: SubjectBox): {
	x: number;
	y: number;
	kind: "eye" | "head";
	source:
		| "eye"
		| "head-landmarks"
		| "head-detection"
		| "head-continuity"
		| "pose-head";
} {
	if (
		Number.isFinite(box.trackingAnchorX) &&
		Number.isFinite(box.trackingAnchorY)
	) {
		return {
			x: box.trackingAnchorX!,
			y: box.trackingAnchorY!,
			kind: box.trackingAnchorKind ?? "eye",
			source:
				box.trackingSource ??
				(box.trackingAnchorKind === "head" ? "head-landmarks" : "eye"),
		};
	}
	const anchorX = box.anchorX ?? box.centerX;
	const anchorY = box.anchorY ?? box.centerY;
	const inferredFaceHeight = Math.max(
		1,
		(box.fitHeight ?? box.height) / FACE_DETECTION_FIT_HEIGHT_MULTIPLIER,
	);
	return {
		x: anchorX,
		y:
			anchorY -
			inferredFaceHeight *
				(FACE_DETECTION_ANCHOR_Y_RATIO - MOTION_TRACKING_EYE_LINE_RATIO),
		kind: "eye",
		source: "eye",
	};
}

function getFaceDetectionHeadAnchor({
	faceBox,
}: {
	faceBox: { originX: number; originY: number; width: number; height: number };
}): { x: number; y: number } {
	return {
		x: faceBox.originX + faceBox.width / 2,
		y: faceBox.originY + faceBox.height * FACE_DETECTION_ANCHOR_Y_RATIO,
	};
}

export function getFaceDetectionEyeMidpoint({
	detection,
	sourceWidth,
	sourceHeight,
}: {
	detection: FaceDetectionLike;
	sourceWidth: number;
	sourceHeight: number;
}): { x: number; y: number; confidence: number } | null {
	const keypoints = (detection.keypoints ?? []).filter(
		(keypoint) =>
			Number.isFinite(keypoint.x) &&
			Number.isFinite(keypoint.y) &&
			keypoint.x >= 0 &&
			keypoint.x <= 1 &&
			keypoint.y >= 0 &&
			keypoint.y <= 1,
	);
	if (keypoints.length === 0) return null;
	const findKeypoint = (pattern: RegExp) =>
		keypoints.find((keypoint) => pattern.test(keypoint.label?.toLowerCase() ?? ""));
	const leftEye =
		findKeypoint(/left.*eye|eye.*left/) ??
		findKeypoint(/^left$/) ??
		keypoints[0];
	const rightEye =
		findKeypoint(/right.*eye|eye.*right/) ??
		findKeypoint(/^right$/) ??
		keypoints[1];
	if (!leftEye || !rightEye || leftEye === rightEye) return null;
	const averageScore =
		((leftEye.score ?? 0.55) + (rightEye.score ?? 0.55)) / 2;
	const eyeDistance = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);
	const eyeSeparationConfidence = clamp((eyeDistance - 0.02) / 0.12, 0, 1);
	return {
		x: ((leftEye.x + rightEye.x) / 2) * sourceWidth,
		y: ((leftEye.y + rightEye.y) / 2) * sourceHeight,
		confidence: clamp(averageScore * 0.7 + eyeSeparationConfidence * 0.3, 0, 1),
	};
}

function getAverageFaceLandmarkPoint({
	landmarks,
	indices,
}: {
	landmarks: Array<{ x: number; y: number }>;
	indices: number[];
}): { x: number; y: number } | null {
	const points = indices
		.map((index) => landmarks[index])
		.filter(
			(point): point is { x: number; y: number } =>
				Boolean(point) &&
				Number.isFinite(point.x) &&
				Number.isFinite(point.y) &&
				point.x >= 0 &&
				point.x <= 1 &&
				point.y >= 0 &&
				point.y <= 1,
		);
	if (points.length === 0) return null;
	return {
		x: median(points.map((point) => point.x)),
		y: median(points.map((point) => point.y)),
	};
}

export function getFaceLandmarkEyeMidpoint({
	landmarks,
	sourceWidth,
	sourceHeight,
}: {
	landmarks: Array<{ x: number; y: number }>;
	sourceWidth: number;
	sourceHeight: number;
}): { x: number; y: number } | null {
	const indexGroups =
		faceLandmarkIndexGroups ?? DEFAULT_FACE_LANDMARK_INDEX_GROUPS;
	const leftIris = getAverageFaceLandmarkPoint({
		landmarks,
		indices: indexGroups.leftIris,
	});
	const rightIris = getAverageFaceLandmarkPoint({
		landmarks,
		indices: indexGroups.rightIris,
	});
	const leftEye =
		leftIris ??
		getAverageFaceLandmarkPoint({
			landmarks,
			indices: indexGroups.leftEye,
		});
	const rightEye =
		rightIris ??
		getAverageFaceLandmarkPoint({
			landmarks,
			indices: indexGroups.rightEye,
		});
	if (!leftEye || !rightEye) return null;
	return {
		x: ((leftEye.x + rightEye.x) / 2) * sourceWidth,
		y: ((leftEye.y + rightEye.y) / 2) * sourceHeight,
	};
}

export function getFaceLandmarkTrackingAnchor({
	landmarks,
	sourceWidth,
	sourceHeight,
}: {
	landmarks: Array<{ x: number; y: number }>;
	sourceWidth: number;
	sourceHeight: number;
}): {
	x: number;
	y: number;
	kind: "eye" | "head";
	source: "eye" | "head-landmarks";
	confidence: number;
} | null {
	const eyeMidpoint = getFaceLandmarkEyeMidpoint({
		landmarks,
		sourceWidth,
		sourceHeight,
	});
	if (eyeMidpoint) {
		return {
			...eyeMidpoint,
			kind: "eye",
			source: "eye",
			confidence: 0.9,
		};
	}
	const validLandmarks = landmarks.filter(
		(landmark) =>
			Number.isFinite(landmark.x) &&
			Number.isFinite(landmark.y) &&
			landmark.x >= 0 &&
			landmark.x <= 1 &&
			landmark.y >= 0 &&
			landmark.y <= 1,
	);
	if (validLandmarks.length === 0) return null;
	const xs = validLandmarks.map((landmark) => landmark.x * sourceWidth);
	const ys = validLandmarks.map((landmark) => landmark.y * sourceHeight);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const rawHeight = Math.max(1, maxY - minY);
	return {
		x: (minX + maxX) / 2,
		y: minY + rawHeight * FACE_DETECTION_ANCHOR_Y_RATIO,
		kind: "head",
		source: "head-landmarks",
		confidence: clamp(validLandmarks.length / Math.max(1, landmarks.length, 200), 0.45, 0.82),
	};
}

function buildFaceCandidateFromDetection({
	detection,
	sourceWidth,
	sourceHeight,
}: {
	detection: FaceDetectionLike;
	sourceWidth: number;
	sourceHeight: number;
}): SubjectBox | null {
	const faceBox = detection.boundingBox;
	if (!faceBox) return null;
	const eyeMidpoint = getFaceDetectionEyeMidpoint({
		detection,
		sourceWidth,
		sourceHeight,
	});
	const headAnchor = getFaceDetectionHeadAnchor({ faceBox });
	const faceAspectRatioConfidence = clamp(faceBox.width / Math.max(1, faceBox.height), 0.35, 1.25);
	const normalizedAspectConfidence =
		faceAspectRatioConfidence <= 0.8
			? clamp((faceAspectRatioConfidence - 0.35) / 0.45, 0, 1)
			: clamp((1.25 - faceAspectRatioConfidence) / 0.45, 0, 1);
	const trackingConfidence = clamp(
		(eyeMidpoint?.confidence ?? 0.58) * 0.78 + normalizedAspectConfidence * 0.22,
		0,
		1,
	);
	const useEyeAnchor = Boolean(eyeMidpoint && trackingConfidence >= MIN_REACQUIRE_TRACKING_SCORE);
	const trackingAnchor = useEyeAnchor ? eyeMidpoint! : headAnchor;
	return {
		centerX: faceBox.originX + faceBox.width / 2,
		centerY: faceBox.originY + faceBox.height / 2,
		width: Math.max(1, faceBox.width * 2.4),
		height: Math.max(1, faceBox.height * 3.4),
		anchorX: faceBox.originX + faceBox.width / 2,
		anchorY:
			faceBox.originY + faceBox.height * FACE_DETECTION_ANCHOR_Y_RATIO,
		fitWidth: Math.max(
			1,
			faceBox.width * FACE_DETECTION_FIT_WIDTH_MULTIPLIER,
		),
		fitHeight: Math.max(
			1,
			faceBox.height * FACE_DETECTION_FIT_HEIGHT_MULTIPLIER,
		),
		trackingAnchorX: trackingAnchor.x,
		trackingAnchorY: trackingAnchor.y,
		trackingAnchorKind: useEyeAnchor ? "eye" : "head",
		trackingSource: useEyeAnchor ? "eye" : "head-detection",
		trackingConfidence,
	};
}

function buildFaceCandidateFromLandmarks({
	landmarks,
	sourceWidth,
	sourceHeight,
}: {
	landmarks: Array<{ x: number; y: number }>;
	sourceWidth: number;
	sourceHeight: number;
}): SubjectBox | null {
	const validLandmarks = landmarks.filter(
		(landmark) =>
			Number.isFinite(landmark.x) &&
			Number.isFinite(landmark.y) &&
			landmark.x >= 0 &&
			landmark.x <= 1 &&
			landmark.y >= 0 &&
			landmark.y <= 1,
	);
	if (validLandmarks.length === 0) return null;
	const xs = validLandmarks.map((landmark) => landmark.x * sourceWidth);
	const ys = validLandmarks.map((landmark) => landmark.y * sourceHeight);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const rawWidth = Math.max(1, maxX - minX);
	const rawHeight = Math.max(1, maxY - minY);
	const trackingAnchor = getFaceLandmarkTrackingAnchor({
		landmarks,
		sourceWidth,
		sourceHeight,
	});
	const validCoverage = clamp(validLandmarks.length / Math.max(1, landmarks.length), 0, 1);
	const aspectRatio = rawWidth / Math.max(1, rawHeight);
	const aspectConfidence =
		aspectRatio <= 0.9
			? clamp((aspectRatio - 0.3) / 0.6, 0, 1)
			: clamp((1.5 - aspectRatio) / 0.6, 0, 1);
	const trackingConfidence = clamp(
		(trackingAnchor?.confidence ?? 0.52) * 0.75 +
			validCoverage * 0.15 +
			aspectConfidence * 0.1,
		0,
		1,
	);
	const useTrackingAnchor =
		trackingAnchor && trackingConfidence >= MIN_CONFIDENT_TRACKING_SCORE;
	const anchorX = useTrackingAnchor ? trackingAnchor.x : (minX + maxX) / 2;
	const anchorY = useTrackingAnchor ? trackingAnchor.y : minY + rawHeight * 0.42;
	return {
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2,
		width: rawWidth * 1.25,
		height: rawHeight * 1.45,
		anchorX,
		anchorY,
		fitWidth: rawWidth,
		fitHeight: rawHeight,
		trackingAnchorX: useTrackingAnchor ? trackingAnchor.x : anchorX,
		trackingAnchorY: useTrackingAnchor ? trackingAnchor.y : anchorY,
		trackingAnchorKind: useTrackingAnchor ? trackingAnchor.kind : "head",
		trackingSource:
			useTrackingAnchor && trackingAnchor.source === "eye"
				? "eye"
				: "head-landmarks",
		trackingConfidence,
	};
}

function buildMotionTrackingSample(box: SubjectBox): MotionTrackingSample {
	const trackingAnchor = getMotionTrackingAnchor(box);
	return {
		time: 0,
		eyeX: trackingAnchor.x,
		eyeY: trackingAnchor.y,
		anchorKind: trackingAnchor.kind,
		source: trackingAnchor.source,
		fitWidth: Math.max(1, box.fitWidth ?? box.width),
		fitHeight: Math.max(1, box.fitHeight ?? box.height),
	};
}

function buildEffectiveMotionTrackingObservations({
	observations,
}: {
	observations: SubjectTrackingObservation[];
}): SubjectTrackingObservation[] {
	const effectiveObservations: SubjectTrackingObservation[] = [];
	let previousEffectiveBox: SubjectBox | null = null;
	for (const observation of observations) {
		if (observation.box) {
			const nextBox = {
				...observation.box,
			};
			effectiveObservations.push({
				time: observation.time,
				box: nextBox,
				lowConfidenceBox: observation.lowConfidenceBox ?? null,
			});
			previousEffectiveBox = nextBox;
			continue;
		}
		if (observation.lowConfidenceBox && previousEffectiveBox) {
			const lowConfidenceBox = observation.lowConfidenceBox;
			const confidence = getTrackingConfidence(lowConfidenceBox);
			const blend = clamp(0.18 + confidence * 0.34, 0.2, 0.44);
			const nextBox: SubjectBox = {
				...previousEffectiveBox,
				centerX:
					previousEffectiveBox.centerX +
					(lowConfidenceBox.centerX - previousEffectiveBox.centerX) * blend,
				centerY:
					previousEffectiveBox.centerY +
					(lowConfidenceBox.centerY - previousEffectiveBox.centerY) * blend,
				width:
					previousEffectiveBox.width +
					(lowConfidenceBox.width - previousEffectiveBox.width) * blend,
				height:
					previousEffectiveBox.height +
					(lowConfidenceBox.height - previousEffectiveBox.height) * blend,
				anchorX:
					(previousEffectiveBox.anchorX ?? previousEffectiveBox.centerX) +
					((lowConfidenceBox.anchorX ?? lowConfidenceBox.centerX) -
						(previousEffectiveBox.anchorX ?? previousEffectiveBox.centerX)) *
						blend,
				anchorY:
					(previousEffectiveBox.anchorY ?? previousEffectiveBox.centerY) +
					((lowConfidenceBox.anchorY ?? lowConfidenceBox.centerY) -
						(previousEffectiveBox.anchorY ?? previousEffectiveBox.centerY)) *
						blend,
				fitWidth:
					(previousEffectiveBox.fitWidth ?? previousEffectiveBox.width) +
					((lowConfidenceBox.fitWidth ?? lowConfidenceBox.width) -
						(previousEffectiveBox.fitWidth ?? previousEffectiveBox.width)) *
						blend,
				fitHeight:
					(previousEffectiveBox.fitHeight ?? previousEffectiveBox.height) +
					((lowConfidenceBox.fitHeight ?? lowConfidenceBox.height) -
						(previousEffectiveBox.fitHeight ?? previousEffectiveBox.height)) *
						blend,
				trackingAnchorX:
					(previousEffectiveBox.trackingAnchorX ??
						previousEffectiveBox.anchorX ??
						previousEffectiveBox.centerX) +
					((lowConfidenceBox.trackingAnchorX ??
						lowConfidenceBox.anchorX ??
						lowConfidenceBox.centerX) -
						(previousEffectiveBox.trackingAnchorX ??
							previousEffectiveBox.anchorX ??
							previousEffectiveBox.centerX)) *
						blend,
				trackingAnchorY:
					(previousEffectiveBox.trackingAnchorY ??
						previousEffectiveBox.anchorY ??
						previousEffectiveBox.centerY) +
					((lowConfidenceBox.trackingAnchorY ??
						lowConfidenceBox.anchorY ??
						lowConfidenceBox.centerY) -
						(previousEffectiveBox.trackingAnchorY ??
							previousEffectiveBox.anchorY ??
							previousEffectiveBox.centerY)) *
						blend,
				trackingAnchorKind:
					lowConfidenceBox.trackingAnchorKind ??
					previousEffectiveBox.trackingAnchorKind,
				trackingSource:
					previousEffectiveBox.trackingSource ?? lowConfidenceBox.trackingSource,
				trackingConfidence: Math.max(0.3, confidence),
			};
			effectiveObservations.push({
				time: observation.time,
				box: nextBox,
				lowConfidenceBox: lowConfidenceBox,
			});
			previousEffectiveBox = nextBox;
			continue;
		}
		effectiveObservations.push({
			time: observation.time,
			box: null,
			lowConfidenceBox: observation.lowConfidenceBox ?? null,
		});
		previousEffectiveBox = null;
	}
	return effectiveObservations;
}

function holdMotionTrackingSamples({
	observations,
	trackingStrength = DEFAULT_MOTION_TRACKING_STRENGTH,
}: {
	observations: SubjectTrackingObservation[];
	trackingStrength?: number;
}): MotionTrackingSample[] {
	if (observations.length === 0) return [];
	const normalizedStrength = normalizeMotionTrackingStrength(trackingStrength);
	const maxHoldSeconds = lerpMotionTrackingSetting(
		0.24,
		0.08,
		normalizedStrength,
	);
	const heldSamples: MotionTrackingSample[] = [];
	let previousTracked: MotionTrackingSample | null = null;
	for (const observation of observations) {
		if (observation.box) {
			const sample = {
				...buildMotionTrackingSample(observation.box),
				time: observation.time,
			};
			heldSamples.push(sample);
			previousTracked = sample;
			continue;
		}
		if (
			previousTracked &&
			observation.time - previousTracked.time <= maxHoldSeconds
		) {
			heldSamples.push({
				...previousTracked,
				time: observation.time,
			});
			continue;
		}
		previousTracked = null;
	}
	return heldSamples;
}

function medianFilterMotionTrackingSamples(
	samples: MotionTrackingSample[],
): MotionTrackingSample[] {
	if (samples.length <= 2) {
		return samples.map((sample) => ({
			...sample,
		}));
	}
	const getWindowValue = (
		values: number[],
		index: number,
		offset: -1 | 0 | 1,
	): number => {
		const resolvedIndex = clamp(index + offset, 0, values.length - 1);
		return values[resolvedIndex] ?? values[index] ?? 0;
	};
	const eyeXs = samples.map((entry) => entry.eyeX);
	const eyeYs = samples.map((entry) => entry.eyeY);
	const fitWidths = samples.map((entry) => entry.fitWidth);
	const fitHeights = samples.map((entry) => entry.fitHeight);
	return samples.map((sample, index) => {
		return {
			time: sample.time,
			eyeX: median([
				getWindowValue(eyeXs, index, -1),
				getWindowValue(eyeXs, index, 0),
				getWindowValue(eyeXs, index, 1),
			]),
			eyeY: median([
				getWindowValue(eyeYs, index, -1),
				getWindowValue(eyeYs, index, 0),
				getWindowValue(eyeYs, index, 1),
			]),
			fitWidth: median([
				getWindowValue(fitWidths, index, -1),
				getWindowValue(fitWidths, index, 0),
				getWindowValue(fitWidths, index, 1),
			]),
			fitHeight: median([
				getWindowValue(fitHeights, index, -1),
				getWindowValue(fitHeights, index, 0),
				getWindowValue(fitHeights, index, 1),
			]),
			anchorKind: sample.anchorKind,
			source: sample.source,
		};
	});
}

function buildMotionTrackingTransformFromSample({
	sample,
	canvasSize,
	sourceWidth,
	sourceHeight,
	baseScale,
	scaleOverride,
}: {
	sample: MotionTrackingSample;
	canvasSize: { width: number; height: number };
	sourceWidth: number;
	sourceHeight: number;
	baseScale: number;
	scaleOverride?: number;
}): VideoReframePresetTransform {
	const containScale = Math.min(
		canvasSize.width / sourceWidth,
		canvasSize.height / sourceHeight,
	);
	const desiredFaceWidthPx =
		canvasSize.width * MOTION_TRACKING_TARGET_FACE_WIDTH_VIEWPORT_RATIO;
	const desiredFaceHeightPx =
		canvasSize.height * MOTION_TRACKING_TARGET_FACE_HEIGHT_VIEWPORT_RATIO;
	const resolvedScale =
		scaleOverride ??
		clamp(
			Math.max(
				baseScale,
				desiredFaceWidthPx / Math.max(1, sample.fitWidth * containScale),
				desiredFaceHeightPx / Math.max(1, sample.fitHeight * containScale),
			),
			baseScale,
			baseScale * 3.2,
		);
	const visibleHalfWidthInSource =
		canvasSize.width / Math.max(1, containScale * resolvedScale * 2);
	const visibleHalfHeightInSource =
		canvasSize.height / Math.max(1, containScale * resolvedScale * 2);
	const targetAnchorViewportRatio =
		sample.anchorKind === "head"
			? MOTION_TRACKING_TARGET_HEAD_VIEWPORT_RATIO
			: MOTION_TRACKING_TARGET_EYE_LINE_VIEWPORT_RATIO;
	const anchorOffsetInSource =
		((0.5 - targetAnchorViewportRatio) * canvasSize.height) /
		Math.max(1, containScale * resolvedScale);
	const viewportCenterX = clamp(
		sample.eyeX,
		visibleHalfWidthInSource,
		Math.max(visibleHalfWidthInSource, sourceWidth - visibleHalfWidthInSource),
	);
	const viewportCenterY = clamp(
		sample.eyeY + anchorOffsetInSource,
		visibleHalfHeightInSource,
		Math.max(
			visibleHalfHeightInSource,
			sourceHeight - visibleHalfHeightInSource,
		),
	);
	return {
		position: {
			x: -((viewportCenterX - sourceWidth / 2) * containScale * resolvedScale),
			y: -((viewportCenterY - sourceHeight / 2) * containScale * resolvedScale),
		},
		scale: resolvedScale,
	};
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
	const poseHeadPoints = [0, 1, 2, 3, 4, 5, 6, 7, 8]
		.map((index) => landmarks[index])
		.filter(
			(entry): entry is { x: number; y: number } =>
				Boolean(entry) &&
				Number.isFinite(entry.x) &&
				Number.isFinite(entry.y),
		);
	const headAnchorX =
		poseHeadPoints.length > 0
			? median(poseHeadPoints.map((entry) => entry.x * sourceWidth))
			: (minX + maxX) / 2;
	const headAnchorY =
		poseHeadPoints.length > 0
			? median(poseHeadPoints.map((entry) => entry.y * sourceHeight))
			: minY + (maxY - minY) * 0.28;
	return {
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2,
		width: Math.max(1, (maxX - minX) * 1.2),
		height: Math.max(1, (maxY - minY) * 1.25),
		anchorX: headAnchorX,
		anchorY: headAnchorY,
		fitWidth: Math.max(1, (maxX - minX) * 0.78),
		fitHeight: Math.max(1, (maxY - minY) * 0.5),
		trackingAnchorX: headAnchorX,
		trackingAnchorY: headAnchorY,
		trackingAnchorKind: "head",
		trackingSource: "pose-head",
		trackingConfidence: 0.64,
	};
}

function isPlausiblePoseTrackingFallback({
	poseBox,
	previousBox,
	sourceWidth,
	sourceHeight,
}: {
	poseBox: SubjectBox;
	previousBox: SubjectBox;
	sourceWidth: number;
	sourceHeight: number;
}): boolean {
	const posePoint = getBoxReferencePoint(poseBox);
	const previousPoint = getBoxReferencePoint(previousBox);
	const maxHorizontalDistancePx = Math.max(
		sourceWidth * 0.08,
		(previousBox.fitWidth ?? previousBox.width) * 1.1,
	);
	const maxVerticalDistancePx = Math.max(
		sourceHeight * 0.1,
		(previousBox.fitHeight ?? previousBox.height) * 1.15,
	);
	return (
		Math.abs(posePoint.x - previousPoint.x) <= maxHorizontalDistancePx &&
		Math.abs(posePoint.y - previousPoint.y) <= maxVerticalDistancePx
	);
}

function buildPoseTrackingFallbackBox({
	poseBox,
	previousBox,
}: {
	poseBox: SubjectBox;
	previousBox: SubjectBox;
}): SubjectBox {
	const posePoint = getBoxReferencePoint(poseBox);
	const previousPoint = getBoxReferencePoint(previousBox);
	return {
		...previousBox,
		centerX: posePoint.x + (previousBox.centerX - previousPoint.x),
		centerY: posePoint.y + (previousBox.centerY - previousPoint.y),
		anchorX: posePoint.x,
		anchorY: posePoint.y,
		trackingAnchorX: posePoint.x,
		trackingAnchorY: posePoint.y,
		trackingAnchorKind: "head",
		trackingSource: "pose-head",
		trackingConfidence: Math.min(
			getTrackingConfidence(previousBox),
			getTrackingConfidence(poseBox),
		),
	};
}

function buildContinuityTrackingFallbackBox({
	previousBox,
}: {
	previousBox: SubjectBox;
}): SubjectBox {
	const previousPoint = getBoxReferencePoint(previousBox);
	return {
		...previousBox,
		anchorX: previousPoint.x,
		anchorY: previousPoint.y,
		trackingAnchorX: previousPoint.x,
		trackingAnchorY: previousPoint.y,
		trackingAnchorKind: "head",
		trackingSource: "head-continuity",
		trackingConfidence: Math.max(0.3, getTrackingConfidence(previousBox) * 0.7),
	};
}

const MOTION_TRACKING_SOURCE_PRIORITY: Record<
	NonNullable<SubjectBox["trackingSource"]>,
	number
> = {
	eye: 4,
	"head-landmarks": 3,
	"head-detection": 2,
	"pose-head": 1,
	"head-continuity": 0,
};

function getMotionTrackingSourcePriority(
	source: SubjectBox["trackingSource"] | MotionTrackingSample["source"] | undefined,
): number {
	return source ? (MOTION_TRACKING_SOURCE_PRIORITY[source] ?? 0) : 0;
}

function chooseMotionTrackingSubjectBox({
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
}): TrackingSelectionResult {
	if (candidates.length === 0) return { box: null };
	const shouldResetPreviousLock =
		Boolean(previousBox) &&
		!doesBoxMatchTrackingWindow({
			box: previousBox!,
			targetViewportBounds,
			targetSubjectSeed,
			sourceWidth,
			sourceHeight,
		}) &&
		candidates.some((candidate) =>
			doesBoxMatchTrackingWindow({
				box: candidate,
				targetViewportBounds,
				targetSubjectSeed,
				sourceWidth,
				sourceHeight,
			}),
		);
	const effectivePreviousBox = shouldResetPreviousLock ? null : previousBox;
	if (!effectivePreviousBox) {
		const maxSourcePriority = Math.max(
			...candidates.map((candidate) =>
				getMotionTrackingSourcePriority(candidate.trackingSource) *
					(0.35 + getTrackingConfidence(candidate) * 0.65),
			),
		);
		const prioritizedCandidates = candidates.filter(
			(candidate) =>
				getMotionTrackingSourcePriority(candidate.trackingSource) *
					(0.35 + getTrackingConfidence(candidate) * 0.65) >=
				maxSourcePriority,
		);
		const selectedBox = choosePrimarySubjectBox({
			candidates:
				prioritizedCandidates.length > 0 ? prioritizedCandidates : candidates,
			previousBox: null,
			sourceWidth,
			sourceHeight,
			targetCenterHint,
			targetSubjectHint,
			targetViewportBounds,
			targetSubjectSeed,
			allowCenterGrouping: false,
		});
		return isLowConfidenceTrackingBox(selectedBox)
			? { box: null, lowConfidenceBox: selectedBox }
			: { box: selectedBox };
	}
	const previousPoint = getBoxReferencePoint(effectivePreviousBox);
	const frameDiagonal = Math.max(1, Math.hypot(sourceWidth, sourceHeight));
	const maxHorizontalDistancePx = Math.max(
		sourceWidth * 0.18,
		(effectivePreviousBox.fitWidth ?? effectivePreviousBox.width) * 2.4,
	);
	const maxVerticalDistancePx = Math.max(
		sourceHeight * 0.22,
		(effectivePreviousBox.fitHeight ?? effectivePreviousBox.height) * 2.1,
	);
	const plausibleCandidates = candidates.filter((candidate) => {
		const point = getBoxReferencePoint(candidate);
		return (
			Math.abs(point.x - previousPoint.x) <= maxHorizontalDistancePx &&
			Math.abs(point.y - previousPoint.y) <= maxVerticalDistancePx
		);
	});
	const scoringPool =
		plausibleCandidates.length > 0 ? plausibleCandidates : candidates;
	const bestMatch = [...scoringPool]
		.map((candidate) => {
			const point = getBoxReferencePoint(candidate);
			const distance = Math.hypot(
				point.x - previousPoint.x,
				point.y - previousPoint.y,
			);
			const overlap = getBoxIoU(candidate, effectivePreviousBox);
			const areaScore =
				1 -
				Math.abs(getBoxArea(candidate) - getBoxArea(effectivePreviousBox)) /
					Math.max(getBoxArea(candidate), getBoxArea(effectivePreviousBox), 1);
			const sourcePriority = getMotionTrackingSourcePriority(
				candidate.trackingSource,
			);
			const confidence = getTrackingConfidence(candidate);
			return {
				candidate,
				score:
					sourcePriority * (2.2 + confidence * 1.8) +
					confidence * 2 +
					(1 - distance / frameDiagonal) * 3 +
					overlap * 1.5 +
					areaScore * 0.5,
				distance,
			};
		})
		.sort((left, right) => right.score - left.score)[0];
	if (!bestMatch) return { box: null };
	const allowFallbackDistancePx = Math.max(
		sourceWidth * 0.28,
		(effectivePreviousBox.fitWidth ?? effectivePreviousBox.width) * 4,
	);
	if (bestMatch.distance > allowFallbackDistancePx) {
		return { box: null };
	}
	if (isLowConfidenceTrackingBox(bestMatch.candidate)) {
		return {
			box: null,
			lowConfidenceBox: bestMatch.candidate,
		};
	}
	return { box: bestMatch.candidate };
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

function getBoxReferencePoint(box: SubjectBox): { x: number; y: number } {
	return {
		x: box.trackingAnchorX ?? box.anchorX ?? box.centerX,
		y: box.trackingAnchorY ?? box.anchorY ?? box.centerY,
	};
}

function getBoxDistance(left: SubjectBox, right: SubjectBox): number {
	const leftPoint = getBoxReferencePoint(left);
	const rightPoint = getBoxReferencePoint(right);
	return Math.hypot(leftPoint.x - rightPoint.x, leftPoint.y - rightPoint.y);
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

function isPointInsideViewportBounds({
	point,
	viewportBounds,
	marginX = 0,
	marginY = 0,
}: {
	point: { x: number; y: number };
	viewportBounds: SourceViewportBounds;
	marginX?: number;
	marginY?: number;
}): boolean {
	return (
		point.x >= viewportBounds.left - marginX &&
		point.x <= viewportBounds.right + marginX &&
		point.y >= viewportBounds.top - marginY &&
		point.y <= viewportBounds.bottom + marginY
	);
}

function doesBoxMatchTrackingWindow({
	box,
	targetViewportBounds,
	targetSubjectSeed,
	sourceWidth,
	sourceHeight,
}: {
	box: SubjectBox;
	targetViewportBounds?: SourceViewportBounds | null;
	targetSubjectSeed?: VideoReframeSubjectSeed | null;
	sourceWidth: number;
	sourceHeight: number;
}): boolean {
	const referencePoint = getBoxReferencePoint(box);
	const matchesViewport = targetViewportBounds
		? (() => {
				const viewportWidth = Math.max(
					1,
					targetViewportBounds.right - targetViewportBounds.left,
				);
				const viewportHeight = Math.max(
					1,
					targetViewportBounds.bottom - targetViewportBounds.top,
				);
				return (
					getBoxOverlapWithViewport(box, targetViewportBounds) >= 0.08 ||
					isPointInsideViewportBounds({
						point: referencePoint,
						viewportBounds: targetViewportBounds,
						marginX: viewportWidth * 0.06,
						marginY: viewportHeight * 0.08,
					})
				);
		  })()
		: false;
	const matchesSeed = targetSubjectSeed
		? (() => {
				const comparableWidth = box.fitWidth ?? box.width;
				const comparableHeight = box.fitHeight ?? box.height;
				const maxSeedDistanceX = Math.max(
					sourceWidth * 0.09,
					targetSubjectSeed.size?.width ?? 0,
					comparableWidth * 0.9,
				);
				const maxSeedDistanceY = Math.max(
					sourceHeight * 0.12,
					targetSubjectSeed.size?.height ?? 0,
					comparableHeight * 0.9,
				);
				return (
					Math.abs(referencePoint.x - targetSubjectSeed.center.x) <=
						maxSeedDistanceX &&
					Math.abs(referencePoint.y - targetSubjectSeed.center.y) <=
						maxSeedDistanceY
				);
		  })()
		: false;
	if (targetViewportBounds && targetSubjectSeed) {
		return matchesViewport || matchesSeed;
	}
	if (targetViewportBounds) return matchesViewport;
	if (targetSubjectSeed) return matchesSeed;
	return true;
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
	allowCenterGrouping = true,
}: {
	candidates: SubjectBox[];
	previousBox: SubjectBox | null;
	sourceWidth: number;
	sourceHeight: number;
	targetCenterHint?: { x: number; y: number } | null;
	targetSubjectHint?: TrackingSubjectHint | null;
	targetViewportBounds?: SourceViewportBounds | null;
	targetSubjectSeed?: VideoReframeSubjectSeed | null;
	allowCenterGrouping?: boolean;
}): SubjectBox | null {
	if (candidates.length === 0) return null;
	if (allowCenterGrouping && targetSubjectHint === "center" && candidates.length > 1) {
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
			const referencePoint = getBoxReferencePoint(candidate);
			const confidence = getTrackingConfidence(candidate);
			const centerPenalty =
				Math.hypot(
					referencePoint.x - frameCenterX,
					referencePoint.y - frameCenterY,
				) / Math.max(1, Math.hypot(frameCenterX, frameCenterY));
			const viewportOverlap = targetViewportBounds
				? getBoxOverlapWithViewport(candidate, targetViewportBounds)
				: 0;
			const seedDistancePenalty = targetSubjectSeed
				? Math.hypot(
						referencePoint.x - targetSubjectSeed.center.x,
						referencePoint.y - targetSubjectSeed.center.y,
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
					? 1 - referencePoint.x / Math.max(1, sourceWidth)
					: targetSubjectHint === "right"
						? referencePoint.x / Math.max(1, sourceWidth)
						: 0;
			const score =
				getBoxArea(candidate) *
					(1 +
						confidence * 0.55 +
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
					const leftPoint = getBoxReferencePoint(left.candidate);
					const rightPoint = getBoxReferencePoint(right.candidate);
					if (
						Math.abs(leftPoint.x - rightPoint.x) > 1e-3
					) {
						return leftPoint.x - rightPoint.x;
					}
					return right.score - left.score;
				})[0]?.candidate ?? null
			);
		}
		if (targetSubjectHint === "right") {
			return (
				[...viableInitialCandidates].sort((left, right) => {
					const leftPoint = getBoxReferencePoint(left.candidate);
					const rightPoint = getBoxReferencePoint(right.candidate);
					if (
						Math.abs(leftPoint.x - rightPoint.x) > 1e-3
					) {
						return rightPoint.x - leftPoint.x;
					}
					return right.score - left.score;
				})[0]?.candidate ?? null
			);
		}
		return [...scoredInitialCandidates].sort((left, right) => {
			const leftPoint = getBoxReferencePoint(left.candidate);
			const rightPoint = getBoxReferencePoint(right.candidate);
			const leftCenterPenalty =
				Math.hypot(
					leftPoint.x - frameCenterX,
					leftPoint.y - frameCenterY,
				) / Math.max(1, Math.hypot(frameCenterX, frameCenterY));
			const rightCenterPenalty =
				Math.hypot(
					rightPoint.x - frameCenterX,
					rightPoint.y - frameCenterY,
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
		const confidenceScore = getTrackingConfidence(candidate) * 2;
		const areaScore =
			1 -
			Math.abs(getBoxArea(candidate) - getBoxArea(previousBox)) /
				Math.max(getBoxArea(candidate), getBoxArea(previousBox), 1);
		return {
			candidate,
			score: overlapScore + distanceScore + areaScore + confidenceScore,
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
	const previousPoint = getBoxReferencePoint(previousBox);
	const bestPoint = getBoxReferencePoint(bestMatch.candidate);
	const bestHorizontalDistance = Math.abs(
		bestPoint.x - previousPoint.x,
	);
	const bestVerticalDistance = Math.abs(
		bestPoint.y - previousPoint.y,
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
	debugSamples: Array<{
		time: number;
		source:
			| "eye"
			| "head-landmarks"
			| "head-detection"
			| "head-continuity"
			| "pose-head"
			| "low-confidence"
			| "miss";
		subjectCenter?: { x: number; y: number };
		subjectSize?: { width: number; height: number };
	}>;
} {
	const effectiveObservations = buildEffectiveMotionTrackingObservations({
		observations,
	});
	const heldSamples = holdMotionTrackingSamples({
		observations: effectiveObservations,
		trackingStrength,
	});
	const smoothedSamples = medianFilterMotionTrackingSamples(heldSamples);
	const startupSettledSamples = (() => {
		if (smoothedSamples.length <= 1) return smoothedSamples;
		const firstSample = smoothedSamples[0]!;
		const firstPriority = getMotionTrackingSourcePriority(firstSample.source);
		if (firstPriority >= 3) return smoothedSamples;
		const warmupUpgradeIndex = smoothedSamples.findIndex(
			(sample, index) =>
				index > 0 &&
				sample.time <= 0.45 &&
				getMotionTrackingSourcePriority(sample.source) >= 3,
		);
		if (warmupUpgradeIndex <= 0) return smoothedSamples;
		const upgradedStart = {
			...smoothedSamples[warmupUpgradeIndex]!,
			time: 0,
		};
		return [upgradedStart, ...smoothedSamples.slice(warmupUpgradeIndex)];
	})();
	const debugSamples =
		startupSettledSamples.length > 0
			? startupSettledSamples.map((sample) => ({
					time: sample.time,
					source: sample.source,
					subjectCenter: {
						x: sample.eyeX,
						y: sample.eyeY,
					},
					subjectSize: {
						width: sample.fitWidth,
						height: sample.fitHeight,
					},
			  }))
			: observations.map((observation) => {
					if (!observation.box && observation.lowConfidenceBox) {
						const sample = buildMotionTrackingSample(observation.lowConfidenceBox);
						return {
							time: observation.time,
							source: "low-confidence" as const,
							subjectCenter: {
								x: sample.eyeX,
								y: sample.eyeY,
							},
							subjectSize: {
								width: sample.fitWidth,
								height: sample.fitHeight,
							},
						};
					}
					if (!observation.box) {
						return {
							time: observation.time,
							source: "miss" as const,
						};
					}
					const sample = buildMotionTrackingSample(observation.box);
					return {
						time: observation.time,
						source: sample.source,
						subjectCenter: {
							x: sample.eyeX,
							y: sample.eyeY,
						},
						subjectSize: {
							width: sample.fitWidth,
							height: sample.fitHeight,
						},
					};
			  });
	const lockedScale =
		!animateScale && startupSettledSamples.length > 0
			? buildMotionTrackingTransformFromSample({
					sample: startupSettledSamples[0]!,
					canvasSize,
					sourceWidth,
					sourceHeight,
					baseScale,
				}).scale
			: undefined;
	const denseKeyframes = startupSettledSamples.map((sample, observationIndex) => {
		const transform = buildMotionTrackingTransformFromSample({
			sample,
			canvasSize,
			sourceWidth,
			sourceHeight,
			baseScale,
			scaleOverride: lockedScale,
		});
		return {
		id: generateUUID(),
		time: Math.max(0, sample.time + observationIndex * 1e-6),
		position: {
			x: transform.position.x,
			y: transform.position.y,
		},
		scale: animateScale ? transform.scale : (lockedScale ?? baseScale),
		subjectCenter: {
			x: sample.eyeX,
			y: sample.eyeY,
		},
		subjectSize: {
			width: sample.fitWidth,
			height: sample.fitHeight,
		},
		trackingSource: sample.source,
	};
	});
	const anchoredKeyframes =
		denseKeyframes.length > 0 && denseKeyframes[0]!.time > 1e-6
			? [
					{
						...denseKeyframes[0]!,
						id: `${denseKeyframes[0]!.id}:start`,
						time: 0,
					},
					...denseKeyframes,
				]
			: denseKeyframes;
	return {
		keyframes: anchoredKeyframes.map((keyframe) => ({
			...keyframe,
			scale: animateScale ? keyframe.scale : (lockedScale ?? baseScale),
		})),
		sampleCount: observations.length,
		trackedSampleCount: startupSettledSamples.length,
		debugSamples,
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
		trackingAnchorX: getMedianOptional(
			detections.map((entry) => entry.trackingAnchorX),
		),
		trackingAnchorY: getMedianOptional(
			detections.map((entry) => entry.trackingAnchorY),
		),
		trackingConfidence: median(
			detections.map((entry) => getTrackingConfidence(entry)),
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

export function filterCandidatesByIdentityCluster({
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
		const referencePoint = getBoxReferencePoint(candidate);
		const isLeftCluster =
			Math.abs(referencePoint.x - leftCenter) <=
			Math.abs(referencePoint.x - rightCenter);
		return targetIdentity === "left" ? isLeftCluster : !isLeftCluster;
	});
	return filtered;
}

export function buildMotionTrackingObservationsFromSampledFrames({
	sampledFrames,
	identityDetections,
	sourceWidth,
	sourceHeight,
	targetCenterHint,
	targetSubjectHint,
	targetViewportBounds,
	targetSubjectSeed,
}: {
	sampledFrames: Array<{
		time: number;
		faceCandidates: SubjectBox[];
		poseCandidates: SubjectBox[];
	}>;
	identityDetections: SubjectBox[];
	sourceWidth: number;
	sourceHeight: number;
	targetCenterHint?: { x: number; y: number } | null;
	targetSubjectHint?: TrackingSubjectHint | null;
	targetViewportBounds?: SourceViewportBounds | null;
	targetSubjectSeed?: VideoReframeSubjectSeed | null;
}): SubjectTrackingObservation[] {
	const observations: SubjectTrackingObservation[] = [];
	let previousTrackedBox: SubjectBox | null = null;
	let lastConcreteTrackedTime: number | null = null;
	let reacquireCandidateBox: SubjectBox | null = null;
	let reacquireCandidateCount = 0;
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
	const requireFaceLockedTracking =
		Boolean(targetSubjectSeed) || targetIdentity !== null;
	const continuityHoldSeconds = 0.42;
	for (const frame of sampledFrames) {
		const clusteredFaceCandidates =
			targetIdentity && identityClusters.length >= 2
				? filterCandidatesByIdentityCluster({
						candidates: frame.faceCandidates,
						clusters: identityClusters,
						targetIdentity,
					})
				: frame.faceCandidates;
		const clusteredPoseCandidates =
			targetIdentity && identityClusters.length >= 2
				? filterCandidatesByIdentityCluster({
						candidates: frame.poseCandidates,
						clusters: identityClusters,
						targetIdentity,
					})
				: frame.poseCandidates;
		const previousTrackedForFallback = previousTrackedBox;
		const poseFallbackCandidates =
			previousTrackedForFallback
				? clusteredPoseCandidates
						.filter((candidate) =>
							isPlausiblePoseTrackingFallback({
								poseBox: candidate,
								previousBox: previousTrackedForFallback,
								sourceWidth,
								sourceHeight,
							}),
						)
						.map((candidate) =>
							buildPoseTrackingFallbackBox({
								poseBox: candidate,
								previousBox: previousTrackedForFallback,
							}),
						)
				: [];
		const candidates =
			clusteredFaceCandidates.length > 0 || poseFallbackCandidates.length > 0
				? [...clusteredFaceCandidates, ...poseFallbackCandidates]
				: requireFaceLockedTracking || previousTrackedBox
					? []
					: frame.poseCandidates;
		const selection = chooseMotionTrackingSubjectBox({
			candidates,
			previousBox: previousTrackedBox,
			sourceWidth,
			sourceHeight,
			targetCenterHint,
			targetSubjectHint,
			targetViewportBounds,
			targetSubjectSeed,
		});
		let trackedBox = selection.box;
		let lowConfidenceBox = selection.lowConfidenceBox ?? null;
		const requiresReacquireHysteresis =
			previousTrackedBox &&
			lastConcreteTrackedTime !== null &&
			frame.time - lastConcreteTrackedTime > 1 / 120;
		const shouldUseReacquireHysteresis =
			requiresReacquireHysteresis &&
			trackedBox?.trackingSource !== "pose-head" &&
			trackedBox?.trackingSource !== "head-detection";
		if (trackedBox) {
			if (
				shouldUseReacquireHysteresis &&
				getTrackingConfidence(trackedBox) < MIN_REACQUIRE_TRACKING_SCORE
			) {
				lowConfidenceBox = trackedBox;
				trackedBox = null;
			} else if (shouldUseReacquireHysteresis) {
				const matchesPendingCandidate: boolean = Boolean(
					reacquireCandidateBox &&
						getBoxDistance(reacquireCandidateBox, trackedBox) <=
						Math.max(
							sourceWidth * 0.04,
							sourceHeight * 0.04,
							(trackedBox.fitWidth ?? trackedBox.width) * 0.45,
						),
				);
				reacquireCandidateBox = matchesPendingCandidate ? trackedBox : trackedBox;
				reacquireCandidateCount = matchesPendingCandidate
					? reacquireCandidateCount + 1
					: 1;
				if (reacquireCandidateCount < REACQUIRE_STABLE_MATCH_COUNT) {
					lowConfidenceBox = trackedBox;
					trackedBox = null;
				}
			} else {
				reacquireCandidateBox = null;
				reacquireCandidateCount = 0;
			}
		} else if (lowConfidenceBox) {
			reacquireCandidateBox = null;
			reacquireCandidateCount = 0;
		} else if (!trackedBox) {
			reacquireCandidateBox = null;
			reacquireCandidateCount = 0;
		}
		if (
			!trackedBox &&
			previousTrackedBox &&
			lastConcreteTrackedTime !== null &&
			frame.time - lastConcreteTrackedTime <= continuityHoldSeconds
		) {
			trackedBox = buildContinuityTrackingFallbackBox({
				previousBox: previousTrackedBox,
			});
		}
		observations.push({
			time: frame.time,
			box: trackedBox ? { ...trackedBox } : null,
			lowConfidenceBox: lowConfidenceBox ? { ...lowConfidenceBox } : null,
		});
		previousTrackedBox = trackedBox;
		if (trackedBox && trackedBox.trackingSource !== "head-continuity") {
			lastConcreteTrackedTime = frame.time;
			reacquireCandidateBox = null;
			reacquireCandidateCount = 0;
		}
	}
	return observations;
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
	const referencePoint = getBoxReferencePoint(box);
	return Math.abs(referencePoint.x - clusterCenters.left) <=
		Math.abs(referencePoint.x - clusterCenters.right)
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
		const [
			{ faceDetector, poseLandmarker },
			{ faceLandmarker },
			{ video, cleanup },
		] = await Promise.all([
			getVisionRuntime(),
			getFaceLandmarkerRuntime(),
			loadVideo({ asset, signal }),
		]);
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
						.map((detection) =>
							buildFaceCandidateFromDetection({
								detection,
								sourceWidth,
								sourceHeight,
							}),
						)
						.filter((box): box is SubjectBox => Boolean(box));
					if (faceDetections.length > 0) {
						const boxes: SubjectBox[] = [];
						for (const nextBox of faceDetections) {
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
	debugSamples: Array<{
		time: number;
		source:
			| "eye"
			| "head-landmarks"
			| "head-detection"
			| "head-continuity"
			| "pose-head"
			| "low-confidence"
			| "miss";
		subjectCenter?: { x: number; y: number };
		subjectSize?: { width: number; height: number };
	}>;
}> {
	if (typeof document === "undefined" || asset.type !== "video") {
		return {
			keyframes: [],
			sampleCount: 0,
			trackedSampleCount: 0,
			detectionCount: 0,
			debugSamples: [],
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
			debugSamples: [],
		};
	}

	try {
		throwIfAborted(signal);
		const [
			{ faceDetector, poseLandmarker },
			{ faceLandmarker },
			{ video, cleanup },
		] = await Promise.all([
			getVisionRuntime(),
			getFaceLandmarkerRuntime(),
			loadVideo({ asset, signal }),
		]);
		try {
			const duration = Math.max(0.2, endTime - startTime);
			const sampleTimes = buildMotionTrackingSampleTimes({
				startTime,
				duration,
			});
			const sampledFrames: Array<{
				time: number;
				faceCandidates: SubjectBox[];
				poseCandidates: SubjectBox[];
			}> = [];
			const identityDetections: SubjectBox[] = [];
			let detectionCount = 0;
			let completedSamples = 0;
			let totalSamples = sampleTimes.length;
			let consecutiveStableFaceFrames = 0;
			const analyzedTimes = new Set<string>();
			const pushProgress = ({
				message,
			}: {
				message: string;
			}) => {
				onProgress?.({
					completedSamples,
					totalSamples,
					progress: totalSamples === 0 ? 100 : (completedSamples / totalSamples) * 100,
					message,
				});
			};
			const recordSampledFrame = ({
				time,
				faceCandidates,
				poseCandidates,
			}: {
				time: number;
				faceCandidates: SubjectBox[];
				poseCandidates: SubjectBox[];
			}) => {
				sampledFrames.push({ time, faceCandidates, poseCandidates });
				detectionCount += faceCandidates.length + poseCandidates.length;
				if (faceCandidates.length > 0) {
					identityDetections.push(...faceCandidates);
				}
			};
			const analyzeSampleAtTime = async ({
				sampledTime,
				message,
			}: {
				sampledTime: number;
				message: string;
			}) => {
				const dedupeKey = sampledTime.toFixed(4);
				if (analyzedTimes.has(dedupeKey)) {
					return;
				}
				analyzedTimes.add(dedupeKey);
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
				const canAnalyzeFrame = await waitForAnalyzableVideoFrame({
					video,
					signal,
				});
				throwIfAborted(signal);
				if (!canAnalyzeFrame) {
					consecutiveStableFaceFrames = 0;
					recordSampledFrame({
						time: Math.max(0, sampledTime - startTime),
						faceCandidates: [],
						poseCandidates: [],
					});
					completedSamples += 1;
					pushProgress({ message });
					return;
				}

				const frameTimestampMs = Math.round(video.currentTime * 1000);
				let faceCandidates: SubjectBox[] = [];
				let poseCandidates: SubjectBox[] = [];
				try {
					faceCandidates = faceLandmarker
						? (withSuppressedVisionConsoleErrors(() =>
								faceLandmarker.detectForVideo(
									video,
									getMonotonicVisionTimestampMs({
										kind: "face-landmarks",
										candidateMs: frameTimestampMs,
									}),
								),
							).faceLandmarks ?? [])
								.map((landmarks: Array<{ x: number; y: number }>) =>
									buildFaceCandidateFromLandmarks({
										landmarks,
										sourceWidth,
										sourceHeight,
									}),
								)
								.filter((box: SubjectBox | null): box is SubjectBox => Boolean(box))
						: [];
					const hasConfidentLandmarkCandidate = faceCandidates.some(
						(candidate) =>
							getTrackingConfidence(candidate) >= MIN_CONFIDENT_TRACKING_SCORE,
					);
					if (!hasConfidentLandmarkCandidate) {
						const faceResult = withSuppressedVisionConsoleErrors(() =>
							faceDetector.detectForVideo(
								video,
								getMonotonicVisionTimestampMs({
									kind: "face",
									candidateMs: frameTimestampMs,
								}),
							),
						);
						const detectorFaceCandidates = (faceResult.detections ?? [])
							.map((detection) =>
								buildFaceCandidateFromDetection({
									detection,
									sourceWidth,
									sourceHeight,
								}),
							)
							.filter((box): box is SubjectBox => Boolean(box));
						faceCandidates = [...faceCandidates, ...detectorFaceCandidates];
					}
					const hasStrongFaceCandidate = faceCandidates.some(
						(candidate) =>
							getTrackingConfidence(candidate) >= MIN_STRONG_TRACKING_SCORE,
					);
					const shouldSamplePose =
						!hasStrongFaceCandidate || consecutiveStableFaceFrames < 2;
					if (shouldSamplePose) {
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
					consecutiveStableFaceFrames =
						hasStrongFaceCandidate && poseCandidates.length === 0
							? consecutiveStableFaceFrames + 1
							: 0;
				} catch (sampleError) {
					consecutiveStableFaceFrames = 0;
					if (!isIgnorableVisionRuntimeMessage(sampleError)) {
						console.warn(
							"Subject motion tracking skipped a sampled frame after detector failure.",
							sampleError,
						);
					}
				}

				recordSampledFrame({
					time: Math.max(0, sampledTime - startTime),
					faceCandidates,
					poseCandidates,
				});
				completedSamples += 1;
				pushProgress({ message });
			};

			pushProgress({ message: "Sampling motion tracking frames..." });
			for (const sampledTime of sampleTimes) {
				await analyzeSampleAtTime({
					sampledTime,
					message: `Tracking subject motion ${Math.min(
						100,
						Math.round(totalSamples === 0 ? 100 : (completedSamples / totalSamples) * 100),
					)}%`,
				});
			}

			const refinementTimes = buildAdaptiveMotionTrackingRefinementTimes({
				sampledFrames,
				startTime,
				sourceWidth,
				sourceHeight,
			}).filter((time) => !analyzedTimes.has(time.toFixed(4)));
			if (refinementTimes.length > 0) {
				totalSamples += refinementTimes.length;
				pushProgress({ message: "Refining unstable tracking intervals..." });
				for (const sampledTime of refinementTimes) {
					await analyzeSampleAtTime({
						sampledTime,
						message: "Refining unstable tracking intervals...",
					});
				}
			}
			sampledFrames.sort((left, right) => left.time - right.time);

			const observations = buildMotionTrackingObservationsFromSampledFrames({
				sampledFrames,
				identityDetections,
				sourceWidth,
				sourceHeight,
				targetCenterHint,
				targetSubjectHint,
				targetViewportBounds,
				targetSubjectSeed,
			});

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
				completedSamples: totalSamples,
				totalSamples,
				progress: 100,
				message: "Baking tracking keyframes...",
			});
			return {
				keyframes: result.keyframes,
				sampleCount: result.sampleCount,
				trackedSampleCount: result.trackedSampleCount,
				detectionCount,
				debugSamples: result.debugSamples,
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
			debugSamples: [],
		};
	}
}
