import type { BaseNode } from "./nodes/base-node";
import type { RootNode } from "./nodes/root-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { ColorNode } from "./nodes/color-node";
import { ImageNode } from "./nodes/image-node";
import { VideoNode } from "./nodes/video-node";
import type { RendererCapabilities } from "./webgpu-types";

export interface HybridScenePartition {
	supported: boolean;
	reasonIfUnsupported?: string;
	gpuNodes: Array<VideoNode | ImageNode>;
	cpuPreNodes: BaseNode[];
	cpuPostNodes: BaseNode[];
	gpuClearColor?: { r: number; g: number; b: number; a: number };
}

const SUPPORTED_GPU_BLEND_MODES = new Set(["normal", "source-over", undefined]);

function parseCssColorToRgba(
	color: string,
): { r: number; g: number; b: number; a: number } | null {
	const trimmed = color.trim().toLowerCase();
	if (!trimmed || /gradient\(/i.test(trimmed)) return null;

	const hex = trimmed.match(/^#([0-9a-f]{3,8})$/i);
	if (hex) {
		const raw = hex[1];
		if (raw.length === 3 || raw.length === 4) {
			const r = Number.parseInt(raw[0] + raw[0], 16);
			const g = Number.parseInt(raw[1] + raw[1], 16);
			const b = Number.parseInt(raw[2] + raw[2], 16);
			const a =
				raw.length === 4 ? Number.parseInt(raw[3] + raw[3], 16) / 255 : 1;
			return { r: r / 255, g: g / 255, b: b / 255, a };
		}
		if (raw.length === 6 || raw.length === 8) {
			const r = Number.parseInt(raw.slice(0, 2), 16);
			const g = Number.parseInt(raw.slice(2, 4), 16);
			const b = Number.parseInt(raw.slice(4, 6), 16);
			const a =
				raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) / 255 : 1;
			return { r: r / 255, g: g / 255, b: b / 255, a };
		}
	}

	const rgba = trimmed.match(
		/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/,
	);
	if (rgba) {
		const r = Math.max(0, Math.min(255, Number.parseFloat(rgba[1])));
		const g = Math.max(0, Math.min(255, Number.parseFloat(rgba[2])));
		const b = Math.max(0, Math.min(255, Number.parseFloat(rgba[3])));
		const a =
			rgba[4] !== undefined
				? Math.max(0, Math.min(1, Number.parseFloat(rgba[4])))
				: 1;
		return { r: r / 255, g: g / 255, b: b / 255, a };
	}

	return null;
}

export function getRendererCapabilities(): RendererCapabilities {
	if (typeof navigator === "undefined") {
		return {
			webgpuSupported: false,
			reasonIfUnsupported: "Navigator API unavailable",
		};
	}

	if (!navigator.gpu) {
		return {
			webgpuSupported: false,
			reasonIfUnsupported: "WebGPU not available in browser",
		};
	}

	return { webgpuSupported: true };
}

export function splitSceneForHybridPreview({
	rootNode,
}: {
	rootNode: RootNode;
}): HybridScenePartition {
	const children = rootNode.children;
	let gpuClearColor: HybridScenePartition["gpuClearColor"] | undefined;
	let normalizedChildren = children;

	if (children[0] instanceof ColorNode) {
		const parsed = parseCssColorToRgba(children[0].params.color);
		if (parsed) {
			gpuClearColor = parsed;
			normalizedChildren = children.slice(1);
		}
	}

	if (normalizedChildren.some((node) => node instanceof BlurBackgroundNode)) {
		return {
			supported: false,
			reasonIfUnsupported: "Blur background not supported in WebGPU phase 1",
			gpuNodes: [],
			cpuPreNodes: [],
			cpuPostNodes: [],
			gpuClearColor,
		};
	}

	const gpuIndices: number[] = [];
	for (let i = 0; i < normalizedChildren.length; i++) {
		if (
			normalizedChildren[i] instanceof VideoNode ||
			normalizedChildren[i] instanceof ImageNode
		) {
			gpuIndices.push(i);
		}
	}

	if (gpuIndices.length === 0) {
		return {
			supported: false,
			reasonIfUnsupported: "No GPU-eligible nodes in frame",
			gpuNodes: [],
			cpuPreNodes: normalizedChildren,
			cpuPostNodes: [],
			gpuClearColor,
		};
	}

	const firstGpuIndex = gpuIndices[0];
	const lastGpuIndex = gpuIndices[gpuIndices.length - 1];

	// Keep phase-1 ordering safe: no CPU node between GPU nodes.
	for (let i = firstGpuIndex; i <= lastGpuIndex; i++) {
		const node = normalizedChildren[i];
		const isGpuNode = node instanceof VideoNode || node instanceof ImageNode;
		if (!isGpuNode) {
			return {
				supported: false,
				reasonIfUnsupported:
					"Interleaved CPU/GPU visual nodes not supported in phase 1",
				gpuNodes: [],
				cpuPreNodes: [],
				cpuPostNodes: [],
				gpuClearColor,
			};
		}
	}

	const gpuNodes = normalizedChildren
		.slice(firstGpuIndex, lastGpuIndex + 1)
		.filter(
			(node) => node instanceof VideoNode || node instanceof ImageNode,
		) as Array<VideoNode | ImageNode>;

	for (const node of gpuNodes) {
		if (!SUPPORTED_GPU_BLEND_MODES.has(node.params.blendMode)) {
			return {
				supported: false,
				reasonIfUnsupported: `Unsupported blend mode: ${node.params.blendMode}`,
				gpuNodes: [],
				cpuPreNodes: [],
				cpuPostNodes: [],
				gpuClearColor,
			};
		}
	}

	return {
		supported: true,
		gpuNodes,
		cpuPreNodes: normalizedChildren.slice(0, firstGpuIndex),
		cpuPostNodes: normalizedChildren.slice(lastGpuIndex + 1),
		gpuClearColor,
	};
}
