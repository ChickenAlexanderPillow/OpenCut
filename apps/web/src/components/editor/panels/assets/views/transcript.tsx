"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { useEditor } from "@/hooks/use-editor";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { invokeAction } from "@/lib/actions";
import {
	applyCutRangesToWords,
	buildTranscriptCutsFromWords,
	mapCompressedTimeToSourceTime,
	normalizeTranscriptWords,
} from "@/lib/transcript-editor/core";
import { DEFAULT_PAUSE_REMOVAL_MIN_GAP_SECONDS } from "@/lib/transcript-editor/constants";
import { toElementLocalCaptionTime } from "@/lib/captions/timing";
import type {
	AudioElement,
	TextElement,
	TimelineElement,
	VideoElement,
} from "@/types/timeline";
import type { TranscriptEditWord } from "@/types/transcription";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { AlignJustify, Check, Pencil, X } from "lucide-react";

type MediaRef = {
	trackId: string;
	element: VideoElement | AudioElement;
};

function formatTime(time: number): string {
	const total = Math.max(0, Math.floor(time));
	const mins = Math.floor(total / 60)
		.toString()
		.padStart(2, "0");
	const secs = (total % 60).toString().padStart(2, "0");
	return `${mins}:${secs}`;
}

function isMediaElement(
	element: TimelineElement,
): element is VideoElement | AudioElement {
	return element.type === "video" || element.type === "audio";
}

function getFallbackWordsFromCaptions({
	tracks,
	mediaElementId,
}: {
	tracks: ReturnType<ReturnType<typeof useEditor>["timeline"]["getTracks"]>;
	mediaElementId: string;
}): TranscriptEditWord[] {
	const matched = tracks
		.flatMap((track) => (track.type === "text" ? track.elements : []))
		.find((element) => {
			if (element.type !== "text") return false;
			if ((element.captionWordTimings?.length ?? 0) === 0) return false;
			if (element.captionSourceRef?.mediaElementId) {
				return element.captionSourceRef.mediaElementId === mediaElementId;
			}
			return true;
		});
	if (!matched || (matched.captionWordTimings?.length ?? 0) === 0) return [];
	return normalizeTranscriptWords({
		words: (matched.captionWordTimings ?? []).map((timing, index) => ({
			id: `${mediaElementId}:fallback:${index}:${timing.startTime.toFixed(3)}`,
			text: timing.word,
			startTime: timing.startTime,
			endTime: timing.endTime,
			removed: false,
		})),
	});
}

function getActiveMediaRef({
	tracks,
	selectedElements,
}: {
	tracks: ReturnType<ReturnType<typeof useEditor>["timeline"]["getTracks"]>;
	selectedElements: Array<{ trackId: string; elementId: string }>;
}): MediaRef | null {
	for (const selected of selectedElements) {
		const track = tracks.find((item) => item.id === selected.trackId);
		const element = track?.elements.find(
			(item) => item.id === selected.elementId,
		);
		if (element && isMediaElement(element)) {
			return { trackId: selected.trackId, element };
		}
	}
	for (const track of tracks) {
		for (const element of track.elements) {
			if (isMediaElement(element)) return { trackId: track.id, element };
		}
	}
	return null;
}

function getMediaRefById({
	tracks,
	mediaElementId,
}: {
	tracks: ReturnType<ReturnType<typeof useEditor>["timeline"]["getTracks"]>;
	mediaElementId: string;
}): MediaRef | null {
	for (const track of tracks) {
		for (const element of track.elements) {
			if (!isMediaElement(element)) continue;
			if (element.id !== mediaElementId) continue;
			return { trackId: track.id, element };
		}
	}
	return null;
}

function getSelectedCaptionElement({
	tracks,
	selectedElements,
}: {
	tracks: ReturnType<ReturnType<typeof useEditor>["timeline"]["getTracks"]>;
	selectedElements: Array<{ trackId: string; elementId: string }>;
}): { trackId: string; element: TextElement } | null {
	for (const selected of selectedElements) {
		const track = tracks.find((item) => item.id === selected.trackId);
		if (!track || track.type !== "text") continue;
		const element = track.elements.find((item) => item.id === selected.elementId);
		if (!element || element.type !== "text") continue;
		if ((element.captionWordTimings?.length ?? 0) === 0) continue;
		return { trackId: selected.trackId, element };
	}
	return null;
}

function buildDefaultSegmentGroups({
	words,
}: {
	words: TranscriptEditWord[];
}): Array<{ id: string; words: TranscriptEditWord[] }> {
	if (words.length === 0) return [];
	const groups: Array<{ id: string; words: TranscriptEditWord[] }> = [];
	let startIndex = 0;
	const MAX_WORDS_PER_SEGMENT = 20;
	const SEGMENT_GAP_SECONDS = 0.65;

	for (let index = 0; index < words.length - 1; index++) {
		const current = words[index];
		const next = words[index + 1];
		const gap = Math.max(0, next.startTime - current.endTime);
		const endsPhrase = /[.!?,:;]$/.test(current.text.trim());
		const reachedWordLimit = index - startIndex + 1 >= MAX_WORDS_PER_SEGMENT;
		if (gap >= SEGMENT_GAP_SECONDS || endsPhrase || reachedWordLimit) {
			groups.push({
				id: `auto:${groups.length}`,
				words: words.slice(startIndex, index + 1),
			});
			startIndex = index + 1;
		}
	}
	groups.push({
		id: `auto:${groups.length}`,
		words: words.slice(startIndex),
	});
	return groups.filter((group) => group.words.length > 0);
}

export function TranscriptView() {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const tracks = editor.timeline.getTracks();
	const currentTime = editor.playback.getCurrentTime();
	const [editingWordId, setEditingWordId] = useState<string | null>(null);
	const [editingWordText, setEditingWordText] = useState("");
	const [editingTargetWordIds, setEditingTargetWordIds] = useState<string[]>([]);
	const [selectedWordIds, setSelectedWordIds] = useState<string[]>([]);
	const [isSelectionActive, setIsSelectionActive] = useState(false);
	const [hoveredWordId, setHoveredWordId] = useState<string | null>(null);
	const selectionContainerRef = useRef<HTMLDivElement | null>(null);
	const activeMediaRef = useRef<MediaRef | null>(null);
	const orderedWordIdsRef = useRef<string[]>([]);
	const editingWordIdRef = useRef<string | null>(null);
	const selectedWordIdsRef = useRef<string[]>([]);
	const selectedCaption = useMemo(
		() => getSelectedCaptionElement({ tracks, selectedElements }),
		[tracks, selectedElements],
	);

	const activeMedia = useMemo(() => {
		const sourceMediaId =
			selectedCaption?.element.captionSourceRef?.mediaElementId ?? null;
		if (sourceMediaId) {
			const sourceMedia = getMediaRefById({
				tracks,
				mediaElementId: sourceMediaId,
			});
			if (sourceMedia) return sourceMedia;
		}
		return getActiveMediaRef({ tracks, selectedElements });
	}, [tracks, selectedElements, selectedCaption]);

	const words = useMemo(() => {
		if (!activeMedia) return [];
		const fromElement = activeMedia.element.transcriptEdit?.words ?? [];
		if (fromElement.length > 0)
			return normalizeTranscriptWords({ words: fromElement });
		return getFallbackWordsFromCaptions({
			tracks,
			mediaElementId: activeMedia.element.id,
		});
	}, [activeMedia, tracks]);

	const cuts = useMemo(
		() =>
			activeMedia?.element.transcriptEdit?.cuts ??
			buildTranscriptCutsFromWords({ words }),
		[activeMedia, words],
	);
	const wordsWithCutState = useMemo(
		() =>
			applyCutRangesToWords({
				words,
				cuts,
			}),
		[words, cuts],
	);

	const currentWordId = useMemo(() => {
		if (!activeMedia || wordsWithCutState.length === 0) return null;
		const localCompressed = Math.max(
			0,
			currentTime - activeMedia.element.startTime,
		);
		const sourceTime = mapCompressedTimeToSourceTime({
			compressedTime: localCompressed,
			cuts,
		});
		const current = wordsWithCutState.find(
			(word) =>
				!word.removed &&
				sourceTime >= word.startTime &&
				sourceTime < word.endTime,
		);
		return current?.id ?? null;
	}, [activeMedia, wordsWithCutState, cuts, currentTime]);

	const segmentsUi = activeMedia?.element.transcriptEdit?.segmentsUi;
	const groups =
		segmentsUi && segmentsUi.length > 0
			? segmentsUi
					.map((segment) => ({
						id: segment.id,
						words: wordsWithCutState.slice(
							segment.wordStartIndex,
							segment.wordEndIndex + 1,
						),
					}))
					.filter((group) => group.words.length > 0)
			: buildDefaultSegmentGroups({ words: wordsWithCutState });

	const orderedWordIds = useMemo(
		() => groups.flatMap((group) => group.words.map((word) => word.id)),
		[groups],
	);
	const selectedCaptionWordIds = useMemo(() => {
		if (!selectedCaption || !activeMedia) return new Set<string>();
		if (
			selectedCaption.element.captionSourceRef?.mediaElementId &&
			selectedCaption.element.captionSourceRef.mediaElementId !== activeMedia.element.id
		) {
			return new Set<string>();
		}
		const timings = selectedCaption.element.captionWordTimings ?? [];
		if (timings.length === 0) return new Set<string>();
		const ranges = timings.map((timing) => ({
			start: mapCompressedTimeToSourceTime({
				compressedTime: toElementLocalCaptionTime({
					time: timing.startTime,
					elementStartTime: selectedCaption.element.startTime,
					timings,
					elementDuration: selectedCaption.element.duration,
				}),
				cuts,
			}),
			end: mapCompressedTimeToSourceTime({
				compressedTime: toElementLocalCaptionTime({
					time: timing.endTime,
					elementStartTime: selectedCaption.element.startTime,
					timings,
					elementDuration: selectedCaption.element.duration,
				}),
				cuts,
			}),
		}));
		const highlighted = wordsWithCutState
			.filter((word) =>
				ranges.some(
					(range) => word.endTime > range.start && word.startTime < range.end,
				),
			)
			.map((word) => word.id);
		return new Set(highlighted);
	}, [selectedCaption, activeMedia, cuts, wordsWithCutState]);
	const selectedWordIdsSet = useMemo(
		() => new Set(selectedWordIds),
		[selectedWordIds],
	);

	useEffect(() => {
		if (!editingWordId) return;
		if (!wordsWithCutState.some((word) => word.id === editingWordId)) {
			setEditingWordId(null);
			setEditingWordText("");
			setEditingTargetWordIds([]);
		}
	}, [editingWordId, wordsWithCutState]);

	const setSelectedWordIdsIfChanged = useCallback((next: string[]) => {
		setSelectedWordIds((previous) => {
			if (
				previous.length === next.length &&
				previous.every((value, index) => value === next[index])
			) {
				return previous;
			}
			return next;
		});
	}, []);

	useEffect(() => {
		activeMediaRef.current = activeMedia;
	}, [activeMedia]);

	useEffect(() => {
		orderedWordIdsRef.current = orderedWordIds;
	}, [orderedWordIds]);

	useEffect(() => {
		editingWordIdRef.current = editingWordId;
	}, [editingWordId]);

	useEffect(() => {
		selectedWordIdsRef.current = selectedWordIds;
	}, [selectedWordIds]);

	useEffect(() => {
		const captureSelectionWords = () => {
			const container = selectionContainerRef.current;
			if (!container) {
				setSelectedWordIdsIfChanged([]);
				setIsSelectionActive(false);
				return;
			}
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) {
				setIsSelectionActive(false);
				return;
			}
			if (selection.isCollapsed) {
				setIsSelectionActive(false);
				return;
			}
			if (
				!container.contains(selection.anchorNode) ||
				!container.contains(selection.focusNode)
			) {
				setIsSelectionActive(false);
				return;
			}
			const range = selection.getRangeAt(0);
			const wordNodes = Array.from(
				container.querySelectorAll<HTMLElement>("[data-word-id]"),
			);
			const selectedIds = wordNodes
				.filter((node) => range.intersectsNode(node))
				.map((node) => node.dataset.wordId ?? "")
			.filter((id) => id.length > 0);
			if (selectedIds.length === 0) {
				setIsSelectionActive(false);
				return;
			}
			const currentOrderedWordIds = orderedWordIdsRef.current;
			const selectedSet = new Set(selectedIds);
			setSelectedWordIdsIfChanged(
				currentOrderedWordIds.filter((id) => selectedSet.has(id)),
			);
			setIsSelectionActive(true);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.key !== "Backspace" &&
				event.key !== "Delete"
			) {
				return;
			}
			if (editingWordIdRef.current) return;
			const container = selectionContainerRef.current;
			const currentSelectedWordIds = selectedWordIdsRef.current;
			const currentActiveMedia = activeMediaRef.current;
			if (!container || !currentActiveMedia || currentSelectedWordIds.length === 0) {
				return;
			}
			const selection = window.getSelection();
			if (
				!selection ||
				selection.rangeCount === 0 ||
				selection.isCollapsed ||
				!container.contains(selection.anchorNode) ||
				!container.contains(selection.focusNode)
			) {
				return;
			}
			event.preventDefault();
			invokeAction("transcript-set-words-removed", {
				trackId: currentActiveMedia.trackId,
				elementId: currentActiveMedia.element.id,
				wordIds: currentSelectedWordIds,
				removed: true,
			});
			selection.removeAllRanges();
			setSelectedWordIdsIfChanged([]);
			setIsSelectionActive(false);
		};
		document.addEventListener("selectionchange", captureSelectionWords);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("selectionchange", captureSelectionWords);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [setSelectedWordIdsIfChanged]);

	useEffect(() => {
		const container = selectionContainerRef.current;
		if (!container) return;
		const onMouseMove = (event: MouseEvent) => {
			const target =
				event.target instanceof HTMLElement ? event.target : null;
			const wordId =
				target?.closest<HTMLElement>("[data-word-id]")?.dataset.wordId ?? null;
			setHoveredWordId(wordId);
		};
		const onMouseLeave = () => {
			setHoveredWordId(null);
		};
		container.addEventListener("mousemove", onMouseMove);
		container.addEventListener("mouseleave", onMouseLeave);
		return () => {
			container.removeEventListener("mousemove", onMouseMove);
			container.removeEventListener("mouseleave", onMouseLeave);
		};
	}, []);

	const clearEditingState = useCallback(() => {
		setEditingWordId(null);
		setEditingWordText("");
		setEditingTargetWordIds([]);
	}, []);

	const commitWordEdit = useCallback(() => {
		if (!activeMedia) return;
		const targetIds = editingTargetWordIds.filter((id) => id.length > 0);
		if (targetIds.length === 0 || !editingWordId) return;
		const text = editingWordText.trim();
		if (!text) return;
		if (targetIds.length === 1) {
			invokeAction("transcript-update-word", {
				trackId: activeMedia.trackId,
				elementId: activeMedia.element.id,
				wordId: targetIds[0] ?? editingWordId,
				text,
			});
			clearEditingState();
			return;
		}
		const tokens = text.split(/\s+/).filter(Boolean);
		if (tokens.length !== targetIds.length) {
			toast.error(
				`Selected ${targetIds.length} words. Edited text must have exactly ${targetIds.length} words.`,
			);
			return;
		}
		invokeAction("transcript-update-words", {
			trackId: activeMedia.trackId,
			elementId: activeMedia.element.id,
			updates: targetIds.map((wordId, index) => ({
				wordId,
				text: tokens[index] ?? "",
			})),
		});
		clearEditingState();
	}, [activeMedia, editingTargetWordIds, editingWordId, editingWordText, clearEditingState]);

	if (!activeMedia) {
		return (
			<PanelView title="Captions" contentClassName="space-y-2">
				<div className="text-sm text-muted-foreground p-3 border rounded-md">
					Select a clip audio/video element to edit transcript words.
				</div>
			</PanelView>
		);
	}

	if (wordsWithCutState.length === 0) {
		return (
			<PanelView title="Captions" contentClassName="space-y-2">
				<div className="text-sm text-muted-foreground p-3 border rounded-md">
					Word-level transcript unavailable for this element.
				</div>
			</PanelView>
		);
	}

	return (
		<PanelView
			title="Captions"
			contentClassName="space-y-3 pb-3"
			actions={
				<div className="flex items-center gap-1">
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							invokeAction("transcript-remove-fillers", {
								trackId: activeMedia.trackId,
								elementId: activeMedia.element.id,
							})
						}
					>
						Remove Fillers
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							invokeAction("transcript-remove-pauses", {
								trackId: activeMedia.trackId,
								elementId: activeMedia.element.id,
								thresholdSeconds: DEFAULT_PAUSE_REMOVAL_MIN_GAP_SECONDS,
							})
						}
					>
						Remove Pauses
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							invokeAction("transcript-restore-all", {
								trackId: activeMedia.trackId,
								elementId: activeMedia.element.id,
							})
						}
					>
						Restore All
					</Button>
				</div>
			}
		>
			<div
				ref={selectionContainerRef}
				className="space-y-4 [&_*::selection]:bg-transparent [&_*::selection]:text-inherit"
				onMouseDownCapture={(event) => {
					if (selectedWordIds.length === 0) return;
					const target =
						event.target instanceof HTMLElement ? event.target : null;
					const clickedWordId =
						target?.closest<HTMLElement>("[data-word-id]")?.dataset.wordId ?? null;
					if (!clickedWordId || !selectedWordIdsSet.has(clickedWordId)) {
						setSelectedWordIdsIfChanged([]);
						setIsSelectionActive(false);
					}
				}}
			>
				{groups.map((group, groupIndex) => {
					if (group.words.length === 0) return null;
					const start = group.words[0]?.startTime ?? 0;
					return (
						<div key={group.id} className="space-y-2">
							<div className="text-xs text-muted-foreground">
								{formatTime(start)} Paragraph {groupIndex + 1}
							</div>
							<p
								className="text-sm leading-7 select-text border-l pl-3"
								onMouseUp={(event) => {
									if (editingWordId) return;
									const target =
										event.target instanceof HTMLElement ? event.target : null;
									if (!target) return;
									if (target.closest("[data-word-edit-trigger='true']")) return;
									const wordId =
										target.closest<HTMLElement>("[data-word-id]")?.dataset
											.wordId ?? null;
									if (!wordId) return;
									if (
										selectedWordIds.length > 1 &&
										selectedWordIdsSet.has(wordId)
									) {
										const selectedWords = wordsWithCutState.filter((word) =>
											selectedWordIdsSet.has(word.id),
										);
										const shouldRemove = !selectedWords.every(
											(word) => word.removed,
										);
										invokeAction("transcript-set-words-removed", {
											trackId: activeMedia.trackId,
											elementId: activeMedia.element.id,
											wordIds: selectedWordIds,
											removed: shouldRemove,
										});
										return;
									}
									const selection = window.getSelection();
									if (selection && !selection.isCollapsed) return;
									invokeAction("transcript-toggle-word", {
										trackId: activeMedia.trackId,
										elementId: activeMedia.element.id,
										wordId,
									});
								}}
							>
								{group.words.map((word) => (
									<span
										key={word.id}
										className="relative group/word inline-block mr-1.5"
										data-word-id={word.id}
									>
										{editingWordId === word.id ? (
											<span className="h-7 rounded-full border bg-secondary inline-flex items-center pr-1 pl-2 align-middle">
												<input
													value={editingWordText}
													onChange={(event) =>
														setEditingWordText(event.target.value)
													}
													onKeyDown={(event) => {
														if (event.key === "Enter") {
															commitWordEdit();
														}
														if (event.key === "Escape") {
															clearEditingState();
														}
													}}
													className="bg-transparent text-xs outline-none w-24"
												/>
												<Button
													variant="ghost"
													size="icon"
													className="size-5"
													onClick={commitWordEdit}
												>
													<Check className="size-3.5" />
												</Button>
												<Button
													variant="ghost"
													size="icon"
													className="size-5"
													onClick={clearEditingState}
												>
													<X className="size-3.5" />
												</Button>
											</span>
										) : (
											<>
											<span
												className={[
													"select-text rounded-full px-0.5 py-0.5 transition-colors cursor-pointer",
													!isSelectionActive ? "hover:bg-secondary" : "",
													!isSelectionActive ? "group-hover/word:bg-secondary" : "",
													hoveredWordId &&
													selectedWordIds.length > 1 &&
													selectedWordIdsSet.has(hoveredWordId) &&
													selectedWordIdsSet.has(word.id)
														? "bg-secondary"
														: "",
													word.removed ? "opacity-40 line-through" : "",
													currentWordId === word.id ? "text-white" : "",
													selectedWordIds.includes(word.id) ? "bg-accent" : "",
														selectedCaptionWordIds.has(word.id)
															? "ring-1 ring-primary/70"
															: "",
													]
														.filter(Boolean)
														.join(" ")}
													style={
														currentWordId === word.id
															? { backgroundColor: "#c71e3a" }
															: undefined
													}
												>
													{word.text}
												</span>
												<Button
													variant="ghost"
													size="icon"
													className="absolute -top-1 -right-1 size-4 rounded-full opacity-0 group-hover/word:opacity-100 transition-opacity"
													data-word-edit-trigger="true"
													onClick={() => {
														if (
															selectedWordIds.length > 1 &&
															selectedWordIdsSet.has(word.id)
														) {
															const orderedSelected = orderedWordIds.filter((id) =>
																selectedWordIdsSet.has(id),
															);
															const wordsById = new Map(
																wordsWithCutState.map((item) => [item.id, item.text]),
															);
															setEditingTargetWordIds(orderedSelected);
															setEditingWordId(orderedSelected[0] ?? word.id);
															setEditingWordText(
																orderedSelected
																	.map((id) => wordsById.get(id) ?? "")
																	.filter(Boolean)
																	.join(" "),
															);
															return;
														}
														setEditingTargetWordIds([word.id]);
														setEditingWordId(word.id);
														setEditingWordText(word.text);
													}}
												>
													<Pencil className="size-2.5" />
												</Button>
											</>
										)}
									</span>
								))}
							</p>
						</div>
					);
				})}
			</div>

			<div className="text-[11px] text-muted-foreground px-1 flex items-center gap-1">
				<AlignJustify className="size-3.5" />
				Transcript edits update captions, playback, and export
				non-destructively.
			</div>
		</PanelView>
	);
}
