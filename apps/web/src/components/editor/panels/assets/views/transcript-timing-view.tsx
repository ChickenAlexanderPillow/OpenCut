"use client";

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { invokeAction } from "@/lib/actions";
import { MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS } from "@/lib/transcript-editor/constants";
import {
	buildTranscriptGapId,
	detectTranscriptFillerCandidates,
	mapSourceTimeToCompressedTime,
} from "@/lib/transcript-editor/core";
import { clampTranscriptWordBoundaryTime } from "@/lib/transcript-editor/timing";
import type { TWaveformPeaksCacheEntry } from "@/types/project";
import {
	getWaveformMinMaxInRange,
	resolveWaveformEnvelopeSource,
	type WaveformEnvelope,
} from "@/lib/media/waveform-envelope";
import type {
	TranscriptEditCutRange,
	TranscriptEditWord,
} from "@/types/transcription";

type SpeakerTone = {
	accent: string;
	background: string;
	border: string;
	wordText: string;
	mutedText: string;
};

type HeldWordPreview = {
	wordIds: string[];
	startTime: number;
	endTime: number;
	gapId?: string;
};

type TranscriptTimingViewProps = {
	trackId: string;
	elementId: string;
	words: TranscriptEditWord[];
	cuts: TranscriptEditCutRange[];
	originalWords: TranscriptEditWord[];
	focusedWordId: string | null;
	currentWordId: string | null;
	currentSourceTime: number | null;
	isPlaying: boolean;
	speakerToneById: Map<string, SpeakerTone>;
	heldWordPreview: HeldWordPreview | null;
	heldWordPreviewIds: Set<string>;
	previewCurrentTime: number;
	onSeekWord: (word: TranscriptEditWord) => void;
	onScheduleWordPreview: (args: {
		pointerId: number;
		clientX: number;
		clientY: number;
		wordIds: string[];
		wordStartTime: number;
		wordEndTime: number;
		gapId?: string;
	}) => void;
	onHeldPreviewPointerMove: (args: {
		pointerId: number;
		clientX: number;
		clientY: number;
	}) => void;
	onHeldPreviewPointerEnd: (pointerId: number) => void;
	onCaptureHeldPreviewPointer: (target: HTMLElement, pointerId: number) => void;
	onReleaseHeldPreviewPointer: (target: HTMLElement, pointerId: number) => void;
	onClearInteractionState: () => void;
	waveformAudioBuffer?: AudioBuffer;
	waveformAudioFile?: File;
	waveformAudioUrl?: string;
	waveformCacheKey?: string;
	initialWaveformEnvelope?: TWaveformPeaksCacheEntry;
	onWaveformEnvelopeResolved?: (envelope: WaveformEnvelope) => void;
};

type TimingToken = {
	kind: "word";
	id: string;
	text: string;
	wordIds: string[];
	firstWord: TranscriptEditWord;
	lastWord: TranscriptEditWord;
	speakerId?: string;
	startTime: number;
	endTime: number;
};

type TimingGap = {
	kind: "gap";
	id: string;
	text: string;
	wordIds: string[];
	leftWordId: string;
	rightWordId: string;
	startTime: number;
	endTime: number;
	speakerId?: string;
};

type TimingItem = TimingToken | TimingGap;

type LocalWord = {
	word: TimingItem;
	displayStartTime: number;
	displayEndTime: number;
};

export type TranscriptWaveformBar = {
	min: number;
	max: number;
};

const HANDLE_HITBOX_PX = 20;
const TRACK_HORIZONTAL_INSET_PX = 14;
const ORIGINAL_BOUNDARY_SNAP_THRESHOLD_SECONDS = 0.012;
const TRACK_EDGE_PADDING_PERCENT = 4;
const TIMING_VIEW_WINDOW_SECONDS = 1.2;

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

function getCompressedTime(
	time: number,
	cuts: TranscriptEditCutRange[],
): number {
	return mapSourceTimeToCompressedTime({
		sourceTime: time,
		cuts,
	});
}

function mapLocalDisplayTimeToSourceTime({
	displayTime,
	localWords,
}: {
	displayTime: number;
	localWords: LocalWord[];
}): number {
	const firstWord = localWords[0]?.word ?? null;
	const lastWord = localWords[localWords.length - 1]?.word ?? null;
	if (!firstWord || !lastWord) return 0;

	for (const item of localWords) {
		if (displayTime > item.displayEndTime) continue;
		const displayDuration = Math.max(
			0.0001,
			item.displayEndTime - item.displayStartTime,
		);
		const sourceDuration = Math.max(
			0.0001,
			item.word.endTime - item.word.startTime,
		);
		const ratio = Math.max(
			0,
			Math.min(1, (displayTime - item.displayStartTime) / displayDuration),
		);
		return item.word.startTime + ratio * sourceDuration;
	}

	return lastWord.endTime;
}

function mapSourceTimeToLocalDisplayTime({
	sourceTime,
	localWords,
}: {
	sourceTime: number;
	localWords: LocalWord[];
}): number | null {
	const firstWord = localWords[0] ?? null;
	const lastWord = localWords[localWords.length - 1] ?? null;
	if (!firstWord || !lastWord) return null;

	for (const item of localWords) {
		if (sourceTime > item.word.endTime) continue;
		if (sourceTime < item.word.startTime) {
			return item.displayStartTime;
		}
		const sourceDuration = Math.max(
			0.0001,
			item.word.endTime - item.word.startTime,
		);
		const displayDuration = Math.max(
			0.0001,
			item.displayEndTime - item.displayStartTime,
		);
		const ratio = Math.max(
			0,
			Math.min(1, (sourceTime - item.word.startTime) / sourceDuration),
		);
		return item.displayStartTime + ratio * displayDuration;
	}

	return lastWord.displayEndTime;
}

export function buildTranscriptWaveformBars({
	envelope,
	localWords,
	localWindow,
	barCount,
}: {
	envelope: WaveformEnvelope;
	localWords: LocalWord[];
	localWindow: { startTime: number; duration: number };
	barCount: number;
}): TranscriptWaveformBar[] {
	if (
		barCount <= 0 ||
		envelope.peaks.length === 0 ||
		localWords.length === 0 ||
		localWindow.duration <= 0
	) {
		return [];
	}

	return Array.from({ length: barCount }, (_, index) => {
		const displayStartTime =
			localWindow.startTime + (index / barCount) * localWindow.duration;
		const displayEndTime =
			localWindow.startTime + ((index + 1) / barCount) * localWindow.duration;
		const sourceStartTime = mapLocalDisplayTimeToSourceTime({
			displayTime: displayStartTime,
			localWords,
		});
		const sourceEndTime = mapLocalDisplayTimeToSourceTime({
			displayTime: displayEndTime,
			localWords,
		});
		const { min, max } = getWaveformMinMaxInRange({
			envelope,
			startTime: Math.min(sourceStartTime, sourceEndTime),
			endTime: Math.max(sourceStartTime, sourceEndTime),
		});
		return { min, max };
	});
}

function getBoundaryHandleStyle(accent?: string) {
	return {
		lineColor: accent ?? "#f4f4f5",
		gripBorder: accent ?? "#f4f4f5",
		gripShadow: "rgba(0,0,0,0.7)",
	};
}

function buildTimingTokens(words: TranscriptEditWord[]): TimingToken[] {
	const candidates = detectTranscriptFillerCandidates({ words });
	const fillerCandidateByStartWordId = new Map(
		candidates
			.map((candidate) => {
				const firstWordId = candidate.wordIds[0];
				return firstWordId
					? [
							firstWordId,
							{
								id: candidate.id,
								text: `[${candidate.text}]`,
								wordIds: candidate.wordIds,
							},
						]
					: null;
			})
			.filter(
				(
					entry,
				): entry is [string, { id: string; text: string; wordIds: string[] }] =>
					entry !== null,
			),
	);
	const coveredFillerWordIds = new Set<string>();
	for (const candidate of candidates) {
		for (const wordId of candidate.wordIds.slice(1)) {
			coveredFillerWordIds.add(wordId);
		}
	}

	const wordById = new Map(words.map((word) => [word.id, word]));
	const tokens: TimingToken[] = [];
	for (const word of words) {
		if (coveredFillerWordIds.has(word.id)) continue;
		const fillerCandidate = fillerCandidateByStartWordId.get(word.id);
		if (fillerCandidate) {
			const tokenWords = fillerCandidate.wordIds
				.map((wordId) => wordById.get(wordId) ?? null)
				.filter(
					(candidateWord): candidateWord is TranscriptEditWord =>
						candidateWord !== null,
				);
			const firstWord = tokenWords[0];
			const lastWord = tokenWords[tokenWords.length - 1];
			if (firstWord && lastWord) {
				tokens.push({
					kind: "word",
					id: fillerCandidate.id,
					text: fillerCandidate.text,
					wordIds: fillerCandidate.wordIds,
					firstWord,
					lastWord,
					speakerId: firstWord.speakerId,
					startTime: firstWord.startTime,
					endTime: lastWord.endTime,
				});
				continue;
			}
		}
		tokens.push({
			kind: "word",
			id: word.id,
			text: word.text,
			wordIds: [word.id],
			firstWord: word,
			lastWord: word,
			speakerId: word.speakerId,
			startTime: word.startTime,
			endTime: word.endTime,
		});
	}
	return tokens;
}

function buildTimingItems({
	tokens,
	cuts,
}: {
	tokens: TimingToken[];
	cuts: TranscriptEditCutRange[];
}): TimingItem[] {
	const items: TimingItem[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const current = tokens[index];
		if (!current) continue;
		items.push(current);
		const next = tokens[index + 1];
		if (!next) continue;
		const compressedGapSeconds = Math.max(
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
		if (compressedGapSeconds < MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS) continue;
		items.push({
			kind: "gap",
			id: buildTranscriptGapId(current.lastWord.id, next.firstWord.id),
			text: "pause",
			wordIds: [],
			leftWordId: current.lastWord.id,
			rightWordId: next.firstWord.id,
			startTime: current.endTime,
			endTime: next.startTime,
			speakerId: current.speakerId ?? next.speakerId,
		});
	}
	return items;
}

function buildDisplayLayout(
	items: TimingItem[],
	cuts: TranscriptEditCutRange[],
) {
	let cursor = 0;
	return items.map((word) => {
		const duration = Math.max(
			0.01,
			getCompressedTime(word.endTime, cuts) -
				getCompressedTime(word.startTime, cuts),
		);
		const displayWord = {
			word,
			displayStartTime: cursor,
			displayEndTime: cursor + duration,
		};
		cursor += duration;
		return displayWord;
	});
}

export function TranscriptTimingView({
	trackId,
	elementId,
	words,
	cuts,
	originalWords,
	focusedWordId,
	currentWordId,
	currentSourceTime,
	isPlaying,
	speakerToneById,
	heldWordPreview,
	heldWordPreviewIds,
	previewCurrentTime,
	onSeekWord,
	onScheduleWordPreview,
	onHeldPreviewPointerMove,
	onHeldPreviewPointerEnd,
	onCaptureHeldPreviewPointer,
	onReleaseHeldPreviewPointer,
	onClearInteractionState,
	waveformAudioBuffer,
	waveformAudioFile,
	waveformAudioUrl,
	waveformCacheKey,
	initialWaveformEnvelope,
	onWaveformEnvelopeResolved,
}: TranscriptTimingViewProps) {
	const stripRef = useRef<HTMLDivElement | null>(null);
	const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const [dragState, setDragState] = useState<{
		pointerId: number;
		side: "left" | "right";
		sourceTime: number;
	} | null>(null);
	const tokens = useMemo(() => buildTimingTokens(words), [words]);
	const originalTokens = useMemo(
		() => buildTimingTokens(originalWords),
		[originalWords],
	);
	const wordStateById = useMemo(
		() => new Map(words.map((word) => [word.id, word])),
		[words],
	);

	const focusedIndex = focusedWordId
		? tokens.findIndex((token) => token.wordIds.includes(focusedWordId))
		: -1;
	const focusedWord = focusedIndex >= 0 ? (tokens[focusedIndex] ?? null) : null;
	const previousWord =
		focusedIndex > 0 ? (tokens[focusedIndex - 1] ?? null) : null;
	const nextWord =
		focusedIndex >= 0 && focusedIndex < tokens.length - 1
			? (tokens[focusedIndex + 1] ?? null)
			: null;
	const originalFocusedWord =
		focusedIndex >= 0 ? (originalTokens[focusedIndex] ?? null) : null;
	const originalPreviousWord =
		focusedIndex > 0 ? (originalTokens[focusedIndex - 1] ?? null) : null;
	const originalNextWord =
		focusedIndex >= 0 && focusedIndex < originalTokens.length - 1
			? (originalTokens[focusedIndex + 1] ?? null)
			: null;

	const previewFocusedWord = useMemo(() => {
		if (!focusedWord) return null;
		if (!dragState) return focusedWord;
		if (dragState.side === "left" && previousWord) {
			return {
				...focusedWord,
				startTime: clampTranscriptWordBoundaryTime({
					leftWord: previousWord.lastWord,
					rightWord: focusedWord.firstWord,
					time: dragState.sourceTime,
				}),
			};
		}
		if (dragState.side === "right" && nextWord) {
			return {
				...focusedWord,
				endTime: clampTranscriptWordBoundaryTime({
					leftWord: focusedWord.lastWord,
					rightWord: nextWord.firstWord,
					time: dragState.sourceTime,
				}),
			};
		}
		return focusedWord;
	}, [dragState, focusedWord, nextWord, previousWord]);

	const previewPreviousWord = useMemo(() => {
		if (!previousWord) return null;
		if (!dragState || dragState.side !== "left" || !focusedWord)
			return previousWord;
		return {
			...previousWord,
			endTime: clampTranscriptWordBoundaryTime({
				leftWord: previousWord.lastWord,
				rightWord: focusedWord.firstWord,
				time: dragState.sourceTime,
			}),
		};
	}, [dragState, focusedWord, previousWord]);

	const previewNextWord = useMemo(() => {
		if (!nextWord) return null;
		if (!dragState || dragState.side !== "right" || !focusedWord)
			return nextWord;
		return {
			...nextWord,
			startTime: clampTranscriptWordBoundaryTime({
				leftWord: focusedWord.lastWord,
				rightWord: nextWord.firstWord,
				time: dragState.sourceTime,
			}),
		};
	}, [dragState, focusedWord, nextWord]);
	const previewTokens = useMemo(
		() =>
			tokens.map((token) => {
				if (previewPreviousWord && token.id === previewPreviousWord.id) {
					return previewPreviousWord;
				}
				if (previewFocusedWord && token.id === previewFocusedWord.id) {
					return previewFocusedWord;
				}
				if (previewNextWord && token.id === previewNextWord.id) {
					return previewNextWord;
				}
				return token;
			}),
		[previewFocusedWord, previewNextWord, previewPreviousWord, tokens],
	);
	const baseItems = useMemo(
		() => buildTimingItems({ tokens, cuts }),
		[cuts, tokens],
	);
	const previewItems = useMemo(
		() => buildTimingItems({ tokens: previewTokens, cuts }),
		[cuts, previewTokens],
	);
	const baseLocalWords = useMemo(
		() => buildDisplayLayout(baseItems, cuts),
		[baseItems, cuts],
	);
	const localWords = useMemo(
		() => buildDisplayLayout(previewItems, cuts),
		[cuts, previewItems],
	);
	const focusedLayoutItem = useMemo(
		() =>
			localWords.find(
				(item) =>
					item.word.kind === "word" && item.word.id === previewFocusedWord?.id,
			) ?? null,
		[localWords, previewFocusedWord?.id],
	);
	const currentDisplayTime = useMemo(
		() =>
			currentSourceTime != null
				? mapSourceTimeToLocalDisplayTime({
						sourceTime: currentSourceTime,
						localWords,
					})
				: null,
		[currentSourceTime, localWords],
	);
	const focusedAnchorTime = focusedLayoutItem?.displayStartTime ?? null;

	const localWindow = useMemo(() => {
		if (localWords.length === 0) return null;
		const trackStart = localWords[0]?.displayStartTime ?? 0;
		const trackEnd =
			localWords[localWords.length - 1]?.displayEndTime ?? trackStart;
		const totalDuration = Math.max(0.01, trackEnd - trackStart);
		const duration = Math.min(TIMING_VIEW_WINDOW_SECONDS, totalDuration);
		const centerTime =
			currentDisplayTime != null
				? currentDisplayTime
				: (focusedAnchorTime ?? trackStart);
		const unclampedStart = centerTime - duration / 2;
		const maxStart = Math.max(trackStart, trackEnd - duration);
		const startTime = Math.max(trackStart, Math.min(maxStart, unclampedStart));
		const endTime = startTime + duration;
		return {
			startTime,
			endTime,
			duration: Math.max(0.01, duration),
		};
	}, [currentDisplayTime, focusedAnchorTime, localWords]);
	const visibleWords = useMemo(() => {
		if (!localWindow) return [];
		return localWords.filter(
			(item) =>
				item.displayEndTime >= localWindow.startTime &&
				item.displayStartTime <= localWindow.endTime,
		);
	}, [localWindow, localWords]);

	const leftBoundaryDisplayTime =
		previewPreviousWord && previewFocusedWord
			? (localWords.find((item) => item.word.id === previewPreviousWord.id)
					?.displayEndTime ?? null)
			: null;
	const rightBoundaryDisplayTime =
		previewFocusedWord && previewNextWord
			? (localWords.find((item) => item.word.id === previewFocusedWord.id)
					?.displayEndTime ?? null)
			: null;

	const getPercent = useCallback(
		(time: number) => {
			if (!localWindow) return 0;
			const rawPercent =
				((time - localWindow.startTime) / localWindow.duration) * 100;
			return (
				TRACK_EDGE_PADDING_PERCENT +
				rawPercent * ((100 - TRACK_EDGE_PADDING_PERCENT * 2) / 100)
			);
		},
		[localWindow],
	);

	const beginBoundaryDrag = useCallback(
		(
			event: ReactPointerEvent<HTMLButtonElement>,
			side: "left" | "right",
			sourceTime: number,
		) => {
			event.preventDefault();
			event.stopPropagation();
			onClearInteractionState();
			try {
				event.currentTarget.setPointerCapture(event.pointerId);
			} catch {}
			setDragState({
				pointerId: event.pointerId,
				side,
				sourceTime,
			});
		},
		[onClearInteractionState],
	);

	const updateBoundaryDrag = useCallback(
		(pointerId: number, clientX: number) => {
			const strip = stripRef.current;
			if (!strip || !localWindow) return;
			setDragState((current) => {
				if (!current || current.pointerId !== pointerId) return current;
				const rect = strip.getBoundingClientRect();
				const relativeX = Math.max(
					0,
					Math.min(rect.width, clientX - rect.left),
				);
				const ratio = rect.width <= 0 ? 0 : relativeX / rect.width;
				const edgeRatio = TRACK_EDGE_PADDING_PERCENT / 100;
				const normalizedRatio =
					1 - edgeRatio * 2 <= 0
						? ratio
						: Math.max(
								0,
								Math.min(1, (ratio - edgeRatio) / (1 - edgeRatio * 2)),
							);
				const displayTime =
					localWindow.startTime + normalizedRatio * localWindow.duration;
				let sourceTime = mapLocalDisplayTimeToSourceTime({
					displayTime,
					localWords,
				});
				const originalBoundaryTime =
					current.side === "left"
						? (originalFocusedWord?.startTime ?? null)
						: (originalFocusedWord?.endTime ?? null);
				if (
					originalBoundaryTime != null &&
					Math.abs(sourceTime - originalBoundaryTime) <=
						ORIGINAL_BOUNDARY_SNAP_THRESHOLD_SECONDS
				) {
					sourceTime = originalBoundaryTime;
				}
				return {
					...current,
					sourceTime,
				};
			});
		},
		[localWindow, localWords, originalFocusedWord],
	);

	const commitBoundaryDrag = useCallback(
		(pointerId: number) => {
			const current = dragState;
			if (!current || current.pointerId !== pointerId || !focusedWord) {
				return;
			}
			setDragState(null);
			if (current.side === "left" && previousWord) {
				invokeAction("transcript-update-word-boundary", {
					trackId,
					elementId,
					leftWordId: previousWord.lastWord.id,
					rightWordId: focusedWord.firstWord.id,
					time: current.sourceTime,
				});
			}
			if (current.side === "right" && nextWord) {
				invokeAction("transcript-update-word-boundary", {
					trackId,
					elementId,
					leftWordId: focusedWord.lastWord.id,
					rightWordId: nextWord.firstWord.id,
					time: current.sourceTime,
				});
			}
		},
		[dragState, elementId, focusedWord, nextWord, previousWord, trackId],
	);
	const resetFocusedTiming = () => {
		if (!focusedWord || !originalFocusedWord) return;
		if (hasResettableLeftBoundary && previousWord) {
			invokeAction("transcript-update-word-boundary", {
				trackId,
				elementId,
				leftWordId: previousWord.lastWord.id,
				rightWordId: focusedWord.firstWord.id,
				time: originalFocusedWord.startTime,
			});
		}
		if (hasResettableRightBoundary && nextWord) {
			invokeAction("transcript-update-word-boundary", {
				trackId,
				elementId,
				leftWordId: focusedWord.lastWord.id,
				rightWordId: nextWord.firstWord.id,
				time: originalFocusedWord.endTime,
			});
		}
	};

	const [waveformEnvelope, setWaveformEnvelope] =
		useState<WaveformEnvelope | null>(initialWaveformEnvelope ?? null);

	useEffect(() => {
		let mounted = true;

		void resolveWaveformEnvelopeSource({
			audioBuffer: waveformAudioBuffer,
			audioFile: waveformAudioFile,
			audioUrl: waveformAudioUrl,
			cacheKey: waveformCacheKey,
			initialEnvelope: initialWaveformEnvelope,
		}).then((resolvedEnvelope) => {
			if (!mounted) return;
			setWaveformEnvelope(resolvedEnvelope);
			if (resolvedEnvelope) {
				onWaveformEnvelopeResolved?.(resolvedEnvelope);
			}
		});

		return () => {
			mounted = false;
		};
	}, [
		initialWaveformEnvelope,
		waveformAudioBuffer,
		waveformAudioFile,
		waveformAudioUrl,
		waveformCacheKey,
		onWaveformEnvelopeResolved,
	]);

	const waveformBars = useMemo(() => {
		if (!waveformEnvelope || !localWindow) return [];
		return buildTranscriptWaveformBars({
			envelope: waveformEnvelope,
			localWords,
			localWindow,
			barCount: 160,
		});
	}, [localWindow, localWords, waveformEnvelope]);

	useEffect(() => {
		const canvas = waveformCanvasRef.current;
		const strip = stripRef.current;
		if (!canvas || !strip) return;

		const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
		const width = Math.max(120, strip.clientWidth || 120);
		const height = Math.max(24, strip.clientHeight || 24);
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;

		const context = canvas.getContext("2d");
		if (!context) return;

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.scale(dpr, dpr);
		context.clearRect(0, 0, width, height);
		if (waveformBars.length === 0) return;

		const centerY = height / 2;
		const maxBarHeight = Math.max(4, height / 2 - 4);
		const step = width / waveformBars.length;
		context.fillStyle = "rgba(255,255,255,0.5)";
		for (let index = 0; index < waveformBars.length; index++) {
			const bar = waveformBars[index];
			const x = index * step;
			const topHeight = Math.max(
				1,
				Math.round(Math.abs(Math.max(0, bar.max)) * maxBarHeight),
			);
			const bottomHeight = Math.max(
				1,
				Math.round(Math.abs(Math.min(0, bar.min)) * maxBarHeight),
			);
			const barWidth = Math.max(1, Math.ceil(step * 0.8));
			context.fillRect(x, centerY - topHeight, barWidth, topHeight);
			context.fillRect(x, centerY, barWidth, bottomHeight);
		}
	}, [waveformBars]);

	if (!focusedWord || !previewFocusedWord || !localWindow) return null;

	const focusedTone = focusedWord.speakerId
		? speakerToneById.get(focusedWord.speakerId)
		: undefined;
	const boundaryHandleStyle = getBoundaryHandleStyle(focusedTone?.accent);
	const hasResettableLeftBoundary = Boolean(
		previousWord &&
			originalPreviousWord &&
			originalFocusedWord &&
			Math.abs(originalFocusedWord.startTime - focusedWord.startTime) > 0.0005,
	);
	const hasResettableRightBoundary = Boolean(
		nextWord &&
			originalNextWord &&
			originalFocusedWord &&
			Math.abs(originalFocusedWord.endTime - focusedWord.endTime) > 0.0005,
	);
	const canResetTiming =
		Boolean(originalFocusedWord) &&
		(hasResettableLeftBoundary || hasResettableRightBoundary);
	const originalLeftBoundaryDisplayTime =
		originalFocusedWord && previousWord
			? mapSourceTimeToLocalDisplayTime({
					sourceTime: originalFocusedWord.startTime,
					localWords: baseLocalWords,
				})
			: null;
	const originalRightBoundaryDisplayTime =
		originalFocusedWord && nextWord
			? mapSourceTimeToLocalDisplayTime({
					sourceTime: originalFocusedWord.endTime,
					localWords: baseLocalWords,
				})
			: null;
	const showOriginalLeftBoundary = Boolean(
		previousWord &&
			originalPreviousWord &&
			originalLeftBoundaryDisplayTime != null,
	);
	const showOriginalRightBoundary = Boolean(
		nextWord && originalNextWord && originalRightBoundaryDisplayTime != null,
	);

	return (
		<div>
			<div className="grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-2">
				<div className="relative h-16 min-w-0 overflow-hidden rounded-md">
					<div
						ref={stripRef}
						className="absolute inset-y-0"
						style={{
							left: `${TRACK_HORIZONTAL_INSET_PX}px`,
							right: `${TRACK_HORIZONTAL_INSET_PX}px`,
						}}
					>
						<div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-zinc-800" />
						<canvas
							ref={waveformCanvasRef}
							className="pointer-events-none absolute inset-0 z-10 opacity-95"
						/>
						{!isPlaying && showOriginalLeftBoundary ? (
							<div
								aria-hidden="true"
								className="pointer-events-none absolute top-1/2 z-20 h-12 -translate-x-1/2 -translate-y-1/2 border-l-2 border-dashed transition-opacity duration-200"
								style={{
									left: `${getPercent(originalLeftBoundaryDisplayTime ?? 0)}%`,
									borderColor: hasResettableLeftBoundary
										? hexToRgba(focusedTone?.accent ?? "#f4f4f5", 0.8)
										: "rgba(212,212,216,0.42)",
									opacity: 0.88,
								}}
							/>
						) : null}
						{!isPlaying && showOriginalRightBoundary ? (
							<div
								aria-hidden="true"
								className="pointer-events-none absolute top-1/2 z-20 h-12 -translate-x-1/2 -translate-y-1/2 border-l-2 border-dashed transition-opacity duration-200"
								style={{
									left: `${getPercent(originalRightBoundaryDisplayTime ?? 0)}%`,
									borderColor: hasResettableRightBoundary
										? hexToRgba(focusedTone?.accent ?? "#f4f4f5", 0.8)
										: "rgba(212,212,216,0.42)",
									opacity: 0.88,
								}}
							/>
						) : null}
						{visibleWords.map((item) => {
							const tone = item.word.speakerId
								? speakerToneById.get(item.word.speakerId)
								: undefined;
							const isFocused =
								item.word.kind === "word" && item.word.id === focusedWord.id;
							const isCurrent =
								currentWordId != null &&
								item.word.wordIds.includes(currentWordId);
							const isHeldPreviewWord =
								item.word.kind === "gap"
									? heldWordPreview?.gapId === item.word.id
									: item.word.wordIds.some((wordId) =>
											heldWordPreviewIds.has(wordId),
										);
							const widthPercent = Math.max(
								1,
								getPercent(item.displayEndTime) -
									getPercent(item.displayStartTime),
							);
							const showLabel = widthPercent >= 8 || isFocused || isCurrent;
							const previewProgress =
								heldWordPreview && isHeldPreviewWord
									? Math.max(
											0,
											Math.min(
												100,
												((previewCurrentTime - heldWordPreview.startTime) /
													Math.max(
														0.01,
														heldWordPreview.endTime - heldWordPreview.startTime,
													)) *
													100,
											),
										)
									: 0;
							if (item.word.kind === "gap") {
								return (
									<button
										key={item.word.id}
										type="button"
										className="absolute top-1/2 z-20 h-8 -translate-y-1/2 overflow-hidden rounded-sm border border-dashed text-left transition-colors hover:bg-zinc-700/50"
										style={{
											left: `${getPercent(item.displayStartTime)}%`,
											width: `${widthPercent}%`,
											borderColor: tone?.border ?? "rgba(113,113,122,0.75)",
											backgroundColor: hexToRgba(
												tone?.accent ?? "#a1a1aa",
												0.03,
											),
											color: tone?.mutedText ?? "#d4d4d8",
										}}
										title={`Pause ${item.word.startTime.toFixed(2)}s-${item.word.endTime.toFixed(2)}s`}
										onPointerDown={(event) => {
											if (event.button !== 0) return;
											onCaptureHeldPreviewPointer(
												event.currentTarget,
												event.pointerId,
											);
											onScheduleWordPreview({
												pointerId: event.pointerId,
												clientX: event.clientX,
												clientY: event.clientY,
												wordIds: [],
												wordStartTime: item.word.startTime,
												wordEndTime: item.word.endTime,
												gapId: item.word.id,
											});
										}}
										onPointerMove={(event) => {
											onHeldPreviewPointerMove({
												pointerId: event.pointerId,
												clientX: event.clientX,
												clientY: event.clientY,
											});
										}}
										onPointerUp={(event) => {
											onReleaseHeldPreviewPointer(
												event.currentTarget,
												event.pointerId,
											);
											onHeldPreviewPointerEnd(event.pointerId);
										}}
										onPointerCancel={(event) => {
											onReleaseHeldPreviewPointer(
												event.currentTarget,
												event.pointerId,
											);
											onHeldPreviewPointerEnd(event.pointerId);
										}}
									>
										{heldWordPreview && isHeldPreviewWord ? (
											<span
												aria-hidden="true"
												className="pointer-events-none absolute inset-y-0 left-0 bg-white/35 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]"
												style={{ width: `${previewProgress}%` }}
											/>
										) : null}
										<span className="relative z-10 flex h-full items-center justify-center px-1.5 text-[9px] uppercase tracking-[0.08em] text-white/70">
											Pause
										</span>
									</button>
								);
							}
							const timingWord = item.word;
							const tokenWords = timingWord.wordIds
								.map((wordId) => wordStateById.get(wordId) ?? null)
								.filter(
									(candidateWord): candidateWord is TranscriptEditWord =>
										candidateWord !== null,
								);
							const isRemoved =
								tokenWords.length > 0 &&
								tokenWords.every((tokenWord) => tokenWord.removed);
							const isHidden =
								tokenWords.length > 0 &&
								tokenWords.every((tokenWord) => tokenWord.hidden);
							const emphasizeWordBoundary =
								isFocused || (isCurrent && !isPlaying);
							const showWordBoundary = !isPlaying;
							const playbackProgress =
								isCurrent && currentSourceTime != null
									? Math.max(
											0,
											Math.min(
												100,
												((currentSourceTime - timingWord.startTime) /
													Math.max(
														0.01,
														timingWord.endTime - timingWord.startTime,
													)) *
													100,
											),
										)
									: 0;
							return (
								<button
									key={timingWord.id}
									type="button"
									className="absolute top-1/2 z-20 h-10 -translate-y-1/2 overflow-hidden text-left transition-colors hover:brightness-110"
									style={{
										left: `${getPercent(item.displayStartTime)}%`,
										width: `${widthPercent}%`,
										borderWidth: showWordBoundary ? 1 : 0,
										borderStyle: "solid",
										borderColor: showWordBoundary
											? emphasizeWordBoundary
												? (tone?.accent ?? "rgba(228,228,231,0.95)")
												: (tone?.border ?? "rgba(63,63,70,0.9)")
											: "transparent",
										backgroundColor: tone
											? hexToRgba(
													tone.accent,
													emphasizeWordBoundary ? 0.2 : 0.08,
												)
											: "rgba(39,39,42,0.32)",
										color: tone?.mutedText ?? undefined,
										boxShadow:
											emphasizeWordBoundary
												? `0 0 0 1px ${tone?.accent ?? "rgba(228,228,231,0.95)"}`
												: undefined,
									}}
									title={`${timingWord.text} ${timingWord.startTime.toFixed(2)}s-${timingWord.endTime.toFixed(2)}s`}
									onClick={() => onSeekWord(timingWord.firstWord)}
									onContextMenu={(event) => {
										event.preventDefault();
										event.stopPropagation();
										onClearInteractionState();
										if (timingWord.wordIds.length === 1) {
											invokeAction("transcript-toggle-word", {
												trackId,
												elementId,
												wordId: timingWord.firstWord.id,
											});
											return;
										}
										invokeAction("transcript-set-words-removed", {
											trackId,
											elementId,
											wordIds: timingWord.wordIds,
											removed: !tokenWords.every(
												(tokenWord) => tokenWord.removed,
											),
										});
									}}
									onPointerDown={(event) => {
										if (event.button !== 0) return;
										onCaptureHeldPreviewPointer(
											event.currentTarget,
											event.pointerId,
										);
										onScheduleWordPreview({
											pointerId: event.pointerId,
											clientX: event.clientX,
											clientY: event.clientY,
											wordIds: timingWord.wordIds,
											wordStartTime: timingWord.startTime,
											wordEndTime: timingWord.endTime,
										});
									}}
									onPointerMove={(event) => {
										onHeldPreviewPointerMove({
											pointerId: event.pointerId,
											clientX: event.clientX,
											clientY: event.clientY,
										});
									}}
									onPointerUp={(event) => {
										onReleaseHeldPreviewPointer(
											event.currentTarget,
											event.pointerId,
										);
										onHeldPreviewPointerEnd(event.pointerId);
									}}
									onPointerCancel={(event) => {
										onReleaseHeldPreviewPointer(
											event.currentTarget,
											event.pointerId,
										);
										onHeldPreviewPointerEnd(event.pointerId);
									}}
								>
									{heldWordPreview && isHeldPreviewWord ? (
										<span
											aria-hidden="true"
											className="pointer-events-none absolute inset-0 bg-white/40 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22)]"
											style={{ width: `${previewProgress}%` }}
										/>
									) : isCurrent ? (
										<span
											aria-hidden="true"
											className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]"
											style={{
												width: `${playbackProgress}%`,
												backgroundColor: hexToRgba(
													tone?.accent ?? "#ffffff",
													0.48,
												),
											}}
										/>
									) : null}
									<span className="relative z-10 flex h-full flex-col justify-center px-1.5">
										{showLabel ? (
											<span
												className={[
													"truncate text-[10px] font-medium",
													isRemoved
														? "line-through decoration-red-600 decoration-2 opacity-75"
														: "",
													isHidden ? "opacity-55" : "",
												]
													.filter(Boolean)
													.join(" ")}
												style={
													isRemoved
														? {
																textDecorationColor: tone?.accent ?? "#ef4444",
															}
														: undefined
												}
											>
												{item.word.text}
											</span>
										) : null}
										{dragState &&
										(timingWord.id === focusedWord.id ||
											(dragState.side === "left" &&
												timingWord.id === previousWord?.id) ||
											(dragState.side === "right" &&
												timingWord.id === nextWord?.id)) ? (
											<span className="truncate text-[9px] leading-tight text-white/85">
												{timingWord.startTime.toFixed(2)}-
												{timingWord.endTime.toFixed(2)}s
											</span>
										) : null}
									</span>
								</button>
							);
						})}
						{!isPlaying && leftBoundaryDisplayTime != null && previousWord ? (
							<button
								type="button"
								className="absolute top-1/2 z-40 h-16 -translate-x-1/2 -translate-y-1/2 touch-none"
								style={{
									left: `${getPercent(leftBoundaryDisplayTime)}%`,
									width: `${HANDLE_HITBOX_PX}px`,
								}}
								aria-label={`Adjust start of ${focusedWord.text}`}
								title={`Adjust start of ${focusedWord.text}`}
								onPointerDown={(event) =>
									beginBoundaryDrag(event, "left", previewFocusedWord.startTime)
								}
								onPointerMove={(event) =>
									updateBoundaryDrag(event.pointerId, event.clientX)
								}
								onPointerUp={(event) => {
									try {
										if (
											event.currentTarget.hasPointerCapture?.(event.pointerId)
										) {
											event.currentTarget.releasePointerCapture?.(
												event.pointerId,
											);
										}
									} catch {}
									commitBoundaryDrag(event.pointerId);
								}}
								onPointerCancel={(event) => {
									try {
										if (
											event.currentTarget.hasPointerCapture?.(event.pointerId)
										) {
											event.currentTarget.releasePointerCapture?.(
												event.pointerId,
											);
										}
									} catch {}
									setDragState((current) =>
										current && current.pointerId === event.pointerId
											? null
											: current,
									);
								}}
							>
								<span
									className="absolute left-1/2 top-1/2 h-12 w-px -translate-x-1/2 -translate-y-1/2"
									style={{ backgroundColor: boundaryHandleStyle.lineColor }}
								/>
								<span
									className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 border-2 bg-zinc-950"
									style={{
										borderColor: boundaryHandleStyle.gripBorder,
										boxShadow: `0 0 0 1px ${boundaryHandleStyle.gripShadow}`,
									}}
								/>
							</button>
						) : null}
						{!isPlaying && rightBoundaryDisplayTime != null && nextWord ? (
							<button
								type="button"
								className="absolute top-1/2 z-40 h-16 -translate-x-1/2 -translate-y-1/2 touch-none"
								style={{
									left: `${getPercent(rightBoundaryDisplayTime)}%`,
									width: `${HANDLE_HITBOX_PX}px`,
								}}
								aria-label={`Adjust end of ${focusedWord.text}`}
								title={`Adjust end of ${focusedWord.text}`}
								onPointerDown={(event) =>
									beginBoundaryDrag(event, "right", previewFocusedWord.endTime)
								}
								onPointerMove={(event) =>
									updateBoundaryDrag(event.pointerId, event.clientX)
								}
								onPointerUp={(event) => {
									try {
										if (
											event.currentTarget.hasPointerCapture?.(event.pointerId)
										) {
											event.currentTarget.releasePointerCapture?.(
												event.pointerId,
											);
										}
									} catch {}
									commitBoundaryDrag(event.pointerId);
								}}
								onPointerCancel={(event) => {
									try {
										if (
											event.currentTarget.hasPointerCapture?.(event.pointerId)
										) {
											event.currentTarget.releasePointerCapture?.(
												event.pointerId,
											);
										}
									} catch {}
									setDragState((current) =>
										current && current.pointerId === event.pointerId
											? null
											: current,
									);
								}}
							>
								<span
									className="absolute left-1/2 top-1/2 h-12 w-px -translate-x-1/2 -translate-y-1/2"
									style={{ backgroundColor: boundaryHandleStyle.lineColor }}
								/>
								<span
									className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 border-2 bg-zinc-950"
									style={{
										borderColor: boundaryHandleStyle.gripBorder,
										boxShadow: `0 0 0 1px ${boundaryHandleStyle.gripShadow}`,
									}}
								/>
							</button>
						) : null}
					</div>
				</div>
				<div className="flex items-center justify-end">
					{originalFocusedWord ? (
						<Button
							type="button"
							variant="outline"
							size="icon"
							className="size-7 border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
							onClick={resetFocusedTiming}
							disabled={!canResetTiming}
							title="Reset this word timing to the original transcript timing"
						>
							<RotateCcw className="size-3.5" />
						</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}
