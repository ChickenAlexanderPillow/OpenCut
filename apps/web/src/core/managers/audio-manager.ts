import type { EditorCore } from "@/core";
import { createAudioContext, createTimelineAudioBuffer } from "@/lib/media/audio";

function buildTranscriptAudioRevision({
	transcriptEdit,
}: {
	transcriptEdit:
		| {
				updatedAt: string;
				words: Array<{ id: string; text: string; removed?: boolean }>;
				cuts: Array<{ start: number; end: number; reason: string }>;
		  }
		| undefined;
}): string {
	if (!transcriptEdit) return "";
	let hash = 5381;
	const updateHash = (value: string): void => {
		for (let index = 0; index < value.length; index++) {
			hash = (hash * 33) ^ value.charCodeAt(index);
		}
	};
	updateHash(transcriptEdit.updatedAt ?? "");
	for (const word of transcriptEdit.words) {
		updateHash(word.id);
		updateHash(word.text);
		updateHash(word.removed ? "1" : "0");
	}
	for (const cut of transcriptEdit.cuts) {
		updateHash(cut.start.toFixed(3));
		updateHash(cut.end.toFixed(3));
		updateHash(cut.reason);
	}
	return `${transcriptEdit.words.length}:${transcriptEdit.cuts.length}:${(hash >>> 0).toString(36)}`;
}

export class AudioManager {
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private playbackSource: AudioBufferSourceNode | null = null;
	private timelineBuffer: AudioBuffer | null = null;
	private timelineDuration = 0;
	private timelineDirty = true;
	private buildingBuffer = false;
	private rebuildRequestedDuringBuild = false;
	private buildGeneration = 0;
	private lastIsPlaying = false;
	private lastIsScrubbing = false;
	private lastVolume = 1;
	private lastSeekRestartAt = 0;
	private lastSeekTime = 0;
	private minSeekRestartIntervalMs = 40;
	private minSeekTimeDeltaSeconds = 1 / 60;
	private playbackStartContextTime = 0;
	private playbackStartTimelineTime = 0;
	private playbackRequestId = 0;
	private lastDriftCorrectionAt = 0;
	private driftCorrectionCooldownMs = 120;
	private driftResyncThresholdSeconds = 0.08;
	private unsubscribers: Array<() => void> = [];
	private lastAudioFingerprint = "";
	private rebuildDebounceTimer: number | null = null;

	constructor(private editor: EditorCore) {
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
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
			this.masterGain = null;
		}
		if (this.rebuildDebounceTimer !== null && typeof window !== "undefined") {
			window.clearTimeout(this.rebuildDebounceTimer);
			this.rebuildDebounceTimer = null;
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
		const nextFingerprint = this.computeAudioFingerprint();
		if (nextFingerprint === this.lastAudioFingerprint) {
			return;
		}
		this.lastAudioFingerprint = nextFingerprint;
		this.timelineDirty = true;
		const isPlaying = this.editor.playback.getIsPlaying();
		const isScrubbing = this.editor.playback.getIsScrubbing();
		// Text-based edits can trigger frequent updates; avoid rebuilding the
		// full mixed timeline audio while idle. Rebuild lazily on playback.
		if (!isPlaying && !isScrubbing) {
			return;
		}
		if (this.buildingBuffer) {
			this.rebuildRequestedDuringBuild = true;
			return;
		}
		if (typeof window === "undefined") {
			void this.ensureBufferReady();
			return;
		}
		if (this.rebuildDebounceTimer !== null) {
			window.clearTimeout(this.rebuildDebounceTimer);
		}
		this.rebuildDebounceTimer = window.setTimeout(() => {
			this.rebuildDebounceTimer = null;
			void this.ensureBufferReady();
		}, 120);
	};

	private handleUserGesture = (): void => {
		void this.unlockAudioContext();
	};

	private ensureAudioContext(): AudioContext | null {
		if (this.audioContext) return this.audioContext;
		if (typeof window === "undefined") return null;

		this.audioContext = createAudioContext();
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

	private async ensureBufferReady(): Promise<void> {
		if (!this.timelineDirty) return;
		if (this.buildingBuffer) {
			this.rebuildRequestedDuringBuild = true;
			return;
		}

		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		const generation = ++this.buildGeneration;
		this.buildingBuffer = true;
		this.rebuildRequestedDuringBuild = false;

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
				sampleRate: audioContext.sampleRate,
			});

			if (generation !== this.buildGeneration) return;
			if (this.rebuildRequestedDuringBuild) return;

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
			if (this.rebuildRequestedDuringBuild || this.timelineDirty) {
				void this.ensureBufferReady();
			}
		}
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

		await this.ensureBufferReady();
		if (requestId !== this.playbackRequestId) return;

		this.stopSource();

		if (requestId !== this.playbackRequestId) return;
		if (!this.editor.playback.getIsPlaying()) return;
		if (!this.timelineBuffer) return;
		if (this.timelineDuration <= 0) return;

		const clampedTime = Math.max(0, Math.min(this.timelineDuration, time));
		const startTime =
			clampedTime >= this.timelineDuration
				? Math.max(0, this.timelineDuration - 1 / 120)
				: clampedTime;

		const source = audioContext.createBufferSource();
		source.buffer = this.timelineBuffer;
		source.connect(this.masterGain ?? audioContext.destination);
		source.start(audioContext.currentTime, startTime);

		this.playbackSource = source;
		this.playbackStartContextTime = audioContext.currentTime;
		this.playbackStartTimelineTime = startTime;

		source.addEventListener("ended", () => {
			if (this.playbackSource === source) {
				this.playbackSource = null;
			}
		});
	}

	async primeCurrentTimelineAudio(): Promise<void> {
		await this.unlockAudioContext();
		await this.ensureBufferReady();
	}

	clearCachedTimelineAudio({ preserveDirty = true }: { preserveDirty?: boolean } = {}): void {
		this.stopSource();
		this.timelineBuffer = null;
		this.timelineDuration = 0;
		// Clearing the mixed buffer should schedule a rebuild by default.
		// Callers can opt out only for full teardown/reset flows.
		this.timelineDirty = preserveDirty ? true : false;
		this.rebuildRequestedDuringBuild = false;
		this.buildGeneration += 1;
	}

	private computeAudioFingerprint(): string {
		const tracks = this.editor.timeline.getTracks();
		const mediaAssets = this.editor.media.getAssets();
		const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
		if (tracks.length === 0) return "tracks:empty";

		const referencedMediaIds = new Set<string>();
		const trackParts: string[] = [];

		for (const track of tracks) {
			const muted = "muted" in track ? String(Boolean(track.muted)) : "0";
			const volume = track.type === "audio" ? String(track.volume ?? 1) : "1";
			const elementParts: string[] = [];
			for (const element of track.elements) {
				if (element.type === "audio") {
					if (element.sourceType === "upload") referencedMediaIds.add(element.mediaId);
					elementParts.push(
						[
							element.type,
							element.id,
							element.sourceType,
							element.sourceType === "upload" ? element.mediaId : element.sourceUrl,
							element.startTime,
							element.duration,
							element.trimStart,
							element.trimEnd,
							element.volume,
							element.muted ? 1 : 0,
							buildTranscriptAudioRevision({
								transcriptEdit: element.transcriptEdit,
							}),
						].join(":"),
					);
					continue;
				}
				if (element.type === "video") {
					referencedMediaIds.add(element.mediaId);
					elementParts.push(
						[
							element.type,
							element.id,
							element.mediaId,
							element.startTime,
							element.duration,
							element.trimStart,
							element.trimEnd,
							element.muted ? 1 : 0,
							buildTranscriptAudioRevision({
								transcriptEdit: element.transcriptEdit,
							}),
						].join(":"),
					);
				}
			}
			trackParts.push(
				[
					track.id,
					track.type,
					muted,
					volume,
					elementParts.join("|"),
				].join("#"),
			);
		}

		const mediaParts = Array.from(referencedMediaIds)
			.sort()
			.map((mediaId) => {
				const media = mediaById.get(mediaId);
				if (!media) return `${mediaId}:missing`;
				return [
					media.id,
					media.type,
					media.file.size,
					media.file.lastModified,
					media.duration ?? "",
				].join(":");
			});

		return `${trackParts.join("||")}@@${mediaParts.join("||")}`;
	}
}
