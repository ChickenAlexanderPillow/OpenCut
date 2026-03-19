import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	PANEL_CONFIG,
	type EditorLayoutPreset,
} from "@/constants/editor-constants";

export interface PanelSizes {
	tools: number;
	preview: number;
	properties: number;
	mainContent: number;
	timeline: number;
}

export type PanelId = keyof PanelSizes;

interface PanelState {
	layoutPreset: EditorLayoutPreset;
	panels: PanelSizes;
	panelsByPreset: Record<EditorLayoutPreset, PanelSizes>;
	setLayoutPreset: (preset: EditorLayoutPreset) => void;
	setPanel: (panel: PanelId, size: number) => void;
	setPanels: (sizes: Partial<PanelSizes>) => void;
	resetPanels: () => void;
}

function clonePanels(panels: PanelSizes): PanelSizes {
	return { ...panels };
}

function buildDefaultPanelsByPreset(): Record<EditorLayoutPreset, PanelSizes> {
	return {
		default: clonePanels(PANEL_CONFIG.panels.default),
		"right-preview": clonePanels(PANEL_CONFIG.panels["right-preview"]),
	};
}

function migrateRightPreviewDefaults(panels: PanelSizes): PanelSizes {
	if (panels.preview !== 36) return panels;

	return {
		...panels,
		preview: PANEL_CONFIG.panels["right-preview"].preview,
	};
}

export const usePanelStore = create<PanelState>()(
	persist(
		(set) => ({
			layoutPreset: PANEL_CONFIG.layoutPreset,
			panels: clonePanels(PANEL_CONFIG.panels[PANEL_CONFIG.layoutPreset]),
			panelsByPreset: buildDefaultPanelsByPreset(),
			setLayoutPreset: (layoutPreset) =>
				set((state) => ({
					layoutPreset,
					panels: clonePanels(state.panelsByPreset[layoutPreset]),
				})),
			setPanel: (panel, size) =>
				set((state) => ({
					panels: clonePanels({
						...state.panels,
						[panel]: size,
					}),
					panelsByPreset: {
						...state.panelsByPreset,
						[state.layoutPreset]: {
							...state.panelsByPreset[state.layoutPreset],
							[panel]: size,
						},
					},
				})),
			setPanels: (sizes) =>
				set((state) => ({
					panels: clonePanels({
						...state.panels,
						...sizes,
					}),
					panelsByPreset: {
						...state.panelsByPreset,
						[state.layoutPreset]: {
							...state.panelsByPreset[state.layoutPreset],
							...sizes,
						},
					},
				})),
			resetPanels: () =>
				set((state) => {
					const panelsByPreset = buildDefaultPanelsByPreset();
					return {
						layoutPreset: state.layoutPreset,
						panels: clonePanels(panelsByPreset[state.layoutPreset]),
						panelsByPreset,
					};
				}),
		}),
		{
			name: "panel-sizes",
			version: 5,
			migrate: (persistedState) => {
				const state = persistedState as
					| {
							layoutPreset?: EditorLayoutPreset;
							panels?: Partial<PanelSizes> | null;
							panelsByPreset?: Partial<
								Record<EditorLayoutPreset, Partial<PanelSizes>>
							> | null;
							toolsPanel?: number;
							previewPanel?: number;
							propertiesPanel?: number;
							mainContent?: number;
							timeline?: number;
							tools?: number;
							preview?: number;
							properties?: number;
					  }
					| undefined
					| null;

				const layoutPreset = state?.layoutPreset ?? PANEL_CONFIG.layoutPreset;
				const panelsByPreset = buildDefaultPanelsByPreset();

				if (!state) {
					return {
						layoutPreset,
						panels: clonePanels(panelsByPreset[layoutPreset]),
						panelsByPreset,
					};
				}

				if (state.panelsByPreset && typeof state.panelsByPreset === "object") {
					const mergedPanelsByPreset: Record<EditorLayoutPreset, PanelSizes> = {
						default: {
							...panelsByPreset.default,
							...(state.panelsByPreset.default ?? {}),
						},
						"right-preview": migrateRightPreviewDefaults({
							...panelsByPreset["right-preview"],
							...(state.panelsByPreset["right-preview"] ?? {}),
						}),
					};

					return {
						layoutPreset,
						panels: clonePanels(mergedPanelsByPreset[layoutPreset]),
						panelsByPreset: mergedPanelsByPreset,
					};
				}

				if (state.panels && typeof state.panels === "object") {
					const legacyPanels = {
						...panelsByPreset.default,
						...state.panels,
					};
					return {
						layoutPreset,
						panels: clonePanels(legacyPanels),
						panelsByPreset: {
							...panelsByPreset,
							default: legacyPanels,
						},
					};
				}

				const legacyPanels = {
					tools:
						state.tools ?? state.toolsPanel ?? panelsByPreset.default.tools,
					preview:
						state.preview ??
						state.previewPanel ??
						panelsByPreset.default.preview,
					properties:
						state.properties ??
						state.propertiesPanel ??
						panelsByPreset.default.properties,
					mainContent: state.mainContent ?? panelsByPreset.default.mainContent,
					timeline: state.timeline ?? panelsByPreset.default.timeline,
				};

				return {
					layoutPreset,
					panels: clonePanels(legacyPanels),
					panelsByPreset: {
						...panelsByPreset,
						default: legacyPanels,
					},
				};
			},
			partialize: (state) => ({
				layoutPreset: state.layoutPreset,
				panelsByPreset: state.panelsByPreset,
			}),
		},
	),
);
