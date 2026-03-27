import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TPlatformLayout } from "@/types/editor";
import type { PreviewRendererMode } from "@/services/renderer/webgpu-types";

interface LayoutGuideSettings {
	platform: TPlatformLayout | null;
}

interface PreviewOverlaysState {
	bookmarks: boolean;
	safeAreas: boolean;
	trackingDebug: boolean;
}

export type PreviewPlaybackQuality = "performance" | "balanced" | "full";
export type PreviewFormatVariant = "project" | "square" | "portrait";

interface SquareFormatSettings {
	blurIntensity: number;
	coverOverscanPercent: number;
}

interface PreviewState {
	layoutGuide: LayoutGuideSettings;
	overlays: PreviewOverlaysState;
	playbackQuality: PreviewPlaybackQuality;
	previewRendererMode: PreviewRendererMode;
	previewFormatVariant: PreviewFormatVariant;
	squareFormatSettings: SquareFormatSettings;
	setLayoutGuide: (settings: Partial<LayoutGuideSettings>) => void;
	toggleLayoutGuide: (platform: TPlatformLayout) => void;
	setPlaybackQuality: ({
		quality,
	}: {
		quality: PreviewPlaybackQuality;
	}) => void;
	setPreviewRendererMode: ({ mode }: { mode: PreviewRendererMode }) => void;
	setPreviewFormatVariant: ({
		variant,
	}: {
		variant: PreviewFormatVariant;
	}) => void;
	setSquareFormatSettings: ({
		settings,
	}: {
		settings: Partial<SquareFormatSettings>;
	}) => void;
	setOverlayVisibility: ({
		overlay,
		isVisible,
	}: {
		overlay: keyof PreviewOverlaysState;
		isVisible: boolean;
	}) => void;
	toggleOverlayVisibility: ({
		overlay,
	}: {
		overlay: keyof PreviewOverlaysState;
	}) => void;
}

const DEFAULT_PREVIEW_OVERLAYS: PreviewOverlaysState = {
	bookmarks: true,
	safeAreas: false,
	trackingDebug: false,
};

export const usePreviewStore = create<PreviewState>()(
	persist(
		(set) => ({
			layoutGuide: { platform: null },
			overlays: DEFAULT_PREVIEW_OVERLAYS,
			playbackQuality: "performance",
			previewRendererMode: "auto",
			previewFormatVariant: "project",
			squareFormatSettings: {
				blurIntensity: 18,
				coverOverscanPercent: 103,
			},
			setLayoutGuide: (settings) => {
				set((state) => ({
					layoutGuide: {
						...state.layoutGuide,
						...settings,
					},
				}));
			},
			setPlaybackQuality: ({ quality }) => {
				set(() => ({ playbackQuality: quality }));
			},
			setPreviewRendererMode: ({ mode }) => {
				set(() => ({ previewRendererMode: mode }));
			},
			setPreviewFormatVariant: ({ variant }) => {
				set(() => ({ previewFormatVariant: variant }));
			},
			setSquareFormatSettings: ({ settings }) => {
				set((state) => ({
					squareFormatSettings: {
						...state.squareFormatSettings,
						...settings,
					},
				}));
			},
			toggleLayoutGuide: (platform) => {
				set((state) => ({
					layoutGuide: {
						platform: state.layoutGuide.platform === platform ? null : platform,
					},
				}));
			},
			setOverlayVisibility: ({ overlay, isVisible }) => {
				set((state) => ({
					overlays: {
						...state.overlays,
						[overlay]: isVisible,
					},
				}));
			},
			toggleOverlayVisibility: ({ overlay }) => {
				set((state) => ({
					overlays: {
						...state.overlays,
						[overlay]: !state.overlays[overlay],
					},
				}));
			},
		}),
		{
			name: "preview-settings",
			version: 8,
			migrate: (persistedState, version) => {
				const state = persistedState as
					| {
							layoutGuide?: LayoutGuideSettings;
							overlays?: PreviewOverlaysState;
							playbackQuality?: PreviewPlaybackQuality;
							previewRendererMode?: PreviewRendererMode;
							previewFormatVariant?: PreviewFormatVariant;
							squareFormatSettings?: Partial<SquareFormatSettings>;
					  }
					| undefined;
				const migratedRendererMode =
					version < 7 && state?.previewRendererMode === "webgpu"
						? "auto"
						: (state?.previewRendererMode ?? "auto");

				return {
					layoutGuide: state?.layoutGuide ?? { platform: null },
					overlays: {
						...DEFAULT_PREVIEW_OVERLAYS,
						...(state?.overlays ?? {}),
					},
					playbackQuality: state?.playbackQuality ?? "performance",
					previewRendererMode: migratedRendererMode,
					previewFormatVariant: state?.previewFormatVariant ?? "project",
					squareFormatSettings: {
						blurIntensity: state?.squareFormatSettings?.blurIntensity ?? 18,
						coverOverscanPercent:
							state?.squareFormatSettings?.coverOverscanPercent ?? 103,
					},
				};
			},
			partialize: (state) => ({
				layoutGuide: state.layoutGuide,
				overlays: state.overlays,
				playbackQuality: state.playbackQuality,
				previewRendererMode: state.previewRendererMode,
				previewFormatVariant: state.previewFormatVariant,
				squareFormatSettings: state.squareFormatSettings,
			}),
		},
	),
);
