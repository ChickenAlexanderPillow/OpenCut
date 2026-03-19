export type EditorLayoutPreset = "default" | "right-preview";

export const DEFAULT_PANEL_SIZES = {
	tools: 25,
	preview: 50,
	properties: 25,
	mainContent: 50,
	timeline: 50,
} as const;

export const RIGHT_PREVIEW_PANEL_SIZES = {
	tools: 62,
	preview: 28,
	properties: 38,
	mainContent: 56,
	timeline: 44,
} as const;

export const PANEL_CONFIG = {
	layoutPreset: "default" as EditorLayoutPreset,
	panels: {
		default: { ...DEFAULT_PANEL_SIZES },
		"right-preview": { ...RIGHT_PREVIEW_PANEL_SIZES },
	},
};
