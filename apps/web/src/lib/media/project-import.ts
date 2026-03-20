import type { EditorCore } from "@/core";
import { AddMediaAssetCommand } from "@/lib/commands/media";
import type { ProcessedMediaAsset } from "@/lib/media/processing";
import { prepareImportedAssetWithTranscript } from "@/lib/media/transcript-import";
import { videoCache } from "@/services/video-cache/service";
import { usePreviewStore, type PreviewPlaybackQuality } from "@/stores/preview-store";

const IMPORT_PREWARM_FRAME_COUNT = 3;
const PREVIEW_VIDEO_PROXY_SCALE_BY_QUALITY: Record<
	PreviewPlaybackQuality,
	number
> = {
	performance: 0.35,
	balanced: 0.5,
	full: 1,
};

async function prewarmImportedVideoPreview({
	asset,
	assetId,
}: {
	asset: ProcessedMediaAsset;
	assetId: string;
}): Promise<void> {
	if (asset.type !== "video") return;
	const fps = Math.max(1, Math.round(asset.fps ?? 30));
	const duration = Math.max(0, asset.duration ?? 0);
	const playbackQuality = usePreviewStore.getState().playbackQuality;
	const proxyScale = PREVIEW_VIDEO_PROXY_SCALE_BY_QUALITY[playbackQuality];
	const sampleTimes = Array.from({ length: IMPORT_PREWARM_FRAME_COUNT }, (_, index) =>
		Math.min(duration, index / fps),
	);

	await Promise.allSettled(
		sampleTimes.flatMap((time) => [
			videoCache.getFrameAt({
				mediaId: assetId,
				file: asset.file,
				time,
				proxyScale,
			}),
			videoCache
				.getGPUFrameAt({
					mediaId: assetId,
					file: asset.file,
					time,
					proxyScale,
				}),
		]),
	);
}

export async function prepareProjectMediaImport({
	editor,
	asset,
	onProgress,
}: {
	editor: EditorCore;
	asset: ProcessedMediaAsset;
	onProgress?: (progress: {
		progress: number;
		step?: string;
		stepProgress?: number;
	}) => void;
}): Promise<{
	addMediaCmd: AddMediaAssetCommand;
	assetId: string;
	importedAsset: ProcessedMediaAsset;
}> {
	const activeProject = editor.project.getActive();
	const addMediaCmd = new AddMediaAssetCommand(
		activeProject.metadata.id,
		asset,
	);
	const assetId = addMediaCmd.getAssetId();
	let prepared;
	try {
		prepared = await prepareImportedAssetWithTranscript({
			project: activeProject,
			asset,
			assetId,
			onProgress,
		});
		onProgress?.({
			progress: 99,
			step: `Preparing preview ${asset.name}`,
			stepProgress: 0,
		});
		await prewarmImportedVideoPreview({ asset, assetId });
		onProgress?.({
			progress: 100,
			step: `Prepared ${asset.name}`,
			stepProgress: 100,
		});
	} catch (error) {
		videoCache.clearVideo({ mediaId: assetId });
		throw error;
	}

	editor.project.setActiveProject({ project: prepared.project });
	editor.save.markDirty();
	addMediaCmd.setAsset({ asset: prepared.asset });

	return {
		addMediaCmd,
		assetId,
		importedAsset: prepared.asset,
	};
}
