import { describe, expect, test } from "bun:test";
import { resolvePreviewRenderBackend } from "../preview-render-mode";

describe("resolvePreviewRenderBackend", () => {
	test("forces canvas2d when mode is canvas2d", () => {
		expect(
			resolvePreviewRenderBackend({
				mode: "canvas2d",
				runtimeFallbackReason: null,
			}),
		).toBe("canvas2d");
	});

	test("forces webgpu when mode is webgpu", () => {
		expect(
			resolvePreviewRenderBackend({
				mode: "webgpu",
				runtimeFallbackReason: "previous runtime error",
			}),
		).toBe("webgpu");
	});

	test("auto uses webgpu when there is no runtime fallback", () => {
		expect(
			resolvePreviewRenderBackend({
				mode: "auto",
				runtimeFallbackReason: null,
			}),
		).toBe("webgpu");
	});

	test("auto uses canvas2d when runtime fallback is active", () => {
		expect(
			resolvePreviewRenderBackend({
				mode: "auto",
				runtimeFallbackReason: "device lost",
			}),
		).toBe("canvas2d");
	});
});
