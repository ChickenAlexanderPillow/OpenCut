import type { MediaAssetData } from "@/services/storage/types";
import type { StoredMediaAssetRecord } from "./repository";

export interface ServerMediaAssetDto extends MediaAssetData {
	sourceUrl: string;
	previewSourceUrl?: string;
}

export function toServerMediaAssetDto({
	projectId,
	asset,
}: {
	projectId: string;
	asset: StoredMediaAssetRecord;
}): ServerMediaAssetDto {
	return {
		id: asset.id,
		name: asset.name ?? "media",
		type: (asset.type as MediaAssetData["type"]) ?? "video",
		size: asset.sizeBytes ?? 0,
		lastModified: asset.lastModified ?? Date.now(),
		width: asset.width ?? undefined,
		height: asset.height ?? undefined,
		duration: asset.durationSeconds ?? undefined,
		fps: asset.fps ?? undefined,
		thumbnailUrl: asset.thumbnailUrl ?? undefined,
		previewProxyAvailable: Boolean(asset.previewObjectKey),
		previewProxyWidth: asset.previewProxyWidth ?? undefined,
		previewProxyHeight: asset.previewProxyHeight ?? undefined,
		previewProxyFps: asset.previewProxyFps ?? undefined,
		previewProxyQualityRatio: asset.previewProxyQualityRatio ?? undefined,
		sourceUrl: `/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(asset.id)}/source`,
		previewSourceUrl: asset.previewObjectKey
			? `/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(asset.id)}/preview`
			: undefined,
	};
}
