import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { editorMediaAssets, editorProjects } from "@/lib/db/schema";
import type { TProjectMetadata } from "@/types/project";

export interface StoredProjectRecord {
	id: string;
	name: string;
	documentJson: Record<string, unknown>;
	documentVersion: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface StoredMediaAssetRecord {
	id: string;
	projectId: string;
	name: string | null;
	type: string | null;
	mimeType: string | null;
	sizeBytes: number | null;
	lastModified: number | null;
	width: number | null;
	height: number | null;
	durationSeconds: number | null;
	fps: number | null;
	thumbnailUrl: string | null;
	previewProxyWidth: number | null;
	previewProxyHeight: number | null;
	previewProxyFps: number | null;
	previewProxyQualityRatio: number | null;
	objectKey: string;
	previewObjectKey: string | null;
	sha256: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export async function listEditorProjectsMetadata(): Promise<TProjectMetadata[]> {
	const rows = await db
		.select()
		.from(editorProjects)
		.orderBy(asc(editorProjects.updatedAt));

	return rows
		.map((row) => {
			const metadataRaw = (
				(row.documentJson?.metadata as Record<string, unknown> | undefined) ?? {}
			);
			const durationRaw = metadataRaw.duration;
			const thumbnailRaw = metadataRaw.thumbnail;
			const thumbnail =
				typeof thumbnailRaw === "string"
					? // Protect project list endpoint from huge inline thumbnails.
						thumbnailRaw.startsWith("data:") && thumbnailRaw.length > 200_000
						? undefined
						: thumbnailRaw
					: undefined;
			return {
				id: row.id,
				name:
					typeof metadataRaw.name === "string" && metadataRaw.name.trim().length > 0
						? metadataRaw.name
						: row.name,
				thumbnail,
				duration: typeof durationRaw === "number" ? durationRaw : 0,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			} satisfies TProjectMetadata;
		})
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function getEditorProject({
	projectId,
}: {
	projectId: string;
}): Promise<StoredProjectRecord | null> {
	const rows = await db
		.select()
		.from(editorProjects)
		.where(eq(editorProjects.id, projectId))
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	return row;
}

export async function upsertEditorProject({
	projectId,
	name,
	documentJson,
	expectedVersion,
}: {
	projectId: string;
	name: string;
	documentJson: Record<string, unknown>;
	expectedVersion?: number;
}): Promise<{ version: number; conflict: boolean }> {
	const now = new Date();
	const existing = await getEditorProject({ projectId });

	if (!existing) {
		await db.insert(editorProjects).values({
			id: projectId,
			name,
			documentJson,
			documentVersion: 1,
			createdAt: now,
			updatedAt: now,
		});
		return { version: 1, conflict: false };
	}

	if (typeof expectedVersion === "number" && expectedVersion !== existing.documentVersion) {
		return { version: existing.documentVersion, conflict: true };
	}

	const nextVersion = existing.documentVersion + 1;
	const updateResult = await db
		.update(editorProjects)
		.set({
			name,
			documentJson,
			documentVersion: nextVersion,
			updatedAt: now,
		})
		.where(
			and(
				eq(editorProjects.id, projectId),
				typeof expectedVersion === "number"
					? eq(editorProjects.documentVersion, expectedVersion)
					: sql`true`,
			),
		)
		.returning({ id: editorProjects.id });

	if (typeof expectedVersion === "number" && updateResult.length === 0) {
		const latest = await getEditorProject({ projectId });
		return {
			version: latest?.documentVersion ?? nextVersion,
			conflict: true,
		};
	}

	return { version: nextVersion, conflict: false };
}

export async function deleteEditorProject({
	projectId,
}: {
	projectId: string;
}): Promise<void> {
	await db.delete(editorProjects).where(eq(editorProjects.id, projectId));
}

export async function listEditorMediaAssets({
	projectId,
}: {
	projectId: string;
}): Promise<StoredMediaAssetRecord[]> {
	return await db
		.select()
		.from(editorMediaAssets)
		.where(eq(editorMediaAssets.projectId, projectId))
		.orderBy(asc(editorMediaAssets.createdAt));
}

export async function getEditorMediaAsset({
	projectId,
	mediaId,
}: {
	projectId: string;
	mediaId: string;
}): Promise<StoredMediaAssetRecord | null> {
	const rows = await db
		.select()
		.from(editorMediaAssets)
		.where(
			and(
				eq(editorMediaAssets.projectId, projectId),
				eq(editorMediaAssets.id, mediaId),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

export async function upsertEditorMediaAsset({
	record,
}: {
	record: Omit<StoredMediaAssetRecord, "createdAt" | "updatedAt">;
}): Promise<void> {
	const now = new Date();
	await db
		.insert(editorMediaAssets)
		.values({
			...record,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [editorMediaAssets.projectId, editorMediaAssets.id],
			set: {
				...record,
				updatedAt: now,
			},
		});
}

export async function deleteEditorMediaAsset({
	projectId,
	mediaId,
}: {
	projectId: string;
	mediaId: string;
}): Promise<void> {
	await db
		.delete(editorMediaAssets)
		.where(
			and(
				eq(editorMediaAssets.projectId, projectId),
				eq(editorMediaAssets.id, mediaId),
			),
		);
}
