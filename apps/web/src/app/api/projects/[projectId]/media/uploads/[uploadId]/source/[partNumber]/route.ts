import { NextResponse } from "next/server";
import { SERVER_STORAGE_PART_SIZE_BYTES } from "@/lib/server-storage/constants";
import { isServerStorageEnabled, uploadMultipartPart } from "@/lib/server-storage/s3";
import {
	getMediaUploadSession,
	markUploadPartCompleted,
} from "@/lib/server-storage/upload-sessions";

export const runtime = "nodejs";

export async function PUT(
	request: Request,
	{
		params,
	}: { params: Promise<{ projectId: string; uploadId: string; partNumber: string }> },
) {
	if (!isServerStorageEnabled()) {
		return NextResponse.json(
			{ error: "Server storage backend is disabled" },
			{ status: 503 },
		);
	}

	const { projectId, uploadId, partNumber } = await params;
	const parsedPartNumber = Number.parseInt(partNumber, 10);
	if (!Number.isFinite(parsedPartNumber) || parsedPartNumber < 1) {
		return NextResponse.json({ error: "Invalid part number" }, { status: 400 });
	}

	const session = getMediaUploadSession({ uploadId, projectId });
	if (!session) {
		return NextResponse.json(
			{ error: "Upload session not found or expired" },
			{ status: 404 },
		);
	}
	if (parsedPartNumber > session.sourceTotalParts) {
		return NextResponse.json(
			{ error: "Part number exceeds source part count" },
			{ status: 400 },
		);
	}

	const arrayBuffer = await request.arrayBuffer();
	const body = new Uint8Array(arrayBuffer);
	if (body.byteLength === 0) {
		return NextResponse.json({ error: "Empty upload part" }, { status: 400 });
	}
	if (body.byteLength > SERVER_STORAGE_PART_SIZE_BYTES) {
		return NextResponse.json(
			{ error: "Upload part exceeds max part size" },
			{ status: 400 },
		);
	}

	try {
		const etag = await uploadMultipartPart({
			key: session.sourceObjectKey,
			multipartUploadId: session.sourceMultipartUploadId,
			partNumber: parsedPartNumber,
			body,
		});

		markUploadPartCompleted({
			uploadId,
			part: "source",
			partNumber: parsedPartNumber,
			etag,
		});

		return NextResponse.json({ success: true, etag });
	} catch (error) {
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to upload source part",
			},
			{ status: 500 },
		);
	}
}
