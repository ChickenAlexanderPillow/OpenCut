import type { MediaAsset } from "@/types/assets";
import type { TProject, TProjectMetadata } from "@/types/project";
import type { SavedSoundsData, SoundEffect } from "@/types/sounds";
import type { StorageBackend, StorageBackendService } from "./backend-types";
import {
	legacyLocalStorageService,
	type LegacyLocalStorageService,
} from "./legacy-local-storage-service";

class StorageService implements StorageBackendService {
	private readonly backend: StorageBackend = "local";
	private readonly localService: LegacyLocalStorageService = legacyLocalStorageService;

	getBackend(): StorageBackend {
		return this.backend;
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		await this.localService.saveProject({ project });
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		return await this.localService.loadProject({ id });
	}

	async loadAllProjects(): Promise<TProject[]> {
		return await this.localService.loadAllProjects();
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		return await this.localService.loadAllProjectsMetadata();
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await this.localService.deleteProject({ id });
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		await this.localService.saveMediaAsset({ projectId, mediaAsset });
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		return await this.localService.loadMediaAsset({ projectId, id });
	}

	async loadAllMediaAssets({
		projectId,
	}: {
		projectId: string;
	}): Promise<MediaAsset[]> {
		return await this.localService.loadAllMediaAssets({ projectId });
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		await this.localService.deleteMediaAsset({ projectId, id });
	}

	async deleteProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		await this.localService.deleteProjectMedia({ projectId });
	}

	async clearAllData(): Promise<void> {
		await this.localService.clearAllData();
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		return await this.localService.getStorageInfo();
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		return await this.localService.getProjectStorageInfo({ projectId });
	}

	async loadSavedSounds(): Promise<SavedSoundsData> {
		return await this.localService.loadSavedSounds();
	}

	async saveSoundEffect({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}): Promise<void> {
		await this.localService.saveSoundEffect({ soundEffect });
	}

	async removeSavedSound({ soundId }: { soundId: number }): Promise<void> {
		await this.localService.removeSavedSound({ soundId });
	}

	async isSoundSaved({ soundId }: { soundId: number }): Promise<boolean> {
		return await this.localService.isSoundSaved({ soundId });
	}

	async clearSavedSounds(): Promise<void> {
		await this.localService.clearSavedSounds();
	}

	isOPFSSupported(): boolean {
		return this.localService.isOPFSSupported();
	}

	isIndexedDBSupported(): boolean {
		if (typeof window === "undefined") return true;
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		return this.localService.isFullySupported();
	}
}

export const storageService = new StorageService();
export { StorageService };
