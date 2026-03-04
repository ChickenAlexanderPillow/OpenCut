import { DEFAULT_BRAND_OVERLAYS } from "@/constants/brand-overlay-constants";
import { getProjectDurationFromScenes } from "@/lib/scenes";
import {
	SERVER_STORAGE_MAX_PARALLEL_PARTS,
	SERVER_STORAGE_PART_SIZE_BYTES,
} from "@/lib/server-storage/constants";
import type { ServerMediaAssetDto } from "@/lib/server-storage/media-dto";
import type { MediaAsset } from "@/types/assets";
import type { TProject, TProjectMetadata } from "@/types/project";
import type { SavedSoundsData, SoundEffect } from "@/types/sounds";
import type { Bookmark, TimelineTrack } from "@/types/timeline";
import type {
	SerializedProject,
	SerializedScene,
} from "./types";
import type {
	StorageBackend,
	StorageBackendService,
} from "./backend-types";
import type { LegacyLocalStorageService } from "./legacy-local-storage-service";

const MAX_UPLOAD_RETRIES = 3;
const RETRY_BACKOFF_BASE_MS = 250;
const MISSING_MEDIA_RECOVERY_TIMEOUT_MS = 4_000;

interface UploadInitResponse {
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

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") return { time: item };
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: obj.time,
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && { duration: obj.duration }),
			};
		})
		.filter((bookmark): bookmark is Bookmark => bookmark !== null);
}

function stripAudioBuffers({
	tracks,
}: {
	tracks: TimelineTrack[];
}): TimelineTrack[] {
	return tracks.map((track) => {
		if (track.type !== "audio") return track;
		return {
			...track,
			elements: track.elements.map((element) => {
				const { buffer: _buffer, ...rest } = element;
				return rest;
			}),
		};
	});
}

function serializeProject({
	project,
}: {
	project: TProject;
}): SerializedProject {
	const duration =
		project.metadata.duration ??
		getProjectDurationFromScenes({ scenes: project.scenes });
	const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
		id: scene.id,
		name: scene.name,
		isMain: scene.isMain,
		tracks: stripAudioBuffers({ tracks: scene.tracks }),
		bookmarks: scene.bookmarks,
		createdAt: scene.createdAt.toISOString(),
		updatedAt: scene.updatedAt.toISOString(),
	}));

	return {
		metadata: {
			id: project.metadata.id,
			name: project.metadata.name,
			thumbnail: project.metadata.thumbnail,
			duration,
			createdAt: project.metadata.createdAt.toISOString(),
			updatedAt: project.metadata.updatedAt.toISOString(),
		},
		scenes: serializedScenes,
		currentSceneId: project.currentSceneId,
		settings: project.settings,
		brandOverlays: project.brandOverlays ?? {
			selectedBrandId: DEFAULT_BRAND_OVERLAYS.selectedBrandId,
			logo: { ...DEFAULT_BRAND_OVERLAYS.logo },
		},
		version: project.version,
		timelineViewState: project.timelineViewState,
		transcriptionCache: project.transcriptionCache,
		clipTranscriptCache: project.clipTranscriptCache,
		clipWordTranscriptionCache: project.clipWordTranscriptionCache,
		clipGenerationCache: project.clipGenerationCache,
		externalProjectLink: project.externalProjectLink,
		externalMediaLinks: project.externalMediaLinks,
		externalTranscriptCache: project.externalTranscriptCache,
	};
}

function deserializeProject({
	serializedProject,
}: {
	serializedProject: SerializedProject;
}): TProject {
	const scenes =
		serializedProject.scenes?.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: (scene.tracks ?? []).map((track) =>
				track.type === "video"
					? { ...track, isMain: track.isMain ?? false }
					: track,
			),
			bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})) ?? [];

	return {
		metadata: {
			id: serializedProject.metadata.id,
			name: serializedProject.metadata.name,
			thumbnail: serializedProject.metadata.thumbnail,
			duration:
				serializedProject.metadata.duration ??
				getProjectDurationFromScenes({ scenes }),
			createdAt: new Date(serializedProject.metadata.createdAt),
			updatedAt: new Date(serializedProject.metadata.updatedAt),
		},
		scenes,
		currentSceneId: serializedProject.currentSceneId || "",
		settings: serializedProject.settings,
		brandOverlays: {
			selectedBrandId:
				serializedProject.brandOverlays?.selectedBrandId ??
				DEFAULT_BRAND_OVERLAYS.selectedBrandId,
			logo: {
				...DEFAULT_BRAND_OVERLAYS.logo,
				...(serializedProject.brandOverlays?.logo ?? {}),
			},
		},
		version: serializedProject.version,
		timelineViewState: serializedProject.timelineViewState,
		transcriptionCache: serializedProject.transcriptionCache,
		clipTranscriptCache: serializedProject.clipTranscriptCache,
		clipWordTranscriptionCache: serializedProject.clipWordTranscriptionCache,
		clipGenerationCache: serializedProject.clipGenerationCache,
		externalProjectLink: serializedProject.externalProjectLink,
		externalMediaLinks: serializedProject.externalMediaLinks,
		externalTranscriptCache: serializedProject.externalTranscriptCache,
	};
}

async function sleep({ ms }: { ms: number }): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export class ServerStorageService implements StorageBackendService {
	private projectVersionCache = new Map<string, number>();

	constructor(private legacyLocalStorageService: LegacyLocalStorageService) {}

	getBackend(): StorageBackend {
		return "server";
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		const serializedProject = serializeProject({ project });
		const expectedVersion = this.projectVersionCache.get(project.metadata.id);
		const response = await fetch(
			`/api/projects/${encodeURIComponent(project.metadata.id)}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				cache: "no-store",
				body: JSON.stringify({
					projectName: project.metadata.name,
					project: serializedProject,
					expectedVersion,
				}),
			},
		);

		if (response.status === 409) {
			const payload = (await response.json()) as { latestVersion?: number };
			if (typeof payload.latestVersion === "number") {
				this.projectVersionCache.set(project.metadata.id, payload.latestVersion);
			}
			throw new Error("Project update conflict. Reload the project and try again.");
		}
		if (!response.ok) {
			throw new Error(await this.getResponseError({ response }));
		}

		const payload = (await response.json()) as { version?: number };
		if (typeof payload.version === "number") {
			this.projectVersionCache.set(project.metadata.id, payload.version);
		}
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
			method: "GET",
			cache: "no-store",
		});
		if (response.status === 404) return null;
		if (!response.ok) {
			throw new Error(await this.getResponseError({ response }));
		}
		const payload = (await response.json()) as {
			project: SerializedProject;
			version?: number;
		};
		if (typeof payload.version === "number") {
			this.projectVersionCache.set(id, payload.version);
		}
		const project = deserializeProject({ serializedProject: payload.project });
		await this.recoverMissingMediaAssets({ project });
		return { project };
	}

	async loadAllProjects(): Promise<TProject[]> {
		const metadata = await this.loadAllProjectsMetadata();
		const projects: TProject[] = [];
		for (const item of metadata) {
			const loaded = await this.loadProject({ id: item.id });
			if (loaded?.project) {
				projects.push(loaded.project);
			}
		}
		return projects;
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		const response = await fetch("/api/projects", {
			method: "GET",
			cache: "no-store",
		});
		if (!response.ok) {
			throw new Error(await this.getResponseError({ response }));
		}
		const payload = (await response.json()) as {
			projects: Array<{
				id: string;
				name: string;
				thumbnail?: string;
				duration: number;
				createdAt: string;
				updatedAt: string;
			}>;
		};
		return payload.projects.map((project) => ({
			id: project.id,
			name: project.name,
			thumbnail: project.thumbnail,
			duration: project.duration,
			createdAt: new Date(project.createdAt),
			updatedAt: new Date(project.updatedAt),
		}));
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
			method: "DELETE",
			cache: "no-store",
		});
		if (!response.ok) {
			throw new Error(await this.getResponseError({ response }));
		}
		this.projectVersionCache.delete(id);
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		const initResponse = await fetch(
			`/api/projects/${encodeURIComponent(projectId)}/media/uploads/init`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				cache: "no-store",
				body: JSON.stringify({
					mediaId: mediaAsset.id,
					source: {
						size: mediaAsset.file.size,
						mimeType: mediaAsset.file.type || "application/octet-stream",
					},
					preview: mediaAsset.previewFile
						? {
								size: mediaAsset.previewFile.size,
								mimeType: mediaAsset.previewFile.type || "video/mp4",
							}
						: undefined,
				}),
			},
		);
		if (!initResponse.ok) {
			throw new Error(await this.getResponseError({ response: initResponse }));
		}
		const initPayload = (await initResponse.json()) as UploadInitResponse;
		const partSizeBytes =
			typeof initPayload.partSizeBytes === "number"
				? initPayload.partSizeBytes
				: SERVER_STORAGE_PART_SIZE_BYTES;
		const maxParallelParts =
			typeof initPayload.maxParallelParts === "number"
				? initPayload.maxParallelParts
				: SERVER_STORAGE_MAX_PARALLEL_PARTS;

		await this.uploadFileParts({
			file: mediaAsset.file,
			totalParts: initPayload.source.totalParts,
			partSizeBytes,
			maxParallelParts,
			partUrlFactory: (partNumber) =>
				`/api/projects/${encodeURIComponent(projectId)}/media/uploads/${encodeURIComponent(initPayload.uploadId)}/source/${partNumber}`,
		});

		if (mediaAsset.previewFile && initPayload.preview?.totalParts) {
			await this.uploadFileParts({
				file: mediaAsset.previewFile,
				totalParts: initPayload.preview.totalParts,
				partSizeBytes,
				maxParallelParts,
				partUrlFactory: (partNumber) =>
					`/api/projects/${encodeURIComponent(projectId)}/media/uploads/${encodeURIComponent(initPayload.uploadId)}/preview/${partNumber}`,
			});
		}

		const completeResponse = await fetch(
			`/api/projects/${encodeURIComponent(projectId)}/media/uploads/complete`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				cache: "no-store",
				body: JSON.stringify({
					uploadId: initPayload.uploadId,
					media: {
						id: mediaAsset.id,
						name: mediaAsset.name,
						type: mediaAsset.type,
						mimeType: mediaAsset.file.type || "application/octet-stream",
						sizeBytes: mediaAsset.file.size,
						lastModified: mediaAsset.file.lastModified,
						width: mediaAsset.width,
						height: mediaAsset.height,
						durationSeconds: mediaAsset.duration,
						fps: mediaAsset.fps,
						thumbnailUrl: mediaAsset.thumbnailUrl,
						previewProxyWidth: mediaAsset.previewProxyWidth,
						previewProxyHeight: mediaAsset.previewProxyHeight,
						previewProxyFps: mediaAsset.previewProxyFps,
						previewProxyQualityRatio: mediaAsset.previewProxyQualityRatio,
					},
				}),
			},
		);
		if (!completeResponse.ok) {
			throw new Error(await this.getResponseError({ response: completeResponse }));
		}
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const response = await fetch(
			`/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(id)}`,
			{
				method: "GET",
				cache: "no-store",
			},
		);
		if (response.status === 404) return null;
		if (!response.ok) {
			throw new Error(await this.getResponseError({ response }));
		}
		const payload = (await response.json()) as { asset: ServerMediaAssetDto };
		return await this.loadMediaAssetFromDto({ asset: payload.asset });
	}

	async loadAllMediaAssets({
		projectId,
	}: {
		projectId: string;
	}): Promise<MediaAsset[]> {
		const response = await fetch(
			`/api/projects/${encodeURIComponent(projectId)}/media`,
			{
				method: "GET",
				cache: "no-store",
			},
		);
		if (!response.ok) {
			throw new Error(await this.getResponseError({ response }));
		}
		const payload = (await response.json()) as { assets: ServerMediaAssetDto[] };
		const assets: MediaAsset[] = [];
		for (const asset of payload.assets) {
			const loaded = await this.loadMediaAssetFromDto({ asset });
			if (loaded) {
				assets.push(loaded);
			}
		}
		return assets;
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const response = await fetch(
			`/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(id)}`,
			{
				method: "DELETE",
				cache: "no-store",
			},
		);
		if (!response.ok) {
			throw new Error(await this.getResponseError({ response }));
		}
	}

	async deleteProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		const response = await fetch(
			`/api/projects/${encodeURIComponent(projectId)}/media`,
			{
				method: "DELETE",
				cache: "no-store",
			},
		);
		if (!response.ok) {
			throw new Error(await this.getResponseError({ response }));
		}
	}

	async clearAllData(): Promise<void> {
		const projects = await this.loadAllProjectsMetadata();
		for (const project of projects) {
			await this.deleteProject({ id: project.id });
		}
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const projects = await this.loadAllProjectsMetadata();
		return {
			projects: projects.length,
			isOPFSSupported: false,
			isIndexedDBSupported: true,
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const response = await fetch(
			`/api/projects/${encodeURIComponent(projectId)}/media`,
			{
				method: "GET",
				cache: "no-store",
			},
		);
		if (!response.ok) {
			throw new Error(await this.getResponseError({ response }));
		}
		const payload = (await response.json()) as { assets: ServerMediaAssetDto[] };
		return { mediaItems: payload.assets.length };
	}

	async loadSavedSounds(): Promise<SavedSoundsData> {
		return this.legacyLocalStorageService.loadSavedSounds();
	}

	async saveSoundEffect({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}): Promise<void> {
		await this.legacyLocalStorageService.saveSoundEffect({ soundEffect });
	}

	async removeSavedSound({ soundId }: { soundId: number }): Promise<void> {
		await this.legacyLocalStorageService.removeSavedSound({ soundId });
	}

	async isSoundSaved({ soundId }: { soundId: number }): Promise<boolean> {
		return await this.legacyLocalStorageService.isSoundSaved({ soundId });
	}

	async clearSavedSounds(): Promise<void> {
		await this.legacyLocalStorageService.clearSavedSounds();
	}

	isOPFSSupported(): boolean {
		return false;
	}

	isIndexedDBSupported(): boolean {
		return true;
	}

	isFullySupported(): boolean {
		return true;
	}

	private async uploadFileParts({
		file,
		totalParts,
		partSizeBytes,
		maxParallelParts,
		partUrlFactory,
	}: {
		file: File;
		totalParts: number;
		partSizeBytes: number;
		maxParallelParts: number;
		partUrlFactory: (partNumber: number) => string;
	}): Promise<void> {
		const partNumbers = Array.from({ length: totalParts }, (_, index) => index + 1);
		let cursor = 0;

		const worker = async () => {
			while (true) {
				const nextIndex = cursor;
				cursor += 1;
				if (nextIndex >= partNumbers.length) return;

				const partNumber = partNumbers[nextIndex];
				const start = (partNumber - 1) * partSizeBytes;
				const end = Math.min(start + partSizeBytes, file.size);
				const chunk = file.slice(start, end);
				await this.uploadPartWithRetry({
					url: partUrlFactory(partNumber),
					body: chunk,
				});
			}
		};

		const workerCount = Math.max(
			1,
			Math.min(maxParallelParts, partNumbers.length),
		);
		await Promise.all(
			Array.from({ length: workerCount }, () => worker()),
		);
	}

	private async uploadPartWithRetry({
		url,
		body,
	}: {
		url: string;
		body: Blob;
	}): Promise<void> {
		let attempt = 0;
		while (attempt < MAX_UPLOAD_RETRIES) {
			attempt += 1;
			const response = await fetch(url, {
				method: "PUT",
				cache: "no-store",
				headers: {
					"Content-Type": "application/octet-stream",
				},
				body,
			});
			if (response.ok) return;
			if (attempt >= MAX_UPLOAD_RETRIES) {
				throw new Error(await this.getResponseError({ response }));
			}
			await sleep({
				ms: RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1),
			});
		}
	}

	private async loadMediaAssetFromDto({
		asset,
	}: {
		asset: ServerMediaAssetDto;
	}): Promise<MediaAsset | null> {
		const sourceResponse = await fetch(asset.sourceUrl, {
			method: "GET",
			cache: "no-store",
		});
		if (!sourceResponse.ok) return null;

		const sourceBlob = await sourceResponse.blob();
		const sourceFile = new File([sourceBlob], asset.name, {
			type: sourceBlob.type || "application/octet-stream",
			lastModified: asset.lastModified,
		});
		const sourceUrl = URL.createObjectURL(sourceFile);

		let previewFile: File | undefined;
		let previewUrl: string | undefined;
		if (asset.previewSourceUrl) {
			const previewResponse = await fetch(asset.previewSourceUrl, {
				method: "GET",
				cache: "no-store",
			});
			if (previewResponse.ok) {
				const previewBlob = await previewResponse.blob();
				previewFile = new File([previewBlob], `${asset.name}.preview`, {
					type: previewBlob.type || "video/mp4",
					lastModified: asset.lastModified,
				});
				previewUrl = URL.createObjectURL(previewFile);
			}
		}

		return {
			id: asset.id,
			name: asset.name,
			type: asset.type,
			file: sourceFile,
			url: sourceUrl,
			previewFile,
			previewUrl,
			width: asset.width,
			height: asset.height,
			duration: asset.duration,
			fps: asset.fps,
			thumbnailUrl: asset.thumbnailUrl,
			ephemeral: asset.ephemeral,
			previewProxyWidth: asset.previewProxyWidth,
			previewProxyHeight: asset.previewProxyHeight,
			previewProxyFps: asset.previewProxyFps,
			previewProxyQualityRatio: asset.previewProxyQualityRatio,
		};
	}

	private async getResponseError({
		response,
	}: {
		response: Response;
	}): Promise<string> {
		try {
			const payload = (await response.json()) as { error?: string };
			if (typeof payload.error === "string" && payload.error.length > 0) {
				return payload.error;
			}
		} catch {
			// ignore json parse failures
		}
		return `Request failed (${response.status})`;
	}

	private collectReferencedMediaIds({ project }: { project: TProject }): string[] {
		const referenced = new Set<string>();

		for (const scene of project.scenes ?? []) {
			for (const track of scene.tracks ?? []) {
				for (const element of track.elements ?? []) {
					const mediaId = (element as { mediaId?: unknown }).mediaId;
					if (typeof mediaId === "string" && mediaId.length > 0) {
						referenced.add(mediaId);
					}
				}
			}
		}

		for (const mediaId of Object.keys(project.clipGenerationCache ?? {})) {
			if (mediaId.length > 0) referenced.add(mediaId);
		}

		for (const mediaId of Object.keys(project.externalMediaLinks ?? {})) {
			if (mediaId.length > 0) referenced.add(mediaId);
		}

		return Array.from(referenced);
	}

	private async recoverMissingMediaAssets({
		project,
	}: {
		project: TProject;
	}): Promise<void> {
		const referencedMediaIds = this.collectReferencedMediaIds({ project });
		if (referencedMediaIds.length === 0) return;

		const response = await fetch(
			`/api/projects/${encodeURIComponent(project.metadata.id)}/media`,
			{
				method: "GET",
				cache: "no-store",
			},
		);
		if (!response.ok) return;

		const payload = (await response.json()) as { assets: ServerMediaAssetDto[] };
		const serverMediaIds = new Set(payload.assets.map((asset) => asset.id));
		const missingMediaIds = referencedMediaIds.filter(
			(mediaId) => !serverMediaIds.has(mediaId),
		);
		if (missingMediaIds.length === 0) return;

		let repairedCount = 0;
		for (const mediaId of missingMediaIds) {
			const legacyMediaAsset = await this.loadLegacyMediaAssetWithTimeout({
				projectId: project.metadata.id,
				mediaId,
			});
			if (!legacyMediaAsset) continue;

			try {
				await this.saveMediaAsset({
					projectId: project.metadata.id,
					mediaAsset: legacyMediaAsset,
				});
				repairedCount += 1;
			} catch (error) {
				console.warn(
					`Failed to recover missing media asset ${mediaId} for project ${project.metadata.id}.`,
					error,
				);
			} finally {
				if (legacyMediaAsset.url) {
					URL.revokeObjectURL(legacyMediaAsset.url);
				}
				if (legacyMediaAsset.previewUrl) {
					URL.revokeObjectURL(legacyMediaAsset.previewUrl);
				}
			}
		}

		if (repairedCount > 0) {
			console.info(
				`Recovered ${repairedCount} missing media asset(s) for project ${project.metadata.id}.`,
			);
		}
	}

	private async loadLegacyMediaAssetWithTimeout({
		projectId,
		mediaId,
	}: {
		projectId: string;
		mediaId: string;
	}): Promise<MediaAsset | null> {
		const loadPromise = this.legacyLocalStorageService.loadMediaAsset({
			projectId,
			id: mediaId,
		});
		const timeoutPromise = new Promise<null>((resolve) => {
			globalThis.setTimeout(
				() => resolve(null),
				MISSING_MEDIA_RECOVERY_TIMEOUT_MS,
			);
		});

		try {
			return await Promise.race([loadPromise, timeoutPromise]);
		} catch {
			return null;
		}
	}
}
