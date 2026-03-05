import { toast } from "sonner";
import type { MediaAsset } from "@/types/assets";
import { getMediaTypeFromFile } from "@/lib/media/media-utils";
import { getVideoInfo } from "./mediabunny";
import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from "mediabunny";
import { transcodingService } from "@/services/transcoding/service";

export interface ProcessedMediaAsset extends Omit<MediaAsset, "id"> {}

const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_MAX_HEIGHT = 720;
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
		const sourceFile = fileArray[fileIndex];
		const fileType = getMediaTypeFromFile({ file: sourceFile });
		reportOverallProgress({ fileIndex, fileProgress: 2 });

		if (!fileType) {
			toast.error(`Unsupported file type: ${sourceFile.name}`);
			reportOverallProgress({ fileIndex, fileProgress: 100 });
			continue;
		}

		let file = sourceFile;
		let importTranscoded: boolean | undefined;
		let importTranscodeProfile: "chrome-h264-aac-1080p30" | undefined;
		let importVideoBitrate: number | undefined;
		let importAudioBitrate: number | undefined;
		let importTargetFps: number | undefined;

		if (fileType === "video" || fileType === "audio") {
			reportOverallProgress({ fileIndex, fileProgress: 10 });
			try {
				const transcoded = await transcodingService.transcodeImportMedia({
					file: sourceFile,
					mediaType: fileType,
					onProgress: ({ progress }) => {
						const mappedProgress = 10 + Math.round(progress * 0.7);
						reportOverallProgress({ fileIndex, fileProgress: mappedProgress });
					},
				});
				file = transcoded.file;
				importTranscoded = transcoded.meta.importTranscoded;
				importTranscodeProfile = transcoded.meta.importTranscodeProfile;
				importVideoBitrate = transcoded.meta.importVideoBitrate;
				importAudioBitrate = transcoded.meta.importAudioBitrate;
				importTargetFps = transcoded.meta.importTargetFps;
			} catch (error) {
				console.error("Failed to transcode media during import:", sourceFile.name, error);
				const details = error instanceof Error ? error.message : "Unknown error";
				toast.error(
					`Failed to transcode ${sourceFile.name}; file was not imported. ${details}`,
				);
				reportOverallProgress({ fileIndex, fileProgress: 100 });
				continue;
			}
		}

		const url = URL.createObjectURL(file);
		let thumbnailUrl: string | undefined;
		let duration: number | undefined;
		let width: number | undefined;
		let height: number | undefined;
		let fps: number | undefined;
		try {
			if (fileType === "image") {
				reportOverallProgress({ fileIndex, fileProgress: 15 });
				try {
					const dimensions = await getImageDimensions({ file });
					width = dimensions.width;
					height = dimensions.height;
				} catch (error) {
					console.warn("Image dimension probing failed; continuing import.", error);
				}
				reportOverallProgress({ fileIndex, fileProgress: 55 });
				try {
					thumbnailUrl = await generateImageThumbnail({ imageFile: file });
				} catch (error) {
					console.warn("Image thumbnail generation failed; continuing import.", error);
				}
				reportOverallProgress({ fileIndex, fileProgress: 95 });
			} else if (fileType === "video") {
				reportOverallProgress({ fileIndex, fileProgress: 82 });
				try {
					const videoInfo = await getVideoInfo({ videoFile: file });
					duration = videoInfo.duration;
					width = videoInfo.width;
					height = videoInfo.height;
					fps = Number.isFinite(videoInfo.fps)
						? Math.round(videoInfo.fps)
						: undefined;
				} catch (error) {
					console.warn(
						"Video probing via mediabunny failed; falling back to HTML metadata.",
						error,
					);
					try {
						const htmlMetadata = await getVideoMetadata({ file });
						duration = htmlMetadata.duration;
						width = htmlMetadata.width;
						height = htmlMetadata.height;
						fps = htmlMetadata.fps;
					} catch (fallbackError) {
						console.warn(
							"Video metadata fallback failed; continuing import with limited metadata.",
							fallbackError,
						);
					}
				}
				reportOverallProgress({ fileIndex, fileProgress: 90 });

				try {
					thumbnailUrl = await generateThumbnail({
						videoFile: file,
						timeInSeconds: 1,
					});
				} catch (error) {
					console.warn("Thumbnail generation failed; continuing import.", error);
				}
				reportOverallProgress({ fileIndex, fileProgress: 94 });

				reportOverallProgress({ fileIndex, fileProgress: 95 });
			} else if (fileType === "audio") {
				// For audio, we don't set width/height/fps (they'll be undefined)
				reportOverallProgress({ fileIndex, fileProgress: 82 });
				try {
					duration = await getMediaDuration({ file });
				} catch (error) {
					console.warn("Audio duration probing failed; continuing import.", error);
				}
				reportOverallProgress({ fileIndex, fileProgress: 95 });
			}

			processedAssets.push({
				name: sourceFile.name,
				type: fileType,
				file,
				url,
				thumbnailUrl,
				duration,
				width,
				height,
				fps,
				importTranscoded,
				importTranscodeProfile,
				importVideoBitrate,
				importAudioBitrate,
				importTargetFps,
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			reportOverallProgress({ fileIndex, fileProgress: 100 });
		} catch (error) {
			console.error("Error processing file:", sourceFile.name, error);
			toast.error(`Failed to process ${sourceFile.name}`);
			URL.revokeObjectURL(url); // Clean up on error
			reportOverallProgress({ fileIndex, fileProgress: 100 });
		}
	}

	return processedAssets;
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

const getVideoMetadata = ({
	file,
}: {
	file: File;
}): Promise<{
	duration: number;
	width: number;
	height: number;
	fps: number | undefined;
}> => {
	return new Promise((resolve, reject) => {
		const video = document.createElement("video");
		const objectUrl = URL.createObjectURL(file);

		video.preload = "metadata";
		video.muted = true;
		video.playsInline = true;

		video.addEventListener("loadedmetadata", () => {
			const duration = Number.isFinite(video.duration) ? video.duration : 0;
			const width = video.videoWidth;
			const height = video.videoHeight;
			const qualityInfo = (
				video as HTMLVideoElement & {
					getVideoPlaybackQuality?: () => { totalVideoFrames?: number };
					webkitDecodedFrameCount?: number;
				}
			).getVideoPlaybackQuality?.();
			const decodedFrameCount =
				qualityInfo?.totalVideoFrames ??
				(video as HTMLVideoElement & { webkitDecodedFrameCount?: number })
					.webkitDecodedFrameCount;
			const fps =
				duration > 0 && decodedFrameCount && decodedFrameCount > 0
					? Math.round(decodedFrameCount / duration)
					: undefined;

			resolve({ duration, width, height, fps });
			URL.revokeObjectURL(objectUrl);
			video.remove();
		});

		video.addEventListener("error", () => {
			reject(new Error("Could not load video metadata"));
			URL.revokeObjectURL(objectUrl);
			video.remove();
		});

		video.src = objectUrl;
		video.load();
	});
};
