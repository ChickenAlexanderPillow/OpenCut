"use client";

import { useEffect } from "react";
import { Separator } from "@/components/ui/separator";
import {
	TAB_KEYS,
	type Tab,
	useAssetsPanelStore,
} from "@/stores/assets-panel-store";
import { TabBar } from "./tabbar";
import { Clips } from "./views/clips";
import { TransitionsView } from "./views/transitions";
import { MediaView } from "./views/assets";
import { SettingsView } from "./views/settings";
import { TextView } from "./views/text";
import { OverlayView } from "./views/overlay";
import { TranscriptView } from "./views/transcript";
import { MusicView } from "./views/music";
import { MixerView } from "./views/mixer";
import { cn } from "@/utils/ui";

export function AssetsPanel() {
	const { activeTab, setActiveTab } = useAssetsPanelStore();
	const resolvedActiveTab = TAB_KEYS.includes(activeTab) ? activeTab : "media";

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
		mixer: <MixerView />,
		transitions: <TransitionsView />,
		overlay: <OverlayView />,
		settings: <SettingsView />,
	};

	return (
		<div
			className="panel bg-background flex h-full rounded-sm border overflow-hidden"
			data-editor-selection-root="assets"
		>
			<TabBar />
			<Separator orientation="vertical" />
			<div className="flex-1 overflow-hidden relative">
				{TAB_KEYS.map((tab) => (
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
		</div>
	);
}
