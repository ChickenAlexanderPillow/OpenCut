import type { ShortcutKey } from "@/types/keybinding";

export type TActionCategory =
	| "playback"
	| "navigation"
	| "editing"
	| "selection"
	| "history"
	| "timeline"
	| "controls";

export interface TActionDefinition {
	description: string;
	category: TActionCategory;
	defaultShortcuts?: ShortcutKey[];
	args?: Record<string, unknown>;
}

export const ACTIONS = {
	"toggle-play": {
		description: "Play/Pause",
		category: "playback",
		defaultShortcuts: ["space", "k"],
	},
	"toggle-loop-playback": {
		description: "Toggle playback loop",
		category: "playback",
	},
	"stop-playback": {
		description: "Stop playback",
		category: "playback",
	},
	"seek-forward": {
		description: "Seek forward 1 second",
		category: "playback",
		defaultShortcuts: ["l"],
		args: { seconds: "number" },
	},
	"seek-backward": {
		description: "Seek backward 1 second",
		category: "playback",
		defaultShortcuts: ["j"],
		args: { seconds: "number" },
	},
	"frame-step-forward": {
		description: "Frame step forward",
		category: "navigation",
		defaultShortcuts: ["right"],
	},
	"frame-step-backward": {
		description: "Frame step backward",
		category: "navigation",
		defaultShortcuts: ["left"],
	},
	"jump-forward": {
		description: "Jump forward 5 seconds",
		category: "navigation",
		defaultShortcuts: ["shift+right"],
		args: { seconds: "number" },
	},
	"jump-backward": {
		description: "Jump backward 5 seconds",
		category: "navigation",
		defaultShortcuts: ["shift+left"],
		args: { seconds: "number" },
	},
	"goto-start": {
		description: "Go to timeline start",
		category: "navigation",
		defaultShortcuts: ["home", "enter"],
	},
	"goto-end": {
		description: "Go to timeline end",
		category: "navigation",
		defaultShortcuts: ["end"],
	},
	split: {
		description: "Split elements at playhead",
		category: "editing",
		defaultShortcuts: ["s"],
	},
	"split-left": {
		description: "Split and remove left",
		category: "editing",
		defaultShortcuts: ["q"],
	},
	"split-right": {
		description: "Split and remove right",
		category: "editing",
		defaultShortcuts: ["w"],
	},
	"smart-cut-selected": {
		description: "Smart cut selected media elements",
		category: "editing",
	},
	"generate-viral-clips": {
		description: "Generate viral clip candidates from selected source media",
		category: "editing",
		args: { sourceMediaId: "string" },
	},
	"import-selected-viral-clips": {
		description: "Import selected viral clip candidates as new scenes",
		category: "editing",
		args: { candidateIds: "string[]" },
	},
	"transcript-toggle-word": {
		description: "Toggle transcript word removal state",
		category: "editing",
		args: { trackId: "string", elementId: "string", wordId: "string" },
	},
	"transcript-toggle-word-hidden": {
		description: "Toggle transcript word caption visibility state",
		category: "editing",
		args: { trackId: "string", elementId: "string", wordId: "string" },
	},
	"transcript-update-word": {
		description: "Update transcript word text",
		category: "editing",
		args: {
			trackId: "string",
			elementId: "string",
			wordId: "string",
			text: "string",
		},
	},
	"transcript-update-words": {
		description: "Update multiple transcript words",
		category: "editing",
		args: {
			trackId: "string",
			elementId: "string",
			updates: "Array<{ wordId: string; text: string }>",
		},
	},
	"transcript-set-words-removed": {
		description: "Set transcript words removed state",
		category: "editing",
		args: {
			trackId: "string",
			elementId: "string",
			wordIds: "string[]",
			removed: "boolean",
		},
	},
	"transcript-remove-fillers": {
		description: "Remove filler words from transcript",
		category: "editing",
		args: { trackId: "string", elementId: "string" },
	},
	"transcript-remove-pauses": {
		description: "Remove long pauses from transcript",
		category: "editing",
		args: {
			trackId: "string",
			elementId: "string",
			thresholdSeconds: "number",
		},
	},
	"transcript-restore-all": {
		description: "Restore all removed transcript words",
		category: "editing",
		args: { trackId: "string", elementId: "string" },
	},
	"transcript-split-segment-ui": {
		description: "Split transcript segment in UI",
		category: "editing",
		args: { trackId: "string", elementId: "string", wordId: "string" },
	},
	"transcript-update-speaker-label": {
		description: "Update a transcript speaker label",
		category: "editing",
		args: {
			trackId: "string",
			elementId: "string",
			speakerId: "string",
			label: "string",
		},
	},
	"transcript-update-gap-text": {
		description: "Update transcript gap text",
		category: "editing",
		args: {
			trackId: "string",
			elementId: "string",
			leftWordId: "string",
			rightWordId: "string",
			text: "string",
		},
	},
	"transcript-toggle-gap-removed": {
		description: "Toggle transcript gap removed state",
		category: "editing",
		args: {
			trackId: "string",
			elementId: "string",
			leftWordId: "string",
			rightWordId: "string",
			removed: "boolean",
		},
	},
	"rebuild-captions-for-clip": {
		description:
			"Rebuild captions for a clip and replace the current caption track",
		category: "editing",
		args: { trackId: "string", elementId: "string" },
	},
	"refresh-derived-media-after-clip-expansion": {
		description:
			"Refresh generated captions and motion tracking after a clip expansion",
		category: "editing",
		args: {
			trackId: "string",
			elementId: "string",
			previousTrimStart: "number",
			previousDuration: "number",
			previousTranscriptUpdatedAt: "string",
		},
	},
	"apply-transition-in": {
		description: "Apply an in transition preset to selected or targeted clips",
		category: "editing",
		args: {
			presetId: "string",
			durationSeconds: "number",
			trackId: "string",
			elementId: "string",
		},
	},
	"apply-transition-out": {
		description: "Apply an out transition preset to selected or targeted clips",
		category: "editing",
		args: {
			presetId: "string",
			durationSeconds: "number",
			trackId: "string",
			elementId: "string",
		},
	},
	"remove-transition-in": {
		description: "Remove in transition from selected or targeted clips",
		category: "editing",
		args: { trackId: "string", elementId: "string" },
	},
	"remove-transition-out": {
		description: "Remove out transition from selected or targeted clips",
		category: "editing",
		args: { trackId: "string", elementId: "string" },
	},
	"caption-run-drift-check": {
		description: "Run caption drift check and auto-heal stale captions",
		category: "editing",
	},
	"clear-viral-clips-session": {
		description: "Clear generated viral clips session",
		category: "editing",
	},
	"toggle-split-screen-selected": {
		description: "Toggle split screen for selected video clip",
		category: "editing",
	},
	"generate-speaker-turn-reframes": {
		description: "Generate reframe switches from diarized speaker turns",
		category: "editing",
		args: { trackId: "string", elementId: "string" },
	},
	"delete-selected": {
		description: "Delete selected elements",
		category: "editing",
		defaultShortcuts: ["backspace", "delete"],
	},
	"ripple-delete-gap": {
		description: "Ripple delete selected gap",
		category: "editing",
		args: {
			trackId: "string",
			startTime: "number",
			endTime: "number",
		},
	},
	"copy-selected": {
		description: "Copy selected elements",
		category: "editing",
		defaultShortcuts: ["ctrl+c"],
	},
	"paste-copied": {
		description: "Paste elements at playhead",
		category: "editing",
		defaultShortcuts: ["ctrl+v"],
	},
	"toggle-snapping": {
		description: "Toggle snapping",
		category: "editing",
		defaultShortcuts: ["n"],
	},
	"select-all": {
		description: "Select all elements",
		category: "selection",
		defaultShortcuts: ["ctrl+a"],
	},
	"select-all-captions": {
		description: "Select all caption elements",
		category: "selection",
		args: { trackId: "string" },
	},
	"duplicate-selected": {
		description: "Duplicate selected element",
		category: "selection",
		defaultShortcuts: ["ctrl+d"],
	},
	"toggle-elements-muted-selected": {
		description: "Mute/unmute selected elements",
		category: "selection",
	},
	"toggle-elements-visibility-selected": {
		description: "Show/hide selected elements",
		category: "selection",
	},
	"toggle-bookmark": {
		description: "Toggle bookmark at playhead",
		category: "timeline",
	},
	"set-in-point": {
		description: "Set in point at playhead",
		category: "timeline",
		defaultShortcuts: ["i"],
	},
	"set-out-point": {
		description: "Set out point at playhead",
		category: "timeline",
		defaultShortcuts: ["o"],
	},
	"clear-in-out-points": {
		description: "Clear in/out points",
		category: "timeline",
	},
	undo: {
		description: "Undo",
		category: "history",
		defaultShortcuts: ["ctrl+z"],
	},
	redo: {
		description: "Redo",
		category: "history",
		defaultShortcuts: ["ctrl+shift+z", "ctrl+y"],
	},
} as const satisfies Record<string, TActionDefinition>;

export type TAction = keyof typeof ACTIONS;

export function getActionDefinition(action: TAction): TActionDefinition {
	return ACTIONS[action];
}

export function getDefaultShortcuts(): Record<ShortcutKey, TAction> {
	const shortcuts: Record<string, TAction> = {};

	for (const [action, def] of Object.entries(ACTIONS) as Array<
		[TAction, TActionDefinition]
	>) {
		if (def.defaultShortcuts) {
			for (const shortcut of def.defaultShortcuts) {
				shortcuts[shortcut] = action;
			}
		}
	}

	return shortcuts as Record<ShortcutKey, TAction>;
}
