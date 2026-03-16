"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { useTimelineStore } from "@/stores/timeline-store";
import AudioWaveform from "./audio-waveform";
import { useTimelineElementResize } from "@/hooks/timeline/element/use-element-resize";
import type { SnapPoint } from "@/lib/timeline/snap-utils";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { snapTimeToFrame } from "@/lib/time";
import {
	getElementBaseValueForProperty,
	getElementKeyframes,
	resolveNumberAtTime,
} from "@/lib/animation";
import {
	getTrackClasses,
	getTrackHeight,
	canElementHaveAudio,
	canElementBeHidden,
	hasMediaId,
} from "@/lib/timeline";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "../../../ui/context-menu";
import type {
	AnimationInterpolation,
	AnimationPropertyPath,
	ElementKeyframe,
} from "@/types/animation";
import type {
	TimelineElement as TimelineElementType,
	TimelineTrack,
	ElementDragState,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { mediaSupportsAudio } from "@/lib/media/media-utils";
import { getActionDefinition, type TAction, invokeAction } from "@/lib/actions";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { resolveStickerId } from "@/lib/stickers";
import type { TimelineVisualModel } from "@/lib/transcript-editor/visual-timeline";
import { getTimelineElementVisualLayout as getElementVisualLayout } from "@/lib/transcript-editor/visual-timeline";
import Image from "next/image";
import {
	ScissorIcon,
	Delete02Icon,
	Copy01Icon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeHighIcon,
	VolumeOffIcon,
	VolumeMute02Icon,
	Search01Icon,
	Exchange01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { uppercase } from "@/utils/string";

const MAX_PERSISTED_WAVEFORM_ENTRIES = 200;
const MAX_PERSISTED_PEAKS = 768;

function downsamplePeaksForPersistence({
	peaks,
	maxLength = MAX_PERSISTED_PEAKS,
}: {
	peaks: number[];
	maxLength?: number;
}): number[] {
	if (peaks.length <= maxLength) return peaks;
	const step = peaks.length / maxLength;
	const sampled: number[] = [];
	for (let i = 0; i < maxLength; i++) {
		const index = Math.min(peaks.length - 1, Math.floor(i * step));
		sampled.push(peaks[index] ?? 0);
	}
	return sampled;
}

function getDisplayShortcut(action: TAction) {
	const { defaultShortcuts } = getActionDefinition(action);
	if (!defaultShortcuts?.length) {
		return "";
	}

	return uppercase({
		string: defaultShortcuts[0].replace("+", " "),
	});
}

function isTranscriptMediaElement(
	element: TimelineElementType,
): element is Extract<TimelineElementType, { type: "video" | "audio" }> {
	return element.type === "video" || element.type === "audio";
}

const TIMELINE_KEYFRAME_PATHS: AnimationPropertyPath[] = [
	"opacity",
	"transform.scale",
	"transform.position.x",
	"transform.position.y",
	"transform.rotate",
];

function isVisualTimelineElement(
	element: TimelineElementType,
): element is Extract<
	TimelineElementType,
	{ type: "video" | "image" | "text" | "sticker" }
> {
	return (
		element.type === "video" ||
		element.type === "image" ||
		element.type === "text" ||
		element.type === "sticker"
	);
}

function toLocalTimeFromClientX({
	clientX,
	containerRect,
	duration,
}: {
	clientX: number;
	containerRect: DOMRect;
	duration: number;
}): number {
	if (containerRect.width <= 0 || duration <= 0) return 0;
	const normalized = Math.max(
		0,
		Math.min(1, (clientX - containerRect.left) / containerRect.width),
	);
	return normalized * duration;
}

function resolveNumericValueAtLocalTime({
	element,
	propertyPath,
	localTime,
}: {
	element: Extract<
		TimelineElementType,
		{ type: "video" | "image" | "text" | "sticker" }
	>;
	propertyPath: AnimationPropertyPath;
	localTime: number;
}): number | null {
	const baseValue = getElementBaseValueForProperty({ element, propertyPath });
	if (typeof baseValue !== "number") return null;
	return resolveNumberAtTime({
		baseValue,
		animations: element.animations,
		propertyPath,
		localTime,
	});
}

const KEYFRAME_EASING_OPTIONS: Array<{
	label: string;
	value: AnimationInterpolation;
}> = [
	{ label: "Linear", value: "linear" },
	{ label: "Ease In", value: "ease-in" },
	{ label: "Ease Out", value: "ease-out" },
	{ label: "Ease In Out", value: "ease-in-out" },
	{ label: "Hold", value: "hold" },
];

interface TimelineElementProps {
	element: TimelineElementType;
	track: TimelineTrack;
	tracks: TimelineTrack[];
	zoomLevel: number;
	visualModel: TimelineVisualModel;
	isSelected: boolean;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
	onResizeStateChange?: (params: { isResizing: boolean }) => void;
	onElementMouseDown: (
		e: React.MouseEvent,
		element: TimelineElementType,
	) => void;
	onElementClick: (e: React.MouseEvent, element: TimelineElementType) => void;
	dragState: ElementDragState;
}

export function TimelineElement({
	element,
	track,
	tracks,
	zoomLevel,
	visualModel,
	isSelected,
	onSnapPointChange,
	onResizeStateChange,
	onElementMouseDown,
	onElementClick,
	dragState,
}: TimelineElementProps) {
	const editor = useEditor({ subscribeTo: ["media", "project", "timeline"] });
	const { selectedElements } = useElementSelection();
	const snappingEnabled = useTimelineStore((state) => state.snappingEnabled);
	const { requestRevealMedia } = useAssetsPanelStore();
	const activeProject = editor.project.getActive();

	const mediaAssets = editor.media.getAssets();
	let mediaAsset: MediaAsset | null = null;

	if (hasMediaId(element)) {
		mediaAsset =
			mediaAssets.find((asset) => asset.id === element.mediaId) ?? null;
	}

	const hasAudio = mediaSupportsAudio({ media: mediaAsset });

	const { handleResizeStart, isResizing, currentStartTime, currentDuration } =
		useTimelineElementResize({
			element,
			track,
			zoomLevel,
			onSnapPointChange,
			onResizeStateChange,
		});

	const isCurrentElementSelected = selectedElements.some(
		(selected) =>
			selected.elementId === element.id && selected.trackId === track.id,
	);

	const isBeingDragged = dragState.elementId === element.id;
	const dragOffsetY =
		isBeingDragged && dragState.isDragging
			? dragState.currentMouseY - dragState.startMouseY
			: 0;
	const elementStartTime =
		isBeingDragged && dragState.isDragging
			? dragState.currentTime
			: element.startTime;
	const displayedStartTime = isResizing ? currentStartTime : elementStartTime;
	const displayedDuration = isResizing ? currentDuration : element.duration;
	const visualLayout = getElementVisualLayout({
		element: {
			...element,
			startTime: displayedStartTime,
			duration: displayedDuration,
		},
		tracks,
		model: visualModel,
	});
	const elementWidth =
		visualLayout.visualDuration *
		TIMELINE_CONSTANTS.PIXELS_PER_SECOND *
		zoomLevel;
	const elementLeft =
		TIMELINE_CONSTANTS.START_OFFSET_PX +
		visualLayout.visualStartTime *
		TIMELINE_CONSTANTS.PIXELS_PER_SECOND *
		zoomLevel;
	const roundedElementWidth = Math.round(elementWidth);
	const roundedElementLeft = Math.round(elementLeft);

	const revealInMedia = () => {
		if (hasMediaId(element)) {
			requestRevealMedia(element.mediaId);
		}
	};

	const isMuted = canElementHaveAudio(element) && element.muted === true;
	const waveformPeaksCache = activeProject.waveformPeaksCache ?? {};

	const getPersistedWaveformPeaks = ({
		cacheKey,
	}: {
		cacheKey?: string;
	}): number[] | undefined => {
		if (!cacheKey) return undefined;
		const cached = waveformPeaksCache[cacheKey]?.peaks;
		return Array.isArray(cached) && cached.length > 0 ? cached : undefined;
	};

	const persistWaveformPeaks = ({
		cacheKey,
		peaks,
	}: {
		cacheKey?: string;
		peaks: number[];
	}): void => {
		if (!cacheKey || peaks.length === 0) return;
		const currentProject = editor.project.getActive();
		if (!currentProject) return;
		const existing = currentProject.waveformPeaksCache?.[cacheKey]?.peaks;
		if (existing && existing.length === peaks.length) return;

		const nextEntry = {
			peaks: downsamplePeaksForPersistence({ peaks }),
			updatedAt: new Date().toISOString(),
		};
		const nextCache = {
			...(currentProject.waveformPeaksCache ?? {}),
			[cacheKey]: nextEntry,
		};
		const entries = Object.entries(nextCache);
		if (entries.length > MAX_PERSISTED_WAVEFORM_ENTRIES) {
			entries.sort(([, a], [, b]) => {
				const aTime = Date.parse(a.updatedAt ?? "") || 0;
				const bTime = Date.parse(b.updatedAt ?? "") || 0;
				return bTime - aTime;
			});
			const trimmed = entries.slice(0, MAX_PERSISTED_WAVEFORM_ENTRIES);
			const trimmedCache = Object.fromEntries(trimmed);
			editor.project.setActiveProject({
				project: {
					...currentProject,
					waveformPeaksCache: trimmedCache,
				},
			});
			editor.save.markDirty();
			return;
		}
		editor.project.setActiveProject({
			project: {
				...currentProject,
				waveformPeaksCache: nextCache,
			},
		});
		editor.save.markDirty();
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					data-timeline-element-id={element.id}
						data-timeline-track-id={track.id}
						data-timeline-element-type={element.type}
						data-visual-start-time={visualLayout.visualStartTime}
						data-visual-duration={visualLayout.visualDuration}
						className={`absolute top-0 h-full select-none`}
					style={{
						left: `${roundedElementLeft}px`,
						width: `${roundedElementWidth}px`,
						transform:
							isBeingDragged && dragState.isDragging
								? `translate3d(0, ${dragOffsetY}px, 0)`
								: undefined,
					}}
				>
					<ElementInner
						editor={editor}
						element={element}
						track={track}
						tracks={tracks}
						isSelected={isSelected}
						visualModel={visualModel}
						visualStartTime={visualLayout.visualStartTime}
						visualDuration={visualLayout.visualDuration}
						projectFps={activeProject.settings.fps}
						snappingEnabled={snappingEnabled}
						hasAudio={hasAudio}
						isMuted={isMuted}
						mediaAssets={mediaAssets}
						getPersistedWaveformPeaks={getPersistedWaveformPeaks}
						onWaveformPeaksResolved={persistWaveformPeaks}
						onElementClick={onElementClick}
						onElementMouseDown={onElementMouseDown}
						handleResizeStart={handleResizeStart}
					/>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-64">
				<ActionMenuItem
					action="split"
					icon={<HugeiconsIcon icon={ScissorIcon} />}
				>
					Split
				</ActionMenuItem>
				<CopyMenuItem />
				{canElementHaveAudio(element) && hasAudio && (
					<MuteMenuItem
						isMultipleSelected={selectedElements.length > 1}
						isCurrentElementSelected={isCurrentElementSelected}
						isMuted={isMuted}
					/>
				)}
				{canElementBeHidden(element) && (
					<VisibilityMenuItem
						element={element}
						isMultipleSelected={selectedElements.length > 1}
						isCurrentElementSelected={isCurrentElementSelected}
					/>
				)}
				{selectedElements.length === 1 && (
					<ActionMenuItem
						action="duplicate-selected"
						icon={<HugeiconsIcon icon={Copy01Icon} />}
					>
						Duplicate
					</ActionMenuItem>
				)}
				{hasMediaId(element) && (
					<>
						<ContextMenuItem
							icon={<HugeiconsIcon icon={Search01Icon} />}
							onSelect={(event) => {
								event.preventDefault();
								event.stopPropagation();
								revealInMedia();
							}}
						>
							Reveal media
						</ContextMenuItem>
						{isTranscriptMediaElement(element) && (
							<ContextMenuItem
								onSelect={(event) => {
									event.preventDefault();
									event.stopPropagation();
									invokeAction("rebuild-captions-for-clip", {
										trackId: track.id,
										elementId: element.id,
									});
								}}
							>
								Rebuild captions for clip
							</ContextMenuItem>
						)}
						<ContextMenuItem
							icon={<HugeiconsIcon icon={Exchange01Icon} />}
							disabled
						>
							Replace media
						</ContextMenuItem>
					</>
				)}
				{isVisualTimelineElement(element) && element.transitions?.in && (
					<ContextMenuItem
						onSelect={(event) => {
							event.preventDefault();
							event.stopPropagation();
							invokeAction("remove-transition-in", {
								trackId: track.id,
								elementId: element.id,
							});
						}}
					>
						Remove In Transition
					</ContextMenuItem>
				)}
				{isVisualTimelineElement(element) && element.transitions?.out && (
					<ContextMenuItem
						onSelect={(event) => {
							event.preventDefault();
							event.stopPropagation();
							invokeAction("remove-transition-out", {
								trackId: track.id,
								elementId: element.id,
							});
						}}
					>
						Remove Out Transition
					</ContextMenuItem>
				)}
				<ContextMenuSeparator />
				<DeleteMenuItem
					isMultipleSelected={selectedElements.length > 1}
					isCurrentElementSelected={isCurrentElementSelected}
					elementType={element.type}
					selectedCount={selectedElements.length}
				/>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function ElementInner({
	editor,
	element,
	track,
	tracks,
	isSelected,
	visualModel,
	visualStartTime,
	visualDuration,
	projectFps,
	snappingEnabled,
	hasAudio,
	isMuted,
	mediaAssets,
	getPersistedWaveformPeaks,
	onWaveformPeaksResolved,
	onElementClick,
	onElementMouseDown,
	handleResizeStart,
}: {
	editor: ReturnType<typeof useEditor>;
	element: TimelineElementType;
	track: TimelineTrack;
	tracks: TimelineTrack[];
	isSelected: boolean;
	visualModel: TimelineVisualModel;
	visualStartTime: number;
	visualDuration: number;
	projectFps: number;
	snappingEnabled: boolean;
	hasAudio: boolean;
	isMuted: boolean;
	mediaAssets: MediaAsset[];
	getPersistedWaveformPeaks: ({ cacheKey }: { cacheKey?: string }) => number[] | undefined;
	onWaveformPeaksResolved: ({
		cacheKey,
		peaks,
	}: {
		cacheKey?: string;
		peaks: number[];
	}) => void;
	onElementClick: (e: React.MouseEvent, element: TimelineElementType) => void;
	onElementMouseDown: (
		e: React.MouseEvent,
		element: TimelineElementType,
	) => void;
	handleResizeStart: (params: {
		event: React.MouseEvent;
		elementId: string;
		side: "left" | "right";
	}) => void;
}) {
	const showMutedOverlay = element.type === "audio" && hasAudio && isMuted;
	const showHiddenOverlay = canElementBeHidden(element) && element.hidden;
	const transcriptCutMarkers = getElementVisualLayout({
		element,
		tracks,
		model: visualModel,
	}).cutMarkers;
	const isVisual = isVisualTimelineElement(element);
	const elementKeyframes = useMemo(
		() =>
			isVisual ? getElementKeyframes({ animations: element.animations }) : [],
		[isVisual, element.animations],
	);
	const hasAnyKeyframes = isVisual
		? getElementKeyframes({ animations: element.animations }).length > 0
		: false;
	const [selectedKeyframes, setSelectedKeyframes] = useState<
		Array<{
			propertyPath: AnimationPropertyPath;
			keyframeId: string;
		}>
	>([]);
	const [draggingKeyframe, setDraggingKeyframe] = useState<{
		propertyPath: AnimationPropertyPath;
		keyframeId: string;
		time: number;
	} | null>(null);
	const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(
		null,
	);
	const laneButtonElementsRef = useRef(
		new Map<AnimationPropertyPath, HTMLButtonElement>(),
	);
	const [easingMenu, setEasingMenu] = useState<{
		x: number;
		y: number;
		propertyPath: AnimationPropertyPath;
		keyframeId?: string;
	} | null>(null);
	const laneKeyframes = useMemo(() => {
		const laneMap = new Map<AnimationPropertyPath, ElementKeyframe[]>();
		for (const path of TIMELINE_KEYFRAME_PATHS) {
			laneMap.set(path, []);
		}
		for (const keyframe of elementKeyframes) {
			const path = keyframe.propertyPath;
			if (!laneMap.has(path)) continue;
			laneMap.set(path, [...(laneMap.get(path) ?? []), keyframe]);
		}
		for (const [path, keyframes] of laneMap.entries()) {
			laneMap.set(
				path,
				[...keyframes].sort((left, right) => left.time - right.time),
			);
		}
		return laneMap;
	}, [elementKeyframes]);
	const visibleLanePaths = useMemo(
		() =>
			TIMELINE_KEYFRAME_PATHS.filter(
				(path) => (laneKeyframes.get(path)?.length ?? 0) > 0,
			),
		[laneKeyframes],
	);
	const isKeyframeSelected = ({
		propertyPath,
		keyframeId,
	}: {
		propertyPath: AnimationPropertyPath;
		keyframeId: string;
	}) =>
		selectedKeyframes.some(
			(selected) =>
				selected.propertyPath === propertyPath &&
				selected.keyframeId === keyframeId,
		);

	useEffect(() => {
		if (!easingMenu) return;
		const handleWindowClick = () => setEasingMenu(null);
		window.addEventListener("click", handleWindowClick);
		return () => window.removeEventListener("click", handleWindowClick);
	}, [easingMenu]);

	useEffect(() => {
		if (selectedKeyframes.length === 0) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			event.preventDefault();
			editor.timeline.removeKeyframes({
				keyframes: selectedKeyframes.map((selected) => ({
						trackId: track.id,
						elementId: element.id,
						propertyPath: selected.propertyPath,
						keyframeId: selected.keyframeId,
					})),
			});
			setSelectedKeyframes([]);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [editor.timeline, track.id, element.id, selectedKeyframes]);

	useEffect(() => {
		if (!draggingKeyframe || !containerElement || !isVisual) return;

		const findKeyframeByRef = ({
			keyframeId,
			propertyPath,
		}: {
			keyframeId: string;
			propertyPath: AnimationPropertyPath;
		}) =>
			(laneKeyframes.get(propertyPath) ?? []).find(
				(candidate) => candidate.id === keyframeId,
			);

		const onMouseMove = (event: MouseEvent) => {
			const rect =
				laneButtonElementsRef.current
					.get(draggingKeyframe.propertyPath)
					?.getBoundingClientRect() ??
				containerElement.getBoundingClientRect();
			let nextTime = toLocalTimeFromClientX({
				clientX: event.clientX,
				containerRect: rect,
				duration: element.duration,
			});
			nextTime = snapTimeToFrame({ time: nextTime, fps: projectFps });

			if (snappingEnabled) {
				const thresholdTime =
					rect.width > 0 ? (6 / rect.width) * element.duration : 0;
				const nearbyTimes = elementKeyframes
					.filter(
						(keyframe) =>
							!(
								keyframe.id === draggingKeyframe.keyframeId &&
								keyframe.propertyPath === draggingKeyframe.propertyPath
							),
					)
					.map((keyframe) => keyframe.time);
				let best = nextTime;
				let bestDistance = Number.POSITIVE_INFINITY;
				for (const candidate of nearbyTimes) {
					const distance = Math.abs(candidate - nextTime);
					if (distance <= thresholdTime && distance < bestDistance) {
						best = candidate;
						bestDistance = distance;
					}
				}
				nextTime = best;
			}

			setDraggingKeyframe((prev) =>
				prev
					? {
							...prev,
							time: Math.max(0, Math.min(element.duration, nextTime)),
					  }
					: prev,
			);
		};

		const onMouseUp = () => {
			const current = draggingKeyframe;
			const original = findKeyframeByRef({
				keyframeId: current.keyframeId,
				propertyPath: current.propertyPath,
			});
			if (original && Math.abs(original.time - current.time) > 0.0001) {
				editor.timeline.retimeKeyframe({
					trackId: track.id,
					elementId: element.id,
					propertyPath: current.propertyPath,
					keyframeId: current.keyframeId,
					time: current.time,
				});
			}
			setDraggingKeyframe(null);
		};

		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
		return () => {
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, [
		draggingKeyframe,
		containerElement,
		isVisual,
		laneKeyframes,
		projectFps,
		snappingEnabled,
		element.duration,
		elementKeyframes,
		editor.timeline,
		track.id,
		element.id,
	]);

	const onLaneMouseDown = ({
		event,
		propertyPath,
	}: {
		event: React.MouseEvent;
		propertyPath: AnimationPropertyPath;
	}) => {
		if (!isSelected) return;
		event.preventDefault();
		event.stopPropagation();
		if (!isVisual || !containerElement) return;
		const laneElement = laneButtonElementsRef.current.get(propertyPath);
		const rawTime = toLocalTimeFromClientX({
			clientX: event.clientX,
			containerRect:
				laneElement?.getBoundingClientRect() ??
				containerElement.getBoundingClientRect(),
			duration: element.duration,
		});
		const localTime = snapTimeToFrame({ time: rawTime, fps: projectFps });
		const value = resolveNumericValueAtLocalTime({
			element,
			propertyPath,
			localTime,
		});
		if (value === null) return;
		editor.timeline.upsertKeyframes({
			keyframes: [
				{
					trackId: track.id,
					elementId: element.id,
					propertyPath,
					time: localTime,
					value,
				},
			],
		});
	};

	const onKeyframeMouseDown = ({
		event,
		propertyPath,
		keyframeId,
		time,
	}: {
		event: React.MouseEvent;
		propertyPath: AnimationPropertyPath;
		keyframeId: string;
		time: number;
	}) => {
		event.preventDefault();
		event.stopPropagation();
		if (event.shiftKey) {
			setSelectedKeyframes((previous) => {
				const exists = previous.some(
					(candidate) =>
						candidate.propertyPath === propertyPath &&
						candidate.keyframeId === keyframeId,
				);
				if (exists) {
					return previous.filter(
						(candidate) =>
							!(
								candidate.propertyPath === propertyPath &&
								candidate.keyframeId === keyframeId
							),
					);
				}
				return [...previous, { propertyPath, keyframeId }];
			});
			setDraggingKeyframe(null);
			return;
		}
		setSelectedKeyframes([{ propertyPath, keyframeId }]);
		setDraggingKeyframe({
			propertyPath,
			keyframeId,
			time,
		});
	};

	const onKeyframeContextMenu = ({
		event,
		propertyPath,
		keyframeId,
	}: {
		event: React.MouseEvent;
		propertyPath: AnimationPropertyPath;
		keyframeId: string;
	}) => {
		event.preventDefault();
		event.stopPropagation();
		if (!isKeyframeSelected({ propertyPath, keyframeId })) {
			setSelectedKeyframes([{ propertyPath, keyframeId }]);
		}
		setEasingMenu({
			x: event.clientX,
			y: event.clientY,
			propertyPath,
			keyframeId,
		});
	};

	const onLaneContextMenu = ({
		event,
		propertyPath,
	}: {
		event: React.MouseEvent;
		propertyPath: AnimationPropertyPath;
	}) => {
		event.preventDefault();
		event.stopPropagation();
		setEasingMenu({
			x: event.clientX,
			y: event.clientY,
			propertyPath,
		});
	};

	const applyEasingToMenuTarget = ({
		interpolation,
	}: {
		interpolation: AnimationInterpolation;
	}) => {
		if (!easingMenu) return;
		const lane = laneKeyframes.get(easingMenu.propertyPath) ?? [];
		const targetKeyframes = easingMenu.keyframeId
			? lane.filter((keyframe) => keyframe.id === easingMenu.keyframeId)
			: lane;
		if (targetKeyframes.length === 0) {
			setEasingMenu(null);
			return;
		}
		editor.timeline.upsertKeyframes({
			keyframes: targetKeyframes.map((keyframe) => ({
				trackId: track.id,
				elementId: element.id,
				propertyPath: easingMenu.propertyPath,
				time: keyframe.time,
				value: keyframe.value,
				interpolation,
				keyframeId: keyframe.id,
			})),
		});
		setEasingMenu(null);
	};

	const clearMenuTargetKeyframes = () => {
		if (!easingMenu) return;
		const lane = laneKeyframes.get(easingMenu.propertyPath) ?? [];
		const targetKeyframes = easingMenu.keyframeId
			? lane.filter((keyframe) => keyframe.id === easingMenu.keyframeId)
			: lane;
		if (targetKeyframes.length === 0) {
			setEasingMenu(null);
			return;
		}
		editor.timeline.removeKeyframes({
			keyframes: targetKeyframes.map((keyframe) => ({
				trackId: track.id,
				elementId: element.id,
				propertyPath: easingMenu.propertyPath,
				keyframeId: keyframe.id,
			})),
		});
		if (
			selectedKeyframes.length > 0 &&
			targetKeyframes.some((keyframe) =>
				selectedKeyframes.some((selected) => selected.keyframeId === keyframe.id),
			)
		) {
			setSelectedKeyframes((previous) =>
				previous.filter(
					(selected) =>
						!targetKeyframes.some(
							(keyframe) =>
								keyframe.id === selected.keyframeId &&
								easingMenu.propertyPath === selected.propertyPath,
						),
				),
			);
		}
		setEasingMenu(null);
	};

	return (
		<div
			ref={setContainerElement}
			className={`relative h-full cursor-pointer overflow-hidden rounded-[0.5rem] ${getTrackClasses(
				{
					type: track.type,
				},
			)} ${canElementBeHidden(element) && element.hidden ? "opacity-50" : ""}`}
			style={{ marginInline: 1 }}
		>
			<button
				type="button"
				data-timeline-element-hit-target={element.id}
				data-visual-start-time={visualStartTime}
				data-visual-duration={visualDuration}
				className="absolute inset-0 size-full cursor-pointer"
				onClick={(e) => onElementClick(e, element)}
				onMouseDown={(e) => onElementMouseDown(e, element)}
			>
				<div className="absolute inset-0 flex h-full items-center">
					<ElementContent
						element={element}
						track={track}
						isSelected={isSelected}
						mediaAssets={mediaAssets}
						getPersistedWaveformPeaks={getPersistedWaveformPeaks}
						onWaveformPeaksResolved={onWaveformPeaksResolved}
					/>
				</div>
				{transcriptCutMarkers.map((marker, index) => (
					<div
						key={`${element.id}:cut-marker:${index}`}
						className="pointer-events-none absolute top-1 bottom-1 w-1 -translate-x-1/2 rounded-full border border-black/25 bg-zinc-400/90"
						style={{
							left: `${marker.leftPercent}%`,
						}}
					/>
				))}

				{(showMutedOverlay || showHiddenOverlay) && (
					<div className="bg-opacity-50 pointer-events-none absolute inset-0 flex items-center justify-center bg-black">
						{showMutedOverlay ? (
							<HugeiconsIcon
								icon={VolumeHighIcon}
								className="size-6 text-white"
							/>
						) : (
							<HugeiconsIcon
								icon={VolumeOffIcon}
								className="size-6 text-white"
							/>
						)}
					</div>
				)}
			</button>

			{isVisual && hasAnyKeyframes && (
				<div className="pointer-events-none absolute inset-x-1 bottom-0 top-0 z-[2] flex flex-col justify-end gap-0.5 pb-1">
					{visibleLanePaths.map((propertyPath) => {
						const keyframes = laneKeyframes.get(propertyPath) ?? [];
						const label =
							propertyPath === "opacity"
								? "Op"
								: propertyPath === "transform.scale"
									? "Sc"
									: propertyPath === "transform.position.x"
										? "X"
										: propertyPath === "transform.position.y"
											? "Y"
											: "R";
						return (
							<div
								key={propertyPath}
								className="pointer-events-none flex h-2.5 items-center gap-1"
							>
								<div className="pointer-events-none w-3 text-[8px] leading-none text-white/70">
									{label}
								</div>
								<button
									type="button"
									ref={(node) => {
										if (node) {
											laneButtonElementsRef.current.set(propertyPath, node);
											return;
										}
										laneButtonElementsRef.current.delete(propertyPath);
									}}
									className={`pointer-events-auto relative h-1.5 flex-1 rounded ${isSelected ? "bg-black/35" : "bg-black/25"}`}
									onMouseDown={(event) =>
										onLaneMouseDown({ event, propertyPath })
									}
									onContextMenu={(event) =>
										onLaneContextMenu({ event, propertyPath })
									}
									title={`Add keyframe on ${propertyPath}`}
								>
									{keyframes.map((keyframe) => {
										const activeDrag =
											draggingKeyframe?.keyframeId === keyframe.id &&
											draggingKeyframe.propertyPath === propertyPath;
										const time = activeDrag ? draggingKeyframe.time : keyframe.time;
										const left = `${
											element.duration > 0 ? (time / element.duration) * 100 : 0
										}%`;
										const isActive =
											isKeyframeSelected({
												propertyPath,
												keyframeId: keyframe.id,
											});
										return (
											<button
												key={keyframe.id}
												type="button"
												className={`pointer-events-auto absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] border ${isActive ? "border-white bg-primary" : "border-white/70 bg-white/70"}`}
												style={{ left }}
												onMouseDown={(event) =>
													onKeyframeMouseDown({
														event,
														propertyPath,
														keyframeId: keyframe.id,
														time: keyframe.time,
													})
												}
												onContextMenu={(event) =>
													onKeyframeContextMenu({
														event,
														propertyPath,
														keyframeId: keyframe.id,
													})
												}
												title={`Keyframe ${propertyPath}`}
											/>
										);
									})}
								</button>
							</div>
						);
					})}
				</div>
			)}

			{easingMenu && (
				<div
					className="fixed z-[120] min-w-32 rounded-md border bg-popover p-1 shadow-lg"
					style={{
						left: easingMenu.x + 6,
						top: easingMenu.y + 6,
					}}
					onMouseDown={(event) => {
						event.preventDefault();
						event.stopPropagation();
					}}
					onContextMenu={(event) => {
						event.preventDefault();
						event.stopPropagation();
					}}
				>
					<div className="px-2 py-1 text-[10px] text-muted-foreground">
						{easingMenu.keyframeId
							? "Apply easing to keyframe"
							: "Apply easing to property lane"}
					</div>
					{KEYFRAME_EASING_OPTIONS.map((option) => (
						<button
							key={option.value}
							type="button"
							className="hover:bg-accent flex w-full items-center rounded px-2 py-1 text-left text-xs"
							onClick={() =>
								applyEasingToMenuTarget({ interpolation: option.value })
							}
						>
							{option.label}
						</button>
					))}
					<div className="my-1 h-px bg-border" />
					<button
						type="button"
						className="hover:bg-accent text-destructive flex w-full items-center rounded px-2 py-1 text-left text-xs"
						onClick={clearMenuTargetKeyframes}
					>
						{easingMenu.keyframeId ? "Clear keyframe" : "Clear keyframes"}
					</button>
				</div>
			)}

			{isSelected && (
				<>
					<ResizeHandle
						side="left"
						elementId={element.id}
						handleResizeStart={handleResizeStart}
					/>
					<ResizeHandle
						side="right"
						elementId={element.id}
						handleResizeStart={handleResizeStart}
					/>
				</>
			)}
		</div>
	);
}

function ResizeHandle({
	side,
	elementId,
	handleResizeStart,
}: {
	side: "left" | "right";
	elementId: string;
	handleResizeStart: (params: {
		event: React.MouseEvent;
		elementId: string;
		side: "left" | "right";
	}) => void;
}) {
	const isLeft = side === "left";
	return (
		<button
			type="button"
			className={`bg-primary absolute top-0 bottom-0 flex w-[0.6rem] items-center justify-center ${isLeft ? "left-0 cursor-w-resize" : "right-0 cursor-e-resize"}`}
			onMouseDown={(event) => handleResizeStart({ event, elementId, side })}
			aria-label={`${isLeft ? "Left" : "Right"} resize handle`}
		>
			<div className="bg-foreground h-[1.5rem] w-[0.2rem] rounded-full" />
		</button>
	);
}

function ElementContent({
	element,
	track,
	isSelected,
	mediaAssets,
	getPersistedWaveformPeaks,
	onWaveformPeaksResolved,
}: {
	element: TimelineElementType;
	track: TimelineTrack;
	isSelected: boolean;
	mediaAssets: MediaAsset[];
	getPersistedWaveformPeaks: ({ cacheKey }: { cacheKey?: string }) => number[] | undefined;
	onWaveformPeaksResolved: ({
		cacheKey,
		peaks,
	}: {
		cacheKey?: string;
		peaks: number[];
	}) => void;
}) {
	if (element.type === "text") {
		return (
			<div className="flex size-full items-center justify-start pl-2">
				<span className="truncate text-xs text-white">{element.content}</span>
			</div>
		);
	}

	if (element.type === "sticker") {
		return (
			<div className="flex size-full items-center gap-2 pl-2">
				<Image
					src={resolveStickerId({
						stickerId: element.stickerId,
						options: { width: 20, height: 20 },
					})}
					alt={element.name}
					className="size-5 shrink-0"
					width={20}
					height={20}
					unoptimized
				/>
				<span className="truncate text-xs text-white">{element.name}</span>
			</div>
		);
	}

	if (element.type === "audio") {
		const audioBuffer = element.buffer;

		const audioUrl =
			element.sourceType === "library"
				? element.sourceUrl
				: mediaAssets.find((asset) => asset.id === element.mediaId)?.url;

		if (audioBuffer || audioUrl) {
			return (
				<div className="flex size-full items-center gap-2">
					<div className="min-w-0 flex-1">
						<AudioWaveform
							audioBuffer={audioBuffer}
							audioUrl={audioUrl}
							trimStart={element.trimStart}
							trimEnd={element.trimEnd}
							duration={element.duration}
							cacheKey={
								element.sourceType === "upload"
									? `media:${element.mediaId}`
									: `library:${element.sourceUrl}`
							}
							initialPeaks={getPersistedWaveformPeaks({
								cacheKey:
									element.sourceType === "upload"
										? `media:${element.mediaId}`
										: `library:${element.sourceUrl}`,
							})}
							onPeaksResolved={(peaks) =>
								onWaveformPeaksResolved({
									cacheKey:
										element.sourceType === "upload"
											? `media:${element.mediaId}`
											: `library:${element.sourceUrl}`,
									peaks,
								})
							}
							audioFile={
								element.sourceType === "upload"
									? mediaAssets.find((asset) => asset.id === element.mediaId)?.file
									: undefined
							}
							height={24}
							className="w-full"
						/>
					</div>
				</div>
			);
		}

		return (
			<span className="text-foreground/80 truncate text-xs">
				{element.name}
			</span>
		);
	}

	const mediaAsset = mediaAssets.find((asset) => asset.id === element.mediaId);
	if (!mediaAsset) {
		return (
			<span className="text-foreground/80 truncate text-xs">
				{element.name}
			</span>
		);
	}

	if (
		mediaAsset.type === "image" ||
		(mediaAsset.type === "video" && mediaAsset.thumbnailUrl)
	) {
		const trackHeight = getTrackHeight({ type: track.type });
		const tileWidth = Math.round(trackHeight * (16 / 9));
		const imageUrl =
			mediaAsset.type === "image" ? mediaAsset.url : mediaAsset.thumbnailUrl;

		return (
			<div className="flex size-full items-center justify-center">
				<div
					className={`relative size-full ${isSelected ? "bg-primary" : "bg-transparent"}`}
				>
					<div
						className="absolute right-0 left-0"
						style={{
							backgroundImage: imageUrl ? `url(${imageUrl})` : "none",
							backgroundRepeat: "repeat-x",
							backgroundSize: `${tileWidth}px ${trackHeight}px`,
							backgroundPosition: "left center",
							pointerEvents: "none",
							top: isSelected ? "0.25rem" : "0rem",
							bottom: isSelected ? "0.25rem" : "0rem",
						}}
					/>
					{mediaAsset.type === "video" &&
						mediaSupportsAudio({ media: mediaAsset }) && (
							<div className="pointer-events-none absolute right-1 bottom-0 left-1 z-[1]">
								<AudioWaveform
									audioUrl={mediaAsset.url}
									audioFile={mediaAsset.file}
									trimStart={element.trimStart}
									trimEnd={element.trimEnd}
									duration={element.duration}
									cacheKey={`media:${mediaAsset.id}`}
									initialPeaks={getPersistedWaveformPeaks({
										cacheKey: `media:${mediaAsset.id}`,
									})}
									onPeaksResolved={(peaks) =>
										onWaveformPeaksResolved({
											cacheKey: `media:${mediaAsset.id}`,
											peaks,
										})
									}
									height={Math.max(14, Math.floor(trackHeight * 0.42))}
									className="w-full opacity-80"
								/>
							</div>
						)}
				</div>
			</div>
		);
	}

	if (mediaAsset.type === "video") {
		return (
			<div className="relative flex size-full items-center justify-center">
				<span className="text-foreground/80 truncate px-2 text-xs">{element.name}</span>
				{mediaSupportsAudio({ media: mediaAsset }) && (
					<div className="pointer-events-none absolute right-1 bottom-0 left-1 z-[1]">
						<AudioWaveform
							audioUrl={mediaAsset.url}
							audioFile={mediaAsset.file}
							trimStart={element.trimStart}
							trimEnd={element.trimEnd}
							duration={element.duration}
							cacheKey={`media:${mediaAsset.id}`}
							initialPeaks={getPersistedWaveformPeaks({
								cacheKey: `media:${mediaAsset.id}`,
							})}
							onPeaksResolved={(peaks) =>
								onWaveformPeaksResolved({
									cacheKey: `media:${mediaAsset.id}`,
									peaks,
								})
							}
							height={Math.max(14, Math.floor(getTrackHeight({ type: track.type }) * 0.42))}
							className="w-full opacity-80"
						/>
					</div>
				)}
			</div>
		);
	}

	return (
		<span className="text-foreground/80 truncate text-xs">{element.name}</span>
	);
}

function CopyMenuItem() {
	return (
		<ActionMenuItem
			action="copy-selected"
			icon={<HugeiconsIcon icon={Copy01Icon} />}
		>
			Copy
		</ActionMenuItem>
	);
}

function MuteMenuItem({
	isMultipleSelected,
	isCurrentElementSelected,
	isMuted,
}: {
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
	isMuted: boolean;
}) {
	const getIcon = () => {
		if (isMultipleSelected && isCurrentElementSelected) {
			return <HugeiconsIcon icon={VolumeMute02Icon} />;
		}
		return isMuted ? (
			<HugeiconsIcon icon={VolumeHighIcon} />
		) : (
			<HugeiconsIcon icon={VolumeOffIcon} />
		);
	};

	return (
		<ActionMenuItem action="toggle-elements-muted-selected" icon={getIcon()}>
			{isMuted ? "Unmute" : "Mute"}
		</ActionMenuItem>
	);
}

function VisibilityMenuItem({
	element,
	isMultipleSelected,
	isCurrentElementSelected,
}: {
	element: TimelineElementType;
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
}) {
	const isHidden = canElementBeHidden(element) && element.hidden;

	const getIcon = () => {
		if (isMultipleSelected && isCurrentElementSelected) {
			return <HugeiconsIcon icon={ViewOffSlashIcon} />;
		}
		return isHidden ? (
			<HugeiconsIcon icon={ViewIcon} />
		) : (
			<HugeiconsIcon icon={ViewOffSlashIcon} />
		);
	};

	return (
		<ActionMenuItem
			action="toggle-elements-visibility-selected"
			icon={getIcon()}
		>
			{isHidden ? "Show" : "Hide"}
		</ActionMenuItem>
	);
}

function DeleteMenuItem({
	isMultipleSelected,
	isCurrentElementSelected,
	elementType,
	selectedCount,
}: {
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
	elementType: TimelineElementType["type"];
	selectedCount: number;
}) {
	return (
		<ActionMenuItem
			action="delete-selected"
			variant="destructive"
			icon={<HugeiconsIcon icon={Delete02Icon} />}
		>
			{isMultipleSelected && isCurrentElementSelected
				? `Delete ${selectedCount} elements`
				: `Delete ${elementType === "text" ? "text" : "clip"}`}
		</ActionMenuItem>
	);
}

function ActionMenuItem({
	action,
	children,
	...props
}: Omit<ComponentProps<typeof ContextMenuItem>, "onSelect" | "textRight"> & {
	action: TAction;
}) {
	return (
		<ContextMenuItem
			onSelect={(event) => {
				event.preventDefault();
				event.stopPropagation();
				invokeAction(action);
			}}
			textRight={getDisplayShortcut(action)}
			{...props}
		>
			{children}
		</ContextMenuItem>
	);
}
