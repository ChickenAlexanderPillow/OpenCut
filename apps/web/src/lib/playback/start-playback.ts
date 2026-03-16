import type { EditorCore } from "@/core";
import { videoCache } from "@/services/video-cache/service";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

const PREPARING_PLAYBACK_REASON = "Preparing playback...";
const PLAYBACK_PREP_TIMEOUT_MS = 700;
const playbackStartTokens = new WeakMap<EditorCore, number>();

function nextPlaybackStartToken(editor: EditorCore): number {
	const next = (playbackStartTokens.get(editor) ?? 0) + 1;
	playbackStartTokens.set(editor, next);
	return next;
}

function getPlaybackStartToken(editor: EditorCore): number {
	return playbackStartTokens.get(editor) ?? 0;
}

function getPreviewableVideoElementsAtTime({
	tracks,
	time,
}: {
	tracks: TimelineTrack[];
	time: number;
}): VideoElement[] {
	const active: VideoElement[] = [];
	for (const track of tracks) {
		if (track.type !== "video" || track.hidden) continue;
		for (const element of track.elements) {
			if (element.type !== "video" || element.hidden) continue;
			if (time < element.startTime || time >= element.startTime + element.duration) {
				continue;
			}
			active.push(element);
		}
	}
	return active;
}

function resolveVideoFrameTime({
	element,
	playhead,
}: {
	element: VideoElement;
	playhead: number;
}): number {
	const elapsed = Math.max(0, Math.min(element.duration, playhead - element.startTime));
	return element.trimStart + elapsed;
}

async function prewarmPreviewVideoFrames({
	editor,
	playhead,
}: {
	editor: EditorCore;
	playhead: number;
}): Promise<void> {
	const tracks = editor.timeline.getTracks();
	const mediaById = new Map(editor.media.getAssets().map((asset) => [asset.id, asset]));
	const activeVideos = getPreviewableVideoElementsAtTime({ tracks, time: playhead });
	if (activeVideos.length === 0) return;

	await Promise.allSettled(
		activeVideos.map(async (element) => {
			const mediaAsset = mediaById.get(element.mediaId);
			if (!mediaAsset || mediaAsset.type !== "video") return;
			await videoCache.getFrameAt({
				mediaId: mediaAsset.id,
				file: mediaAsset.file,
				time: resolveVideoFrameTime({
					element,
					playhead,
				}),
			});
		}),
	);
}

async function preparePlayback({
	editor,
}: {
	editor: EditorCore;
}): Promise<void> {
	const playhead = editor.playback.getCurrentTime();
	await Promise.race([
		Promise.allSettled([
			editor.audio.primeCurrentTimelineAudio(),
			prewarmPreviewVideoFrames({ editor, playhead }),
		]).then(() => undefined),
		new Promise<void>((resolve) => {
			if (typeof window === "undefined") {
				resolve();
				return;
			}
			window.setTimeout(resolve, PLAYBACK_PREP_TIMEOUT_MS);
		}),
	]);
}

export function cancelPreparedPlaybackStart({
	editor,
}: {
	editor: EditorCore;
}): void {
	nextPlaybackStartToken(editor);
	if (editor.playback.getBlockedReason() === PREPARING_PLAYBACK_REASON) {
		editor.playback.setBlockedReason({ reason: null });
	}
}

export async function startPlaybackWhenReady({
	editor,
}: {
	editor: EditorCore;
}): Promise<void> {
	if (editor.playback.getIsPlaying()) return;
	const blockedReason = editor.playback.getBlockedReason();
	if (blockedReason && blockedReason !== PREPARING_PLAYBACK_REASON) return;
	const token = nextPlaybackStartToken(editor);
	editor.playback.setBlockedReason({ reason: PREPARING_PLAYBACK_REASON });
	try {
		await preparePlayback({ editor });
		if (token !== getPlaybackStartToken(editor)) return;
		editor.playback.setBlockedReason({ reason: null });
		editor.playback.play();
	} catch (error) {
		if (token !== getPlaybackStartToken(editor)) return;
		console.warn("Failed to prepare synchronized playback:", error);
		editor.playback.setBlockedReason({ reason: null });
		editor.playback.play();
	}
}

export { PREPARING_PLAYBACK_REASON };
