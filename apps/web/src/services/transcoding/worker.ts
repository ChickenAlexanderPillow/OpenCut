import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { MediaType } from "@/types/assets";
import {
	IMPORT_AUDIO_BITRATE,
	IMPORT_TRANSCODE_PROFILE,
	resolveImportVideoProfile,
	type VideoSourceInfo,
} from "./import-profile";

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
				importTranscodeProfile: typeof IMPORT_TRANSCODE_PROFILE;
				importVideoBitrate?: number;
				importAudioBitrate: number;
				importTargetFps?: number;
			};
	  }
	| { type: "error"; requestId: string; error: string };

const ffmpeg = new FFmpeg();
let ffmpegReadyPromise: Promise<void> | null = null;
let currentRequestId: string | null = null;
let ffmpegAssetBaseUrl: string | null = null;
let lastFfmpegErrorLine = "";

function getFileExtension({ fileName }: { fileName: string }): string {
	const extension = fileName.split(".").pop()?.toLowerCase();
	return extension && extension.length > 0 ? extension : "bin";
}

function buildVideoFilter(): string {
	return [
		"scale=w='if(gt(iw,ih),min(1080,iw),-2)':h='if(gt(iw,ih),-2,min(1080,ih))':force_original_aspect_ratio=decrease",
		"scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'",
	].join(",");
}

async function runFfmpegWithTimeout({
	args,
	timeoutMs,
}: {
	args: string[];
	timeoutMs: number;
}): Promise<void> {
	await Promise.race([
		ffmpeg.exec(args),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Transcoding timed out")), timeoutMs),
		),
	]);
}

async function ensureFfmpegLoaded({
	assetBaseUrl,
}: {
	assetBaseUrl?: string;
}): Promise<void> {
	if (assetBaseUrl) {
		ffmpegAssetBaseUrl = assetBaseUrl;
	}
	if (ffmpegReadyPromise) {
		await ffmpegReadyPromise;
		return;
	}

	ffmpegReadyPromise = (async () => {
		ffmpeg.on("progress", ({ progress }) => {
			if (!currentRequestId) return;
			const normalized = Math.round(Math.max(0, Math.min(100, progress * 100)));
			self.postMessage({
				type: "progress",
				requestId: currentRequestId,
				progress: normalized,
			} satisfies WorkerResponse);
		});
		ffmpeg.on("log", ({ type, message }) => {
			if (type === "stderr" && message.trim().length > 0) {
				lastFfmpegErrorLine = message.trim();
			}
		});

		const baseUrl = ffmpegAssetBaseUrl;
		if (!baseUrl) {
			throw new Error("Missing ffmpeg asset base URL");
		}

		await ffmpeg.load({
			coreURL: `${baseUrl}/ffmpeg/ffmpeg-core.js`,
			wasmURL: `${baseUrl}/ffmpeg/ffmpeg-core.wasm`,
		});
	})();

	await ffmpegReadyPromise;
}

async function deleteFsPath({ path }: { path: string }): Promise<void> {
	try {
		await ffmpeg.deleteFile(path);
	} catch {}
}

async function transcode({
	requestId,
	fileName,
	fileData,
	mediaType,
	timeoutMs = 120_000,
	sourceInfo,
}: Omit<WorkerMessage, "type">): Promise<
	Extract<WorkerResponse, { type: "complete" }>
> {
	if (!fileData || fileData.byteLength === 0) {
		throw new Error("Input file is empty");
	}

	lastFfmpegErrorLine = "";

	const extension = getFileExtension({ fileName });
	const inputName = `${requestId}-input.${extension}`;
	const outputName =
		mediaType === "video"
			? `${requestId}-output.mp4`
			: `${requestId}-output.m4a`;

	currentRequestId = requestId;

	try {
		await ffmpeg.writeFile(inputName, new Uint8Array(fileData));

		if (mediaType === "video") {
			const profile = resolveImportVideoProfile({ sourceInfo });
			const maxrate = Math.round(profile.videoBitrate * 1.3);
			const bufsize = Math.round(profile.videoBitrate * 2);
			const gopSize = Math.max(1, profile.targetFps);
			const codecCandidates = ["libx264", "h264", "mpeg4"] as const;
			let encoded = false;
			let lastError: unknown = null;
			for (const codec of codecCandidates) {
				try {
					const args = [
						"-i",
						inputName,
						"-map",
						"0:v:0",
						"-map",
						"0:a:0?",
						"-vf",
						buildVideoFilter(),
						"-fps_mode",
						"cfr",
						"-r",
						String(profile.targetFps),
						"-c:v",
						codec,
						...(codec !== "mpeg4"
							? ([
									"-preset",
									"veryfast",
									"-profile:v",
									"high",
									"-level:v",
									"4.1",
									"-g",
									String(gopSize),
									"-keyint_min",
									String(gopSize),
									"-sc_threshold",
									"0",
								] as const)
							: []),
						"-pix_fmt",
						"yuv420p",
						"-b:v",
						String(profile.videoBitrate),
						"-maxrate",
						String(maxrate),
						"-bufsize",
						String(bufsize),
						"-c:a",
						"aac",
						"-b:a",
						`${Math.round(profile.audioBitrate / 1000)}k`,
						"-ar",
						"48000",
						"-ac",
						"2",
						"-movflags",
						"+faststart",
						outputName,
					];

					await runFfmpegWithTimeout({ args, timeoutMs });
					encoded = true;
					break;
				} catch (error) {
					lastError = error;
				}
			}
			if (!encoded) {
				if (lastError instanceof Error) throw lastError;
				throw new Error("Video transcoding failed for all codec candidates");
			}

			const output = await ffmpeg.readFile(outputName);
			if (typeof output === "string") {
				throw new Error("Unexpected text output while transcoding video");
			}
			const outputData = output;

			return {
				type: "complete",
				requestId,
				fileData: outputData,
				fileName: `${fileName}.transcoded.mp4`,
				mimeType: "video/mp4",
				meta: {
					importTranscoded: true,
					importTranscodeProfile: IMPORT_TRANSCODE_PROFILE,
					importVideoBitrate: profile.videoBitrate,
					importAudioBitrate: profile.audioBitrate,
					importTargetFps: profile.targetFps,
				},
			};
		}

		const args = [
			"-i",
			inputName,
			"-map",
			"0:a:0",
			"-c:a",
			"aac",
			"-b:a",
			`${Math.round(IMPORT_AUDIO_BITRATE / 1000)}k`,
			"-ar",
			"48000",
			"-ac",
			"2",
			"-movflags",
			"+faststart",
			outputName,
		];

		await runFfmpegWithTimeout({ args, timeoutMs });

		const output = await ffmpeg.readFile(outputName);
		if (typeof output === "string") {
			throw new Error("Unexpected text output while transcoding audio");
		}
		const outputData = output;

		return {
			type: "complete",
			requestId,
			fileData: outputData,
			fileName: `${fileName}.transcoded.m4a`,
			mimeType: "audio/mp4",
			meta: {
				importTranscoded: true,
				importTranscodeProfile: IMPORT_TRANSCODE_PROFILE,
				importAudioBitrate: IMPORT_AUDIO_BITRATE,
			},
		};
	} finally {
		await deleteFsPath({ path: inputName });
		await deleteFsPath({ path: outputName });
		currentRequestId = null;
	}
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;
	if (message.type !== "transcode") return;

	try {
		await ensureFfmpegLoaded({ assetBaseUrl: message.assetBaseUrl });
		const response = await transcode(message);
		self.postMessage(response satisfies WorkerResponse);
	} catch (error) {
		const baseMessage =
			error instanceof Error
				? error.message
				: typeof error === "string"
					? error
					: (() => {
							try {
								return JSON.stringify(error);
							} catch {
								return String(error);
							}
						})();
		const enrichedMessage =
			lastFfmpegErrorLine && !baseMessage.includes(lastFfmpegErrorLine)
				? `${baseMessage} (${lastFfmpegErrorLine})`
				: baseMessage;
		self.postMessage({
			type: "error",
			requestId: message.requestId,
			error: enrichedMessage,
		} satisfies WorkerResponse);
	}
};
