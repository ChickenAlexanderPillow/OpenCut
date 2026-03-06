import { Command } from "@/lib/commands/base-command";
import type { TimelineTrack } from "@/types/timeline";
import { EditorCore } from "@/core";
import { clampAnimationsToDuration } from "@/lib/animation";
import { reconcileLinkedCaptionIntegrityInTracks } from "@/lib/transcript-editor/sync-captions";
import { normalizeTimelineElementForInvariants } from "@/lib/timeline/element-timing";

export class UpdateElementDurationCommand extends Command {
	private savedState: TimelineTrack[] | null = null;

	constructor(
		private trackId: string,
		private elementId: string,
		private duration: number,
	) {
		super();
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();
		const minDuration = 1 / Math.max(1, editor.project.getActive().settings.fps);

		const updatedTracks = this.savedState.map((t) => {
			if (t.id !== this.trackId) return t;
			const newElements = t.elements.map((el) =>
				el.id === this.elementId
					? (() => {
							const normalized = normalizeTimelineElementForInvariants({
								element: { ...el, duration: this.duration },
								minDuration,
							});
							return {
								...normalized,
								animations: clampAnimationsToDuration({
									animations: el.animations,
									duration: normalized.duration,
								}),
							};
						})()
					: el,
			);
			return { ...t, elements: newElements } as typeof t;
		});

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
