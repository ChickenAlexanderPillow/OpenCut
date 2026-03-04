"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import type {
	AudioElement,
	TextElement,
	TimelineElement,
	VideoElement,
} from "@/types/timeline";
import type { TranscriptEditWord } from "@/types/transcription";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlignJustify, Check, Pencil, Scissors, X } from "lucide-react";

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

function getCaptionSourceTrackInfo({
	tracks,
	mediaElementId,
}: {
	tracks: ReturnType<ReturnType<typeof useEditor>["timeline"]["getTracks"]>;
	mediaElementId: string;
}): Array<{ trackId: string; element: TextElement }> {
	return tracks.flatMap((track) =>
		track.type === "text"
			? track.elements
					.filter(
						(element) =>
							element.type === "text" &&
							(element.captionWordTimings?.length ?? 0) > 0 &&
							(!element.captionSourceRef ||
								element.captionSourceRef.mediaElementId === mediaElementId),
					)
					.map((element) => ({ trackId: track.id, element }))
			: [],
	);
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

function getWordIdFromNode({
	node,
}: {
	node: Node | null;
}): string | null {
	if (!node) return null;
	const element =
		node instanceof HTMLElement
			? node
			: node.parentElement instanceof HTMLElement
				? node.parentElement
				: null;
	if (!element) return null;
	return element.closest<HTMLElement>("[data-word-id]")?.dataset.wordId ?? null;
}

export function TranscriptView() {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const tracks = editor.timeline.getTracks();
	const currentTime = editor.playback.getCurrentTime();
	const [editingWordId, setEditingWordId] = useState<string | null>(null);
	const [editingWordText, setEditingWordText] = useState("");
	const [selectedWordIds, setSelectedWordIds] = useState<string[]>([]);
	const selectionContainerRef = useRef<HTMLDivElement | null>(null);

	const activeMedia = useMemo(
		() => getActiveMediaRef({ tracks, selectedElements }),
		[tracks, selectedElements],
	);

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

	const captionLinks = useMemo(
		() =>
			activeMedia
				? getCaptionSourceTrackInfo({
						tracks,
						mediaElementId: activeMedia.element.id,
					}).length
				: 0,
		[activeMedia, tracks],
	);
	const orderedWordIds = useMemo(
		() => groups.flatMap((group) => group.words.map((word) => word.id)),
		[groups],
	);

	useEffect(() => {
		if (!editingWordId) return;
		if (!wordsWithCutState.some((word) => word.id === editingWordId)) {
			setEditingWordId(null);
			setEditingWordText("");
		}
	}, [editingWordId, wordsWithCutState]);

	useEffect(() => {
		if (!activeMedia) return;
		const captureSelectionWords = () => {
			const container = selectionContainerRef.current;
			if (!container) {
				setSelectedWordIds([]);
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
				setSelectedWordIds([]);
				return;
			}
			const startWordId = getWordIdFromNode({ node: selection.anchorNode });
			const endWordId = getWordIdFromNode({ node: selection.focusNode });
			if (!startWordId || !endWordId) {
				setSelectedWordIds([]);
				return;
			}
			const startIndex = orderedWordIds.indexOf(startWordId);
			const endIndex = orderedWordIds.indexOf(endWordId);
			if (startIndex < 0 || endIndex < 0) {
				setSelectedWordIds([]);
				return;
			}
			const from = Math.min(startIndex, endIndex);
			const to = Math.max(startIndex, endIndex);
			setSelectedWordIds(orderedWordIds.slice(from, to + 1));
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.key !== "Backspace" &&
				event.key !== "Delete"
			) {
				return;
			}
			if (editingWordId) return;
			const container = selectionContainerRef.current;
			if (!container || selectedWordIds.length === 0) return;
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
				trackId: activeMedia.trackId,
				elementId: activeMedia.element.id,
				wordIds: selectedWordIds,
				removed: true,
			});
			selection.removeAllRanges();
			setSelectedWordIds([]);
		};
		document.addEventListener("selectionchange", captureSelectionWords);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("selectionchange", captureSelectionWords);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [
		activeMedia,
		editingWordId,
		orderedWordIds,
		selectedWordIds,
	]);

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
			<div className="rounded-md border p-2 text-xs text-muted-foreground flex items-center gap-2">
				<Badge variant="secondary">
					{activeMedia.element.type.toUpperCase()}
				</Badge>
				<span>{activeMedia.element.name}</span>
				<span className="ml-auto">Captions linked: {captionLinks}</span>
			</div>

			<div ref={selectionContainerRef} className="space-y-2">
				{groups.map((group, groupIndex) => {
					if (group.words.length === 0) return null;
					const start = group.words[0]?.startTime ?? 0;
					return (
						<div key={group.id} className="rounded-md border p-2">
							<div className="flex items-center justify-between mb-2">
								<div className="text-xs text-muted-foreground">
									{formatTime(start)} Segment {groupIndex + 1}
								</div>
								<div className="flex items-center gap-1">
									<Button
										variant="ghost"
										size="icon"
										className="size-6"
										onClick={() => {
											const splitWord =
												group.words[Math.floor(group.words.length / 2)];
											if (!splitWord) return;
											invokeAction("transcript-split-segment-ui", {
												trackId: activeMedia.trackId,
												elementId: activeMedia.element.id,
												wordId: splitWord.id,
											});
										}}
									>
										<Scissors className="size-3.5" />
									</Button>
								</div>
							</div>
							<div className="text-sm leading-7 select-text">
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
														const text = editingWordText.trim();
														if (!text) return;
														invokeAction("transcript-update-word", {
															trackId: activeMedia.trackId,
															elementId: activeMedia.element.id,
															wordId: word.id,
															text,
														});
														setEditingWordId(null);
														setEditingWordText("");
													}
													if (event.key === "Escape") {
														setEditingWordId(null);
														setEditingWordText("");
													}
												}}
												className="bg-transparent text-xs outline-none w-24"
											/>
											<Button
												variant="ghost"
												size="icon"
												className="size-5"
												onClick={() => {
													const text = editingWordText.trim();
													if (!text) return;
													invokeAction("transcript-update-word", {
														trackId: activeMedia.trackId,
														elementId: activeMedia.element.id,
														wordId: word.id,
														text,
													});
													setEditingWordId(null);
													setEditingWordText("");
												}}
											>
												<Check className="size-3.5" />
											</Button>
											<Button
												variant="ghost"
												size="icon"
												className="size-5"
												onClick={() => {
													setEditingWordId(null);
													setEditingWordText("");
												}}
											>
												<X className="size-3.5" />
											</Button>
										</span>
									) : (
										<>
											<button
												type="button"
												onClick={() => {
													const selection = window.getSelection();
													if (selection && !selection.isCollapsed) return;
													invokeAction("transcript-toggle-word", {
														trackId: activeMedia.trackId,
														elementId: activeMedia.element.id,
														wordId: word.id,
													});
												}}
												className={[
													"border-0 bg-transparent p-0 m-0 font-inherit text-inherit rounded-full px-0.5 py-0.5 transition-colors cursor-pointer",
													"hover:bg-secondary",
													word.removed ? "opacity-40 line-through" : "",
													currentWordId === word.id ? "bg-secondary/70" : "",
													selectedWordIds.includes(word.id) ? "bg-accent" : "",
												]
													.filter(Boolean)
													.join(" ")}
											>
												{word.text}
											</button>
											<Button
												variant="ghost"
												size="icon"
												className="absolute -top-1 -right-1 size-4 rounded-full border bg-background opacity-0 group-hover/word:opacity-100 transition-opacity"
												onClick={() => {
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
							</div>
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
