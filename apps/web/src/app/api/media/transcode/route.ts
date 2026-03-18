import { webEnv } from "@opencut/env/web";
import { NextResponse, type NextRequest } from "next/server";

function resolveLocalTranscodeBaseUrl(): string | null {
	return (
		webEnv.LOCAL_TRANSCRIBE_URL ??
		webEnv.NEXT_PUBLIC_LOCAL_TRANSCRIBE_URL ??
		null
	);
}

function resolveLocalTranscodeApiKey(): string | null {
	return (
		webEnv.LOCAL_TRANSCRIBE_API_KEY ??
		webEnv.NEXT_PUBLIC_LOCAL_TRANSCRIBE_API_KEY ??
		null
	);
}

function getOptionalFormValue(
	formData: FormData,
	key: string,
): string | undefined {
	const value = formData.get(key);
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

export async function POST(request: NextRequest) {
	try {
		const localTranscodeBaseUrl = resolveLocalTranscodeBaseUrl();
		if (!localTranscodeBaseUrl) {
			return NextResponse.json(
				{
					error:
						"LOCAL_TRANSCRIBE_URL or NEXT_PUBLIC_LOCAL_TRANSCRIBE_URL must be configured",
				},
				{ status: 503 },
			);
		}

		const contentType = request.headers.get("content-type") ?? "";
		if (!contentType.includes("multipart/form-data")) {
			return NextResponse.json(
				{ error: "Expected multipart/form-data request body" },
				{ status: 400 },
			);
		}

		const timeoutMs = webEnv.LOCAL_TRANSCODE_TIMEOUT_MS ?? 1800000;
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort("Transcode timed out"),
			timeoutMs,
		);

		try {
			const formData = await request.formData();
			const fileEntry = formData.get("file");
			const mediaType = getOptionalFormValue(formData, "media_type");
			if (!(fileEntry instanceof File)) {
				return NextResponse.json(
					{ error: "file is required" },
					{ status: 400 },
				);
			}
			if (mediaType !== "video" && mediaType !== "audio") {
				return NextResponse.json(
					{ error: "media_type must be video or audio" },
					{ status: 400 },
				);
			}

			const upstreamHeaders: Record<string, string> = {
				"x-media-type": mediaType,
				"x-file-name": fileEntry.name || "import-media",
				"content-type": fileEntry.type || "application/octet-stream",
			};
			const apiKey = resolveLocalTranscodeApiKey();
			if (apiKey) {
				upstreamHeaders.Authorization = `Bearer ${apiKey}`;
			}

			const sourceWidth = getOptionalFormValue(formData, "source_width");
			const sourceHeight = getOptionalFormValue(formData, "source_height");
			const sourceFps = getOptionalFormValue(formData, "source_fps");
			if (sourceWidth) {
				upstreamHeaders["x-source-width"] = sourceWidth;
			}
			if (sourceHeight) {
				upstreamHeaders["x-source-height"] = sourceHeight;
			}
			if (sourceFps) {
				upstreamHeaders["x-source-fps"] = sourceFps;
			}

			const fetchInit: RequestInit & { duplex: "half" } = {
				method: "POST",
				headers: upstreamHeaders,
				body: fileEntry.stream(),
				signal: controller.signal,
				duplex: "half",
			};

			const response = await fetch(
				`${localTranscodeBaseUrl.replace(/\/$/, "")}/v1/transcode-import-stream`,
				fetchInit,
			);

			if (!response.ok) {
				const detail = (await response.text()).trim();
				return NextResponse.json(
					{
						error: detail || `Transcode service failed (${response.status})`,
					},
					{ status: response.status },
				);
			}

			const payload = await response.arrayBuffer();
			const headers = new Headers();
			headers.set(
				"content-type",
				response.headers.get("content-type") || "application/octet-stream",
			);

			const passthroughHeaders = [
				"x-import-transcoded",
				"x-import-transcode-profile",
				"x-import-video-bitrate",
				"x-import-audio-bitrate",
				"x-import-target-fps",
				"x-output-filename",
				"x-video-encoder",
			] as const;
			for (const key of passthroughHeaders) {
				const value = response.headers.get(key);
				if (value) headers.set(key, value);
			}

			return new NextResponse(payload, {
				status: 200,
				headers,
			});
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Unexpected transcode route error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
