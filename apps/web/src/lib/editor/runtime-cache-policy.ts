import type { EditorCore } from "@/core";
import { videoCache } from "@/services/video-cache/service";
import { clearTranscriptTimelineSnapshotCache } from "@/lib/transcript-editor/snapshot";
import { clearSmartCutAnalysisCache } from "@/lib/editing/smart-cut";
import { clearImageSourceCache } from "@/services/renderer/nodes/image-node";
import { clearStickerSourceCache } from "@/services/renderer/nodes/sticker-node";
import { clearWaveformPeaksCache } from "@/lib/media/waveform-cache";
import {
	clearFontAtlasCache,
	clearLoadedGoogleFontsCache,
} from "@/lib/fonts/google-fonts";
import { clearLoadedLocalFontsCache } from "@/lib/fonts/local-fonts";

export type RuntimeCachePolicy =
	| "project-exit"
	| "project-switch"
	| "memory-soft"
	| "memory-hard";

export function clearRuntimeCaches({
	editor,
	policy,
}: {
	editor: EditorCore;
	policy: RuntimeCachePolicy;
}): void {
	videoCache.clearAll();
	clearWaveformPeaksCache();
	clearSmartCutAnalysisCache();
	clearTranscriptTimelineSnapshotCache();
	clearImageSourceCache();
	clearStickerSourceCache();
	editor.audio.clearCachedTimelineAudio({
		preserveDirty: policy === "memory-soft" || policy === "memory-hard",
	});

	if (policy === "memory-hard") {
		clearFontAtlasCache();
		clearLoadedGoogleFontsCache();
		clearLoadedLocalFontsCache();
	}

	if (policy === "project-switch" || policy === "project-exit") {
		editor.playback.pause();
		editor.command.clear();
		editor.selection.clearSelection();
		editor.renderer.setRenderTree({ renderTree: null });
		editor.media.clearAllAssets();
		editor.scenes.clearScenes();
	}
}
