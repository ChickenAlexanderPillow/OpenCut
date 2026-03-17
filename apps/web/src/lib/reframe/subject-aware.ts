import type { MediaAsset } from "@/types/assets";
import type {
	VideoElement,
	VideoReframePreset,
	VideoReframeSwitch,
} from "@/types/timeline";
import { generateUUID } from "@/utils/id";
import { buildVideoReframePreset } from "./video-reframe";

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
};

type SubjectObservation = {
	time: number;
	boxes: SubjectBox[];
};

type AutoSectionKind = "Subject" | "Subject Left" | "Subject Right";

type VisionRuntime = Awaited<ReturnType<typeof loadVisionRuntime>>;

let runtimePromise: Promise<VisionRuntime> | null = null;

async function loadVisionRuntime() {
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
}

async function getVisionRuntime(): Promise<VisionRuntime> {
	if (!runtimePromise) {
		runtimePromise = loadVisionRuntime();
	}
	return runtimePromise;
}

async function loadVideo({
	asset,
}: {
	asset: MediaAsset;
}): Promise<{ video: HTMLVideoElement; cleanup: () => void }> {
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
		const cleanupListeners = () => {
			video.removeEventListener("loadedmetadata", onLoaded);
			video.removeEventListener("error", onError);
		};
		video.addEventListener("loadedmetadata", onLoaded);
		video.addEventListener("error", onError);
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
}: {
	video: HTMLVideoElement;
	time: number;
}) {
	await new Promise<void>((resolve, reject) => {
		const onSeeked = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error("Failed to seek video for subject-aware reframing"));
		};
		const cleanup = () => {
			video.removeEventListener("seeked", onSeeked);
			video.removeEventListener("error", onError);
		};
		video.addEventListener("seeked", onSeeked);
		video.addEventListener("error", onError);
		video.currentTime = Math.max(0, time);
	});
}

async function waitForVideoFrameReady({
	video,
}: {
	video: HTMLVideoElement;
}) {
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
			const cleanup = () => {
				clearTimeout(timeout);
				video.removeEventListener("loadeddata", onReady);
				video.removeEventListener("canplay", onReady);
				video.removeEventListener("timeupdate", onReady);
				video.removeEventListener("error", onError);
			};
			video.addEventListener("loadeddata", onReady);
			video.addEventListener("canplay", onReady);
			video.addEventListener("timeupdate", onReady);
			video.addEventListener("error", onError);
			onReady();
		});
	}

	if ("requestVideoFrameCallback" in video) {
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				resolve();
			};
			const timeout = setTimeout(finish, 250);
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

	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function canAnalyzeCurrentVideoFrame({
	video,
}: {
	video: HTMLVideoElement;
}) {
	return (
		Number.isFinite(video.currentTime) &&
		!video.seeking &&
		video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
		video.videoWidth > 0 &&
		video.videoHeight > 0
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
	const uniformTimes = Array.from({ length: sampleCount }, (_, index) =>
		startTime + (duration * index) / Math.max(1, sampleCount - 1),
	);
	return [...earlyOffsets, ...uniformTimes]
		.sort((left, right) => left - right)
		.filter((time, index, values) => {
			if (time < startTime || time > endTime) return false;
			return index === 0 || Math.abs(time - (values[index - 1] ?? 0)) > 1 / 120;
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

function clampSubjectCenterX({
	centerX,
	sourceWidth,
	boxWidth,
}: {
	centerX: number;
	sourceWidth: number;
	boxWidth: number;
}) {
	const safeHalfWidth = Math.max(1, boxWidth / 2);
	return clamp(
		centerX,
		safeHalfWidth,
		Math.max(safeHalfWidth, sourceWidth - safeHalfWidth),
	);
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
		box.centerX,
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

function buildSubjectBoxFromDetections(detections: SubjectBox[]): SubjectBox {
	return {
		centerX: median(detections.map((entry) => entry.centerX)),
		centerY: median(detections.map((entry) => entry.centerY)),
		width: median(detections.map((entry) => entry.width)),
		height: median(detections.map((entry) => entry.height)),
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

function classifyObservationPresetName({
	observation,
	clusters,
}: {
	observation: SubjectObservation;
	clusters: SubjectBox[][];
}): AutoSectionKind | null {
	if (observation.boxes.length === 0) return null;
	if (observation.boxes.length === 1) {
		return "Subject";
	}
	if (clusters.length < 2) {
		return "Subject";
	}
	if (observation.boxes.length >= 2) {
		let hasLeft = false;
		let hasRight = false;
		const leftCenter = buildSubjectBoxFromDetections(clusters[0]!).centerX;
		const rightCenter = buildSubjectBoxFromDetections(
			clusters[clusters.length - 1]!,
		).centerX;
		for (const box of observation.boxes) {
			if (
				Math.abs(box.centerX - leftCenter) <=
				Math.abs(box.centerX - rightCenter)
			) {
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
					(observation as SubjectObservation & {
						presetName?: AutoSectionKind;
					}).presetName ?? "Subject",
			}))
			.filter(
				(
					observation,
				): observation is SubjectObservation & { presetName: AutoSectionKind } =>
					Boolean(observation.presetName),
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

	const defaultPresetId = presetIdByName[mergedRuns[0]?.presetName ?? "Subject"] ?? null;
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
	const presets: VideoReframePreset[] = [
		buildVideoReframePreset({
			name: "Subject",
			autoSeeded: true,
			transform: derivePresetTransform({
				box: centerBox,
				canvasSize,
				sourceWidth,
				sourceHeight,
				baseScale,
			}),
		}),
	];
	let switches: VideoReframeSwitch[] = [];
	let defaultPresetId = presets[0]?.id ?? null;

	if (clusters.length >= 2) {
		const edgeBias = Math.max(sourceWidth * 0.02, centerBox.width * 0.12);
		const leftClusterBox = buildSubjectBoxFromDetections(clusters[0]!);
		const rightClusterBox = buildSubjectBoxFromDetections(
			clusters[clusters.length - 1]!,
		);
		const leftBox: SubjectBox = {
			...leftClusterBox,
			centerX: clampSubjectCenterX({
				centerX: leftClusterBox.centerX - edgeBias,
				sourceWidth,
				boxWidth: leftClusterBox.width,
			}),
		};
		const rightBox: SubjectBox = {
			...rightClusterBox,
			centerX: clampSubjectCenterX({
				centerX: rightClusterBox.centerX + edgeBias,
				sourceWidth,
				boxWidth: rightClusterBox.width,
			}),
		};
		presets.push(
			buildVideoReframePreset({
				name: "Subject Left",
				autoSeeded: true,
				transform: derivePresetTransform({
					box: leftBox,
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
				transform: derivePresetTransform({
					box: rightBox,
					canvasSize,
					sourceWidth,
					sourceHeight,
					baseScale,
					tightness: 0.36,
				}),
			}),
		);

		const defaultPreset = presets.find((preset) => preset.name === "Subject");
		const subjectLeftPreset = presets.find(
			(preset) => preset.name === "Subject Left",
		);
		if (subjectLeftPreset) {
			const leftClusterCenterX = leftClusterBox.centerX;
			const rightClusterCenterX = rightClusterBox.centerX;
			const multiSubjectObservation = observations.find((observation) => {
				if (observation.boxes.length < 2) return false;
				let hasLeft = false;
				let hasRight = false;
				for (const box of observation.boxes) {
					if (
						Math.abs(box.centerX - leftClusterCenterX) <=
						Math.abs(box.centerX - rightClusterCenterX)
					) {
						hasLeft = true;
					} else {
						hasRight = true;
					}
				}
				return hasLeft && hasRight;
			});

			if (multiSubjectObservation) {
				if (multiSubjectObservation.time <= 0.05) {
					defaultPresetId = subjectLeftPreset.id;
				} else if (defaultPreset) {
					defaultPresetId = defaultPreset.id;
					switches = [
						{
							id: generateUUID(),
							time: multiSubjectObservation.time,
							presetId: subjectLeftPreset.id,
						},
					];
				}
			}
		}
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
		switches: autoSections.switches.length > 0 ? autoSections.switches : switches,
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
}: {
	asset: MediaAsset;
	startTime: number;
	endTime: number;
	canvasSize: { width: number; height: number };
	baseScale: number;
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
		const [{ faceDetector, poseLandmarker }, { video, cleanup }] =
			await Promise.all([getVisionRuntime(), loadVideo({ asset })]);
		try {
			const duration = Math.max(0.2, endTime - startTime);
			const detections: SubjectBox[] = [];
			const observations: SubjectObservation[] = [];
			const sampleTimes = buildObservationSampleTimes({
				startTime,
				duration,
			});

			for (const t of sampleTimes) {
				await seekVideo({
					video,
					time: clamp(t, startTime, Math.max(startTime, endTime - 0.04)),
				});
				await waitForVideoFrameReady({ video });
				if (!canAnalyzeCurrentVideoFrame({ video })) {
					continue;
				}
				const timestampMs = Math.round(video.currentTime * 1000);
				try {
					const faceResult = faceDetector.detectForVideo(video, timestampMs);
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
							};
							detections.push(nextBox);
							boxes.push(nextBox);
						}
						observations.push({ time: Math.max(0, t - startTime), boxes });
						continue;
					}

					const poseResult = poseLandmarker.detectForVideo(video, timestampMs);
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
					console.warn(
						"Subject-aware reframing skipped a sampled frame after detector failure.",
						sampleError,
					);
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
		console.warn(
			"Subject-aware reframing failed; using centered subject fallback.",
			error,
		);
		return {
			presets: [subjectPreset],
			switches: [],
			defaultPresetId: subjectPreset.id,
			detectionCount: 0,
			subjectClusterCount: 0,
		};
	}
}
