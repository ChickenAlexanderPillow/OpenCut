import { webEnv } from "@opencut/env/web";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
	getDeepLinkForExternalProject,
	upsertExternalProject,
} from "@/lib/external-projects/service";

const MAX_TRANSCRIPT_CHARS = 300_000;
const MAX_SEGMENT_COUNT = 20_000;

const requestSchema = z.object({
	opencutProjectId: z.string().trim().min(1),
	sourceSystem: z.literal("thumbnail_decoupled"),
	externalProjectId: z.string().trim().min(1),
	relativeKey: z.string().trim().min(1),
	name: z.string().trim().optional(),
	mode: z.string().trim().optional(),
	sponsored: z.boolean().optional(),
	show: z.string().trim().optional(),
	sourceFilePath: z.string().trim().optional(),
	sourceAudioWavPath: z.string().trim().optional(),
	transcript: z.string().min(1).max(MAX_TRANSCRIPT_CHARS),
	segments: z
		.array(
			z.object({
				text: z.string(),
				start: z.number(),
				end: z.number(),
			}),
		)
		.max(MAX_SEGMENT_COUNT),
	audioDurationSeconds: z.number().nonnegative().optional(),
});

function isIngestAuthorized({ request }: { request: NextRequest }): boolean {
	const secret = webEnv.TRANSCRIPT_INGEST_SECRET;
	if (!secret) return false;
	const authHeader = request.headers.get("authorization") ?? "";
	const token = authHeader.startsWith("Bearer ")
		? authHeader.slice("Bearer ".length)
		: "";
	return token.length > 0 && token === secret;
}

export async function POST(request: NextRequest) {
	if (!webEnv.EXTERNAL_PROJECTS_ENABLED) {
		return NextResponse.json(
			{ error: "External projects integration is disabled" },
			{ status: 503 },
		);
	}

	if (!isIngestAuthorized({ request })) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
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

		const result = await upsertExternalProject({
			...validation.data,
			audioDurationSeconds: validation.data.audioDurationSeconds ?? null,
		});
		const deepLink = getDeepLinkForExternalProject({
			opencutProjectId: result.opencutProjectId,
			origin: request.nextUrl.origin,
		});

		console.info("External project upserted", {
			opencutProjectId: result.opencutProjectId,
			sourceSystem: validation.data.sourceSystem,
			externalProjectId: validation.data.externalProjectId,
			relativeKey: validation.data.relativeKey,
			isSuitable: result.suitability.isSuitable,
		});

		return NextResponse.json({
			opencutProjectId: result.opencutProjectId,
			deepLink,
			suitability: result.suitability,
		});
	} catch (error) {
		console.error("External project upsert failed", error);
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "External upsert failed",
			},
			{ status: 500 },
		);
	}
}
