import { toast } from "sonner";
import type { MediaAsset } from "@/types/assets";
import { getMediaTypeFromFile } from "@/lib/media/media-utils";
import { getVideoInfo } from "./mediabunny";
import { createVideoProxy } from "@/lib/media/proxy";
import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from "mediabunny";

export interface ProcessedMediaAsset extends Omit<MediaAsset, "id"> {}

const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_MAX_HEIGHT = 720;
const VIDEO_PROXY_RACE_BUFFER_MS = 5_000;
const VIDEO_PROXY_ATTEMPTS = [
	{
		qualityRatio: 0.55,
		resolutionRatio: 0.6,
		maxFps: 30,
		timeoutMs: 120_000,
	},
	{
		qualityRatio: 0.5,
		resolutionRatio: 0.45,
		maxFps: 24,
		timeoutMs: 240_000,
	},
	{
		qualityRatio: 0.5,
		resolutionRatio: 0.35,
		maxFps: 15,
		timeoutMs: 600_000,
	},
] as const;

function withTimeout<T>({
	promise,
	timeoutMs,
}: {
	promise: Promise<T>;
	timeoutMs: number;
}): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			reject(new Error("Timed out"));
		}, timeoutMs);
		void promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				window.clearTimeout(timer);
				reject(error);
			},
		);
	});
}

const getThumbnailSize = ({
	width,
	height,
}: {
	width: number;
	height: number;
}): { width: number; height: number } => {
	const aspectRatio = width / height;
	let targetWidth = width;
	let targetHeight = height;

	if (targetWidth > THUMBNAIL_MAX_WIDTH) {
		targetWidth = THUMBNAIL_MAX_WIDTH;
		targetHeight = Math.round(targetWidth / aspectRatio);
	}
	if (targetHeight > THUMBNAIL_MAX_HEIGHT) {
		targetHeight = THUMBNAIL_MAX_HEIGHT;
		targetWidth = Math.round(targetHeight * aspectRatio);
	}

	return { width: targetWidth, height: targetHeight };
};

const renderToThumbnailDataUrl = ({
	width,
	height,
	draw,
}: {
	width: number;
	height: number;
	draw: ({
		context,
		width,
		height,
	}: {
		context: CanvasRenderingContext2D;
		width: number;
		height: number;
	}) => void;
}): string => {
	const size = getThumbnailSize({ width, height });
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	const context = canvas.getContext("2d");

	if (!context) {
		throw new Error("Could not get canvas context");
	}

	draw({ context, width: size.width, height: size.height });
	return canvas.toDataURL("image/jpeg", 0.8);
};

export async function generateThumbnail({
	videoFile,
	timeInSeconds,
}: {
	videoFile: File;
	timeInSeconds: number;
}): Promise<string> {
	const input = new Input({
		source: new BlobSource(videoFile),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) {
		throw new Error("No video track found in the file");
	}

	const canDecode = await videoTrack.canDecode();
	if (!canDecode) {
		throw new Error("Video codec not supported for decoding");
	}

	const sink = new VideoSampleSink(videoTrack);

	const frame = await sink.getSample(timeInSeconds);

	if (!frame) {
		throw new Error("Could not get frame at specified time");
	}

	try {
		return renderToThumbnailDataUrl({
			width: videoTrack.displayWidth,
			height: videoTrack.displayHeight,
			draw: ({ context, width, height }) => {
				frame.draw(context, 0, 0, width, height);
			},
		});
	} finally {
		frame.close();
	}
}

export async function generateImageThumbnail({
	imageFile,
}: {
	imageFile: File;
}): Promise<string> {
	return new Promise((resolve, reject) => {
		const image = new window.Image();
		const objectUrl = URL.createObjectURL(imageFile);

		image.addEventListener("load", () => {
			try {
				const dataUrl = renderToThumbnailDataUrl({
					width: image.naturalWidth,
					height: image.naturalHeight,
					draw: ({ context, width, height }) => {
						context.drawImage(image, 0, 0, width, height);
					},
				});
				resolve(dataUrl);
			} catch (error) {
				reject(
					error instanceof Error ? error : new Error("Could not render image"),
				);
			} finally {
				URL.revokeObjectURL(objectUrl);
				image.remove();
			}
		});

		image.addEventListener("error", () => {
			URL.revokeObjectURL(objectUrl);
			image.remove();
			reject(new Error("Could not load image"));
		});

		image.src = objectUrl;
	});
}

export async function processMediaAssets({
	files,
	onProgress,
}: {
	files: FileList | File[];
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<ProcessedMediaAsset[]> {
	const fileArray = Array.from(files);
	const processedAssets: ProcessedMediaAsset[] = [];

	const total = fileArray.length;
	let completed = 0;

	const reportOverallProgress = ({
		fileIndex,
		fileProgress,
	}: {
		fileIndex: number;
		fileProgress: number;
	}) => {
		if (!onProgress || total <= 0) return;
		const clampedFileProgress = Math.max(0, Math.min(100, fileProgress));
		const overall = ((fileIndex + clampedFileProgress / 100) / total) * 100;
		onProgress({ progress: Math.round(Math.max(0, Math.min(100, overall))) });
	};

	for (let fileIndex = 0; fileIndex < fileArray.length; fileIndex++) {
		const file = fileArray[fileIndex];
		const fileType = getMediaTypeFromFile({ file });
		reportOverallProgress({ fileIndex, fileProgress: 2 });

		if (!fileType) {
			toast.error(`Unsupported file type: ${file.name}`);
			reportOverallProgress({ fileIndex, fileProgress: 100 });
			continue;
		}

		const url = URL.createObjectURL(file);
		let thumbnailUrl: string | undefined;
		let duration: number | undefined;
		let width: number | undefined;
		let height: number | undefined;
		let fps: number | undefined;
		let previewFile: File | undefined;
		let previewUrl: string | undefined;
		let previewProxyWidth: number | undefined;
		let previewProxyHeight: number | undefined;
		let previewProxyFps: number | undefined;
		let previewProxyQualityRatio: number | undefined;

		try {
			if (fileType === "image") {
				reportOverallProgress({ fileIndex, fileProgress: 15 });
				const dimensions = await getImageDimensions({ file });
				width = dimensions.width;
				height = dimensions.height;
				reportOverallProgress({ fileIndex, fileProgress: 55 });
				thumbnailUrl = await generateImageThumbnail({ imageFile: file });
				reportOverallProgress({ fileIndex, fileProgress: 95 });
			} else if (fileType === "video") {
				reportOverallProgress({ fileIndex, fileProgress: 8 });
				const videoInfo = await getVideoInfo({ videoFile: file });
				duration = videoInfo.duration;
				width = videoInfo.width;
				height = videoInfo.height;
				fps = Number.isFinite(videoInfo.fps)
					? Math.round(videoInfo.fps)
					: undefined;
				reportOverallProgress({ fileIndex, fileProgress: 28 });

				try {
					thumbnailUrl = await generateThumbnail({
						videoFile: file,
						timeInSeconds: 1,
					});
				} catch (error) {
					console.warn("Thumbnail generation failed; continuing import.", error);
				}
				reportOverallProgress({ fileIndex, fileProgress: 40 });

				const proxy = await createRequiredVideoProxyWithProgress({
					file,
					onProgress: ({ progress }) => {
						// Proxy generation owns the majority of work for video ingest.
						// Map proxy [0-100] into file stage [40-95].
						const mapped = 40 + (Math.max(0, Math.min(100, progress)) / 100) * 55;
						reportOverallProgress({ fileIndex, fileProgress: mapped });
					},
				});
				previewFile = proxy.file;
				previewUrl = URL.createObjectURL(proxy.file);
				previewProxyWidth = proxy.width;
				previewProxyHeight = proxy.height;
				previewProxyFps = proxy.fps;
				previewProxyQualityRatio = proxy.qualityRatio;
				reportOverallProgress({ fileIndex, fileProgress: 95 });
			} else if (fileType === "audio") {
				// For audio, we don't set width/height/fps (they'll be undefined)
				reportOverallProgress({ fileIndex, fileProgress: 25 });
				duration = await getMediaDuration({ file });
				reportOverallProgress({ fileIndex, fileProgress: 95 });
			}

			processedAssets.push({
				name: file.name,
				type: fileType,
				file,
				url,
				previewFile,
				previewUrl,
				thumbnailUrl,
				duration,
				width,
				height,
				fps,
				previewProxyWidth,
				previewProxyHeight,
				previewProxyFps,
				previewProxyQualityRatio,
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			completed += 1;
			reportOverallProgress({ fileIndex, fileProgress: 100 });
		} catch (error) {
			console.error("Error processing file:", file.name, error);
			toast.error(`Failed to process ${file.name}`);
			URL.revokeObjectURL(url); // Clean up on error
			if (previewUrl) {
				URL.revokeObjectURL(previewUrl);
			}
			reportOverallProgress({ fileIndex, fileProgress: 100 });
		}
	}

	return processedAssets;
}

async function createRequiredVideoProxyWithProgress({
	file,
	onProgress,
}: {
	file: File;
	onProgress?: ({ progress }: { progress: number }) => void;
}) {
	let lastError: unknown = null;

	for (let i = 0; i < VIDEO_PROXY_ATTEMPTS.length; i++) {
		const attempt = VIDEO_PROXY_ATTEMPTS[i];
		try {
			return await withTimeout({
				promise: createVideoProxy({
					file,
					qualityRatio: attempt.qualityRatio,
					resolutionRatio: attempt.resolutionRatio,
					maxFps: attempt.maxFps,
					timeoutMs: attempt.timeoutMs,
					onProgress: ({ progress }) => {
						// Keep progress monotonic across retries.
						const attemptStart = (i / VIDEO_PROXY_ATTEMPTS.length) * 100;
						const attemptSpan = 100 / VIDEO_PROXY_ATTEMPTS.length;
						const mapped =
							attemptStart +
							(Math.max(0, Math.min(100, progress)) / 100) * attemptSpan;
						onProgress?.({ progress: mapped });
					},
				}),
				timeoutMs: attempt.timeoutMs + VIDEO_PROXY_RACE_BUFFER_MS,
			});
		} catch (error) {
			lastError = error;
			console.warn(
				`Proxy generation attempt ${i + 1}/${VIDEO_PROXY_ATTEMPTS.length} failed for ${file.name}`,
				error,
			);
		}
	}

	if (lastError instanceof Error) {
		throw new Error(
			`Failed to generate preview proxy for ${file.name}: ${lastError.message}`,
		);
	}
	throw new Error(`Failed to generate preview proxy for ${file.name}`);
}

const getImageDimensions = ({
	file,
}: {
	file: File;
}): Promise<{ width: number; height: number }> => {
	return new Promise((resolve, reject) => {
		const img = new window.Image();
		const objectUrl = URL.createObjectURL(file);

		img.addEventListener("load", () => {
			const width = img.naturalWidth;
			const height = img.naturalHeight;
			resolve({ width, height });
			URL.revokeObjectURL(objectUrl);
			img.remove();
		});

		img.addEventListener("error", () => {
			reject(new Error("Could not load image"));
			URL.revokeObjectURL(objectUrl);
			img.remove();
		});

		img.src = objectUrl;
	});
};

const getMediaDuration = ({ file }: { file: File }): Promise<number> => {
	return new Promise((resolve, reject) => {
		const element = document.createElement(
			file.type.startsWith("video/") ? "video" : "audio",
		) as HTMLVideoElement;
		const objectUrl = URL.createObjectURL(file);

		element.addEventListener("loadedmetadata", () => {
			resolve(element.duration);
			URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.addEventListener("error", () => {
			reject(new Error("Could not load media"));
			URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.src = objectUrl;
		element.load();
	});
};
