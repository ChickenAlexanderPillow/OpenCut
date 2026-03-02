import { HugeiconsIcon } from "@hugeicons/react";
import { Settings05Icon } from "@hugeicons/core-free-icons";
import { useEditor } from "@/hooks/use-editor";
import { usePreviewStore } from "@/stores/preview-store";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
} from "./section";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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
		setPreviewFormatVariant,
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
						<SectionField label="Preview format">
							<Select
								value={previewFormatVariant}
								onValueChange={(value) =>
									setPreviewFormatVariant({
										variant: value === "square" ? "square" : "project",
									})
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select preview format" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="project">Project</SelectItem>
									{!isProjectSquare && (
										<SelectItem value="square">Square</SelectItem>
									)}
								</SelectContent>
							</Select>
						</SectionField>
						{previewFormatVariant === "square" && !isProjectSquare && (
							<>
								<SectionField label="Square blur intensity">
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
								</SectionField>
								<SectionField label="Background cover overscan %">
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
								</SectionField>
							</>
						)}
					</SectionFields>
				</SectionContent>
			</Section>
			<div className="text-muted-foreground px-4 py-3 text-xs">
				Select a timeline element to edit element-specific properties.
			</div>
		</div>
	);
}
