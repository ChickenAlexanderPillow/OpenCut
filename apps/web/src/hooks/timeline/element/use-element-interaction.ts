import {
	useState,
	useCallback,
	useEffect,
	useRef,
	type MouseEvent as ReactMouseEvent,
	type RefObject,
} from "react";
import { useEditor } from "@/hooks/use-editor";
import { useShiftKey } from "@/hooks/use-shift-key";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import {
	DRAG_THRESHOLD_PX,
	TIMELINE_CONSTANTS,
} from "@/constants/timeline-constants";
import { snapTimeToFrame } from "@/lib/time";
import { computeDropTarget } from "@/lib/timeline/drop-utils";
import { getMouseTimeFromClientX } from "@/lib/timeline/drag-utils";
import { generateUUID } from "@/utils/id";
import {
	snapElementEdge,
	type SnapPoint,
} from "@/lib/timeline/snap-utils";
import { useTimelineStore } from "@/stores/timeline-store";
import { TracksSnapshotCommand } from "@/lib/commands/timeline";
import { enforceMainTrackStart } from "@/lib/timeline/track-utils";
import { reconcileLinkedCaptionIntegrityInTracks } from "@/lib/transcript-editor/sync-captions";
import { isCaptionTimingRelativeToElement } from "@/lib/captions/timing";
import type {
	DropTarget,
	ElementDragState,
	TextElement,
	TimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";

interface UseElementInteractionProps {
	zoomLevel: number;
	timelineRef: RefObject<HTMLDivElement | null>;
	tracksContainerRef: RefObject<HTMLDivElement | null>;
	tracksScrollRef: RefObject<HTMLDivElement | null>;
	headerRef?: RefObject<HTMLElement | null>;
	snappingEnabled: boolean;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
	mapVisualTimeToRealTime?: (time: number) => number;
}

const initialDragState: ElementDragState = {
	isDragging: false,
	elementId: null,
	trackId: null,
	startMouseX: 0,
	startMouseY: 0,
	startElementTime: 0,
	clickOffsetTime: 0,
	currentTime: 0,
	currentMouseY: 0,
};

interface PendingDragState {
	elementId: string;
	trackId: string;
	startMouseX: number;
	startMouseY: number;
	startElementTime: number;
	clickOffsetTime: number;
}

function isVideoElement(element: TimelineElement): element is VideoElement {
	return element.type === "video";
}

function isTextElement(element: TimelineElement): element is TextElement {
	return element.type === "text";
}

function getDragCompanionElements({
	tracks,
	draggedTrackId,
	draggedElementId,
}: {
	tracks: TimelineTrack[];
	draggedTrackId: string;
	draggedElementId: string;
}): Array<{ trackId: string; elementId: string }> {
	const draggedTrack = tracks.find((track) => track.id === draggedTrackId);
	const draggedElement = draggedTrack?.elements.find(
		(element) => element.id === draggedElementId,
	);
	if (!draggedElement || !isVideoElement(draggedElement)) return [];

	const companions: Array<{ trackId: string; elementId: string }> = [];
	for (const track of tracks) {
		for (const element of track.elements) {
			if (element.id === draggedElementId && track.id === draggedTrackId) continue;
			if (
				isTextElement(element) &&
				element.captionSourceRef?.mediaElementId === draggedElement.id
			) {
				companions.push({ trackId: track.id, elementId: element.id });
			}
		}
	}
	return companions;
}

function getClickOffsetTime({
	clientX,
	elementRect,
	zoomLevel,
	visualStartTime,
	mapVisualTimeToRealTime,
}: {
	clientX: number;
	elementRect: DOMRect;
	zoomLevel: number;
	visualStartTime?: number;
	mapVisualTimeToRealTime?: (time: number) => number;
}): number {
	const clickOffsetX = clientX - elementRect.left;
	const visualOffsetTime =
		clickOffsetX / (TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel);
	if (typeof visualStartTime !== "number" || !mapVisualTimeToRealTime) {
		return visualOffsetTime;
	}
	const realTime = mapVisualTimeToRealTime(visualStartTime + visualOffsetTime);
	return Math.max(0, realTime - mapVisualTimeToRealTime(visualStartTime));
}

function getVerticalDragDirection({
	startMouseY,
	currentMouseY,
}: {
	startMouseY: number;
	currentMouseY: number;
}): "up" | "down" | null {
	if (currentMouseY < startMouseY) return "up";
	if (currentMouseY > startMouseY) return "down";
	return null;
}

function getDragDropTarget({
	clientX,
	clientY,
	elementId,
	trackId,
	tracks,
	tracksContainerRef,
	tracksScrollRef,
	headerRef,
	zoomLevel,
	snappedTime,
	verticalDragDirection,
}: {
	clientX: number;
	clientY: number;
	elementId: string;
	trackId: string;
	tracks: TimelineTrack[];
	tracksContainerRef: RefObject<HTMLDivElement | null>;
	tracksScrollRef: RefObject<HTMLDivElement | null>;
	headerRef?: RefObject<HTMLElement | null>;
	zoomLevel: number;
	snappedTime: number;
	verticalDragDirection?: "up" | "down" | null;
}): DropTarget | null {
	const containerRect = tracksContainerRef.current?.getBoundingClientRect();
	const scrollContainer = tracksScrollRef.current;
	if (!containerRect || !scrollContainer) return null;

	const sourceTrack = tracks.find(({ id }) => id === trackId);
	const movingElement = sourceTrack?.elements.find(
		({ id }) => id === elementId,
	);
	if (!movingElement) return null;

	const elementDuration = movingElement.duration;
	const scrollLeft = scrollContainer.scrollLeft;
	const scrollTop = scrollContainer.scrollTop;
	const scrollContainerRect = scrollContainer.getBoundingClientRect();
	const headerHeight = headerRef?.current?.getBoundingClientRect().height ?? 0;
	const mouseX = clientX - scrollContainerRect.left + scrollLeft;
	const mouseY = clientY - scrollContainerRect.top + scrollTop - headerHeight;

	return computeDropTarget({
		elementType: movingElement.type,
		mouseX,
		mouseY,
		tracks,
		playheadTime: snappedTime,
		isExternalDrop: false,
		elementDuration,
		pixelsPerSecond: TIMELINE_CONSTANTS.PIXELS_PER_SECOND,
		zoomLevel,
		startTimeOverride: snappedTime,
		excludeElementId: movingElement.id,
		verticalDragDirection,
	});
}

interface StartDragParams
	extends Omit<
		ElementDragState,
		"isDragging" | "currentTime" | "currentMouseY"
	> {
	initialCurrentTime: number;
	initialCurrentMouseY: number;
}

export function useElementInteraction({
	zoomLevel,
	timelineRef,
	tracksContainerRef,
	tracksScrollRef,
	headerRef,
	snappingEnabled,
	onSnapPointChange,
	mapVisualTimeToRealTime,
}: UseElementInteractionProps) {
	const editor = useEditor({ subscribeTo: ["timeline", "project"] });
	const rippleEditingEnabled = useTimelineStore((state) => state.rippleEditingEnabled);
	const isShiftHeldRef = useShiftKey();
	const tracks = editor.timeline.getTracks();
	const {
		isElementSelected,
		selectElement,
		handleElementClick: handleSelectionClick,
	} = useElementSelection();

	const [dragState, setDragState] =
		useState<ElementDragState>(initialDragState);
	const [dragDropTarget, setDragDropTarget] = useState<DropTarget | null>(null);
	const [isPendingDrag, setIsPendingDrag] = useState(false);
	const pendingDragRef = useRef<PendingDragState | null>(null);
	const lastMouseXRef = useRef(0);
	const mouseDownLocationRef = useRef<{ x: number; y: number } | null>(null);
	const lastProcessedMoveTsRef = useRef(0);

	const startDrag = useCallback(
		({
			elementId,
			trackId,
			startMouseX,
			startMouseY,
			startElementTime,
			clickOffsetTime,
			initialCurrentTime,
			initialCurrentMouseY,
		}: StartDragParams) => {
			setDragState({
				isDragging: true,
				elementId,
				trackId,
				startMouseX,
				startMouseY,
				startElementTime,
				clickOffsetTime,
				currentTime: initialCurrentTime,
				currentMouseY: initialCurrentMouseY,
			});
		},
		[],
	);

	const endDrag = useCallback(() => {
		setDragState(initialDragState);
		setDragDropTarget(null);
	}, []);

	const getDragSnapResult = useCallback(
		({
			frameSnappedTime,
			movingElement,
		}: {
			frameSnappedTime: number;
			movingElement: TimelineElement | null | undefined;
		}) => {
			const shouldSnap = snappingEnabled && !isShiftHeldRef.current;
			if (!shouldSnap || !movingElement) {
				return { snappedTime: frameSnappedTime, snapPoint: null };
			}

			const elementDuration = movingElement.duration;
			const playheadTime = editor.playback.getCurrentTime();

			const startSnap = snapElementEdge({
				targetTime: frameSnappedTime,
				elementDuration,
				tracks,
				playheadTime,
				zoomLevel,
				excludeElementId: movingElement.id,
				snapToStart: true,
			});

			const endSnap = snapElementEdge({
				targetTime: frameSnappedTime,
				elementDuration,
				tracks,
				playheadTime,
				zoomLevel,
				excludeElementId: movingElement.id,
				snapToStart: false,
			});

			const snapResult =
				startSnap.snapDistance <= endSnap.snapDistance ? startSnap : endSnap;
			if (!snapResult.snapPoint) {
				return { snappedTime: frameSnappedTime, snapPoint: null };
			}

			return {
				snappedTime: snapResult.snappedTime,
				snapPoint: snapResult.snapPoint,
			};
		},
		[snappingEnabled, editor.playback, tracks, zoomLevel, isShiftHeldRef],
	);

	useEffect(() => {
		if (!dragState.isDragging && !isPendingDrag) return;

		const handleMouseMove = ({ clientX, clientY }: MouseEvent) => {
			const now = performance.now();
			if (now - lastProcessedMoveTsRef.current < 12) {
				return;
			}
			lastProcessedMoveTsRef.current = now;

			let startedDragThisEvent = false;
			const timeline = timelineRef.current;
			const scrollContainer = tracksScrollRef.current;
			if (!timeline || !scrollContainer) return;
			lastMouseXRef.current = clientX;

			if (isPendingDrag && pendingDragRef.current) {
				const deltaX = Math.abs(clientX - pendingDragRef.current.startMouseX);
				const deltaY = Math.abs(clientY - pendingDragRef.current.startMouseY);
				if (deltaX > DRAG_THRESHOLD_PX || deltaY > DRAG_THRESHOLD_PX) {
					const activeProject = editor.project.getActive();
					if (!activeProject) return;
					editor.playback.pause();
					const scrollLeft = scrollContainer.scrollLeft;
					const mouseTime = getMouseTimeFromClientX({
						clientX,
						containerRect: scrollContainer.getBoundingClientRect(),
						zoomLevel,
						scrollLeft,
						mapVisualTimeToRealTime,
					});
					const adjustedTime = Math.max(
						0,
						mouseTime - pendingDragRef.current.clickOffsetTime,
					);
					const snappedTime = snapTimeToFrame({
						time: adjustedTime,
						fps: activeProject.settings.fps,
					});
					startDrag({
						...pendingDragRef.current,
						initialCurrentTime: snappedTime,
						initialCurrentMouseY: clientY,
					});
					startedDragThisEvent = true;
					pendingDragRef.current = null;
					setIsPendingDrag(false);
				} else {
					return;
				}
			}

			if (startedDragThisEvent) {
				return;
			}

			if (dragState.elementId && dragState.trackId) {
				const alreadySelected = isElementSelected({
					trackId: dragState.trackId,
					elementId: dragState.elementId,
				});
				if (!alreadySelected) {
					selectElement({
						trackId: dragState.trackId,
						elementId: dragState.elementId,
					});
				}
			}

			const activeProject = editor.project.getActive();
			if (!activeProject) return;

			const scrollLeft = scrollContainer.scrollLeft;
			const mouseTime = getMouseTimeFromClientX({
				clientX,
				containerRect: scrollContainer.getBoundingClientRect(),
				zoomLevel,
				scrollLeft,
				mapVisualTimeToRealTime,
			});
			const adjustedTime = Math.max(0, mouseTime - dragState.clickOffsetTime);
			const fps = activeProject.settings.fps;
			const frameSnappedTime = snapTimeToFrame({ time: adjustedTime, fps });

			const sourceTrack = tracks.find(({ id }) => id === dragState.trackId);
			const movingElement = sourceTrack?.elements.find(
				({ id }) => id === dragState.elementId,
			);
			const { snappedTime, snapPoint } = getDragSnapResult({
				frameSnappedTime,
				movingElement,
			});
			setDragState((previousDragState) => ({
				...previousDragState,
				currentTime: snappedTime,
				currentMouseY: clientY,
			}));
			onSnapPointChange?.(snapPoint);

			if (dragState.elementId && dragState.trackId) {
				const verticalDragDirection = getVerticalDragDirection({
					startMouseY: dragState.startMouseY,
					currentMouseY: clientY,
				});
				const dropTarget = getDragDropTarget({
					clientX,
					clientY,
					elementId: dragState.elementId,
					trackId: dragState.trackId,
					tracks,
					tracksContainerRef,
					tracksScrollRef,
					headerRef,
					zoomLevel,
					snappedTime,
					verticalDragDirection,
				});
				setDragDropTarget(dropTarget?.isNewTrack ? dropTarget : null);
			}
		};

		document.addEventListener("mousemove", handleMouseMove);
		return () => document.removeEventListener("mousemove", handleMouseMove);
	}, [
		dragState.isDragging,
		dragState.clickOffsetTime,
		dragState.elementId,
		dragState.startMouseY,
		dragState.trackId,
		zoomLevel,
		isElementSelected,
		selectElement,
		editor.playback,
		editor.project,
		timelineRef,
		tracksScrollRef,
		tracksContainerRef,
		headerRef,
		tracks,
		isPendingDrag,
		startDrag,
		getDragSnapResult,
		onSnapPointChange,
		mapVisualTimeToRealTime,
	]);

	useEffect(() => {
		if (!dragState.isDragging) return;

		const handleMouseUp = ({ clientX, clientY }: MouseEvent) => {
			if (!dragState.elementId || !dragState.trackId) return;

			if (mouseDownLocationRef.current) {
				const deltaX = Math.abs(clientX - mouseDownLocationRef.current.x);
				const deltaY = Math.abs(clientY - mouseDownLocationRef.current.y);
				if (deltaX <= DRAG_THRESHOLD_PX && deltaY <= DRAG_THRESHOLD_PX) {
					mouseDownLocationRef.current = null;
					endDrag();
					onSnapPointChange?.(null);
					return;
				}
			}

			const dropTarget = getDragDropTarget({
				clientX,
				clientY,
				elementId: dragState.elementId,
				trackId: dragState.trackId,
				tracks,
				tracksContainerRef,
				tracksScrollRef,
				headerRef,
				zoomLevel,
				snappedTime: dragState.currentTime,
				verticalDragDirection: getVerticalDragDirection({
					startMouseY: dragState.startMouseY,
					currentMouseY: clientY,
				}),
			});
			if (!dropTarget) {
				endDrag();
				onSnapPointChange?.(null);
				return;
			}
			const snappedTime = dragState.currentTime;

			const sourceTrack = tracks.find(({ id }) => id === dragState.trackId);
			if (!sourceTrack) {
				endDrag();
				onSnapPointChange?.(null);
				return;
			}

			const companionElements = getDragCompanionElements({
				tracks,
				draggedTrackId: dragState.trackId,
				draggedElementId: dragState.elementId,
			});
			if (companionElements.length > 0) {
				const selection = [
					{ trackId: dragState.trackId, elementId: dragState.elementId },
					...companionElements,
				];
				const records = selection
					.map(({ trackId, elementId }) => {
						const track = tracks.find((candidate) => candidate.id === trackId);
						const element = track?.elements.find(
							(candidate) => candidate.id === elementId,
						);
						return track && element ? { track, element } : null;
					})
					.filter((record): record is NonNullable<typeof record> => record !== null);

				const draggedRecord = records.find(
					(record) =>
						record.track.id === dragState.trackId &&
						record.element.id === dragState.elementId,
				);
				if (!draggedRecord) {
					endDrag();
					onSnapPointChange?.(null);
					return;
				}

				const requestedPrimaryStart = Math.max(0, snappedTime);
				const adjustedPrimaryStart = enforceMainTrackStart({
					tracks,
					targetTrackId: draggedRecord.track.id,
					requestedStartTime: requestedPrimaryStart,
					excludeElementId: draggedRecord.element.id,
				});
				const shiftDelta = adjustedPrimaryStart - draggedRecord.element.startTime;
				if (Math.abs(shiftDelta) > 0.0001) {
					const updatesByTrack = new Map<string, Map<string, number>>();
					for (const record of records) {
						const nextStart = Math.max(0, record.element.startTime + shiftDelta);
						const perTrack =
							updatesByTrack.get(record.track.id) ?? new Map<string, number>();
						perTrack.set(record.element.id, nextStart);
						updatesByTrack.set(record.track.id, perTrack);
					}
					const nextTracks = tracks.map((track) => {
						const perTrack = updatesByTrack.get(track.id);
						if (!perTrack) return track;
						const nextElements = track.elements.map((element) =>
							perTrack.has(element.id)
								? (() => {
										const nextStartTime = perTrack.get(element.id) ?? element.startTime;
										if (element.type !== "text") {
											return { ...element, startTime: nextStartTime };
										}
										const existingTimings = element.captionWordTimings ?? [];
										const timingsAreRelative = isCaptionTimingRelativeToElement({
											timings: existingTimings,
											elementDuration: element.duration,
										});
										const startDelta = nextStartTime - element.startTime;
										const nextTimings =
											existingTimings.length === 0 ||
											timingsAreRelative ||
											Math.abs(startDelta) < 1e-6
												? existingTimings
												: existingTimings.map((timing) => ({
														word: timing.word,
														startTime: timing.startTime + startDelta,
														endTime: timing.endTime + startDelta,
												  }));
										return {
											...element,
											startTime: nextStartTime,
											captionWordTimings: nextTimings,
										};
								  })()
								: element,
						);
						return { ...track, elements: nextElements } as TimelineTrack;
					});
					const reconciled = reconcileLinkedCaptionIntegrityInTracks({
						beforeTracks: tracks,
						tracks: nextTracks,
					});
					editor.command.execute({
						command: new TracksSnapshotCommand(tracks, reconciled.tracks),
					});
				}
				endDrag();
				onSnapPointChange?.(null);
				return;
			}

			if (dropTarget.isNewTrack) {
				const newTrackId = generateUUID();

				editor.timeline.moveElement({
					sourceTrackId: dragState.trackId,
					targetTrackId: newTrackId,
					elementId: dragState.elementId,
					newStartTime: snappedTime,
					createTrack: { type: sourceTrack.type, index: dropTarget.trackIndex },
					rippleEnabled: rippleEditingEnabled,
				});
			} else {
				const targetTrack = tracks[dropTarget.trackIndex];
				if (targetTrack) {
					editor.timeline.moveElement({
						sourceTrackId: dragState.trackId,
						targetTrackId: targetTrack.id,
						elementId: dragState.elementId,
						newStartTime: snappedTime,
						rippleEnabled: rippleEditingEnabled,
					});
				}
			}

			endDrag();
			onSnapPointChange?.(null);
		};

		document.addEventListener("mouseup", handleMouseUp);
		return () => document.removeEventListener("mouseup", handleMouseUp);
	}, [
		dragState.isDragging,
		dragState.elementId,
		dragState.startMouseY,
		dragState.trackId,
		dragState.currentTime,
		zoomLevel,
		tracks,
		endDrag,
		onSnapPointChange,
		editor.timeline,
		editor.command,
		tracksContainerRef,
		tracksScrollRef,
		headerRef,
		rippleEditingEnabled,
	]);

	useEffect(() => {
		if (!isPendingDrag) return;

		const handleMouseUp = () => {
			pendingDragRef.current = null;
			setIsPendingDrag(false);
			onSnapPointChange?.(null);
		};

		document.addEventListener("mouseup", handleMouseUp);
		return () => document.removeEventListener("mouseup", handleMouseUp);
	}, [isPendingDrag, onSnapPointChange]);

	const handleElementMouseDown = useCallback(
		({
			event,
			element,
			track,
		}: {
			event: ReactMouseEvent;
			element: TimelineElement;
			track: TimelineTrack;
		}) => {
			const isRightClick = event.button === 2;

			// right-click: don't stop propagation so ContextMenu can open
			if (isRightClick) {
				const alreadySelected = isElementSelected({
					trackId: track.id,
					elementId: element.id,
				});
				if (!alreadySelected) {
					handleSelectionClick({
						trackId: track.id,
						elementId: element.id,
						isMultiKey: false,
					});
				}
				return;
			}

			// left-click: stop propagation for drag operations
			event.stopPropagation();
			mouseDownLocationRef.current = { x: event.clientX, y: event.clientY };

			const isMultiSelect = event.metaKey || event.ctrlKey || event.shiftKey;

			// multi-select: toggle selection
			if (isMultiSelect) {
				handleSelectionClick({
					trackId: track.id,
					elementId: element.id,
					isMultiKey: true,
				});
			}

			// start drag
			const clickOffsetTime = getClickOffsetTime({
				clientX: event.clientX,
				elementRect: event.currentTarget.getBoundingClientRect(),
				zoomLevel,
				visualStartTime: Number(
					event.currentTarget.getAttribute("data-visual-start-time"),
				),
				mapVisualTimeToRealTime,
			});
			pendingDragRef.current = {
				elementId: element.id,
				trackId: track.id,
				startMouseX: event.clientX,
				startMouseY: event.clientY,
				startElementTime: element.startTime,
				clickOffsetTime,
			};
			setIsPendingDrag(true);
		},
		[
			zoomLevel,
			isElementSelected,
			handleSelectionClick,
			mapVisualTimeToRealTime,
		],
	);

	const handleElementClick = useCallback(
		({
			event,
			element,
			track,
		}: {
			event: ReactMouseEvent;
			element: TimelineElement;
			track: TimelineTrack;
		}) => {
			event.stopPropagation();

			// was it a drag or a click?
			if (mouseDownLocationRef.current) {
				const deltaX = Math.abs(event.clientX - mouseDownLocationRef.current.x);
				const deltaY = Math.abs(event.clientY - mouseDownLocationRef.current.y);
				if (deltaX > DRAG_THRESHOLD_PX || deltaY > DRAG_THRESHOLD_PX) {
					mouseDownLocationRef.current = null;
					return;
				}
			}

			// modifier keys already handled in mousedown
			if (event.metaKey || event.ctrlKey || event.shiftKey) return;

			// single click: select if not selected
			const alreadySelected = isElementSelected({
				trackId: track.id,
				elementId: element.id,
			});
			if (!alreadySelected) {
				selectElement({ trackId: track.id, elementId: element.id });
			}
		},
		[isElementSelected, selectElement],
	);

	return {
		dragState,
		dragDropTarget,
		handleElementMouseDown,
		handleElementClick,
		lastMouseXRef,
	};
}
