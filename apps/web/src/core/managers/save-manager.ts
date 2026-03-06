import type { EditorCore } from "@/core";

type SaveManagerOptions = {
	debounceMs?: number;
	minIntervalMs?: number;
};

export class SaveManager {
	private debounceMs: number;
	private minIntervalMs: number;
	private isPaused = false;
	private isSaving = false;
	private hasPendingSave = false;
	private lastSavedAt = 0;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];

	constructor(
		private editor: EditorCore,
		{ debounceMs = 1200, minIntervalMs = 4000 }: SaveManagerOptions = {},
	) {
		this.debounceMs = debounceMs;
		this.minIntervalMs = minIntervalMs;
	}

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		this.hasPendingSave = true;
		this.queueSave();
	}

	async flush(): Promise<void> {
		this.hasPendingSave = true;
		await this.saveNow({ force: true });
	}

	getIsDirty(): boolean {
		return this.hasPendingSave || this.isSaving;
	}

	private queueSave(): void {
		if (this.isSaving) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		const now = Date.now();
		const nextAllowedAt = this.lastSavedAt + this.minIntervalMs;
		const minIntervalDelay = Math.max(0, nextAllowedAt - now);
		const delay = Math.max(this.debounceMs, minIntervalDelay);
		this.saveTimer = setTimeout(() => {
			void this.saveNow();
		}, delay);
	}

	private async saveNow({ force = false }: { force?: boolean } = {}): Promise<void> {
		if (this.isSaving) return;
		if (!this.hasPendingSave) return;
		if (!force) {
			const now = Date.now();
			if (now < this.lastSavedAt + this.minIntervalMs) {
				this.queueSave();
				return;
			}
		}

		const activeProject = this.editor.project.getActive();
		if (!activeProject) return;
		if (this.editor.project.getIsLoading()) return;
		if (this.editor.project.getMigrationState().isMigrating) return;

		this.isSaving = true;
		this.hasPendingSave = false;
		this.clearTimer();

		try {
			await this.editor.project.saveCurrentProject();
			this.lastSavedAt = Date.now();
		} finally {
			this.isSaving = false;
			if (this.hasPendingSave) {
				this.queueSave();
			}
		}
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
