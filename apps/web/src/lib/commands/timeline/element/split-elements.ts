import { Command } from "@/lib/commands/base-command";
import type { TimelineTrack } from "@/types/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { rippleShiftElements } from "@/lib/timeline";
import { splitAnimationsAtTime } from "@/lib/animation";
import {
	buildTranscriptCutsFromWords,
	mergeCutRanges,
	normalizeTranscriptWords,
} from "@/lib/transcript-editor/core";
import type { TranscriptEditCutRange } from "@/types/transcription";
import type { AudioElement, VideoElement } from "@/types/timeline";

function isTranscriptEditableElement(
	element: unknown,
): element is VideoElement | AudioElement {
	if (!element || typeof element !== "object") return false;
	const candidate = element as { type?: string };
	return candidate.type === "video" || candidate.type === "audio";
}

function splitTranscriptEdit({
	element,
	leftDuration,
	rightDuration,
}: {
	element: VideoElement | AudioElement;
	leftDuration: number;
	rightDuration: number;
}): {
	left: VideoElement["transcriptEdit"] | AudioElement["transcriptEdit"];
	right: VideoElement["transcriptEdit"] | AudioElement["transcriptEdit"];
} {
	const transcriptEdit = element.transcriptEdit;
	if (!transcriptEdit || transcriptEdit.words.length === 0) {
		return {
			left: transcriptEdit,
			right: transcriptEdit,
		};
	}

	const leftWords = normalizeTranscriptWords({
		words: transcriptEdit.words
			.filter((word) => word.endTime > 0 && word.startTime < leftDuration)
			.map((word) => ({
				...word,
				startTime: Math.max(0, Math.min(leftDuration, word.startTime)),
				endTime: Math.max(0, Math.min(leftDuration, word.endTime)),
			})),
	});
	const rightWords = normalizeTranscriptWords({
		words: transcriptEdit.words
			.filter((word) => word.endTime > leftDuration)
			.map((word) => ({
				...word,
				startTime: Math.max(0, Math.min(rightDuration, word.startTime - leftDuration)),
				endTime: Math.max(0, Math.min(rightDuration, word.endTime - leftDuration)),
			})),
	});

	const buildSegments = (words: typeof leftWords) =>
		words.length === 0
			? []
			: [
					{
						id: `${element.id}:seg:0`,
						wordStartIndex: 0,
						wordEndIndex: words.length - 1,
					},
				];

	const projectCuts = ({
		cuts,
		sourceStart,
		sourceEnd,
		offset,
	}: {
		cuts: TranscriptEditCutRange[];
		sourceStart: number;
		sourceEnd: number;
		offset: number;
	}): TranscriptEditCutRange[] =>
		mergeCutRanges({
			cuts: cuts
				.map((cut) => ({
					start: Math.max(sourceStart, cut.start),
					end: Math.min(sourceEnd, cut.end),
					reason: cut.reason,
				}))
				.filter((cut) => cut.end - cut.start > 0.01)
				.map((cut) => ({
					start: Math.max(0, cut.start - offset),
					end: Math.max(0.01, cut.end - offset),
					reason: cut.reason,
				})),
		});

	return {
		left: {
			...transcriptEdit,
			words: leftWords,
			cuts:
				transcriptEdit.cuts && transcriptEdit.cuts.length > 0
					? projectCuts({
							cuts: transcriptEdit.cuts,
							sourceStart: 0,
							sourceEnd: leftDuration,
							offset: 0,
						})
					: buildTranscriptCutsFromWords({ words: leftWords }),
			segmentsUi: buildSegments(leftWords),
			updatedAt: new Date().toISOString(),
		},
		right: {
			...transcriptEdit,
			words: rightWords,
			cuts:
				transcriptEdit.cuts && transcriptEdit.cuts.length > 0
					? projectCuts({
							cuts: transcriptEdit.cuts,
							sourceStart: leftDuration,
							sourceEnd: leftDuration + rightDuration,
							offset: leftDuration,
						})
					: buildTranscriptCutsFromWords({ words: rightWords }),
			segmentsUi: buildSegments(rightWords),
			updatedAt: new Date().toISOString(),
		},
	};
}

export class SplitElementsCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private rightSideElements: { trackId: string; elementId: string }[] = [];
	private previousSelection: { trackId: string; elementId: string }[] = [];
	private readonly elements: { trackId: string; elementId: string }[];
	private readonly splitTime: number;
	private readonly retainSide: "both" | "left" | "right";
	private readonly rippleEnabled: boolean;

	constructor({
		elements,
		splitTime,
		retainSide = "both",
		rippleEnabled = false,
	}: {
		elements: { trackId: string; elementId: string }[];
		splitTime: number;
		retainSide?: "both" | "left" | "right";
		rippleEnabled?: boolean;
	}) {
		super();
		this.elements = elements;
		this.splitTime = splitTime;
		this.retainSide = retainSide;
		this.rippleEnabled = rippleEnabled;
	}

	getRightSideElements(): { trackId: string; elementId: string }[] {
		return this.rightSideElements;
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();
		this.previousSelection = editor.selection.getSelectedElements();
		this.rightSideElements = [];

		const updatedTracks = this.savedState.map((track) => {
			const elementsToSplit = this.elements.filter(
				(target) => target.trackId === track.id,
			);

			if (elementsToSplit.length === 0) {
				return track;
			}

			let leftVisibleDurationForRipple: number | null = null;

			let elements = track.elements.flatMap((element) => {
				const shouldSplit = elementsToSplit.some(
					(target) => target.elementId === element.id,
				);

				if (!shouldSplit) {
					return [element];
				}

				const effectiveStart = element.startTime;
				const effectiveEnd = element.startTime + element.duration;

				if (
					this.splitTime <= effectiveStart ||
					this.splitTime >= effectiveEnd
				) {
					return [element];
				}

				const relativeTime = this.splitTime - element.startTime;
				const leftVisibleDuration = relativeTime;
				const rightVisibleDuration = element.duration - relativeTime;
				const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
					animations: element.animations,
					splitTime: relativeTime,
					shouldIncludeSplitBoundary: true,
				});

				if (this.retainSide === "left") {
					const leftTranscriptEdit = isTranscriptEditableElement(element)
						? splitTranscriptEdit({
								element,
								leftDuration: leftVisibleDuration,
								rightDuration: rightVisibleDuration,
						  }).left
						: undefined;
					return [
						{
							...element,
							duration: leftVisibleDuration,
							trimEnd: element.trimEnd + rightVisibleDuration,
							name: `${element.name} (left)`,
							animations: leftAnimations,
							...(leftTranscriptEdit !== undefined
								? { transcriptEdit: leftTranscriptEdit }
								: {}),
						},
					];
				}

				if (this.retainSide === "right") {
					if (this.rippleEnabled && elementsToSplit.length === 1) {
						leftVisibleDurationForRipple = leftVisibleDuration;
					}
					const newId = generateUUID();
					this.rightSideElements.push({
						trackId: track.id,
						elementId: newId,
					});
					const rightTranscriptEdit = isTranscriptEditableElement(element)
						? splitTranscriptEdit({
								element,
								leftDuration: leftVisibleDuration,
								rightDuration: rightVisibleDuration,
						  }).right
						: undefined;
					return [
						{
							...element,
							id: newId,
							startTime: this.splitTime,
							duration: rightVisibleDuration,
							trimStart: element.trimStart + leftVisibleDuration,
							name: `${element.name} (right)`,
							animations: rightAnimations,
							...(rightTranscriptEdit !== undefined
								? { transcriptEdit: rightTranscriptEdit }
								: {}),
						},
					];
				}

				// "both" - split into two pieces
				const secondElementId = generateUUID();
				this.rightSideElements.push({
					trackId: track.id,
					elementId: secondElementId,
				});
				const splitTranscript = isTranscriptEditableElement(element)
					? splitTranscriptEdit({
							element,
							leftDuration: leftVisibleDuration,
							rightDuration: rightVisibleDuration,
					  })
					: null;

				return [
					{
						...element,
						duration: leftVisibleDuration,
						trimEnd: element.trimEnd + rightVisibleDuration,
						name: `${element.name} (left)`,
						animations: leftAnimations,
						...(splitTranscript ? { transcriptEdit: splitTranscript.left } : {}),
					},
					{
						...element,
						id: secondElementId,
						startTime: this.splitTime,
						duration: rightVisibleDuration,
						trimStart: element.trimStart + leftVisibleDuration,
						name: `${element.name} (right)`,
						animations: rightAnimations,
						...(splitTranscript ? { transcriptEdit: splitTranscript.right } : {}),
					},
				];
			});

			if (this.rippleEnabled && leftVisibleDurationForRipple !== null) {
				elements = rippleShiftElements({
					elements,
					afterTime: this.splitTime,
					shiftAmount: leftVisibleDurationForRipple,
				});
			}

			return { ...track, elements } as typeof track;
		});

		editor.timeline.updateTracks(updatedTracks);

		if (this.rightSideElements.length > 0) {
			editor.selection.setSelectedElements({
				elements: this.rightSideElements,
			});
		}
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
			editor.selection.setSelectedElements({
				elements: this.previousSelection,
			});
		}
	}
}
