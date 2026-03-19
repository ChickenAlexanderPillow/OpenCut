import type { TimelineTrack } from "@/types/timeline";
import { isGeneratedCaptionElement } from "@/lib/captions/caption-track";

export const PORTRAIT_PREVIEW_SIZE = { width: 1080, height: 1920 } as const;

export type PreviewFormatVariant = "project" | "square" | "portrait";

export function getPreviewCanvasSize({
	projectWidth,
	projectHeight,
	previewFormatVariant,
}: {
	projectWidth: number;
	projectHeight: number;
	previewFormatVariant: PreviewFormatVariant;
}): { width: number; height: number } {
	if (previewFormatVariant === "square") {
		const side = Math.max(1, Math.min(projectWidth, projectHeight));
		return { width: side, height: side };
	}
	if (previewFormatVariant === "portrait") {
		return { ...PORTRAIT_PREVIEW_SIZE };
	}
	return { width: projectWidth, height: projectHeight };
}

export function remapCaptionTransformsForPreviewVariant({
	tracks,
	sourceCanvas,
	previewCanvas,
}: {
	tracks: TimelineTrack[];
	sourceCanvas: { width: number; height: number };
	previewCanvas: { width: number; height: number };
}): TimelineTrack[] {
	const scaleX = previewCanvas.width / Math.max(1, sourceCanvas.width);
	const scaleY = previewCanvas.height / Math.max(1, sourceCanvas.height);
	if (Math.abs(scaleX - 1) < 0.0001 && Math.abs(scaleY - 1) < 0.0001) {
		return tracks;
	}

	return tracks.map((track) => {
		if (track.type !== "text") return track;
		return {
			...track,
			elements: track.elements.map((element) => {
				if (isGeneratedCaptionElement(element)) {
					return element;
				}
				return {
					...element,
					transform: {
						...element.transform,
						position: {
							x: element.transform.position.x * scaleX,
							y: element.transform.position.y * scaleY,
						},
					},
				};
			}),
		};
	});
}
