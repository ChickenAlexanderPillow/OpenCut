import type { EditorCore } from "@/core";
import { AddMediaAssetCommand } from "@/lib/commands/media";
import type { ProcessedMediaAsset } from "@/lib/media/processing";
import { prepareImportedAssetWithTranscript } from "@/lib/media/transcript-import";

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
	const prepared = await prepareImportedAssetWithTranscript({
		project: activeProject,
		asset,
		assetId: addMediaCmd.getAssetId(),
		onProgress,
	});

	editor.project.setActiveProject({ project: prepared.project });
	editor.save.markDirty();
	addMediaCmd.setAsset({ asset: prepared.asset });

	return {
		addMediaCmd,
		assetId: addMediaCmd.getAssetId(),
		importedAsset: prepared.asset,
	};
}
