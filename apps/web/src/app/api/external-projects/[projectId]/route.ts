import { NextResponse } from "next/server";
import { getExternalProjectByOpenCutId } from "@/lib/external-projects/service";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	try {
		const { projectId } = await params;
		const result = await getExternalProjectByOpenCutId({ projectId });
		if (!result) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		return NextResponse.json({
			project: result.project,
			transcript: result.transcript,
		});
	} catch (error) {
		console.error("Failed to load external project", error);
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "Failed to load project",
			},
			{ status: 500 },
		);
	}
}
