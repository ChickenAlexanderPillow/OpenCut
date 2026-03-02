import { NumberField } from "@/components/ui/number-field";
import { useEditor } from "@/hooks/use-editor";
import { usePropertyDraft } from "../hooks/use-property-draft";
import { clamp } from "@/utils/math";
import type { ElementType, TextElement, Transform } from "@/types/timeline";
import { Section, SectionContent, SectionField, SectionFields, SectionHeader } from "../section";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowExpandIcon,
	Link05Icon,
	RotateClockwiseIcon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { Checkbox } from "@/components/ui/checkbox";

type TransformElement = {
	id: string;
	transform: Transform;
	type: ElementType;
	captionWordTimings?: TextElement["captionWordTimings"];
	captionStyle?: TextElement["captionStyle"];
};

function parseFloat_({ input }: { input: string }): number | null {
	const parsed = parseFloat(input);
	return Number.isNaN(parsed) ? null : parsed;
}

export function TransformSection({
	element,
	trackId,
}: {
	element: TransformElement;
	trackId: string;
}) {
	const editor = useEditor();
	const [isScaleLocked, setIsScaleLocked] = useState(false);

	const previewTransform = (transform: Partial<Transform>) => {
		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: { transform: { ...element.transform, ...transform } },
				},
			],
		});
	};

	const commit = () => editor.timeline.commitPreview();

	const positionX = usePropertyDraft({
		displayValue: Math.round(element.transform.position.x).toString(),
		parse: (input) => parseFloat_({ input }),
		onPreview: (value) =>
			previewTransform({
				position: { ...element.transform.position, x: value },
			}),
		onCommit: commit,
	});

	const positionY = usePropertyDraft({
		displayValue: Math.round(element.transform.position.y).toString(),
		parse: (input) => parseFloat_({ input }),
		onPreview: (value) =>
			previewTransform({
				position: { ...element.transform.position, y: value },
			}),
		onCommit: commit,
	});

	const scale = usePropertyDraft({
		displayValue: Math.round(element.transform.scale * 100).toString(),
		parse: (input) => {
			const parsed = parseFloat_({ input });
			if (parsed === null) return null;
			return Math.max(parsed, 1) / 100;
		},
		onPreview: (value) => previewTransform({ scale: value }),
		onCommit: commit,
	});
	const scaleFieldProps = {
		className: "flex-1",
		value: scale.displayValue,
		onFocus: scale.onFocus,
		onChange: scale.onChange,
		onBlur: scale.onBlur,
		dragSensitivity: "slow" as const,
		onScrub: scale.scrubTo,
		onScrubEnd: scale.commitScrub,
		onReset: () =>
			editor.timeline.updateElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							transform: {
								...element.transform,
								scale: DEFAULT_TRANSFORM.scale,
							},
						},
					},
				],
			}),
		isDefault: element.transform.scale === DEFAULT_TRANSFORM.scale,
	};

	const rotation = usePropertyDraft({
		displayValue: Math.round(element.transform.rotate).toString(),
		parse: (input) => {
			const parsed = parseFloat_({ input });
			if (parsed === null) return null;
			return clamp({ value: parsed, min: -360, max: 360 });
		},
		onPreview: (value) => previewTransform({ rotate: value }),
		onCommit: commit,
	});
	const isGeneratedCaptionText =
		element.type === "text" && (element.captionWordTimings?.length ?? 0) > 0;

	return (
		<Section collapsible sectionKey={`${element.type}:transform`}>
			<SectionHeader title="Transform" />
		<SectionContent>
			<SectionFields>
				<SectionField label="Scale">
					<div className="flex items-center gap-2">
						{isScaleLocked ? (
							<>
								<NumberField icon="W" {...scaleFieldProps} />
								<NumberField icon="H" {...scaleFieldProps} />
							</>
						) : (
							<NumberField
								icon={<HugeiconsIcon icon={ArrowExpandIcon} />}
								{...scaleFieldProps}
								className="flex-1"
							/>
						)}
						<Button
							variant={isScaleLocked ? "secondary" : "ghost"}
							size="icon"
							aria-pressed={isScaleLocked}
							onClick={() => setIsScaleLocked((isLocked) => !isLocked)}
						>
							<HugeiconsIcon icon={Link05Icon} />
						</Button>
					</div>
				</SectionField>
				<SectionField label="Position">
					<div className="flex items-center gap-2">
							<NumberField
								icon="X"
								className="flex-1"
								value={positionX.displayValue}
								onFocus={positionX.onFocus}
								onChange={positionX.onChange}
								onBlur={positionX.onBlur}
								onScrub={positionX.scrubTo}
								onScrubEnd={positionX.commitScrub}
								onReset={() =>
									editor.timeline.updateElements({
										updates: [
											{
												trackId,
												elementId: element.id,
												updates: {
													transform: {
														...element.transform,
														position: {
															...element.transform.position,
															x: DEFAULT_TRANSFORM.position.x,
														},
													},
												},
											},
										],
									})
								}
								isDefault={
									element.transform.position.x === DEFAULT_TRANSFORM.position.x
								}
							/>
							<NumberField
								icon="Y"
								className="flex-1"
								value={positionY.displayValue}
								onFocus={positionY.onFocus}
								onChange={positionY.onChange}
								onBlur={positionY.onBlur}
								onScrub={positionY.scrubTo}
								onScrubEnd={positionY.commitScrub}
								onReset={() =>
									editor.timeline.updateElements({
										updates: [
											{
												trackId,
												elementId: element.id,
												updates: {
													transform: {
														...element.transform,
														position: {
															...element.transform.position,
															y: DEFAULT_TRANSFORM.position.y,
														},
													},
												},
											},
										],
									})
								}
								isDefault={
									element.transform.position.y === DEFAULT_TRANSFORM.position.y
								}
							/>
					</div>
				</SectionField>

				<SectionField label="Rotation">
					<NumberField
						icon={<HugeiconsIcon icon={RotateClockwiseIcon} />}
						className="flex-none"
						value={rotation.displayValue}
						onFocus={rotation.onFocus}
						onChange={rotation.onChange}
						onBlur={rotation.onBlur}
						dragSensitivity="slow"
						onScrub={rotation.scrubTo}
						onScrubEnd={rotation.commitScrub}
						onReset={() =>
							editor.timeline.updateElements({
								updates: [
									{
										trackId,
										elementId: element.id,
										updates: {
											transform: {
												...element.transform,
												rotate: DEFAULT_TRANSFORM.rotate,
											},
										},
									},
								],
							})
						}
						isDefault={element.transform.rotate === DEFAULT_TRANSFORM.rotate}
					/>
				</SectionField>
				{isGeneratedCaptionText && (
					<div className="flex items-center justify-between rounded-sm border px-2 py-2">
						<span className="text-muted-foreground text-xs">
							Anchor Y to safe area
						</span>
						<Checkbox
							checked={element.captionStyle?.anchorToSafeAreaBottom ?? true}
							onCheckedChange={(checked) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													anchorToSafeAreaBottom: Boolean(checked),
												},
											},
										},
									],
								})
							}
						/>
					</div>
				)}
			</SectionFields>
		</SectionContent>
		</Section>
	);
}
