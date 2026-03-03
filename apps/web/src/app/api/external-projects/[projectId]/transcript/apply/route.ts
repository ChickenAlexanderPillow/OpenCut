import { NextResponse } from "next/server";
import { z } from "zod";
import {
	getExternalProjectByOpenCutId,
	getExternalProjectBySource,
} from "@/lib/external-projects/service";
import { evaluateTranscriptSuitability } from "@/lib/external-projects/transcript-suitability";

const requestSchema = z.object({
	sourceSystem: z.literal("thumbnail_decoupled").optional(),
	externalProjectId: z.string().trim().optional(),
});

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	try {
		const { projectId } = await params;
		const validation = requestSchema.safeParse(await request.json());
		if (!validation.success) {
			return NextResponse.json(
				{
					error: "Invalid payload",
					details: validation.error.flatten().fieldErrors,
				},
				{ status: 400 },
			);
		}

		const requestedSource = validation.data.sourceSystem;
		const requestedExternalProjectId = validation.data.externalProjectId?.trim();
		const result =
			requestedSource && requestedExternalProjectId
				? await getExternalProjectBySource({
						sourceSystem: requestedSource,
						externalProjectId: requestedExternalProjectId,
					})
				: await getExternalProjectByOpenCutId({ projectId });
		if (!result || !result.transcript) {
			return NextResponse.json(
				{ error: "Linked transcript not found" },
				{ status: 404 },
			);
		}

		const segments =
			(result.transcript.segmentsJson as Array<{
				text: string;
				start: number;
				end: number;
			}>) ?? [];
		const suitability = evaluateTranscriptSuitability({
			transcriptText: result.transcript.transcriptText,
			segments,
			audioDurationSeconds: result.transcript.audioDurationSeconds,
		});

		return NextResponse.json({
			sourceSystem: result.project.sourceSystem,
			externalProjectId: result.project.externalProjectId,
			transcriptText: result.transcript.transcriptText,
			segments,
			segmentsCount: result.transcript.segmentsCount,
			audioDurationSeconds: result.transcript.audioDurationSeconds,
			qualityMeta: result.transcript.qualityMetaJson,
			updatedAt: result.transcript.updatedAt.toISOString(),
			suitability,
		});
	} catch (error) {
		console.error("Failed to apply linked transcript", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to apply transcript",
			},
			{ status: 500 },
		);
	}
}
