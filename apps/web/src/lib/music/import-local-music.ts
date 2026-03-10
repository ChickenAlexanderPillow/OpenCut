import { BatchCommand } from "@/lib/commands";
import { AddTrackCommand, InsertElementCommand } from "@/lib/commands/timeline";
import type { EditorCore } from "@/core";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import type { Command } from "@/lib/commands/base-command";
import { buildLibraryAudioElement } from "@/lib/timeline/element-utils";

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

function buildLocalMusicSourceUrl({
	root,
	file,
}: {
	root: string;
	file: LocalMusicSourceFile;
}): string {
	const search = new URLSearchParams({
		path: file.relativePath,
		root,
	});
	return `/api/music/local/source?${search.toString()}`;
}

async function resolveLocalMusicDuration({
	sourceUrl,
}: {
	sourceUrl: string;
}): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const audio = new Audio();
		const cleanup = () => {
			audio.removeAttribute("src");
			audio.load();
			audio.remove();
		};

		audio.preload = "metadata";
		audio.addEventListener("loadedmetadata", () => {
			const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
			cleanup();
			resolve(duration);
		});
		audio.addEventListener("error", () => {
			cleanup();
			reject(new Error("Could not load local music metadata"));
		});
		audio.src = sourceUrl;
		audio.load();
	});
}

async function fetchLocalMusicFile({
	sourceUrl,
	file,
}: {
	sourceUrl: string;
	file: LocalMusicSourceFile;
}): Promise<File> {
	const response = await fetch(sourceUrl, { cache: "no-store" });
	if (!response.ok) {
		throw new Error(`Failed to load ${file.name}`);
	}

	const blob = await response.blob();
	return new File([blob], file.name, {
		type: blob.type || `audio/${file.extension}`,
		lastModified: file.modifiedAt ? Date.parse(file.modifiedAt) : Date.now(),
	});
}

async function resolveDurationFromFile({
	file,
}: {
	file: File;
}): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const audio = new Audio();
		const objectUrl = URL.createObjectURL(file);
		const cleanup = () => {
			URL.revokeObjectURL(objectUrl);
			audio.removeAttribute("src");
			audio.load();
			audio.remove();
		};

		audio.preload = "metadata";
		audio.addEventListener("loadedmetadata", () => {
			const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
			cleanup();
			if (duration > 0) {
				resolve(duration);
				return;
			}
			reject(new Error("Could not resolve local music duration"));
		});
		audio.addEventListener("error", () => {
			cleanup();
			reject(new Error("Could not load local music file"));
		});
		audio.src = objectUrl;
		audio.load();
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
}): Promise<{ elementId: string; trackId: string | null }> {
	const activeProject = editor.project.getActive();
	if (!activeProject) {
		throw new Error("No active project");
	}

	const sourceUrl = buildLocalMusicSourceUrl({ root, file });
	let duration: number = TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
	try {
		const resolvedDuration = await resolveLocalMusicDuration({ sourceUrl });
		if (resolvedDuration > 0) {
			duration = resolvedDuration;
		}
	} catch {}

	const commands: Command[] = [];
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

	const element = buildLibraryAudioElement({
		sourceUrl,
		name: file.name,
		duration,
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
	const elementId = insertCmd.getElementId();

	if (
		insertedTrackId &&
		(!Number.isFinite(duration) ||
			duration <= 0 ||
			duration === TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION)
	) {
		void (async () => {
			try {
				const sourceFile = await fetchLocalMusicFile({ sourceUrl, file });
				const resolvedDuration = await resolveDurationFromFile({
					file: sourceFile,
				});
				if (
					!Number.isFinite(resolvedDuration) ||
					resolvedDuration <= 0 ||
					Math.abs(resolvedDuration - duration) < 0.01
				) {
					return;
				}
				editor.timeline.updateElementDuration({
					trackId: insertedTrackId,
					elementId,
					duration: resolvedDuration,
				});
			} catch {}
		})();
	}

	return {
		elementId,
		trackId: insertedTrackId,
	};
}
