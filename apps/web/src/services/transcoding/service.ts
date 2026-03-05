import type { MediaType } from "@/types/assets";
import {
	IMPORT_AUDIO_BITRATE,
	IMPORT_TRANSCODE_PROFILE,
	resolveImportVideoProfile,
	type VideoSourceInfo,
} from "./import-profile";

type TranscodeMediaType = Extract<MediaType, "video" | "audio">;

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

function parseOptionalNumber(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

class TranscodingService {
	private transcodeRequest({
		url,
		headers,
		body,
		timeoutMs,
		onProgress,
	}: {
		url: string;
		headers?: Record<string, string>;
		body: FormData | File;
		timeoutMs: number;
		onProgress?: ({ progress }: { progress: number }) => void;
	}): Promise<{
		status: number;
		ok: boolean;
		body: Blob;
		headers: Headers;
		errorText?: string;
	}> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			let waitProgress = 62;
			let waitTimer: number | undefined;
			let isUploadComplete = false;

			const clearWaitTimer = () => {
				if (waitTimer !== undefined) {
					window.clearInterval(waitTimer);
					waitTimer = undefined;
				}
			};

			const startWaitTimer = () => {
				if (waitTimer !== undefined) return;
				waitTimer = window.setInterval(() => {
					if (!isUploadComplete) return;
					waitProgress = Math.min(78, waitProgress + 1);
					onProgress?.({ progress: waitProgress });
				}, 1000);
			};

			xhr.open("POST", url, true);
			xhr.responseType = "blob";
			xhr.timeout = timeoutMs;

			for (const [key, value] of Object.entries(headers ?? {})) {
				xhr.setRequestHeader(key, value);
			}

			xhr.upload.onprogress = (event) => {
				if (!event.lengthComputable || event.total <= 0) return;
				const ratio = Math.max(0, Math.min(1, event.loaded / event.total));
				const mapped = 10 + Math.round(ratio * 50);
				onProgress?.({ progress: mapped });
				if (ratio >= 1) {
					isUploadComplete = true;
					onProgress?.({ progress: Math.max(mapped, 62) });
					startWaitTimer();
				}
			};

			xhr.upload.onloadend = () => {
				isUploadComplete = true;
				onProgress?.({ progress: Math.max(waitProgress, 62) });
				startWaitTimer();
			};

			xhr.onreadystatechange = () => {
				if (xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED) {
					onProgress?.({ progress: Math.max(waitProgress, 80) });
				}
			};

			xhr.onprogress = (event) => {
				if (!event.lengthComputable || event.total <= 0) return;
				const ratio = Math.max(0, Math.min(1, event.loaded / event.total));
				const mapped = 80 + Math.round(ratio * 10);
				onProgress?.({ progress: mapped });
			};

			xhr.onload = () => {
				clearWaitTimer();
				const responseHeaders = new Headers();
				const rawHeaders = xhr.getAllResponseHeaders().trim();
				if (rawHeaders) {
					for (const line of rawHeaders.split(/[\r\n]+/)) {
						const idx = line.indexOf(":");
						if (idx === -1) continue;
						const key = line.slice(0, idx).trim();
						const value = line.slice(idx + 1).trim();
						if (key) responseHeaders.append(key, value);
					}
				}

				let errorText: string | undefined;
				if (!(xhr.status >= 200 && xhr.status < 300)) {
					try {
						errorText = xhr.responseType === "text" ? xhr.responseText : undefined;
					} catch {
						errorText = undefined;
					}
				}

				resolve({
					status: xhr.status,
					ok: xhr.status >= 200 && xhr.status < 300,
					body: xhr.response instanceof Blob ? xhr.response : new Blob(),
					headers: responseHeaders,
					errorText,
				});
			};

			xhr.onerror = () => {
				clearWaitTimer();
				reject(new Error("Transcode request failed during upload or network transfer"));
			};

			xhr.ontimeout = () => {
				clearWaitTimer();
				reject(new Error(`Transcode request timed out after ${timeoutMs}ms`));
			};

			xhr.onabort = () => {
				clearWaitTimer();
				reject(new Error("Transcode request was aborted"));
			};

			xhr.send(body);
		});
	}

	private resolveTranscodeEndpoint(): {
		url: string;
		headers?: Record<string, string>;
		mode: "multipart" | "stream";
	} {
		const directUrlFromEnv = process.env.NEXT_PUBLIC_LOCAL_TRANSCRIBE_URL?.trim();
		const directApiKey = process.env.NEXT_PUBLIC_LOCAL_TRANSCRIBE_API_KEY?.trim();
		if (directUrlFromEnv) {
			return {
				url: `${directUrlFromEnv.replace(/\/$/, "")}/v1/transcode-import-stream`,
				headers: directApiKey ? { Authorization: `Bearer ${directApiKey}` } : undefined,
				mode: "stream",
			};
		}

		if (typeof window !== "undefined") {
			const isLocalhost =
				window.location.hostname === "localhost" ||
				window.location.hostname === "127.0.0.1";
			if (isLocalhost) {
				return {
					url: "http://localhost:8765/v1/transcode-import-stream",
					mode: "stream",
				};
			}
		}

		return { url: "/api/media/transcode", mode: "multipart" };
	}

	async transcodeImportMedia({
		file,
		mediaType,
		sourceInfo,
		onProgress,
		timeoutMs,
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

		onProgress?.({ progress: 2 });

		onProgress?.({ progress: 10 });
		const endpoint = this.resolveTranscodeEndpoint();
		const transcodeTimeoutMs =
			typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
				? Math.round(timeoutMs)
				: 30 * 60 * 1000;

		let requestBody: FormData | File;
		let requestHeaders: Record<string, string> | undefined = endpoint.headers;
		if (endpoint.mode === "stream") {
			requestBody = file;
			requestHeaders = {
				...requestHeaders,
				"x-media-type": mediaType,
				"x-file-name": file.name || "import-media",
				"content-type": file.type || "application/octet-stream",
			};
			if (mediaType === "video") {
				if (
					typeof sourceInfo?.width === "number" &&
					Number.isFinite(sourceInfo.width)
				) {
					requestHeaders["x-source-width"] = String(Math.round(sourceInfo.width));
				}
				if (
					typeof sourceInfo?.height === "number" &&
					Number.isFinite(sourceInfo.height)
				) {
					requestHeaders["x-source-height"] = String(Math.round(sourceInfo.height));
				}
				if (typeof sourceInfo?.fps === "number" && Number.isFinite(sourceInfo.fps)) {
					requestHeaders["x-source-fps"] = String(Math.round(sourceInfo.fps));
				}
			}
		} else {
			const form = new FormData();
			form.append("file", file, file.name || "import-media");
			form.append("media_type", mediaType);
			if (mediaType === "video") {
				if (
					typeof sourceInfo?.width === "number" &&
					Number.isFinite(sourceInfo.width)
				) {
					form.append("source_width", String(Math.round(sourceInfo.width)));
				}
				if (
					typeof sourceInfo?.height === "number" &&
					Number.isFinite(sourceInfo.height)
				) {
					form.append("source_height", String(Math.round(sourceInfo.height)));
				}
				if (typeof sourceInfo?.fps === "number" && Number.isFinite(sourceInfo.fps)) {
					form.append("source_fps", String(Math.round(sourceInfo.fps)));
				}
			}
			requestBody = form;
		}

		const response = await this.transcodeRequest({
			url: endpoint.url,
			headers: requestHeaders,
			body: requestBody,
			timeoutMs: transcodeTimeoutMs,
			onProgress,
		});
		onProgress?.({ progress: 80 });

		if (!response.ok) {
			const detail = (response.errorText || "").trim();
			throw new Error(detail || `Transcode request failed (${response.status})`);
		}

		const payload = response.body;
		if (payload.size <= 0) {
			throw new Error("Transcode response returned empty payload");
		}

		const outputName =
			response.headers.get("x-output-filename") ||
			`${file.name}.transcoded.${mediaType === "video" ? "mp4" : "m4a"}`;
		const contentType =
			response.headers.get("content-type") ||
			(mediaType === "video" ? "video/mp4" : "audio/mp4");

		const fallbackProfile = resolveImportVideoProfile({ sourceInfo });
		const importVideoBitrate = parseOptionalNumber(
			response.headers.get("x-import-video-bitrate"),
		);
		const importAudioBitrate =
			parseOptionalNumber(response.headers.get("x-import-audio-bitrate")) ||
			IMPORT_AUDIO_BITRATE;
		const importTargetFps = parseOptionalNumber(
			response.headers.get("x-import-target-fps"),
		);

		onProgress?.({ progress: 100 });
		return {
			file: new File([payload], outputName, {
				type: contentType,
				lastModified: Date.now(),
			}),
			meta: {
				importTranscoded: true,
				importTranscodeProfile: IMPORT_TRANSCODE_PROFILE,
				importVideoBitrate:
					mediaType === "video"
						? (importVideoBitrate ?? fallbackProfile.videoBitrate)
						: undefined,
				importAudioBitrate,
				importTargetFps:
					mediaType === "video"
						? (importTargetFps ?? fallbackProfile.targetFps)
						: undefined,
			},
		};
	}
}

export const transcodingService = new TranscodingService();
