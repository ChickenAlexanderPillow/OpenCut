"use client";

import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { flushSync } from "react-dom";
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
import { resolvePreviewRenderBackend } from "@/services/renderer/preview-render-mode";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import type { TBackground } from "@/types/project";
import type { TimelineTrack } from "@/types/timeline";
import { SafeAreaOverlay } from "./safe-area-overlay";
import { SquareDashed } from "lucide-react";
import {
	getPreviewCanvasSize,
	remapCaptionTransformsForPreviewVariant,
} from "@/lib/preview/preview-format";
import { validateAndHealCaptionDriftInTracks } from "@/lib/transcript-editor/sync-captions";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";

const PREVIEW_PROFILES = {
	performance: {
		videoFrameRateCap: 10,
		renderFrameRateCap: 12,
		videoProxyScale: 0.35,
	},
	balanced: {
		videoFrameRateCap: 15,
		renderFrameRateCap: 18,
		videoProxyScale: 0.5,
	},
	full: {
		videoFrameRateCap: Number.POSITIVE_INFINITY,
		renderFrameRateCap: Number.POSITIVE_INFINITY,
		videoProxyScale: 1,
	},
} as const;

function getCoverToContainScaleRatio({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
}): number {
	if (
		canvasWidth <= 0 ||
		canvasHeight <= 0 ||
		sourceWidth <= 0 ||
		sourceHeight <= 0
	) {
		return 1;
	}
	const widthRatio = canvasWidth / sourceWidth;
	const heightRatio = canvasHeight / sourceHeight;
	const contain = Math.min(widthRatio, heightRatio);
	const cover = Math.max(widthRatio, heightRatio);
	if (contain <= 0 || !Number.isFinite(contain) || !Number.isFinite(cover)) {
		return 1;
	}
	return cover / contain;
}

function remapLandscapeVideoScalesForSquarePreview({
	tracks,
	mediaById,
	projectCanvas,
	previewCanvas,
}: {
	tracks: TimelineTrack[];
	mediaById: Map<
		string,
		{
			width?: number;
			height?: number;
		}
	>;
	projectCanvas: { width: number; height: number };
	previewCanvas: { width: number; height: number };
}): TimelineTrack[] {
	const projectIsPortrait = projectCanvas.height > projectCanvas.width;
	return tracks.map((track) => {
		if (track.type !== "video") return track;
		return {
			...track,
			elements: track.elements.map((element) => {
				if (element.type !== "video") return element;
				const asset = mediaById.get(element.mediaId);
				const sourceWidth = asset?.width ?? 0;
				const sourceHeight = asset?.height ?? 0;
				const hasKnownDimensions = sourceWidth > 0 && sourceHeight > 0;
				const hasKnownLandscape =
					hasKnownDimensions && sourceWidth > sourceHeight;
				const canApplyUnknownFallback =
					!hasKnownDimensions &&
					projectIsPortrait &&
					element.transform.scale > 1;
				if (!hasKnownLandscape && !canApplyUnknownFallback) {
					return element;
				}
				const effectiveSourceWidth = hasKnownDimensions ? sourceWidth : 16;
				const effectiveSourceHeight = hasKnownDimensions ? sourceHeight : 9;

				const projectCoverRatio = getCoverToContainScaleRatio({
					canvasWidth: projectCanvas.width,
					canvasHeight: projectCanvas.height,
					sourceWidth: effectiveSourceWidth,
					sourceHeight: effectiveSourceHeight,
				});
				const previewCoverRatio = getCoverToContainScaleRatio({
					canvasWidth: previewCanvas.width,
					canvasHeight: previewCanvas.height,
					sourceWidth: effectiveSourceWidth,
					sourceHeight: effectiveSourceHeight,
				});
				const ratio =
					projectCoverRatio > 0 ? previewCoverRatio / projectCoverRatio : 1;
				const nextScale = Math.max(
					0.01,
					element.transform.scale * (Number.isFinite(ratio) ? ratio : 1),
				);

				return {
					...element,
					transform: {
						...element.transform,
						scale: nextScale,
					},
				};
			}),
		};
	});
}

function hasMotionBlurTransitionInTracks({
	tracks,
}: {
	tracks: TimelineTrack[];
}): boolean {
	for (const track of tracks) {
		for (const element of track.elements) {
			if (
				element.type !== "video" &&
				element.type !== "image" &&
				element.type !== "text" &&
				element.type !== "sticker"
			) {
				continue;
			}
			const inPresetId = element.transitions?.in?.presetId ?? "";
			const outPresetId = element.transitions?.out?.presetId ?? "";
			if (
				inPresetId.includes("motion-blur") ||
				outPresetId.includes("motion-blur")
			) {
				return true;
			}
		}
	}
	return false;
}

const EDITOR_SUBSCRIBE_PROJECT = ["project"] as const;
const EDITOR_SUBSCRIBE_RENDER_TREE = ["timeline", "media", "project"] as const;
const EDITOR_SUBSCRIBE_PREVIEW_CANVAS = ["project", "renderer"] as const;

function usePreviewSize() {
	const editor = useEditor({ subscribeTo: EDITOR_SUBSCRIBE_PROJECT });
	const activeProject = editor.project.getActive();
	const { previewFormatVariant } = usePreviewStore();
	const baseWidth = activeProject?.settings.canvasSize.width ?? 0;
	const baseHeight = activeProject?.settings.canvasSize.height ?? 0;
	const size = getPreviewCanvasSize({
		projectWidth: baseWidth,
		projectHeight: baseHeight,
		previewFormatVariant,
	});

	return {
		width: size.width,
		height: size.height,
	};
}

export function PreviewPanel() {
	const containerRef = useRef<HTMLDivElement>(null);
	const { isFullscreen, toggleFullscreen } = useFullscreen({ containerRef });
	const editor = useEditor({ subscribeTo: EDITOR_SUBSCRIBE_PROJECT });
	const activeProject = editor.project.getActive();
	const {
		previewFormatVariant,
		setPreviewFormatVariant,
		overlays,
		setOverlayVisibility,
	} = usePreviewStore();
	const [freezeFrameToken, setFreezeFrameToken] = useState(0);
	const projectWidth = activeProject.settings.canvasSize.width;
	const projectHeight = activeProject.settings.canvasSize.height;
	const isProjectSquare = projectWidth === projectHeight;

	const triggerFormatSwitch = useCallback(
		({ variant }: { variant: "project" | "square" }) => {
			flushSync(() => {
				setFreezeFrameToken((value) => value + 1);
			});
			setPreviewFormatVariant({ variant });
		},
		[setPreviewFormatVariant],
	);

	return (
		<div
			ref={containerRef}
			className="panel bg-background relative flex size-full min-h-0 min-w-0 flex-col rounded-sm border"
		>
			<div className="flex items-center justify-between gap-2 px-2 pt-2">
				<div className="flex items-center gap-1">
					<Button
						variant={previewFormatVariant === "project" ? "secondary" : "ghost"}
						size="sm"
						className={cn("h-7 px-2 text-xs")}
						onClick={() => triggerFormatSwitch({ variant: "project" })}
					>
						Project
					</Button>
					{!isProjectSquare && (
						<Button
							variant={
								previewFormatVariant === "square" ? "secondary" : "ghost"
							}
							size="sm"
							className={cn("h-7 px-2 text-xs")}
							onClick={() => triggerFormatSwitch({ variant: "square" })}
						>
							Square
						</Button>
					)}
				</div>
				<TooltipProvider>
					<Tooltip delayDuration={120}>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant={overlays.safeAreas ? "secondary" : "ghost"}
								size="icon"
								className="h-7 w-7"
								aria-label="Toggle safe area"
								aria-pressed={overlays.safeAreas}
								onClick={() =>
									setOverlayVisibility({
										overlay: "safeAreas",
										isVisible: !overlays.safeAreas,
									})
								}
							>
								<SquareDashed className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Safe area</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			</div>
			<div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-2 pb-0">
				<PreviewCanvas
					freezeFrameToken={freezeFrameToken}
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
	const editor = useEditor({ subscribeTo: EDITOR_SUBSCRIBE_RENDER_TREE });
	const tracks = editor.timeline.getTracks();
	const mediaAssets = editor.media.getAssets();
	const activeProject = editor.project.getActive();
	const activeProjectId = activeProject.metadata.id;
	const {
		previewFormatVariant,
		squareFormatSettings,
		playbackQuality,
		previewRendererMode,
	} = usePreviewStore();
	const previewProfile = PREVIEW_PROFILES[playbackQuality];
	const projectFps = Math.max(1, activeProject.settings.fps);
	const previewVideoFrameRateCap = projectFps;
	const hasMotionBlurTransition = useMemo(
		() => hasMotionBlurTransitionInTracks({ tracks }),
		[tracks],
	);
	const previewVideoProxyScale = hasMotionBlurTransition
		? 1
		: previewProfile.videoProxyScale;
	const hasLandscapeVideoSource = useMemo(() => {
		const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
		for (const track of tracks) {
			for (const element of track.elements) {
				if (element.type !== "video") continue;
				const asset = mediaById.get(element.mediaId);
				if (!asset) continue;
				const width = asset.width ?? 0;
				const height = asset.height ?? 0;
				if (width > height && height > 0) {
					return true;
				}
			}
		}
		return false;
	}, [mediaAssets, tracks]);

	const { width, height } = usePreviewSize();

	useEffect(() => {
		void activeProjectId;
		void previewVideoProxyScale;
		videoCache.clearAll();
	}, [activeProjectId, previewVideoProxyScale]);

	useEffect(() => {
		editor.renderer.setPreviewRendererMode({ mode: previewRendererMode });
	}, [editor.renderer, previewRendererMode]);

	useEffect(() => {
		if (!activeProject) return;
		const driftHeal = validateAndHealCaptionDriftInTracks({
			tracks,
			projectId: activeProject.metadata.id,
		});
		if (driftHeal.changed) {
			editor.timeline.updateTracks(driftHeal.tracks);
		}
	}, [activeProject, editor.timeline, tracks]);

	useDeepCompareEffect(() => {
		if (!activeProject) return;

		const duration = editor.timeline.getTotalDuration();
		const projectWidth = activeProject.settings.canvasSize.width;
		const projectHeight = activeProject.settings.canvasSize.height;
		const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
		const squareCoverScale =
			Math.max(projectWidth, projectHeight) /
			Math.max(1, Math.min(projectWidth, projectHeight));
		const previewBackground: TBackground =
			previewFormatVariant === "square"
				? hasLandscapeVideoSource
					? {
							type: "color",
							color: "#000000",
						}
					: {
							type: "blur",
							blurIntensity: squareFormatSettings.blurIntensity,
							blurScale: Math.max(
								1.4,
								squareCoverScale *
									Math.max(1, squareFormatSettings.coverOverscanPercent / 100),
							),
						}
				: activeProject.settings.background;
		const captionMappedTracks =
			previewFormatVariant === "square"
				? remapCaptionTransformsForPreviewVariant({
						tracks,
						sourceCanvas: { width: projectWidth, height: projectHeight },
						previewCanvas: { width, height },
					})
				: tracks;
		const previewTracks =
			previewFormatVariant === "square" && hasLandscapeVideoSource
				? remapLandscapeVideoScalesForSquarePreview({
						tracks: captionMappedTracks,
						mediaById,
						projectCanvas: { width: projectWidth, height: projectHeight },
						previewCanvas: { width, height },
					})
				: captionMappedTracks;
		const renderTree = buildScene({
			tracks: previewTracks,
			mediaAssets,
			duration,
			canvasSize: { width, height },
			backgroundReferenceCanvasSize: activeProject.settings.canvasSize,
			background: previewBackground,
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
		previewFormatVariant,
		squareFormatSettings,
		hasLandscapeVideoSource,
		playbackQuality,
		width,
		height,
		previewVideoFrameRateCap,
		previewVideoProxyScale,
	]);

	return null;
}

function PreviewCanvas({
	freezeFrameToken,
	onToggleFullscreen,
	containerRef,
}: {
	freezeFrameToken: number;
	onToggleFullscreen: () => void;
	containerRef: React.RefObject<HTMLElement | null>;
}) {
	const canvas2dRef = useRef<HTMLCanvasElement>(null);
	const webgpuCanvasRef = useRef<HTMLCanvasElement>(null);
	const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
	const outerContainerRef = useRef<HTMLDivElement>(null);
	const canvasBoundsRef = useRef<HTMLDivElement>(null);
	const lastFrameRef = useRef(-1);
	const lastSceneRef = useRef<RootNode | null>(null);
	const runtimeFallbackRef = useRef<string | null>(null);
	const [isPageVisible, setIsPageVisible] = useState(
		typeof document === "undefined" ? true : !document.hidden,
	);
	const [activeSurface, setActiveSurface] = useState<"canvas2d" | "webgpu">(
		"canvas2d",
	);
	const [safeAreaOverlayReady, setSafeAreaOverlayReady] = useState(true);
	const [isRenderReadyForSize, setIsRenderReadyForSize] = useState(true);
	const [showFrozenFrame, setShowFrozenFrame] = useState(false);
	const [freezeFrameDataUrl, setFreezeFrameDataUrl] = useState<string | null>(
		null,
	);
	const renderReadyRef = useRef(true);
	const previousDisplaySizeRef = useRef<{ width: number; height: number }>({
		width: 0,
		height: 0,
	});
	const [transitionHoldSize, setTransitionHoldSize] = useState<{
		width: number;
		height: number;
	} | null>(null);
	const renderingRef = useRef(false);
	const pendingRenderRef = useRef<{
		time: number;
		frame: number;
		scene: RootNode;
	} | null>(null);
	const { width: nativeWidth, height: nativeHeight } = usePreviewSize();
	const containerSize = useContainerSize({ containerRef: outerContainerRef });
	const editor = useEditor({ subscribeTo: EDITOR_SUBSCRIBE_PREVIEW_CANVAS });
	const activeProject = editor.project.getActive();
	const { overlays, previewFormatVariant, previewRendererMode } =
		usePreviewStore();
	const projectFps = Math.max(1, activeProject.settings.fps);
	const renderFrameRateCap = projectFps;
	const previewBackgroundColor =
		previewFormatVariant === "square"
			? "transparent"
			: activeProject.settings.background.type === "blur"
				? "transparent"
				: activeProject.settings.background.color;

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
	useEffect(() => {
		previousDisplaySizeRef.current = displaySize;
	}, [displaySize.width, displaySize.height]);

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

			const setSurface = ({ active }: { active: "webgpu" | "canvas2d" }) => {
				setActiveSurface((prev) => (prev === active ? prev : active));
			};

			renderingRef.current = true;
			lastSceneRef.current = scene;
			lastFrameRef.current = frameNumber;
			const renderStart = performance.now();
			const renderPromise = (() => {
				const backend = resolvePreviewRenderBackend({
					mode: previewRendererMode,
					runtimeFallbackReason: runtimeFallbackRef.current,
				});
				if (backend === "canvas2d") {
					const overlayCtx = overlayCanvasRef.current?.getContext("2d");
					if (overlayCtx && overlayCanvasRef.current) {
						overlayCtx.clearRect(
							0,
							0,
							overlayCanvasRef.current.width,
							overlayCanvasRef.current.height,
						);
					}
					setSurface({ active: "canvas2d" });
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
							setSurface({ active: "canvas2d" });
							if (
								previewRendererMode === "auto" &&
								result.shouldDisableWebGPU
							) {
								runtimeFallbackRef.current =
									result.reasonIfFallback ?? "WebGPU fallback";
							}
							return renderer.renderToCanvas({
								node: scene,
								time,
								targetCanvas: canvas2d,
							});
						}
						setSurface({ active: "webgpu" });
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
						if (fatal && previewRendererMode === "auto") {
							runtimeFallbackRef.current = message;
						}
						setSurface({ active: "canvas2d" });
						return renderer.renderToCanvas({
							node: scene,
							time,
							targetCanvas: canvas2d,
						});
					});
			})();
			void renderPromise.then(() => {
				if (!renderReadyRef.current) {
					renderReadyRef.current = true;
					setIsRenderReadyForSize(true);
					setTransitionHoldSize(null);
					setShowFrozenFrame(false);
					setFreezeFrameDataUrl(null);
				}
				void renderStart;
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
		previewRendererMode,
	]);

	useEffect(() => {
		if (typeof document === "undefined") return;
		const handleVisibilityChange = () => {
			setIsPageVisible(!document.hidden);
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, []);

	useEffect(() => {
		if (isPageVisible) return;
		// Release GPU resources immediately while tab/app is hidden.
		webgpuRenderer.dispose();
	}, [isPageVisible, webgpuRenderer]);

	useRafLoop(render, { enabled: isPageVisible });

	useEffect(() => {
		void previewRendererMode;
		runtimeFallbackRef.current = null;
		setActiveSurface("canvas2d");
	}, [previewRendererMode]);

	useEffect(() => {
		const sourceCanvas =
			activeSurface === "webgpu"
				? webgpuCanvasRef.current
				: canvas2dRef.current;
		if (!sourceCanvas) return;
		const composite = document.createElement("canvas");
		composite.width = sourceCanvas.width;
		composite.height = sourceCanvas.height;
		const compositeCtx = composite.getContext("2d");
		if (!compositeCtx) return;
		compositeCtx.clearRect(0, 0, composite.width, composite.height);
		compositeCtx.drawImage(sourceCanvas, 0, 0);
		const overlayCanvas = overlayCanvasRef.current;
		if (overlayCanvas) {
			compositeCtx.drawImage(overlayCanvas, 0, 0);
		}
		const snapshot = composite.toDataURL("image/png");
		if (!snapshot) return;

		setFreezeFrameDataUrl(snapshot);
		setShowFrozenFrame(true);
		renderReadyRef.current = false;
		setIsRenderReadyForSize(false);
		const previous = previousDisplaySizeRef.current;
		if (previous.width > 0 && previous.height > 0) {
			setTransitionHoldSize(previous);
		}
		lastFrameRef.current = -1;
		lastSceneRef.current = null;
	}, [freezeFrameToken, activeSurface]);

	const effectiveDisplaySize =
		isRenderReadyForSize || !transitionHoldSize
			? displaySize
			: transitionHoldSize;

	useEffect(() => {
		setSafeAreaOverlayReady(false);
		let raf1 = 0;
		let raf2 = 0;
		raf1 = requestAnimationFrame(() => {
			raf2 = requestAnimationFrame(() => {
				setSafeAreaOverlayReady(true);
			});
		});
		return () => {
			if (raf1) cancelAnimationFrame(raf1);
			if (raf2) cancelAnimationFrame(raf2);
		};
	}, [previewFormatVariant, nativeWidth, nativeHeight]);

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
						data-editor-selection-root="preview"
						className="relative"
						style={{
							width: effectiveDisplaySize.width,
							height: effectiveDisplaySize.height,
						}}
					>
						{freezeFrameDataUrl && (
							<img
								alt=""
								className="pointer-events-none absolute inset-0"
								src={freezeFrameDataUrl}
								style={{
									width: effectiveDisplaySize.width,
									height: effectiveDisplaySize.height,
									display:
										showFrozenFrame && !isRenderReadyForSize ? "block" : "none",
								}}
							/>
						)}
						<canvas
							ref={canvas2dRef}
							width={nativeWidth}
							height={nativeHeight}
							className="absolute inset-0 block border"
							style={{
								width: effectiveDisplaySize.width,
								height: effectiveDisplaySize.height,
								display:
									activeSurface === "canvas2d" && isRenderReadyForSize
										? "block"
										: "none",
								background: previewBackgroundColor,
							}}
						/>
						<canvas
							ref={webgpuCanvasRef}
							width={nativeWidth}
							height={nativeHeight}
							className="absolute inset-0 block border"
							style={{
								width: effectiveDisplaySize.width,
								height: effectiveDisplaySize.height,
								display:
									activeSurface === "webgpu" && isRenderReadyForSize
										? "block"
										: "none",
								background: "transparent",
							}}
						/>
						<canvas
							ref={overlayCanvasRef}
							width={nativeWidth}
							height={nativeHeight}
							className="pointer-events-none absolute inset-0"
							style={{
								width: effectiveDisplaySize.width,
								height: effectiveDisplaySize.height,
								background: "transparent",
							}}
						/>
						<PreviewInteractionOverlay
							canvasRef={interactionCanvasRef}
							containerRef={canvasBoundsRef}
						/>
						{overlays.safeAreas && safeAreaOverlayReady && (
							<SafeAreaOverlay
								canvasWidth={nativeWidth}
								canvasHeight={nativeHeight}
							/>
						)}
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
