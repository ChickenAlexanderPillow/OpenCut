import type { EditorCore } from "@/core";
import type { Command } from "@/lib/commands/base-command";
import { BatchCommand } from "@/lib/commands";
import { AddMediaAssetCommand } from "@/lib/commands/media";
import { AddTrackCommand, InsertElementCommand } from "@/lib/commands/timeline";
import { processMediaAssets } from "@/lib/media/processing";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import { autoLinkTranscriptAndCaptionsForMediaElement } from "@/lib/media/transcript-import";

export type LocalMusicSourceFile = {
	name: string;
	relativePath: string;
	extension: string;
	modifiedAt?: string;
};

type LocalMusicInsertTarget =
	| {
			mode: "auto";
			startTime: number;
	  }
	| {
			mode: "explicit";
			startTime: number;
			trackId?: string;
			trackIndex: number;
			isNewTrack: boolean;
	  };

async function fetchLocalMusicFile({
	root,
	file,
}: {
	root: string;
	file: LocalMusicSourceFile;
}): Promise<File> {
	const search = new URLSearchParams({
		path: file.relativePath,
		root,
	});
	const response = await fetch(`/api/music/local/source?${search.toString()}`, {
		cache: "no-store",
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new Error(payload?.error || `Failed to load ${file.name}`);
	}

	const blob = await response.blob();
	const contentType =
		response.headers.get("content-type") || `audio/${file.extension}`;

	return new File([blob], file.name, {
		type: contentType,
		lastModified: file.modifiedAt ? Date.parse(file.modifiedAt) : Date.now(),
	});
}

export async function importLocalMusicToTimeline({
	editor,
	root,
	file,
	target,
}: {
	editor: EditorCore;
	root: string;
	file: LocalMusicSourceFile;
	target: LocalMusicInsertTarget;
}): Promise<{ assetId: string; elementId: string; trackId: string | null }> {
	const activeProject = editor.project.getActive();
	if (!activeProject) {
		throw new Error("No active project");
	}

	const sourceFile = await fetchLocalMusicFile({ root, file });
	const processedAssets = await processMediaAssets({ files: [sourceFile] });
	const asset = processedAssets[0];

	if (!asset || asset.type !== "audio") {
		throw new Error(`Failed to import ${file.name}`);
	}

	const addMediaCmd = new AddMediaAssetCommand(
		activeProject.metadata.id,
		asset,
	);
	const assetId = addMediaCmd.getAssetId();
	addMediaCmd.setAsset({ asset });

	const commands: Command[] = [addMediaCmd];
	let trackId: string | undefined;

	if (target.mode === "explicit") {
		if (target.isNewTrack) {
			const addTrackCmd = new AddTrackCommand("audio", target.trackIndex);
			trackId = addTrackCmd.getTrackId();
			commands.unshift(addTrackCmd);
		} else {
			trackId = target.trackId;
		}
	}

	const element = buildElementFromMedia({
		mediaId: assetId,
		mediaType: "audio",
		name: asset.name,
		duration: asset.duration ?? 0,
		startTime: target.startTime,
	});

	const insertCmd = new InsertElementCommand({
		element,
		placement:
			target.mode === "auto"
				? { mode: "auto", trackType: "audio" }
				: { mode: "explicit", trackId: trackId ?? "" },
	});
	commands.push(insertCmd);

	editor.command.execute({ command: new BatchCommand(commands) });

	const insertedTrackId =
		(target.mode === "auto" ? insertCmd.getTrackId() : trackId) ?? null;
	if (insertedTrackId) {
		void autoLinkTranscriptAndCaptionsForMediaElement({
			editor,
			trackId: insertedTrackId,
			elementId: insertCmd.getElementId(),
		});
	}

	return {
		assetId,
		elementId: insertCmd.getElementId(),
		trackId: insertedTrackId,
	};
}
