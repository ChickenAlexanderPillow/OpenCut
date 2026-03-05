import { webEnv } from "@opencut/env/web";
import { NextResponse, type NextRequest } from "next/server";

export async function POST(request: NextRequest) {
	try {
		if (!webEnv.LOCAL_TRANSCRIBE_URL) {
			return NextResponse.json(
				{ error: "LOCAL_TRANSCRIBE_URL is not configured" },
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
		const timeoutId = setTimeout(() => controller.abort("Transcode timed out"), timeoutMs);

		try {
			const upstreamHeaders: Record<string, string> = {
				"content-type": contentType,
			};
			if (webEnv.LOCAL_TRANSCRIBE_API_KEY) {
				upstreamHeaders.Authorization = `Bearer ${webEnv.LOCAL_TRANSCRIBE_API_KEY}`;
			}

			const fetchInit: RequestInit & { duplex: "half" } = {
				method: "POST",
				headers: upstreamHeaders,
				body: request.body,
				signal: controller.signal,
				duplex: "half",
			};

			const response = await fetch(
				`${webEnv.LOCAL_TRANSCRIBE_URL.replace(/\/$/, "")}/v1/transcode-import`,
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
			error instanceof Error ? error.message : "Unexpected transcode route error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
