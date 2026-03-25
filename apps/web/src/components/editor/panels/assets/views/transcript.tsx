"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { TranscriptTimingView } from "@/components/editor/panels/assets/views/transcript-timing-view";
import { useEditor } from "@/hooks/use-editor";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { invokeAction } from "@/lib/actions";
import { DEFAULT_TRANSCRIPTION_MODEL } from "@/constants/transcription-constants";
import {
	applyCutRangesToWords,
	buildTranscriptGapId,
	detectTranscriptFillerCandidates,
	getTranscriptGapEdit,
	buildTranscriptCutsFromWords,
	mapCompressedTimeToSourceTime,
	mapSourceTimeToCompressedTime,
	normalizeTranscriptWords,
} from "@/lib/transcript-editor/core";
import { buildTranscriptWordsFromCaptionTimings } from "@/lib/transcript-editor/caption-fallback";
import { MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS } from "@/lib/transcript-editor/constants";
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
	clipTranscriptWordsForWindow,
	getClipTranscriptCacheKey,
	getOrCreateClipTranscriptForAsset,
	transcribeClipTranscriptLocallyForAsset,
} from "@/lib/clips/transcript";
import {
	cancelPreparedPlaybackStart,
	startPlaybackWithAudioWarmup,
} from "@/lib/playback/start-playback";
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
import {
	Check,
	ChevronDown,
	ChevronUp,
	Pencil,
	RefreshCw,
	RotateCcw,
	X,
} from "lucide-react";
import { useTranscriptionStatusStore } from "@/stores/transcription-status-store";
import { useProjectProcessStore } from "@/stores/project-process-store";
import { MIN_TRANSCRIPT_WORD_DURATION_SECONDS } from "@/lib/transcript-editor/timing";

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

type HeldWordPreview = {
	wordIds: string[];
	startTime: number;
	endTime: number;
	gapId?: string;
};

type TranscriptPanelGap = {
	id: string;
	leftWordId: string;
	rightWordId: string;
	rightWord: TranscriptEditWord;
	sourceDurationSeconds: number;
	compressedDurationSeconds: number;
	compressedStartTime: number;
	compressedEndTime: number;
};

const MAX_DISFLUENCY_REPEAT_GAP_SECONDS = 0.35;
const HOLD_TO_PREVIEW_CANCEL_DISTANCE_PX = 5;
const HOLD_TO_PREVIEW_CANCEL_DISTANCE_SQUARED_PX =
	HOLD_TO_PREVIEW_CANCEL_DISTANCE_PX * HOLD_TO_PREVIEW_CANCEL_DISTANCE_PX;
const MIN_HOLD_PREVIEW_DURATION_SECONDS = MIN_TRANSCRIPT_WORD_DURATION_SECONDS;
const HOLD_PREVIEW_STOP_EPSILON_SECONDS = 0.001;

function getWordPreviewStartTime({
	word,
}: {
	word: TranscriptEditWord;
	previousWord: TranscriptEditWord | null;
}): number {
	return word.startTime;
}

function getWordPreviewEndTime({
	word,
}: {
	word: TranscriptEditWord;
	nextWord: TranscriptEditWord | null;
}): number {
	return word.endTime;
}

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

function normalizeTranscriptDisplayToken(token: string): string {
	return token
		.toLowerCase()
		.replace(/[^\p{L}\p{N}'\s]+/gu, "")
		.trim();
}

function hasExpandedSelectionWithinContainer(container: HTMLElement | null) {
	if (!container) return false;
	const selection = window.getSelection();
	return Boolean(
		selection &&
			!selection.isCollapsed &&
			container.contains(selection.anchorNode) &&
			container.contains(selection.focusNode),
	);
}

function getEventTargetElement(target: EventTarget | null): HTMLElement | null {
	if (target instanceof HTMLElement) return target;
	if (target instanceof Node) return target.parentElement;
	return null;
}

function findScrollableAncestor(
	element: HTMLElement | null,
): HTMLElement | null {
	let current = element?.parentElement ?? null;
	while (current) {
		const style = window.getComputedStyle(current);
		if (
			(style.overflowY === "auto" || style.overflowY === "scroll") &&
			current.scrollHeight > current.clientHeight
		) {
			return current;
		}
		current = current.parentElement;
	}
	return null;
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
		const nextWord = words[index + 1];
		let effectiveEndTime = word.endTime;
		if (
			nextWord &&
			Boolean(nextWord.hidden) === matchHidden &&
			!nextWord.removed &&
			nextWord.startTime < effectiveEndTime
		) {
			effectiveEndTime =
				nextWord.startTime > word.startTime
					? nextWord.startTime
					: Math.min(effectiveEndTime, nextWord.endTime);
		}
		effectiveEndTime = Math.max(word.startTime + 0.01, effectiveEndTime);
		if (time >= word.startTime && time < effectiveEndTime) {
			return word.id;
		}
		if (time < effectiveEndTime) {
			continue;
		}
		if (!nextWord) {
			continue;
		}
		const gapSeconds = nextWord.startTime - effectiveEndTime;
		if (
			gapSeconds > 0 &&
			gapSeconds < MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS &&
			time < nextWord.startTime
		) {
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
				: (formatSpeakerLabel({ speakerId }) ?? speakerId);
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
	const isPlaying = editor.playback.getIsPlaying();
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
	const [editingSpeakerGroupId, setEditingSpeakerGroupId] = useState<
		string | null
	>(null);
	const [editingSpeakerName, setEditingSpeakerName] = useState("");
	const [isTimingToolbarExpanded, setIsTimingToolbarExpanded] = useState(true);
	const [timingAnchorWordId, setTimingAnchorWordId] = useState<string | null>(
		null,
	);
	const [persistedTimingWordId, setPersistedTimingWordId] = useState<
		string | null
	>(null);
	const [, setTranscriptUiRefreshVersion] = useState(0);
	const [heldWordPreview, setHeldWordPreview] =
		useState<HeldWordPreview | null>(null);
	const previewCurrentTime = heldWordPreview
		? Math.min(
				currentTime,
				Math.max(
					heldWordPreview.startTime,
					heldWordPreview.endTime - HOLD_PREVIEW_STOP_EPSILON_SECONDS,
				),
			)
		: currentTime;
	const selectionContainerRef = useRef<HTMLDivElement | null>(null);
	const activeMediaRef = useRef<MediaRef | null>(null);
	const orderedWordIdsRef = useRef<string[]>([]);
	const originalTimingWordsCacheRef = useRef<Map<string, TranscriptEditWord[]>>(
		new Map(),
	);
	const heldWordPreviewRef = useRef<HeldWordPreview | null>(null);
	const editingWordIdRef = useRef<string | null>(null);
	const editingSpeakerInputRef = useRef<HTMLInputElement | null>(null);
	const editingWordInputRef = useRef<HTMLInputElement | null>(null);
	const editingGapInputRef = useRef<HTMLInputElement | null>(null);
	const transcriptSourceKeyRef = useRef<string | null>(null);
	const transcriptScrollContainerRef = useRef<HTMLElement | null>(null);
	const selectedWordIdsRef = useRef<string[]>([]);
	const holdPreviewTimeoutRef = useRef<number | null>(null);
	const holdPreviewPointerIdRef = useRef<number | null>(null);
	const holdPreviewOriginRef = useRef<{ x: number; y: number } | null>(null);
	const heldPreviewEnteredRangeRef = useRef(false);
	const suppressClickSeekRef = useRef(false);
	const selectedCaption = useMemo(
		() => getSelectedCaptionElement({ tracks, selectedElements }),
		[tracks, selectedElements],
	);
	const activeProjectId =
		editor.project.getActive()?.metadata.id ?? "no-project";

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
	const activeWaveformEnvelope = useMemo(() => {
		if (!activeMedia) return undefined;
		const activeProject = editor.project.getActive();
		const waveformCache = activeProject?.waveformPeaksCache ?? {};
		if (activeMedia.element.type === "video") {
			return activeMediaAsset
				? waveformCache[`media:${activeMediaAsset.id}`]
				: undefined;
		}
		if (activeMedia.element.sourceType === "upload" && activeMediaAsset) {
			return waveformCache[`media:${activeMediaAsset.id}`];
		}
		if (activeMedia.element.sourceType === "library") {
			return waveformCache[`library:${activeMedia.element.sourceUrl}`];
		}
		return undefined;
	}, [activeMedia, activeMediaAsset, editor]);
	const activeWaveformSource = useMemo(() => {
		if (!activeMedia) return null;
		if (activeMedia.element.type === "video") {
			if (!activeMediaAsset) return null;
			return {
				audioFile: activeMediaAsset.file,
				audioUrl: activeMediaAsset.url,
				cacheKey: `media:${activeMediaAsset.id}`,
			};
		}
		if (activeMedia.element.buffer) {
			return {
				audioBuffer: activeMedia.element.buffer,
				cacheKey:
					activeMedia.element.sourceType === "upload"
						? `media:${activeMedia.element.mediaId}`
						: `library:${activeMedia.element.sourceUrl}`,
			};
		}
		if (activeMedia.element.sourceType === "upload" && activeMediaAsset) {
			return {
				audioFile: activeMediaAsset.file,
				audioUrl: activeMediaAsset.url,
				cacheKey: `media:${activeMediaAsset.id}`,
			};
		}
		if (activeMedia.element.sourceType === "library") {
			return {
				audioUrl: activeMedia.element.sourceUrl,
				cacheKey: `library:${activeMedia.element.sourceUrl}`,
			};
		}
		return null;
	}, [activeMedia, activeMediaAsset]);
	const persistActiveWaveformEnvelope = useCallback(
		(envelope: {
			version: 2;
			sourceDurationSeconds: number;
			bucketsPerSecond: number;
			peaks: number[];
		}) => {
			if (!activeWaveformSource?.cacheKey || envelope.peaks.length === 0)
				return;
			const currentProject = editor.project.getActive();
			if (!currentProject) return;
			const existing =
				currentProject.waveformPeaksCache?.[activeWaveformSource.cacheKey];
			if (
				existing &&
				existing.version === envelope.version &&
				existing.sourceDurationSeconds === envelope.sourceDurationSeconds &&
				existing.bucketsPerSecond === envelope.bucketsPerSecond &&
				existing.peaks.length === envelope.peaks.length
			) {
				return;
			}
			editor.project.setActiveProject({
				project: {
					...currentProject,
					waveformPeaksCache: {
						...(currentProject.waveformPeaksCache ?? {}),
						[activeWaveformSource.cacheKey]: {
							...envelope,
							updatedAt: new Date().toISOString(),
						},
					},
				},
			});
			editor.save.markDirty();
		},
		[activeWaveformSource, editor],
	);
	const activeTranscriptSourceKey = activeMedia
		? `${activeProjectId}:${activeMedia.trackId}:${activeMedia.element.id}`
		: `${activeProjectId}:none`;

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
	const originalTimingWords = useMemo(() => {
		if (!activeMedia) return [];
		const projectionWords =
			activeTranscriptDraft?.projectionSource?.words ?? null;
		if (projectionWords && projectionWords.length > 0) {
			const normalizedProjectionWords = normalizeTranscriptWords({
				words: projectionWords,
			}).filter((word) => !word.removed && !word.hidden);
			originalTimingWordsCacheRef.current.set(
				activeTranscriptSourceKey,
				normalizedProjectionWords.map((word) => ({ ...word })),
			);
			return normalizedProjectionWords;
		}

		const cached =
			originalTimingWordsCacheRef.current.get(activeTranscriptSourceKey) ??
			null;
		if (cached && cached.length > 0) {
			return cached;
		}

		const baselineWords =
			words.length > 0
				? words
				: getFallbackWordsFromCaptions({
						tracks,
						mediaElementId: activeMedia.element.id,
					});
		const normalizedBaselineWords = normalizeTranscriptWords({
			words: baselineWords,
		}).filter((word) => !word.removed && !word.hidden);
		if (normalizedBaselineWords.length > 0) {
			originalTimingWordsCacheRef.current.set(
				activeTranscriptSourceKey,
				normalizedBaselineWords.map((word) => ({ ...word })),
			);
		}
		return normalizedBaselineWords;
	}, [
		activeMedia,
		activeTranscriptDraft?.projectionSource?.words,
		activeTranscriptSourceKey,
		tracks,
		words,
	]);

	const cuts = !activeMedia
		? buildTranscriptCutsFromWords({ words })
		: !activeTranscriptDraft
			? buildTranscriptCutsFromWords({ words })
			: getEffectiveTranscriptCutsFromTranscriptEdit({
					transcriptEdit: activeTranscriptDraft,
				});
	const wordsWithCutState = applyCutRangesToWords({
		words,
		cuts,
	});
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
	const visibleTranscriptWords = useMemo(
		() => wordsWithCutState.filter((word) => !word.removed && !word.hidden),
		[wordsWithCutState],
	);
	const timingToolbarWords = useMemo(
		() => wordsWithCutState.filter((word) => !word.hidden),
		[wordsWithCutState],
	);
	const currentSourceTime = useMemo(() => {
		if (!activeMedia) return null;
		const localCompressed = Math.max(
			0,
			previewCurrentTime - activeMedia.element.startTime,
		);
		return mapCompressedTimeToSourceTime({
			compressedTime: localCompressed,
			cuts,
		});
	}, [activeMedia, previewCurrentTime, cuts]);
	const currentCompressedTime = useMemo(() => {
		if (!activeMedia) return null;
		return Math.max(0, previewCurrentTime - activeMedia.element.startTime);
	}, [activeMedia, previewCurrentTime]);

	const currentWordId = useMemo(() => {
		if (currentSourceTime == null) return null;
		return findActiveWordIdAtSourceTime({
			words: visibleTranscriptWords,
			time: currentSourceTime,
			matchHidden: false,
		});
	}, [currentSourceTime, visibleTranscriptWords]);

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
				speakerIds.map((speakerId, index) => [
					speakerId,
					getSpeakerTone(index),
				]),
			),
		[speakerIds],
	);
	const fillerCandidates = useMemo(
		() => detectTranscriptFillerCandidates({ words: wordsWithCutState }),
		[wordsWithCutState],
	);
	const fillerCandidateByStartWordId = useMemo(() => {
		const map = new Map<
			string,
			{
				id: string;
				wordIds: string[];
				text: string;
				startTime: number;
				endTime: number;
				kind: "phrase" | "repeat";
			}
		>();
		for (const candidate of fillerCandidates) {
			const firstWordId = candidate.wordIds[0];
			if (!firstWordId) continue;
			map.set(firstWordId, {
				id: candidate.id,
				wordIds: candidate.wordIds,
				text: `[${candidate.text}]`,
				startTime: candidate.startTime,
				endTime: candidate.endTime,
				kind: candidate.kind === "phrase" ? "phrase" : "repeat",
			});
		}
		return map;
	}, [fillerCandidates]);
	const wordById = useMemo(
		() => new Map(wordsWithCutState.map((word) => [word.id, word])),
		[wordsWithCutState],
	);
	const coveredFillerWordIds = useMemo(() => {
		const ids = new Set<string>();
		for (const candidate of fillerCandidates) {
			for (const wordId of candidate.wordIds.slice(1)) {
				ids.add(wordId);
			}
		}
		return ids;
	}, [fillerCandidates]);
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
	const previousPanelWordById = useMemo(() => {
		const previousWordMap = new Map<string, TranscriptEditWord>();
		for (let index = 1; index < orderedPanelWords.length; index++) {
			const previous = orderedPanelWords[index - 1];
			const current = orderedPanelWords[index];
			if (!previous || !current) continue;
			previousWordMap.set(current.id, previous);
		}
		return previousWordMap;
	}, [orderedPanelWords]);
	const nextPanelWordById = useMemo(() => {
		const nextWordMap = new Map<string, TranscriptPanelGap>();
		for (let index = 0; index < orderedPanelWords.length - 1; index++) {
			const current = orderedPanelWords[index];
			const next = orderedPanelWords[index + 1];
			if (!current || !next) continue;
			const currentToken = normalizeTranscriptDisplayToken(current.text);
			const nextToken = normalizeTranscriptDisplayToken(next.text);
			const gapId = buildTranscriptGapId(current.id, next.id);
			const gapEdit = gapEdits[gapId];
			const sourceDurationSeconds = Math.max(
				0,
				next.startTime - current.endTime,
			);
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
			const compressedStartTime = mapSourceTimeToCompressedTime({
				sourceTime: current.endTime,
				cuts,
			});
			const compressedEndTime = compressedStartTime + compressedDurationSeconds;
			const hasPlayableGap =
				compressedDurationSeconds >= MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS;
			const hasExplicitGapEdit =
				Boolean(gapEdit?.removed) ||
				(typeof gapEdit?.text === "string" && gapEdit.text !== " ");
			const isImmediateRepeatedWord =
				Boolean(currentToken) &&
				currentToken === nextToken &&
				current.speakerId === next.speakerId &&
				sourceDurationSeconds <= MAX_DISFLUENCY_REPEAT_GAP_SECONDS &&
				compressedDurationSeconds <= MAX_DISFLUENCY_REPEAT_GAP_SECONDS;
			if (isImmediateRepeatedWord && !hasExplicitGapEdit) {
				continue;
			}
			if (!hasPlayableGap && !hasExplicitGapEdit) {
				continue;
			}
			nextWordMap.set(current.id, {
				id: gapId,
				leftWordId: current.id,
				rightWordId: next.id,
				rightWord: next,
				sourceDurationSeconds,
				compressedDurationSeconds,
				compressedStartTime,
				compressedEndTime,
			});
		}
		return nextWordMap;
	}, [cuts, gapEdits, orderedPanelWords]);
	const currentGapId = useMemo(() => {
		if (currentCompressedTime == null) return null;
		for (const gap of nextPanelWordById.values()) {
			if (
				currentCompressedTime >= gap.compressedStartTime &&
				currentCompressedTime < gap.compressedEndTime
			) {
				return gap.id;
			}
		}
		return null;
	}, [currentCompressedTime, nextPanelWordById]);
	const activeWordId = currentGapId ? null : currentWordId;
	const activeHiddenWordId = currentGapId ? null : currentHiddenWordId;
	const effectiveTimingWordId = currentWordId ?? focusedWordId;
	const displayedTimingWordId = effectiveTimingWordId ?? timingAnchorWordId;
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
		const highlighted = visibleTranscriptWords
			.filter((word) =>
				ranges.some(
					(range) => word.endTime > range.start && word.startTime < range.end,
				),
			)
			.map((word) => word.id);
		if (highlighted.length === 0) return new Set<string>();
		if (highlighted.length === visibleTranscriptWords.length) {
			return new Set<string>();
		}
		return new Set(highlighted);
	}, [selectedCaption, activeMedia, cuts, visibleTranscriptWords]);
	const selectedWordIdsSet = useMemo(
		() => new Set(selectedWordIds),
		[selectedWordIds],
	);
	const selectedWordsForEdit = useMemo(
		() => wordsWithCutState.filter((word) => selectedWordIdsSet.has(word.id)),
		[wordsWithCutState, selectedWordIdsSet],
	);
	const heldWordPreviewIds = useMemo(
		() => new Set(heldWordPreview?.wordIds ?? []),
		[heldWordPreview],
	);
	const timingToolbarWordId =
		displayedTimingWordId ??
		persistedTimingWordId ??
		timingToolbarWords[0]?.id ??
		null;
	const shouldRenderTimingToolbar =
		Boolean(activeMedia) && timingToolbarWords.length > 0;
	const isTimingViewVisible =
		shouldRenderTimingToolbar && (isTimingToolbarExpanded || isPlaying);
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
		if (!effectiveTimingWordId) return;
		setTimingAnchorWordId((current) =>
			current === effectiveTimingWordId ? current : effectiveTimingWordId,
		);
	}, [effectiveTimingWordId]);

	useEffect(() => {
		if (!displayedTimingWordId) return;
		setPersistedTimingWordId((current) =>
			current === displayedTimingWordId ? current : displayedTimingWordId,
		);
	}, [displayedTimingWordId]);

	useEffect(() => {
		if (!timingAnchorWordId) return;
		if (wordsWithCutState.some((word) => word.id === timingAnchorWordId))
			return;
		setTimingAnchorWordId(visibleTranscriptWords[0]?.id ?? null);
	}, [timingAnchorWordId, visibleTranscriptWords, wordsWithCutState]);

	useEffect(() => {
		if (!persistedTimingWordId) return;
		if (wordsWithCutState.some((word) => word.id === persistedTimingWordId)) {
			return;
		}
		setPersistedTimingWordId(visibleTranscriptWords[0]?.id ?? null);
	}, [persistedTimingWordId, visibleTranscriptWords, wordsWithCutState]);

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
		if (!editingSpeakerGroupId) return;
		if (!panelGroups.some((group) => group.id === editingSpeakerGroupId)) {
			setEditingSpeakerGroupId(null);
			setEditingSpeakerName("");
		}
	}, [editingSpeakerGroupId, panelGroups]);

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
		if (!isPlaying) return;
		setSelectedWordIdsIfChanged([]);
		setIsSelectionActive(false);
		window.getSelection()?.removeAllRanges();
		if (currentWordId) {
			setFocusedWordId(currentWordId);
			setFocusedGap(null);
		}
	}, [currentWordId, isPlaying, setSelectedWordIdsIfChanged]);

	const clearHeldWordPreviewTimer = useCallback(() => {
		if (holdPreviewTimeoutRef.current !== null) {
			window.clearTimeout(holdPreviewTimeoutRef.current);
			holdPreviewTimeoutRef.current = null;
		}
	}, []);

	const stopHeldWordPreview = useCallback(() => {
		const preview = heldWordPreviewRef.current;
		clearHeldWordPreviewTimer();
		holdPreviewPointerIdRef.current = null;
		holdPreviewOriginRef.current = null;
		heldPreviewEnteredRangeRef.current = false;
		setHeldWordPreview(null);
		cancelPreparedPlaybackStart({ editor });
		editor.playback.pause();
		editor.playback.clearTransientPlaybackRange();
		if (preview) {
			editor.playback.seek({ time: preview.startTime });
		}
	}, [clearHeldWordPreviewTimer, editor]);

	useEffect(() => {
		if (!heldWordPreview) return;
		if (
			currentTime >= heldWordPreview.startTime &&
			currentTime <= heldWordPreview.endTime
		) {
			heldPreviewEnteredRangeRef.current = true;
		}
		if (!heldPreviewEnteredRangeRef.current) return;
		if (
			currentTime <
			heldWordPreview.endTime - HOLD_PREVIEW_STOP_EPSILON_SECONDS
		) {
			return;
		}
		stopHeldWordPreview();
	}, [currentTime, heldWordPreview, stopHeldWordPreview]);

	useEffect(() => {
		activeMediaRef.current = activeMedia;
	}, [activeMedia]);

	useEffect(() => {
		transcriptScrollContainerRef.current = findScrollableAncestor(
			selectionContainerRef.current,
		);
	}, []);

	useEffect(() => {
		heldWordPreviewRef.current = heldWordPreview;
	}, [heldWordPreview]);

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
		if (!isPlaying || !currentWordId) return;
		const selectionContainer = selectionContainerRef.current;
		const scrollContainer = transcriptScrollContainerRef.current;
		if (!selectionContainer || !scrollContainer) return;

		const activeWordNode = selectionContainer.querySelector<HTMLElement>(
			`[data-word-id="${currentWordId}"]`,
		);
		if (!activeWordNode) return;

		const containerRect = scrollContainer.getBoundingClientRect();
		const wordRect = activeWordNode.getBoundingClientRect();
		const viewportHeight = scrollContainer.clientHeight;
		if (viewportHeight <= 0) return;

		const footerReservePx = 132;
		const revealTop = containerRect.top + viewportHeight * 0.12;
		const revealBottom =
			containerRect.top +
			Math.max(viewportHeight * 0.58, viewportHeight - footerReservePx);
		if (wordRect.top >= revealTop && wordRect.bottom <= revealBottom) {
			return;
		}

		const wordCenterY =
			wordRect.top -
			containerRect.top +
			scrollContainer.scrollTop +
			wordRect.height / 2;
		const targetTop = Math.max(0, wordCenterY - viewportHeight * 0.35);
		scrollContainer.scrollTo({
			top: targetTop,
			behavior: "smooth",
		});
	}, [currentWordId, isPlaying]);

	useEffect(() => {
		const captureSelectionWords = () => {
			const container = selectionContainerRef.current;
			if (!container) {
				stopHeldWordPreview();
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
			stopHeldWordPreview();
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
				.flatMap((node) =>
					(node.dataset.wordIds ?? node.dataset.wordId ?? "")
						.split(",")
						.map((id) => id.trim()),
				)
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
	}, [setSelectedWordIdsIfChanged, stopHeldWordPreview]);

	const clearEditingState = useCallback(() => {
		setEditingWordId(null);
		setEditingWordText("");
		setEditingTargetWordIds([]);
	}, []);

	const clearGapEditingState = useCallback(() => {
		setEditingGapId(null);
		setEditingGapText(" ");
	}, []);

	useEffect(() => {
		return () => {
			stopHeldWordPreview();
		};
	}, [stopHeldWordPreview]);

	const seekToTranscriptWord = useCallback(
		(word: TranscriptEditWord) => {
			if (!activeMedia) return;
			editor.playback.seek({
				time:
					activeMedia.element.startTime +
					mapSourceTimeToCompressedTime({
						sourceTime: word.startTime,
						cuts,
					}),
			});
		},
		[activeMedia, cuts, editor],
	);

	const startHeldWordPreview = useCallback(
		({
			wordIds,
			wordStartTime,
			wordEndTime,
			gapId,
		}: {
			wordIds: string[];
			wordStartTime: number;
			wordEndTime: number;
			gapId?: string;
		}) => {
			if (!activeMedia) return;
			const timelineStart =
				activeMedia.element.startTime +
				mapSourceTimeToCompressedTime({
					sourceTime: wordStartTime,
					cuts,
				});
			const timelineEnd =
				activeMedia.element.startTime +
				mapSourceTimeToCompressedTime({
					sourceTime: wordEndTime,
					cuts,
				});
			const boundedEnd = Math.max(
				timelineStart + MIN_HOLD_PREVIEW_DURATION_SECONDS,
				timelineEnd,
			);
			const previewOutPoint = Math.max(
				timelineStart + Math.min(0.01, MIN_HOLD_PREVIEW_DURATION_SECONDS),
				boundedEnd - HOLD_PREVIEW_STOP_EPSILON_SECONDS,
			);
			heldPreviewEnteredRangeRef.current = false;
			suppressClickSeekRef.current = true;
			setHeldWordPreview({
				wordIds,
				startTime: timelineStart,
				endTime: previewOutPoint,
				gapId,
			});
			editor.playback.pause();
			editor.playback.setTransientPlaybackRange({
				inPoint: timelineStart,
				outPoint: previewOutPoint,
			});
			editor.playback.seek({ time: timelineStart });
			cancelPreparedPlaybackStart({ editor });
			void startPlaybackWithAudioWarmup({ editor });
		},
		[activeMedia, cuts, editor],
	);

	const scheduleHeldPreview = useCallback(
		({
			pointerId,
			clientX,
			clientY,
			wordIds,
			wordStartTime,
			wordEndTime,
			gapId,
		}: {
			pointerId: number;
			clientX: number;
			clientY: number;
			wordIds: string[];
			wordStartTime: number;
			wordEndTime: number;
			gapId?: string;
		}) => {
			clearHeldWordPreviewTimer();
			holdPreviewPointerIdRef.current = pointerId;
			holdPreviewOriginRef.current = { x: clientX, y: clientY };
			if (hasExpandedSelectionWithinContainer(selectionContainerRef.current)) {
				return;
			}
			startHeldWordPreview({
				wordIds,
				wordStartTime,
				wordEndTime,
				gapId,
			});
		},
		[clearHeldWordPreviewTimer, startHeldWordPreview],
	);

	const handleHeldPreviewPointerMove = useCallback(
		({
			pointerId,
			clientX,
			clientY,
		}: {
			pointerId: number;
			clientX: number;
			clientY: number;
		}) => {
			if (holdPreviewPointerIdRef.current !== pointerId || heldWordPreview) {
				return;
			}
			const origin = holdPreviewOriginRef.current;
			if (!origin) return;
			const deltaX = clientX - origin.x;
			const deltaY = clientY - origin.y;
			if (
				deltaX * deltaX + deltaY * deltaY >=
				HOLD_TO_PREVIEW_CANCEL_DISTANCE_SQUARED_PX
			) {
				clearHeldWordPreviewTimer();
			}
		},
		[clearHeldWordPreviewTimer, heldWordPreview],
	);

	const handleHeldPreviewPointerEnd = useCallback(
		(pointerId: number) => {
			if (holdPreviewPointerIdRef.current !== pointerId) {
				return;
			}
			stopHeldWordPreview();
		},
		[stopHeldWordPreview],
	);

	const captureHeldPreviewPointer = useCallback(
		(target: HTMLElement, pointerId: number) => {
			try {
				target.setPointerCapture?.(pointerId);
			} catch {}
		},
		[],
	);

	const releaseHeldPreviewPointer = useCallback(
		(target: HTMLElement, pointerId: number) => {
			try {
				if (target.hasPointerCapture?.(pointerId)) {
					target.releasePointerCapture?.(pointerId);
				}
			} catch {}
		},
		[],
	);

	const startEditingWordIds = useCallback(
		(targetIds: string[]) => {
			if (targetIds.length === 0) return;
			const targetIdSet = new Set(targetIds);
			const orderedSelected = orderedWordIds.filter((id) =>
				targetIdSet.has(id),
			);
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
		},
		[clearGapEditingState, orderedWordIds, wordsWithCutState],
	);

	const startEditingSelectedWords = useCallback(() => {
		if (selectedWordIds.length === 0) return;
		startEditingWordIds(selectedWordIds);
	}, [selectedWordIds, startEditingWordIds]);

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

	const refreshTranscriptUi = useCallback(() => {
		setTranscriptUiRefreshVersion((current) => current + 1);
	}, []);

	const commitGapEdit = useCallback(() => {
		if (!activeMedia || !focusedGap || !editingGapId) return;
		invokeAction("transcript-update-gap-text", {
			trackId: activeMedia.trackId,
			elementId: activeMedia.element.id,
			leftWordId: focusedGap.leftWordId,
			rightWordId: focusedGap.rightWordId,
			text: editingGapText,
		});
		refreshTranscriptUi();
		clearGapEditingState();
	}, [
		activeMedia,
		focusedGap,
		editingGapId,
		editingGapText,
		clearGapEditingState,
		refreshTranscriptUi,
	]);

	const clearSpeakerEditingState = useCallback(() => {
		setEditingSpeakerGroupId(null);
		setEditingSpeakerName("");
	}, []);

	const resetTranscriptPanelUi = useCallback(() => {
		stopHeldWordPreview();
		clearEditingState();
		clearGapEditingState();
		clearSpeakerEditingState();
		setFocusedGap(null);
		setFocusedWordId(null);
		setSelectedWordIdsIfChanged([]);
		setIsSelectionActive(false);
		suppressClickSeekRef.current = false;
		window.getSelection()?.removeAllRanges();
	}, [
		clearEditingState,
		clearGapEditingState,
		clearSpeakerEditingState,
		setSelectedWordIdsIfChanged,
		stopHeldWordPreview,
	]);

	useEffect(() => {
		if (transcriptSourceKeyRef.current === activeTranscriptSourceKey) {
			return;
		}
		transcriptSourceKeyRef.current = activeTranscriptSourceKey;
		resetTranscriptPanelUi();
		setTimingAnchorWordId(null);
		setPersistedTimingWordId(null);
		setIsTimingToolbarExpanded(true);
	}, [activeTranscriptSourceKey, resetTranscriptPanelUi]);

	useEffect(() => {
		if (!editingSpeakerGroupId) return;
		editingSpeakerInputRef.current?.focus();
		editingSpeakerInputRef.current?.select();
	}, [editingSpeakerGroupId]);

	useEffect(() => {
		if (!editingWordId) return;
		editingWordInputRef.current?.focus();
		editingWordInputRef.current?.select();
	}, [editingWordId]);

	useEffect(() => {
		if (!editingGapId) return;
		editingGapInputRef.current?.focus();
		editingGapInputRef.current?.select();
	}, [editingGapId]);

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
		if (!activeMedia || !editingSpeakerGroupId) return;
		const editingGroup =
			panelGroups.find((group) => group.id === editingSpeakerGroupId) ?? null;
		const editingSpeakerId = editingGroup?.speakerId?.trim() ?? "";
		if (!editingSpeakerId) return;
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
		editingSpeakerGroupId,
		editingSpeakerName,
		panelGroups,
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
			if (sourceWindowWords.length === 0) {
				throw new Error(
					"Word-level alignment failed for this clip. Re-generate after fixing the local WhisperX alignment error to avoid inaccurate caption timing.",
				);
			}
			const wordsForEdit = buildTranscriptWordsFromTimedWords({
				mediaElementId: activeMedia.element.id,
				words: sourceWindowWords,
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
			if (sourceWindowWords.length === 0) {
				throw new Error(
					"Word-level alignment failed for this clip. Re-generate after fixing the local WhisperX alignment error to avoid inaccurate caption timing.",
				);
			}

			const wordsForEdit = buildTranscriptWordsFromTimedWords({
				mediaElementId: activeMedia.element.id,
				words: sourceWindowWords,
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
			<PanelView title="Transcript" contentClassName="space-y-2">
				<div className="text-sm text-muted-foreground p-3 border rounded-md">
					Select a clip audio/video element to edit transcript words.
				</div>
			</PanelView>
		);
	}

	if (!hasLinkedCaptions || !hasTranscriptData) {
		return (
			<PanelView title="Transcript" contentClassName="space-y-2">
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
			title="Transcript"
			contentClassName="space-y-3 pb-3"
			actions={
				<div className="flex items-center gap-2">
					{activeMediaAsset && (
						<Button
							variant="outline"
							size="icon"
							className="shrink-0"
							onClick={() => void handleRefreshTranscript()}
							disabled={isRefreshingTranscript || isGeneratingCaptions}
							aria-label={
								isRefreshingTranscript
									? "Re-generating transcript"
									: "Re-generate transcript"
							}
							title={
								isRefreshingTranscript
									? "Re-generating transcript"
									: "Re-generate transcript"
							}
						>
							{isRefreshingTranscript ? (
								<Spinner />
							) : (
								<RefreshCw className="size-4" />
							)}
						</Button>
					)}
					<Button
						variant="outline"
						size="icon"
						className="shrink-0"
						onClick={() =>
							invokeAction("transcript-restore-all", {
								trackId: activeMedia.trackId,
								elementId: activeMedia.element.id,
							})
						}
						aria-label="Restore all transcript edits"
						title="Restore all"
					>
						<RotateCcw className="size-4" />
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
										removed: !selectedWordsForEdit.every(
											(word) => word.removed,
										),
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
			{/* biome-ignore lint/a11y/noStaticElementInteractions: This is a transcript selection surface, not a standalone control. */}
			<div
				ref={selectionContainerRef}
				className={[
					"space-y-4 overflow-x-hidden pb-24 [&_*::selection]:bg-transparent [&_*::selection]:text-inherit",
					isSelectionActive ? "cursor-text" : "",
				].join(" ")}
				onContextMenu={(event) => {
					event.preventDefault();
				}}
				onMouseDownCapture={(event) => {
					const target = getEventTargetElement(event.target);
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
						target?.closest<HTMLElement>("[data-gap-id]")?.dataset.gapId ??
						null;
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
						const timelineJumpTime =
							activeMedia.element.startTime +
							mapSourceTimeToCompressedTime({
								sourceTime: start,
								cuts,
							});
						const previousSpeakerId =
							groupIndex > 0
								? panelGroups[groupIndex - 1]?.speakerId
								: undefined;
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
									<div
										className={showSpeakerHeader ? "space-y-4" : "space-y-2"}
									>
										{showSpeakerHeader && group.speakerId ? (
											<div className="flex items-center gap-2 text-xs">
												{editingSpeakerGroupId === group.id ? (
													<span className="inline-flex items-center gap-1">
														<input
															ref={editingSpeakerInputRef}
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
																	group.tone?.accent ?? "rgb(226 232 240)",
															}}
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
															color: group.tone?.accent ?? "rgb(226 232 240)",
														}}
														onClick={() => {
															setEditingSpeakerGroupId(group.id);
															setEditingSpeakerName(group.speakerLabel ?? "");
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
												const target = getEventTargetElement(event.target);
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
												if (suppressClickSeekRef.current) {
													suppressClickSeekRef.current = false;
													return;
												}
												const targetWord =
													wordsWithCutState.find(
														(candidate) => candidate.id === wordId,
													) ?? null;
												if (targetWord) {
													seekToTranscriptWord(targetWord);
												}
											}}
										>
											{group.words.map((word) => {
												if (coveredFillerWordIds.has(word.id)) {
													return null;
												}
												const fillerCandidate =
													fillerCandidateByStartWordId.get(word.id);
												const tokenWordIds = fillerCandidate?.wordIds ?? [
													word.id,
												];
												const tokenWordIdSet = new Set(tokenWordIds);
												const tokenWords = tokenWordIds
													.map(
														(tokenWordId) => wordById.get(tokenWordId) ?? null,
													)
													.filter(
														(
															candidateWord,
														): candidateWord is TranscriptEditWord =>
															candidateWord !== null,
													);
												const displayWord = tokenWords[0] ?? word;
												const displayLastWord =
													tokenWords[tokenWords.length - 1] ?? word;
												const displayText = fillerCandidate?.text ?? word.text;
												const previousWord =
													previousPanelWordById.get(word.id) ?? null;
												const followingWord =
													nextPanelWordById.get(word.id)?.rightWord ?? null;
												const previewStartTime = getWordPreviewStartTime({
													word,
													previousWord,
												});
												const previewEndTime = Math.max(
													previewStartTime + 0.01,
													getWordPreviewEndTime({
														word,
														nextWord: followingWord,
													}),
												);
												const isCurrentWord = tokenWordIds.some(
													(tokenWordId) => activeWordId === tokenWordId,
												);
												const isCurrentHiddenWord = tokenWordIds.some(
													(tokenWordId) => activeHiddenWordId === tokenWordId,
												);
												const isSelectedWord = tokenWordIds.some(
													(tokenWordId) => selectedWordIdsSet.has(tokenWordId),
												);
												const isCaptionLinkedWord = tokenWordIds.some(
													(tokenWordId) =>
														selectedCaptionWordIds.has(tokenWordId),
												);
												const isFocusedWord =
													focusedWordId != null &&
													tokenWordIdSet.has(focusedWordId);
												const gap = nextPanelWordById.get(displayLastWord.id);
												const nextWord = gap?.rightWord;
												const gapId = gap?.id ?? null;
												const isFocusedGap = focusedGap?.id === gapId;
												const gapEdit = nextWord
													? getTranscriptGapEdit({
															gapEdits,
															leftWordId: displayLastWord.id,
															rightWordId: nextWord.id,
														})
													: undefined;
												const gapDurationSeconds =
													gap?.compressedDurationSeconds ?? 0;
												const gapWidthClass =
													getTranscriptGapWidthClass(gapDurationSeconds);
												const gapIsSelected = Boolean(gap) && isFocusedGap;
												const gapIsCurrent = gap
													? currentGapId === gap.id
													: false;
												const isHoverSelectedGroupWord =
													isFocusedWord &&
													selectedWordIds.length > 1 &&
													tokenWordIds.some((tokenWordId) =>
														selectedWordIdsSet.has(tokenWordId),
													);
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
															textDecorationColor: tone?.accent ?? "#ef4444",
														}
													: undefined;
												const gapBaseAlpha =
													gapIsSelected || gapIsCurrent ? 0.34 : 0.16;
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
													displayText.length,
													editingWordText.length,
													3,
												);
												return (
													<span key={word.id} className="contents">
														<span
															className="relative group/word mr-1 inline-block my-1 align-baseline"
															data-word-id={displayWord.id}
															data-word-ids={tokenWordIds.join(",")}
														>
															{isFocusedWord &&
																!isPlaying &&
																selectedWordIds.length === 0 && (
																	<span className="absolute left-0 bottom-full z-10 mb-1 flex items-center gap-1">
																		<Button
																			variant="ghost"
																			size="sm"
																			className="h-6 rounded-md border border-zinc-700 bg-zinc-900/95 px-1.5 text-[11px] text-zinc-100 shadow-sm hover:bg-zinc-800"
																			onClick={() =>
																				startEditingWordIds(tokenWordIds)
																			}
																		>
																			<Pencil className="mr-1 size-3" />
																			Edit
																		</Button>
																		<Button
																			variant="ghost"
																			size="sm"
																			className="h-6 rounded-md border border-zinc-700 bg-zinc-900/95 px-1.5 text-[11px] text-zinc-100 shadow-sm hover:bg-zinc-800"
																			onClick={() => {
																				if (tokenWordIds.length === 1) {
																					invokeAction(
																						"transcript-toggle-word",
																						{
																							trackId: activeMedia.trackId,
																							elementId: activeMedia.element.id,
																							wordId: displayWord.id,
																						},
																					);
																					return;
																				}
																				invokeAction(
																					"transcript-set-words-removed",
																					{
																						trackId: activeMedia.trackId,
																						elementId: activeMedia.element.id,
																						wordIds: tokenWordIds,
																						removed: !tokenWords.every(
																							(tokenWord) => tokenWord.removed,
																						),
																					},
																				);
																			}}
																		>
																			{tokenWords.every(
																				(tokenWord) => tokenWord.removed,
																			)
																				? "Restore"
																				: "Mute"}
																		</Button>
																	</span>
																)}
															{/* biome-ignore lint/a11y/noStaticElementInteractions: Transcript tokens need custom pointer handling for selection, preview, and editing. */}
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
																	tokenWords.every(
																		(tokenWord) => tokenWord.removed,
																	)
																		? "line-through decoration-red-600 decoration-2 opacity-75"
																		: "",
																	tokenWords.every(
																		(tokenWord) => tokenWord.hidden,
																	)
																		? "opacity-55"
																		: "",
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
																	if (
																		editingWordId ||
																		isCurrentWord ||
																		isSelectedWord
																	) {
																		return;
																	}
																	event.currentTarget.style.backgroundColor =
																		"";
																}}
																onDoubleClick={(event) => {
																	event.preventDefault();
																	event.stopPropagation();
																	stopHeldWordPreview();
																	window.getSelection()?.removeAllRanges();
																	startEditingWordIds(tokenWordIds);
																}}
																onPointerDown={(event) => {
																	if (editingWordId || event.button !== 0)
																		return;
																	suppressClickSeekRef.current = false;
																	captureHeldPreviewPointer(
																		event.currentTarget,
																		event.pointerId,
																	);
																	scheduleHeldPreview({
																		pointerId: event.pointerId,
																		clientX: event.clientX,
																		clientY: event.clientY,
																		wordIds: [word.id],
																		wordStartTime: previewStartTime,
																		wordEndTime: previewEndTime,
																	});
																}}
																onPointerMove={(event) => {
																	handleHeldPreviewPointerMove({
																		pointerId: event.pointerId,
																		clientX: event.clientX,
																		clientY: event.clientY,
																	});
																}}
																onPointerUp={(event) => {
																	releaseHeldPreviewPointer(
																		event.currentTarget,
																		event.pointerId,
																	);
																	handleHeldPreviewPointerEnd(event.pointerId);
																}}
																onPointerCancel={(event) => {
																	releaseHeldPreviewPointer(
																		event.currentTarget,
																		event.pointerId,
																	);
																	handleHeldPreviewPointerEnd(event.pointerId);
																}}
																onContextMenu={(event) => {
																	event.preventDefault();
																	event.stopPropagation();
																	stopHeldWordPreview();
																	setFocusedWordId(displayWord.id);
																	if (tokenWordIds.length === 1) {
																		invokeAction("transcript-toggle-word", {
																			trackId: activeMedia.trackId,
																			elementId: activeMedia.element.id,
																			wordId: displayWord.id,
																		});
																		return;
																	}
																	invokeAction("transcript-set-words-removed", {
																		trackId: activeMedia.trackId,
																		elementId: activeMedia.element.id,
																		wordIds: tokenWordIds,
																		removed: !tokenWords.every(
																			(tokenWord) => tokenWord.removed,
																		),
																	});
																}}
															>
																{heldWordPreview &&
																tokenWordIds.some((tokenWordId) =>
																	heldWordPreviewIds.has(tokenWordId),
																) ? (
																	<span
																		aria-hidden="true"
																		className="pointer-events-none absolute inset-y-0 left-0 rounded-sm bg-white/25"
																		style={{
																			width: `${Math.max(
																				0,
																				Math.min(
																					100,
																					((previewCurrentTime -
																						heldWordPreview.startTime) /
																						Math.max(
																							0.01,
																							heldWordPreview.endTime -
																								heldWordPreview.startTime,
																						)) *
																						100,
																				),
																			)}%`,
																		}}
																	/>
																) : null}
																<span className="relative z-10">
																	{displayText}
																</span>
															</span>
															{editingWordId === displayWord.id && (
																<span className="absolute left-0 top-1/2 z-20 inline-flex -translate-y-1/2 items-center rounded-sm border border-zinc-500 bg-zinc-800 px-2 pr-1 align-middle shadow-sm">
																	<input
																		ref={editingWordInputRef}
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
																role="option"
																tabIndex={0}
																aria-selected={focusedGap?.id === gapId}
																aria-label={`Select gap between ${displayText} and ${nextWord.text}`}
																data-gap-id={gapId ?? undefined}
																title={`${gapDurationSeconds.toFixed(2)}s playback gap${gap ? ` (${gap.sourceDurationSeconds.toFixed(2)}s source)` : ""}`}
																className={[
																	"relative mx-1 inline-flex h-[1.05em] min-w-2.5 max-w-6 cursor-pointer items-center justify-center align-middle px-0.5 text-[11px] leading-none transition-none",
																	gapWidthClass,
																	!editingWordId
																		? "opacity-80 hover:opacity-100"
																		: "",
																].join(" ")}
																style={gapStyle}
																onMouseEnter={(event) => {
																	if (!tone) return;
																	event.currentTarget.style.backgroundColor =
																		hexToRgba(tone.accent, 0.24);
																}}
																onMouseLeave={(event) => {
																	event.currentTarget.style.backgroundColor =
																		String(gapStyle.backgroundColor);
																}}
																onClick={(event) => {
																	event.stopPropagation();
																	if (suppressClickSeekRef.current) {
																		suppressClickSeekRef.current = false;
																		return;
																	}
																	focusWordGap(displayLastWord.id, nextWord.id);
																}}
																onPointerDown={(event) => {
																	if (editingWordId || event.button !== 0)
																		return;
																	captureHeldPreviewPointer(
																		event.currentTarget,
																		event.pointerId,
																	);
																	scheduleHeldPreview({
																		pointerId: event.pointerId,
																		clientX: event.clientX,
																		clientY: event.clientY,
																		wordIds: [],
																		wordStartTime: displayLastWord.endTime,
																		wordEndTime: nextWord.startTime,
																		gapId: gapId ?? undefined,
																	});
																}}
																onPointerMove={(event) => {
																	handleHeldPreviewPointerMove({
																		pointerId: event.pointerId,
																		clientX: event.clientX,
																		clientY: event.clientY,
																	});
																}}
																onPointerUp={(event) => {
																	releaseHeldPreviewPointer(
																		event.currentTarget,
																		event.pointerId,
																	);
																	handleHeldPreviewPointerEnd(event.pointerId);
																}}
																onPointerCancel={(event) => {
																	releaseHeldPreviewPointer(
																		event.currentTarget,
																		event.pointerId,
																	);
																	handleHeldPreviewPointerEnd(event.pointerId);
																}}
																onDoubleClick={(event) => {
																	event.preventDefault();
																	event.stopPropagation();
																	stopHeldWordPreview();
																	startEditingGap(
																		displayLastWord.id,
																		nextWord.id,
																	);
																}}
																onContextMenu={(event) => {
																	event.preventDefault();
																	event.stopPropagation();
																	stopHeldWordPreview();
																	focusWordGap(displayLastWord.id, nextWord.id);
																	invokeAction(
																		"transcript-toggle-gap-removed",
																		{
																			trackId: activeMedia.trackId,
																			elementId: activeMedia.element.id,
																			leftWordId: displayLastWord.id,
																			rightWordId: nextWord.id,
																			removed: !gapEdit?.removed,
																		},
																	);
																	refreshTranscriptUi();
																}}
																onKeyDown={(event) => {
																	if (
																		event.key === "Enter" ||
																		event.key === " "
																	) {
																		event.preventDefault();
																		focusWordGap(word.id, nextWord.id);
																	}
																}}
															>
																{heldWordPreview?.gapId === gapId ? (
																	<span
																		aria-hidden="true"
																		className="pointer-events-none absolute inset-y-0 left-0 z-0"
																		style={{
																			backgroundColor: hexToRgba(
																				tone?.accent ?? "#ffffff",
																				0.32,
																			),
																			width: `${Math.max(
																				0,
																				Math.min(
																					100,
																					((currentTime -
																						heldWordPreview.startTime) /
																						Math.max(
																							0.01,
																							heldWordPreview.endTime -
																								heldWordPreview.startTime,
																						)) *
																						100,
																				),
																			)}%`,
																		}}
																	/>
																) : null}
																{gapEdit?.removed ? (
																	<span
																		aria-hidden="true"
																		className="pointer-events-none absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 border-t-2"
																		style={{
																			borderTopColor: tone?.accent ?? "#ef4444",
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
																{isFocusedGap &&
																	selectedWordIds.length === 0 && (
																		<span className="absolute left-1/2 bottom-full z-10 mb-1 flex -translate-x-1/2 items-center gap-1">
																			{editingGapId === gapId ? (
																				<span className="inline-flex items-center gap-1 rounded-sm border border-zinc-700 bg-zinc-900/95 px-1.5 py-1 shadow-sm">
																					<input
																						ref={editingGapInputRef}
																						value={editingGapText}
																						onChange={(event) =>
																							setEditingGapText(
																								event.target.value,
																							)
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
																							startEditingGap(
																								displayLastWord.id,
																								nextWord.id,
																							)
																						}
																					>
																						<Pencil className="mr-1 size-3" />
																						Edit
																					</Button>
																					<Button
																						variant="ghost"
																						size="sm"
																						className="h-6 rounded-md border border-zinc-700 bg-zinc-900/95 px-1.5 text-[11px] text-zinc-100 shadow-sm hover:bg-zinc-800"
																						onClick={() => {
																							invokeAction(
																								"transcript-toggle-gap-removed",
																								{
																									trackId: activeMedia.trackId,
																									elementId:
																										activeMedia.element.id,
																									leftWordId: word.id,
																									rightWordId: nextWord.id,
																									removed: !gapEdit?.removed,
																								},
																							);
																							refreshTranscriptUi();
																						}}
																					>
																						{gapEdit?.removed
																							? "Restore"
																							: "Mute"}
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
			{shouldRenderTimingToolbar ? (
				<div className="sticky bottom-0 z-30 -mx-2 bg-background px-3 py-2 shadow-[0_-10px_18px_rgba(0,0,0,0.28)]">
					<div className="flex items-center justify-between">
						<button
							type="button"
							className="inline-flex items-center gap-1.5 text-xs text-zinc-300 transition-colors hover:text-zinc-100"
							onClick={() => setIsTimingToolbarExpanded((current) => !current)}
						>
							<span>Timing</span>
							{isTimingViewVisible ? (
								<ChevronDown className="size-3.5" />
							) : (
								<ChevronUp className="size-3.5" />
							)}
						</button>
					</div>
					{isTimingViewVisible ? (
						<div className="pt-1">
							{timingToolbarWordId ? (
								<TranscriptTimingView
									key={activeTranscriptSourceKey}
									trackId={activeMedia.trackId}
									elementId={activeMedia.element.id}
									words={timingToolbarWords}
									cuts={cuts}
									originalWords={originalTimingWords}
									focusedWordId={timingToolbarWordId}
									currentWordId={currentWordId}
									currentSourceTime={currentSourceTime}
									isPlaying={isPlaying}
									speakerToneById={speakerToneById}
									heldWordPreview={heldWordPreview}
									heldWordPreviewIds={heldWordPreviewIds}
									previewCurrentTime={previewCurrentTime}
									waveformAudioBuffer={activeWaveformSource?.audioBuffer}
									waveformAudioFile={activeWaveformSource?.audioFile}
									waveformAudioUrl={activeWaveformSource?.audioUrl}
									waveformCacheKey={activeWaveformSource?.cacheKey}
									initialWaveformEnvelope={activeWaveformEnvelope}
									onWaveformEnvelopeResolved={persistActiveWaveformEnvelope}
									onSeekWord={(word) => {
										setFocusedWordId(word.id);
										if (suppressClickSeekRef.current) {
											suppressClickSeekRef.current = false;
											return;
										}
										seekToTranscriptWord(word);
									}}
									onScheduleWordPreview={scheduleHeldPreview}
									onHeldPreviewPointerMove={handleHeldPreviewPointerMove}
									onHeldPreviewPointerEnd={handleHeldPreviewPointerEnd}
									onCaptureHeldPreviewPointer={captureHeldPreviewPointer}
									onReleaseHeldPreviewPointer={releaseHeldPreviewPointer}
									onClearInteractionState={() => {
										stopHeldWordPreview();
										clearGapEditingState();
										clearEditingState();
										setFocusedGap(null);
										setSelectedWordIdsIfChanged([]);
										setIsSelectionActive(false);
										window.getSelection()?.removeAllRanges();
									}}
								/>
							) : (
								<div className="text-muted-foreground px-1 py-2 text-xs">
									No transcript timing target available.
								</div>
							)}
						</div>
					) : null}
				</div>
			) : null}

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
