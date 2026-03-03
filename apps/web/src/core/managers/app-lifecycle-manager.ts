import type { EditorCore } from "@/core";

export class AppLifecycleManager {
	private isBackgrounded = false;
	private resumePlaybackOnFocus = false;

	constructor(private editor: EditorCore) {
		if (typeof window === "undefined" || typeof document === "undefined") {
			return;
		}

		document.addEventListener("visibilitychange", this.handleLifecycleEvent);
		this.applyLifecycleState();
	}

	dispose(): void {
		if (typeof window === "undefined" || typeof document === "undefined") {
			return;
		}
		document.removeEventListener("visibilitychange", this.handleLifecycleEvent);
	}

	private handleLifecycleEvent = (): void => {
		this.applyLifecycleState();
	};

	private applyLifecycleState(): void {
		if (typeof document === "undefined") return;
		const shouldBeBackgrounded = document.hidden;

		if (shouldBeBackgrounded && !this.isBackgrounded) {
			this.enterBackground();
			return;
		}
		if (!shouldBeBackgrounded && this.isBackgrounded) {
			this.exitBackground();
		}
	}

	private enterBackground(): void {
		this.isBackgrounded = true;
		this.resumePlaybackOnFocus = this.editor.playback.getIsPlaying();
		if (this.resumePlaybackOnFocus) {
			this.editor.playback.pause();
		}
		void this.editor.audio.suspendContext();
	}

	private exitBackground(): void {
		this.isBackgrounded = false;
		void this.editor.audio.resumeContext();
		if (this.resumePlaybackOnFocus) {
			this.resumePlaybackOnFocus = false;
			this.editor.playback.play();
		}
	}
}
