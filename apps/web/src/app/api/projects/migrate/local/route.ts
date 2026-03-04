import { NextResponse } from "next/server";
import { z } from "zod";
import { upsertEditorProject } from "@/lib/server-storage/repository";
import { isServerStorageEnabled } from "@/lib/server-storage/s3";

const migrateProjectSchema = z.object({
	projectId: z.string().min(1),
	projectName: z.string().min(1),
	project: z.record(z.string(), z.unknown()),
	expectedVersion: z.number().int().positive().optional(),
});

const migrateRequestSchema = z.object({
	projects: z.array(migrateProjectSchema).min(1),
});

export async function POST(request: Request) {
	if (!isServerStorageEnabled()) {
		return NextResponse.json(
			{ error: "Server storage backend is disabled" },
			{ status: 503 },
		);
	}

	const payload = migrateRequestSchema.safeParse(await request.json());
	if (!payload.success) {
		return NextResponse.json(
			{ error: "Invalid payload", details: payload.error.flatten().fieldErrors },
			{ status: 400 },
		);
	}

	const results = await Promise.all(
		payload.data.projects.map(async (project) => {
			const result = await upsertEditorProject({
				projectId: project.projectId,
				name: project.projectName,
				documentJson: project.project,
				expectedVersion: project.expectedVersion,
			});
			return { projectId: project.projectId, conflict: result.conflict };
		}),
	);

	return NextResponse.json({
		imported: results.filter((result) => !result.conflict).length,
		conflicts: results.filter((result) => result.conflict).map((item) => item.projectId),
	});
}
