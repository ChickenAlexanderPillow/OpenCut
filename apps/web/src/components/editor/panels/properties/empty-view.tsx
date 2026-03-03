import { HugeiconsIcon } from "@hugeicons/react";
import { Settings05Icon } from "@hugeicons/core-free-icons";
import { useEditor } from "@/hooks/use-editor";
import { usePreviewStore } from "@/stores/preview-store";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
} from "./section";
import { Input } from "@/components/ui/input";
import { dimensionToAspectRatio } from "@/utils/geometry";
import { Label } from "@/components/ui/label";

function clampNumber({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}): number {
	return Math.min(max, Math.max(min, value));
}

export function EmptyView() {
	const editor = useEditor({ subscribeTo: ["project"] });
	const activeProject = editor.project.getActive();
	const {
		previewFormatVariant,
		squareFormatSettings,
		setSquareFormatSettings,
	} = usePreviewStore();
	const canvas = activeProject.settings.canvasSize;
	const isProjectSquare = canvas.width === canvas.height;
	const aspectRatioLabel = dimensionToAspectRatio({
		width: canvas.width,
		height: canvas.height,
	});

	return (
		<div className="bg-background h-full overflow-y-auto">
			<Section hasBorderTop={false}>
				<SectionHeader title="Format Settings">
					<HugeiconsIcon
						icon={Settings05Icon}
						className="text-muted-foreground/75 size-4"
						strokeWidth={1.5}
					/>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<div className="flex flex-col gap-2">
							<Label>Project aspect</Label>
							<div className="text-muted-foreground text-sm">
								{aspectRatioLabel} ({canvas.width} x {canvas.height})
							</div>
						</div>
						{previewFormatVariant === "square" && !isProjectSquare && (
							<>
								<div className="flex flex-col gap-1.5">
									<Label>Square blur intensity</Label>
									<Input
										type="number"
										min={0}
										max={64}
										step={1}
										value={squareFormatSettings.blurIntensity}
										onChange={(event) => {
											const next = Number.parseInt(event.target.value, 10);
											if (!Number.isFinite(next)) return;
											setSquareFormatSettings({
												settings: {
													blurIntensity: clampNumber({
														value: next,
														min: 0,
														max: 64,
													}),
												},
											});
										}}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label>Background cover overscan %</Label>
									<Input
										type="number"
										min={100}
										max={130}
										step={1}
										value={squareFormatSettings.coverOverscanPercent}
										onChange={(event) => {
											const next = Number.parseInt(event.target.value, 10);
											if (!Number.isFinite(next)) return;
											setSquareFormatSettings({
												settings: {
													coverOverscanPercent: clampNumber({
														value: next,
														min: 100,
														max: 130,
													}),
												},
											});
										}}
									/>
								</div>
							</>
						)}
					</SectionFields>
				</SectionContent>
			</Section>
		</div>
	);
}
