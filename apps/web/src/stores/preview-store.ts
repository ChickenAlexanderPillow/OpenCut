import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TPlatformLayout } from "@/types/editor";

interface LayoutGuideSettings {
	platform: TPlatformLayout | null;
}

interface PreviewOverlaysState {
	bookmarks: boolean;
}

export type PreviewPlaybackQuality = "performance" | "balanced" | "full";

interface PreviewState {
	layoutGuide: LayoutGuideSettings;
	overlays: PreviewOverlaysState;
	playbackQuality: PreviewPlaybackQuality;
	setLayoutGuide: (settings: Partial<LayoutGuideSettings>) => void;
	toggleLayoutGuide: (platform: TPlatformLayout) => void;
	setPlaybackQuality: ({ quality }: { quality: PreviewPlaybackQuality }) => void;
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
};

export const usePreviewStore = create<PreviewState>()(
	persist(
		(set) => ({
			layoutGuide: { platform: null },
			overlays: DEFAULT_PREVIEW_OVERLAYS,
			playbackQuality: "balanced",
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
			version: 3,
			migrate: (persistedState) => {
				const state = persistedState as
					| {
							layoutGuide?: LayoutGuideSettings;
							overlays?: PreviewOverlaysState;
							playbackQuality?: PreviewPlaybackQuality;
					  }
					| undefined;
				return {
					layoutGuide: state?.layoutGuide ?? { platform: null },
					overlays: state?.overlays ?? DEFAULT_PREVIEW_OVERLAYS,
					playbackQuality: state?.playbackQuality ?? "balanced",
				};
			},
			partialize: (state) => ({
				layoutGuide: state.layoutGuide,
				overlays: state.overlays,
				playbackQuality: state.playbackQuality,
			}),
		},
	),
);
