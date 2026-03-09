"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invokeAction } from "@/lib/actions";
import { TRANSITION_PRESETS } from "@/lib/transitions/presets";

function TransitionThumbnail({ presetId }: { presetId: string }) {
	const commonFrame =
		"absolute rounded-[0.4rem] border border-white/30 shadow-[0_10px_30px_rgba(0,0,0,0.28)]";

	let content: ReactNode;
	switch (presetId) {
		case "fade":
			content = (
				<>
					<div className="absolute inset-0 bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_38%,#f59e0b_100%)]" />
					<div className="absolute inset-y-0 left-0 w-[48%] bg-black/42" />
					<div className="absolute inset-y-0 right-0 w-[46%] bg-white/12" />
					<div className="absolute inset-y-0 left-[44%] w-[18%] bg-gradient-to-r from-transparent via-white/70 to-transparent blur-md" />
				</>
			);
			break;
		case "scale":
			content = (
				<>
					<div className="absolute inset-0 bg-[radial-gradient(circle_at_35%_35%,#22d3ee_0%,#0891b2_32%,#0f172a_100%)]" />
					<div className={`${commonFrame} inset-[16%] bg-white/10 backdrop-blur-[1px]`} />
					<div className={`${commonFrame} inset-[24%] bg-white/16`} />
					<div className={`${commonFrame} inset-[33%] bg-white/24`} />
				</>
			);
			break;
		case "zoom":
			content = (
				<>
					<div className="absolute inset-0 bg-[linear-gradient(140deg,#111827_0%,#1d4ed8_40%,#93c5fd_100%)]" />
					<div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.2)_0%,transparent_54%)]" />
					<div className={`${commonFrame} inset-[18%] bg-black/18`} />
					<div className={`${commonFrame} inset-[28%] bg-white/14`} />
					<div className="absolute inset-[28%] rounded-[0.5rem] ring-2 ring-white/65 ring-offset-0" />
				</>
			);
			break;
		case "fade-zoom":
			content = (
				<>
					<div className="absolute inset-0 bg-[linear-gradient(160deg,#1f2937_0%,#7c3aed_48%,#f97316_100%)]" />
					<div className="absolute inset-y-0 left-0 w-[44%] bg-black/48" />
					<div className="absolute inset-y-0 left-[36%] w-[24%] bg-gradient-to-r from-transparent via-white/75 to-transparent blur-md" />
					<div className={`${commonFrame} inset-[24%] bg-white/12`} />
					<div className={`${commonFrame} inset-[32%] bg-white/22`} />
				</>
			);
			break;
		case "motion-blur-zoom":
			content = (
				<>
					<div className="absolute inset-0 bg-[linear-gradient(145deg,#111827_0%,#1d4ed8_34%,#06b6d4_65%,#f8fafc_100%)]" />
					<div className="absolute inset-y-[22%] left-[10%] right-[10%] rounded-full bg-white/14 blur-xl" />
					<div className={`${commonFrame} inset-[24%] bg-white/16`} />
					<div className={`${commonFrame} inset-[24%] translate-x-3 scale-[1.05] border-white/15 bg-white/8 blur-[1px]`} />
					<div className={`${commonFrame} inset-[24%] -translate-x-3 scale-[0.95] border-white/12 bg-white/6 blur-[2px]`} />
					<div className="absolute inset-y-[34%] left-[6%] right-[6%] bg-gradient-to-r from-transparent via-white/80 to-transparent blur-md" />
				</>
			);
			break;
		default:
			content = (
				<>
					<div className="absolute inset-0 bg-[linear-gradient(135deg,#334155_0%,#475569_45%,#94a3b8_100%)]" />
					<div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent" />
				</>
			);
			break;
	}

	return (
		<div className="relative size-full overflow-hidden rounded-sm bg-slate-950">
			{content}
		</div>
	);
}

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
							preview={<TransitionThumbnail presetId={preset.id} />}
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
