"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { useEditor } from "@/hooks/use-editor";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { invokeAction } from "@/lib/actions";
import { DEFAULT_TRANSCRIPTION_MODEL } from "@/constants/transcription-constants";
import {
	applyCutRangesToWords,
	buildTranscriptGapId,
	getTranscriptGapEdit,
	buildTranscriptCutsFromWords,
	isFillerWordOrPhrase,
	mapCompressedTimeToSourceTime,
	mapSourceTimeToCompressedTime,
	normalizeTranscriptWords,
} from "@/lib/transcript-editor/core";
import { buildTranscriptWordsFromCaptionTimings } from "@/lib/transcript-editor/caption-fallback";
import {
	buildDefaultTranscriptSegmentsUi,
	buildDefaultTranscriptWordGroups,
	formatSpeakerLabel,
} from "@/lib/transcript-editor/segments";
import {
	compileTranscriptDraft,
	getTranscriptCompileState,
	getTranscriptDraft,
} from "@/lib/transcript-editor/state";
import { getEffectiveTranscriptCutsFromTranscriptEdit } from "@/lib/transcript-editor/snapshot";
import { toElementLocalCaptionTime } from "@/lib/captions/timing";
import {
	buildClipTranscriptCacheEntryForAsset,
	buildProjectMediaTranscriptLinkKey,
	clipTranscriptSegmentsForWindow,
	clipTranscriptWordsForWindow,
	getClipTranscriptCacheKey,
	getOrCreateClipTranscriptForAsset,
	transcribeClipTranscriptLocallyForAsset,
} from "@/lib/clips/transcript";
import type {
	AudioElement,
	TextElement,
	TimelineElement,
	VideoElement,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import type {
	TranscriptEditWord,
	TranscriptionProgress,
	TranscriptionSegment,
	TranscriptionWord,
} from "@/types/transcription";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { AlignJustify, Check, Pencil, X } from "lucide-react";
import { useTranscriptionStatusStore } from "@/stores/transcription-status-store";
import { useProjectProcessStore } from "@/stores/project-process-store";

type MediaRef = {
	trackId: string;
	element: VideoElement | AudioElement;
};

type TranscriptPanelGroup = {
	id: string;
	words: TranscriptEditWord[];
	label?: string;
	speakerId?: string;
};

type TranscriptGapFocus = {
	id: string;
	leftWordId: string;
	rightWordId: string;
};

type TranscriptPanelGap = {
	id: string;
	leftWordId: string;
	rightWordId: string;
	rightWord: TranscriptEditWord;
	sourceDurationSeconds: number;
	compressedDurationSeconds: number;
};

const EDITOR_SUBSCRIBE_TRANSCRIPT_VIEW = [
	"timeline",
	"playback",
	"media",
	"project",
] as const;

function formatTime(time: number): string {
	const total = Math.max(0, Math.floor(time));
	const mins = Math.floor(total / 60)
		.toString()
		.padStart(2, "0");
	const secs = (total % 60).toString().padStart(2, "0");
	return `${mins}:${secs}`;
}

function findActiveWordIdAtSourceTime({
	words,
	time,
	matchHidden,
}: {
	words: TranscriptEditWord[];
	time: number;
	matchHidden: boolean;
}): string | null {
	for (let index = words.length - 1; index >= 0; index--) {
		const word = words[index];
		if (word.removed) continue;
		if (Boolean(word.hidden) !== matchHidden) continue;
		if (time >= word.startTime && time < word.endTime) {
			return word.id;
		}
	}
	return null;
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
	return buildTranscriptWordsFromCaptionTimings({
		mediaElementId,
		mediaStartTime: 0,
		timings: matched.captionWordTimings ?? [],
		idPrefix: "fallback",
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

function getMediaAssetForElement({
	element,
	assets,
}: {
	element: VideoElement | AudioElement;
	assets: MediaAsset[];
}): MediaAsset | null {
	const mediaId =
		element.type === "video"
			? element.mediaId
			: element.sourceType === "upload"
				? element.mediaId
				: null;
	if (!mediaId) return null;
	return assets.find((asset) => asset.id === mediaId) ?? null;
}

function buildTranscriptWordsFromSegments({
	mediaElementId,
	segments,
}: {
	mediaElementId: string;
	segments: TranscriptionSegment[];
}): TranscriptEditWord[] {
	let wordIndex = 0;
	const words = segments.flatMap((segment) => {
		const tokens = segment.text.match(/\S+/g) ?? [];
		if (tokens.length === 0) return [];
		const segmentStart = Math.max(0, segment.start);
		const segmentEnd = Math.max(segmentStart + 0.01, segment.end);
		const duration = Math.max(0.01, segmentEnd - segmentStart);
		const weights = tokens.map((token) =>
			Math.max(
				1,
				token.replace(/[^\p{L}\p{N}']+/gu, "").length || token.length,
			),
		);
		const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
		let consumed = 0;
		return tokens.map((token, tokenIndex) => {
			const startWeight = consumed;
			consumed += weights[tokenIndex] ?? 1;
			const endWeight = consumed;
			const startTime = segmentStart + (duration * startWeight) / totalWeight;
			const endTime = Math.max(
				startTime + 0.01,
				segmentStart + (duration * endWeight) / totalWeight,
			);
			const id = `${mediaElementId}:word:${wordIndex}:${startTime.toFixed(3)}`;
			wordIndex += 1;
			return {
				id,
				text: token,
				startTime,
				endTime,
				speakerId: segment.speakerId,
				removed: false,
			};
		});
	});
	return normalizeTranscriptWords({ words });
}

function buildTranscriptWordsFromTimedWords({
	mediaElementId,
	words,
}: {
	mediaElementId: string;
	words: TranscriptionWord[];
}): TranscriptEditWord[] {
	const mergedWords: TranscriptEditWord[] = [];
	for (const [index, word] of words.entries()) {
		const trimmed = word.word.trim();
		if (!trimmed) continue;
		const previous = mergedWords[mergedWords.length - 1];
		if (previous && /^[^\p{L}\p{N}']+$/u.test(trimmed)) {
			previous.text = `${previous.text}${trimmed}`;
			previous.endTime = Math.max(previous.endTime, word.end);
			continue;
		}
		mergedWords.push({
			id: `${mediaElementId}:word:${index}:${word.start.toFixed(3)}`,
			text: trimmed,
			startTime: word.start,
			endTime: word.end,
			speakerId: word.speakerId,
			removed: false,
		});
	}
	return normalizeTranscriptWords({
		words: mergedWords,
	});
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
		const element = track.elements.find(
			(item) => item.id === selected.elementId,
		);
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
}): TranscriptPanelGroup[] {
	return buildDefaultTranscriptWordGroups({ words });
}

function buildSpeakerLabels({
	words,
	existingLabels,
}: {
	words: TranscriptEditWord[];
	existingLabels?: Record<string, string>;
}): Record<string, string> | undefined {
	const nextLabels: Record<string, string> = {};
	for (const word of words) {
		const speakerId = word.speakerId?.trim();
		if (!speakerId || nextLabels[speakerId]) continue;
		const customLabel = existingLabels?.[speakerId]?.trim();
		nextLabels[speakerId] =
			customLabel && customLabel.length > 0
				? customLabel
				: formatSpeakerLabel({ speakerId }) ?? speakerId;
	}
	return Object.keys(nextLabels).length > 0 ? nextLabels : undefined;
}

function getSpeakerTone(index: number): {
	accent: string;
	background: string;
	border: string;
	wordText: string;
	mutedText: string;
} {
	const palette = [
		{
			accent: "#f97316",
			background: "rgba(249, 115, 22, 0.11)",
			border: "rgba(249, 115, 22, 0.28)",
			wordText: "#c2410c",
			mutedText: "#fdba74",
		},
		{
			accent: "#ec4899",
			background: "rgba(236, 72, 153, 0.11)",
			border: "rgba(236, 72, 153, 0.28)",
			wordText: "#be185d",
			mutedText: "#f9a8d4",
		},
		{
			accent: "#7c3aed",
			background: "rgba(124, 58, 237, 0.11)",
			border: "rgba(124, 58, 237, 0.26)",
			wordText: "#581c87",
			mutedText: "#6d28d9",
		},
		{
			accent: "#c2410c",
			background: "rgba(194, 65, 12, 0.11)",
			border: "rgba(194, 65, 12, 0.26)",
			wordText: "#7c2d12",
			mutedText: "#9a3412",
		},
		{
			accent: "#1d4ed8",
			background: "rgba(29, 78, 216, 0.11)",
			border: "rgba(29, 78, 216, 0.24)",
			wordText: "#1e3a8a",
			mutedText: "#1d4ed8",
		},
	];
	return palette[index % palette.length] ?? palette[0];
}

function hexToRgba(hex: string, alpha: number): string {
	const normalized = hex.replace("#", "");
	if (normalized.length !== 6) {
		return `rgba(161, 161, 170, ${alpha})`;
	}
	const red = Number.parseInt(normalized.slice(0, 2), 16);
	const green = Number.parseInt(normalized.slice(2, 4), 16);
	const blue = Number.parseInt(normalized.slice(4, 6), 16);
	return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getTranscriptGapWidthClass(durationSeconds: number): string {
	if (durationSeconds >= 0.45) return "w-6";
	if (durationSeconds >= 0.18) return "w-4";
	return "w-2.5";
}

async function waitForNextPaint(): Promise<void> {
	await new Promise<void>((resolve) => {
		window.requestAnimationFrame(() => resolve());
	});
}

export function TranscriptView() {
	const editor = useEditor({ subscribeTo: EDITOR_SUBSCRIBE_TRANSCRIPT_VIEW });
	const { selectedElements } = useElementSelection();
	const transcriptionStatus = useTranscriptionStatusStore();
	const { registerProcess, updateProcessLabel, removeProcess } =
		useProjectProcessStore();
	const tracks = editor.timeline.getTracks();
	const currentTime = editor.playback.getCurrentTime();
	const [editingWordId, setEditingWordId] = useState<string | null>(null);
	const [editingWordText, setEditingWordText] = useState("");
	const [editingTargetWordIds, setEditingTargetWordIds] = useState<string[]>(
		[],
	);
	const [selectedWordIds, setSelectedWordIds] = useState<string[]>([]);
	const [isSelectionActive, setIsSelectionActive] = useState(false);
	const [focusedWordId, setFocusedWordId] = useState<string | null>(null);
	const [focusedGap, setFocusedGap] = useState<TranscriptGapFocus | null>(null);
	const [editingGapId, setEditingGapId] = useState<string | null>(null);
	const [editingGapText, setEditingGapText] = useState(" ");
	const [isGeneratingCaptions, setIsGeneratingCaptions] = useState(false);
	const [isRefreshingTranscript, setIsRefreshingTranscript] = useState(false);
	const [generateStep, setGenerateStep] = useState("");
	const [generateError, setGenerateError] = useState<string | null>(null);
	const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
	const [editingSpeakerName, setEditingSpeakerName] = useState("");
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
	const activeMediaAsset = useMemo(
		() =>
			activeMedia
				? getMediaAssetForElement({
						element: activeMedia.element,
						assets: editor.media.getAssets(),
					})
				: null,
		[activeMedia, editor],
	);

	const words = useMemo(() => {
		if (!activeMedia) return [];
		const fromElement = getTranscriptDraft(activeMedia.element)?.words ?? [];
		if (fromElement.length > 0)
			return normalizeTranscriptWords({ words: fromElement });
		return getFallbackWordsFromCaptions({
			tracks,
			mediaElementId: activeMedia.element.id,
		});
	}, [activeMedia, tracks]);

	const activeTranscriptDraft = activeMedia
		? getTranscriptDraft(activeMedia.element)
		: undefined;

	const cuts = useMemo(() => {
		if (!activeMedia) {
			return buildTranscriptCutsFromWords({ words });
		}
		if (!activeTranscriptDraft) {
			return buildTranscriptCutsFromWords({ words });
		}
		return getEffectiveTranscriptCutsFromTranscriptEdit({
			transcriptEdit: activeTranscriptDraft,
		});
	}, [activeMedia, activeTranscriptDraft, words]);
	const wordsWithCutState = useMemo(
		() =>
			applyCutRangesToWords({
				words,
				cuts,
			}),
		[words, cuts],
	);
	const hasLinkedCaptions = useMemo(() => {
		if (!activeMedia) return false;
		return tracks.some((track) => {
			if (track.type !== "text") return false;
			return track.elements.some(
				(element) =>
					element.type === "text" &&
					(element.captionWordTimings?.length ?? 0) > 0 &&
					element.captionSourceRef?.mediaElementId === activeMedia.element.id,
			);
		});
	}, [activeMedia, tracks]);
	const hasTranscriptData = useMemo(
		() => wordsWithCutState.length > 0,
		[wordsWithCutState],
	);
	const visibleCaptionWords = useMemo(
		() =>
			wordsWithCutState.filter(
				(word) =>
					!word.removed &&
					!word.hidden &&
					!isFillerWordOrPhrase({ text: word.text }),
			),
		[wordsWithCutState],
	);
	const currentSourceTime = useMemo(() => {
		if (!activeMedia) return null;
		const localCompressed = Math.max(
			0,
			currentTime - activeMedia.element.startTime,
		);
		return mapCompressedTimeToSourceTime({
			compressedTime: localCompressed,
			cuts,
		});
	}, [activeMedia, currentTime, cuts]);

	const currentWordId = useMemo(() => {
		if (currentSourceTime == null) return null;
		return findActiveWordIdAtSourceTime({
			words: visibleCaptionWords,
			time: currentSourceTime,
			matchHidden: false,
		});
	}, [currentSourceTime, visibleCaptionWords]);

	const currentHiddenWordId = useMemo(() => {
		if (currentSourceTime == null) return null;
		return findActiveWordIdAtSourceTime({
			words: wordsWithCutState,
			time: currentSourceTime,
			matchHidden: true,
		});
	}, [currentSourceTime, wordsWithCutState]);

	const transcriptCompileState = activeMedia
		? getTranscriptCompileState(activeMedia.element)
		: { status: "idle" as const };
	const segmentsUi = activeTranscriptDraft?.segmentsUi;
	const speakerLabels = activeTranscriptDraft?.speakerLabels ?? {};
	const gapEdits = activeTranscriptDraft?.gapEdits ?? {};
	const speakerIds = useMemo(() => {
		const orderedIds: string[] = [];
		for (const word of wordsWithCutState) {
			const speakerId = word.speakerId?.trim();
			if (!speakerId || orderedIds.includes(speakerId)) continue;
			orderedIds.push(speakerId);
		}
		return orderedIds;
	}, [wordsWithCutState]);
	const speakerToneById = useMemo(
		() =>
			new Map(
				speakerIds.map((speakerId, index) => [speakerId, getSpeakerTone(index)]),
			),
		[speakerIds],
	);
	const groups =
		segmentsUi && segmentsUi.length > 0
			? segmentsUi
					.map((segment) => ({
						id: segment.id,
						speakerId: wordsWithCutState[segment.wordStartIndex]?.speakerId,
						label:
							segment.label ??
							formatSpeakerLabel({
								speakerId: wordsWithCutState[segment.wordStartIndex]?.speakerId,
							}),
						words: wordsWithCutState.slice(
							segment.wordStartIndex,
							segment.wordEndIndex + 1,
						),
					}))
					.filter((group) => group.words.length > 0)
			: buildDefaultSegmentGroups({ words: wordsWithCutState });
	const panelGroups = groups.map((group) => {
		const speakerId = group.speakerId?.trim();
		return {
			...group,
			speakerId,
			speakerLabel:
				(speakerId ? speakerLabels[speakerId] : undefined) ??
				group.label ??
				formatSpeakerLabel({ speakerId }),
			tone: speakerId ? speakerToneById.get(speakerId) : undefined,
		};
	});

	const orderedPanelWords = useMemo(
		() => panelGroups.flatMap((group) => group.words),
		[panelGroups],
	);
	const nextPanelWordById = useMemo(() => {
		const nextWordMap = new Map<string, TranscriptPanelGap>();
		for (let index = 0; index < orderedPanelWords.length - 1; index++) {
			const current = orderedPanelWords[index];
			const next = orderedPanelWords[index + 1];
			if (!current || !next) continue;
			const sourceDurationSeconds = Math.max(0, next.startTime - current.endTime);
			const compressedDurationSeconds = Math.max(
				0,
				mapSourceTimeToCompressedTime({
					sourceTime: next.startTime,
					cuts,
				}) -
					mapSourceTimeToCompressedTime({
						sourceTime: current.endTime,
						cuts,
					}),
			);
			nextWordMap.set(current.id, {
				id: buildTranscriptGapId(current.id, next.id),
				leftWordId: current.id,
				rightWordId: next.id,
				rightWord: next,
				sourceDurationSeconds,
				compressedDurationSeconds,
			});
		}
		return nextWordMap;
	}, [cuts, orderedPanelWords]);
	const orderedWordIds = useMemo(
		() => panelGroups.flatMap((group) => group.words.map((word) => word.id)),
		[panelGroups],
	);
	const selectedCaptionWordIds = useMemo(() => {
		if (!selectedCaption || !activeMedia) return new Set<string>();
		if (
			selectedCaption.element.captionSourceRef?.mediaElementId &&
			selectedCaption.element.captionSourceRef.mediaElementId !==
				activeMedia.element.id
		) {
			return new Set<string>();
		}
		const timings = selectedCaption.element.captionWordTimings ?? [];
		if (timings.length === 0) return new Set<string>();
		const visibleTimings = timings.filter((timing) => !timing.hidden);
		if (visibleTimings.length === 0) return new Set<string>();
		if (visibleTimings.length === visibleCaptionWords.length) {
			return new Set(visibleCaptionWords.map((word) => word.id));
		}
		const ranges = visibleTimings.map((timing) => ({
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
		const highlighted = visibleCaptionWords
			.filter((word) =>
				ranges.some(
					(range) => word.endTime > range.start && word.startTime < range.end,
				),
			)
			.map((word) => word.id);
		return new Set(highlighted);
	}, [selectedCaption, activeMedia, cuts, visibleCaptionWords]);
	const selectedWordIdsSet = useMemo(
		() => new Set(selectedWordIds),
		[selectedWordIds],
	);
	const selectedWordsForEdit = useMemo(
		() =>
			wordsWithCutState.filter((word) => selectedWordIdsSet.has(word.id)),
		[wordsWithCutState, selectedWordIdsSet],
	);
	const focusedWord = useMemo(
		() =>
			focusedWordId
				? wordsWithCutState.find((word) => word.id === focusedWordId) ?? null
				: null,
		[focusedWordId, wordsWithCutState],
	);

	useEffect(() => {
		if (!editingWordId) return;
		if (!wordsWithCutState.some((word) => word.id === editingWordId)) {
			setEditingWordId(null);
			setEditingWordText("");
			setEditingTargetWordIds([]);
		}
	}, [editingWordId, wordsWithCutState]);

	useEffect(() => {
		if (!focusedWordId) return;
		if (!wordsWithCutState.some((word) => word.id === focusedWordId)) {
			setFocusedWordId(null);
		}
	}, [focusedWordId, wordsWithCutState]);

	useEffect(() => {
		if (!focusedGap) return;
		const wordIds = new Set(wordsWithCutState.map((word) => word.id));
		if (
			!wordIds.has(focusedGap.leftWordId) ||
			!wordIds.has(focusedGap.rightWordId)
		) {
			setFocusedGap(null);
		}
	}, [focusedGap, wordsWithCutState]);

	useEffect(() => {
		if (!editingSpeakerId) return;
		if (!speakerIds.includes(editingSpeakerId)) {
			setEditingSpeakerId(null);
			setEditingSpeakerName("");
		}
	}, [editingSpeakerId, speakerIds]);

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
			if (event.key !== "Backspace" && event.key !== "Delete") {
				return;
			}
			if (editingWordIdRef.current) return;
			const container = selectionContainerRef.current;
			const currentSelectedWordIds = selectedWordIdsRef.current;
			const currentActiveMedia = activeMediaRef.current;
			if (
				!container ||
				!currentActiveMedia ||
				currentSelectedWordIds.length === 0
			) {
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

	const clearEditingState = useCallback(() => {
		setEditingWordId(null);
		setEditingWordText("");
		setEditingTargetWordIds([]);
	}, []);

	const clearGapEditingState = useCallback(() => {
		setEditingGapId(null);
		setEditingGapText(" ");
	}, []);

	const startEditingWordIds = useCallback((targetIds: string[]) => {
		if (targetIds.length === 0) return;
		const targetIdSet = new Set(targetIds);
		const orderedSelected = orderedWordIds.filter((id) => targetIdSet.has(id));
		const wordsById = new Map(
			wordsWithCutState.map((item) => [item.id, item.text]),
		);
		setFocusedGap(null);
		setEditingTargetWordIds(orderedSelected);
		setEditingWordId(orderedSelected[0] ?? null);
		clearGapEditingState();
		setEditingWordText(
			orderedSelected
				.map((id) => wordsById.get(id) ?? "")
				.filter(Boolean)
				.join(" "),
		);
	}, [orderedWordIds, wordsWithCutState]);

	const startEditingSelectedWords = useCallback(() => {
		if (selectedWordIds.length === 0) return;
		startEditingWordIds(selectedWordIds);
	}, [selectedWordIds, startEditingWordIds]);

	const startEditingWord = useCallback(
		(word: TranscriptEditWord) => {
			startEditingWordIds([word.id]);
		},
		[startEditingWordIds],
	);

	const focusWordGap = useCallback(
		(leftWordId: string, rightWordId: string) => {
			setFocusedWordId(null);
			setFocusedGap({
				id: `${leftWordId}:${rightWordId}`,
				leftWordId,
				rightWordId,
			});
			setSelectedWordIdsIfChanged([]);
			setIsSelectionActive(false);
			window.getSelection()?.removeAllRanges();
		},
		[setSelectedWordIdsIfChanged],
	);

	const startEditingGap = useCallback(
		(leftWordId: string, rightWordId: string) => {
			const gapId = buildTranscriptGapId(leftWordId, rightWordId);
			setFocusedWordId(null);
			setFocusedGap({
				id: gapId,
				leftWordId,
				rightWordId,
			});
			setEditingWordId(null);
			setEditingTargetWordIds([]);
			setEditingWordText("");
			setEditingGapId(gapId);
			setEditingGapText(
				getTranscriptGapEdit({
					gapEdits,
					leftWordId,
					rightWordId,
				})?.text ?? " ",
			);
			setSelectedWordIdsIfChanged([]);
			setIsSelectionActive(false);
			window.getSelection()?.removeAllRanges();
		},
		[gapEdits, setSelectedWordIdsIfChanged],
	);

	const commitGapEdit = useCallback(() => {
		if (!activeMedia || !focusedGap || !editingGapId) return;
		invokeAction("transcript-update-gap-text", {
			trackId: activeMedia.trackId,
			elementId: activeMedia.element.id,
			leftWordId: focusedGap.leftWordId,
			rightWordId: focusedGap.rightWordId,
			text: editingGapText,
		});
		clearGapEditingState();
	}, [activeMedia, focusedGap, editingGapId, editingGapText, clearGapEditingState]);

	const clearSpeakerEditingState = useCallback(() => {
		setEditingSpeakerId(null);
		setEditingSpeakerName("");
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
	}, [
		activeMedia,
		editingTargetWordIds,
		editingWordId,
		editingWordText,
		clearEditingState,
	]);

	const commitSpeakerEdit = useCallback(() => {
		if (!activeMedia || !editingSpeakerId) return;
		const nextLabel = editingSpeakerName.trim();
		if (!nextLabel) {
			toast.error("Speaker name cannot be empty");
			return;
		}
		invokeAction("transcript-update-speaker-label", {
			trackId: activeMedia.trackId,
			elementId: activeMedia.element.id,
			speakerId: editingSpeakerId,
			label: nextLabel,
		});
		clearSpeakerEditingState();
	}, [
		activeMedia,
		clearSpeakerEditingState,
		editingSpeakerId,
		editingSpeakerName,
	]);

	const handleGenerateCaptions = useCallback(async () => {
		let transcriptionOperationId: string | undefined;
		let projectProcessId: string | undefined;
		try {
			if (!activeMedia || !activeMediaAsset) {
				throw new Error("Select one uploaded audio/video element first.");
			}
			if ((getTranscriptDraft(activeMedia.element)?.words?.length ?? 0) > 0) {
				setIsGeneratingCaptions(true);
				setGenerateError(null);
				setGenerateStep("Rebuilding from transcript...");
				await waitForNextPaint();
				invokeAction("rebuild-captions-for-clip", {
					trackId: activeMedia.trackId,
					elementId: activeMedia.element.id,
				});
				return;
			}
			setIsGeneratingCaptions(true);
			setGenerateError(null);
			setGenerateStep("Transcribing...");
			await waitForNextPaint();
			const activeProject = editor.project.getActive();
			transcriptionOperationId = transcriptionStatus.start(
				"Transcribing media...",
			);
			projectProcessId = registerProcess({
				projectId: activeProject.metadata.id,
				kind: "transcription",
				label: "Generating captions...",
			});

			const onProgress = (progress: TranscriptionProgress) => {
				if (progress.status === "loading-model") {
					setGenerateStep(`Loading model ${Math.round(progress.progress)}%`);
				} else if (progress.status === "transcribing") {
					setGenerateStep("Transcribing...");
				}
				transcriptionStatus.update({
					operationId: transcriptionOperationId,
					message: progress.message ?? "Generating captions...",
					progress: progress.progress,
				});
				if (projectProcessId) {
					updateProcessLabel({
						id: projectProcessId,
						label:
							progress.message ??
							`Transcription ${Math.round(progress.progress)}%`,
					});
				}
			};

			const transcriptResult = await getOrCreateClipTranscriptForAsset({
				project: activeProject,
				asset: activeMediaAsset,
				modelId: DEFAULT_TRANSCRIPTION_MODEL,
				language: "auto",
				onProgress,
			});
			const latestProject = editor.project.getActive();
			editor.project.setActiveProject({
				project: {
					...latestProject,
					clipTranscriptCache: {
						...(latestProject.clipTranscriptCache ?? {}),
						[transcriptResult.cacheKey]: transcriptResult.transcript,
					},
				},
			});
			editor.save.markDirty();

			const sourceWindowWords = clipTranscriptWordsForWindow({
				words: transcriptResult.transcript.words ?? [],
				startTime: activeMedia.element.trimStart,
				endTime: activeMedia.element.trimStart + activeMedia.element.duration,
			});
			const sourceWindowSegments =
				sourceWindowWords.length === 0
					? clipTranscriptSegmentsForWindow({
							segments: transcriptResult.transcript.segments,
							startTime: activeMedia.element.trimStart,
							endTime:
								activeMedia.element.trimStart + activeMedia.element.duration,
						})
					: [];
			if (sourceWindowWords.length === 0 && sourceWindowSegments.length === 0) {
				throw new Error("No transcript words found for this media window.");
			}
			const wordsForEdit =
				sourceWindowWords.length > 0
					? buildTranscriptWordsFromTimedWords({
							mediaElementId: activeMedia.element.id,
							words: sourceWindowWords,
						})
					: buildTranscriptWordsFromSegments({
							mediaElementId: activeMedia.element.id,
							segments: sourceWindowSegments,
						});
			const transcriptVersion = 1 as const;
			const transcriptDraft = {
				version: transcriptVersion,
				source: "word-level" as const,
				words: wordsForEdit,
				cuts: buildTranscriptCutsFromWords({ words: wordsForEdit }),
				segmentsUi: buildDefaultTranscriptSegmentsUi({
					elementId: activeMedia.element.id,
					words: wordsForEdit,
				}),
				speakerLabels: buildSpeakerLabels({
					words: wordsForEdit,
					existingLabels: activeTranscriptDraft?.speakerLabels,
				}),
				gapEdits: activeTranscriptDraft?.gapEdits,
				updatedAt: new Date().toISOString(),
			};
			editor.timeline.updateElements({
				updates: [
					{
						trackId: activeMedia.trackId,
						elementId: activeMedia.element.id,
						updates: {
							transcriptDraft,
							transcriptEdit: transcriptDraft,
							transcriptApplied: compileTranscriptDraft({
								mediaElementId: activeMedia.element.id,
								draft: transcriptDraft,
								mediaStartTime: activeMedia.element.startTime,
								mediaDuration: activeMedia.element.duration,
							}),
							transcriptCompileState: {
								status: "idle",
								updatedAt: transcriptDraft.updatedAt,
							},
						},
					},
				],
				pushHistory: false,
			});

			setGenerateStep("Generating captions...");
			invokeAction("rebuild-captions-for-clip", {
				trackId: activeMedia.trackId,
				elementId: activeMedia.element.id,
			});
		} catch (error) {
			setGenerateError(
				error instanceof Error ? error.message : "Failed to generate captions.",
			);
		} finally {
			setIsGeneratingCaptions(false);
			setGenerateStep("");
			transcriptionStatus.stop(transcriptionOperationId);
			if (projectProcessId) {
				removeProcess({ id: projectProcessId });
			}
		}
	}, [
		activeMedia,
		activeMediaAsset,
		activeTranscriptDraft,
		editor,
		registerProcess,
		removeProcess,
		transcriptionStatus,
		updateProcessLabel,
	]);

	const applyTranscriptResultToActiveMedia = useCallback(
		({
			segments,
			words: timedWords,
			storeInProjectCache,
			successMessage,
		}: {
			segments: TranscriptionSegment[];
			words?: TranscriptionWord[];
			storeInProjectCache: boolean;
			successMessage: string;
		}) => {
			if (!activeMedia || !activeMediaAsset) {
				throw new Error("Select one uploaded audio/video element first.");
			}

			const updatedAt = new Date().toISOString();
			const normalizedTimedWords = timedWords ?? [];
			if (storeInProjectCache) {
				const cacheEntry = buildClipTranscriptCacheEntryForAsset({
					asset: activeMediaAsset,
					modelId: DEFAULT_TRANSCRIPTION_MODEL,
					language: "auto",
					text: segments
						.map((segment) => segment.text)
						.join(" ")
						.trim(),
					segments,
					words: normalizedTimedWords,
					updatedAt,
				});
				const linkKey =
					activeMediaAsset.transcriptLinkKey ??
					buildProjectMediaTranscriptLinkKey({ asset: activeMediaAsset });
				const latestProject = editor.project.getActive();
				editor.project.setActiveProject({
					project: {
						...latestProject,
						mediaTranscriptLinks: {
							...(latestProject.mediaTranscriptLinks ?? {}),
							[linkKey]: {
								modelId: DEFAULT_TRANSCRIPTION_MODEL,
								language: "auto",
								text: cacheEntry.transcript.text,
								segments: cacheEntry.transcript.segments,
								words: cacheEntry.transcript.words,
								updatedAt,
							},
						},
						clipTranscriptCache: {
							...(latestProject.clipTranscriptCache ?? {}),
							[cacheEntry.cacheKey]: cacheEntry.transcript,
						},
					},
				});
				editor.save.markDirty();
			}

			const sourceWindowWords = clipTranscriptWordsForWindow({
				words: normalizedTimedWords,
				startTime: activeMedia.element.trimStart,
				endTime: activeMedia.element.trimStart + activeMedia.element.duration,
			});
			const sourceWindowSegments =
				sourceWindowWords.length === 0
					? clipTranscriptSegmentsForWindow({
							segments,
							startTime: activeMedia.element.trimStart,
							endTime:
								activeMedia.element.trimStart + activeMedia.element.duration,
						})
					: [];
			if (sourceWindowWords.length === 0 && sourceWindowSegments.length === 0) {
				throw new Error("No transcript words found for this media window.");
			}

			const wordsForEdit =
				sourceWindowWords.length > 0
					? buildTranscriptWordsFromTimedWords({
							mediaElementId: activeMedia.element.id,
							words: sourceWindowWords,
						})
					: buildTranscriptWordsFromSegments({
							mediaElementId: activeMedia.element.id,
							segments: sourceWindowSegments,
						});
			const transcriptDraft = {
				version: 1 as const,
				source: "word-level" as const,
				words: wordsForEdit,
				cuts: buildTranscriptCutsFromWords({ words: wordsForEdit }),
				segmentsUi: buildDefaultTranscriptSegmentsUi({
					elementId: activeMedia.element.id,
					words: wordsForEdit,
				}),
				speakerLabels: buildSpeakerLabels({
					words: wordsForEdit,
					existingLabels: activeTranscriptDraft?.speakerLabels,
				}),
				gapEdits: activeTranscriptDraft?.gapEdits,
				updatedAt,
			};
			editor.timeline.updateElements({
				updates: [
					{
						trackId: activeMedia.trackId,
						elementId: activeMedia.element.id,
						updates: {
							transcriptDraft,
							transcriptEdit: transcriptDraft,
							transcriptApplied: compileTranscriptDraft({
								mediaElementId: activeMedia.element.id,
								draft: transcriptDraft,
								mediaStartTime: activeMedia.element.startTime,
								mediaDuration: activeMedia.element.duration,
							}),
							transcriptCompileState: {
								status: "idle",
								updatedAt: transcriptDraft.updatedAt,
							},
						},
					},
				],
				pushHistory: false,
			});

			setGenerateStep("Generating captions...");
			invokeAction("rebuild-captions-for-clip", {
				trackId: activeMedia.trackId,
				elementId: activeMedia.element.id,
			});
			toast.success(successMessage);
		},
		[activeMedia, activeMediaAsset, activeTranscriptDraft, editor],
	);

	const handleRefreshTranscript = useCallback(async () => {
		let transcriptionOperationId: string | undefined;
		let projectProcessId: string | undefined;
		try {
			if (!activeMedia || !activeMediaAsset) {
				throw new Error("Select one uploaded audio/video element first.");
			}
			setIsRefreshingTranscript(true);
			setGenerateError(null);
			setGenerateStep("Re-transcribing...");
			await waitForNextPaint();
			const activeProject = editor.project.getActive();
			const transcriptLinkKey =
				activeMediaAsset.transcriptLinkKey ??
				buildProjectMediaTranscriptLinkKey({ asset: activeMediaAsset });
			const clipTranscriptCacheKey = getClipTranscriptCacheKey({
				mediaId: activeMediaAsset.id,
				modelId: DEFAULT_TRANSCRIPTION_MODEL,
				language: "auto",
			});
			const nextMediaTranscriptLinks = {
				...(activeProject.mediaTranscriptLinks ?? {}),
			};
			const nextClipTranscriptCache = {
				...(activeProject.clipTranscriptCache ?? {}),
			};
			delete nextMediaTranscriptLinks[transcriptLinkKey];
			delete nextClipTranscriptCache[clipTranscriptCacheKey];
			editor.project.setActiveProject({
				project: {
					...activeProject,
					mediaTranscriptLinks: nextMediaTranscriptLinks,
					clipTranscriptCache: nextClipTranscriptCache,
				},
			});
			editor.save.markDirty();
			transcriptionOperationId = transcriptionStatus.start(
				"Re-transcribing media...",
			);
			projectProcessId = registerProcess({
				projectId: activeProject.metadata.id,
				kind: "transcription",
				label: "Re-generating transcript...",
			});

			const onProgress = (progress: TranscriptionProgress) => {
				if (progress.status === "loading-model") {
					setGenerateStep(`Loading model ${Math.round(progress.progress)}%`);
				} else if (progress.status === "transcribing") {
					setGenerateStep("Re-transcribing...");
				}
				transcriptionStatus.update({
					operationId: transcriptionOperationId,
					message: progress.message ?? "Re-generating transcript...",
					progress: progress.progress,
				});
				if (projectProcessId) {
					updateProcessLabel({
						id: projectProcessId,
						label:
							progress.message ??
							`Transcript refresh ${Math.round(progress.progress)}%`,
					});
				}
			};

			const freshResult = await transcribeClipTranscriptLocallyForAsset({
				asset: activeMediaAsset,
				modelId: DEFAULT_TRANSCRIPTION_MODEL,
				language: "auto",
				onProgress,
				bypassCache: true,
			});
			applyTranscriptResultToActiveMedia({
				segments: freshResult.segments,
				words: freshResult.words,
				storeInProjectCache: true,
				successMessage: "Transcript re-generated from source media",
			});
		} catch (error) {
			console.error("Transcript refresh failed", error);
			setGenerateError(
				error instanceof Error
					? error.message
					: "Failed to re-generate transcript.",
			);
		} finally {
			setIsRefreshingTranscript(false);
			setGenerateStep("");
			transcriptionStatus.stop(transcriptionOperationId);
			if (projectProcessId) {
				removeProcess({ id: projectProcessId });
			}
		}
	}, [
		activeMedia,
		activeMediaAsset,
		editor,
		registerProcess,
		removeProcess,
		transcriptionStatus,
		updateProcessLabel,
		applyTranscriptResultToActiveMedia,
	]);

	if (!activeMedia) {
		return (
			<PanelView title="Transcript & Captions" contentClassName="space-y-2">
				<div className="text-sm text-muted-foreground p-3 border rounded-md">
					Select a clip audio/video element to edit transcript words.
				</div>
			</PanelView>
		);
	}

	if (!hasLinkedCaptions || !hasTranscriptData) {
		return (
			<PanelView title="Transcript & Captions" contentClassName="space-y-2">
				<div className="text-sm text-muted-foreground p-3 border rounded-md">
					No captions for this clip.
				</div>
				{generateError && (
					<div className="bg-destructive/10 border-destructive/20 rounded-md border p-3">
						<p className="text-destructive text-sm">{generateError}</p>
					</div>
				)}
				{activeMediaAsset ? (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							onClick={() => void handleGenerateCaptions()}
							disabled={isGeneratingCaptions}
						>
							{isGeneratingCaptions && <Spinner className="mr-1" />}
							{isGeneratingCaptions
								? generateStep || "Generating..."
								: "Generate captions"}
						</Button>
					</div>
				) : (
					<div className="text-xs text-muted-foreground p-2 border rounded-md">
						Selected media is not transcribable (library audio is not
						supported).
					</div>
				)}
			</PanelView>
		);
	}

	return (
		<PanelView
			title="Transcript & Captions"
			contentClassName="space-y-3 pb-3"
			actions={
				<div className="flex items-center gap-1">
					{activeMediaAsset && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => void handleRefreshTranscript()}
							disabled={isRefreshingTranscript || isGeneratingCaptions}
						>
							{isRefreshingTranscript
								? "Re-generating..."
								: "Re-generate transcript"}
						</Button>
					)}
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
			{selectedWordIds.length > 1 && (
				<div className="pointer-events-none sticky top-2 z-20 flex h-0 justify-center overflow-visible">
					<div className="pointer-events-auto -translate-y-1 flex items-center justify-between gap-3 rounded-lg border border-zinc-700/90 bg-zinc-900/90 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
						<div className="whitespace-nowrap text-zinc-300">
							<span className="font-medium text-zinc-100">
								{selectedWordIds.length}
							</span>{" "}
							words selected
						</div>
						<div className="flex items-center gap-2">
							<Button
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-zinc-100 hover:bg-zinc-800"
								onClick={startEditingSelectedWords}
							>
								Edit
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-zinc-100 hover:bg-zinc-800"
								onClick={() =>
									invokeAction("transcript-set-words-removed", {
										trackId: activeMedia.trackId,
										elementId: activeMedia.element.id,
										wordIds: selectedWordIds,
										removed: !selectedWordsForEdit.every((word) => word.removed),
									})
								}
							>
								{selectedWordsForEdit.every((word) => word.removed)
									? "Restore"
									: "Remove"}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
								onClick={() => {
									setSelectedWordIdsIfChanged([]);
									setIsSelectionActive(false);
									window.getSelection()?.removeAllRanges();
								}}
							>
								Clear
							</Button>
						</div>
					</div>
				</div>
			)}
			<div
				ref={selectionContainerRef}
				className={[
					"space-y-4 [&_*::selection]:bg-transparent [&_*::selection]:text-inherit",
					isSelectionActive ? "cursor-text" : "",
				].join(" ")}
				onContextMenu={(event) => {
					event.preventDefault();
				}}
				onMouseDownCapture={(event) => {
					const target =
						event.target instanceof HTMLElement ? event.target : null;
					if (
						event.detail > 1 &&
						(target?.closest<HTMLElement>("[data-word-id]") ||
							target?.closest<HTMLElement>("[data-gap-id]"))
					) {
						event.preventDefault();
					}
					const clickedWordId =
						target?.closest<HTMLElement>("[data-word-id]")?.dataset.wordId ??
						null;
					const clickedGapId =
						target?.closest<HTMLElement>("[data-gap-id]")?.dataset.gapId ?? null;
					if (!clickedGapId) {
						setFocusedGap(null);
						clearGapEditingState();
					}
					if (!clickedWordId) {
						setFocusedWordId(null);
					}
					if (selectedWordIds.length === 0) return;
					if (
						(!clickedWordId || !selectedWordIdsSet.has(clickedWordId)) &&
						!clickedGapId
					) {
						setSelectedWordIdsIfChanged([]);
						setIsSelectionActive(false);
					}
				}}
			>
				<div className="px-1 py-1">
					{panelGroups.map((group, groupIndex) => {
						if (group.words.length === 0) return null;
						const start = group.words[0]?.startTime ?? 0;
						const timelineJumpTime = activeMedia.element.startTime +
							mapSourceTimeToCompressedTime({
								sourceTime: start,
								cuts,
							});
						const previousSpeakerId =
							groupIndex > 0 ? panelGroups[groupIndex - 1]?.speakerId : undefined;
						const showSpeakerHeader =
							Boolean(group.speakerId) && group.speakerId !== previousSpeakerId;
						return (
							<div
								key={group.id}
								className={[
									"space-y-3 px-1",
									showSpeakerHeader
										? groupIndex === 0
											? "pt-1"
											: "mt-7 border-t border-zinc-600/80 pt-7"
										: "mt-0.5",
								].join(" ")}
							>
								<div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3">
									<div className="pt-0.5">
										<button
											type="button"
											className="text-left text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300"
											onClick={() =>
												editor.playback.seek({
													time: Math.max(0, timelineJumpTime),
												})
											}
										>
											{formatTime(start)}
										</button>
									</div>
									<div className={showSpeakerHeader ? "space-y-4" : "space-y-2"}>
										{showSpeakerHeader && group.speakerId ? (
											<div className="flex items-center gap-2 text-xs">
												{editingSpeakerId === group.speakerId ? (
													<span className="inline-flex items-center gap-1">
														<input
															value={editingSpeakerName}
															onChange={(event) =>
																setEditingSpeakerName(event.target.value)
															}
															onKeyDown={(event) => {
																if (event.key === "Enter") {
																	commitSpeakerEdit();
																}
																if (event.key === "Escape") {
																	clearSpeakerEditingState();
																}
															}}
															className="h-7 min-w-28 border-b-2 bg-zinc-800 px-1 text-sm font-semibold text-zinc-100 shadow-sm outline-none"
															style={{
																borderBottomColor:
																	group.tone?.accent ??
																	"rgb(226 232 240)",
															}}
															autoFocus
														/>
														<Button
															variant="ghost"
															size="icon"
															className="size-6 bg-zinc-800 text-zinc-100 shadow-sm hover:bg-zinc-700"
															onClick={commitSpeakerEdit}
														>
															<Check className="size-3.5" />
														</Button>
														<Button
															variant="ghost"
															size="icon"
															className="size-6 bg-zinc-800 text-zinc-100 shadow-sm hover:bg-zinc-700"
															onClick={clearSpeakerEditingState}
														>
															<X className="size-3.5" />
														</Button>
													</span>
												) : (
													<button
														type="button"
														className="inline-flex items-center text-sm font-semibold transition-opacity hover:opacity-80"
														style={{
															color:
																group.tone?.accent ?? "rgb(226 232 240)",
														}}
														onClick={() => {
															setEditingSpeakerId(group.speakerId ?? null);
															setEditingSpeakerName(
																group.speakerLabel ?? "",
															);
														}}
													>
														<span>{group.speakerLabel}</span>
													</button>
												)}
											</div>
										) : null}
										<p
											className="select-text pr-1 text-[15px] leading-6 text-zinc-100"
											onMouseUp={(event) => {
												if (editingWordId) return;
												const target =
													event.target instanceof HTMLElement
														? event.target
														: null;
												if (!target) return;
												const wordId =
													target.closest<HTMLElement>("[data-word-id]")?.dataset
														.wordId ?? null;
												if (!wordId) return;
												const selection = window.getSelection();
												if (selection && !selection.isCollapsed) return;
												if (
													selectedWordIds.length > 1 &&
													selectedWordIdsSet.has(wordId)
												) {
													return;
												}
												setFocusedWordId(wordId);
											}}
										>
											{group.words.map((word, wordIndex) => {
									const isCurrentWord = currentWordId === word.id;
									const isCurrentHiddenWord = currentHiddenWordId === word.id;
									const isSelectedWord = selectedWordIds.includes(word.id);
									const isCaptionLinkedWord = selectedCaptionWordIds.has(word.id);
									const isFocusedWord = focusedWordId === word.id;
									const gap = nextPanelWordById.get(word.id);
									const nextWord = gap?.rightWord;
									const gapId = gap?.id ?? null;
									const isFocusedGap = focusedGap?.id === gapId;
									const gapEdit = nextWord
										? getTranscriptGapEdit({
												gapEdits,
												leftWordId: word.id,
												rightWordId: nextWord.id,
											})
										: undefined;
									const gapDurationSeconds = gap?.compressedDurationSeconds ?? 0;
									const gapWidthClass = getTranscriptGapWidthClass(
										gapDurationSeconds,
									);
									const gapIsSelected =
										Boolean(nextWord) && isFocusedGap;
									const gapIsCurrent =
										Boolean(nextWord) &&
										(currentWordId === word.id || currentWordId === nextWord.id);
									const isHoverSelectedGroupWord =
										isFocusedWord &&
										selectedWordIds.length > 1 &&
										selectedWordIdsSet.has(word.id);
									const tone = group.tone;
									const wordStyle = isCurrentWord
										? {
												backgroundColor: tone?.accent ?? "#0f766e",
												color: "#ffffff",
											}
										: isSelectedWord
											? {
													backgroundColor: tone?.accent ?? "#0f766e",
													color: "#ffffff",
												}
											: isHoverSelectedGroupWord
												? {
														backgroundColor:
															tone?.background ?? "rgba(39, 39, 42, 0.4)",
														color: "#ffffff",
													}
												: tone
													? { color: tone.mutedText }
													: { color: "#e4e4e7" };
									const removedWordDecorationStyle = word.removed
										? {
												textDecorationColor:
													tone?.accent ?? "#ef4444",
											}
										: undefined;
									const gapBaseAlpha = gapIsSelected || gapIsCurrent ? 0.34 : 0.16;
									const gapStyle =
										gapIsSelected || gapIsCurrent
											? {
													backgroundColor: hexToRgba(
														tone?.accent ?? "#a1a1aa",
														gapIsCurrent ? 0.42 : 0.3,
													),
												}
											: {
													backgroundColor: hexToRgba(
														tone?.accent ?? "#a1a1aa",
														gapBaseAlpha,
													),
												};
									const editingWidthCh = Math.max(
										word.text.length,
										editingWordText.length,
										3,
									);
									return (
										<span key={word.id} className="contents">
											<span
												className="relative group/word mr-1 inline-block my-1 align-baseline"
												data-word-id={word.id}
											>
												{isFocusedWord && selectedWordIds.length === 0 && (
													<span className="absolute left-0 bottom-full z-10 mb-1 flex items-center gap-1">
														<Button
															variant="ghost"
															size="sm"
															className="h-6 rounded-md border border-zinc-700 bg-zinc-900/95 px-1.5 text-[11px] text-zinc-100 shadow-sm hover:bg-zinc-800"
															onClick={() => startEditingWord(word)}
														>
															<Pencil className="mr-1 size-3" />
															Edit
														</Button>
														<Button
															variant="ghost"
															size="sm"
															className="h-6 rounded-md border border-zinc-700 bg-zinc-900/95 px-1.5 text-[11px] text-zinc-100 shadow-sm hover:bg-zinc-800"
															onClick={() =>
																invokeAction("transcript-toggle-word", {
																	trackId: activeMedia.trackId,
																	elementId: activeMedia.element.id,
																	wordId: word.id,
																})
															}
														>
															{word.removed ? "Restore" : "Mute"}
														</Button>
													</span>
												)}
												<span
													className={[
														"cursor-pointer rounded-sm px-1 py-0.5 select-text whitespace-nowrap",
														editingWordId === word.id ? "invisible" : "",
														!editingWordId && !isSelectionActive
															? ""
															: "",
														!isSelectionActive && isFocusedWord
															? "bg-zinc-800/40"
															: "",
														word.removed
															? "line-through decoration-red-600 decoration-2 opacity-75"
															: "",
														word.hidden ? "opacity-55" : "",
														isCurrentWord ? "text-white" : "",
														isCurrentHiddenWord
															? "bg-zinc-500/50 text-white"
															: "",
														isCaptionLinkedWord
															? "ring-2 ring-primary/80 ring-offset-1 ring-offset-zinc-950/80"
															: "",
													]
														.filter(Boolean)
														.join(" ")}
													style={{
														...wordStyle,
														...removedWordDecorationStyle,
													}}
													onMouseEnter={(event) => {
														if (editingWordId || !tone) return;
														if (!isCurrentWord && !isSelectedWord) {
															event.currentTarget.style.backgroundColor =
																hexToRgba(tone.accent, 0.1);
														}
													}}
													onMouseLeave={(event) => {
														if (editingWordId || isCurrentWord || isSelectedWord) {
															return;
														}
														event.currentTarget.style.backgroundColor = "";
													}}
													onDoubleClick={(event) => {
														event.preventDefault();
														event.stopPropagation();
														window.getSelection()?.removeAllRanges();
														startEditingWord(word);
													}}
													onContextMenu={(event) => {
														event.preventDefault();
														event.stopPropagation();
														setFocusedWordId(word.id);
														invokeAction("transcript-toggle-word", {
															trackId: activeMedia.trackId,
															elementId: activeMedia.element.id,
															wordId: word.id,
														});
													}}
												>
													{word.text}
												</span>
												{editingWordId === word.id && (
													<span className="absolute left-0 top-1/2 z-20 inline-flex -translate-y-1/2 items-center rounded-sm border border-zinc-500 bg-zinc-800 px-2 pr-1 align-middle shadow-sm">
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
															className="min-w-0 bg-transparent text-sm font-medium text-zinc-100 outline-none"
															style={{ width: `${editingWidthCh}ch` }}
															autoFocus
														/>
														<Button
															variant="ghost"
															size="icon"
															className="size-6 text-zinc-100 hover:bg-emerald-950/60"
															onClick={commitWordEdit}
														>
															<Check className="size-3.5" />
														</Button>
														<Button
															variant="ghost"
															size="icon"
															className="size-6 text-zinc-100 hover:bg-rose-950/60"
															onClick={clearEditingState}
														>
															<X className="size-3.5" />
														</Button>
													</span>
												)}
											</span>
											{nextWord ? (
												<span
													role="button"
													tabIndex={0}
													aria-label={`Select gap between ${word.text} and ${nextWord.text}`}
													data-gap-id={gapId ?? undefined}
													title={`${gapDurationSeconds.toFixed(2)}s playback gap${gap ? ` (${gap.sourceDurationSeconds.toFixed(2)}s source)` : ""}`}
													className={[
														"relative mx-1 inline-flex h-[1.05em] min-w-2.5 max-w-6 cursor-pointer items-center justify-center align-middle px-0.5 text-[11px] leading-none transition-none",
														gapWidthClass,
														!editingWordId ? "opacity-80 hover:opacity-100" : "",
													].join(" ")}
													style={gapStyle}
													onMouseEnter={(event) => {
														if (!tone) return;
														event.currentTarget.style.backgroundColor = hexToRgba(
															tone.accent,
															0.24,
														);
													}}
													onMouseLeave={(event) => {
														event.currentTarget.style.backgroundColor =
															String(gapStyle.backgroundColor);
													}}
													onClick={(event) => {
														event.stopPropagation();
														focusWordGap(word.id, nextWord.id);
													}}
													onDoubleClick={(event) => {
														event.preventDefault();
														event.stopPropagation();
														startEditingGap(word.id, nextWord.id);
													}}
													onContextMenu={(event) => {
														event.preventDefault();
														event.stopPropagation();
														focusWordGap(word.id, nextWord.id);
														invokeAction("transcript-toggle-gap-removed", {
															trackId: activeMedia.trackId,
															elementId: activeMedia.element.id,
															leftWordId: word.id,
															rightWordId: nextWord.id,
															removed: !Boolean(gapEdit?.removed),
														});
													}}
													onKeyDown={(event) => {
														if (event.key === "Enter" || event.key === " ") {
															event.preventDefault();
															focusWordGap(word.id, nextWord.id);
														}
													}}
												>
													{gapEdit?.removed ? (
														<span
															aria-hidden="true"
															className="pointer-events-none absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 border-t-2"
															style={{
																borderTopColor:
																	tone?.accent ?? "#ef4444",
															}}
														/>
													) : null}
													<span
														className={[
															"pointer-events-none whitespace-pre",
														]
															.filter(Boolean)
															.join(" ")}
														style={{
															color: tone?.accent ?? "#d4d4d8",
															opacity: gapEdit?.removed ? 0.78 : 0.6,
														}}
													>
														{gapEdit?.text && gapEdit.text !== " "
															? gapEdit.text
															: " "}
													</span>
													{isFocusedGap && selectedWordIds.length === 0 && (
														<span className="absolute left-1/2 bottom-full z-10 mb-1 flex -translate-x-1/2 items-center gap-1">
															{editingGapId === gapId ? (
																<span className="inline-flex items-center gap-1 rounded-sm border border-zinc-700 bg-zinc-900/95 px-1.5 py-1 shadow-sm">
																	<input
																		value={editingGapText}
																		onChange={(event) =>
																			setEditingGapText(event.target.value)
																		}
																		onKeyDown={(event) => {
																			if (event.key === "Enter") {
																				commitGapEdit();
																			}
																			if (event.key === "Escape") {
																				clearGapEditingState();
																			}
																		}}
																		className="min-w-[3ch] bg-transparent text-[11px] text-zinc-100 outline-none"
																		style={{
																			width: `${Math.max(3, editingGapText.length + 1)}ch`,
																		}}
																		autoFocus
																	/>
																	<Button
																		variant="ghost"
																		size="icon"
																		className="size-5 text-zinc-100 hover:bg-zinc-800"
																		onClick={commitGapEdit}
																	>
																		<Check className="size-3" />
																	</Button>
																	<Button
																		variant="ghost"
																		size="icon"
																		className="size-5 text-zinc-100 hover:bg-zinc-800"
																		onClick={clearGapEditingState}
																	>
																		<X className="size-3" />
																	</Button>
																</span>
															) : (
																<>
																	<Button
																		variant="ghost"
																		size="sm"
																		className="h-6 rounded-md border border-zinc-700 bg-zinc-900/95 px-1.5 text-[11px] text-zinc-100 shadow-sm hover:bg-zinc-800"
																		onClick={() =>
																			startEditingGap(word.id, nextWord.id)
																		}
																	>
																		<Pencil className="mr-1 size-3" />
																		Edit
																	</Button>
																	<Button
																		variant="ghost"
																		size="sm"
																		className="h-6 rounded-md border border-zinc-700 bg-zinc-900/95 px-1.5 text-[11px] text-zinc-100 shadow-sm hover:bg-zinc-800"
																		onClick={() =>
																			invokeAction("transcript-toggle-gap-removed", {
																				trackId: activeMedia.trackId,
																				elementId: activeMedia.element.id,
																				leftWordId: word.id,
																				rightWordId: nextWord.id,
																				removed: !Boolean(gapEdit?.removed),
																			})
																		}
																	>
																		{gapEdit?.removed ? "Restore" : "Mute"}
																	</Button>
																</>
															)}
														</span>
													)}
												</span>
											) : null}
										</span>
									);
								})}
										</p>
									</div>
								</div>
							</div>
						);
					})}
				</div>
			</div>

			<div className="text-[11px] text-muted-foreground px-1 flex items-center gap-1">
				<AlignJustify className="size-3.5" />
				Transcript edits update captions, playback, and export
				non-destructively.
			</div>
			{transcriptCompileState.status === "compiling" && (
				<div className="text-[11px] text-muted-foreground px-1 flex items-center gap-1">
					<Spinner className="size-3" />
					Updating clip playback…
				</div>
			)}
			{isRefreshingTranscript && (
				<div className="text-[11px] text-muted-foreground px-1 flex items-center gap-1">
					<Spinner className="size-3" />
					Re-generating transcript from source media...
				</div>
			)}
		</PanelView>
	);
}
