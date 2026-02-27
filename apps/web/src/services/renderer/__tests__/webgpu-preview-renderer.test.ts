import { describe, expect, test, beforeEach, mock } from "bun:test";

type Fake2DContext = {
	clearRectCalls: number;
	drawImageCalls: number;
	clearRect: () => void;
	drawImage: () => void;
};

function createFake2DContext(): Fake2DContext {
	return {
		clearRectCalls: 0,
		drawImageCalls: 0,
		clearRect() {
			this.clearRectCalls += 1;
		},
		drawImage() {
			this.drawImageCalls += 1;
		},
	};
}

describe("WebGPUPreviewRenderer", () => {
	let drawSourceFactory: () => unknown;
	let fakeDevice: {
		queue: {
			copyExternalImageToTexture: ReturnType<typeof mock>;
			writeBuffer: () => void;
			submit: ReturnType<typeof mock>;
		};
		createShaderModule: () => object;
		createRenderPipeline: () => { getBindGroupLayout: () => object };
		createSampler: () => object;
		importExternalTexture: ReturnType<typeof mock>;
		createCommandEncoder: () => {
			beginRenderPass: () => {
				setPipeline: () => void;
				setBindGroup: () => void;
				setVertexBuffer: () => void;
				draw: () => void;
				end: () => void;
			};
			finish: () => object;
		};
		createTexture: () => { createView: () => object };
		createBuffer: () => object;
		createBindGroup: () => object;
		lost: Promise<never>;
	};

	beforeEach(() => {
		Object.defineProperty(globalThis, "window", {
			value: { isSecureContext: true },
			configurable: true,
		});

		fakeDevice = {
			queue: {
				copyExternalImageToTexture: mock(() => {}),
				writeBuffer: () => {},
				submit: mock(() => {}),
			},
			createShaderModule: () => ({}),
			createRenderPipeline: () => ({
				getBindGroupLayout: () => ({}),
			}),
			createSampler: () => ({}),
			importExternalTexture: mock(() => ({})),
			createCommandEncoder: () => ({
				beginRenderPass: () => ({
					setPipeline: () => {},
					setBindGroup: () => {},
					setVertexBuffer: () => {},
					draw: () => {},
					end: () => {},
				}),
				finish: () => ({}),
			}),
			createTexture: () => ({
				createView: () => ({}),
			}),
			createBuffer: () => ({}),
			createBindGroup: () => ({}),
			lost: new Promise<never>(() => {}),
		};

		const fakeWebGPUContext = {
			configure: () => {},
			getCurrentTexture: () => ({
				createView: () => ({}),
			}),
		};

		Object.defineProperty(globalThis, "navigator", {
			value: {
				gpu: {
					requestAdapter: async () => ({
						requestDevice: async () => fakeDevice,
					}),
					getPreferredCanvasFormat: () => "bgra8unorm",
				},
			},
			configurable: true,
		});

		Object.defineProperty(globalThis, "GPUTextureUsage", {
			value: {
				TEXTURE_BINDING: 1,
				COPY_DST: 2,
				RENDER_ATTACHMENT: 4,
			},
			configurable: true,
		});

		Object.defineProperty(globalThis, "GPUBufferUsage", {
			value: {
				UNIFORM: 1,
				COPY_DST: 2,
				VERTEX: 4,
			},
			configurable: true,
		});

		Object.defineProperty(globalThis, "document", {
			value: {
				createElement: (tag: string) => {
					if (tag !== "canvas") return {};
					const fake2d = createFake2DContext();
					return {
						width: 0,
						height: 0,
						getContext: (kind: string) => {
							if (kind === "webgpu") return fakeWebGPUContext;
							if (kind === "2d") return fake2d;
							return null;
						},
					};
				},
			},
			configurable: true,
		});

		drawSourceFactory = () => ({
			width: 1920,
			height: 1080,
		});

		mock.module("../scene-partition", () => ({
			getRendererCapabilities: () => ({ webgpuSupported: true }),
			splitSceneForHybridPreview: () => ({
				supported: true,
				gpuNodes: [
					{
						getWebGPUDrawData: async () => ({
							source: drawSourceFactory() as GPUCopyExternalImageSource,
							sourceWidth: 1920,
							sourceHeight: 1080,
							x: 0,
							y: 0,
							width: 1920,
							height: 1080,
							rotation: 0,
							opacity: 1,
							blendMode: "normal",
						}),
					},
				],
				cpuPreNodes: [],
				cpuPostNodes: [],
			}),
		}));
	});

	test("uses WebGPU path when available and scene is GPU-eligible", async () => {
		const { WebGPUPreviewRenderer } = await import(
			"../webgpu-preview-renderer"
		);

		const renderer = new WebGPUPreviewRenderer({
			width: 1920,
			height: 1080,
			fps: 30,
		});

		const target2d = createFake2DContext();
		const targetWebGPUContext = {
			configure: () => {},
			getCurrentTexture: () => ({
				createView: () => ({}),
			}),
		};
		const targetCanvas = {
			width: 1920,
			height: 1080,
			getContext: (kind: string) => {
				if (kind === "webgpu") return targetWebGPUContext;
				if (kind === "2d") return target2d;
				return null;
			},
		} as unknown as HTMLCanvasElement;

		const result = await renderer.renderToCanvas({
			rootNode: {} as never,
			time: 0,
			targetCanvas,
		});

		expect(result.usedWebGPU).toBe(true);
		expect(target2d.clearRectCalls).toBe(0);
		expect(target2d.drawImageCalls).toBe(0);
	});

	test("uses importExternalTexture path for VideoFrame sources", async () => {
		class FakeVideoFrame {
			close() {}
		}
		Object.defineProperty(globalThis, "VideoFrame", {
			value: FakeVideoFrame,
			configurable: true,
		});
		drawSourceFactory = () => new FakeVideoFrame();

		const { WebGPUPreviewRenderer } = await import(
			"../webgpu-preview-renderer"
		);

		const renderer = new WebGPUPreviewRenderer({
			width: 1920,
			height: 1080,
			fps: 30,
		});

		const targetWebGPUContext = {
			configure: () => {},
			getCurrentTexture: () => ({
				createView: () => ({}),
			}),
		};
		const targetCanvas = {
			width: 1920,
			height: 1080,
			getContext: (kind: string) =>
				kind === "webgpu" ? targetWebGPUContext : null,
		} as unknown as HTMLCanvasElement;

		const result = await renderer.renderToCanvas({
			rootNode: {} as never,
			time: 0,
			targetCanvas,
		});

		expect(result.usedWebGPU).toBe(true);
		expect(fakeDevice.importExternalTexture.mock.calls.length).toBeGreaterThan(
			0,
		);
		expect(fakeDevice.queue.copyExternalImageToTexture.mock.calls.length).toBe(
			0,
		);
	});
});
