import { useEffect } from "react";
import { toast } from "sonner";
import { useEditor } from "@/hooks/use-editor";
import { processMediaAssets } from "@/lib/media/processing";
import { prepareProjectMediaImport } from "@/lib/media/project-import";
import {
	autoLinkTranscriptAndCaptionsForMediaElement,
} from "@/lib/media/transcript-import";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import { InsertElementCommand } from "@/lib/commands/timeline";
import { BatchCommand } from "@/lib/commands";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { isTypableDOMElement } from "@/utils/browser";
import type { MediaType } from "@/types/assets";

const MEDIA_MIME_PREFIXES: MediaType[] = ["image", "video", "audio"];
const EDITOR_SUBSCRIBE_NONE = [] as const;

function isMediaMimeType({ type }: { type: string }): boolean {
	return MEDIA_MIME_PREFIXES.some((prefix) => type.startsWith(`${prefix}/`));
}

function extractMediaFilesFromClipboard({
	clipboardData,
}: {
	clipboardData: DataTransfer | null;
}): File[] {
	if (!clipboardData?.items) return [];

	const files: File[] = [];
	for (const item of clipboardData.items) {
		if (item.kind !== "file") continue;
		if (!isMediaMimeType({ type: item.type })) continue;

		const file = item.getAsFile();
		if (file) files.push(file);
	}
	return files;
}

export function usePasteMedia() {
	const editor = useEditor({ subscribeTo: EDITOR_SUBSCRIBE_NONE });

	useEffect(() => {
		const handlePaste = async (event: ClipboardEvent) => {
			const activeElement = document.activeElement as HTMLElement;
			if (activeElement && isTypableDOMElement({ element: activeElement })) {
				return;
			}

			const files = extractMediaFilesFromClipboard({
				clipboardData: event.clipboardData,
			});
			if (files.length === 0) return;

			event.preventDefault();

			const activeProject = editor.project.getActive();
			if (!activeProject) return;

			try {
				const processedAssets = await processMediaAssets({ files });
				const startTime = editor.playback.getCurrentTime();

				for (const asset of processedAssets) {
					const { addMediaCmd, assetId } = await prepareProjectMediaImport({
						editor,
						asset,
					});
					const duration =
						asset.duration ?? TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
					const trackType = asset.type === "audio" ? "audio" : "video";

					const element = buildElementFromMedia({
						mediaId: assetId,
						mediaType: asset.type,
						name: asset.name,
						duration,
						startTime,
					});

					const insertCmd = new InsertElementCommand({
						element,
						placement: { mode: "auto", trackType },
					});
					const batchCmd = new BatchCommand([addMediaCmd, insertCmd]);
					editor.command.execute({ command: batchCmd });
					const insertedTrackId = insertCmd.getTrackId();
					if (insertedTrackId && (asset.type === "video" || asset.type === "audio")) {
						void autoLinkTranscriptAndCaptionsForMediaElement({
							editor,
							trackId: insertedTrackId,
							elementId: insertCmd.getElementId(),
						});
					}
				}
			} catch (error) {
				console.error("Failed to paste media:", error);
				toast.error("Failed to paste media");
			}
		};

		window.addEventListener("paste", handlePaste);
		return () => window.removeEventListener("paste", handlePaste);
	}, [editor]);
}
