import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import { rippleDeleteGapFromTrack } from "@/lib/timeline";
import { reconcileLinkedCaptionIntegrityInTracks } from "@/lib/transcript-editor/sync-captions";
import type { TimelineGapSelection, TimelineTrack } from "@/types/timeline";

export class DeleteGapCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private readonly gap: TimelineGapSelection;

	constructor({ gap }: { gap: TimelineGapSelection }) {
		super();
		this.gap = gap;
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();

		const updatedTracks = this.savedState.map((track) =>
			rippleDeleteGapFromTrack({
				track,
				gap: this.gap,
			}),
		);
		const reconciled = reconcileLinkedCaptionIntegrityInTracks({
			beforeTracks: this.savedState,
			tracks: updatedTracks,
		});

		editor.timeline.updateTracks(reconciled.tracks);
	}

	undo(): void {
		if (!this.savedState) return;
		EditorCore.getInstance().timeline.updateTracks(this.savedState);
	}
}
