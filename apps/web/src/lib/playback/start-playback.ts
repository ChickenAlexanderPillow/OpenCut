import type { EditorCore } from "@/core";
import { buildCompressedCutBoundaryTimes, mapCompressedTimeToSourceTime } from "@/lib/transcript-editor/core";
import { getTranscriptApplied } from "@/lib/transcript-editor/state";
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

function resolvePlaybackPreparationTime({
	editor,
}: {
	editor: EditorCore;
}): number {
	const playhead = editor.playback.getCurrentTime();
	const duration = editor.timeline.getTotalDuration();
	const playbackBounds = editor.playback.getPlaybackBounds({ duration });

	if (
		duration > 0 &&
		(playhead >= playbackBounds.end || playhead < playbackBounds.start)
	) {
		return playbackBounds.start;
	}

	return playhead;
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
	const transcriptCuts = getTranscriptApplied(element)?.removedRanges ?? [];
	const sourceElapsed =
		transcriptCuts.length > 0
			? mapCompressedTimeToSourceTime({
					compressedTime: elapsed,
					cuts: transcriptCuts,
				})
			: elapsed;
	return element.trimStart + sourceElapsed;
}

function buildPrewarmVideoSampleTimes({
	element,
	playhead,
	fps,
}: {
	element: VideoElement;
	playhead: number;
	fps: number;
}): number[] {
	const effectivePlayhead = Math.max(playhead, element.startTime);
	const transcriptCuts = getTranscriptApplied(element)?.removedRanges ?? [];
	const baseCompressedTimes = Array.from(
		{ length: VIDEO_PREWARM_FRAME_COUNT },
		(_, index) =>
			Math.max(
				0,
				Math.min(element.duration, effectivePlayhead + index / fps - element.startTime),
			),
	);
	const boundaryCompressedTimes =
		transcriptCuts.length > 0
			? buildCompressedCutBoundaryTimes({ cuts: transcriptCuts })
					.filter(
						(boundaryTime) =>
							boundaryTime >= baseCompressedTimes[0]! - 1 / fps &&
							boundaryTime <=
								baseCompressedTimes[baseCompressedTimes.length - 1]! +
									VIDEO_PREWARM_HORIZON_SECONDS,
					)
					.flatMap((boundaryTime) => [boundaryTime, boundaryTime + 1 / fps])
			: [];
	const sampleTimes = [...baseCompressedTimes, ...boundaryCompressedTimes].map(
		(compressedElapsed) =>
			resolveVideoFrameTime({
				element,
				playhead: element.startTime + compressedElapsed,
			}),
	);
	return Array.from(
		new Set(sampleTimes.map((time) => time.toFixed(4))),
	).map((time) => Number.parseFloat(time));
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
			const sampleTimes = buildPrewarmVideoSampleTimes({
				element,
				playhead,
				fps,
			});
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
	const playhead = resolvePlaybackPreparationTime({ editor });
	await Promise.race([
		Promise.allSettled([
			editor.audio.primeCurrentTimelineAudio({ playhead }),
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

async function preparePlaybackAudioOnly({
	editor,
}: {
	editor: EditorCore;
}): Promise<void> {
	const playhead = resolvePlaybackPreparationTime({ editor });
	await Promise.race([
		editor.audio.primeCurrentTimelineAudio({ playhead }),
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
	const targetPlayhead = resolvePlaybackPreparationTime({ editor });
	editor.playback.setBlockedReason({ reason: PREPARING_PLAYBACK_REASON });
	try {
		if (targetPlayhead !== editor.playback.getCurrentTime()) {
			editor.playback.seek({ time: targetPlayhead });
		}
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

export async function startPlaybackWithAudioWarmup({
	editor,
}: {
	editor: EditorCore;
}): Promise<void> {
	if (editor.playback.getIsPlaying()) return;
	const blockedReason = editor.playback.getBlockedReason();
	if (blockedReason && blockedReason !== PREPARING_PLAYBACK_REASON) return;
	const token = nextPlaybackStartToken(editor);
	const targetPlayhead = resolvePlaybackPreparationTime({ editor });
	editor.playback.setBlockedReason({ reason: PREPARING_PLAYBACK_REASON });
	try {
		if (targetPlayhead !== editor.playback.getCurrentTime()) {
			editor.playback.seek({ time: targetPlayhead });
		}
		await preparePlaybackAudioOnly({ editor });
		if (token !== getPlaybackStartToken(editor)) return;
		editor.playback.setBlockedReason({ reason: null });
		editor.playback.play();
	} catch (error) {
		if (token !== getPlaybackStartToken(editor)) return;
		console.warn("Failed to prepare audio-priority playback:", error);
		editor.playback.setBlockedReason({ reason: null });
		editor.playback.play();
	}
}

export { PREPARING_PLAYBACK_REASON, resolvePlaybackPreparationTime };
