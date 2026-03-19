"use client";

import { useEffect } from "react";
import { Separator } from "@/components/ui/separator";
import { type Tab, useAssetsPanelStore } from "@/stores/assets-panel-store";
import { AssetsTabRail, TabBar } from "./tabbar";
import { Clips } from "./views/clips";
import { TransitionsView } from "./views/transitions";
import { MediaView } from "./views/assets";
import { SettingsView } from "./views/settings";
import { TextView } from "./views/text";
import { OverlayView } from "./views/overlay";
import { TranscriptView } from "./views/transcript";
import { MusicView } from "./views/music";
import { MixerView } from "./views/mixer";
import { ReframeView } from "./views/reframe";
import { cn } from "@/utils/ui";

const ASSET_PANEL_TABS: Tab[] = [
	"media",
	"music",
	"clips",
	"transcript",
	"text",
	"reframe",
	"mixer",
	"transitions",
	"overlay",
	"settings",
];

export function AssetsPanel() {
	return (
		<div
			className="panel bg-background flex h-full rounded-sm border overflow-hidden"
			data-editor-selection-root="assets"
		>
			<TabBar />
			<Separator orientation="vertical" />
			<AssetsPanelContent />
		</div>
	);
}

export function AssetsPanelSidebar({
	onTabSelect,
}: {
	onTabSelect?: (tab: Tab) => void;
}) {
	return (
		<div
			className="panel bg-background flex h-full rounded-sm border overflow-hidden"
			data-editor-selection-root="assets"
		>
			<AssetsTabRail onTabSelect={onTabSelect} />
			<Separator orientation="vertical" />
		</div>
	);
}

export function AssetsPanelContent() {
	const { activeTab, setActiveTab } = useAssetsPanelStore();
	const resolvedActiveTab = ASSET_PANEL_TABS.includes(activeTab) ? activeTab : "media";

	useEffect(() => {
		if (activeTab !== resolvedActiveTab) {
			setActiveTab(resolvedActiveTab);
		}
	}, [activeTab, resolvedActiveTab, setActiveTab]);

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		music: <MusicView />,
		clips: <Clips />,
		transcript: <TranscriptView />,
		text: <TextView />,
		reframe: <ReframeView />,
		mixer: <MixerView />,
		transitions: <TransitionsView />,
		overlay: <OverlayView />,
		settings: <SettingsView />,
	};

	return (
		<div className="flex-1 overflow-hidden relative bg-background">
			{ASSET_PANEL_TABS.map((tab) => (
				<div
					key={tab}
					className={cn(
						"absolute inset-0",
						resolvedActiveTab === tab ? "block" : "hidden",
					)}
				>
					{viewMap[tab]}
				</div>
			))}
		</div>
	);
}
