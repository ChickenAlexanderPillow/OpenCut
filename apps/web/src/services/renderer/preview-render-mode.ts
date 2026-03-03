import type { PreviewRendererMode } from "./webgpu-types";

export type PreviewRenderBackend = "webgpu" | "canvas2d";

export function resolvePreviewRenderBackend({
	mode,
	runtimeFallbackReason,
}: {
	mode: PreviewRendererMode;
	runtimeFallbackReason: string | null;
}): PreviewRenderBackend {
	if (mode === "canvas2d") return "canvas2d";
	if (mode === "webgpu") return "webgpu";
	return runtimeFallbackReason ? "canvas2d" : "webgpu";
}

