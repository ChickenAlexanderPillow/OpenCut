"use client";

import { useMemo } from "react";
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
import { AlignJustify, Scissors } from "lucide-react";

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

export function TranscriptView() {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const tracks = editor.timeline.getTracks();
	const currentTime = editor.playback.getCurrentTime();

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
			: [{ id: "default", words: wordsWithCutState }];

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

	if (!activeMedia) {
		return (
			<PanelView title="Transcript" contentClassName="space-y-2">
				<div className="text-sm text-muted-foreground p-3 border rounded-md">
					Select a clip audio/video element to edit transcript words.
				</div>
			</PanelView>
		);
	}

	if (wordsWithCutState.length === 0) {
		return (
			<PanelView title="Transcript" contentClassName="space-y-2">
				<div className="text-sm text-muted-foreground p-3 border rounded-md">
					Word-level transcript unavailable for this element.
				</div>
			</PanelView>
		);
	}

	return (
		<PanelView
			title="Transcript"
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
						<div className="flex flex-wrap gap-1.5">
							{group.words.map((word) => (
								<Button
									key={word.id}
									variant="secondary"
									size="sm"
									onClick={() =>
										invokeAction("transcript-toggle-word", {
											trackId: activeMedia.trackId,
											elementId: activeMedia.element.id,
											wordId: word.id,
										})
									}
									className={[
										"h-7 px-2 rounded-full text-xs",
										word.removed ? "opacity-35 line-through" : "",
										currentWordId === word.id ? "ring-2 ring-primary" : "",
									]
										.filter(Boolean)
										.join(" ")}
								>
									{word.text}
								</Button>
							))}
						</div>
					</div>
				);
			})}

			<div className="text-[11px] text-muted-foreground px-1 flex items-center gap-1">
				<AlignJustify className="size-3.5" />
				Transcript edits update captions, playback, and export
				non-destructively.
			</div>
		</PanelView>
	);
}
