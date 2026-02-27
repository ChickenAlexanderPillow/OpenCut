import type { EditorCore } from "@/core";
import { createAudioContext, createTimelineAudioBuffer } from "@/lib/media/audio";

export class AudioManager {
	private static readonly PLAYBACK_SAMPLE_RATE = 32000;
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private playbackSource: AudioBufferSourceNode | null = null;
	private timelineBuffer: AudioBuffer | null = null;
	private timelineDuration = 0;
	private timelineDirty = true;
	private buildingBuffer = false;
	private buildGeneration = 0;
	private lastIsPlaying = false;
	private lastIsScrubbing = false;
	private lastVolume = 1;
	private lastSeekRestartAt = 0;
	private lastSeekTime = 0;
	private minSeekRestartIntervalMs = 80;
	private minSeekTimeDeltaSeconds = 1 / 30;
	private playbackStartContextTime = 0;
	private playbackStartTimelineTime = 0;
	private playbackRequestId = 0;
	private lastDriftCorrectionAt = 0;
	private driftCorrectionCooldownMs = 120;
	private driftResyncThresholdSeconds = 0.08;
	private unsubscribers: Array<() => void> = [];
	private activeProjectId: string | null = null;
	private bufferBuildPromise: Promise<void> | null = null;
	private warmupTimer: number | null = null;
	private warmupIdleHandle: number | null = null;
	private quickStartMaxWaitMs = 120;

	constructor(private editor: EditorCore) {
		this.lastVolume = this.editor.playback.getVolume();

		this.unsubscribers.push(
			this.editor.playback.subscribe(this.handlePlaybackChange),
			this.editor.timeline.subscribe(this.handleTimelineOrMediaChange),
			this.editor.media.subscribe(this.handleTimelineOrMediaChange),
			this.editor.project.subscribe(this.handleProjectChange),
		);

		this.activeProjectId = this.editor.project.getActiveOrNull()?.metadata.id ?? null;

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
		this.stopSource();
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
		this.clearWarmupScheduling();
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
			this.masterGain = null;
		}
	}

	private handlePlaybackChange = (): void => {
		const isPlaying = this.editor.playback.getIsPlaying();
		const isScrubbing = this.editor.playback.getIsScrubbing();
		const volume = this.editor.playback.getVolume();

		if (volume !== this.lastVolume) {
			this.lastVolume = volume;
			this.updateGain();
		}

		if (isPlaying !== this.lastIsPlaying) {
			this.lastIsPlaying = isPlaying;
			if (isPlaying) {
				void this.startPlayback({ time: this.editor.playback.getCurrentTime() });
			} else {
				this.playbackRequestId += 1;
				this.stopSource();
			}
		}

		// Scrub end is a hard resync point to avoid brief AV drift.
		if (this.lastIsScrubbing && !isScrubbing && isPlaying) {
			this.lastSeekRestartAt = 0;
			this.lastSeekTime = Number.NaN;
			void this.startPlayback({ time: this.editor.playback.getCurrentTime() });
		}
		this.lastIsScrubbing = isScrubbing;
	};

	private handleSeek = (event: Event): void => {
		const detail = (event as CustomEvent<{ time: number }>).detail;
		if (!detail) return;
		const time = detail.time;
		const isScrubbing = this.editor.playback.getIsScrubbing();

		if (!this.editor.playback.getIsPlaying()) {
			this.stopSource();
			return;
		}

		const now = Date.now();
		const timeDelta = Math.abs(time - this.lastSeekTime);
		const shouldThrottle =
			isScrubbing &&
			now - this.lastSeekRestartAt < this.minSeekRestartIntervalMs &&
			timeDelta < this.minSeekTimeDeltaSeconds;
		if (shouldThrottle) return;

		this.lastSeekRestartAt = now;
		this.lastSeekTime = time;
		void this.startPlayback({ time });
	};

	private handlePlaybackUpdate = (event: Event): void => {
		if (!this.editor.playback.getIsPlaying()) return;
		if (this.editor.playback.getIsScrubbing()) return;
		if (!this.audioContext || !this.playbackSource) return;

		const detail = (event as CustomEvent<{ time: number }>).detail;
		if (!detail) return;

		const expectedTimelineFromAudio =
			this.playbackStartTimelineTime +
			(this.audioContext.currentTime - this.playbackStartContextTime);
		const drift = detail.time - expectedTimelineFromAudio;

		if (Math.abs(drift) < this.driftResyncThresholdSeconds) return;
		const now = Date.now();
		if (now - this.lastDriftCorrectionAt < this.driftCorrectionCooldownMs) return;

		this.lastDriftCorrectionAt = now;
		void this.startPlayback({ time: detail.time });
	};

	private handleTimelineOrMediaChange = (): void => {
		this.timelineDirty = true;
		if (this.editor.playback.getIsPlaying() && this.timelineBuffer) {
			return;
		}
		this.scheduleBufferWarmup();
	};

	private handleProjectChange = (): void => {
		const nextProjectId = this.editor.project.getActiveOrNull()?.metadata.id ?? null;
		if (nextProjectId === this.activeProjectId) return;

		this.activeProjectId = nextProjectId;

		// Hard boundary between projects: stop any active source and invalidate buffers.
		this.playbackRequestId += 1;
		this.stopSource();
		this.timelineBuffer = null;
		this.timelineDuration = 0;
		this.timelineDirty = true;
		this.buildGeneration += 1;
		this.buildingBuffer = false;
		this.bufferBuildPromise = null;
		this.clearWarmupScheduling();
		this.lastSeekRestartAt = 0;
		this.lastSeekTime = 0;
		this.lastDriftCorrectionAt = 0;
	};

	private handleUserGesture = (): void => {
		void this.unlockAudioContext();
	};

	private ensureAudioContext(): AudioContext | null {
		if (this.audioContext) return this.audioContext;
		if (typeof window === "undefined") return null;

		this.audioContext = createAudioContext({
			sampleRate: AudioManager.PLAYBACK_SAMPLE_RATE,
		});
		this.masterGain = this.audioContext.createGain();
		this.masterGain.gain.value = this.lastVolume;
		this.masterGain.connect(this.audioContext.destination);
		return this.audioContext;
	}

	private updateGain(): void {
		if (!this.masterGain) return;
		this.masterGain.gain.value = this.lastVolume;
	}

	private async unlockAudioContext(): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;
		if (audioContext.state !== "suspended") return;
		try {
			await audioContext.resume();
		} catch (error) {
			console.warn("Failed to resume audio context:", error);
		}
	}

	private scheduleBufferWarmup(): void {
		this.clearWarmupScheduling();
		if (typeof window === "undefined") {
			void this.ensureBufferReady();
			return;
		}

		this.warmupTimer = window.setTimeout(() => {
			this.warmupTimer = null;
			if ("requestIdleCallback" in window) {
				this.warmupIdleHandle = (
					window as typeof window & {
						requestIdleCallback: (
							cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
							opts?: { timeout?: number },
						) => number;
					}
				).requestIdleCallback(
					() => {
						this.warmupIdleHandle = null;
						void this.ensureBufferReady();
					},
					{ timeout: 1200 },
				);
				return;
			}
			void this.ensureBufferReady();
		}, 80);
	}

	private clearWarmupScheduling(): void {
		if (typeof window === "undefined") return;
		if (this.warmupTimer !== null) {
			window.clearTimeout(this.warmupTimer);
			this.warmupTimer = null;
		}
		if (this.warmupIdleHandle !== null && "cancelIdleCallback" in window) {
			(
				window as typeof window & {
					cancelIdleCallback: (id: number) => void;
				}
			).cancelIdleCallback(this.warmupIdleHandle);
			this.warmupIdleHandle = null;
		}
	}

	private async ensureBufferReady(): Promise<void> {
		if (!this.timelineDirty) return;
		if (this.bufferBuildPromise) {
			return this.bufferBuildPromise;
		}

		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		const generation = ++this.buildGeneration;
		this.buildingBuffer = true;
		this.bufferBuildPromise = (async () => {
			try {
				const tracks = this.editor.timeline.getTracks();
				const mediaAssets = this.editor.media.getAssets();
				const duration = this.editor.timeline.getTotalDuration();

				if (duration <= 0) {
					if (generation === this.buildGeneration) {
						this.timelineBuffer = null;
						this.timelineDuration = 0;
						this.timelineDirty = false;
					}
					return;
				}

				const buffer = await createTimelineAudioBuffer({
					tracks,
					mediaAssets,
					duration,
					audioContext,
					sampleRate: AudioManager.PLAYBACK_SAMPLE_RATE,
				});

				if (generation !== this.buildGeneration) return;

				this.timelineBuffer = buffer;
				this.timelineDuration = duration;
				this.timelineDirty = false;

				if (this.editor.playback.getIsPlaying()) {
					void this.startPlayback({ time: this.editor.playback.getCurrentTime() });
				}
			} catch (error) {
				console.warn("Failed to build timeline audio buffer:", error);
			} finally {
				if (generation === this.buildGeneration) {
					this.buildingBuffer = false;
				}
				this.bufferBuildPromise = null;
			}
		})();
		return this.bufferBuildPromise;
	}

	private stopSource(): void {
		if (!this.playbackSource) return;
		try {
			this.playbackSource.stop();
		} catch {}
		this.playbackSource.disconnect();
		this.playbackSource = null;
	}

	private async startPlayback({ time }: { time: number }): Promise<void> {
		const requestId = ++this.playbackRequestId;
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		await this.unlockAudioContext();
		if (requestId !== this.playbackRequestId) return;
		if (audioContext.state !== "running") {
			console.warn("Audio context is not running; playback audio is unavailable.");
			return;
		}

		const shouldWaitForBuffer = this.timelineDirty || !this.timelineBuffer;
		if (shouldWaitForBuffer) {
			const readyInTime = await Promise.race([
				this.ensureBufferReady().then(() => true),
				new Promise<boolean>((resolve) =>
					setTimeout(() => resolve(false), this.quickStartMaxWaitMs),
				),
			]);
			if (!readyInTime || requestId !== this.playbackRequestId) {
				return;
			}
		}

		this.stopSource();

		if (requestId !== this.playbackRequestId) return;
		if (!this.editor.playback.getIsPlaying()) return;
		if (!this.timelineBuffer) return;
		if (this.timelineDuration <= 0) return;

		const clampedTime = Math.max(0, Math.min(this.timelineDuration, time));
		if (clampedTime >= this.timelineDuration) return;

		const source = audioContext.createBufferSource();
		source.buffer = this.timelineBuffer;
		source.connect(this.masterGain ?? audioContext.destination);
		source.start(audioContext.currentTime, clampedTime);

		this.playbackSource = source;
		this.playbackStartContextTime = audioContext.currentTime;
		this.playbackStartTimelineTime = clampedTime;

		source.addEventListener("ended", () => {
			if (this.playbackSource === source) {
				this.playbackSource = null;
			}
		});
	}
}
