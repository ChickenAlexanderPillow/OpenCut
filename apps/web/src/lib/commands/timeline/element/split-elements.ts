import { Command } from "@/lib/commands/base-command";
import type { TimelineTrack } from "@/types/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { rippleShiftElements } from "@/lib/timeline";
import { splitAnimationsAtTime } from "@/lib/animation";
import {
	projectTranscriptEditToWindow,
} from "@/lib/transcript-editor/core";
import {
	syncCaptionsFromTranscriptEdits,
	reconcileLinkedCaptionIntegrityInTracks,
} from "@/lib/transcript-editor/sync-captions";
import {
	compileTranscriptDraft,
	getTranscriptDraft,
	withTranscriptState,
} from "@/lib/transcript-editor/state";
import type { AudioElement, VideoElement, TextElement } from "@/types/timeline";

function isTranscriptEditableElement(
	element: unknown,
): element is VideoElement | AudioElement {
	if (!element || typeof element !== "object") return false;
	const candidate = element as { type?: string };
	return candidate.type === "video" || candidate.type === "audio";
}

type SplitTranscriptState = {
	draft: NonNullable<VideoElement["transcriptDraft"] | AudioElement["transcriptDraft"]>;
	applied: NonNullable<
		VideoElement["transcriptApplied"] | AudioElement["transcriptApplied"]
	>;
	compileState: NonNullable<
		VideoElement["transcriptCompileState"] | AudioElement["transcriptCompileState"]
	>;
};

function resolveSplitTranscriptProjectionContext({
	transcriptDraft,
	baseTrimStart,
}: {
	transcriptDraft: NonNullable<
		VideoElement["transcriptDraft"] | AudioElement["transcriptDraft"]
	>;
	baseTrimStart: number;
}): {
	sourceTranscript: NonNullable<
		VideoElement["transcriptDraft"] | AudioElement["transcriptDraft"]
	>;
	projectionSource: NonNullable<
		NonNullable<
			VideoElement["transcriptDraft"] | AudioElement["transcriptDraft"]
		>["projectionSource"]
	>;
} {
	const projectionSource = transcriptDraft.projectionSource;
	if (projectionSource) {
		return {
			sourceTranscript: {
				...transcriptDraft,
				words: projectionSource.words,
				cuts: projectionSource.cuts,
				updatedAt: projectionSource.updatedAt,
			},
			projectionSource,
		};
	}
	return {
		sourceTranscript: transcriptDraft,
		projectionSource: {
			words: transcriptDraft.words,
			cuts: transcriptDraft.cuts,
			updatedAt: transcriptDraft.updatedAt,
			baseTrimStart,
		},
	};
}

function splitTranscriptState({
	element,
	leftElementId,
	rightElementId,
	leftStartTime,
	rightStartTime,
	leftDuration,
	rightDuration,
}: {
	element: VideoElement | AudioElement;
	leftElementId: string;
	rightElementId: string;
	leftStartTime: number;
	rightStartTime: number;
	leftDuration: number;
	rightDuration: number;
}): {
	left: SplitTranscriptState | undefined;
	right: SplitTranscriptState | undefined;
} {
	const transcriptDraft = getTranscriptDraft(element);
	if (!transcriptDraft || transcriptDraft.words.length === 0) {
		return {
			left: undefined,
			right: undefined,
		};
	}

	const projectionContext = resolveSplitTranscriptProjectionContext({
		transcriptDraft,
		baseTrimStart: element.trimStart,
	});
	const sourceWindowStart = Math.max(
		0,
		element.trimStart - projectionContext.projectionSource.baseTrimStart,
	);
	const leftDraft = {
		...projectTranscriptEditToWindow({
			transcriptEdit: projectionContext.sourceTranscript,
			elementId: leftElementId,
			sourceStart: sourceWindowStart,
			sourceEnd: sourceWindowStart + leftDuration,
		}),
		projectionSource: projectionContext.projectionSource,
	};
	const rightDraft = {
		...projectTranscriptEditToWindow({
			transcriptEdit: projectionContext.sourceTranscript,
			elementId: rightElementId,
			sourceStart: sourceWindowStart + leftDuration,
			sourceEnd: sourceWindowStart + leftDuration + rightDuration,
		}),
		projectionSource: projectionContext.projectionSource,
	};
	return {
		left: {
			draft: leftDraft,
			applied: compileTranscriptDraft({
				mediaElementId: leftElementId,
				draft: leftDraft,
				mediaStartTime: leftStartTime,
				mediaDuration: leftDuration,
			}),
			compileState: {
				status: "idle",
				updatedAt: leftDraft.updatedAt,
			},
		},
		right: {
			draft: rightDraft,
			applied: compileTranscriptDraft({
				mediaElementId: rightElementId,
				draft: rightDraft,
				mediaStartTime: rightStartTime,
				mediaDuration: rightDuration,
			}),
			compileState: {
				status: "idle",
				updatedAt: rightDraft.updatedAt,
			},
		},
	};
}

type CaptionSplitOperation = {
	sourceMediaElementId: string;
	rightMediaElementId?: string;
	splitTime: number;
	retainSide: "both" | "left" | "right";
};

function splitCaptionWordTimings({
	timings,
	splitTime,
}: {
	timings: NonNullable<TextElement["captionWordTimings"]>;
	splitTime: number;
}): {
	left: NonNullable<TextElement["captionWordTimings"]>;
	right: NonNullable<TextElement["captionWordTimings"]>;
} {
	const left = timings
		.filter((timing) => timing.endTime > -1e-6 && timing.startTime < splitTime)
		.map((timing) => ({
			word: timing.word,
			startTime: Math.max(0, Math.min(splitTime, timing.startTime)),
			endTime: Math.max(0.01, Math.min(splitTime, timing.endTime)),
		}))
		.filter((timing) => timing.endTime - timing.startTime > 0.001);
	const right = timings
		.filter((timing) => timing.endTime > splitTime)
		.map((timing) => ({
			word: timing.word,
			startTime: Math.max(splitTime, timing.startTime),
			endTime: Math.max(splitTime + 0.01, timing.endTime),
		}))
		.filter((timing) => timing.endTime - timing.startTime > 0.001);
	return { left, right };
}

function buildCaptionFromTimings({
	base,
	timings,
	id,
	sourceMediaElementId,
}: {
	base: TextElement;
	timings: NonNullable<TextElement["captionWordTimings"]>;
	id: string;
	sourceMediaElementId: string;
}): TextElement | null {
	if (timings.length === 0) return null;
	const startTime = timings[0]?.startTime ?? base.startTime;
	const endTime = timings[timings.length - 1]?.endTime ?? startTime;
	return {
		...base,
		id,
		content: timings.map((timing) => timing.word).join(" ").trim(),
		startTime,
		duration: Math.max(0.04, endTime - startTime),
		captionWordTimings: timings,
		captionSourceRef: {
			mediaElementId: sourceMediaElementId,
			transcriptVersion: base.captionSourceRef?.transcriptVersion ?? 1,
		},
	};
}

function splitLinkedCaptionsForMedia({
	tracks,
	operations,
}: {
	tracks: TimelineTrack[];
	operations: CaptionSplitOperation[];
}): TimelineTrack[] {
	if (operations.length === 0) return tracks;
	const operationByMediaId = new Map(
		operations.map((operation) => [operation.sourceMediaElementId, operation]),
	);

	return tracks.map((track) => {
		if (track.type !== "text") return track;
		const nextElements = track.elements.flatMap((element) => {
			if (element.type !== "text") return [element];
			const sourceMediaId = element.captionSourceRef?.mediaElementId;
			if (!sourceMediaId) return [element];
			const operation = operationByMediaId.get(sourceMediaId);
			if (!operation) return [element];
			const timings = element.captionWordTimings;
			if (!timings || timings.length === 0) {
				if (operation.retainSide === "right" && operation.rightMediaElementId) {
					return [
						{
							...element,
							captionSourceRef: {
								mediaElementId: operation.rightMediaElementId,
								transcriptVersion: element.captionSourceRef?.transcriptVersion ?? 1,
							},
						},
					];
				}
				return [element];
			}

			const { left, right } = splitCaptionWordTimings({
				timings,
				splitTime: operation.splitTime,
			});

			if (operation.retainSide === "left") {
				const leftCaption = buildCaptionFromTimings({
					base: element,
					timings: left,
					id: element.id,
					sourceMediaElementId: operation.sourceMediaElementId,
				});
				return leftCaption ? [leftCaption] : [];
			}
			if (operation.retainSide === "right") {
				if (!operation.rightMediaElementId) return [];
				const rightCaption = buildCaptionFromTimings({
					base: element,
					timings: right,
					id: element.id,
					sourceMediaElementId: operation.rightMediaElementId,
				});
				return rightCaption ? [rightCaption] : [];
			}

			const leftCaption = buildCaptionFromTimings({
				base: element,
				timings: left,
				id: element.id,
				sourceMediaElementId: operation.sourceMediaElementId,
			});
			const rightCaption = operation.rightMediaElementId
				? buildCaptionFromTimings({
						base: element,
						timings: right,
						id: generateUUID(),
						sourceMediaElementId: operation.rightMediaElementId,
				  })
				: null;

			return [
				...(leftCaption ? [leftCaption] : []),
				...(rightCaption ? [rightCaption] : []),
			];
		});
		return {
			...track,
			elements: nextElements,
		};
	});
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
		const mediaElementIdsForCaptionSync = new Set<string>();
		const captionSplitOperations: CaptionSplitOperation[] = [];

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
					const canSplitLinkedCaptionsWithoutTranscript =
						isTranscriptEditableElement(element) &&
						((getTranscriptDraft(element)?.words.length ?? 0) === 0);
					if (canSplitLinkedCaptionsWithoutTranscript) {
						captionSplitOperations.push({
							sourceMediaElementId: element.id,
							splitTime: this.splitTime,
							retainSide: "left",
						});
					}
					const leftTranscriptEdit = isTranscriptEditableElement(element)
						? splitTranscriptState({
								element,
								leftElementId: element.id,
								rightElementId: element.id,
								leftStartTime: element.startTime,
								rightStartTime: this.splitTime,
								leftDuration: leftVisibleDuration,
								rightDuration: rightVisibleDuration,
						  }).left
						: undefined;
					if (leftTranscriptEdit !== undefined) {
						mediaElementIdsForCaptionSync.add(element.id);
					}
					return [
						leftTranscriptEdit
							? withTranscriptState({
									element: {
										...element,
										duration: leftVisibleDuration,
										trimEnd: element.trimEnd + rightVisibleDuration,
										name: `${element.name} (left)`,
										animations: leftAnimations,
									} as VideoElement | AudioElement,
									draft: leftTranscriptEdit.draft,
									applied: leftTranscriptEdit.applied,
									compileState: leftTranscriptEdit.compileState,
							  })
							: {
							...element,
							duration: leftVisibleDuration,
							trimEnd: element.trimEnd + rightVisibleDuration,
							name: `${element.name} (left)`,
							animations: leftAnimations,
						},
					];
				}

				if (this.retainSide === "right") {
					if (this.rippleEnabled && elementsToSplit.length === 1) {
						leftVisibleDurationForRipple = leftVisibleDuration;
					}
					const newId = generateUUID();
					const canSplitLinkedCaptionsWithoutTranscript =
						isTranscriptEditableElement(element) &&
						((getTranscriptDraft(element)?.words.length ?? 0) === 0);
					if (canSplitLinkedCaptionsWithoutTranscript) {
						captionSplitOperations.push({
							sourceMediaElementId: element.id,
							rightMediaElementId: newId,
							splitTime: this.splitTime,
							retainSide: "right",
						});
					}
					this.rightSideElements.push({
						trackId: track.id,
						elementId: newId,
					});
					const rightTranscriptEdit = isTranscriptEditableElement(element)
						? splitTranscriptState({
								element,
								leftElementId: element.id,
								rightElementId: newId,
								leftStartTime: element.startTime,
								rightStartTime: this.splitTime,
								leftDuration: leftVisibleDuration,
								rightDuration: rightVisibleDuration,
						  }).right
						: undefined;
					if (rightTranscriptEdit !== undefined) {
						mediaElementIdsForCaptionSync.add(newId);
					}
					return [
						rightTranscriptEdit
							? withTranscriptState({
									element: {
										...element,
										id: newId,
										startTime: this.splitTime,
										duration: rightVisibleDuration,
										trimStart: element.trimStart + leftVisibleDuration,
										name: `${element.name} (right)`,
										animations: rightAnimations,
									} as VideoElement | AudioElement,
									draft: rightTranscriptEdit.draft,
									applied: rightTranscriptEdit.applied,
									compileState: rightTranscriptEdit.compileState,
							  })
							: {
							...element,
							id: newId,
							startTime: this.splitTime,
							duration: rightVisibleDuration,
							trimStart: element.trimStart + leftVisibleDuration,
							name: `${element.name} (right)`,
							animations: rightAnimations,
						},
					];
				}

				// "both" - split into two pieces
				const secondElementId = generateUUID();
				const canSplitLinkedCaptionsWithoutTranscript =
					isTranscriptEditableElement(element) &&
					((getTranscriptDraft(element)?.words.length ?? 0) === 0);
				if (canSplitLinkedCaptionsWithoutTranscript) {
					captionSplitOperations.push({
						sourceMediaElementId: element.id,
						rightMediaElementId: secondElementId,
						splitTime: this.splitTime,
						retainSide: "both",
					});
				}
				this.rightSideElements.push({
					trackId: track.id,
					elementId: secondElementId,
				});
				const splitTranscript = isTranscriptEditableElement(element)
					? splitTranscriptState({
							element,
							leftElementId: element.id,
							rightElementId: secondElementId,
							leftStartTime: element.startTime,
							rightStartTime: this.splitTime,
							leftDuration: leftVisibleDuration,
							rightDuration: rightVisibleDuration,
					  })
					: null;
				if (splitTranscript) {
					mediaElementIdsForCaptionSync.add(element.id);
					mediaElementIdsForCaptionSync.add(secondElementId);
				}

				return [
					splitTranscript?.left
						? withTranscriptState({
								element: {
									...element,
									duration: leftVisibleDuration,
									trimEnd: element.trimEnd + rightVisibleDuration,
									name: `${element.name} (left)`,
									animations: leftAnimations,
								} as VideoElement | AudioElement,
								draft: splitTranscript.left.draft,
								applied: splitTranscript.left.applied,
								compileState: splitTranscript.left.compileState,
						  })
						: {
						...element,
						duration: leftVisibleDuration,
						trimEnd: element.trimEnd + rightVisibleDuration,
						name: `${element.name} (left)`,
						animations: leftAnimations,
					},
					splitTranscript?.right
						? withTranscriptState({
								element: {
									...element,
									id: secondElementId,
									startTime: this.splitTime,
									duration: rightVisibleDuration,
									trimStart: element.trimStart + leftVisibleDuration,
									name: `${element.name} (right)`,
									animations: rightAnimations,
								} as VideoElement | AudioElement,
								draft: splitTranscript.right.draft,
								applied: splitTranscript.right.applied,
								compileState: splitTranscript.right.compileState,
						  })
						: {
						...element,
						id: secondElementId,
						startTime: this.splitTime,
						duration: rightVisibleDuration,
						trimStart: element.trimStart + leftVisibleDuration,
						name: `${element.name} (right)`,
						animations: rightAnimations,
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

		let syncedTracks = splitLinkedCaptionsForMedia({
			tracks: updatedTracks,
			operations: captionSplitOperations,
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
