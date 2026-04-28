import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type {
	ExportContent,
	ExportOptions,
	ExportResult,
} from "@/types/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { buildScene } from "@/services/renderer/scene-builder";
import { createTimelineAudioBuffer } from "@/lib/media/audio";
import { formatTimeCode, getLastFrameTime } from "@/lib/time";
import { downloadBlob } from "@/utils/browser";
import { VideoCache } from "@/services/video-cache/service";
import type {
	PreviewRendererMode,
	RendererCapabilities,
} from "@/services/renderer/webgpu-types";
import { getRendererCapabilities } from "@/services/renderer/scene-partition";
import type { TextTrack, TimelineTrack } from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import type { TBackground, TCanvasSize } from "@/types/project";
import { isGeneratedCaptionElement } from "@/lib/captions/caption-track";
import { transcodeTransparentOverlayExport } from "@/services/export-transcoding/service";
import {
	getPreviewCanvasSize,
	remapCaptionTransformsForPreviewVariant,
	remapSquareSourceVideoTransformsForSquarePreview,
	remapVideoAdjustmentsForPreviewVariant,
	resolveSquarePreviewStrategy,
} from "@/lib/preview/preview-format";

const EXPORT_AUDIO_BUILD_TIMEOUT_MS = 20_000;
const SQUARE_EXPORT_BLUR_INTENSITY = 18;
const SQUARE_EXPORT_COVER_OVERSCAN_PERCENT = 103;

function rangesOverlap({
	startA,
	endA,
	startB,
	endB,
}: {
	startA: number;
	endA: number;
	startB: number;
	endB: number;
}): boolean {
	return Math.max(startA, startB) < Math.min(endA, endB);
}

function filterTracksByExportRegion({
	tracks,
	startTime,
	endTime,
}: {
	tracks: TimelineTrack[];
	startTime: number;
	endTime: number;
}): TimelineTrack[] {
	const filteredTracks: TimelineTrack[] = [];

	for (const track of tracks) {
		if (track.type === "video") {
			const elements = track.elements.filter((element) =>
				rangesOverlap({
					startA: element.startTime,
					endA: element.startTime + element.duration,
					startB: startTime,
					endB: endTime,
				}),
			);
			if (elements.length > 0) {
				filteredTracks.push({ ...track, elements });
			}
			continue;
		}

		if (track.type === "text") {
			const elements = track.elements.filter((element) =>
				rangesOverlap({
					startA: element.startTime,
					endA: element.startTime + element.duration,
					startB: startTime,
					endB: endTime,
				}),
			);
			if (elements.length > 0) {
				filteredTracks.push({ ...track, elements });
			}
			continue;
		}

		if (track.type === "audio") {
			const elements = track.elements.filter((element) =>
				rangesOverlap({
					startA: element.startTime,
					endA: element.startTime + element.duration,
					startB: startTime,
					endB: endTime,
				}),
			);
			if (elements.length > 0) {
				filteredTracks.push({ ...track, elements });
			}
			continue;
		}

		const elements = track.elements.filter((element) =>
			rangesOverlap({
				startA: element.startTime,
				endA: element.startTime + element.duration,
				startB: startTime,
				endB: endTime,
			}),
		);
		if (elements.length > 0) {
			filteredTracks.push({ ...track, elements });
		}
	}

	return filteredTracks;
}

export function getLastMediaEndTime({
	tracks,
}: {
	tracks: TimelineTrack[];
}): number {
	let lastMediaEndTime = 0;
	for (const track of tracks) {
		for (const element of track.elements) {
			if (
				element.type !== "video" &&
				element.type !== "audio" &&
				element.type !== "image"
			) {
				continue;
			}
			lastMediaEndTime = Math.max(
				lastMediaEndTime,
				element.startTime + element.duration,
			);
		}
	}
	return lastMediaEndTime;
}

export function filterTracksByExportContent({
	tracks,
	content,
}: {
	tracks: TimelineTrack[];
	content: ExportContent;
}): TimelineTrack[] {
	if (content === "full") return tracks;

	const filteredTracks: TimelineTrack[] = [];
	for (const track of tracks) {
		if (track.type === "audio") {
			filteredTracks.push(track);
			continue;
		}
		if (track.type !== "text") {
			continue;
		}
		const elements = track.elements.filter((element) =>
			isGeneratedCaptionElement(element),
		);
		if (elements.length === 0) continue;
		filteredTracks.push({
			...(track as TextTrack),
			elements,
		});
	}

	return filteredTracks;
}

export function resolveExportRenderPlan({
	tracks,
	mediaAssets,
	projectCanvasSize,
	projectBackground,
	aspect,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	projectCanvasSize: TCanvasSize;
	projectBackground: TBackground;
	aspect: ExportOptions["aspect"];
}): {
	canvasSize: TCanvasSize;
	background: TBackground;
	tracks: TimelineTrack[];
	backgroundReferenceCanvasSize: TCanvasSize;
} {
	if (aspect === "project") {
		return {
			canvasSize: projectCanvasSize,
			background: projectBackground,
			tracks,
			backgroundReferenceCanvasSize: projectCanvasSize,
		};
	}

	const canvasSize = getPreviewCanvasSize({
		projectWidth: projectCanvasSize.width,
		projectHeight: projectCanvasSize.height,
		previewFormatVariant: "square",
	});
	const squarePreviewStrategy = resolveSquarePreviewStrategy({
		tracks,
		mediaAssets,
	});
	const squareCoverScale =
		Math.max(projectCanvasSize.width, projectCanvasSize.height) /
		Math.max(1, Math.min(projectCanvasSize.width, projectCanvasSize.height));
	const background: TBackground =
		squarePreviewStrategy.backgroundMode === "black"
			? {
					type: "color",
					color: "#000000",
			  }
			: squarePreviewStrategy.backgroundMode === "blur"
				? {
						type: "blur",
						blurIntensity: SQUARE_EXPORT_BLUR_INTENSITY,
						blurScale: Math.max(
							1.4,
							squareCoverScale *
								Math.max(1, SQUARE_EXPORT_COVER_OVERSCAN_PERCENT / 100),
						),
				  }
				: projectBackground;

	const captionMappedTracks = remapCaptionTransformsForPreviewVariant({
		tracks,
		sourceCanvas: projectCanvasSize,
		previewCanvas: canvasSize,
	});
	const squareSourceRemappedTracks =
		remapSquareSourceVideoTransformsForSquarePreview({
			tracks: captionMappedTracks,
			mediaAssets,
			sourceCanvas: projectCanvasSize,
		});
	const resolvedTracks = squarePreviewStrategy.remapVideoAdjustments
		? remapVideoAdjustmentsForPreviewVariant({
				tracks: squareSourceRemappedTracks,
				sourceCanvas: projectCanvasSize,
				previewCanvas: canvasSize,
			})
		: squareSourceRemappedTracks;

	return {
		canvasSize,
		background,
		tracks: resolvedTracks,
		backgroundReferenceCanvasSize: projectCanvasSize,
	};
}

export class RendererManager {
	private renderTree: RootNode | null = null;
	private listeners = new Set<() => void>();
	private previewRendererMode: PreviewRendererMode = "auto";

	constructor(private editor: EditorCore) {}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	setPreviewRendererMode({ mode }: { mode: PreviewRendererMode }): void {
		this.previewRendererMode = mode;
		this.notify();
	}

	getPreviewRendererMode(): PreviewRendererMode {
		return this.previewRendererMode;
	}

	getCapabilities(): RendererCapabilities {
		return getRendererCapabilities();
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		try {
			const renderTree = this.getRenderTree();
			const activeProject = this.editor.project.getActive();

			if (!renderTree || !activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;
			const currentTime = this.editor.playback.getCurrentTime();
			const lastFrameTime = getLastFrameTime({ duration, fps });
			const renderTime = Math.min(currentTime, lastFrameTime);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimeCode({
				timeInSeconds: renderTime,
				fps,
			}).replace(/:/g, "-");
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			downloadBlob({ blob, filename });
			return { success: true };
		} catch (error) {
			console.error("Save snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async exportProject({
		options,
	}: {
		options: ExportOptions;
	}): Promise<ExportResult> {
		const { format, quality, fps, includeAudio, onProgress, onCancel } =
			options;
		const isTransparentCaptionsOnly =
			options.content === "captions_only_transparent";
		const shouldIncludeAudio = Boolean(includeAudio) && !isTransparentCaptionsOnly;

		const exportVideoCache = new VideoCache();
		try {
			const timelineTracks = this.editor.timeline.getTracks();
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}
			if (isTransparentCaptionsOnly && format !== "mov") {
				return {
					success: false,
					error:
						"Transparent captions-only export requires QuickTime MOV.",
				};
			}
			if (!isTransparentCaptionsOnly && format === "mov") {
				return {
					success: false,
					error:
						"QuickTime MOV export is only supported for transparent captions overlays.",
				};
			}

			const timelineDuration = this.editor.timeline.getTotalDuration();
			if (timelineDuration === 0) {
				return { success: false, error: "Project is empty" };
			}
			const hasExplicitStartTime = Number.isFinite(options.startTime);
			const hasExplicitEndTime = Number.isFinite(options.endTime);
			const defaultExportEndTime =
				!hasExplicitStartTime && !hasExplicitEndTime
					? Math.max(
							0,
							Math.min(
								timelineDuration,
								getLastMediaEndTime({ tracks: timelineTracks }) || timelineDuration,
							),
						)
					: timelineDuration;
			const requestedStart = Math.max(0, options.startTime ?? 0);
			const requestedEnd = Math.min(
				timelineDuration,
				options.endTime ?? defaultExportEndTime,
			);
			const startTime = Math.min(requestedStart, requestedEnd);
			const endTime = Math.max(startTime, requestedEnd);
			const duration = Math.max(0, endTime - startTime);
			if (duration <= 0) {
				return { success: false, error: "Export range is empty" };
			}
			const regionTracks = filterTracksByExportRegion({
				tracks: timelineTracks,
				startTime,
				endTime,
			});
			const tracks = filterTracksByExportContent({
				tracks: regionTracks,
				content: options.content,
			});
			if (
				options.content === "captions_only_transparent" &&
				!tracks.some((track) => track.type === "text")
			) {
				return {
					success: false,
					error:
						"No generated captions were found in the selected export range.",
				};
			}

			const exportFps = fps || activeProject.settings.fps;
			const renderPlan = resolveExportRenderPlan({
				tracks,
				mediaAssets,
				projectCanvasSize: activeProject.settings.canvasSize,
				projectBackground: activeProject.settings.background,
				aspect: options.aspect,
			});

			let audioBuffer: AudioBuffer | null = null;
			if (shouldIncludeAudio) {
				onProgress?.({ progress: 0.05 });
				try {
					audioBuffer = await Promise.race([
						createTimelineAudioBuffer({
							tracks: regionTracks,
							mediaAssets,
							duration,
							startTime,
						}),
						new Promise<null>((_, reject) => {
							setTimeout(() => {
								reject(
									new Error(
										`Timeline audio build timed out after ${EXPORT_AUDIO_BUILD_TIMEOUT_MS}ms`,
									),
								);
							}, EXPORT_AUDIO_BUILD_TIMEOUT_MS);
						}),
					]);
				} catch (error) {
					console.warn(
						"Export audio preparation failed; continuing without audio:",
						error,
					);
					audioBuffer = null;
				}
			}

			const scene = buildScene({
				tracks: renderPlan.tracks,
				mediaAssets,
				duration: endTime,
				canvasSize: renderPlan.canvasSize,
				backgroundReferenceCanvasSize: renderPlan.backgroundReferenceCanvasSize,
				background: renderPlan.background,
				brandOverlays: activeProject.brandOverlays,
				videoCache: exportVideoCache,
				exportContent: options.content,
			});

			const exporter = new SceneExporter({
				width: renderPlan.canvasSize.width,
				height: renderPlan.canvasSize.height,
				fps: exportFps,
				format: isTransparentCaptionsOnly ? "mkv" : format,
				quality,
				startTime,
				duration,
				shouldIncludeAudio,
				audioBuffer: shouldIncludeAudio ? (audioBuffer ?? undefined) : undefined,
				alpha: isTransparentCaptionsOnly,
			});

			exporter.on("progress", (progress) => {
				const adjustedProgress = shouldIncludeAudio
					? 0.05 + progress * 0.95
					: progress;
				onProgress?.({ progress: adjustedProgress });
			});

			let cancelled = false;
			const checkCancel = () => {
				if (onCancel?.()) {
					cancelled = true;
					exporter.cancel();
				}
			};

			const cancelInterval = setInterval(checkCancel, 100);

			try {
				const buffer = await exporter.export({ rootNode: scene });
				clearInterval(cancelInterval);

				if (cancelled) {
					return { success: false, cancelled: true };
				}

				if (!buffer) {
					return { success: false, error: "Export failed to produce buffer" };
				}
				if (isTransparentCaptionsOnly) {
					onProgress?.({ progress: 0.98 });
					const transcodedBuffer = await transcodeTransparentOverlayExport({
						buffer,
						fileName: `${activeProject.metadata.name || "captions-overlay"}.mkv`,
					});
					onProgress?.({ progress: 1 });
					return {
						success: true,
						buffer: transcodedBuffer,
					};
				}

				return {
					success: true,
					buffer,
				};
			} finally {
				clearInterval(cancelInterval);
			}
		} catch (error) {
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		} finally {
			exportVideoCache.clearAll();
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
