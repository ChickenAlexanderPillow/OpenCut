import type { MediaAsset } from "@/types/assets";
import type { TProject, TProjectMetadata } from "@/types/project";
import type { SavedSoundsData, SoundEffect } from "@/types/sounds";

export type StorageBackend = "local";

export interface StorageBackendService {
	saveProject({ project }: { project: TProject }): Promise<void>;
	loadProject({ id }: { id: string }): Promise<{ project: TProject } | null>;
	loadAllProjects(): Promise<TProject[]>;
	loadAllProjectsMetadata(): Promise<TProjectMetadata[]>;
	deleteProject({ id }: { id: string }): Promise<void>;
	saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void>;
	loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null>;
	loadAllMediaAssets({ projectId }: { projectId: string }): Promise<MediaAsset[]>;
	deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void>;
	deleteProjectMedia({ projectId }: { projectId: string }): Promise<void>;
	clearAllData(): Promise<void>;
	getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}>;
	getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}>;
	loadSavedSounds(): Promise<SavedSoundsData>;
	saveSoundEffect({ soundEffect }: { soundEffect: SoundEffect }): Promise<void>;
	removeSavedSound({ soundId }: { soundId: number }): Promise<void>;
	isSoundSaved({ soundId }: { soundId: number }): Promise<boolean>;
	clearSavedSounds(): Promise<void>;
	isOPFSSupported(): boolean;
	isIndexedDBSupported(): boolean;
	isFullySupported(): boolean;
}
