import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
	externalProjects,
	externalProjectTranscripts,
} from "@/lib/db/schema";
import type { TranscriptionSegment } from "@/types/transcription";
import type { ExternalSourceSystem } from "@/types/external-projects";
import { evaluateTranscriptSuitability } from "@/lib/external-projects/transcript-suitability";

function buildExternalTranscriptKey({
	sourceSystem,
	externalProjectId,
}: {
	sourceSystem: ExternalSourceSystem;
	externalProjectId: string;
}): string {
	return `${sourceSystem}:${externalProjectId}`;
}

export function getDeepLinkForExternalProject({
	opencutProjectId,
	origin,
}: {
	opencutProjectId: string;
	origin: string;
}): string {
	const normalizedOrigin = origin.replace(/\/$/, "");
	return `${normalizedOrigin}/editor/${encodeURIComponent(opencutProjectId)}`;
}

export async function getExternalProjectByOpenCutId({
	projectId,
}: {
	projectId: string;
}) {
	const [project] = await db
		.select()
		.from(externalProjects)
		.where(eq(externalProjects.id, projectId))
		.limit(1);
	if (!project) return null;

	const [transcript] = await db
		.select()
		.from(externalProjectTranscripts)
		.where(eq(externalProjectTranscripts.projectId, projectId))
		.limit(1);

	return {
		project,
		transcript,
	};
}

export async function getExternalProjectBySource({
	sourceSystem,
	externalProjectId,
}: {
	sourceSystem: ExternalSourceSystem;
	externalProjectId: string;
}) {
	const [project] = await db
		.select()
		.from(externalProjects)
		.where(
			and(
				eq(externalProjects.sourceSystem, sourceSystem),
				eq(externalProjects.externalProjectId, externalProjectId),
			),
		)
		.limit(1);
	if (!project) return null;

	const [transcript] = await db
		.select()
		.from(externalProjectTranscripts)
		.where(eq(externalProjectTranscripts.projectId, project.id))
		.limit(1);
	return {
		project,
		transcript,
	};
}

export async function upsertExternalProject({
	opencutProjectId,
	sourceSystem,
	externalProjectId,
	name,
	mode,
	sponsored,
	show,
	sourceFilePath,
	sourceAudioWavPath,
	relativeKey,
	transcript,
	segments,
	audioDurationSeconds,
}: {
	opencutProjectId: string;
	sourceSystem: ExternalSourceSystem;
	externalProjectId: string;
	name?: string;
	mode?: string;
	sponsored?: boolean;
	show?: string;
	sourceFilePath?: string;
	sourceAudioWavPath?: string;
	relativeKey?: string;
	transcript: string;
	segments: TranscriptionSegment[];
	audioDurationSeconds?: number | null;
}) {
	const now = new Date();
	const existingByRelativeKey =
		relativeKey && relativeKey.length > 0
			? (
					await db
						.select()
						.from(externalProjects)
						.where(
							and(
								eq(externalProjects.sourceSystem, sourceSystem),
								eq(externalProjects.relativeKey, relativeKey),
							),
						)
						.limit(1)
				)[0]
			: null;
	const resolvedProjectId = existingByRelativeKey?.id ?? opencutProjectId;
	if (
		existingByRelativeKey &&
		existingByRelativeKey.externalProjectId !== externalProjectId
	) {
		await db
			.update(externalProjects)
			.set({
				externalProjectId,
				name,
				mode,
				sponsored,
				show,
				sourceFilePath,
				sourceAudioWavPath,
				relativeKey,
				updatedAt: now,
			})
			.where(eq(externalProjects.id, existingByRelativeKey.id));
	} else {
		await db
			.insert(externalProjects)
			.values({
				id: resolvedProjectId,
				sourceSystem,
				externalProjectId,
				name,
				mode,
				sponsored,
				show,
				sourceFilePath,
				sourceAudioWavPath,
				relativeKey,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [externalProjects.sourceSystem, externalProjects.externalProjectId],
				set: {
					id: resolvedProjectId,
					name,
					mode,
					sponsored,
					show,
					sourceFilePath,
					sourceAudioWavPath,
					relativeKey,
					updatedAt: now,
				},
			});
	}

	const suitability = evaluateTranscriptSuitability({
		transcriptText: transcript,
		segments,
		audioDurationSeconds: audioDurationSeconds ?? null,
	});

	await db
		.insert(externalProjectTranscripts)
		.values({
			id: `${resolvedProjectId}:transcript`,
			projectId: resolvedProjectId,
			transcriptText: transcript,
			segmentsJson: segments,
			segmentsCount: segments.length,
			audioDurationSeconds:
				typeof audioDurationSeconds === "number"
					? Math.round(audioDurationSeconds)
					: null,
			qualityMetaJson: {
				...suitability,
			},
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [externalProjectTranscripts.id],
			set: {
				transcriptText: transcript,
				segmentsJson: segments,
				segmentsCount: segments.length,
				audioDurationSeconds:
					typeof audioDurationSeconds === "number"
						? Math.round(audioDurationSeconds)
						: null,
				qualityMetaJson: {
					...suitability,
				},
				updatedAt: now,
			},
		});

	return {
		opencutProjectId: resolvedProjectId,
		externalTranscriptCacheKey: buildExternalTranscriptKey({
			sourceSystem,
			externalProjectId,
		}),
		suitability,
	};
}
