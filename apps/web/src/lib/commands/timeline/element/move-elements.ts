import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import type {
	TimelineTrack,
	TimelineElement,
	TrackType,
} from "@/types/timeline";
import {
	buildEmptyTrack,
	isMainTrack,
	validateElementTrackCompatibility,
	enforceMainTrackStart,
} from "@/lib/timeline/track-utils";
import { rippleShiftElements } from "@/lib/timeline/ripple-utils";
import { reconcileLinkedCaptionIntegrityInTracks } from "@/lib/transcript-editor/sync-captions";
import { isCaptionTimingRelativeToElement } from "@/lib/captions/timing";
import { normalizeTimelineElementForInvariants } from "@/lib/timeline/element-timing";

export class MoveElementCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private readonly sourceTrackId: string;
	private readonly targetTrackId: string;
	private readonly elementId: string;
	private readonly newStartTime: number;
	private readonly createTrack: { type: TrackType; index: number } | undefined;
	private readonly rippleEnabled: boolean;

	constructor({
		sourceTrackId,
		targetTrackId,
		elementId,
		newStartTime,
		createTrack,
		rippleEnabled = false,
	}: {
		sourceTrackId: string;
		targetTrackId: string;
		elementId: string;
		newStartTime: number;
		createTrack?: { type: TrackType; index: number };
		rippleEnabled?: boolean;
	}) {
		super();
		this.sourceTrackId = sourceTrackId;
		this.targetTrackId = targetTrackId;
		this.elementId = elementId;
		this.newStartTime = newStartTime;
		this.createTrack = createTrack;
		this.rippleEnabled = rippleEnabled;
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();

		const sourceTrack = this.savedState.find(
			(track) => track.id === this.sourceTrackId,
		);
		const element = sourceTrack?.elements.find(
			(trackElement) => trackElement.id === this.elementId,
		);

		if (!sourceTrack || !element) {
			throw new Error("Source track or element not found");
		}

		let targetTrack = this.savedState.find((track) => track.id === this.targetTrackId);
		let tracksToUpdate = this.savedState;
		if (!targetTrack && this.createTrack) {
			const newTrack = buildEmptyTrack({
				id: this.targetTrackId,
				type: this.createTrack.type,
			});
			tracksToUpdate = [...this.savedState];
			tracksToUpdate.splice(this.createTrack.index, 0, newTrack);
			targetTrack = newTrack;
		}
		if (!targetTrack) {
			throw new Error("Target track not found");
		}

		const validation = validateElementTrackCompatibility({
			element,
			track: targetTrack,
		});

		if (!validation.isValid) {
			throw new Error(validation.errorMessage);
		}

		const adjustedStartTime = enforceMainTrackStart({
			tracks: tracksToUpdate,
			targetTrackId: this.targetTrackId,
			requestedStartTime: Math.max(0, this.newStartTime),
			excludeElementId: this.elementId,
		});
		const minDuration = 1 / Math.max(1, editor.project.getActive().settings.fps);

		// keyframe times remain clip-local, so moving only changes element startTime.
		const movedElement: TimelineElement = normalizeTimelineElementForInvariants({
			element: {
				...element,
				startTime: adjustedStartTime,
			},
			minDuration,
		});

		const isSameTrack = this.sourceTrackId === this.targetTrackId;

		let updatedTracks = tracksToUpdate.map((track): TimelineTrack => {
			if (isSameTrack && track.id === this.sourceTrackId) {
				return {
					...track,
					elements: track.elements.map((trackElement) =>
						trackElement.id === this.elementId ? movedElement : trackElement,
					),
				} as typeof track;
			}

			if (track.id === this.sourceTrackId) {
				const remainingElements = track.elements.filter(
					(trackElement) => trackElement.id !== this.elementId,
				);
				const shiftedElements = this.rippleEnabled
					? rippleShiftElements({
							elements: remainingElements,
							afterTime: element.startTime,
							shiftAmount: element.duration,
						})
					: remainingElements;
				return { ...track, elements: shiftedElements } as typeof track;
			}

			if (track.id === this.targetTrackId) {
				return {
					...track,
					elements: [...track.elements, movedElement],
				} as typeof track;
			}

			return track;
		});

		const mediaShift = movedElement.startTime - element.startTime;
		if (
			Math.abs(mediaShift) > 1e-6 &&
			(movedElement.type === "video" || movedElement.type === "audio")
		) {
			updatedTracks = updatedTracks.map((track) => {
				if (track.type !== "text") return track;
				let changed = false;
				const nextElements = track.elements.map((trackElement) => {
					if (trackElement.type !== "text") return trackElement;
					if (
						trackElement.captionSourceRef?.mediaElementId !== movedElement.id
					) {
						return trackElement;
					}
					const nextStartTime = Math.max(0, trackElement.startTime + mediaShift);
					const currentTimings = trackElement.captionWordTimings ?? [];
					const timingsAreRelative = isCaptionTimingRelativeToElement({
						timings: currentTimings,
						elementDuration: trackElement.duration,
					});
					const nextTimings =
						currentTimings.length === 0 || timingsAreRelative
							? currentTimings
							: currentTimings.map((timing) => ({
									word: timing.word,
									startTime: timing.startTime + mediaShift,
									endTime: timing.endTime + mediaShift,
							  }));
					changed = true;
					return {
						...trackElement,
						startTime: nextStartTime,
						captionWordTimings: nextTimings,
					};
				});
				return changed ? ({ ...track, elements: nextElements } as typeof track) : track;
			});
		}

		if (!isSameTrack) {
			const sourceTrackAfterMove = updatedTracks.find(
				(track) => track.id === this.sourceTrackId,
			);
			if (
				sourceTrackAfterMove &&
				sourceTrackAfterMove.elements.length === 0 &&
				!isMainTrack(sourceTrackAfterMove)
			) {
				updatedTracks = updatedTracks.filter(
					(track) => track.id !== this.sourceTrackId,
				);
			}
		}

		const reconciled = reconcileLinkedCaptionIntegrityInTracks({
			beforeTracks: this.savedState,
			tracks: updatedTracks,
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
