"use client";

import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import useDeepCompareEffect from "use-deep-compare-effect";
import { useEditor } from "@/hooks/use-editor";
import { useRafLoop } from "@/hooks/use-raf-loop";
import { useContainerSize } from "@/hooks/use-container-size";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import { buildScene } from "@/services/renderer/scene-builder";
import { getLastFrameTime } from "@/lib/time";
import { PreviewInteractionOverlay } from "./preview-interaction-overlay";
import { BookmarkNoteOverlay } from "./bookmark-note-overlay";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { usePreviewStore } from "@/stores/preview-store";
import { PreviewContextMenu } from "./context-menu";
import { PreviewToolbar } from "./toolbar";
import { videoCache } from "@/services/video-cache/service";
import { WebGPUPreviewRenderer } from "@/services/renderer/webgpu-preview-renderer";

const PREVIEW_PROFILES = {
	performance: {
		videoFrameRateCap: 12,
		renderFrameRateCap: 15,
		videoProxyScale: 0.4,
	},
	balanced: {
		videoFrameRateCap: 18,
		renderFrameRateCap: 24,
		videoProxyScale: 0.6,
	},
	full: {
		videoFrameRateCap: Number.POSITIVE_INFINITY,
		renderFrameRateCap: Number.POSITIVE_INFINITY,
		videoProxyScale: 1,
	},
} as const;

function usePreviewSize() {
	const editor = useEditor();
	const activeProject = editor.project.getActive();

	return {
		width: activeProject?.settings.canvasSize.width,
		height: activeProject?.settings.canvasSize.height,
	};
}

export function PreviewPanel() {
	const containerRef = useRef<HTMLDivElement>(null);
	const { isFullscreen, toggleFullscreen } = useFullscreen({ containerRef });

	return (
		<div
			ref={containerRef}
			className="panel bg-background relative flex size-full min-h-0 min-w-0 flex-col rounded-sm border"
		>
			<div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-2 pb-0">
				<PreviewCanvas
					onToggleFullscreen={toggleFullscreen}
					containerRef={containerRef}
				/>
				<RenderTreeController />
			</div>
			<PreviewToolbar
				isFullscreen={isFullscreen}
				onToggleFullscreen={toggleFullscreen}
			/>
		</div>
	);
}

function RenderTreeController() {
	const editor = useEditor();
	const tracks = editor.timeline.getTracks();
	const mediaAssets = editor.media.getAssets();
	const activeProject = editor.project.getActive();
	const previewRendererMode = "auto" as const;
	const previewProfile = PREVIEW_PROFILES.balanced;
	const previewVideoFrameRateCap = activeProject.settings.fps;
	const previewVideoProxyScale = previewProfile.videoProxyScale;
	const activeProjectId = activeProject.metadata.id;

	const { width, height } = usePreviewSize();

	useEffect(() => {
		void activeProjectId;
		void previewVideoProxyScale;
		videoCache.clearAll();
	}, [activeProjectId, previewVideoProxyScale]);

	useEffect(() => {
		editor.renderer.setPreviewRendererMode({ mode: previewRendererMode });
	}, [editor.renderer, previewRendererMode]);

	useDeepCompareEffect(() => {
		if (!activeProject) return;

		const duration = editor.timeline.getTotalDuration();
		const renderTree = buildScene({
			tracks,
			mediaAssets,
			duration,
			canvasSize: { width, height },
			background: activeProject.settings.background,
			brandOverlays: activeProject.brandOverlays,
			isPreview: true,
			previewFrameRateCap: previewVideoFrameRateCap,
			previewProxyScale: previewVideoProxyScale,
		});

		editor.renderer.setRenderTree({ renderTree });
	}, [
		tracks,
		mediaAssets,
		activeProject?.settings.background,
		activeProject?.brandOverlays,
		width,
		height,
		previewVideoFrameRateCap,
		previewVideoProxyScale,
	]);

	return null;
}

function PreviewCanvas({
	onToggleFullscreen,
	containerRef,
}: {
	onToggleFullscreen: () => void;
	containerRef: React.RefObject<HTMLElement | null>;
}) {
	type RuntimeRendererStatus = {
		active: "webgpu" | "canvas2d";
		reason?: string;
	};

	const canvas2dRef = useRef<HTMLCanvasElement>(null);
	const webgpuCanvasRef = useRef<HTMLCanvasElement>(null);
	const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
	const outerContainerRef = useRef<HTMLDivElement>(null);
	const canvasBoundsRef = useRef<HTMLDivElement>(null);
	const lastFrameRef = useRef(-1);
	const lastSceneRef = useRef<RootNode | null>(null);
	const runtimeFallbackRef = useRef<string | null>(null);
	const runtimeRendererStatusRef = useRef<RuntimeRendererStatus>({
		active: "canvas2d",
		reason: "Initializing",
	});
	const [_runtimeRendererStatus, setRuntimeRendererStatus] =
		useState<RuntimeRendererStatus>({
			active: "canvas2d",
			reason: "Initializing",
		});
	const [activeSurface, setActiveSurface] = useState<"canvas2d" | "webgpu">(
		"canvas2d",
	);
	const renderingRef = useRef(false);
	const pendingRenderRef = useRef<{
		time: number;
		frame: number;
		scene: RootNode;
	} | null>(null);
	const perfRef = useRef<{
		lastRenderedAt: number;
		lastPerfSampleAt: number;
		renderedFramesSinceSample: number;
		fpsEma: number;
		renderMsEma: number;
	}>({
		lastRenderedAt: 0,
		lastPerfSampleAt: 0,
		renderedFramesSinceSample: 0,
		fpsEma: 0,
		renderMsEma: 0,
	});
	const { width: nativeWidth, height: nativeHeight } = usePreviewSize();
	const containerSize = useContainerSize({ containerRef: outerContainerRef });
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const { overlays } = usePreviewStore();
	const previewRendererMode = "auto" as const;
	const renderFrameRateCap = activeProject.settings.fps;

	const renderer = useMemo(() => {
		return new CanvasRenderer({
			width: nativeWidth,
			height: nativeHeight,
			fps: Math.max(1, activeProject.settings.fps),
		});
	}, [nativeWidth, nativeHeight, activeProject.settings.fps]);

	const webgpuRenderer = useMemo(
		() =>
			new WebGPUPreviewRenderer({
				width: nativeWidth,
				height: nativeHeight,
				fps: Math.max(1, activeProject.settings.fps),
			}),
		[nativeWidth, nativeHeight, activeProject.settings.fps],
	);

	useEffect(
		() => () => {
			webgpuRenderer.dispose();
		},
		[webgpuRenderer],
	);

	const displaySize = useMemo(() => {
		if (
			!nativeWidth ||
			!nativeHeight ||
			containerSize.width === 0 ||
			containerSize.height === 0
		) {
			return { width: nativeWidth ?? 0, height: nativeHeight ?? 0 };
		}

		const paddingBuffer = 4;
		const availableWidth = containerSize.width - paddingBuffer;
		const availableHeight = containerSize.height - paddingBuffer;

		const aspectRatio = nativeWidth / nativeHeight;
		const containerAspect = availableWidth / availableHeight;

		const displayWidth =
			containerAspect > aspectRatio
				? availableHeight * aspectRatio
				: availableWidth;
		const displayHeight =
			containerAspect > aspectRatio
				? availableHeight
				: availableWidth / aspectRatio;

		return { width: displayWidth, height: displayHeight };
	}, [nativeWidth, nativeHeight, containerSize.width, containerSize.height]);

	const renderTree = editor.renderer.getRenderTree();

	const render = useCallback(() => {
		if (!renderTree) return;

		const time = editor.playback.getCurrentTime();
		const lastFrameTime = getLastFrameTime({
			duration: renderTree.duration,
			fps: renderer.fps,
		});
		const rawRenderTime = Math.min(time, lastFrameTime);
		const renderTime =
			Number.isFinite(renderFrameRateCap) && renderFrameRateCap > 0
				? Math.floor(rawRenderTime * renderFrameRateCap) / renderFrameRateCap
				: rawRenderTime;
		const frame = Math.floor(renderTime * renderer.fps);

		if (frame === lastFrameRef.current && renderTree === lastSceneRef.current) {
			return;
		}

		const runRender = ({
			scene,
			time,
			frameNumber,
		}: {
			scene: RootNode;
			time: number;
			frameNumber: number;
		}) => {
			const canvas2d = canvas2dRef.current;
			const webgpuCanvas = webgpuCanvasRef.current;
			if (!canvas2d || !webgpuCanvas) return;

			const updateRendererStatus = (nextStatus: RuntimeRendererStatus) => {
				const current = runtimeRendererStatusRef.current;
				if (
					current.active === nextStatus.active &&
					current.reason === nextStatus.reason
				) {
					return;
				}
				runtimeRendererStatusRef.current = nextStatus;
				setRuntimeRendererStatus(nextStatus);
				setActiveSurface(
					nextStatus.active === "webgpu" ? "webgpu" : "canvas2d",
				);
			};

			renderingRef.current = true;
			lastSceneRef.current = scene;
			lastFrameRef.current = frameNumber;
			const renderStart = performance.now();
			const renderPromise = (() => {
				const forceCanvas2D = runtimeFallbackRef.current !== null;
				if (forceCanvas2D) {
					const overlayCtx = overlayCanvasRef.current?.getContext("2d");
					if (overlayCtx && overlayCanvasRef.current) {
						overlayCtx.clearRect(
							0,
							0,
							overlayCanvasRef.current.width,
							overlayCanvasRef.current.height,
						);
					}
					updateRendererStatus({
						active: "canvas2d",
						reason: runtimeFallbackRef.current ?? "Runtime fallback",
					});
					return renderer.renderToCanvas({
						node: scene,
						time,
						targetCanvas: canvas2d,
					});
				}

				return webgpuRenderer
					.renderToCanvas({
						rootNode: scene,
						time,
						targetCanvas: webgpuCanvas,
						overlayCanvas: overlayCanvasRef.current ?? undefined,
					})
					.then((result) => {
						if (!result.usedWebGPU) {
							updateRendererStatus({
								active: "canvas2d",
								reason: result.reasonIfFallback ?? "WebGPU unavailable",
							});
							if (result.shouldDisableWebGPU) {
								runtimeFallbackRef.current =
									result.reasonIfFallback ?? "WebGPU fallback";
							}
							return renderer.renderToCanvas({
								node: scene,
								time,
								targetCanvas: canvas2d,
							});
						}
						updateRendererStatus({
							active: "webgpu",
							reason: result.stats
								? `ext:${result.stats.externalVideoFrames} copy:${result.stats.copiedTextureUploads} draws:${result.stats.totalDraws}`
								: undefined,
						});
					})
					.catch((error) => {
						const message =
							error instanceof Error ? error.message : "WebGPU render failure";
						// Scene-level mismatches should not permanently disable WebGPU.
						// Only latch off for likely fatal/device-level failures.
						const lower = message.toLowerCase();
						const fatal =
							lower.includes("device") ||
							lower.includes("adapter") ||
							lower.includes("webgpu") ||
							lower.includes("context");
						if (fatal) {
							runtimeFallbackRef.current = message;
						}
						updateRendererStatus({
							active: "canvas2d",
							reason: message,
						});
						return renderer.renderToCanvas({
							node: scene,
							time,
							targetCanvas: canvas2d,
						});
					});
			})();
			void renderPromise.then(() => {
				const renderMs = performance.now() - renderStart;
				const p = perfRef.current;
				p.renderMsEma =
					p.renderMsEma === 0
						? renderMs
						: p.renderMsEma * 0.85 + renderMs * 0.15;
				p.lastRenderedAt = performance.now();
				p.renderedFramesSinceSample += 1;
				if (p.lastPerfSampleAt === 0) {
					p.lastPerfSampleAt = p.lastRenderedAt;
				}
				const perfWindowMs = p.lastRenderedAt - p.lastPerfSampleAt;
				if (perfWindowMs >= 400) {
					const measuredFps =
						(p.renderedFramesSinceSample * 1000) / perfWindowMs;
					p.fpsEma =
						p.fpsEma === 0 ? measuredFps : p.fpsEma * 0.7 + measuredFps * 0.3;
					p.renderedFramesSinceSample = 0;
					p.lastPerfSampleAt = p.lastRenderedAt;
				}
				if (runtimeRendererStatusRef.current.active === "webgpu") {
					const existing = runtimeRendererStatusRef.current.reason ?? "";
					const perfSuffix = `target:${activeProject.settings.fps} fps:${p.fpsEma.toFixed(1)} ms:${p.renderMsEma.toFixed(1)}`;
					const reasonWithoutPerf = existing.replace(
						/\s\| fps:[\d.]+ ms:[\d.]+$/,
						"",
					);
					const nextReason = reasonWithoutPerf
						? `${reasonWithoutPerf} | ${perfSuffix}`
						: perfSuffix;
					if (nextReason !== runtimeRendererStatusRef.current.reason) {
						runtimeRendererStatusRef.current = {
							...runtimeRendererStatusRef.current,
							reason: nextReason,
						};
						setRuntimeRendererStatus(runtimeRendererStatusRef.current);
					}
				}
				renderingRef.current = false;
				const pending = pendingRenderRef.current;
				if (!pending) return;
				pendingRenderRef.current = null;
				if (
					pending.frame !== lastFrameRef.current ||
					pending.scene !== lastSceneRef.current
				) {
					runRender({
						scene: pending.scene,
						time: pending.time,
						frameNumber: pending.frame,
					});
				}
			});
		};

		if (renderingRef.current) {
			pendingRenderRef.current = { scene: renderTree, time: renderTime, frame };
			return;
		}

		runRender({ scene: renderTree, time: renderTime, frameNumber: frame });
	}, [
		renderer,
		renderTree,
		editor.playback,
		renderFrameRateCap,
		webgpuRenderer,
		activeProject.settings.fps,
	]);

	useRafLoop(render);

	useEffect(() => {
		void previewRendererMode;
		void nativeWidth;
		void nativeHeight;
		runtimeFallbackRef.current = null;
		runtimeRendererStatusRef.current = {
			active: "canvas2d",
			reason: "Re-evaluating renderer",
		};
		setRuntimeRendererStatus(runtimeRendererStatusRef.current);
		setActiveSurface("canvas2d");
	}, [previewRendererMode, nativeWidth, nativeHeight]);

	const interactionCanvasRef =
		activeSurface === "webgpu" ? webgpuCanvasRef : canvas2dRef;

	return (
		<div
			ref={outerContainerRef}
			className="relative flex size-full items-center justify-center"
		>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						ref={canvasBoundsRef}
						className="relative"
						style={{ width: displaySize.width, height: displaySize.height }}
					>
						<canvas
							ref={canvas2dRef}
							width={nativeWidth}
							height={nativeHeight}
							className="absolute inset-0 block border"
							style={{
								width: displaySize.width,
								height: displaySize.height,
								display: activeSurface === "canvas2d" ? "block" : "none",
								background:
									activeProject.settings.background.type === "blur"
										? "transparent"
										: activeProject?.settings.background.color,
							}}
						/>
						<canvas
							ref={webgpuCanvasRef}
							width={nativeWidth}
							height={nativeHeight}
							className="absolute inset-0 block border"
							style={{
								width: displaySize.width,
								height: displaySize.height,
								display: activeSurface === "webgpu" ? "block" : "none",
								background: "transparent",
							}}
						/>
						<canvas
							ref={overlayCanvasRef}
							width={nativeWidth}
							height={nativeHeight}
							className="pointer-events-none absolute inset-0"
							style={{
								width: displaySize.width,
								height: displaySize.height,
								background: "transparent",
							}}
						/>
						<PreviewInteractionOverlay
							canvasRef={interactionCanvasRef}
							containerRef={canvasBoundsRef}
						/>
						{overlays.bookmarks && <BookmarkNoteOverlay />}
					</div>
				</ContextMenuTrigger>
				<PreviewContextMenu
					onToggleFullscreen={onToggleFullscreen}
					containerRef={containerRef}
				/>
			</ContextMenu>
		</div>
	);
}
