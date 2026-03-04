import { NextResponse } from "next/server";
import { z } from "zod";
import { toServerMediaAssetDto } from "@/lib/server-storage/media-dto";
import { upsertEditorMediaAsset } from "@/lib/server-storage/repository";
import {
	completeMultipartUpload,
	isServerStorageEnabled,
} from "@/lib/server-storage/s3";
import {
	deleteMediaUploadSession,
	getMediaUploadSession,
	hasAllPartsUploaded,
} from "@/lib/server-storage/upload-sessions";

const completeUploadSchema = z.object({
	uploadId: z.string().min(1),
	media: z.object({
		id: z.string().min(1),
		name: z.string().min(1),
		type: z.enum(["image", "video", "audio"]).optional(),
		mimeType: z.string().optional(),
		sizeBytes: z.number().int().nonnegative().optional(),
		lastModified: z.number().int().nonnegative().optional(),
		width: z.number().int().positive().optional(),
		height: z.number().int().positive().optional(),
		durationSeconds: z.number().nonnegative().optional(),
		fps: z.number().nonnegative().optional(),
		thumbnailUrl: z.string().optional(),
		previewProxyWidth: z.number().int().positive().optional(),
		previewProxyHeight: z.number().int().positive().optional(),
		previewProxyFps: z.number().nonnegative().optional(),
		previewProxyQualityRatio: z.number().positive().optional(),
		sha256: z.string().optional(),
	}),
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

	const payload = completeUploadSchema.safeParse(await request.json());
	if (!payload.success) {
		return NextResponse.json(
			{ error: "Invalid payload", details: payload.error.flatten().fieldErrors },
			{ status: 400 },
		);
	}

	const { projectId } = await params;
	const { uploadId, media } = payload.data;
	const session = getMediaUploadSession({ uploadId, projectId });
	if (!session) {
		return NextResponse.json(
			{ error: "Upload session not found or expired" },
			{ status: 404 },
		);
	}
	if (session.mediaId !== media.id) {
		return NextResponse.json(
			{ error: "Media id does not match upload session" },
			{ status: 400 },
		);
	}
	if (!hasAllPartsUploaded({ session, part: "source" })) {
		return NextResponse.json(
			{ error: "Source upload is incomplete" },
			{ status: 400 },
		);
	}
	if (session.previewObjectKey && !hasAllPartsUploaded({ session, part: "preview" })) {
		return NextResponse.json(
			{ error: "Preview upload is incomplete" },
			{ status: 400 },
		);
	}

	try {
		await completeMultipartUpload({
			key: session.sourceObjectKey,
			multipartUploadId: session.sourceMultipartUploadId,
			parts: session.sourceParts,
		});
		if (session.previewObjectKey && session.previewMultipartUploadId) {
			await completeMultipartUpload({
				key: session.previewObjectKey,
				multipartUploadId: session.previewMultipartUploadId,
				parts: session.previewParts,
			});
		}

		const storedRecord = {
			id: media.id,
			projectId,
			name: media.name,
			type: media.type ?? null,
			mimeType: media.mimeType ?? null,
			sizeBytes: media.sizeBytes ?? null,
			lastModified: media.lastModified ?? null,
			width: media.width ?? null,
			height: media.height ?? null,
			durationSeconds: media.durationSeconds ?? null,
			fps: media.fps ?? null,
			thumbnailUrl: media.thumbnailUrl ?? null,
			previewProxyWidth: media.previewProxyWidth ?? null,
			previewProxyHeight: media.previewProxyHeight ?? null,
			previewProxyFps: media.previewProxyFps ?? null,
			previewProxyQualityRatio: media.previewProxyQualityRatio ?? null,
			objectKey: session.sourceObjectKey,
			previewObjectKey: session.previewObjectKey,
			sha256: media.sha256 ?? null,
		};
		await upsertEditorMediaAsset({
			record: storedRecord,
		});
		deleteMediaUploadSession({ uploadId: session.uploadId });

		return NextResponse.json({
			asset: toServerMediaAssetDto({
				projectId,
				asset: {
					...storedRecord,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			}),
		});
	} catch (error) {
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to complete media upload",
			},
			{ status: 500 },
		);
	}
}
