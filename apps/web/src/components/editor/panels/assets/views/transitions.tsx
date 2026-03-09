"use client";

import { useMemo, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invokeAction } from "@/lib/actions";
import { TRANSITION_PRESETS } from "@/lib/transitions/presets";

export function TransitionsView() {
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return TRANSITION_PRESETS;
		return TRANSITION_PRESETS.filter((preset) =>
			`${preset.name} ${preset.description} ${preset.category}`
				.toLowerCase()
				.includes(normalized),
		);
	}, [query]);

	return (
		<PanelView title="Transitions" contentClassName="space-y-3 pb-3">
			<Input
				placeholder="Search transitions"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				className="h-8"
			/>
			<div className="grid grid-cols-2 gap-2">
				{filtered.map((preset) => (
					<div key={preset.id} className="rounded-md border p-2">
						<DraggableItem
							name={preset.name}
							preview={
								<div className="bg-accent/60 relative size-full overflow-hidden rounded-sm">
									<div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent" />
								</div>
							}
							dragData={{
								id: `transition:${preset.id}`,
								type: "transition",
								name: preset.name,
								presetId: preset.id,
							}}
							aspectRatio={16 / 9}
							shouldShowLabel={false}
							containerClassName="w-full"
							shouldShowPlusOnDrag={false}
							onAddToTimeline={() =>
								invokeAction("apply-transition-in", {
									presetId: preset.id,
								})
							}
						/>
						<div className="mt-2 space-y-2">
							<div>
								<div className="text-xs font-medium">{preset.name}</div>
								<div className="text-[11px] text-muted-foreground leading-tight">
									{preset.description}
								</div>
							</div>
							<div className="flex gap-1">
								<Button
									size="sm"
									variant="outline"
									className="h-7 flex-1 px-2 text-xs"
									onClick={() =>
										invokeAction("apply-transition-in", {
											presetId: preset.id,
										})
									}
								>
									Apply In
								</Button>
								<Button
									size="sm"
									variant="outline"
									className="h-7 flex-1 px-2 text-xs"
									onClick={() =>
										invokeAction("apply-transition-out", {
											presetId: preset.id,
										})
									}
								>
									Apply Out
								</Button>
							</div>
						</div>
					</div>
				))}
			</div>
		</PanelView>
	);
}
