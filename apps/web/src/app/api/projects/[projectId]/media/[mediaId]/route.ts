import { NextResponse } from "next/server";
import { toServerMediaAssetDto } from "@/lib/server-storage/media-dto";
import {
	deleteEditorMediaAsset,
	getEditorMediaAsset,
} from "@/lib/server-storage/repository";
import {
	deleteObjectFromStorage,
	isServerStorageEnabled,
} from "@/lib/server-storage/s3";

export async function GET(
	_request: Request,
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
	if (!asset) {
		return NextResponse.json({ error: "Media asset not found" }, { status: 404 });
	}
	return NextResponse.json({
		asset: toServerMediaAssetDto({ projectId, asset }),
	});
}

export async function DELETE(
	_request: Request,
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
	if (!asset) {
		return NextResponse.json({ success: true });
	}
	await deleteObjectFromStorage({ key: asset.objectKey }).catch(() => undefined);
	if (asset.previewObjectKey) {
		await deleteObjectFromStorage({ key: asset.previewObjectKey }).catch(() => undefined);
	}
	await deleteEditorMediaAsset({ projectId, mediaId });
	return NextResponse.json({ success: true });
}
