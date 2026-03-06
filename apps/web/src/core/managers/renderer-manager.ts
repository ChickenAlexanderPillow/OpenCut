import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportOptions, ExportResult } from "@/types/export";
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
import type { TimelineTrack } from "@/types/timeline";

const EXPORT_AUDIO_BUILD_TIMEOUT_MS = 20_000;

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

		const exportVideoCache = new VideoCache();
		try {
			const timelineTracks = this.editor.timeline.getTracks();
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const timelineDuration = this.editor.timeline.getTotalDuration();
			if (timelineDuration === 0) {
				return { success: false, error: "Project is empty" };
			}
			const requestedStart = Math.max(0, options.startTime ?? 0);
			const requestedEnd = Math.min(
				timelineDuration,
				options.endTime ?? timelineDuration,
			);
			const startTime = Math.min(requestedStart, requestedEnd);
			const endTime = Math.max(startTime, requestedEnd);
			const duration = Math.max(0, endTime - startTime);
			if (duration <= 0) {
				return { success: false, error: "Export range is empty" };
			}
			const tracks = filterTracksByExportRegion({
				tracks: timelineTracks,
				startTime,
				endTime,
			});

			const exportFps = fps || activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;

			let audioBuffer: AudioBuffer | null = null;
			if (includeAudio) {
				onProgress?.({ progress: 0.05 });
				try {
					audioBuffer = await Promise.race([
						createTimelineAudioBuffer({
							tracks,
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
				tracks,
				mediaAssets,
				duration: endTime,
				canvasSize,
				background: activeProject.settings.background,
				brandOverlays: activeProject.brandOverlays,
				videoCache: exportVideoCache,
			});

			const exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				quality,
				startTime,
				duration,
				shouldIncludeAudio: !!includeAudio,
				audioBuffer: audioBuffer || undefined,
			});

			exporter.on("progress", (progress) => {
				const adjustedProgress = includeAudio
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
