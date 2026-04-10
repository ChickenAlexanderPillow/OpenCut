"use client";

import { useMemo } from "react";
import { useEditor } from "@/hooks/use-editor";
import {
	applySelectedReframePresetPreviewToTracks,
	getActiveReframePresetId,
	getReframePresetById,
	normalizeVideoReframeState,
	resolveVideoSplitScreenAtTime,
} from "@/lib/reframe/video-reframe";
import { resolveMotionTrackedSubjectFrame } from "@/lib/reframe/motion-tracking";
import { snapTimeToFrame } from "@/lib/time";
import { useReframeStore } from "@/stores/reframe-store";
import type { VideoElement, VideoReframePreset } from "@/types/timeline";

const MAX_PATH_POINTS = 120;

type RawDebugSeries = {
	id: string;
	label: string;
	color: string;
	path: Array<{
		x: number;
		y: number;
		source:
			| "eye"
			| "head-landmarks"
			| "head-detection"
			| "head-continuity"
			| "pose-head"
			| "low-confidence"
			| "miss";
	}>;
	current:
		| {
				x: number;
				y: number;
				source?:
					| "eye"
					| "head-landmarks"
					| "head-detection"
					| "head-continuity"
					| "pose-head"
					| "low-confidence"
					| "miss";
		  }
		| null;
};

function sampleKeyframes<T>(values: T[]): T[] {
	if (values.length <= MAX_PATH_POINTS) return values;
	const step = Math.max(1, Math.ceil(values.length / MAX_PATH_POINTS));
	return values.filter(
		(_, index) => index === 0 || index === values.length - 1 || index % step === 0,
	);
}

function getSeriesStyle({
	preset,
	slotId,
}: {
	preset: VideoReframePreset;
	slotId?: string;
}): { color: string; label: string } {
	const normalizedName = preset.name.trim().toLowerCase();
	const slotSuffix = slotId ? ` (${slotId})` : "";
	if (normalizedName.includes("left")) {
		return { color: "#38bdf8", label: `${preset.name}${slotSuffix}` };
	}
	if (normalizedName.includes("right")) {
		return { color: "#f472b6", label: `${preset.name}${slotSuffix}` };
	}
	return { color: "#fbbf24", label: `${preset.name}${slotSuffix}` };
}

function buildRawPresetDebugSeries({
	preset,
	localTime,
	slotId,
}: {
	preset: VideoReframePreset;
	localTime: number;
	slotId?: string;
}): RawDebugSeries | null {
	const debugSamples = sampleKeyframes(preset.motionTracking?.debugSamples ?? []);
	const fallbackPath = sampleKeyframes(
		(preset.motionTracking?.keyframes ?? []).filter(
			(keyframe) => keyframe.subjectCenter !== undefined,
		),
	);
	if (debugSamples.length === 0 && fallbackPath.length === 0) return null;
	const style = getSeriesStyle({ preset, slotId });
	const currentSubjectFrame = resolveMotionTrackedSubjectFrame({
		motionTracking: preset.motionTracking,
		localTime,
	});
	const currentSampleSource =
		(preset.motionTracking?.debugSamples ?? [])
			.reduce<{
				timeDelta: number;
				source:
					| "eye"
					| "head-landmarks"
					| "head-detection"
					| "head-continuity"
					| "pose-head"
					| "low-confidence"
					| "miss";
			} | null>((closest, sample) => {
				const timeDelta = Math.abs(sample.time - localTime);
				if (!closest || timeDelta < closest.timeDelta) {
					return {
						timeDelta,
						source: sample.source,
					};
				}
				return closest;
			}, null)
			?.source ?? undefined;
	return {
		id: slotId ? `${preset.id}:${slotId}` : preset.id,
		label: style.label,
		color: style.color,
		path:
			debugSamples.length > 0
				? debugSamples.map((sample) => ({
						x: sample.subjectCenter?.x ?? Number.NaN,
						y: sample.subjectCenter?.y ?? Number.NaN,
						source: sample.source,
					}))
				: fallbackPath.map((keyframe) => ({
						x: keyframe.subjectCenter?.x ?? Number.NaN,
						y: keyframe.subjectCenter?.y ?? Number.NaN,
						source: keyframe.trackingSource ?? "eye",
					})),
		current: currentSubjectFrame?.center
			? {
					x: currentSubjectFrame.center.x,
					y: currentSubjectFrame.center.y,
					source: currentSampleSource,
				}
			: null,
	};
}

function getSampleSourceColor(
	source:
		| "eye"
		| "head-landmarks"
		| "head-detection"
		| "head-continuity"
		| "pose-head"
		| "low-confidence"
		| "miss",
): string {
	switch (source) {
		case "eye":
			return "#38bdf8";
		case "head-landmarks":
			return "#fbbf24";
		case "head-detection":
			return "#c084fc";
		case "head-continuity":
			return "#ffffff";
		case "pose-head":
			return "#34d399";
		case "low-confidence":
			return "#fb7185";
		case "miss":
			return "#f87171";
	}
}

function getSampleSourceLabel(
	source:
		| "eye"
		| "head-landmarks"
		| "head-detection"
		| "head-continuity"
		| "pose-head"
		| "low-confidence"
		| "miss",
): string {
	switch (source) {
		case "eye":
			return "Eye";
		case "head-landmarks":
			return "Head LM";
		case "head-detection":
			return "Head Det";
		case "head-continuity":
			return "Head Hold";
		case "pose-head":
			return "Pose Head";
		case "low-confidence":
			return "Low Conf";
		case "miss":
			return "Miss";
	}
}

export function MotionTrackingDebugOverlay() {
	const editor = useEditor({
		subscribeTo: ["timeline", "selection", "media", "playback"],
	});
	const selectedPresetIdByElementId = useReframeStore(
		(state) => state.selectedPresetIdByElementId,
	);
	const selectedSplitPreviewByElementId = useReframeStore(
		(state) => state.selectedSplitPreviewByElementId,
	);
	const isPlaying = editor.playback.getIsPlaying();
	const playbackTime = editor.playback.getCurrentTime();
	const tracks = editor.timeline.getTracks();
	const selectedElements = editor.selection.getSelectedElements();
	const mediaAssets = editor.media.getAssets();
	const projectFps = Math.max(1, editor.project.getActive().settings.fps);

	const debugData = useMemo(() => {
		const selectedElementIds = new Set(
			selectedElements.map((selection) => selection.elementId),
		);
		const previewTracks = applySelectedReframePresetPreviewToTracks({
			tracks,
			selectedPresetIdByElementId: !isPlaying ? selectedPresetIdByElementId : {},
			selectedSplitPreviewByElementId: !isPlaying
				? selectedSplitPreviewByElementId
				: {},
			selectedElementIds,
		});
		const selectedVideo = previewTracks
			.flatMap((track) =>
				track.type === "video"
					? track.elements.filter(
							(element) =>
								element.type === "video" && selectedElementIds.has(element.id),
						)
					: [],
			)
			.find((element): element is VideoElement => element.type === "video");
		if (!selectedVideo) return null;

		const normalizedElement = normalizeVideoReframeState({ element: selectedVideo });
		const sourceAsset = mediaAssets.find(
			(asset) => asset.id === normalizedElement.mediaId,
		);
		const sourceWidth = sourceAsset?.width ?? 0;
		const sourceHeight = sourceAsset?.height ?? 0;
		if (sourceWidth <= 0 || sourceHeight <= 0) return null;

		const localTime = snapTimeToFrame({
			time: Math.max(
				0,
				Math.min(
					normalizedElement.duration,
					playbackTime - normalizedElement.startTime,
				),
			),
			fps: projectFps,
		});
		const activeSplitScreen = resolveVideoSplitScreenAtTime({
			element: normalizedElement,
			localTime,
		});
		const series = activeSplitScreen
			? activeSplitScreen.slots.flatMap((slot) => {
					if (!slot.presetId) return [];
					const preset = getReframePresetById({
						element: normalizedElement,
						presetId: slot.presetId,
					});
					if (!preset?.motionTracking?.enabled) return [];
					const entry = buildRawPresetDebugSeries({
						preset,
						localTime,
						slotId: slot.slotId,
					});
					return entry ? [entry] : [];
				})
			: (() => {
					const activePresetId = getActiveReframePresetId({
						element: normalizedElement,
						localTime,
					});
					if (!activePresetId) return [];
					const activePreset = getReframePresetById({
						element: normalizedElement,
						presetId: activePresetId,
					});
					if (!activePreset?.motionTracking?.enabled) return [];
					const entry = buildRawPresetDebugSeries({
						preset: activePreset,
						localTime,
					});
					return entry ? [entry] : [];
				})();

		if (series.length === 0) return null;
		return {
			sourceWidth,
			sourceHeight,
			series,
		};
	}, [
		isPlaying,
		mediaAssets,
		playbackTime,
		selectedElements,
		selectedPresetIdByElementId,
		selectedSplitPreviewByElementId,
		tracks,
		projectFps,
	]);

	if (!debugData) return null;

	return (
		<div className="pointer-events-none absolute bottom-3 right-3 w-[240px] rounded-md border border-white/15 bg-black/75 p-2 text-white shadow-xl backdrop-blur-sm">
			<div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/70">
				Tracking Source Map
			</div>
			<div className="mt-1 text-[11px] text-white/55">
				Raw sampled tracking points before reframe transform
			</div>
			<div
				className="mt-2 overflow-hidden rounded border border-white/10 bg-black/60"
				style={{
					aspectRatio: `${debugData.sourceWidth} / ${debugData.sourceHeight}`,
				}}
			>
				<svg
					className="block size-full"
					viewBox={`0 0 ${debugData.sourceWidth} ${debugData.sourceHeight}`}
					aria-hidden
				>
					<rect
						x={0}
						y={0}
						width={debugData.sourceWidth}
						height={debugData.sourceHeight}
						fill="transparent"
						stroke="rgba(255,255,255,0.18)"
						strokeWidth={2}
					/>
					{debugData.series.map((entry) => (
						<g key={entry.id}>
							{entry.path.map((point, index) => {
								const isValidPoint =
									Number.isFinite(point.x) && Number.isFinite(point.y);
								if (!isValidPoint) {
									return (
										<rect
											key={`${entry.id}:path:${index}`}
											x={8 + ((index * 14) % (debugData.sourceWidth - 16))}
											y={debugData.sourceHeight - 18}
											width={6}
											height={6}
											fill={getSampleSourceColor(point.source)}
											opacity={0.85}
											rx={2}
										/>
									);
								}
								return (
									<circle
										key={`${entry.id}:path:${index}`}
										cx={point.x}
										cy={point.y}
										r={10}
										fill={getSampleSourceColor(point.source)}
										opacity={0.3}
									/>
								);
							})}
							{entry.current && (
								<>
									<circle
										cx={entry.current.x}
										cy={entry.current.y}
										r={24}
										fill={entry.color}
										fillOpacity={0.12}
										stroke={getSampleSourceColor(entry.current.source ?? "eye")}
										strokeWidth={4}
									/>
									<circle
										cx={entry.current.x}
										cy={entry.current.y}
										r={10}
										fill={getSampleSourceColor(entry.current.source ?? "eye")}
									/>
								</>
							)}
						</g>
					))}
				</svg>
			</div>
			<div className="mt-2 space-y-1">
				{debugData.series.map((entry) => (
					<div key={`${entry.id}:legend`} className="flex items-center gap-2 text-[11px] text-white/80">
						<div
							className="size-2.5 rounded-full"
							style={{ backgroundColor: entry.color }}
						/>
						<span>{entry.label}</span>
					</div>
				))}
				<div className="mt-2 flex flex-wrap gap-3 text-[10px] text-white/65">
					{(
						[
							"eye",
							"head-landmarks",
							"head-detection",
							"head-continuity",
							"pose-head",
							"low-confidence",
							"miss",
						] as const
					).map((source) => (
						<div key={source} className="flex items-center gap-1.5">
							<div
								className="size-2 rounded-full"
								style={{ backgroundColor: getSampleSourceColor(source) }}
							/>
							<span>{getSampleSourceLabel(source)}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
