"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { useReframeStore } from "@/stores/reframe-store";
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
import { Clapperboard, Sparkles } from "lucide-react";
import { uppercase } from "@/utils/string";
import { cn } from "@/utils/ui";
import {
	deriveVideoAngleSections,
	getActiveReframePresetId,
	getVideoAngleSectionByStartTime,
	getVideoAngleSectionAtTime,
	getSelectedOrActiveReframePresetId,
	getVideoReframeSectionAtTime,
	getVideoReframeSectionByStartTime,
	getVideoSplitScreenSectionByStartTime,
	getVideoSplitScreenSectionAtTime,
	normalizeVideoReframeState,
	resolveVideoBaseTransformAtTime,
	resolveVideoSplitScreenAtTime,
	resolveVideoSplitScreenSlotTransform,
} from "@/lib/reframe/video-reframe";

const MAX_PERSISTED_WAVEFORM_ENTRIES = 200;
const timelineSectionThumbnailCache = new Map<string, Record<string, string>>();
const MAX_PERSISTED_PEAKS = 768;
const TIMELINE_SECTION_BOUNDARY_EPSILON = 1 / 1000;

type TimelineBoundaryMarker = {
	time: number;
	switchId: string | null;
	splitSectionId: string | null;
	presetId: string | null;
	isSplit: boolean;
	isSplitToggle: boolean;
};

function getTimelineSectionThumbnailKey({
	startTime,
	endTime,
}: {
	startTime: number;
	endTime: number;
}): string {
	return `${startTime.toFixed(3)}:${endTime.toFixed(3)}`;
}

function getTimelineVisualPlacement({
	rendererWidth,
	rendererHeight,
	sourceWidth,
	sourceHeight,
	transform,
	offsetX = 0,
	offsetY = 0,
}: {
	rendererWidth: number;
	rendererHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	transform: {
		position: { x: number; y: number };
		scale: number;
	};
	offsetX?: number;
	offsetY?: number;
}) {
	const containScale = Math.min(
		rendererWidth / sourceWidth,
		rendererHeight / sourceHeight,
	);
	const width = sourceWidth * containScale * transform.scale;
	const height = sourceHeight * containScale * transform.scale;
	const x = offsetX + rendererWidth / 2 + transform.position.x - width / 2;
	const y = offsetY + rendererHeight / 2 + transform.position.y - height / 2;
	return { x, y, width, height };
}

function getTimelineSplitViewports({
	width,
	height,
}: {
	width: number;
	height: number;
}) {
	return new Map([
		["top", { x: 0, y: 0, width, height: height / 2 }],
		["bottom", { x: 0, y: height / 2, width, height: height / 2 }],
	]);
}

function getTimelineViewportAdjustedTransform({
	transform,
	viewport,
	rendererWidth,
	rendererHeight,
}: {
	transform: {
		position: { x: number; y: number };
		scale: number;
		rotate?: number;
	};
	viewport: { x: number; y: number; width: number; height: number };
	rendererWidth: number;
	rendererHeight: number;
}) {
	const viewportCenterX = viewport.x + viewport.width / 2;
	const viewportCenterY = viewport.y + viewport.height / 2;
	return {
		...transform,
		position: {
			x: transform.position.x + rendererWidth / 2 - viewportCenterX,
			y: transform.position.y + rendererHeight / 2 - viewportCenterY,
		},
	};
}

function scaleTransformToThumbnailCanvas({
	transform,
	projectCanvas,
	rendererWidth,
	rendererHeight,
}: {
	transform: {
		position: { x: number; y: number };
		scale: number;
		rotate?: number;
	};
	projectCanvas: { width: number; height: number };
	rendererWidth: number;
	rendererHeight: number;
}) {
	const xScale = rendererWidth / Math.max(1, projectCanvas.width);
	const yScale = rendererHeight / Math.max(1, projectCanvas.height);
	return {
		...transform,
		position: {
			x: transform.position.x * xScale,
			y: transform.position.y * yScale,
		},
	};
}

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
	const openReframeTab = useAssetsPanelStore((state) => state.setActiveTab);
	const setSelectedPresetId = useReframeStore(
		(state) => state.setSelectedPresetId,
	);
	const selectedSectionStartTimeByElementId = useReframeStore(
		(state) => state.selectedSectionStartTimeByElementId,
	);
	const setSelectedSectionStartTime = useReframeStore(
		(state) => state.setSelectedSectionStartTime,
	);
	const { selectedElements } = useElementSelection();
	const snappingEnabled = useTimelineStore((state) => state.snappingEnabled);
	const requestRevealMedia = useAssetsPanelStore((state) => state.requestRevealMedia);
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
	const normalizedVideoElement =
		element.type === "video" ? normalizeVideoReframeState({ element }) : null;
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
				{normalizedVideoElement &&
					(normalizedVideoElement.reframePresets?.length ?? 0) > 0 && (
						<>
							<ContextMenuSeparator />
							<ContextMenuItem
								icon={<Sparkles className="size-4" />}
								onSelect={(event) => {
									event.preventDefault();
									event.stopPropagation();
									openReframeTab("reframe");
									setSelectedPresetId({
										elementId: normalizedVideoElement.id,
										presetId:
											getSelectedOrActiveReframePresetId({
												element: normalizedVideoElement,
												localTime: Math.max(
													0,
													Math.min(
														normalizedVideoElement.duration,
														editor.playback.getCurrentTime() -
															normalizedVideoElement.startTime,
													),
												),
											}) ?? null,
									});
								}}
							>
								Open reframe controls
							</ContextMenuItem>
							<ContextMenuItem
								icon={<Clapperboard className="size-4" />}
								disabled={
									(normalizedVideoElement.reframeSwitches?.length ?? 0) === 0
								}
								onSelect={(event) => {
									event.preventDefault();
									event.stopPropagation();
									editor.timeline.clearVideoReframeSwitches({
										trackId: track.id,
										elementId: normalizedVideoElement.id,
									});
								}}
							>
								Clear angles
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
	const playbackTime = editor.playback.getCurrentTime();
	const openReframeTab = useAssetsPanelStore((state) => state.setActiveTab);
	const setSelectedPresetId = useReframeStore(
		(state) => state.setSelectedPresetId,
	);
	const selectedSectionStartTimeByElementId = useReframeStore(
		(state) => state.selectedSectionStartTimeByElementId,
	);
	const setSelectedSectionStartTime = useReframeStore(
		(state) => state.setSelectedSectionStartTime,
	);
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
		new Map<AnimationPropertyPath, HTMLDivElement>(),
	);
	const [easingMenu, setEasingMenu] = useState<{
		x: number;
		y: number;
		propertyPath: AnimationPropertyPath;
		keyframeId?: string;
	} | null>(null);
	const [draggingReframeMarker, setDraggingReframeMarker] = useState<{
		boundaryIndex: number;
		switchId: string | null;
		splitSectionId: string | null;
		time: number;
		pointerOffsetPx: number;
		minTime: number;
		maxTime: number;
	} | null>(null);
	const normalizedVideoElement = useMemo(
		() =>
			element.type === "video" ? normalizeVideoReframeState({ element }) : null,
		[element],
	);
	const displayedReframeSwitches = useMemo(() => {
		if (!normalizedVideoElement) return [];
		return (normalizedVideoElement.reframeSwitches ?? []).map((entry) =>
			entry.id === draggingReframeMarker?.switchId
				? { ...entry, time: draggingReframeMarker.time }
				: entry,
		);
	}, [normalizedVideoElement, draggingReframeMarker]);
	const displayedSplitSections = useMemo(() => {
		if (!normalizedVideoElement?.splitScreen) {
			return normalizedVideoElement?.splitScreen?.sections ?? [];
		}
		return (normalizedVideoElement.splitScreen.sections ?? []).map((section) =>
			section.id === draggingReframeMarker?.splitSectionId
				? { ...section, startTime: draggingReframeMarker.time }
				: section,
		);
	}, [normalizedVideoElement, draggingReframeMarker]);
	const displayedVideoElement = useMemo(() => {
		if (!normalizedVideoElement) return null;
		return {
			...normalizedVideoElement,
			reframeSwitches: displayedReframeSwitches,
			splitScreen: normalizedVideoElement.splitScreen
				? {
						...normalizedVideoElement.splitScreen,
						sections: displayedSplitSections,
				  }
				: undefined,
		};
	}, [normalizedVideoElement, displayedReframeSwitches, displayedSplitSections]);
	const activeReframePresetId = useMemo(() => {
		if (!displayedVideoElement) return null;
		return getActiveReframePresetId({
			element: displayedVideoElement,
			localTime: Math.max(
				0,
				Math.min(
					displayedVideoElement.duration,
					playbackTime - displayedVideoElement.startTime,
				),
			),
		});
	}, [displayedVideoElement, playbackTime]);
	const displayedAngleSections = useMemo(() => {
		if (!displayedVideoElement) return [];
		return deriveVideoAngleSections({
			element: displayedVideoElement,
		});
	}, [displayedVideoElement]);
	const displayedBoundaryMarkers = useMemo(
		() =>
			displayedVideoElement
				? deriveTimelineBoundaryMarkers({
						element: displayedVideoElement,
						sections: displayedAngleSections,
					})
				: [],
		[displayedVideoElement, displayedAngleSections],
	);
	const playheadAngleSection = useMemo(() => {
		if (!displayedVideoElement) return null;
		return getVideoAngleSectionAtTime({
			element: displayedVideoElement,
			localTime: Math.max(
				0,
				Math.min(
					displayedVideoElement.duration,
					playbackTime - displayedVideoElement.startTime,
				),
			),
		});
	}, [displayedVideoElement, playbackTime]);
	const activeSplitSection = useMemo(() => {
		if (!displayedVideoElement) return null;
		const section = getVideoSplitScreenSectionAtTime({
			element: displayedVideoElement,
			localTime: Math.max(
				0,
				Math.min(
					displayedVideoElement.duration,
					playbackTime - displayedVideoElement.startTime,
				),
			),
		});
		return section?.enabled === false ? null : section;
	}, [displayedVideoElement, playbackTime]);
	const selectedReframeSectionStartTime = normalizedVideoElement
		? editor.playback.getIsPlaying()
			? playheadAngleSection?.startTime ?? null
			: (() => {
					const selectedSection = getVideoAngleSectionByStartTime({
						element: displayedVideoElement ?? normalizedVideoElement,
						startTime:
							selectedSectionStartTimeByElementId[normalizedVideoElement.id] ??
							null,
					});
					const localTime = Math.max(
						0,
						Math.min(
							normalizedVideoElement.duration,
							playbackTime - normalizedVideoElement.startTime,
						),
					);
					const isPlayheadWithinSelectedSection = selectedSection
						? localTime >= selectedSection.startTime &&
							localTime <= selectedSection.endTime
						: false;
					return isPlayheadWithinSelectedSection
						? selectedSection?.startTime ?? playheadAngleSection?.startTime ?? null
						: (playheadAngleSection?.startTime ?? null);
				})()
		: null;
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

	useEffect(() => {
		if (!draggingReframeMarker || !containerElement || !normalizedVideoElement) {
			return;
		}

		const onMouseMove = (event: MouseEvent) => {
			const rect = containerElement.getBoundingClientRect();
			let nextTime = snapTimeToFrame({
				time: toLocalTimeFromClientX({
					clientX: event.clientX - draggingReframeMarker.pointerOffsetPx,
					containerRect: rect,
					duration: normalizedVideoElement.duration,
				}),
				fps: projectFps,
			});
			if (snappingEnabled) {
				const thresholdTime =
					rect.width > 0 ? (8 / rect.width) * normalizedVideoElement.duration : 0;
				const playheadLocalTime = Math.max(
					0,
					Math.min(
						normalizedVideoElement.duration,
						playbackTime - normalizedVideoElement.startTime,
					),
				);
				const playheadDistance = Math.abs(playheadLocalTime - nextTime);
				if (playheadDistance <= thresholdTime) {
					nextTime = playheadLocalTime;
				} else {
					const nearbyTimes = displayedBoundaryMarkers
						.filter(
							(_, index) => index !== draggingReframeMarker.boundaryIndex,
						)
						.map((marker) => marker.time);
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
			}
			nextTime = Math.max(
				draggingReframeMarker.minTime,
				Math.min(
					draggingReframeMarker.maxTime,
					nextTime,
				),
			);
			setDraggingReframeMarker((previous) =>
				previous
					? {
							...previous,
							time: Math.max(
								0,
								Math.min(normalizedVideoElement.duration, nextTime),
							),
					  }
					: previous,
			);
		};

		const onMouseUp = () => {
			const current = draggingReframeMarker;
			if (current) {
				if (current.switchId && current.splitSectionId) {
					editor.timeline.updateVideoReframeSwitch({
						trackId: track.id,
						elementId: element.id,
						switchId: current.switchId,
						updates: { time: current.time },
						pushHistory: false,
					});
					editor.timeline.updateVideoSplitScreenSection({
						trackId: track.id,
						elementId: element.id,
						sectionId: current.splitSectionId,
						updates: { startTime: current.time },
					});
				} else if (current.switchId) {
					editor.timeline.updateVideoReframeSwitch({
						trackId: track.id,
						elementId: element.id,
						switchId: current.switchId,
						updates: { time: current.time },
					});
				} else if (current.splitSectionId) {
					editor.timeline.updateVideoSplitScreenSection({
						trackId: track.id,
						elementId: element.id,
						sectionId: current.splitSectionId,
						updates: { startTime: current.time },
					});
				}
			}
			setDraggingReframeMarker(null);
		};

		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
		return () => {
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, [
		containerElement,
		displayedBoundaryMarkers,
		draggingReframeMarker,
		editor.timeline,
		element.id,
		normalizedVideoElement,
		playbackTime,
		projectFps,
		snappingEnabled,
		track.id,
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
			<div
				role="button"
				tabIndex={0}
				data-timeline-element-hit-target={element.id}
				data-visual-start-time={visualStartTime}
				data-visual-duration={visualDuration}
				className="absolute inset-0 size-full cursor-pointer"
				onClick={(e) => onElementClick(e, element)}
				onMouseDown={(e) => onElementMouseDown(e, element)}
				onKeyDown={(event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					onElementClick(event as unknown as React.MouseEvent, element);
				}}
			>
				<div className="absolute inset-0 flex h-full items-center">
						<ElementContent
							element={element}
							captureVideoElement={element.type === "video" ? normalizedVideoElement : null}
							displayedVideoSections={displayedAngleSections}
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
				{normalizedVideoElement &&
					isSelected &&
					normalizedVideoElement.reframePresets &&
					normalizedVideoElement.reframePresets.length > 0 && (
							<ReframeSwitchLane
								element={displayedVideoElement ?? normalizedVideoElement}
								sections={displayedAngleSections}
								boundaryMarkers={displayedBoundaryMarkers}
								activePresetId={activeReframePresetId}
								activeSplitSectionId={activeSplitSection?.id ?? null}
								selectedSectionStartTime={selectedReframeSectionStartTime}
							onMarkerMouseDown={({
								boundaryIndex,
								switchId,
								splitSectionId,
								time,
								pointerOffsetPx,
							}) =>
								(() => {
									const previousBoundaryTime =
										boundaryIndex > 0
											? displayedBoundaryMarkers[boundaryIndex - 1]?.time ?? 0
											: 0;
									const nextBoundaryTime =
										boundaryIndex >= 0
											? displayedBoundaryMarkers[boundaryIndex + 1]?.time ??
												normalizedVideoElement.duration
											: normalizedVideoElement.duration;
									setDraggingReframeMarker({
										boundaryIndex,
										switchId,
										splitSectionId,
										time,
										pointerOffsetPx,
										minTime:
											previousBoundaryTime + TIMELINE_SECTION_BOUNDARY_EPSILON,
										maxTime:
											nextBoundaryTime - TIMELINE_SECTION_BOUNDARY_EPSILON,
									});
								})()
							}
							onMarkerClick={({ presetId }) => {
								setSelectedPresetId({
									elementId: normalizedVideoElement.id,
									presetId,
								});
								openReframeTab("reframe");
							}}
							onSectionClick={({ startTime, presetId }) => {
								setSelectedSectionStartTime({
									elementId: normalizedVideoElement.id,
									startTime,
								});
								openReframeTab("reframe");
							}}
						/>
					)}

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
			</div>

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
								<div
									role="button"
									tabIndex={0}
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
									onKeyDown={(event) => {
										if (event.key !== "Enter" && event.key !== " ") return;
										event.preventDefault();
									}}
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
								</div>
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

function ReframeSwitchLane({
	element,
	sections,
	boundaryMarkers,
	activePresetId,
	activeSplitSectionId,
	selectedSectionStartTime,
	onMarkerMouseDown,
	onMarkerClick,
	onSectionClick,
}: {
	element: Extract<TimelineElementType, { type: "video" }>;
	sections: Array<{
		startTime: number;
		endTime: number;
		presetId: string | null;
		switchId: string | null;
		splitSectionId: string | null;
		isSplit: boolean;
	}>;
	boundaryMarkers: TimelineBoundaryMarker[];
	activePresetId: string | null;
	activeSplitSectionId: string | null;
	selectedSectionStartTime: number | null;
	onMarkerMouseDown: (params: {
		boundaryIndex: number;
		switchId: string | null;
		splitSectionId: string | null;
		time: number;
		pointerOffsetPx: number;
	}) => void;
	onMarkerClick: (params: { presetId: string }) => void;
	onSectionClick: (params: { startTime: number; presetId: string | null }) => void;
}) {
	return (
		<div className="pointer-events-none absolute inset-x-0 top-1 z-[3] h-5">
			<div className="relative h-full bg-black/35">
				{sections.map((section) => {
					const leftPercent =
						(section.startTime / Math.max(element.duration, 0.001)) * 100;
					const rightPercent =
						100 -
						(section.endTime / Math.max(element.duration, 0.001)) * 100;
					const isSelected =
						selectedSectionStartTime !== null &&
						Math.abs(selectedSectionStartTime - section.startTime) <= 1 / 1000;
					const isActive = section.isSplit
						? section.splitSectionId === activeSplitSectionId
						: section.presetId === activePresetId &&
							activeSplitSectionId === null;
					const presetName = section.isSplit
						? "Split Screen"
						: (element.reframePresets?.find(
								(preset) => preset.id === section.presetId,
						  )?.name ?? "Section");
					return (
						<button
							key={`${section.startTime}:${section.switchId ?? section.splitSectionId ?? "default"}`}
							type="button"
							className={cn(
								"pointer-events-auto absolute top-0 bottom-0 overflow-hidden border text-left",
								isSelected
									? "border-white/85 bg-white/32"
									: isActive
										? "border-white/45 bg-white/22"
										: section.isSplit
											? "border-sky-300/45 bg-sky-300/24"
											: "border-white/25 bg-black/20",
							)}
							style={{
								left: `${leftPercent}%`,
								right: `${rightPercent}%`,
							}}
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								onSectionClick({
									startTime: section.startTime,
									presetId: section.presetId,
								});
							}}
							title={presetName}
						>
							<div className="flex h-full items-center px-1.5">
								<span
									className={cn(
										"truncate text-[9px] font-medium",
										section.isSplit ? "text-sky-100/90" : "text-white/80",
									)}
								>
									{presetName}
								</span>
							</div>
						</button>
					);
				})}
				{boundaryMarkers.map((entry, boundaryIndex) => (
					<button
						key={`${entry.time}:${entry.switchId ?? "no-switch"}:${entry.splitSectionId ?? "no-split"}`}
						type="button"
						className="pointer-events-auto absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] border border-white/80 bg-white/80"
						style={{
							left: `${(entry.time / Math.max(element.duration, 0.001)) * 100}%`,
						}}
						onMouseDown={(event) => {
							event.preventDefault();
							event.stopPropagation();
							const rect = event.currentTarget.getBoundingClientRect();
							onMarkerMouseDown({
								boundaryIndex,
								switchId: entry.switchId,
								splitSectionId: entry.splitSectionId,
								time: entry.time,
								pointerOffsetPx:
									event.clientX - (rect.left + rect.width / 2),
							});
						}}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							if (entry.presetId) {
								onMarkerClick({ presetId: entry.presetId });
							}
						}}
						title={
							entry.isSplitToggle
								? "Single view marker"
								: entry.isSplit
								? "Split screen marker"
								: (element.reframePresets?.find((preset) => preset.id === entry.presetId)
										?.name ?? "Reframe marker")
						}
					/>
				))}
			</div>
		</div>
	);
}

function deriveTimelineBoundaryMarkers({
	element,
	sections,
}: {
	element: Extract<TimelineElementType, { type: "video" }>;
	sections: Array<{
		startTime: number;
		endTime: number;
		presetId: string | null;
		switchId: string | null;
		splitSectionId: string | null;
		isSplit: boolean;
	}>;
}) {
	const splitSectionByStartTime = new Map(
		(element.splitScreen?.sections ?? []).map((section) => [
			section.startTime.toFixed(3),
			section,
		]),
	);
	const reframeSwitchByTime = new Map(
		(element.reframeSwitches ?? []).map((entry) => [entry.time.toFixed(3), entry]),
	);

	return sections
		.slice(1)
		.map((section) => {
			const timeKey = section.startTime.toFixed(3);
			const splitSection =
				splitSectionByStartTime.get(timeKey) ??
				getVideoSplitScreenSectionByStartTime({
					element,
					startTime: section.startTime,
				});
			const reframeSwitch =
				reframeSwitchByTime.get(timeKey) ??
				(element.reframeSwitches ?? []).find(
					(entry) => Math.abs(entry.time - section.startTime) <= 1 / 1000,
				) ??
				null;
			return {
				time: section.startTime,
				switchId: reframeSwitch?.id ?? section.switchId,
				splitSectionId: splitSection?.id ?? section.splitSectionId,
				presetId: reframeSwitch?.presetId ?? section.presetId,
				isSplit:
					splitSection?.enabled !== false && Boolean(splitSection)
						? true
						: section.isSplit,
				isSplitToggle:
					splitSection !== null && splitSection !== undefined
						? splitSection.enabled === false
						: false,
			};
		})
		.filter((entry) => entry.switchId !== null || entry.splitSectionId !== null)
		.sort((left, right) => left.time - right.time);
}

function drawTimelineThumbnailFrame({
	context,
	source,
	sourceWidth,
	sourceHeight,
	rendererWidth,
	rendererHeight,
	transform,
	offsetX = 0,
	offsetY = 0,
}: {
	context: CanvasRenderingContext2D;
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
	rendererWidth: number;
	rendererHeight: number;
	transform: {
		position: { x: number; y: number };
		scale: number;
	};
	offsetX?: number;
	offsetY?: number;
}) {
	const placement = getTimelineVisualPlacement({
		rendererWidth,
		rendererHeight,
		sourceWidth,
		sourceHeight,
		transform,
		offsetX,
		offsetY,
	});
	context.drawImage(source, placement.x, placement.y, placement.width, placement.height);
}

function SectionThumbnailStrip({
	captureElement,
	displaySections,
	mediaAsset,
	trackHeight,
	insetY,
}: {
	captureElement: Extract<TimelineElementType, { type: "video" }>;
	displaySections: Array<{
		startTime: number;
		endTime: number;
		presetId: string | null;
		switchId: string | null;
		splitSectionId: string | null;
		isSplit: boolean;
	}>;
	mediaAsset: MediaAsset & { type: "video" };
	trackHeight: number;
	insetY: number;
}) {
	const editor = useEditor({ subscribeTo: ["project"] });
	const projectCanvas = editor.project.getActive().settings.canvasSize;
	const projectAspectRatio = Math.max(
		0.01,
		projectCanvas.width / Math.max(1, projectCanvas.height),
	);
	const tileHeight = Math.max(54, trackHeight);
	const tileWidth = Math.max(96, Math.round(tileHeight * projectAspectRatio));
	const renderScale = 2;
	const sections = displaySections;
	const fallbackThumbnailUrls = useMemo(
		() =>
			mediaAsset.thumbnailUrl
				? Object.fromEntries(
						sections.map((section) => [
							getTimelineSectionThumbnailKey(section),
							mediaAsset.thumbnailUrl as string,
						]),
					)
				: {},
		[mediaAsset.thumbnailUrl, sections],
	);
	const thumbnailCacheKey = useMemo(
		() =>
			JSON.stringify({
				elementId: captureElement.id,
				mediaId: mediaAsset.id,
				mediaUrl: mediaAsset.url,
				trackHeight,
				projectCanvas,
				trimStart: captureElement.trimStart,
				transform: captureElement.transform,
				defaultReframePresetId: captureElement.defaultReframePresetId ?? null,
				reframePresets: (captureElement.reframePresets ?? []).map((preset) => ({
					id: preset.id,
					transform: preset.transform,
				})),
				reframeSwitches: (captureElement.reframeSwitches ?? []).map((entry) => ({
					time: entry.time,
					presetId: entry.presetId,
				})),
				splitScreen: captureElement.splitScreen
					? {
							enabled: captureElement.splitScreen.enabled ?? false,
							layoutPreset: captureElement.splitScreen.layoutPreset,
							sections: (captureElement.splitScreen.sections ?? []).map((section) => ({
								startTime: section.startTime,
								enabled: section.enabled ?? true,
							})),
							slots: (captureElement.splitScreen.slots ?? []).map((slot) => ({
								slotId: slot.slotId,
								mode: slot.mode,
								presetId: slot.presetId ?? null,
								transformOverride: slot.transformOverride ?? null,
							})),
					  }
					: null,
				sections: sections.map((section) => ({
					key: getTimelineSectionThumbnailKey(section),
					presetId: section.presetId,
					isSplit: section.isSplit,
				})),
			}),
		[captureElement, mediaAsset.id, mediaAsset.url, projectCanvas, sections, trackHeight],
	);
	const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>(
		() =>
			timelineSectionThumbnailCache.get(thumbnailCacheKey) ??
			fallbackThumbnailUrls,
	);

	useEffect(() => {
		const cachedThumbnailUrls = timelineSectionThumbnailCache.get(thumbnailCacheKey);
		if (cachedThumbnailUrls) {
			setThumbnailUrls(cachedThumbnailUrls);
			return;
		}
		if (Object.keys(fallbackThumbnailUrls).length > 0) {
			setThumbnailUrls(fallbackThumbnailUrls);
		}
	}, [fallbackThumbnailUrls, thumbnailCacheKey]);

	useEffect(() => {
		if (!mediaAsset.url) return;
		if (timelineSectionThumbnailCache.has(thumbnailCacheKey)) return;
		let cancelled = false;
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.preload = "auto";
		video.src = mediaAsset.url;

		const waitForReady = () =>
			new Promise<void>((resolve, reject) => {
				if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
					resolve();
					return;
				}
				const onReady = () => {
					cleanup();
					resolve();
				};
				const onError = () => {
					cleanup();
					reject(new Error("Could not load video for timeline thumbnails"));
				};
				const cleanup = () => {
					video.removeEventListener("loadeddata", onReady);
					video.removeEventListener("loadedmetadata", onReady);
					video.removeEventListener("error", onError);
				};
				video.addEventListener("loadeddata", onReady);
				video.addEventListener("loadedmetadata", onReady);
				video.addEventListener("error", onError);
			});

		const seekTo = (time: number) =>
			new Promise<void>((resolve, reject) => {
				const onSeeked = () => {
					cleanup();
					resolve();
				};
				const onError = () => {
					cleanup();
					reject(new Error("Could not seek video for timeline thumbnails"));
				};
				const cleanup = () => {
					video.removeEventListener("seeked", onSeeked);
					video.removeEventListener("error", onError);
				};
				video.addEventListener("seeked", onSeeked);
				video.addEventListener("error", onError);
				video.currentTime = time;
			});

		const waitForRenderedFrame = () =>
			new Promise<void>((resolve) => {
				const finish = () => {
					requestAnimationFrame(() => {
						requestAnimationFrame(() => resolve());
					});
				};
				if (typeof video.requestVideoFrameCallback === "function") {
					video.requestVideoFrameCallback(() => finish());
					return;
				}
				finish();
			});

		const render = async () => {
			try {
				await waitForReady();
				const nextUrls: Record<string, string> = {};
				for (const section of sections) {
					const sectionKey = getTimelineSectionThumbnailKey(section);
					try {
						const sampleTime = Math.max(
							0,
							Math.min(
								captureElement.duration,
								section.startTime +
									Math.max(0.05, (section.endTime - section.startTime) / 2),
							),
						);
						const sourceTime = Math.max(
							0,
							Math.min(
								Math.max(video.duration || 0, 0.001),
								captureElement.trimStart + sampleTime,
							),
						);
						await seekTo(sourceTime);
						await waitForRenderedFrame();
						if (cancelled || video.videoWidth === 0 || video.videoHeight === 0) {
							continue;
						}
						const canvas = document.createElement("canvas");
						canvas.width = tileWidth * renderScale;
						canvas.height = tileHeight * renderScale;
						const context = canvas.getContext("2d");
						if (!context) continue;
						context.fillStyle = "#0a0a0a";
						context.fillRect(0, 0, canvas.width, canvas.height);
						if (section.isSplit) {
							const split = resolveVideoSplitScreenAtTime({
								element: captureElement,
								localTime: sampleTime,
							});
							if (split?.slots?.length) {
								const logicalViewports = getTimelineSplitViewports({
									width: projectCanvas.width,
									height: projectCanvas.height,
								});
								const viewports = getTimelineSplitViewports({
									width: canvas.width,
									height: canvas.height,
								});
								for (const slot of split.slots) {
									const logicalViewport = logicalViewports.get(slot.slotId);
									const viewport = viewports.get(slot.slotId);
									if (!viewport || !logicalViewport) {
										continue;
									}
									context.save();
									context.beginPath();
									context.rect(
										viewport.x,
										viewport.y,
										viewport.width,
										viewport.height,
									);
									context.clip();
									const transform = resolveVideoSplitScreenSlotTransform({
										baseTransform: captureElement.transform,
										duration: captureElement.duration,
										reframePresets: captureElement.reframePresets,
										reframeSwitches: captureElement.reframeSwitches,
										defaultReframePresetId: captureElement.defaultReframePresetId,
										localTime: sampleTime,
										slot,
									});
									const viewportAdjustedTransform =
										getTimelineViewportAdjustedTransform({
											transform,
											viewport: logicalViewport,
											rendererWidth: projectCanvas.width,
											rendererHeight: projectCanvas.height,
										});
									const scaledTransform = scaleTransformToThumbnailCanvas({
										transform: viewportAdjustedTransform,
										projectCanvas,
										rendererWidth: canvas.width,
										rendererHeight: canvas.height,
										});
									drawTimelineThumbnailFrame({
										context,
										source: video,
										sourceWidth: video.videoWidth,
										sourceHeight: video.videoHeight,
										rendererWidth: viewport.width,
										rendererHeight: viewport.height,
										transform: scaledTransform,
										offsetX: viewport.x,
										offsetY: viewport.y,
									});
									context.restore();
								}
							}
						} else {
							drawTimelineThumbnailFrame({
								context,
								source: video,
								sourceWidth: video.videoWidth,
								sourceHeight: video.videoHeight,
								rendererWidth: canvas.width,
								rendererHeight: canvas.height,
								transform: scaleTransformToThumbnailCanvas({
									transform: resolveVideoBaseTransformAtTime({
										element: captureElement,
										localTime: sampleTime,
									}),
									projectCanvas,
									rendererWidth: canvas.width,
									rendererHeight: canvas.height,
								}),
							});
						}
						nextUrls[sectionKey] = canvas.toDataURL(
							"image/jpeg",
							0.72,
						);
					} catch {
						const fallbackUrl =
							timelineSectionThumbnailCache.get(thumbnailCacheKey)?.[sectionKey] ??
							mediaAsset.thumbnailUrl ??
							null;
						if (fallbackUrl) {
							nextUrls[sectionKey] = fallbackUrl;
						}
					}
				}
				if (!cancelled && Object.keys(nextUrls).length > 0) {
					timelineSectionThumbnailCache.set(thumbnailCacheKey, nextUrls);
					setThumbnailUrls(nextUrls);
				}
			} catch {
				if (!cancelled && mediaAsset.thumbnailUrl) {
					const fallbackUrls = Object.fromEntries(
						sections.map((section) => [
							getTimelineSectionThumbnailKey(section),
							mediaAsset.thumbnailUrl as string,
						]),
					);
					timelineSectionThumbnailCache.set(thumbnailCacheKey, fallbackUrls);
					setThumbnailUrls(fallbackUrls);
				}
			}
		};

		void render();
		return () => {
			cancelled = true;
			video.pause();
			video.removeAttribute("src");
			video.load();
		};
	}, [
		captureElement,
		displaySections,
		mediaAsset.thumbnailUrl,
		mediaAsset.url,
		projectCanvas,
		sections,
		thumbnailCacheKey,
		tileHeight,
		tileWidth,
		trackHeight,
	]);

	return (
		<div className="flex size-full items-center justify-center">
			<div className="relative size-full">
				<div
					className="absolute inset-x-0"
					style={{
						top: insetY,
						bottom: insetY,
					}}
				>
					{sections.map((section) => {
						const leftPercent =
							(section.startTime / Math.max(captureElement.duration, 0.001)) * 100;
						const widthPercent =
							((section.endTime - section.startTime) /
								Math.max(captureElement.duration, 0.001)) *
							100;
						const key = getTimelineSectionThumbnailKey(section);
						const thumbnailUrl = thumbnailUrls[key] ?? mediaAsset.thumbnailUrl ?? "";
						return (
							<div
								key={key}
								className="absolute top-0 bottom-0 overflow-hidden border-r border-black/20"
								style={{
									left: `${leftPercent}%`,
									width: `${widthPercent}%`,
									backgroundImage: thumbnailUrl ? `url(${thumbnailUrl})` : "none",
									backgroundSize: `${tileWidth}px ${tileHeight}px`,
									backgroundRepeat: "repeat-x",
									backgroundPosition: "left center",
								}}
							/>
						);
					})}
				</div>
			</div>
		</div>
	);
}

function ElementContent({
	element,
	captureVideoElement,
	displayedVideoSections,
	track,
	isSelected,
	mediaAssets,
	getPersistedWaveformPeaks,
	onWaveformPeaksResolved,
}: {
	element: TimelineElementType;
	captureVideoElement: Extract<TimelineElementType, { type: "video" }> | null;
	displayedVideoSections: Array<{
		startTime: number;
		endTime: number;
		presetId: string | null;
		switchId: string | null;
		splitSectionId: string | null;
		isSplit: boolean;
	}>;
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
		const mediaAsset =
			element.sourceType === "upload"
				? mediaAssets.find((asset) => asset.id === element.mediaId)
				: undefined;

		const audioUrl =
			element.sourceType === "library"
				? element.sourceUrl
				: mediaAsset?.url;

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
							sourceDuration={mediaAsset?.duration ?? audioBuffer?.duration}
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
									? mediaAsset?.file
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

	if (mediaAsset.type === "image") {
		const trackHeight = getTrackHeight({ type: track.type });
		const tileWidth = Math.round(trackHeight * (16 / 9));
		const imageUrl = mediaAsset.url;

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
				</div>
			</div>
		);
	}

	if (mediaAsset.type === "video" && element.type === "video") {
		const videoMediaAsset = mediaAsset as MediaAsset & { type: "video" };
		return (
			<div className="relative flex size-full items-center justify-center">
				<SectionThumbnailStrip
					captureElement={captureVideoElement ?? element}
					displaySections={displayedVideoSections}
					mediaAsset={videoMediaAsset}
					trackHeight={getTrackHeight({ type: track.type })}
					insetY={isSelected ? 4 : 0}
				/>
				{mediaSupportsAudio({ media: videoMediaAsset }) && (
					<div className="pointer-events-none absolute right-1 bottom-0 left-1 z-[1]">
						<AudioWaveform
							audioUrl={videoMediaAsset.url}
							audioFile={videoMediaAsset.file}
							trimStart={element.trimStart}
							trimEnd={element.trimEnd}
							duration={element.duration}
							sourceDuration={videoMediaAsset.duration}
							cacheKey={`media:${videoMediaAsset.id}`}
							initialPeaks={getPersistedWaveformPeaks({
								cacheKey: `media:${videoMediaAsset.id}`,
							})}
							onPeaksResolved={(peaks) =>
								onWaveformPeaksResolved({
									cacheKey: `media:${videoMediaAsset.id}`,
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
