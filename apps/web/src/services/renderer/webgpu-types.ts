import type { BlendMode } from "@/types/rendering";

export interface WebGPUVisualDrawData {
	source: GPUCopyExternalImageSource;
	sourceWidth: number;
	sourceHeight: number;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	opacity: number;
	blendMode?: BlendMode;
}

export type PreviewRendererMode = "auto" | "webgpu" | "canvas2d";

export interface RendererCapabilities {
	webgpuSupported: boolean;
	reasonIfUnsupported?: string;
}
