import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { editorMediaAssets } from "@/lib/db/schema";
import { toServerMediaAssetDto } from "@/lib/server-storage/media-dto";
import {
	deleteObjectFromStorage,
	isServerStorageEnabled,
} from "@/lib/server-storage/s3";
import { listEditorMediaAssets } from "@/lib/server-storage/repository";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	if (!isServerStorageEnabled()) {
		return NextResponse.json(
			{ error: "Server storage backend is disabled" },
			{ status: 503 },
		);
	}

	const { projectId } = await params;
	const assets = await listEditorMediaAssets({ projectId });
	return NextResponse.json({
		assets: assets.map((asset) => toServerMediaAssetDto({ projectId, asset })),
	});
}

export async function DELETE(
	_request: Request,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	if (!isServerStorageEnabled()) {
		return NextResponse.json(
			{ error: "Server storage backend is disabled" },
			{ status: 503 },
		);
	}

	const { projectId } = await params;
	const assets = await listEditorMediaAssets({ projectId });
	for (const asset of assets) {
		await deleteObjectFromStorage({ key: asset.objectKey }).catch(() => undefined);
		if (asset.previewObjectKey) {
			await deleteObjectFromStorage({ key: asset.previewObjectKey }).catch(() => undefined);
		}
	}
	await db
		.delete(editorMediaAssets)
		.where(eq(editorMediaAssets.projectId, projectId));
	return NextResponse.json({ success: true });
}
