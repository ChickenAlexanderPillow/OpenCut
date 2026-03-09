"use client";

import { useEffect, useMemo, useState, type ComponentProps } from "react";
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

function getVisibleTranscriptCutOverlays({
	element,
}: {
	element: TimelineElementType;
}): Array<{ leftPercent: number; widthPercent: number }> {
	if (!isTranscriptMediaElement(element)) return [];
	const cuts = element.transcriptEdit?.cuts ?? [];
	if (cuts.length === 0 || element.duration <= 0) return [];

	const visibleStart = element.trimStart;
	const visibleEnd = element.trimStart + element.duration;
	const overlays: Array<{ leftPercent: number; widthPercent: number }> = [];

	for (const cut of cuts) {
		const start = Math.max(visibleStart, cut.start);
		const end = Math.min(visibleEnd, cut.end);
		if (end - start <= 0) continue;
		overlays.push({
			leftPercent: ((start - visibleStart) / element.duration) * 100,
			widthPercent: ((end - start) / element.duration) * 100,
		});
	}
	return overlays;
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

interface TimelineElementProps {
	element: TimelineElementType;
	track: TimelineTrack;
	zoomLevel: number;
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
	zoomLevel,
	isSelected,
	onSnapPointChange,
	onResizeStateChange,
	onElementMouseDown,
	onElementClick,
	dragState,
}: TimelineElementProps) {
	const editor = useEditor({ subscribeTo: ["media", "project"] });
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
	const elementWidth =
		displayedDuration * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;
	const elementLeft = displayedStartTime * 50 * zoomLevel;

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
					className={`absolute top-0 h-full select-none`}
					style={{
						left: `${elementLeft}px`,
						width: `${elementWidth}px`,
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
						isSelected={isSelected}
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
	isSelected,
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
	isSelected: boolean;
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
	const transcriptCutOverlays = getVisibleTranscriptCutOverlays({ element });
	const isVisual = isVisualTimelineElement(element);
	const elementKeyframes = useMemo(
		() =>
			isVisual ? getElementKeyframes({ animations: element.animations }) : [],
		[isVisual, element.animations],
	);
	const hasAnyKeyframes = isVisual
		? getElementKeyframes({ animations: element.animations }).length > 0
		: false;
	const [selectedKeyframe, setSelectedKeyframe] = useState<{
		propertyPath: AnimationPropertyPath;
		keyframeId: string;
	} | null>(null);
	const [draggingKeyframe, setDraggingKeyframe] = useState<{
		propertyPath: AnimationPropertyPath;
		keyframeId: string;
		time: number;
	} | null>(null);
	const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(
		null,
	);
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

	useEffect(() => {
		if (isSelected) return;
		setSelectedKeyframe(null);
		setDraggingKeyframe(null);
	}, [isSelected]);

	useEffect(() => {
		if (!selectedKeyframe || !isSelected) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			event.preventDefault();
			editor.timeline.removeKeyframes({
				keyframes: [
					{
						trackId: track.id,
						elementId: element.id,
						propertyPath: selectedKeyframe.propertyPath,
						keyframeId: selectedKeyframe.keyframeId,
					},
				],
			});
			setSelectedKeyframe(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [editor.timeline, track.id, element.id, selectedKeyframe, isSelected]);

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
			const rect = containerElement.getBoundingClientRect();
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
		const rawTime = toLocalTimeFromClientX({
			clientX: event.clientX,
			containerRect: containerElement.getBoundingClientRect(),
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
		setSelectedKeyframe({ propertyPath, keyframeId });
		setDraggingKeyframe({
			propertyPath,
			keyframeId,
			time,
		});
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
				{transcriptCutOverlays.map((overlay) => (
					<div
						key={`${overlay.leftPercent.toFixed(3)}:${overlay.widthPercent.toFixed(3)}`}
						className="pointer-events-none absolute top-0 bottom-0 bg-black/35"
						style={{
							left: `${overlay.leftPercent}%`,
							width: `${overlay.widthPercent}%`,
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
					{TIMELINE_KEYFRAME_PATHS.map((propertyPath) => {
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
									className={`relative h-1.5 flex-1 rounded ${isSelected ? "pointer-events-auto bg-black/35" : "pointer-events-none bg-black/25"}`}
									onMouseDown={(event) =>
										onLaneMouseDown({ event, propertyPath })
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
											selectedKeyframe?.keyframeId === keyframe.id &&
											selectedKeyframe.propertyPath === propertyPath;
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
		const tileWidth = trackHeight * (16 / 9);
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
