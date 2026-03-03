import type { EditorCore } from "@/core";
import { collectAudioClips } from "@/lib/media/audio";
import { useProjectProcessStore } from "@/stores/project-process-store";

type ActiveClip = {
	id: string;
	sourceKey: string;
	startTime: number;
	duration: number;
	trimStart: number;
	muted: boolean;
	media: HTMLMediaElement;
};

export class AudioManager {
	private clips: ActiveClip[] = [];
	private sourceObjectUrls = new Map<string, string>();
	private timelineDirty = true;
	private buildPromise: Promise<void> | null = null;
	private buildGeneration = 0;
	private activeProjectId: string | null = null;
	private unsubscribers: Array<() => void> = [];
	private processId: string | null = null;
	private lastVolume = 1;
	private lastIsPlaying = false;
	private suspendSync = false;

	constructor(private editor: EditorCore) {
		this.lastVolume = this.editor.playback.getVolume();
		this.activeProjectId = this.editor.project.getActiveOrNull()?.metadata.id ?? null;

		this.unsubscribers.push(
			this.editor.playback.subscribe(this.handlePlaybackChange),
			this.editor.timeline.subscribe(this.handleTimelineChange),
			this.editor.scenes.subscribe(this.handleTimelineChange),
			this.editor.media.subscribe(this.handleTimelineChange),
			this.editor.project.subscribe(this.handleProjectChange),
		);

		if (typeof window !== "undefined") {
			window.addEventListener("playback-seek", this.handleSeek);
			window.addEventListener("playback-update", this.handlePlaybackUpdate);
			window.addEventListener("pointerdown", this.handleUserGesture, {
				passive: true,
			});
			window.addEventListener("keydown", this.handleUserGesture);
		}
	}

	dispose(): void {
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		if (typeof window !== "undefined") {
			window.removeEventListener("playback-seek", this.handleSeek);
			window.removeEventListener("playback-update", this.handlePlaybackUpdate);
			window.removeEventListener("pointerdown", this.handleUserGesture);
			window.removeEventListener("keydown", this.handleUserGesture);
		}
		this.stopAllMedia();
		this.clearAllObjectUrls();
		if (this.processId) {
			useProjectProcessStore.getState().removeProcess({ id: this.processId });
			this.processId = null;
		}
	}

	private handlePlaybackChange = (): void => {
		const isPlaying = this.editor.playback.getIsPlaying();
		const volume = this.editor.playback.getVolume();

		if (volume !== this.lastVolume) {
			this.lastVolume = volume;
			for (const clip of this.clips) {
				clip.media.volume = this.lastVolume;
			}
		}

		if (isPlaying === this.lastIsPlaying) return;
		this.lastIsPlaying = isPlaying;

		if (!isPlaying) {
			this.pauseAllMedia();
			return;
		}

		void this.startAtCurrentTime();
	};

	private handleTimelineChange = (): void => {
		this.timelineDirty = true;
		if (!this.editor.playback.getIsPlaying()) {
			void this.ensureClipsReady();
			return;
		}
		void this.rebuildAndSync();
	};

	private handleProjectChange = (): void => {
		const nextProjectId = this.editor.project.getActiveOrNull()?.metadata.id ?? null;
		if (nextProjectId === this.activeProjectId) return;
		this.activeProjectId = nextProjectId;

		this.timelineDirty = true;
		this.buildGeneration += 1;
		this.buildPromise = null;
		this.pauseAllMedia();
		this.disposeClipMedia();
		this.clearAllObjectUrls();
		if (this.processId) {
			useProjectProcessStore.getState().removeProcess({ id: this.processId });
			this.processId = null;
		}
	};

	private handleSeek = (event: Event): void => {
		const detail = (event as CustomEvent<{ time: number }>).detail;
		if (!detail) return;
		void this.syncToTimelineTime({
			time: detail.time,
			forceSeek: true,
		});
	};

	private handlePlaybackUpdate = (event: Event): void => {
		const detail = (event as CustomEvent<{ time: number }>).detail;
		if (!detail) return;
		if (!this.editor.playback.getIsPlaying()) return;
		if (this.editor.playback.getIsScrubbing()) return;
		void this.syncToTimelineTime({
			time: detail.time,
			forceSeek: false,
		});
	};

	private handleUserGesture = (): void => {
		if (!this.editor.playback.getIsPlaying()) return;
		void this.startAtCurrentTime();
	};

	private ensureObjectUrl({
		sourceKey,
		file,
	}: {
		sourceKey: string;
		file: File;
	}): string {
		const existing = this.sourceObjectUrls.get(sourceKey);
		if (existing) return existing;
		const url = URL.createObjectURL(file);
		this.sourceObjectUrls.set(sourceKey, url);
		return url;
	}

	private async ensureClipsReady(): Promise<void> {
		if (!this.timelineDirty) return;
		if (this.buildPromise) {
			return this.buildPromise;
		}

		const generation = ++this.buildGeneration;
		const projectId = this.activeProjectId;
		if (!this.processId && projectId) {
			this.processId = useProjectProcessStore.getState().registerProcess({
				projectId,
				kind: "other",
				label: "Preparing timeline audio...",
			});
		}

		this.buildPromise = (async () => {
			try {
				const tracks = this.editor.timeline.getTracks();
				const mediaAssets = this.editor.media.getAssets();
				const clipSources = await collectAudioClips({
					tracks,
					mediaAssets,
				});
				if (generation !== this.buildGeneration) return;

				const nextKeys = new Set(clipSources.map((clip) => clip.sourceKey));
				for (const [key, url] of this.sourceObjectUrls) {
					if (nextKeys.has(key)) continue;
					URL.revokeObjectURL(url);
					this.sourceObjectUrls.delete(key);
				}

				this.pauseAllMedia();
				this.disposeClipMedia();

				const nextClips: ActiveClip[] = [];
				for (const clip of clipSources) {
					const url = this.ensureObjectUrl({
						sourceKey: clip.sourceKey,
						file: clip.file,
					});
					const media = document.createElement(
						clip.file.type.startsWith("video/") ? "video" : "audio",
					);
					media.preload = "auto";
					media.src = url;
					media.volume = this.lastVolume;
					if (media instanceof HTMLVideoElement) {
						media.playsInline = true;
					}
					media.loop = false;
					media.muted = clip.muted || this.lastVolume <= 0;
					nextClips.push({
						id: clip.id,
						sourceKey: clip.sourceKey,
						startTime: clip.startTime,
						duration: clip.duration,
						trimStart: clip.trimStart,
						muted: clip.muted,
						media,
					});
				}

				this.clips = nextClips;
				this.timelineDirty = false;
			} catch (error) {
				console.warn("Failed to build timeline audio clips:", error);
			} finally {
				if (this.processId) {
					useProjectProcessStore.getState().removeProcess({ id: this.processId });
					this.processId = null;
				}
				this.buildPromise = null;
			}
		})();

		return this.buildPromise;
	}

	private async rebuildAndSync(): Promise<void> {
		const time = this.editor.playback.getCurrentTime();
		this.buildGeneration += 1;
		this.buildPromise = null;
		this.timelineDirty = true;
		await this.ensureClipsReady();
		if (!this.editor.playback.getIsPlaying()) return;
		await this.syncToTimelineTime({
			time,
			forceSeek: true,
		});
	}

	private pauseAllMedia(): void {
		for (const clip of this.clips) {
			try {
				clip.media.pause();
			} catch {}
		}
	}

	private stopAllMedia(): void {
		for (const clip of this.clips) {
			try {
				clip.media.pause();
			} catch {}
			clip.media.src = "";
		}
		this.clips = [];
	}

	private disposeClipMedia(): void {
		for (const clip of this.clips) {
			try {
				clip.media.pause();
			} catch {}
			clip.media.src = "";
		}
		this.clips = [];
	}

	private clearAllObjectUrls(): void {
		for (const [, url] of this.sourceObjectUrls) {
			URL.revokeObjectURL(url);
		}
		this.sourceObjectUrls.clear();
	}

	private async syncToTimelineTime({
		time,
		forceSeek,
	}: {
		time: number;
		forceSeek: boolean;
	}): Promise<void> {
		if (this.suspendSync) return;
		await this.ensureClipsReady();

		const isPlaying = this.editor.playback.getIsPlaying();
		const volume = this.editor.playback.getVolume();

		for (const clip of this.clips) {
			const endTime = clip.startTime + clip.duration;
			const active = time >= clip.startTime && time < endTime;
			clip.media.volume = volume;
			clip.media.muted = clip.muted || volume <= 0;

			if (!active || !isPlaying) {
				if (!clip.media.paused) {
					try {
						clip.media.pause();
					} catch {}
				}
				continue;
			}

			const mediaTime = Math.max(0, clip.trimStart + (time - clip.startTime));
			const drift = Math.abs((clip.media.currentTime || 0) - mediaTime);
			if (
				forceSeek ||
				!Number.isFinite(clip.media.currentTime) ||
				drift > 0.08
			) {
				try {
					clip.media.currentTime = mediaTime;
				} catch {}
			}

			if (clip.media.paused && !clip.media.muted) {
				try {
					await clip.media.play();
				} catch {}
			}
		}
	}

	private async startAtCurrentTime(): Promise<void> {
		await this.syncToTimelineTime({
			time: this.editor.playback.getCurrentTime(),
			forceSeek: true,
		});
	}

	async primeCurrentTimelineAudio(): Promise<void> {
		await this.ensureClipsReady();
		await this.preloadClipMediaElements();
	}

	private async preloadClipMediaElements(): Promise<void> {
		if (typeof window === "undefined") return;
		await Promise.all(this.clips.map((clip) => this.waitForMediaReady({ media: clip.media })));
	}

	private async waitForMediaReady({
		media,
	}: {
		media: HTMLMediaElement;
	}): Promise<void> {
		if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;

		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				media.removeEventListener("loadeddata", handleReady);
				media.removeEventListener("canplay", handleReady);
				media.removeEventListener("error", handleReady);
				window.clearTimeout(timeoutId);
				resolve();
			};
			const handleReady = () => finish();
			const timeoutId = window.setTimeout(() => finish(), 2500);
			media.addEventListener("loadeddata", handleReady, { once: true });
			media.addEventListener("canplay", handleReady, { once: true });
			media.addEventListener("error", handleReady, { once: true });
			try {
				media.load();
			} catch {
				finish();
			}
		});
	}
}
