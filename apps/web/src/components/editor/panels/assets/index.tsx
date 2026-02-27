"use client";

import { Separator } from "@/components/ui/separator";
import {
	TAB_KEYS,
	type Tab,
	useAssetsPanelStore,
} from "@/stores/assets-panel-store";
import { TabBar } from "./tabbar";
import { Captions } from "./views/captions";
import { MediaView } from "./views/assets";
import { SettingsView } from "./views/settings";
import { SoundsView } from "./views/sounds";
import { StickersView } from "./views/stickers";
import { TextView } from "./views/text";
import { cn } from "@/utils/ui";

export function AssetsPanel() {
	const { activeTab } = useAssetsPanelStore();

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		sounds: <SoundsView />,
		text: <TextView />,
		stickers: <StickersView />,
		effects: (
			<div className="text-muted-foreground p-4">
				Effects view coming soon...
			</div>
		),
		transitions: (
			<div className="text-muted-foreground p-4">
				Transitions view coming soon...
			</div>
		),
		captions: <Captions />,
		filters: (
			<div className="text-muted-foreground p-4">
				Filters view coming soon...
			</div>
		),
		adjustment: (
			<div className="text-muted-foreground p-4">
				Adjustment view coming soon...
			</div>
		),
		settings: <SettingsView />,
	};

	return (
		<div className="panel bg-background flex h-full rounded-sm border overflow-hidden">
			<TabBar />
			<Separator orientation="vertical" />
			<div className="flex-1 overflow-hidden relative">
				{TAB_KEYS.map((tab) => (
					<div
						key={tab}
						className={cn(
							"absolute inset-0",
							activeTab === tab ? "block" : "hidden",
						)}
					>
						{viewMap[tab]}
					</div>
				))}
			</div>
		</div>
	);
}
