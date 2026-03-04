import type { MediaAssetData } from "@/services/storage/types";

export interface ServerProjectListItemDto {
	id: string;
	name: string;
	thumbnail?: string;
	duration: number;
	createdAt: string;
	updatedAt: string;
}

export interface ServerMediaAssetDto extends MediaAssetData {
	sourceUrl: string;
	previewSourceUrl?: string;
}

export interface UploadInitDto {
	uploadId: string;
	partSizeBytes: number;
	maxParallelParts: number;
	source: {
		totalParts: number;
	};
	preview: {
		totalParts: number;
	} | null;
}
