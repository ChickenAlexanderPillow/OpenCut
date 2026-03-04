import { NextResponse } from "next/server";
import { z } from "zod";
import {
	deleteEditorProject,
	getEditorProject,
	listEditorMediaAssets,
	upsertEditorProject,
} from "@/lib/server-storage/repository";
import {
	deleteObjectFromStorage,
	deleteObjectsByPrefix,
	isServerStorageEnabled,
} from "@/lib/server-storage/s3";

const updateProjectSchema = z.object({
	projectName: z.string().min(1),
	project: z.record(z.string(), z.unknown()),
	expectedVersion: z.number().int().positive().optional(),
});

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
	const project = await getEditorProject({ projectId });
	if (!project) {
		return NextResponse.json({ error: "Project not found" }, { status: 404 });
	}
	return NextResponse.json({
		project: project.documentJson,
		version: project.documentVersion,
	});
}

export async function PUT(
	request: Request,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	if (!isServerStorageEnabled()) {
		return NextResponse.json(
			{ error: "Server storage backend is disabled" },
			{ status: 503 },
		);
	}

	const { projectId } = await params;
	const payload = updateProjectSchema.safeParse(await request.json());
	if (!payload.success) {
		return NextResponse.json(
			{ error: "Invalid payload", details: payload.error.flatten().fieldErrors },
			{ status: 400 },
		);
	}

	const result = await upsertEditorProject({
		projectId,
		name: payload.data.projectName,
		documentJson: payload.data.project,
		expectedVersion: payload.data.expectedVersion,
	});

	if (result.conflict) {
		return NextResponse.json(
			{ error: "Version conflict", latestVersion: result.version },
			{ status: 409 },
		);
	}
	return NextResponse.json({ version: result.version });
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
			await deleteObjectFromStorage({ key: asset.previewObjectKey }).catch(
				() => undefined,
			);
		}
	}
	await deleteObjectsByPrefix({ prefix: `projects/${projectId}/` }).catch(
		() => undefined,
	);
	await deleteEditorProject({ projectId });
	return NextResponse.json({ success: true });
}
