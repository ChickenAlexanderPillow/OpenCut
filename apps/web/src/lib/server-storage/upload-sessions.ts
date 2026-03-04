import { generateUUID } from "@/utils/id";
import { SERVER_STORAGE_UPLOAD_SESSION_TTL_MS } from "./constants";
import type { CompletedPart } from "@aws-sdk/client-s3";

export interface MediaUploadSession {
	uploadId: string;
	projectId: string;
	mediaId: string;
	sourceObjectKey: string;
	previewObjectKey: string | null;
	sourceMultipartUploadId: string;
	previewMultipartUploadId: string | null;
	sourceTotalParts: number;
	previewTotalParts: number | null;
	sourceParts: CompletedPart[];
	previewParts: CompletedPart[];
	expiresAt: number;
	sourceUploadedAt?: number;
	previewUploadedAt?: number;
}

const sessions = new Map<string, MediaUploadSession>();

function cleanupExpired(): void {
	const now = Date.now();
	for (const [sessionId, session] of sessions.entries()) {
		if (session.expiresAt <= now) {
			sessions.delete(sessionId);
		}
	}
}

export function createMediaUploadSession({
	projectId,
	mediaId,
	hasPreview,
	sourceMultipartUploadId,
	previewMultipartUploadId,
	sourceTotalParts,
	previewTotalParts,
}: {
	projectId: string;
	mediaId: string;
	hasPreview: boolean;
	sourceMultipartUploadId: string;
	previewMultipartUploadId: string | null;
	sourceTotalParts: number;
	previewTotalParts: number | null;
}): MediaUploadSession {
	cleanupExpired();
	const uploadId = generateUUID();
	const session: MediaUploadSession = {
		uploadId,
		projectId,
		mediaId,
		sourceObjectKey: `projects/${projectId}/media/${mediaId}/source`,
		previewObjectKey: hasPreview
			? `projects/${projectId}/media/${mediaId}/preview`
			: null,
		sourceMultipartUploadId,
		previewMultipartUploadId: hasPreview ? previewMultipartUploadId : null,
		sourceTotalParts,
		previewTotalParts: hasPreview ? previewTotalParts : null,
		sourceParts: [],
		previewParts: [],
		expiresAt: Date.now() + SERVER_STORAGE_UPLOAD_SESSION_TTL_MS,
	};
	sessions.set(uploadId, session);
	return session;
}

export function getMediaUploadSession({
	uploadId,
	projectId,
}: {
	uploadId: string;
	projectId: string;
}): MediaUploadSession | null {
	cleanupExpired();
	const session = sessions.get(uploadId);
	if (!session) return null;
	if (session.projectId !== projectId) return null;
	if (session.expiresAt <= Date.now()) {
		sessions.delete(uploadId);
		return null;
	}
	return session;
}

export function markUploadPartCompleted({
	uploadId,
	part,
	partNumber,
	etag,
}: {
	uploadId: string;
	part: "source" | "preview";
	partNumber: number;
	etag: string;
}): void {
	const session = sessions.get(uploadId);
	if (!session) return;
	const nextPart: CompletedPart = {
		ETag: etag,
		PartNumber: partNumber,
	};
	if (part === "source") {
		session.sourceParts = [
			...session.sourceParts.filter((item) => item.PartNumber !== partNumber),
			nextPart,
		];
		session.sourceUploadedAt = Date.now();
	} else {
		session.previewParts = [
			...session.previewParts.filter((item) => item.PartNumber !== partNumber),
			nextPart,
		];
		session.previewUploadedAt = Date.now();
	}
	sessions.set(uploadId, session);
}

export function hasAllPartsUploaded({
	session,
	part,
}: {
	session: MediaUploadSession;
	part: "source" | "preview";
}): boolean {
	if (part === "source") {
		return session.sourceParts.length === session.sourceTotalParts;
	}
	if (!session.previewObjectKey) return true;
	const total = session.previewTotalParts ?? 0;
	return session.previewParts.length === total;
}

export function deleteMediaUploadSession({ uploadId }: { uploadId: string }): void {
	sessions.delete(uploadId);
}
