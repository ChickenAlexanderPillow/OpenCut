import type { EditorCore } from "@/core";

export class PlaybackManager {
	private isPlaying = false;
	private currentTime = 0;
	private volume = 1;
	private muted = false;
	private previousVolume = 1;
	private isScrubbing = false;
	private listeners = new Set<() => void>();
	private playbackTimer: number | null = null;
	private lastUpdate = 0;
	private lastNotifiedAt = 0;

	constructor(private editor: EditorCore) {}

	play(): void {
		if (this.isPlaying) return;
		const duration = this.editor.timeline.getTotalDuration();

		if (duration > 0) {
			if (this.currentTime >= duration) {
				this.seek({ time: 0 });
			}
		}

		this.isPlaying = true;
		this.startTimer();
		this.notify();
		this.emitPlaybackStateEvent({ isPlaying: true });
	}

	pause(): void {
		if (!this.isPlaying) return;
		this.isPlaying = false;
		this.stopTimer();
		this.notify();
		this.emitPlaybackStateEvent({ isPlaying: false });
	}

	toggle(): void {
		if (this.isPlaying) {
			this.pause();
		} else {
			this.play();
		}
	}

	seek({ time }: { time: number }): void {
		const duration = this.editor.timeline.getTotalDuration();
		const nextTime = Math.max(0, Math.min(duration, time));
		if (Math.abs(nextTime - this.currentTime) < 1e-6) return;
		this.currentTime = nextTime;
		this.notify();

		window.dispatchEvent(
			new CustomEvent("playback-seek", {
				detail: { time: this.currentTime },
			}),
		);
	}

	setVolume({ volume }: { volume: number }): void {
		const clampedVolume = Math.max(0, Math.min(1, volume));
		if (clampedVolume === this.volume && this.muted === (clampedVolume === 0)) {
			return;
		}
		this.volume = clampedVolume;
		this.muted = clampedVolume === 0;
		if (clampedVolume > 0) {
			this.previousVolume = clampedVolume;
		}
		this.notify();
	}

	mute(): void {
		if (this.muted && this.volume === 0) return;
		if (this.volume > 0) {
			this.previousVolume = this.volume;
		}
		this.muted = true;
		this.volume = 0;
		this.notify();
	}

	unmute(): void {
		const nextVolume = this.previousVolume;
		if (!this.muted && this.volume === nextVolume) return;
		this.muted = false;
		this.volume = nextVolume;
		this.notify();
	}

	toggleMute(): void {
		if (this.muted) {
			this.unmute();
		} else {
			this.mute();
		}
	}

	getIsPlaying(): boolean {
		return this.isPlaying;
	}

	getCurrentTime(): number {
		return this.currentTime;
	}

	getVolume(): number {
		return this.volume;
	}

	isMuted(): boolean {
		return this.muted;
	}

	setScrubbing({ isScrubbing }: { isScrubbing: boolean }): void {
		if (this.isScrubbing === isScrubbing) return;
		this.isScrubbing = isScrubbing;
		this.notify();
	}

	getIsScrubbing(): boolean {
		return this.isScrubbing;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}

	private startTimer(): void {
		if (this.playbackTimer) {
			cancelAnimationFrame(this.playbackTimer);
		}

		this.lastUpdate = performance.now();
		this.lastNotifiedAt = 0;
		this.updateTime();
	}

	private stopTimer(): void {
		if (this.playbackTimer) {
			cancelAnimationFrame(this.playbackTimer);
			this.playbackTimer = null;
		}
	}

	private updateTime = (): void => {
		if (!this.isPlaying) return;

		const now = performance.now();
		const delta = (now - this.lastUpdate) / 1000;
		this.lastUpdate = now;

		const newTime = this.currentTime + delta;
		const duration = this.editor.timeline.getTotalDuration();

		if (duration > 0 && newTime >= duration) {
			this.pause();
			this.currentTime = duration;
			this.notify();

			window.dispatchEvent(
				new CustomEvent("playback-seek", {
					detail: { time: duration },
				}),
			);
		} else {
			this.currentTime = newTime;
			const activeProject = this.editor.project.getActive();
			const fps = Math.max(1, Math.min(30, activeProject?.settings.fps ?? 30));
			const minNotifyIntervalMs = 1000 / fps;
			const shouldNotify =
				this.lastNotifiedAt === 0 || now - this.lastNotifiedAt >= minNotifyIntervalMs;

			if (shouldNotify) {
				this.lastNotifiedAt = now;
				this.notify();
				window.dispatchEvent(
					new CustomEvent("playback-update", {
						detail: { time: newTime },
					}),
				);
			}
		}

		this.playbackTimer = requestAnimationFrame(this.updateTime);
	};

	private emitPlaybackStateEvent({
		isPlaying,
	}: {
		isPlaying: boolean;
	}): void {
		if (typeof window === "undefined") return;
		window.dispatchEvent(
			new CustomEvent("opencut:timeline-playback-state", {
				detail: { isPlaying },
			}),
		);
	}
}
