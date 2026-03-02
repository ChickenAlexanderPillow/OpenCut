import { webEnv } from "@opencut/env/web";
import { NextResponse } from "next/server";
import { z } from "zod";
import { upsertExternalProject } from "@/lib/external-projects/service";

const MAX_TRANSCRIPT_CHARS = 300_000;
const MAX_SEGMENT_COUNT = 20_000;

const requestSchema = z.object({
	opencutProjectId: z.string().trim().min(1),
	sourceSystem: z.literal("thumbnail_decoupled"),
	externalProjectId: z.string().trim().min(1),
});

const thumbnailProjectSchema = z.object({
	project_id: z.string().trim().min(1),
	name: z.string().optional(),
	mode: z.string().optional(),
	sponsored: z.boolean().optional(),
	transcript: z.string().max(MAX_TRANSCRIPT_CHARS).optional(),
	transcript_segments: z
		.array(
			z.object({
				text: z.string(),
				start: z.number(),
				end: z.number(),
			}),
		)
		.max(MAX_SEGMENT_COUNT)
		.optional(),
	metadata: z
		.object({
			relative_key: z.string().optional(),
			source_file: z.string().optional(),
			source_audio_wav_path: z.string().optional(),
			audioDuration: z.string().optional(),
			inferred_show: z.string().optional(),
		})
		.passthrough()
		.optional(),
});

function parseAudioDurationSeconds(value: string | undefined): number | null {
	if (!value) return null;
	const parts = value.split(":");
	if (parts.length !== 2) return null;
	const mins = Number.parseInt(parts[0] ?? "", 10);
	const secs = Number.parseInt(parts[1] ?? "", 10);
	if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null;
	return mins * 60 + secs;
}

export async function POST(request: Request) {
	if (!webEnv.EXTERNAL_PROJECTS_ENABLED) {
		return NextResponse.json(
			{ error: "External projects integration is disabled" },
			{ status: 503 },
		);
	}

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

	if (!webEnv.THUMBNAIL_API_BASE) {
		return NextResponse.json(
			{ error: "THUMBNAIL_API_BASE is not configured" },
			{ status: 500 },
		);
	}

	try {
		const source = validation.data;
		const endpoint = `${webEnv.THUMBNAIL_API_BASE.replace(/\/+$/, "")}/projects/${encodeURIComponent(source.externalProjectId)}`;
		const response = await fetch(endpoint, {
			method: "GET",
			cache: "no-store",
		});
		if (!response.ok) {
			if (response.status === 404) {
				return NextResponse.json(
					{ error: "Thumbnail project not found" },
					{ status: 404 },
				);
			}
			const text = await response.text();
			throw new Error(`Thumbnail API error (${response.status}): ${text}`);
		}

		const payload = thumbnailProjectSchema.safeParse(await response.json());
		if (!payload.success) {
			return NextResponse.json(
				{
					error: "Thumbnail project response malformed",
					details: payload.error.flatten().fieldErrors,
				},
				{ status: 502 },
			);
		}

		const project = payload.data;
		const transcript = project.transcript ?? "";
		const segments = project.transcript_segments ?? [];
		const relativeKey = project.metadata?.relative_key;
		if (!relativeKey) {
			return NextResponse.json(
				{
					error: "Thumbnail project missing metadata.relative_key",
				},
				{ status: 400 },
			);
		}

		const upserted = await upsertExternalProject({
			opencutProjectId: source.opencutProjectId,
			sourceSystem: source.sourceSystem,
			externalProjectId: project.project_id,
			relativeKey,
			name: project.name,
			mode: project.mode,
			sponsored: project.sponsored,
			show: project.metadata?.inferred_show,
			sourceFilePath: project.metadata?.source_file,
			sourceAudioWavPath: project.metadata?.source_audio_wav_path,
			transcript,
			segments,
			audioDurationSeconds: parseAudioDurationSeconds(
				project.metadata?.audioDuration,
			),
		});

		return NextResponse.json({
			opencutProjectId: upserted.opencutProjectId,
			sourceSystem: source.sourceSystem,
			externalProjectId: project.project_id,
			suitability: upserted.suitability,
		});
	} catch (error) {
		console.error("Failed to link thumbnail project", error);
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "Failed to link project",
			},
			{ status: 500 },
		);
	}
}
