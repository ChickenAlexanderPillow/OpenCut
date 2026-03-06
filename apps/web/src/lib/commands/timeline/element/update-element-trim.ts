import { Command } from "@/lib/commands/base-command";
import type { TimelineTrack } from "@/types/timeline";
import { EditorCore } from "@/core";
import { clampAnimationsToDuration } from "@/lib/animation";
import { rippleShiftElements } from "@/lib/timeline";
import { projectTranscriptEditToWindow } from "@/lib/transcript-editor/core";
import { CAPTION_TAIL_PAD_SECONDS } from "@/lib/transcript-editor/constants";
import {
	syncCaptionsFromTranscriptEdits,
	reconcileLinkedCaptionIntegrityInTracks,
} from "@/lib/transcript-editor/sync-captions";
import type { AudioElement, VideoElement, TextElement } from "@/types/timeline";
import { normalizeElementTiming } from "@/lib/timeline/element-timing";

function isTranscriptEditableElement(
	element: unknown,
): element is VideoElement | AudioElement {
	if (!element || typeof element !== "object") return false;
	const candidate = element as { type?: string };
	return candidate.type === "video" || candidate.type === "audio";
}

type CaptionTrimOperation = {
	mediaElementId: string;
	startTime: number;
	endTime: number;
};

function resolveTranscriptProjectionContext({
	transcriptEdit,
	defaultBaseTrimStart,
}: {
	transcriptEdit: NonNullable<
		VideoElement["transcriptEdit"] | AudioElement["transcriptEdit"]
	>;
	defaultBaseTrimStart: number;
}): {
	sourceTranscript: NonNullable<
		VideoElement["transcriptEdit"] | AudioElement["transcriptEdit"]
	>;
	baseTrimStart: number;
	projectionSource: NonNullable<
		VideoElement["transcriptEdit"] | AudioElement["transcriptEdit"]
	>["projectionSource"];
} {
	const projectionSource = transcriptEdit.projectionSource;
	if (!projectionSource) {
		return {
			sourceTranscript: transcriptEdit,
			baseTrimStart: defaultBaseTrimStart,
			projectionSource: {
				words: transcriptEdit.words,
				cuts: transcriptEdit.cuts,
				updatedAt: transcriptEdit.updatedAt,
				baseTrimStart: defaultBaseTrimStart,
			},
		};
	}

	return {
		sourceTranscript: {
			...transcriptEdit,
			words: projectionSource.words,
			cuts: projectionSource.cuts,
			updatedAt: projectionSource.updatedAt,
		},
		baseTrimStart: projectionSource.baseTrimStart,
		projectionSource,
	};
}

function trimLinkedCaptionsForMedia({
	tracks,
	operations,
}: {
	tracks: TimelineTrack[];
	operations: CaptionTrimOperation[];
}): TimelineTrack[] {
	if (operations.length === 0) return tracks;
	const operationByMediaId = new Map(
		operations.map((operation) => [operation.mediaElementId, operation]),
	);

	const trimTimings = ({
		timings,
		startTime,
		endTime,
	}: {
		timings: NonNullable<TextElement["captionWordTimings"]>;
		startTime: number;
		endTime: number;
	}): NonNullable<TextElement["captionWordTimings"]> =>
		timings
			.filter(
				(timing) => timing.endTime > startTime && timing.startTime < endTime,
			)
			.map((timing) => ({
				word: timing.word,
				startTime: Math.max(startTime, timing.startTime),
				endTime: Math.min(endTime, timing.endTime),
			}))
			.filter((timing) => timing.endTime - timing.startTime > 0.001);

	return tracks.map((track) => {
		if (track.type !== "text") return track;
		const nextElements = track.elements.flatMap((element) => {
			if (element.type !== "text") return [element];
			const linkedMediaId = element.captionSourceRef?.mediaElementId;
			if (!linkedMediaId) return [element];
			const operation = operationByMediaId.get(linkedMediaId);
			if (!operation) return [element];

			const timings = element.captionWordTimings;
			if (timings && timings.length > 0) {
				const trimmedTimings = trimTimings({
					timings,
					startTime: operation.startTime,
					endTime: operation.endTime,
				});
				if (trimmedTimings.length === 0) return [];
				const nextStart = trimmedTimings[0]?.startTime ?? operation.startTime;
				const nextEnd =
					trimmedTimings[trimmedTimings.length - 1]?.endTime ?? nextStart;
				return [
					{
						...element,
						content: trimmedTimings
							.map((timing) => timing.word)
							.join(" ")
							.trim(),
						startTime: nextStart,
						duration: Math.max(
							0.04,
							nextEnd - nextStart + CAPTION_TAIL_PAD_SECONDS,
						),
						captionWordTimings: trimmedTimings,
					},
				];
			}

			const captionStart = element.startTime;
			const captionEnd = element.startTime + element.duration;
			const nextStart = Math.max(captionStart, operation.startTime);
			const nextEnd = Math.min(captionEnd, operation.endTime);
			if (nextEnd - nextStart <= 0.01) return [];
			return [
				{
					...element,
					startTime: nextStart,
					duration: Math.max(0.04, nextEnd - nextStart),
				},
			];
		});
		return { ...track, elements: nextElements };
	});
}

export class UpdateElementTrimCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private readonly elementId: string;
	private readonly trimStart: number;
	private readonly trimEnd: number;
	private readonly startTime: number | undefined;
	private readonly duration: number | undefined;
	private readonly rippleEnabled: boolean;
	private readonly transcriptProjectionBase:
		| {
				transcriptEdit:
					| VideoElement["transcriptEdit"]
					| AudioElement["transcriptEdit"];
				trimStart: number;
		  }
		| undefined;
	private readonly captionSyncMode: "full" | "trim-only";

	constructor({
		elementId,
		trimStart,
		trimEnd,
		startTime,
		duration,
		rippleEnabled = false,
		transcriptProjectionBase,
		captionSyncMode = "full",
	}: {
		elementId: string;
		trimStart: number;
		trimEnd: number;
		startTime?: number;
		duration?: number;
		rippleEnabled?: boolean;
		transcriptProjectionBase?: {
			transcriptEdit:
				| VideoElement["transcriptEdit"]
				| AudioElement["transcriptEdit"];
			trimStart: number;
		};
		captionSyncMode?: "full" | "trim-only";
	}) {
		super();
		this.elementId = elementId;
		this.trimStart = trimStart;
		this.trimEnd = trimEnd;
		this.startTime = startTime;
		this.duration = duration;
		this.rippleEnabled = rippleEnabled;
		this.transcriptProjectionBase = transcriptProjectionBase;
		this.captionSyncMode = captionSyncMode;
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();
		const projectFps = editor.project.getActive().settings.fps;
		const minDuration = 1 / projectFps;
		const mediaElementIdsForCaptionSync = new Set<string>();
		const captionTrimOperations: CaptionTrimOperation[] = [];
		const shouldRunFullCaptionSync = this.captionSyncMode === "full";

		const updatedTracks = this.savedState.map((track) => {
			const targetElement = track.elements.find(
				(element) => element.id === this.elementId,
			);
			if (!targetElement) return track;

			const normalizedTiming = normalizeElementTiming({
				startTime: this.startTime ?? targetElement.startTime,
				duration: this.duration ?? targetElement.duration,
				trimStart: this.trimStart,
				trimEnd: this.trimEnd,
				minDuration,
			});
			const nextTrimStart = normalizedTiming.trimStart;
			const nextDuration = normalizedTiming.duration;
			const nextStartTime = normalizedTiming.startTime;

			const oldEndTime = targetElement.startTime + targetElement.duration;
			const newEndTime = nextStartTime + nextDuration;
			const shiftAmount = oldEndTime - newEndTime;

			const updatedElement = {
				...targetElement,
				trimStart: nextTrimStart,
				trimEnd: normalizedTiming.trimEnd,
				startTime: nextStartTime,
				duration: nextDuration,
				animations: clampAnimationsToDuration({
					animations: targetElement.animations,
					duration: nextDuration,
				}),
			};
			const updatedElementWithTranscript = isTranscriptEditableElement(
				targetElement,
			)
				? (() => {
						if (
							!shouldRunFullCaptionSync ||
							!targetElement.transcriptEdit ||
							targetElement.transcriptEdit.words.length === 0
						) {
							captionTrimOperations.push({
								mediaElementId: targetElement.id,
								startTime: nextStartTime,
								endTime: nextStartTime + nextDuration,
							});
							return updatedElement;
						}
						const projectionBaseTranscript =
							this.transcriptProjectionBase?.transcriptEdit ??
							targetElement.transcriptEdit;
						const projectionBaseTrimStartCandidate =
							this.transcriptProjectionBase?.trimStart ??
							targetElement.trimStart;
						const projectionContext = resolveTranscriptProjectionContext({
							transcriptEdit: projectionBaseTranscript,
							defaultBaseTrimStart: projectionBaseTrimStartCandidate,
						});
						mediaElementIdsForCaptionSync.add(targetElement.id);
						const projectedTranscript = projectTranscriptEditToWindow({
							transcriptEdit: projectionContext.sourceTranscript,
							elementId: targetElement.id,
							sourceStart: nextTrimStart - projectionContext.baseTrimStart,
							sourceEnd:
								nextTrimStart - projectionContext.baseTrimStart + nextDuration,
						});
						return {
							...updatedElement,
							transcriptEdit: {
								...projectedTranscript,
								projectionSource: projectionContext.projectionSource,
							},
						};
					})()
				: (() => {
						return updatedElement;
					})();

			if (this.rippleEnabled && Math.abs(shiftAmount) > 0) {
				const shiftedOthers = rippleShiftElements({
					elements: track.elements.filter(
						(element) => element.id !== this.elementId,
					),
					afterTime: oldEndTime,
					shiftAmount,
				});
				return {
					...track,
					elements: track.elements.map((element) =>
						element.id === this.elementId
							? updatedElementWithTranscript
							: (shiftedOthers.find((shifted) => shifted.id === element.id) ??
								element),
					),
				} as typeof track;
			}

			return {
				...track,
				elements: track.elements.map((element) =>
					element.id === this.elementId
						? updatedElementWithTranscript
						: element,
				),
			} as typeof track;
		});

		let syncedTracks = trimLinkedCaptionsForMedia({
			tracks: updatedTracks,
			operations: captionTrimOperations,
		});
		for (const mediaElementId of mediaElementIdsForCaptionSync) {
			const syncResult = syncCaptionsFromTranscriptEdits({
				tracks: syncedTracks,
				mediaElementId,
			});
			if (syncResult.changed) {
				syncedTracks = syncResult.tracks;
			}
		}
		const reconciled = reconcileLinkedCaptionIntegrityInTracks({
			beforeTracks: this.savedState,
			tracks: syncedTracks,
		});

		editor.timeline.updateTracks(reconciled.tracks);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
