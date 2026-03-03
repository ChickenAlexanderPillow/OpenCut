"use client";

import { useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/hooks/use-editor";
import { Sparkles } from "lucide-react";
import type { TimelineElement } from "@/types/timeline";

type EffectPreset = {
	id: string;
	name: string;
	description: string;
	preview: string;
	opacity: number;
	scale: number;
};

const EFFECTS: EffectPreset[] = [
	{
		id: "cinematic-soft",
		name: "Cinematic Soft",
		description: "Slight zoom-in with gentle opacity tuning.",
		preview:
			"radial-gradient(circle at 20% 30%, #7dd3fc 0%, transparent 40%), radial-gradient(circle at 70% 60%, #fca5a5 0%, transparent 45%), linear-gradient(135deg, #1f2937 0%, #111827 100%)",
		opacity: 0.96,
		scale: 1.03,
	},
	{
		id: "punchy-overlay",
		name: "Punchy Overlay",
		description: "Slight zoom-out with full opacity for crisp framing.",
		preview:
			"repeating-linear-gradient(45deg, #4f46e5 0 6px, #0f172a 6px 12px), repeating-linear-gradient(-45deg, #22c55e33 0 5px, #0000 5px 10px)",
		opacity: 1,
		scale: 0.98,
	},
	{
		id: "dream-screen",
		name: "Dream Screen",
		description: "Soft cinematic zoom with slightly reduced opacity.",
		preview:
			"radial-gradient(circle at 10% 20%, #fef3c7 0%, transparent 40%), radial-gradient(circle at 80% 70%, #93c5fd 0%, transparent 45%), linear-gradient(160deg, #111827 0%, #334155 100%)",
		opacity: 0.94,
		scale: 1.06,
	},
];

function isVisualElement(element: TimelineElement): boolean {
	return element.type !== "audio";
}

export function EffectsView() {
	const editor = useEditor({ subscribeTo: ["timeline", "selection"] });
	const [statusMessage, setStatusMessage] = useState<string>("");

	const selected = editor.selection.getSelectedElements();
	const selectedVisualElements =
		selected.length === 0
			? []
			: editor.timeline
					.getElementsWithTracks({ elements: selected })
					.filter(({ element }) => isVisualElement(element));

	const applyEffect = (effect: EffectPreset) => {
		if (selectedVisualElements.length === 0) {
			setStatusMessage("Select one or more visual clips in the timeline first.");
			return;
		}

		editor.timeline.updateElements({
			updates: selectedVisualElements.map(({ track, element }) => {
				if (element.type === "audio") {
					return {
						trackId: track.id,
						elementId: element.id,
						updates: {},
					};
				}
				return {
					trackId: track.id,
					elementId: element.id,
					updates: {
						opacity: effect.opacity,
						blendMode: "normal",
						transform: {
							...element.transform,
							scale: effect.scale,
						},
					},
				};
			}),
		});

		setStatusMessage(
			`Applied "${effect.name}" to ${selectedVisualElements.length} element${
				selectedVisualElements.length === 1 ? "" : "s"
			}.`,
		);
	};

	return (
		<PanelView title="Effects" contentClassName="space-y-3 pb-3">
			<div className="grid grid-cols-2 gap-2">
				{EFFECTS.map((effect) => (
					<div key={effect.id} className="rounded-md border p-2.5 space-y-2">
						<div
							className="h-16 rounded-sm border"
							style={{ background: effect.preview }}
						/>
						<div className="flex items-center justify-between gap-2">
							<div className="space-y-0.5">
								<div className="text-xs font-medium">{effect.name}</div>
								<div className="text-[11px] text-muted-foreground leading-tight">
									{effect.description}
								</div>
							</div>
							<Button
								size="sm"
								variant="outline"
								className="h-7 px-2 text-xs"
								onClick={() => applyEffect(effect)}
								title={`Apply ${effect.name} to selected visual elements`}
							>
								<Sparkles className="mr-1 size-3.5" />
								Apply
							</Button>
						</div>
					</div>
				))}
			</div>
			<div className="text-xs text-muted-foreground rounded-md border p-2.5 space-y-1">
				<div>
					Select timeline clips, then apply a preset. Presets use transform and
					opacity only to keep preview/export output stable.
				</div>
				{statusMessage && <div className="text-foreground">{statusMessage}</div>}
			</div>
		</PanelView>
	);
}
