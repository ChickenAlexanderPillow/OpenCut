import type { BaseNode } from "./nodes/base-node";
import type { RootNode } from "./nodes/root-node";
import type { ImageNode } from "./nodes/image-node";
import type { VideoNode } from "./nodes/video-node";
import {
	getRendererCapabilities,
	splitSceneForHybridPreview,
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
	externalPipeline: GPURenderPipeline;
	sampler: GPUSampler;
};

type CachedTexture = {
	texture: GPUTexture;
	width: number;
	height: number;
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
	private textureCache = new WeakMap<object, CachedTexture>();

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
		this.state = null;
		this.initPromise = null;
		this.deviceLost = false;
		this.initErrorReason = null;
		this.textureCache = new WeakMap<object, CachedTexture>();
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
					externalPipeline,
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
		return drawData.filter((draw): draw is WebGPUVisualDrawData => !!draw);
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
	}): Float32Array {
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
		return new Float32Array(data);
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
	}): GPUTexture {
		const width = Math.max(1, Math.round(sourceWidth));
		const height = Math.max(1, Math.round(sourceHeight));
		const key = source as object;
		const cached = this.textureCache.get(key);
		if (cached && cached.width === width && cached.height === height) {
			return cached.texture;
		}

		const texture = device.createTexture({
			size: { width, height },
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.RENDER_ATTACHMENT,
		});
		this.textureCache.set(key, { texture, width, height });
		return texture;
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
			};
		}
		if (!this.ensurePresentationContext({ targetCanvas })) {
			return {
				usedWebGPU: false,
				reasonIfFallback:
					this.initErrorReason ?? "WebGPU presentation setup failed",
				shouldDisableWebGPU: true,
			};
		}

		const partition = splitSceneForHybridPreview({ rootNode });
		if (!partition.supported) {
			return {
				usedWebGPU: false,
				reasonIfFallback: partition.reasonIfUnsupported,
				shouldDisableWebGPU: false,
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
			};
		}

		const { device, context, pipeline, externalPipeline, sampler } = this.state;
		if (!context) {
			return {
				usedWebGPU: false,
				reasonIfFallback: "WebGPU context unavailable",
				shouldDisableWebGPU: true,
			};
		}
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

		const drawList: WebGPUVisualDrawData[] = [];
		if (partition.cpuPreNodes.length > 0) {
			const cpuPreCanvas = document.createElement("canvas");
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
		let externalVideoFrames = 0;
		let copiedTextureUploads = 0;
		const videoFramesToClose: VideoFrame[] = [];

		for (const draw of drawList) {
			const isVideoFrameSource =
				typeof VideoFrame !== "undefined" && draw.source instanceof VideoFrame;

			const uniformBuffer = device.createBuffer({
				size: 16,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			device.queue.writeBuffer(
				uniformBuffer,
				0,
				new Float32Array([draw.opacity, 0, 0, 0]),
			);

			let bindGroup: GPUBindGroup;
			if (isVideoFrameSource) {
				const videoFrameSource = draw.source as VideoFrame;
				const externalTexture = device.importExternalTexture({
					source: videoFrameSource,
				});
				externalVideoFrames += 1;
				videoFramesToClose.push(videoFrameSource);
				bindGroup = device.createBindGroup({
					layout: externalPipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: sampler },
						{ binding: 1, resource: externalTexture },
						{ binding: 2, resource: { buffer: uniformBuffer } },
					],
				});
			} else {
				const texture = this.getOrCreateTexture({
					source: draw.source,
					sourceWidth: draw.sourceWidth,
					sourceHeight: draw.sourceHeight,
					device,
				});
				device.queue.copyExternalImageToTexture(
					{ source: draw.source },
					{ texture },
					{
						width: Math.max(1, Math.round(draw.sourceWidth)),
						height: Math.max(1, Math.round(draw.sourceHeight)),
					},
				);
				copiedTextureUploads += 1;
				bindGroup = device.createBindGroup({
					layout: pipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: texture.createView() },
						{ binding: 1, resource: sampler },
						{ binding: 2, resource: { buffer: uniformBuffer } },
					],
				});
			}

			const vertices = this.createQuadVertices({ draw });
			const vertexBuffer = device.createBuffer({
				size: vertices.byteLength,
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			});
			device.queue.writeBuffer(vertexBuffer, 0, vertices);

			pass.setPipeline(isVideoFrameSource ? externalPipeline : pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.setVertexBuffer(0, vertexBuffer);
			pass.draw(6);
		}

		pass.end();
		device.queue.submit([encoder.finish()]);
		if (videoFramesToClose.length > 0) {
			const closeFrames = () => {
				for (const frame of videoFramesToClose) {
					try {
						frame.close();
					} catch {}
				}
			};
			if (typeof device.queue.onSubmittedWorkDone === "function") {
				void device.queue
					.onSubmittedWorkDone()
					.catch(() => {})
					.finally(closeFrames);
			} else {
				// Fallback for environments without queue completion promises.
				setTimeout(closeFrames, 0);
			}
		}

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
			stats: {
				externalVideoFrames,
				copiedTextureUploads,
				totalDraws: drawList.length,
			},
		};
	}
}
