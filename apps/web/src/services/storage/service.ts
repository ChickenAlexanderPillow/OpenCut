import type { MediaAsset } from "@/types/assets";
import type { TProject, TProjectMetadata } from "@/types/project";
import type { SavedSoundsData, SoundEffect } from "@/types/sounds";
import {
	LOCAL_STORAGE_RECLAIM_MARKER,
	LOCAL_TO_SERVER_MIGRATION_MARKER,
} from "@/lib/server-storage/constants";
import type {
	StorageBackend,
	StorageBackendService,
} from "./backend-types";
import { deleteDatabase, IndexedDBAdapter } from "./indexeddb-adapter";
import {
	legacyLocalStorageService,
	type LegacyLocalStorageService,
} from "./legacy-local-storage-service";
import { ServerStorageService } from "./server-storage-service";

function resolveStorageBackend(): StorageBackend {
	const configured = process.env.NEXT_PUBLIC_STORAGE_BACKEND;
	return configured === "local" ? "local" : "server";
}

class StorageService implements StorageBackendService {
	private readonly backend: StorageBackend = resolveStorageBackend();
	private readonly localService: LegacyLocalStorageService = legacyLocalStorageService;
	private readonly serverService = new ServerStorageService(this.localService);
	private localToServerMigrationPromise: Promise<void> | null = null;
	private hasRunMigrationInSession = false;
	private static readonly MIGRATION_GUARD_TIMEOUT_MS = 12_000;
	private static readonly LEGACY_READ_TIMEOUT_MS = 4_000;

	getBackend(): StorageBackend {
		return this.backend;
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		const backend = await this.getProjectBackend();
		await backend.saveProject({ project });
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		const backend = await this.getProjectBackend();
		return await backend.loadProject({ id });
	}

	async loadAllProjects(): Promise<TProject[]> {
		const backend = await this.getProjectBackend();
		return await backend.loadAllProjects();
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		const backend = await this.getProjectBackend();
		return await backend.loadAllProjectsMetadata();
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		const backend = await this.getProjectBackend();
		await backend.deleteProject({ id });
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		const backend = await this.getProjectBackend();
		await backend.saveMediaAsset({ projectId, mediaAsset });
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const backend = await this.getProjectBackend();
		return await backend.loadMediaAsset({ projectId, id });
	}

	async loadAllMediaAssets({
		projectId,
	}: {
		projectId: string;
	}): Promise<MediaAsset[]> {
		const backend = await this.getProjectBackend();
		return await backend.loadAllMediaAssets({ projectId });
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const backend = await this.getProjectBackend();
		await backend.deleteMediaAsset({ projectId, id });
	}

	async deleteProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		const backend = await this.getProjectBackend();
		await backend.deleteProjectMedia({ projectId });
	}

	async clearAllData(): Promise<void> {
		const backend = await this.getProjectBackend();
		await backend.clearAllData();
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const backend = await this.getProjectBackend();
		return await backend.getStorageInfo();
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const backend = await this.getProjectBackend();
		return await backend.getProjectStorageInfo({ projectId });
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
		if (this.backend === "server") return false;
		return this.localService.isOPFSSupported();
	}

	isIndexedDBSupported(): boolean {
		if (typeof window === "undefined") return true;
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		if (this.backend === "server") return true;
		return this.localService.isFullySupported();
	}

	private async getProjectBackend(): Promise<StorageBackendService> {
		if (this.backend === "server") {
			await this.ensureLocalToServerMigration();
			return this.serverService;
		}
		return this.localService;
	}

	private async ensureLocalToServerMigration(): Promise<void> {
		if (this.hasRunMigrationInSession) return;
		if (typeof window === "undefined") {
			this.hasRunMigrationInSession = true;
			return;
		}
		const marker = window.localStorage.getItem(LOCAL_TO_SERVER_MIGRATION_MARKER);
		const reclaimMarker = window.localStorage.getItem(LOCAL_STORAGE_RECLAIM_MARKER);
		if (marker === "done") {
			if (reclaimMarker !== "done") {
				await this.reclaimLegacyLocalStorage();
				window.localStorage.setItem(LOCAL_STORAGE_RECLAIM_MARKER, "done");
			}
			this.hasRunMigrationInSession = true;
			return;
		}

		// If server already has projects, avoid blocking startup on legacy storage scan.
		try {
			const serverProjects = await this.withTimeout({
				promise: this.serverService.loadAllProjectsMetadata(),
				timeoutMs: StorageService.LEGACY_READ_TIMEOUT_MS,
				label: "server project list preflight",
			});
			if (serverProjects.length > 0) {
				window.localStorage.setItem(LOCAL_TO_SERVER_MIGRATION_MARKER, "done");
				window.localStorage.setItem(LOCAL_STORAGE_RECLAIM_MARKER, "done");
				this.hasRunMigrationInSession = true;
				return;
			}
		} catch {
			// Continue with migration attempt below.
		}
		if (this.localToServerMigrationPromise) {
			await this.localToServerMigrationPromise;
			return;
		}

		this.localToServerMigrationPromise = this.withTimeout({
			promise: this.runLocalToServerMigration(),
			timeoutMs: StorageService.MIGRATION_GUARD_TIMEOUT_MS,
			label: "local-to-server migration",
		}).catch((error) => {
			console.warn("Migration guard triggered; continuing with server storage.", error);
			window.localStorage.setItem(LOCAL_TO_SERVER_MIGRATION_MARKER, "done");
			this.hasRunMigrationInSession = true;
		});
		await this.localToServerMigrationPromise;
	}

	private async runLocalToServerMigration(): Promise<void> {
		try {
			let localProjects: TProjectMetadata[] = [];
			try {
				localProjects = await this.withTimeout({
					promise: this.localService.loadAllProjectsMetadata(),
					timeoutMs: StorageService.LEGACY_READ_TIMEOUT_MS,
					label: "legacy local project metadata read",
				});
			} catch (error) {
				console.warn(
					"Local project migration skipped: unable to read legacy local storage.",
					error,
				);
				window.localStorage.setItem(LOCAL_TO_SERVER_MIGRATION_MARKER, "done");
				this.hasRunMigrationInSession = true;
				return;
			}
			if (localProjects.length === 0) {
				window.localStorage.setItem(LOCAL_TO_SERVER_MIGRATION_MARKER, "done");
				this.hasRunMigrationInSession = true;
				return;
			}

			const migratedProjectsPayload: Array<{
				projectId: string;
				projectName: string;
				project: Record<string, unknown>;
			}> = [];
			let hasFailures = false;

			for (const metadata of localProjects) {
				try {
					const loaded = await this.localService.loadProject({ id: metadata.id });
					if (!loaded?.project) {
						continue;
					}
					await this.serverService.saveProject({ project: loaded.project });
					migratedProjectsPayload.push({
						projectId: loaded.project.metadata.id,
						projectName: loaded.project.metadata.name,
						project: loaded.project as unknown as Record<string, unknown>,
					});

					const mediaIds = await this.listLegacyMediaIds({
						projectId: metadata.id,
					});
					for (const mediaId of mediaIds) {
						const mediaAsset = await this.localService.loadMediaAsset({
							projectId: metadata.id,
							id: mediaId,
						});
						if (!mediaAsset) continue;

						await this.serverService.saveMediaAsset({
							projectId: metadata.id,
							mediaAsset,
						});

						// Migration-only object URLs should be revoked immediately.
						if (mediaAsset.url) {
							URL.revokeObjectURL(mediaAsset.url);
						}
						if (mediaAsset.previewUrl) {
							URL.revokeObjectURL(mediaAsset.previewUrl);
						}
					}
				} catch (error) {
					hasFailures = true;
					console.warn(
						`Local-to-server migration failed for project ${metadata.id}.`,
						error,
					);
				}
			}

			if (migratedProjectsPayload.length > 0) {
				await fetch("/api/projects/migrate/local", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					cache: "no-store",
					body: JSON.stringify({ projects: migratedProjectsPayload }),
				}).catch(() => undefined);
			}

			if (!hasFailures) {
				window.localStorage.setItem(LOCAL_TO_SERVER_MIGRATION_MARKER, "done");
				await this.reclaimLegacyLocalStorage();
				window.localStorage.setItem(LOCAL_STORAGE_RECLAIM_MARKER, "done");
			}
			this.hasRunMigrationInSession = true;
		} finally {
			this.localToServerMigrationPromise = null;
		}
	}

	private async reclaimLegacyLocalStorage(): Promise<void> {
		try {
			const localProjects = await this.localService.loadAllProjectsMetadata();
			for (const metadata of localProjects) {
				await Promise.allSettled([
					this.localService.deleteProjectMedia({ projectId: metadata.id }),
					this.localService.deleteProject({ id: metadata.id }),
				]);
			}
		} catch (error) {
			console.warn("Failed to reclaim project/media via local service.", error);
		}

		// Best-effort cleanup of orphaned legacy IndexedDB databases.
		try {
			await deleteDatabase({ dbName: "video-editor-projects" });
		} catch {}
		try {
			await deleteDatabase({ dbName: "video-editor-meta" });
		} catch {}

		try {
			const dbFactory = indexedDB as IDBFactory & {
				databases?: () => Promise<Array<{ name?: string; version?: number }>>;
			};
			if (typeof dbFactory.databases === "function") {
				const databases = await dbFactory.databases();
				for (const db of databases) {
					const name = db.name ?? "";
					if (name.startsWith("video-editor-media-")) {
						await deleteDatabase({ dbName: name }).catch(() => undefined);
					}
				}
			}
		} catch {}

		// Best-effort cleanup of orphaned OPFS project media directories.
		try {
			if ("storage" in navigator && "getDirectory" in navigator.storage) {
				const root = await navigator.storage.getDirectory();
				for await (const [entryName, handle] of root.entries()) {
					if (
						handle.kind === "directory" &&
						entryName.startsWith("media-files-")
					) {
						await root.removeEntry(entryName, { recursive: true });
					}
				}
			}
		} catch {}
	}

	private async listLegacyMediaIds({
		projectId,
	}: {
		projectId: string;
	}): Promise<string[]> {
		const metadataAdapter = new IndexedDBAdapter<unknown>(
			`video-editor-media-${projectId}`,
			"media-metadata",
			1,
		);
		try {
			return await this.withTimeout({
				promise: metadataAdapter.list(),
				timeoutMs: StorageService.LEGACY_READ_TIMEOUT_MS,
				label: `legacy media id read (${projectId})`,
			});
		} catch {
			return [];
		}
	}

	private async withTimeout<T>({
		promise,
		timeoutMs,
		label,
	}: {
		promise: Promise<T>;
		timeoutMs: number;
		label: string;
	}): Promise<T> {
		return await new Promise<T>((resolve, reject) => {
			const timeoutHandle = window.setTimeout(() => {
				reject(
					new Error(
						`Timed out after ${timeoutMs}ms while running ${label}.`,
					),
				);
			}, timeoutMs);
			promise
				.then((value) => {
					window.clearTimeout(timeoutHandle);
					resolve(value);
				})
				.catch((error) => {
					window.clearTimeout(timeoutHandle);
					reject(error);
				});
		});
	}
}

export const storageService = new StorageService();
export { StorageService };
