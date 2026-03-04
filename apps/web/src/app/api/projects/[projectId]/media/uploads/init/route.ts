import { NextResponse } from "next/server";
import { z } from "zod";
import {
	SERVER_STORAGE_MAX_PARALLEL_PARTS,
	SERVER_STORAGE_PART_SIZE_BYTES,
} from "@/lib/server-storage/constants";
import {
	abortMultipartUpload,
	createMultipartUpload,
	isServerStorageEnabled,
} from "@/lib/server-storage/s3";
import { createMediaUploadSession } from "@/lib/server-storage/upload-sessions";

const initUploadSchema = z.object({
	mediaId: z.string().min(1),
	source: z.object({
		size: z.number().int().positive(),
		mimeType: z.string().optional(),
	}),
	preview: z
		.object({
			size: z.number().int().positive(),
			mimeType: z.string().optional(),
		})
		.optional(),
});

export const runtime = "nodejs";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	if (!isServerStorageEnabled()) {
		return NextResponse.json(
			{ error: "Server storage backend is disabled" },
			{ status: 503 },
		);
	}

	const payload = initUploadSchema.safeParse(await request.json());
	if (!payload.success) {
		return NextResponse.json(
			{ error: "Invalid payload", details: payload.error.flatten().fieldErrors },
			{ status: 400 },
		);
	}

	const { projectId } = await params;
	const { mediaId, source, preview } = payload.data;
	const sourceObjectKey = `projects/${projectId}/media/${mediaId}/source`;
	const previewObjectKey = preview
		? `projects/${projectId}/media/${mediaId}/preview`
		: null;
	const sourceTotalParts = Math.max(
		1,
		Math.ceil(source.size / SERVER_STORAGE_PART_SIZE_BYTES),
	);
	const previewTotalParts = preview
		? Math.max(1, Math.ceil(preview.size / SERVER_STORAGE_PART_SIZE_BYTES))
		: null;

	let sourceMultipartUploadId: string | null = null;
	let previewMultipartUploadId: string | null = null;

	try {
		sourceMultipartUploadId = await createMultipartUpload({
			key: sourceObjectKey,
			contentType: source.mimeType,
		});
		if (previewObjectKey) {
			previewMultipartUploadId = await createMultipartUpload({
				key: previewObjectKey,
				contentType: preview?.mimeType,
			});
		}

		const session = createMediaUploadSession({
			projectId,
			mediaId,
			hasPreview: Boolean(previewObjectKey),
			sourceMultipartUploadId,
			previewMultipartUploadId,
			sourceTotalParts,
			previewTotalParts,
		});

		return NextResponse.json({
			uploadId: session.uploadId,
			partSizeBytes: SERVER_STORAGE_PART_SIZE_BYTES,
			maxParallelParts: SERVER_STORAGE_MAX_PARALLEL_PARTS,
			source: {
				totalParts: sourceTotalParts,
			},
			preview: previewObjectKey
				? {
						totalParts: previewTotalParts,
					}
				: null,
			expiresAt: session.expiresAt,
		});
	} catch (error) {
		if (sourceMultipartUploadId) {
			await abortMultipartUpload({
				key: sourceObjectKey,
				multipartUploadId: sourceMultipartUploadId,
			}).catch(() => undefined);
		}
		if (previewMultipartUploadId && previewObjectKey) {
			await abortMultipartUpload({
				key: previewObjectKey,
				multipartUploadId: previewMultipartUploadId,
			}).catch(() => undefined);
		}

		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to initialize media upload",
			},
			{ status: 500 },
		);
	}
}
