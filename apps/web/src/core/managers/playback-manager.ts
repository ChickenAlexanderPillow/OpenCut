import type { EditorCore } from "@/core";

export class PlaybackManager {
	private isPlaying = false;
	private currentTime = 0;
	private volume = 1;
	private muted = false;
	private loopEnabled = false;
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
		const playbackBounds = this.getPlaybackBounds({ duration });

		if (duration > 0) {
			if (
				this.currentTime >= playbackBounds.end ||
				this.currentTime < playbackBounds.start
			) {
				this.seek({ time: playbackBounds.start });
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

	getIsLoopEnabled(): boolean {
		return this.loopEnabled;
	}

	setLoopEnabled({ enabled }: { enabled: boolean }): void {
		if (this.loopEnabled === enabled) return;
		this.loopEnabled = enabled;
		this.notify();
	}

	toggleLoopEnabled(): void {
		this.setLoopEnabled({ enabled: !this.loopEnabled });
	}

	getInPoint(): number | null {
		const duration = this.editor.timeline.getTotalDuration();
		const { inPoint } = this.getStoredRange();
		if (inPoint === null) return null;
		return this.clampToDuration({ value: inPoint, duration });
	}

	getOutPoint(): number | null {
		const duration = this.editor.timeline.getTotalDuration();
		const { outPoint } = this.getStoredRange();
		if (outPoint === null) return null;
		return this.clampToDuration({ value: outPoint, duration });
	}

	setInPoint({ time }: { time: number }): void {
		const duration = this.editor.timeline.getTotalDuration();
		const clampedInPoint = this.clampToDuration({ value: time, duration });
		const { outPoint } = this.getStoredRange();
		const nextOutPoint =
			outPoint !== null && outPoint <= clampedInPoint ? null : outPoint;
		this.updateStoredRange({
			inPoint: clampedInPoint,
			outPoint: nextOutPoint,
		});
	}

	setOutPoint({ time }: { time: number }): void {
		const duration = this.editor.timeline.getTotalDuration();
		const clampedOutPoint = this.clampToDuration({ value: time, duration });
		const { inPoint } = this.getStoredRange();
		const nextInPoint =
			inPoint !== null && inPoint >= clampedOutPoint ? null : inPoint;
		this.updateStoredRange({
			inPoint: nextInPoint,
			outPoint: clampedOutPoint,
		});
	}

	setInPointAtCurrentTime(): void {
		this.setInPoint({ time: this.currentTime });
	}

	setOutPointAtCurrentTime(): void {
		this.setOutPoint({ time: this.currentTime });
	}

	clearInOutPoints(): void {
		this.updateStoredRange({ inPoint: null, outPoint: null });
	}

	getPlaybackBounds({
		duration = this.editor.timeline.getTotalDuration(),
	}: {
		duration?: number;
	} = {}): { start: number; end: number; hasCustomRange: boolean } {
		const { inPoint, outPoint } = this.getStoredRange();
		const clampedInPoint =
			inPoint === null ? null : this.clampToDuration({ value: inPoint, duration });
		const clampedOutPoint =
			outPoint === null
				? null
				: this.clampToDuration({ value: outPoint, duration });
		const start = clampedInPoint ?? 0;
		const end = clampedOutPoint ?? duration;
		if (end <= start + 1e-6) {
			return { start: 0, end: duration, hasCustomRange: false };
		}
		return {
			start,
			end,
			hasCustomRange: clampedInPoint !== null || clampedOutPoint !== null,
		};
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
		const playbackBounds = this.getPlaybackBounds({ duration });
		const loopDuration = Math.max(0, playbackBounds.end - playbackBounds.start);

		if (duration > 0 && newTime >= playbackBounds.end) {
			if (this.loopEnabled && loopDuration > 0) {
				const overflow = newTime - playbackBounds.end;
				this.currentTime =
					playbackBounds.start + (overflow % Math.max(loopDuration, 1e-6));
				this.notify();
				window.dispatchEvent(
					new CustomEvent("playback-seek", {
						detail: { time: this.currentTime },
					}),
				);
			} else {
				this.pause();
				this.currentTime = playbackBounds.end;
				this.notify();

				window.dispatchEvent(
					new CustomEvent("playback-seek", {
						detail: { time: playbackBounds.end },
					}),
				);
			}
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

	private getStoredRange(): { inPoint: number | null; outPoint: number | null } {
		const viewState = this.editor.project.getTimelineViewState();
		return {
			inPoint: viewState.inPoint ?? null,
			outPoint: viewState.outPoint ?? null,
		};
	}

	private updateStoredRange({
		inPoint,
		outPoint,
	}: {
		inPoint: number | null;
		outPoint: number | null;
	}): void {
		const viewState = this.editor.project.getTimelineViewState();
		this.editor.project.setTimelineViewState({
			viewState: {
				...viewState,
				inPoint,
				outPoint,
			},
		});
		this.notify();
	}

	private clampToDuration({
		value,
		duration,
	}: {
		value: number;
		duration: number;
	}): number {
		return Math.max(0, Math.min(duration, value));
	}

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
