"use client";

import { useCallback, useMemo, useRef, useEffect } from "react";
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
	const { playbackQuality } = usePreviewStore();
	const previewProfile = PREVIEW_PROFILES[playbackQuality];
	const previewVideoFrameRateCap = Math.min(
		activeProject.settings.fps,
		previewProfile.videoFrameRateCap,
	);
	const previewVideoProxyScale = previewProfile.videoProxyScale;
	const activeProjectId = activeProject.metadata.id;

	const { width, height } = usePreviewSize();

	useEffect(() => {
		void activeProjectId;
		void playbackQuality;
		void previewVideoProxyScale;
		videoCache.clearAll();
	}, [activeProjectId, playbackQuality, previewVideoProxyScale]);

	useDeepCompareEffect(() => {
		if (!activeProject) return;

		const duration = editor.timeline.getTotalDuration();
		const renderTree = buildScene({
			tracks,
			mediaAssets,
			duration,
			canvasSize: { width, height },
			background: activeProject.settings.background,
			isPreview: true,
			previewFrameRateCap: previewVideoFrameRateCap,
			previewProxyScale: previewVideoProxyScale,
		});

		editor.renderer.setRenderTree({ renderTree });
	}, [
		tracks,
		mediaAssets,
		activeProject?.settings.background,
		width,
		height,
		previewVideoFrameRateCap,
		previewVideoProxyScale,
		playbackQuality,
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
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const outerContainerRef = useRef<HTMLDivElement>(null);
	const canvasBoundsRef = useRef<HTMLDivElement>(null);
	const lastFrameRef = useRef(-1);
	const lastSceneRef = useRef<RootNode | null>(null);
	const renderingRef = useRef(false);
	const pendingRenderRef = useRef<{
		time: number;
		frame: number;
		scene: RootNode;
	} | null>(null);
	const { width: nativeWidth, height: nativeHeight } = usePreviewSize();
	const containerSize = useContainerSize({ containerRef: outerContainerRef });
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const { overlays, playbackQuality } = usePreviewStore();
	const previewProfile = PREVIEW_PROFILES[playbackQuality];
	const renderFrameRateCap = Math.min(
		activeProject.settings.fps,
		previewProfile.renderFrameRateCap,
	);

	const renderer = useMemo(() => {
		return new CanvasRenderer({
			width: nativeWidth,
			height: nativeHeight,
			fps: Math.max(1, activeProject.settings.fps),
		});
	}, [nativeWidth, nativeHeight, activeProject.settings.fps]);

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
		if (!canvasRef.current || !renderTree) return;

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
			if (!canvasRef.current) return;
			renderingRef.current = true;
			lastSceneRef.current = scene;
			lastFrameRef.current = frameNumber;
			void renderer
				.renderToCanvas({
					node: scene,
					time,
					targetCanvas: canvasRef.current,
				})
				.then(() => {
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
	}, [renderer, renderTree, editor.playback, renderFrameRateCap]);

	useRafLoop(render);

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
							ref={canvasRef}
							width={nativeWidth}
							height={nativeHeight}
							className="block border"
							style={{
								width: displaySize.width,
								height: displaySize.height,
								background:
									activeProject.settings.background.type === "blur"
										? "transparent"
										: activeProject?.settings.background.color,
							}}
						/>
						<PreviewInteractionOverlay
							canvasRef={canvasRef}
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
