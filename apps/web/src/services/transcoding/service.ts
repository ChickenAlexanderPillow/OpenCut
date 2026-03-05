import type { MediaType } from "@/types/assets";
import type { VideoSourceInfo } from "./import-profile";

type TranscodeMediaType = Extract<MediaType, "video" | "audio">;

type WorkerMessage = {
	type: "transcode";
	requestId: string;
	fileName: string;
	fileData: ArrayBuffer;
	mediaType: TranscodeMediaType;
	timeoutMs?: number;
	sourceInfo?: VideoSourceInfo;
	assetBaseUrl?: string;
};

type WorkerResponse =
	| { type: "progress"; requestId: string; progress: number }
	| {
			type: "complete";
			requestId: string;
			fileData: Uint8Array;
			fileName: string;
			mimeType: string;
			meta: {
				importTranscoded: true;
				importTranscodeProfile: "chrome-h264-aac-1080p30";
				importVideoBitrate?: number;
				importAudioBitrate: number;
				importTargetFps?: number;
			};
	  }
	| { type: "error"; requestId: string; error: string };

export interface ImportTranscodeResult {
	file: File;
	meta: {
		importTranscoded: true;
		importTranscodeProfile: "chrome-h264-aac-1080p30";
		importVideoBitrate?: number;
		importAudioBitrate: number;
		importTargetFps?: number;
	};
}

class TranscodingService {
	private worker: Worker | null = null;
	private workerInitError: Error | null = null;

	private getWorker(): Worker {
		if (this.workerInitError) {
			throw this.workerInitError;
		}
		if (this.worker) return this.worker;
		try {
			this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
				type: "module",
			});
		} catch (error) {
			this.workerInitError =
				error instanceof Error
					? error
					: new Error("Failed to initialize transcoding worker");
			throw this.workerInitError;
		}
		return this.worker;
	}

	async transcodeImportMedia({
		file,
		mediaType,
		timeoutMs = 120_000,
		sourceInfo,
		onProgress,
	}: {
		file: File;
		mediaType: TranscodeMediaType;
		timeoutMs?: number;
		sourceInfo?: VideoSourceInfo;
		onProgress?: ({ progress }: { progress: number }) => void;
	}): Promise<ImportTranscodeResult> {
		if (typeof window === "undefined") {
			throw new Error("Transcoding is only available in browser context");
		}
		if (file.size <= 0) {
			throw new Error("Cannot transcode an empty file");
		}

		const worker = this.getWorker();
		const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const fileBuffer = await file.arrayBuffer();

		return new Promise((resolve, reject) => {
			const handleMessage = (event: MessageEvent<WorkerResponse>) => {
				const message = event.data;
				if (message.requestId !== requestId) return;

				if (message.type === "progress") {
					onProgress?.({ progress: message.progress });
					return;
				}

				worker.removeEventListener("message", handleMessage);
				clearTimeout(timeout);

				if (message.type === "error") {
					reject(new Error(message.error));
					return;
				}

				const nextFile = new File([message.fileData], message.fileName, {
					type: message.mimeType,
					lastModified: Date.now(),
				});
				resolve({
					file: nextFile,
					meta: message.meta,
				});
			};

			const timeout = setTimeout(() => {
				worker.removeEventListener("message", handleMessage);
				reject(new Error("Transcoding timed out"));
			}, timeoutMs + 5_000);

			worker.addEventListener("message", handleMessage);
			worker.postMessage(
				{
					type: "transcode",
					requestId,
					fileName: file.name,
					fileData: fileBuffer,
					mediaType,
					timeoutMs,
					sourceInfo,
					assetBaseUrl: window.location.origin,
				} satisfies WorkerMessage,
				[fileBuffer],
			);
		});
	}
}

export const transcodingService = new TranscodingService();
