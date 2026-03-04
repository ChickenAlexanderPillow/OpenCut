import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getEditorMediaAsset } from "@/lib/server-storage/repository";
import { getObjectFromStorage, isServerStorageEnabled } from "@/lib/server-storage/s3";

export const runtime = "nodejs";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ projectId: string; mediaId: string }> },
) {
	if (!isServerStorageEnabled()) {
		return NextResponse.json(
			{ error: "Server storage backend is disabled" },
			{ status: 503 },
		);
	}

	const { projectId, mediaId } = await params;
	const asset = await getEditorMediaAsset({ projectId, mediaId });
	if (!asset || !asset.previewObjectKey) {
		return NextResponse.json({ error: "Preview media not found" }, { status: 404 });
	}

	const range = request.headers.get("range") ?? undefined;
	const object = await getObjectFromStorage({ key: asset.previewObjectKey, range });
	if (!object) {
		return NextResponse.json({ error: "Preview media not found" }, { status: 404 });
	}

	return new NextResponse(
		Readable.toWeb(object.body) as unknown as ReadableStream,
		{
		status: range && object.contentRange ? 206 : 200,
		headers: {
			"Content-Type": object.contentType || "video/mp4",
			"Accept-Ranges": object.acceptRanges || "bytes",
			...(typeof object.contentRange === "string"
				? { "Content-Range": object.contentRange }
				: {}),
			"Cache-Control": "private, max-age=120",
			...(typeof object.contentLength === "number"
				? { "Content-Length": String(object.contentLength) }
				: {}),
		},
		},
	);
}
