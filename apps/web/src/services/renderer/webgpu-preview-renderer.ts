import type { BaseNode } from "./nodes/base-node";
import type { RootNode } from "./nodes/root-node";
import type { ImageNode } from "./nodes/image-node";
import type { VideoNode } from "./nodes/video-node";
import {
	getRendererCapabilities,
	splitSceneForHybridPreview,
	type HybridScenePartition,
} from "./scene-partition";
import type {
	RendererCapabilities,
	WebGPUVisualDrawData,
} from "./webgpu-types";
import type { CanvasRenderer } from "./canvas-renderer";

type GPUState = {
	device: GPUDevice;
	context: GPUCanvasContext | null;
	configuredCanvas: HTMLCanvasElement | null;
	format: GPUTextureFormat;
	pipeline: GPURenderPipeline;
	pipelinePlus: GPURenderPipeline;
	externalPipeline: GPURenderPipeline;
	externalPipelinePlus: GPURenderPipeline;
	sampler: GPUSampler;
};

type CachedTexture = {
	texture: GPUTexture;
	view: GPUTextureView;
	width: number;
	height: number;
	lastAccessAt: number;
	estimatedBytes: number;
	isStaticUploaded: boolean;
};

function mapBlendMode(mode: WebGPUVisualDrawData["blendMode"]): GPUBlendState {
	if (mode === "plus-lighter") {
		return {
			color: {
				srcFactor: "one",
				dstFactor: "one",
				operation: "add",
			},
			alpha: {
				srcFactor: "one",
				dstFactor: "one",
				operation: "add",
			},
		};
	}

	// source-over
	return {
		color: {
			srcFactor: "src-alpha",
			dstFactor: "one-minus-src-alpha",
			operation: "add",
		},
		alpha: {
			srcFactor: "one",
			dstFactor: "one-minus-src-alpha",
			operation: "add",
		},
	};
}

export class WebGPUPreviewRenderer {
	private width: number;
	private height: number;
	private fps: number;
	private state: GPUState | null = null;
	private initPromise: Promise<void> | null = null;
	private deviceLost = false;
	private initErrorReason: string | null = null;
	private textureCache = new Map<object, CachedTexture>();
	private textureCacheBytes = 0;
	private cpuPreCanvas: HTMLCanvasElement | null = null;
	private uniformBufferPool: GPUBuffer[] = [];
	private vertexBufferPool: GPUBuffer[] = [];
	private cachedPartitionRoot: RootNode | null = null;
	private cachedPartition: HybridScenePartition | null = null;
	private pendingVideoFramesToClose: VideoFrame[] = [];
	private closeVideoFramesTaskInFlight = false;
	private solidColorSourceCache = new Map<
		string,
		HTMLCanvasElement | OffscreenCanvas
	>();
	private static readonly MAX_TEXTURE_CACHE = 10;
	private static readonly MAX_TEXTURE_CACHE_BYTES = 96 * 1024 * 1024; // 96MB
	private static readonly TEXTURE_IDLE_TTL_MS = 10_000;
	private static readonly MOTION_BLUR_TRAIL_OPACITY_FACTOR = 0.52;

	private getResolvedScissorRect({
		clipRect,
	}: {
		clipRect?: WebGPUVisualDrawData["clipRect"];
	}):
		| {
				x: number;
				y: number;
				width: number;
				height: number;
		  }
		| null {
		const left = Math.max(0, Math.floor(clipRect?.x ?? 0));
		const top = Math.max(0, Math.floor(clipRect?.y ?? 0));
		const right = Math.min(
			this.width,
			Math.ceil((clipRect?.x ?? 0) + (clipRect?.width ?? this.width)),
		);
		const bottom = Math.min(
			this.height,
			Math.ceil((clipRect?.y ?? 0) + (clipRect?.height ?? this.height)),
		);
		if (right <= left || bottom <= top) {
			return null;
		}
		return {
			x: left,
			y: top,
			width: right - left,
			height: bottom - top,
		};
	}

	constructor({
		width,
		height,
		fps,
	}: {
		width: number;
		height: number;
		fps: number;
	}) {
		this.width = width;
		this.height = height;
		this.fps = fps;
	}

	getCapabilities(): RendererCapabilities {
		return getRendererCapabilities();
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;
		if (
			this.state?.context &&
			this.state.configuredCanvas &&
			(this.state.configuredCanvas.width !== width ||
				this.state.configuredCanvas.height !== height)
		) {
			this.state.configuredCanvas.width = width;
			this.state.configuredCanvas.height = height;
			this.state.context.configure({
				device: this.state.device,
				format: this.state.format,
				alphaMode: "premultiplied",
			});
		}
	}

	dispose(): void {
		this.destroyAllTextures();
		this.destroyBufferPool();
		this.state = null;
		this.initPromise = null;
		this.deviceLost = false;
		this.initErrorReason = null;
		this.textureCache = new Map<object, CachedTexture>();
		this.cpuPreCanvas = null;
		this.cachedPartitionRoot = null;
		this.cachedPartition = null;
		this.pendingVideoFramesToClose = [];
		this.closeVideoFramesTaskInFlight = false;
		this.solidColorSourceCache.clear();
	}

	private getSolidColorSource({ color }: { color: string }): {
		source: HTMLCanvasElement | OffscreenCanvas;
		width: number;
		height: number;
	} | null {
		const cached = this.solidColorSourceCache.get(color);
		if (cached) {
			return { source: cached, width: 1, height: 1 };
		}
		if (typeof document !== "undefined") {
			const canvas = document.createElement("canvas");
			canvas.width = 1;
			canvas.height = 1;
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			ctx.fillStyle = color;
			ctx.fillRect(0, 0, 1, 1);
			this.solidColorSourceCache.set(color, canvas);
			return { source: canvas, width: 1, height: 1 };
		}
		if (typeof OffscreenCanvas !== "undefined") {
			const canvas = new OffscreenCanvas(1, 1);
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			ctx.fillStyle = color;
			ctx.fillRect(0, 0, 1, 1);
			this.solidColorSourceCache.set(color, canvas);
			return { source: canvas, width: 1, height: 1 };
		}
		return null;
	}

	private flushPendingVideoFrames(): void {
		if (this.pendingVideoFramesToClose.length === 0) return;
		const frames = this.pendingVideoFramesToClose.splice(
			0,
			this.pendingVideoFramesToClose.length,
		);
		for (const frame of frames) {
			try {
				frame.close();
			} catch {}
		}
	}

	private schedulePendingVideoFrameClose({
		device,
	}: {
		device: GPUDevice;
	}): void {
		if (this.closeVideoFramesTaskInFlight) return;
		if (this.pendingVideoFramesToClose.length === 0) return;

		this.closeVideoFramesTaskInFlight = true;
		const finalize = () => {
			this.flushPendingVideoFrames();
			this.closeVideoFramesTaskInFlight = false;
			if (this.pendingVideoFramesToClose.length > 0) {
				this.schedulePendingVideoFrameClose({ device });
			}
		};

		if (typeof device.queue.onSubmittedWorkDone === "function") {
			void device.queue
				.onSubmittedWorkDone()
				.catch(() => {})
				.finally(finalize);
			return;
		}

		setTimeout(finalize, 0);
	}

	private getPartition({
		rootNode,
	}: {
		rootNode: RootNode;
	}): HybridScenePartition {
		if (this.cachedPartitionRoot === rootNode && this.cachedPartition) {
			return this.cachedPartition;
		}
		const partition = splitSceneForHybridPreview({ rootNode });
		this.cachedPartitionRoot = rootNode;
		this.cachedPartition = partition;
		return partition;
	}

	private destroyAllTextures(): void {
		for (const { texture } of this.textureCache.values()) {
			try {
				texture.destroy();
			} catch {}
		}
		this.textureCache.clear();
		this.textureCacheBytes = 0;
	}

	private destroyBufferPool(): void {
		for (const buffer of this.uniformBufferPool) {
			try {
				buffer.destroy();
			} catch {}
		}
		for (const buffer of this.vertexBufferPool) {
			try {
				buffer.destroy();
			} catch {}
		}
		this.uniformBufferPool = [];
		this.vertexBufferPool = [];
	}

	private destroyTextureCacheEntry({ key }: { key: object }): void {
		const entry = this.textureCache.get(key);
		if (!entry) return;
		try {
			entry.texture.destroy();
		} catch {}
		this.textureCache.delete(key);
		this.textureCacheBytes = Math.max(
			0,
			this.textureCacheBytes - entry.estimatedBytes,
		);
	}

	private pruneIdleTextures(): void {
		const now = Date.now();
		for (const [key, entry] of this.textureCache.entries()) {
			if (
				now - entry.lastAccessAt <=
				WebGPUPreviewRenderer.TEXTURE_IDLE_TTL_MS
			) {
				continue;
			}
			this.destroyTextureCacheEntry({ key });
		}
	}

	private evictTexturesIfNeeded({
		preserveKey,
	}: {
		preserveKey?: object;
	}): void {
		const shouldEvictByCount =
			this.textureCache.size >= WebGPUPreviewRenderer.MAX_TEXTURE_CACHE;
		const shouldEvictByBytes =
			this.textureCacheBytes > WebGPUPreviewRenderer.MAX_TEXTURE_CACHE_BYTES;
		if (!shouldEvictByCount && !shouldEvictByBytes) return;

		const entries = Array.from(this.textureCache.entries())
			.filter(([key]) => key !== preserveKey)
			.sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
		for (const [evictKey] of entries) {
			if (
				this.textureCache.size < WebGPUPreviewRenderer.MAX_TEXTURE_CACHE &&
				this.textureCacheBytes <= WebGPUPreviewRenderer.MAX_TEXTURE_CACHE_BYTES
			) {
				break;
			}
			this.destroyTextureCacheEntry({ key: evictKey });
		}
	}

	private getErrorMessage(error: unknown): string {
		if (error instanceof Error && error.message) return error.message;
		return "Unknown WebGPU initialization error";
	}

	private async ensureInitialized(): Promise<boolean> {
		if (this.deviceLost) return false;
		if (this.state) return true;

		if (!this.initPromise) {
			this.initPromise = (async () => {
				this.initErrorReason = null;

				if (typeof window !== "undefined" && !window.isSecureContext) {
					throw new Error(
						"WebGPU requires secure context (https or localhost)",
					);
				}

				const gpu = navigator.gpu;
				if (!gpu) {
					throw new Error("WebGPU unavailable");
				}

				const adapter =
					(await gpu.requestAdapter({
						powerPreference: "high-performance",
					})) ?? (await gpu.requestAdapter());
				if (!adapter) {
					throw new Error("No compatible WebGPU adapter found");
				}

				const device = await adapter.requestDevice();

				const format = gpu.getPreferredCanvasFormat();

				const shader = device.createShaderModule({
					code: `
struct VertexOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct Params {
  opacity: f32,
};

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs(@location(0) inPos: vec2<f32>, @location(1) inUv: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  out.pos = vec4<f32>(inPos, 0.0, 1.0);
  out.uv = inUv;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let sampled = textureSample(tex, samp, in.uv);
  return vec4<f32>(sampled.rgb, sampled.a * params.opacity);
}
`,
				});

				const pipeline = device.createRenderPipeline({
					layout: "auto",
					vertex: {
						module: shader,
						entryPoint: "vs",
						buffers: [
							{
								arrayStride: 16,
								attributes: [
									{ shaderLocation: 0, offset: 0, format: "float32x2" },
									{ shaderLocation: 1, offset: 8, format: "float32x2" },
								],
							},
						],
					},
					fragment: {
						module: shader,
						entryPoint: "fs",
						targets: [
							{
								format,
								blend: mapBlendMode("normal"),
							},
						],
					},
					primitive: {
						topology: "triangle-list",
					},
				});
				const pipelinePlus = device.createRenderPipeline({
					layout: "auto",
					vertex: {
						module: shader,
						entryPoint: "vs",
						buffers: [
							{
								arrayStride: 16,
								attributes: [
									{ shaderLocation: 0, offset: 0, format: "float32x2" },
									{ shaderLocation: 1, offset: 8, format: "float32x2" },
								],
							},
						],
					},
					fragment: {
						module: shader,
						entryPoint: "fs",
						targets: [
							{
								format,
								blend: mapBlendMode("plus-lighter"),
							},
						],
					},
					primitive: {
						topology: "triangle-list",
					},
				});
				const externalShader = device.createShaderModule({
					code: `
struct VertexOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct Params {
  opacity: f32,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs(@location(0) inPos: vec2<f32>, @location(1) inUv: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  out.pos = vec4<f32>(inPos, 0.0, 1.0);
  out.uv = inUv;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let sampled = textureSampleBaseClampToEdge(tex, samp, in.uv);
  return vec4<f32>(sampled.rgb, sampled.a * params.opacity);
}
`,
				});
				const externalPipeline = device.createRenderPipeline({
					layout: "auto",
					vertex: {
						module: externalShader,
						entryPoint: "vs",
						buffers: [
							{
								arrayStride: 16,
								attributes: [
									{ shaderLocation: 0, offset: 0, format: "float32x2" },
									{ shaderLocation: 1, offset: 8, format: "float32x2" },
								],
							},
						],
					},
					fragment: {
						module: externalShader,
						entryPoint: "fs",
						targets: [
							{
								format,
								blend: mapBlendMode("normal"),
							},
						],
					},
					primitive: {
						topology: "triangle-list",
					},
				});
				const externalPipelinePlus = device.createRenderPipeline({
					layout: "auto",
					vertex: {
						module: externalShader,
						entryPoint: "vs",
						buffers: [
							{
								arrayStride: 16,
								attributes: [
									{ shaderLocation: 0, offset: 0, format: "float32x2" },
									{ shaderLocation: 1, offset: 8, format: "float32x2" },
								],
							},
						],
					},
					fragment: {
						module: externalShader,
						entryPoint: "fs",
						targets: [
							{
								format,
								blend: mapBlendMode("plus-lighter"),
							},
						],
					},
					primitive: {
						topology: "triangle-list",
					},
				});

				const sampler = device.createSampler({
					magFilter: "linear",
					minFilter: "linear",
				});

				device.lost.then((info) => {
					this.deviceLost = true;
					this.state = null;
					this.initErrorReason = `WebGPU device lost${
						info?.message ? `: ${info.message}` : ""
					}`;
				});

				this.state = {
					device,
					context: null,
					configuredCanvas: null,
					format,
					pipeline,
					pipelinePlus,
					externalPipeline,
					externalPipelinePlus,
					sampler,
				};
			})();
		}

		try {
			await this.initPromise;
			return !!this.state;
		} catch (error) {
			this.state = null;
			this.initErrorReason = this.getErrorMessage(error);
			return false;
		} finally {
			if (!this.state) {
				this.initPromise = null;
			}
		}
	}

	private ensurePresentationContext({
		targetCanvas,
	}: {
		targetCanvas: HTMLCanvasElement;
	}): boolean {
		if (!this.state) return false;
		if (
			this.state.context &&
			this.state.configuredCanvas === targetCanvas &&
			targetCanvas.width === this.width &&
			targetCanvas.height === this.height
		) {
			return true;
		}

		targetCanvas.width = this.width;
		targetCanvas.height = this.height;
		const context = targetCanvas.getContext(
			"webgpu",
		) as GPUCanvasContext | null;
		if (!context) {
			this.initErrorReason = "Canvas WebGPU context unavailable";
			return false;
		}

		try {
			context.configure({
				device: this.state.device,
				format: this.state.format,
				alphaMode: "premultiplied",
			});
		} catch (error) {
			this.initErrorReason = `WebGPU context configure failed: ${this.getErrorMessage(error)}`;
			return false;
		}

		this.state.context = context;
		this.state.configuredCanvas = targetCanvas;
		return true;
	}

	private async collectGPUDrawData({
		nodes,
		time,
	}: {
		nodes: Array<VideoNode | ImageNode>;
		time: number;
	}): Promise<WebGPUVisualDrawData[]> {
		const drawData = await Promise.all(
			nodes.map((node) =>
				node.getWebGPUDrawData({
					time,
					rendererWidth: this.width,
					rendererHeight: this.height,
				}),
			),
		);
		return drawData.flatMap((draws) => draws ?? []);
	}

	private async renderNodesCpu({
		nodes,
		time,
		targetCanvas,
		fps,
		clear,
	}: {
		nodes: BaseNode[];
		time: number;
		targetCanvas: HTMLCanvasElement;
		fps: number;
		clear: boolean;
	}) {
		const targetCtx = targetCanvas.getContext("2d");
		if (!targetCtx) return;
		if (clear) {
			targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
		}

		const rendererLike = {
			width: this.width,
			height: this.height,
			fps,
			context: targetCtx,
			canvas: targetCanvas,
		} as unknown as CanvasRenderer;

		for (const node of nodes) {
			await node.render({ renderer: rendererLike, time });
		}
	}

	private createQuadVertices({
		draw,
	}: {
		draw: WebGPUVisualDrawData;
	}): Float32Array<ArrayBuffer> {
		const cx = draw.x + draw.width / 2;
		const cy = draw.y + draw.height / 2;
		const theta = (draw.rotation * Math.PI) / 180;
		const cos = Math.cos(theta);
		const sin = Math.sin(theta);

		const corners = [
			{ x: -draw.width / 2, y: -draw.height / 2, u: 0, v: 0 },
			{ x: draw.width / 2, y: -draw.height / 2, u: 1, v: 0 },
			{ x: draw.width / 2, y: draw.height / 2, u: 1, v: 1 },
			{ x: -draw.width / 2, y: draw.height / 2, u: 0, v: 1 },
		].map((corner) => {
			const rx = corner.x * cos - corner.y * sin + cx;
			const ry = corner.x * sin + corner.y * cos + cy;
			return {
				x: (rx / this.width) * 2 - 1,
				y: 1 - (ry / this.height) * 2,
				u: corner.u,
				v: corner.v,
			};
		});

		const indices = [0, 1, 2, 0, 2, 3];
		const data: number[] = [];
		for (const idx of indices) {
			const c = corners[idx];
			data.push(c.x, c.y, c.u, c.v);
		}
		const vertexBuffer = new ArrayBuffer(
			data.length * Float32Array.BYTES_PER_ELEMENT,
		);
		const vertices = new Float32Array(vertexBuffer);
		vertices.set(data);
		return vertices;
	}

	private drawSplitDividerOverlays({
		draws,
		overlayCanvas,
	}: {
		draws: WebGPUVisualDrawData[];
		overlayCanvas: HTMLCanvasElement;
	}) {
		const overlayCtx = overlayCanvas.getContext("2d");
		if (!overlayCtx) return;
		const dividerDraws = draws.filter(
			(draw) =>
				draw.solidColor === "#000000" &&
				!draw.source &&
				typeof draw.x === "number" &&
				typeof draw.y === "number" &&
				typeof draw.width === "number" &&
				typeof draw.height === "number" &&
				draw.width > 0 &&
				draw.height > 0,
		);
		if (dividerDraws.length === 0) return;
		overlayCtx.save();
		overlayCtx.globalCompositeOperation = "source-over";
		overlayCtx.globalAlpha = 1;
		overlayCtx.fillStyle = "#000000";
		for (const draw of dividerDraws) {
			overlayCtx.fillRect(draw.x, draw.y, draw.width, draw.height);
		}
		overlayCtx.restore();
	}

	private expandDrawListWithMotionBlur({
		drawList,
	}: {
		drawList: WebGPUVisualDrawData[];
	}): WebGPUVisualDrawData[] {
		const expanded: WebGPUVisualDrawData[] = [];
		for (const draw of drawList) {
			const blur = draw.motionBlur;
			if (!blur || blur.samples <= 1) {
				expanded.push(draw);
				continue;
			}

			const sampleCount = Math.max(2, blur.samples);
			const trailSampleCount = Math.max(1, sampleCount - 1);
			const trailOpacity =
				draw.opacity * WebGPUPreviewRenderer.MOTION_BLUR_TRAIL_OPACITY_FACTOR;
			const trailWeights = Array.from(
				{ length: trailSampleCount },
				(_, index) => {
					const progress = (index + 1) / (trailSampleCount + 1);
					return (1 - progress) ** 1.15;
				},
			);
			const totalTrailWeight = Math.max(
				1e-6,
				trailWeights.reduce((sum, weight) => sum + weight, 0),
			);

			// Draw trails first so the current frame can remain full-opacity on top.
			for (let sampleIndex = 0; sampleIndex < trailSampleCount; sampleIndex++) {
				const progress = (sampleIndex + 1) / (trailSampleCount + 1);
				const trail = 1 - progress;
				const sampleWeight = trailWeights[sampleIndex] ?? 0;
				const sampleScale = Math.max(1e-6, 1 - blur.deltaScaleRatio * trail);
				const sampleWidth = draw.width * sampleScale;
				const sampleHeight = draw.height * sampleScale;
				const sampleCenterX = draw.x + draw.width / 2 - blur.deltaX * trail;
				const sampleCenterY = draw.y + draw.height / 2 - blur.deltaY * trail;
				expanded.push({
					...draw,
					x: sampleCenterX - sampleWidth / 2,
					y: sampleCenterY - sampleHeight / 2,
					width: sampleWidth,
					height: sampleHeight,
					rotation: draw.rotation - blur.deltaRotation * trail,
					opacity: trailOpacity * (sampleWeight / totalTrailWeight),
					blendMode: "plus-lighter",
				});
			}

			expanded.push({
				...draw,
				opacity: draw.opacity,
			});
		}
		return expanded;
	}

	private getOrCreateTexture({
		source,
		sourceWidth,
		sourceHeight,
		device,
	}: {
		source: GPUCopyExternalImageSource;
		sourceWidth: number;
		sourceHeight: number;
		device: GPUDevice;
	}): CachedTexture {
		const width = Math.max(1, Math.round(sourceWidth));
		const height = Math.max(1, Math.round(sourceHeight));
		const key = source as object;
		const cached = this.textureCache.get(key);
		if (cached && cached.width === width && cached.height === height) {
			cached.lastAccessAt = Date.now();
			return cached;
		}
		if (cached) {
			this.destroyTextureCacheEntry({ key });
		}
		this.evictTexturesIfNeeded({ preserveKey: key });

		const texture = device.createTexture({
			size: { width, height },
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.RENDER_ATTACHMENT,
		});
		const estimatedBytes = width * height * 4;
		const entry: CachedTexture = {
			texture,
			view: texture.createView(),
			width,
			height,
			lastAccessAt: Date.now(),
			estimatedBytes,
			isStaticUploaded: false,
		};
		this.textureCache.set(key, entry);
		this.textureCacheBytes += estimatedBytes;
		this.evictTexturesIfNeeded({ preserveKey: key });
		return entry;
	}

	private sourceNeedsUploadEachFrame({
		source,
	}: {
		source: GPUCopyExternalImageSource;
	}): boolean {
		if (
			typeof HTMLImageElement !== "undefined" &&
			source instanceof HTMLImageElement
		) {
			return false;
		}
		if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
			return false;
		}
		return true;
	}

	private ensureBufferPool({
		device,
		drawCount,
	}: {
		device: GPUDevice;
		drawCount: number;
	}): void {
		for (let i = this.uniformBufferPool.length; i < drawCount; i++) {
			this.uniformBufferPool.push(
				device.createBuffer({
					size: 16,
					usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				}),
			);
		}
		for (let i = this.vertexBufferPool.length; i < drawCount; i++) {
			this.vertexBufferPool.push(
				device.createBuffer({
					size: 6 * 4 * 4,
					usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
				}),
			);
		}
	}

	async renderToCanvas({
		rootNode,
		time,
		targetCanvas,
		overlayCanvas,
	}: {
		rootNode: RootNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
		overlayCanvas?: HTMLCanvasElement;
	}): Promise<{
		usedWebGPU: boolean;
		reasonIfFallback?: string;
		shouldDisableWebGPU?: boolean;
		dividerRects?: Array<{
			x: number;
			y: number;
			width: number;
			height: number;
		}>;
		stats?: {
			externalVideoFrames: number;
			copiedTextureUploads: number;
			totalDraws: number;
		};
	}> {
		const supported = await this.ensureInitialized();
		if (!supported || !this.state) {
			return {
				usedWebGPU: false,
				reasonIfFallback:
					this.initErrorReason ?? "WebGPU initialization failed",
				shouldDisableWebGPU: true,
				dividerRects: [],
			};
		}
		if (!this.ensurePresentationContext({ targetCanvas })) {
			return {
				usedWebGPU: false,
				reasonIfFallback:
					this.initErrorReason ?? "WebGPU presentation setup failed",
				shouldDisableWebGPU: true,
				dividerRects: [],
			};
		}
		this.pruneIdleTextures();

		const partition = this.getPartition({ rootNode });
		if (!partition.supported) {
			return {
				usedWebGPU: false,
				reasonIfFallback: partition.reasonIfUnsupported,
				shouldDisableWebGPU: false,
				dividerRects: [],
			};
		}

		const draws = await this.collectGPUDrawData({
			nodes: partition.gpuNodes,
			time,
		});
		if (partition.gpuNodes.length > 0 && draws.length === 0) {
			return {
				usedWebGPU: false,
				reasonIfFallback: "No GPU-eligible frames available at current time",
				shouldDisableWebGPU: false,
				dividerRects: [],
			};
		}

		const {
			device,
			context,
			pipeline,
			pipelinePlus,
			externalPipeline,
			externalPipelinePlus,
			sampler,
		} = this.state;
		if (!context) {
			return {
				usedWebGPU: false,
				reasonIfFallback: "WebGPU context unavailable",
				shouldDisableWebGPU: true,
				dividerRects: [],
			};
		}
		const dividerRects = draws
			.filter(
				(draw) =>
					draw.solidColor === "#000000" &&
					!draw.source &&
					typeof draw.x === "number" &&
					typeof draw.y === "number" &&
					typeof draw.width === "number" &&
					typeof draw.height === "number" &&
					draw.width > 0 &&
					draw.height > 0,
			)
			.map((draw) => ({
				x: draw.x,
				y: draw.y,
				width: draw.width,
				height: draw.height,
			}));
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: context.getCurrentTexture().createView(),
					clearValue: partition.gpuClearColor ?? { r: 0, g: 0, b: 0, a: 0 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.setScissorRect(0, 0, this.width, this.height);

		const drawList: WebGPUVisualDrawData[] = [];
		if (partition.cpuPreNodes.length > 0) {
			const cpuPreCanvas =
				this.cpuPreCanvas ?? document.createElement("canvas");
			this.cpuPreCanvas = cpuPreCanvas;
			cpuPreCanvas.width = this.width;
			cpuPreCanvas.height = this.height;
			await this.renderNodesCpu({
				nodes: partition.cpuPreNodes,
				time,
				targetCanvas: cpuPreCanvas,
				fps: this.fps,
				clear: true,
			});
			drawList.push({
				source: cpuPreCanvas as GPUCopyExternalImageSource,
				sourceWidth: this.width,
				sourceHeight: this.height,
				x: 0,
				y: 0,
				width: this.width,
				height: this.height,
				rotation: 0,
				opacity: 1,
				blendMode: "normal",
			});
		}
		drawList.push(...draws);
		const effectiveDrawList = this.expandDrawListWithMotionBlur({ drawList });
		let externalVideoFrames = 0;
		let copiedTextureUploads = 0;
		this.ensureBufferPool({ device, drawCount: effectiveDrawList.length });

		for (const [index, draw] of effectiveDrawList.entries()) {
			const resolvedSource = draw.solidColor
				? this.getSolidColorSource({ color: draw.solidColor })
				: draw.source && draw.sourceWidth && draw.sourceHeight
					? {
							source: draw.source,
							width: draw.sourceWidth,
							height: draw.sourceHeight,
						}
					: null;
			if (!resolvedSource) {
				continue;
			}
			const isVideoFrameSource =
				typeof VideoFrame !== "undefined" &&
				resolvedSource.source instanceof VideoFrame;
			const usePlusBlend = draw.blendMode === "plus-lighter";
			const scissorRect = this.getResolvedScissorRect({
				clipRect: draw.clipRect,
			});
			if (!scissorRect) {
				continue;
			}
			pass.setScissorRect(
				scissorRect.x,
				scissorRect.y,
				scissorRect.width,
				scissorRect.height,
			);

			const uniformBuffer = this.uniformBufferPool[index];
			device.queue.writeBuffer(
				uniformBuffer,
				0,
				new Float32Array([draw.opacity, 0, 0, 0]),
			);

			let bindGroup: GPUBindGroup;
			if (isVideoFrameSource) {
				const selectedExternalPipeline = usePlusBlend
					? externalPipelinePlus
					: externalPipeline;
				const videoFrame = resolvedSource.source as VideoFrame;
				const externalTexture = device.importExternalTexture({
					source: videoFrame,
				});
				externalVideoFrames += 1;
				bindGroup = device.createBindGroup({
					layout: selectedExternalPipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: sampler },
						{ binding: 1, resource: externalTexture },
						{ binding: 2, resource: { buffer: uniformBuffer } },
					],
				});
			} else {
				const selectedPipeline = usePlusBlend ? pipelinePlus : pipeline;
				const textureEntry = this.getOrCreateTexture({
					source: resolvedSource.source as GPUCopyExternalImageSource,
					sourceWidth: resolvedSource.width,
					sourceHeight: resolvedSource.height,
					device,
				});
				const sourceIsDynamic = this.sourceNeedsUploadEachFrame({
					source: resolvedSource.source as GPUCopyExternalImageSource,
				});
				const needsUpload =
					textureEntry.isStaticUploaded === false || sourceIsDynamic;
				if (needsUpload) {
					device.queue.copyExternalImageToTexture(
						{ source: resolvedSource.source as GPUCopyExternalImageSource },
						{ texture: textureEntry.texture },
						{
							width: Math.max(1, Math.round(resolvedSource.width)),
							height: Math.max(1, Math.round(resolvedSource.height)),
						},
					);
					textureEntry.isStaticUploaded = !sourceIsDynamic;
					copiedTextureUploads += 1;
				}
				bindGroup = device.createBindGroup({
					layout: selectedPipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: textureEntry.view },
						{ binding: 1, resource: sampler },
						{ binding: 2, resource: { buffer: uniformBuffer } },
					],
				});
			}

			const vertices = this.createQuadVertices({ draw });
			const vertexBuffer = this.vertexBufferPool[index];
			device.queue.writeBuffer(vertexBuffer, 0, vertices);

			pass.setPipeline(
				isVideoFrameSource
					? usePlusBlend
						? externalPipelinePlus
						: externalPipeline
					: usePlusBlend
						? pipelinePlus
						: pipeline,
			);
			pass.setBindGroup(0, bindGroup);
			pass.setVertexBuffer(0, vertexBuffer);
			pass.draw(6);
		}

		pass.end();
		device.queue.submit([encoder.finish()]);

		if (overlayCanvas) {
			await this.renderNodesCpu({
				nodes: partition.cpuPostNodes,
				time,
				targetCanvas: overlayCanvas,
				fps: this.fps,
				clear: true,
			});
		} else if (partition.cpuPostNodes.length > 0) {
			const fallbackCtx = targetCanvas.getContext("2d");
			if (!fallbackCtx) {
				return {
					usedWebGPU: false,
					reasonIfFallback: "Overlay canvas required for CPU overlay nodes",
					shouldDisableWebGPU: false,
					dividerRects: [],
				};
			}
			await this.renderNodesCpu({
				nodes: partition.cpuPostNodes,
				time,
				targetCanvas,
				fps: this.fps,
				clear: true,
			});
		}

		return {
			usedWebGPU: true,
			dividerRects,
			stats: {
				externalVideoFrames,
				copiedTextureUploads,
				totalDraws: effectiveDrawList.length,
			},
		};
	}
}
