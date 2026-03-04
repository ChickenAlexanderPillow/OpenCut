import { NextResponse } from "next/server";
import { z } from "zod";
import {
	listEditorProjectsMetadata,
	upsertEditorProject,
} from "@/lib/server-storage/repository";
import { isServerStorageEnabled } from "@/lib/server-storage/s3";

const upsertProjectSchema = z.object({
	projectId: z.string().min(1),
	projectName: z.string().min(1),
	project: z.record(z.string(), z.unknown()),
	expectedVersion: z.number().int().positive().optional(),
});

export async function GET() {
	if (!isServerStorageEnabled()) {
		return NextResponse.json({ projects: [] });
	}

	const projects = await listEditorProjectsMetadata();
	return NextResponse.json({ projects });
}

export async function POST(request: Request) {
	if (!isServerStorageEnabled()) {
		return NextResponse.json(
			{ error: "Server storage backend is disabled" },
			{ status: 503 },
		);
	}

	const payload = upsertProjectSchema.safeParse(await request.json());
	if (!payload.success) {
		return NextResponse.json(
			{ error: "Invalid payload", details: payload.error.flatten().fieldErrors },
			{ status: 400 },
		);
	}

	const result = await upsertEditorProject({
		projectId: payload.data.projectId,
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
