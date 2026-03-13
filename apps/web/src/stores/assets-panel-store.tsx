import type { ElementType } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	ClosedCaptionIcon,
	Folder03Icon,
	Happy01Icon,
	Image02Icon,
	Video01Icon,
	MusicNote03Icon,
	TextIcon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export const TAB_KEYS = [
	"media",
	"music",
	"clips",
	"transcript",
	"text",
	"stickers",
	"transitions",
	"overlay",
	"settings",
] as const;

export type Tab = (typeof TAB_KEYS)[number];

const createHugeiconsIcon =
	({ icon }: { icon: IconSvgElement }) =>
	({ className }: { className?: string }) => (
		<HugeiconsIcon icon={icon} className={className} />
	);

function OcTransitionsIcon({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			className={className}
		>
			<title>Transitions</title>
			<rect
				x="3.5"
				y="3.5"
				width="17"
				height="17"
				rx="4.5"
				fill="currentColor"
				fillOpacity="0.22"
				stroke="currentColor"
				strokeWidth="1.5"
			/>
			<path
				d="M7.5 15.5L11 12L13.2 14.2L16.8 8.8"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle cx="16.8" cy="8.8" r="1.2" fill="currentColor" />
		</svg>
	);
}

export const tabs = {
	media: {
		icon: createHugeiconsIcon({ icon: Folder03Icon }),
		label: "Media",
	},
	music: {
		icon: createHugeiconsIcon({ icon: MusicNote03Icon }),
		label: "Music",
	},
	clips: {
		icon: createHugeiconsIcon({ icon: Video01Icon }),
		label: "Clips",
	},
	transcript: {
		icon: createHugeiconsIcon({ icon: ClosedCaptionIcon }),
		label: "Transcript & Captions",
	},
	text: {
		icon: createHugeiconsIcon({ icon: TextIcon }),
		label: "Text",
	},
	stickers: {
		icon: createHugeiconsIcon({ icon: Happy01Icon }),
		label: "Stickers",
	},
	transitions: {
		icon: OcTransitionsIcon,
		label: "Transitions",
	},
	overlay: {
		icon: createHugeiconsIcon({ icon: Image02Icon }),
		label: "Overlay",
	},
	settings: {
		icon: createHugeiconsIcon({ icon: Settings01Icon }),
		label: "Settings",
	},
} satisfies Record<
	Tab,
	{ icon: ElementType<{ className?: string }>; label: string }
>;

type MediaViewMode = "grid" | "list";

interface AssetsPanelStore {
	activeTab: Tab;
	setActiveTab: (tab: Tab) => void;
	highlightMediaId: string | null;
	requestRevealMedia: (mediaId: string) => void;
	clearHighlight: () => void;
	clipFocusMediaId: string | null;
	requestClipSectionFocus: (mediaId: string) => void;
	clearClipSectionFocus: () => void;

	/* Media */
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
}

export const useAssetsPanelStore = create<AssetsPanelStore>()(
	persist(
		(set) => ({
			activeTab: "media",
			setActiveTab: (tab) => set({ activeTab: tab }),
			highlightMediaId: null,
			requestRevealMedia: (mediaId) =>
				set({ activeTab: "media", highlightMediaId: mediaId }),
			clearHighlight: () => set({ highlightMediaId: null }),
			clipFocusMediaId: null,
			requestClipSectionFocus: (mediaId) =>
				set({ activeTab: "clips", clipFocusMediaId: mediaId }),
			clearClipSectionFocus: () => set({ clipFocusMediaId: null }),
			mediaViewMode: "grid",
			setMediaViewMode: (mode) => set({ mediaViewMode: mode }),
		}),
		{
			name: "assets-panel-state",
			version: 1,
			partialize: (state) => ({
				activeTab: state.activeTab,
				mediaViewMode: state.mediaViewMode,
			}),
		},
	),
);
