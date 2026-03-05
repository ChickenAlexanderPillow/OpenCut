import { PlaybackManager } from "./managers/playback-manager";
import { TimelineManager } from "./managers/timeline-manager";
import { ScenesManager } from "./managers/scenes-manager";
import { ProjectManager } from "./managers/project-manager";
import { MediaManager } from "./managers/media-manager";
import { RendererManager } from "./managers/renderer-manager";
import { CommandManager } from "./managers/commands";
import { SaveManager } from "./managers/save-manager";
import { AudioManager } from "./managers/audio-manager";
import { SelectionManager } from "./managers/selection-manager";
import { AppLifecycleManager } from "./managers/app-lifecycle-manager";

const EDITOR_CORE_GLOBAL_KEY = "__opencut_editor_core_singleton__";

type GlobalWithEditorCore = typeof globalThis & {
	[EDITOR_CORE_GLOBAL_KEY]?: EditorCore | null;
};

export class EditorCore {
	private static instance: EditorCore | null = null;

	public readonly command: CommandManager;
	public readonly playback: PlaybackManager;
	public readonly timeline: TimelineManager;
	public readonly scenes: ScenesManager;
	public readonly project: ProjectManager;
	public readonly media: MediaManager;
	public readonly renderer: RendererManager;
	public readonly save: SaveManager;
	public readonly audio: AudioManager;
	public readonly selection: SelectionManager;
	public readonly lifecycle: AppLifecycleManager;

	private constructor() {
		this.command = new CommandManager();
		this.playback = new PlaybackManager(this);
		this.timeline = new TimelineManager(this);
		this.scenes = new ScenesManager(this);
		this.project = new ProjectManager(this);
		this.media = new MediaManager(this);
		this.renderer = new RendererManager(this);
		this.save = new SaveManager(this);
		this.audio = new AudioManager(this);
		this.selection = new SelectionManager(this);
		this.lifecycle = new AppLifecycleManager(this);
		this.save.start();
	}

	static getInstance(): EditorCore {
		const globalScope = globalThis as GlobalWithEditorCore;
		const globalInstance = globalScope[EDITOR_CORE_GLOBAL_KEY] ?? null;
		if (globalInstance) {
			EditorCore.instance = globalInstance;
			return globalInstance;
		}
		if (!EditorCore.instance) {
			EditorCore.instance = new EditorCore();
		}
		globalScope[EDITOR_CORE_GLOBAL_KEY] = EditorCore.instance;
		return EditorCore.instance;
	}

	static reset(): void {
		const globalScope = globalThis as GlobalWithEditorCore;
		const instance =
			EditorCore.instance ?? globalScope[EDITOR_CORE_GLOBAL_KEY] ?? null;
		instance?.dispose();
		EditorCore.instance = null;
		globalScope[EDITOR_CORE_GLOBAL_KEY] = null;
	}

	private dispose(): void {
		this.playback.pause();
		this.save.pause();
		this.lifecycle.dispose();
		this.audio.dispose();
	}
}
