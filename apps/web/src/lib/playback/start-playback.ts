import type { EditorCore } from "@/core";
import { videoCache } from "@/services/video-cache/service";
import { usePreviewStore } from "@/stores/preview-store";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

const PREPARING_PLAYBACK_REASON = "Preparing playback...";
const PLAYBACK_PREP_TIMEOUT_MS = 900;
const VIDEO_PREWARM_HORIZON_SECONDS = 1.5;
const VIDEO_PREWARM_FRAME_COUNT = 3;
const PREVIEW_VIDEO_PROXY_SCALE_BY_QUALITY = {
	performance: 0.35,
	balanced: 0.5,
	full: 1,
} as const;
const playbackStartTokens = new WeakMap<EditorCore, number>();

function nextPlaybackStartToken(editor: EditorCore): number {
	const next = (playbackStartTokens.get(editor) ?? 0) + 1;
	playbackStartTokens.set(editor, next);
	return next;
}

function getPlaybackStartToken(editor: EditorCore): number {
	return playbackStartTokens.get(editor) ?? 0;
}

function getPreviewableVideoElementsNearTime({
	tracks,
	time,
	horizonSeconds = 0,
}: {
	tracks: TimelineTrack[];
	time: number;
	horizonSeconds?: number;
}): VideoElement[] {
	const active: VideoElement[] = [];
	const horizonEnd = time + Math.max(0, horizonSeconds);
	for (const track of tracks) {
		if (track.type !== "video" || track.hidden) continue;
		for (const element of track.elements) {
			if (element.type !== "video" || element.hidden) continue;
			const elementEnd = element.startTime + element.duration;
			const overlapsWindow = element.startTime < horizonEnd && elementEnd > time;
			if (!overlapsWindow) {
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

export async function prewarmPlaybackVideoFrames({
	editor,
	playhead,
}: {
	editor: EditorCore;
	playhead: number;
}): Promise<void> {
	const tracks = editor.timeline.getTracks();
	const mediaById = new Map(editor.media.getAssets().map((asset) => [asset.id, asset]));
	const playbackQuality = usePreviewStore.getState().playbackQuality;
	const proxyScale = PREVIEW_VIDEO_PROXY_SCALE_BY_QUALITY[playbackQuality];
	const fps = Math.max(1, editor.project.getActive().settings.fps ?? 30);
	const activeVideos = getPreviewableVideoElementsNearTime({
		tracks,
		time: playhead,
		horizonSeconds: VIDEO_PREWARM_HORIZON_SECONDS,
	});
	if (activeVideos.length === 0) return;

	await Promise.allSettled(
		activeVideos.map(async (element) => {
			const mediaAsset = mediaById.get(element.mediaId);
			if (!mediaAsset || mediaAsset.type !== "video") return;
			const effectivePlayhead = Math.max(playhead, element.startTime);
			const sampleTimes = Array.from(
				{ length: VIDEO_PREWARM_FRAME_COUNT },
				(_, index) =>
					resolveVideoFrameTime({
						element,
						playhead: effectivePlayhead + index / fps,
					}),
			);
			await Promise.allSettled(
				sampleTimes.flatMap((time) => [
					videoCache.getFrameAt({
						mediaId: mediaAsset.id,
						file: mediaAsset.file,
						time,
						proxyScale,
					}),
					videoCache.getGPUFrameAt({
						mediaId: mediaAsset.id,
						file: mediaAsset.file,
						time,
						proxyScale,
					}).then((frame) => {
						frame?.frame.close();
						return frame;
					}),
				]),
			);
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
			prewarmPlaybackVideoFrames({ editor, playhead }),
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
