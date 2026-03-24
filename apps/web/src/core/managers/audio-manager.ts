import type { EditorCore } from "@/core";
import { createAudioContext } from "@/lib/media/audio";
import { StreamingTimelineAudioEngine } from "@/lib/media/streaming-audio-engine";
import { getTrackAudioEffectsFingerprint } from "@/lib/media/track-audio-effects";
import { getTranscriptAudioRevisionKey } from "@/lib/transcript-editor/state";

const AUDIO_MANAGER_GLOBAL_KEY = "__opencut_audio_manager_singleton__";

type GlobalWithAudioManager = typeof globalThis & {
	[AUDIO_MANAGER_GLOBAL_KEY]?: AudioManager | null;
};

type MeterLevelSnapshot = {
	peak: number;
	rms: number;
	rmsDb: number;
	silent: boolean;
};

type TrackMeterLevelSnapshot = MeterLevelSnapshot & {
	trackId: string;
};

function buildTranscriptAudioRevision({
	transcriptRevisionKey,
}: {
	transcriptRevisionKey?: string;
}): string {
	return transcriptRevisionKey ?? "";
}

export class AudioManager {
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private lastIsPlaying = false;
	private lastIsScrubbing = false;
	private lastVolume = 1;
	private lastSeekRestartAt = 0;
	private lastSeekTime = 0;
	private minSeekRestartIntervalMs = 40;
	private minSeekTimeDeltaSeconds = 1 / 60;
	private playbackRequestId = 0;
	private lastDriftCorrectionAt = 0;
	private driftCorrectionCooldownMs = 1000;
	private driftResyncThresholdSeconds = 0.35;
	private outputAnalyser: AnalyserNode | null = null;
	private outputMeterData: Float32Array | null = null;
	private outputMeterFrame: number | null = null;
	private previousOutputLevel: MeterLevelSnapshot = {
		peak: 0,
		rms: 0,
		rmsDb: -120,
		silent: true,
	};
	private previousTrackLevels = new Map<string, TrackMeterLevelSnapshot>();
	private meterReleasePeakPerSecond = 1.35;
	private meterReleaseDbPerSecond = 26;
	private meterLastFrameAtMs: number | null = null;
	private unsubscribers: Array<() => void> = [];
	private lastAudioFingerprint = "";
	private rebuildDebounceTimer: number | null = null;
	private pausedSeekPrimeTimer: number | null = null;
	private streamingEngine: StreamingTimelineAudioEngine | null = null;
	private prepareGraphSequence = 0;
	private audioGraphDirty = false;
	private audioGraphDirtySinceMs: number | null = null;
	private pendingGraphRebuild = false;
	private lastGraphRebuildAtMs: number | null = null;
	private lastGraphDirtyReason = "initial";

	constructor(private editor: EditorCore) {
		const globalScope = globalThis as GlobalWithAudioManager;
		const existing = globalScope[AUDIO_MANAGER_GLOBAL_KEY] ?? null;
		if (existing && existing !== this) {
			existing.dispose();
		}
		globalScope[AUDIO_MANAGER_GLOBAL_KEY] = this;

		this.lastVolume = this.editor.playback.getVolume();
		this.lastAudioFingerprint = this.computeAudioFingerprint();

		this.unsubscribers.push(
			this.editor.playback.subscribe(this.handlePlaybackChange),
			this.editor.timeline.subscribe(this.handleTimelineOrMediaChange),
			this.editor.media.subscribe(this.handleTimelineOrMediaChange),
			this.editor.scenes.subscribe(this.handleTimelineOrMediaChange),
		);

		if (typeof window !== "undefined") {
			window.addEventListener("playback-seek", this.handleSeek);
			window.addEventListener("playback-update", this.handlePlaybackUpdate);
			window.addEventListener("pointerdown", this.handleUserGesture, {
				passive: true,
			});
			window.addEventListener("keydown", this.handleUserGesture);
			window.setTimeout(() => {
				void this.prepareStreamingGraph({
					playhead: this.editor.playback.getCurrentTime(),
					prewarm: true,
				});
			}, 0);
		}
	}

	dispose(): void {
		const globalScope = globalThis as GlobalWithAudioManager;
		if (globalScope[AUDIO_MANAGER_GLOBAL_KEY] === this) {
			globalScope[AUDIO_MANAGER_GLOBAL_KEY] = null;
		}
		this.stopPlaybackOutputs();
		this.emitSilentMeterLevels();
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
		if (this.rebuildDebounceTimer !== null && typeof window !== "undefined") {
			window.clearTimeout(this.rebuildDebounceTimer);
			this.rebuildDebounceTimer = null;
		}
		if (this.pausedSeekPrimeTimer !== null && typeof window !== "undefined") {
			window.clearTimeout(this.pausedSeekPrimeTimer);
			this.pausedSeekPrimeTimer = null;
		}
		this.pendingGraphRebuild = false;
		this.audioGraphDirty = false;
		this.audioGraphDirtySinceMs = null;
		if (this.streamingEngine) {
			this.streamingEngine.dispose();
			this.streamingEngine = null;
		}
		void this.resetAudioContext();
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
			// Gate transport output immediately on pause/play transitions so stray nodes
			// can never leak audible output while paused.
			this.updateGain();
			if (isPlaying) {
				this.clearPausedSeekPrimeTimer();
				void this.startPlayback({
					time: this.editor.playback.getCurrentTime(),
				});
			} else {
				this.playbackRequestId += 1;
				this.stopPlaybackOutputs();
				this.emitSilentMeterLevels();
			}
		}

		if (!this.lastIsScrubbing && isScrubbing && isPlaying) {
			// During scrub we mute transport audio and resume on scrub-end to avoid
			// rapid unschedule/restart crackles.
			this.stopPlaybackOutputs();
		}

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
			this.stopPlaybackOutputs();
			this.schedulePausedSeekPrime({ time });
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
		if (isScrubbing) {
			// Scrub-end restart handles output; skip live seek scheduling while dragging.
			return;
		}
		if (this.audioGraphDirty) {
			// Timeline audio changed and graph rebuild is pending; restart against
			// latest graph immediately to avoid seeking into stale scheduled audio.
			void this.startPlayback({
				time,
				stopCurrentOutputFirst: true,
			});
			return;
		}
		this.streamingEngine?.seek({ time, immediate: true });
	};

	private handlePlaybackUpdate = (event: Event): void => {
		if (!this.editor.playback.getIsPlaying()) return;
		if (this.editor.playback.getIsScrubbing()) return;
		if (this.audioGraphDirty) return;
		if (!this.audioContext) return;

		const detail = (event as CustomEvent<{ time: number }>).detail;
		if (!detail) return;

		const expectedTimelineFromAudio =
			this.streamingEngine?.getClockTime() ?? detail.time;
		const drift = detail.time - expectedTimelineFromAudio;

		if (Math.abs(drift) < this.driftResyncThresholdSeconds) return;
		const now = Date.now();
		if (now - this.lastDriftCorrectionAt < this.driftCorrectionCooldownMs)
			return;

		this.lastDriftCorrectionAt = now;
		this.streamingEngine?.seek({ time: detail.time, immediate: true });
	};

	private handleTimelineOrMediaChange = (): void => {
		const nextFingerprint = this.computeAudioFingerprint();
		if (nextFingerprint === this.lastAudioFingerprint) {
			return;
		}
		this.lastAudioFingerprint = nextFingerprint;
		// Invalidate any in-flight graph prepares or playback restarts against an older
		// timeline state before scheduling the next rebuild.
		this.prepareGraphSequence += 1;
		this.playbackRequestId += 1;
		this.setAudioGraphDirty({
			dirty: true,
			reason: "timeline-or-media-change",
		});

		const isPlaying = this.editor.playback.getIsPlaying();
		const isScrubbing = this.editor.playback.getIsScrubbing();
		if (typeof window === "undefined") {
			void this.prepareStreamingGraph({
				playhead: this.editor.playback.getCurrentTime(),
			});
			return;
		}

		// During active playback we must immediately stop stale output and rebuild from
		// latest timeline edits to avoid doubled/overlapping transport audio.
		if (isPlaying && !isScrubbing) {
			this.stopPlaybackOutputs();
			this.scheduleGraphRebuild({ delayMs: 20 });
			return;
		}
		this.scheduleGraphRebuild({
			delayMs: isScrubbing ? 40 : 90,
		});
	};

	private handleUserGesture = (): void => {
		void this.unlockAudioContext();
	};

	private ensureAudioContext(): AudioContext | null {
		if (this.audioContext) return this.audioContext;
		if (typeof window === "undefined") return null;

		this.audioContext = createAudioContext();
		this.masterGain = this.audioContext.createGain();
		this.masterGain.gain.value = this.editor.playback.getIsPlaying()
			? this.lastVolume
			: 0;
		this.outputAnalyser = this.audioContext.createAnalyser();
		this.outputAnalyser.fftSize = 512;
		this.outputAnalyser.smoothingTimeConstant = 0.18;
		this.outputMeterData = new Float32Array(this.outputAnalyser.fftSize);
		this.masterGain.connect(this.outputAnalyser);
		this.outputAnalyser.connect(this.audioContext.destination);
		this.startOutputMetering();
		return this.audioContext;
	}

	private ensureStreamingEngine(): StreamingTimelineAudioEngine | null {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return null;
		if (!this.masterGain) return null;
		if (!this.streamingEngine) {
			this.streamingEngine = new StreamingTimelineAudioEngine(
				audioContext,
				this.masterGain,
			);
		}
		return this.streamingEngine;
	}

	private updateGain(): void {
		if (!this.masterGain) return;
		this.masterGain.gain.value = this.editor.playback.getIsPlaying()
			? this.lastVolume
			: 0;
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

	async suspendContext(): Promise<void> {
		if (!this.audioContext) return;
		if (this.audioContext.state !== "running") return;
		try {
			await this.audioContext.suspend();
		} catch (error) {
			console.warn("Failed to suspend audio context:", error);
		}
	}

	async resumeContext(): Promise<void> {
		if (!this.audioContext) return;
		if (this.audioContext.state !== "suspended") return;
		try {
			await this.audioContext.resume();
		} catch (error) {
			console.warn("Failed to resume audio context:", error);
		}
	}

	private async prepareStreamingGraph({
		playhead,
		prewarm = false,
	}: {
		playhead: number;
		prewarm?: boolean;
	}): Promise<void> {
		const prepareSequence = ++this.prepareGraphSequence;
		const engine = this.ensureStreamingEngine();
		if (!engine) return;
		const tracks = this.editor.timeline.getTracks();
		const mediaAssets = this.editor.media.getAssets();
		try {
			const preparedGraph = await engine.prepare({
				tracks,
				mediaAssets,
				playhead,
			});
			if (prepareSequence !== this.prepareGraphSequence) return;
			engine.applyPreparedGraph({
				...preparedGraph,
				playhead,
			});
			this.setAudioGraphDirty({
				dirty: false,
				reason: "prepare-complete",
			});
			if (prewarm) {
				void engine.prewarm({ playhead, horizonSeconds: 12 });
			}
		} catch (error) {
			if (prepareSequence !== this.prepareGraphSequence) return;
			console.warn("Streaming audio engine prepare failed:", error);
		}
	}

	private stopPlaybackOutputs(): void {
		this.streamingEngine?.stop();
	}

	private async resetAudioContext(): Promise<void> {
		if (!this.audioContext) return;
		const context = this.audioContext;
		this.audioContext = null;
		this.masterGain = null;
		this.outputAnalyser = null;
		this.outputMeterData = null;
		this.stopOutputMetering();
		this.emitSilentMeterLevels();
		try {
			await context.close();
		} catch (error) {
			console.warn("Failed to close audio context:", error);
		}
	}

	private startOutputMetering(): void {
		this.stopOutputMetering();
		if (typeof window === "undefined") return;
		const tick = (frameAtMs: number) => {
			const deltaSeconds =
				this.meterLastFrameAtMs === null
					? 1 / 60
					: Math.max(
							1 / 240,
							Math.min(0.1, (frameAtMs - this.meterLastFrameAtMs) / 1000),
						);
			this.meterLastFrameAtMs = frameAtMs;
			if (!this.audioContext || !this.outputAnalyser || !this.outputMeterData) {
				this.emitSilentMeterLevels();
				this.outputMeterFrame = window.requestAnimationFrame(tick);
				return;
			}
			if (this.audioContext.state !== "running") {
				this.emitSilentMeterLevels();
				this.outputMeterFrame = window.requestAnimationFrame(tick);
				return;
			}
			this.outputAnalyser.getFloatTimeDomainData(this.outputMeterData);
			let peak = 0;
			let sumSquares = 0;
			for (let index = 0; index < this.outputMeterData.length; index++) {
				const value = this.outputMeterData[index] ?? 0;
				const abs = Math.abs(value);
				if (abs > peak) peak = abs;
				sumSquares += value * value;
			}
			const rms = Math.sqrt(sumSquares / this.outputMeterData.length);
			const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120;
			this.emitMeterLevels({
				peak,
				rms,
				rmsDb,
				silent: peak < 1e-4,
				tracks: this.streamingEngine?.getTrackLevels() ?? [],
				deltaSeconds,
			});
			this.outputMeterFrame = window.requestAnimationFrame(tick);
		};
		this.outputMeterFrame = window.requestAnimationFrame(tick);
	}

	private emitMeterLevels({
		peak,
		rms,
		rmsDb,
		silent,
		tracks,
		deltaSeconds,
	}: {
		peak: number;
		rms: number;
		rmsDb: number;
		silent: boolean;
		tracks: TrackMeterLevelSnapshot[];
		deltaSeconds?: number;
	}): void {
		if (typeof window === "undefined") return;
		const nextOutputLevel = this.applyMeterRelease({
			next: {
				peak,
				rms,
				rmsDb,
				silent,
			},
			previous: this.previousOutputLevel,
			deltaSeconds,
		});
		this.previousOutputLevel = nextOutputLevel;
		const nextTrackLevels = tracks.map((track) => {
			const smoothedTrack = this.applyMeterRelease({
				next: track,
				previous: this.previousTrackLevels.get(track.trackId),
				deltaSeconds,
			});
			const trackLevel = {
				trackId: track.trackId,
				...smoothedTrack,
			};
			this.previousTrackLevels.set(track.trackId, trackLevel);
			return trackLevel;
		});
		for (const trackId of Array.from(this.previousTrackLevels.keys())) {
			if (!nextTrackLevels.some((track) => track.trackId === trackId)) {
				this.previousTrackLevels.delete(trackId);
			}
		}
		window.dispatchEvent(
			new CustomEvent("opencut:audio-output-level", {
				detail: {
					peak: nextOutputLevel.peak,
					rms: nextOutputLevel.rms,
					rmsDb: nextOutputLevel.rmsDb,
					silent: nextOutputLevel.silent,
					isPlaying: this.editor.playback.getIsPlaying(),
				},
			}),
		);
		window.dispatchEvent(
			new CustomEvent("opencut:audio-track-levels", {
				detail: {
					tracks: nextTrackLevels,
					isPlaying: this.editor.playback.getIsPlaying(),
				},
			}),
		);
	}

	private emitSilentMeterLevels(): void {
		this.previousOutputLevel = {
			peak: 0,
			rms: 0,
			rmsDb: -120,
			silent: true,
		};
		this.previousTrackLevels.clear();
		this.meterLastFrameAtMs = null;
		const silentTracks = this.editor.timeline
			.getTracks()
			.filter((track) => track.type === "audio" || track.type === "video")
			.map((track) => ({
				trackId: track.id,
				peak: 0,
				rms: 0,
				rmsDb: -120,
				silent: true,
			}));
		this.emitMeterLevels({
			peak: 0,
			rms: 0,
			rmsDb: -120,
			silent: true,
			tracks: silentTracks,
		});
	}

	private stopOutputMetering(): void {
		if (this.outputMeterFrame === null || typeof window === "undefined") return;
		window.cancelAnimationFrame(this.outputMeterFrame);
		this.outputMeterFrame = null;
		this.meterLastFrameAtMs = null;
	}

	private applyMeterRelease({
		next,
		previous,
		deltaSeconds,
	}: {
		next: MeterLevelSnapshot;
		previous?: MeterLevelSnapshot;
		deltaSeconds?: number;
	}): MeterLevelSnapshot {
		if (!previous) return next;
		if (next.silent) {
			return {
				peak: 0,
				rms: 0,
				rmsDb: -120,
				silent: true,
			};
		}

		const elapsedSeconds = Math.max(1 / 240, deltaSeconds ?? 1 / 60);
		const peak =
			next.peak >= previous.peak
				? next.peak
				: Math.max(next.peak, previous.peak - this.meterReleasePeakPerSecond * elapsedSeconds);
		const rmsDb =
			next.rmsDb >= previous.rmsDb
				? next.rmsDb
				: Math.max(next.rmsDb, previous.rmsDb - this.meterReleaseDbPerSecond * elapsedSeconds);
		const rms = rmsDb <= -120 ? 0 : 10 ** (rmsDb / 20);

		return {
			peak,
			rms,
			rmsDb,
			silent: peak < 1e-4 && rmsDb <= -110,
		};
	}

	private async startPlayback({
		time,
		stopCurrentOutputFirst = false,
	}: {
		time: number;
		stopCurrentOutputFirst?: boolean;
	}): Promise<void> {
		const requestId = ++this.playbackRequestId;
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;
		if (stopCurrentOutputFirst) {
			this.stopPlaybackOutputs();
		}

		await this.unlockAudioContext();
		if (requestId !== this.playbackRequestId) return;
		if (audioContext.state !== "running") {
			console.warn(
				"Audio context is not running; playback audio is unavailable.",
			);
			return;
		}

		try {
			const engine = this.ensureStreamingEngine();
			if (!engine) return;
			const hasPreparedClips = engine.getDiagnostics().clipCount > 0;
			const canReusePreparedGraph =
				!this.audioGraphDirty && hasPreparedClips && !stopCurrentOutputFirst;
			if (!canReusePreparedGraph) {
				await this.prepareStreamingGraph({ playhead: time, prewarm: true });
			}
			if (requestId !== this.playbackRequestId) return;
			if (!this.editor.playback.getIsPlaying()) return;
			engine.stop();
			engine.start({ atTime: time });
			this.setAudioGraphDirty({
				dirty: false,
				reason: "playback-restarted",
			});
		} catch (error) {
			console.warn("Streaming playback failed:", error);
		}
	}

	async primeCurrentTimelineAudio({
		playhead = this.editor.playback.getCurrentTime(),
	}: {
		playhead?: number;
	} = {}): Promise<void> {
		await this.unlockAudioContext();
		await this.prepareStreamingGraph({ playhead });
		await this.streamingEngine?.prewarm({ playhead, horizonSeconds: 2 });
		void this.streamingEngine?.prewarm({ playhead, horizonSeconds: 12 });
	}

	private schedulePausedSeekPrime({ time }: { time: number }): void {
		if (typeof window === "undefined") return;
		this.clearPausedSeekPrimeTimer();
		this.pausedSeekPrimeTimer = window.setTimeout(() => {
			this.pausedSeekPrimeTimer = null;
			if (this.editor.playback.getIsPlaying()) return;
			void this.prepareStreamingGraph({
				playhead: time,
				prewarm: true,
			});
		}, 40);
	}

	private clearPausedSeekPrimeTimer(): void {
		if (this.pausedSeekPrimeTimer === null || typeof window === "undefined") {
			return;
		}
		window.clearTimeout(this.pausedSeekPrimeTimer);
		this.pausedSeekPrimeTimer = null;
	}

	clearCachedTimelineAudio({
		preserveDirty = true,
	}: {
		preserveDirty?: boolean;
	} = {}): void {
		this.stopPlaybackOutputs();
		this.streamingEngine?.clearCaches();
		if (preserveDirty) {
			this.setAudioGraphDirty({
				dirty: true,
				reason: "cache-cleared",
			});
		} else {
			this.setAudioGraphDirty({
				dirty: false,
				reason: "cache-cleared-reset",
			});
		}
	}

	getAudioHealth(): {
		startupMs: number | null;
		cacheHitRate: number;
		dropouts: number;
		graphDirty: boolean;
		pendingRebuild: boolean;
		staleForMs: number;
		lastGraphRebuildAtMs: number | null;
	} {
		const graphState = this.getAudioGraphState();
		if (this.streamingEngine) {
			const health = this.streamingEngine.getHealth();
			return {
				startupMs: health.startupMs,
				cacheHitRate: health.cacheHitRate,
				dropouts: health.dropouts,
				graphDirty: graphState.isDirty,
				pendingRebuild: graphState.pendingRebuild,
				staleForMs: graphState.staleForMs,
				lastGraphRebuildAtMs: graphState.lastRebuildAtMs,
			};
		}
		return {
			startupMs: null,
			cacheHitRate: 0,
			dropouts: 0,
			graphDirty: graphState.isDirty,
			pendingRebuild: graphState.pendingRebuild,
			staleForMs: graphState.staleForMs,
			lastGraphRebuildAtMs: graphState.lastRebuildAtMs,
		};
	}

	getPlaybackClockTime(): number | null {
		if (!this.editor.playback.getIsPlaying()) return null;
		if (!this.streamingEngine?.isTransportActive()) return null;
		return this.streamingEngine.getClockTime();
	}

	getAudioGraphState(): {
		isDirty: boolean;
		pendingRebuild: boolean;
		staleForMs: number;
		lastRebuildAtMs: number | null;
		reason: string;
	} {
		const staleForMs =
			this.audioGraphDirty && this.audioGraphDirtySinceMs !== null
				? Math.max(0, this.nowMs() - this.audioGraphDirtySinceMs)
				: 0;
		return {
			isDirty: this.audioGraphDirty,
			pendingRebuild: this.pendingGraphRebuild,
			staleForMs,
			lastRebuildAtMs: this.lastGraphRebuildAtMs,
			reason: this.lastGraphDirtyReason,
		};
	}

	private scheduleGraphRebuild({ delayMs }: { delayMs: number }): void {
		if (typeof window === "undefined") return;
		if (this.rebuildDebounceTimer !== null) {
			window.clearTimeout(this.rebuildDebounceTimer);
		}
		this.pendingGraphRebuild = true;
		this.emitAudioGraphState({
			phase: "queued",
			reason: "rebuild-queued",
		});
		this.rebuildDebounceTimer = window.setTimeout(
			() => {
				this.rebuildDebounceTimer = null;
				this.pendingGraphRebuild = false;
				this.emitAudioGraphState({
					phase: "rebuilding",
					reason: "rebuild-start",
				});
				const playhead = this.editor.playback.getCurrentTime();
				if (
					this.editor.playback.getIsPlaying() &&
					!this.editor.playback.getIsScrubbing()
				) {
					// During active playback, rebuild+restart transport so no stale nodes remain.
					void this.startPlayback({
						time: playhead,
						stopCurrentOutputFirst: true,
					});
					return;
				}
				void this.prepareStreamingGraph({
					playhead,
					prewarm:
						!this.editor.playback.getIsPlaying() &&
						!this.editor.playback.getIsScrubbing(),
				});
			},
			Math.max(0, Math.floor(delayMs)),
		);
	}

	private setAudioGraphDirty({
		dirty,
		reason,
	}: {
		dirty: boolean;
		reason: string;
	}): void {
		const wasDirty = this.audioGraphDirty;
		if (dirty) {
			this.audioGraphDirty = true;
			this.lastGraphDirtyReason = reason;
			if (this.audioGraphDirtySinceMs === null) {
				this.audioGraphDirtySinceMs = this.nowMs();
			}
			// Emit once when entering dirty state, then rely on queued/rebuild events.
			if (!wasDirty) {
				this.emitAudioGraphState({
					phase: "dirty",
					reason,
				});
			}
			return;
		}

		this.audioGraphDirty = false;
		this.lastGraphDirtyReason = reason;
		const hadPendingGraphRebuild = this.pendingGraphRebuild;
		const staleForMs =
			this.audioGraphDirtySinceMs === null
				? 0
				: Math.max(0, this.nowMs() - this.audioGraphDirtySinceMs);
		if (this.rebuildDebounceTimer !== null && typeof window !== "undefined") {
			window.clearTimeout(this.rebuildDebounceTimer);
			this.rebuildDebounceTimer = null;
		}
		this.pendingGraphRebuild = false;
		this.audioGraphDirtySinceMs = null;
		this.lastGraphRebuildAtMs = this.nowMs();
		if (wasDirty || hadPendingGraphRebuild) {
			this.emitAudioGraphState({
				phase: "clean",
				reason,
				staleForMs,
			});
		}
	}

	private nowMs(): number {
		return typeof performance !== "undefined" ? performance.now() : Date.now();
	}

	private emitAudioGraphState({
		phase,
		reason,
		staleForMs,
	}: {
		phase: "dirty" | "queued" | "rebuilding" | "clean";
		reason: string;
		staleForMs?: number;
	}): void {
		if (typeof window === "undefined") return;
		const state = this.getAudioGraphState();
		window.dispatchEvent(
			new CustomEvent("opencut:audio-graph-state", {
				detail: state,
			}),
		);
		window.dispatchEvent(
			new CustomEvent("opencut:audio-diagnostics", {
				detail: {
					type: "graph-state",
					phase,
					reason,
					isDirty: state.isDirty,
					pendingRebuild: state.pendingRebuild,
					staleForMs: staleForMs ?? state.staleForMs,
					lastRebuildAtMs: state.lastRebuildAtMs,
					isPlaying: this.editor.playback.getIsPlaying(),
					isScrubbing: this.editor.playback.getIsScrubbing(),
				},
			}),
		);
	}

	private computeAudioFingerprint(): string {
		const tracks = this.editor.timeline.getTracks();
		const mediaAssets = this.editor.media.getAssets();
		const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
		if (tracks.length === 0) return "tracks:empty";

		let hash = 5381;
		const updateHash = (value: string): void => {
			for (let index = 0; index < value.length; index++) {
				hash = (hash * 33) ^ value.charCodeAt(index);
			}
			hash = (hash * 33) ^ 124;
		};
		const referencedMediaIds = new Set<string>();
		updateHash(String(tracks.length));
		for (const track of tracks) {
			const muted = "muted" in track ? String(Boolean(track.muted)) : "0";
			const volume =
				"volume" in track
					? String((track as { volume?: number }).volume ?? 1)
					: "1";
			updateHash(track.id);
			updateHash(track.type);
			updateHash(muted);
			updateHash(volume);
			if (track.type === "audio" || track.type === "video") {
				updateHash(getTrackAudioEffectsFingerprint(track.audioEffects));
			}
			updateHash(String(track.elements.length));
			for (const element of track.elements) {
				if (element.type === "audio") {
					if (element.sourceType === "upload")
						referencedMediaIds.add(element.mediaId);
					updateHash(element.type);
					updateHash(element.id);
					updateHash(element.sourceType);
					updateHash(
						element.sourceType === "upload"
							? element.mediaId
							: element.sourceUrl,
					);
					updateHash(String(element.startTime));
					updateHash(String(element.duration));
					updateHash(String(element.trimStart));
					updateHash(String(element.trimEnd));
					updateHash(String(element.volume));
					updateHash(element.muted ? "1" : "0");
					updateHash(
						buildTranscriptAudioRevision({
							transcriptRevisionKey: getTranscriptAudioRevisionKey(element),
						}),
					);
					continue;
				}
				if (element.type === "video") {
					referencedMediaIds.add(element.mediaId);
					updateHash(element.type);
					updateHash(element.id);
					updateHash(element.mediaId);
					updateHash(String(element.startTime));
					updateHash(String(element.duration));
					updateHash(String(element.trimStart));
					updateHash(String(element.trimEnd));
					updateHash(element.muted ? "1" : "0");
					updateHash(
						buildTranscriptAudioRevision({
							transcriptRevisionKey: getTranscriptAudioRevisionKey(element),
						}),
					);
				}
			}
		}

		const sortedMediaIds = Array.from(referencedMediaIds).sort();
		updateHash(String(sortedMediaIds.length));
		for (const mediaId of sortedMediaIds) {
			const media = mediaById.get(mediaId);
			if (!media) {
				updateHash(mediaId);
				updateHash("missing");
				continue;
			}
			updateHash(media.id);
			updateHash(media.type);
			updateHash(String(media.file.size));
			updateHash(String(media.file.lastModified));
			updateHash(String(media.duration ?? ""));
		}

		return `${tracks.length}:${sortedMediaIds.length}:${(hash >>> 0).toString(36)}`;
	}
}
