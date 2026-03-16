import { NumberField } from "@/components/ui/number-field";
import { useEditor } from "@/hooks/use-editor";
import { clamp, isNearlyEqual } from "@/utils/math";
import type { AnimationPropertyPath } from "@/types/animation";
import type { TextElement, VisualElement } from "@/types/timeline";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
} from "../section";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowExpandIcon,
	Link05Icon,
	RotateClockwiseIcon,
} from "@hugeicons/core-free-icons";
import { Monitor, Smartphone } from "lucide-react";
import { useMemo, useState } from "react";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { KeyframeToggle } from "../keyframe-toggle";
import { useKeyframedNumberProperty } from "../hooks/use-keyframed-number-property";
import { useElementPlayhead } from "../hooks/use-element-playhead";
import { getElementKeyframes, resolveElementTransformAtTime } from "@/lib/animation";
import { Checkbox } from "@/components/ui/checkbox";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";

export function parseNumericInput({ input }: { input: string }): number | null {
	const parsed = parseFloat(input);
	return Number.isNaN(parsed) ? null : parsed;
}

export function isPropertyAtDefault({
	hasAnimatedKeyframes,
	isPlayheadWithinElementRange,
	resolvedValue,
	staticValue,
	defaultValue,
}: {
	hasAnimatedKeyframes: boolean;
	isPlayheadWithinElementRange: boolean;
	resolvedValue: number;
	staticValue: number;
	defaultValue: number;
}): boolean {
	if (hasAnimatedKeyframes && isPlayheadWithinElementRange) {
		return isNearlyEqual({
			leftValue: resolvedValue,
			rightValue: defaultValue,
		});
	}
	return staticValue === defaultValue;
}

export function TransformSection({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	const editor = useEditor();
	const setActiveTab = useAssetsPanelStore((state) => state.setActiveTab);
	const [isScaleLocked, setIsScaleLocked] = useState(false);
	const mediaAsset = useMemo(() => {
		if (element.type !== "video" && element.type !== "image") return null;
		return (
			editor.media.getAssets().find((asset) => asset.id === element.mediaId) ??
			null
		);
	}, [editor, element]);
	const fitScales = useMemo(() => {
		if (!mediaAsset) return null;
		const sourceWidth = mediaAsset.width ?? 0;
		const sourceHeight = mediaAsset.height ?? 0;
		if (sourceWidth <= 0 || sourceHeight <= 0) return null;
		const canvas = editor.project.getActive().settings.canvasSize;
		const widthRatio = canvas.width / sourceWidth;
		const heightRatio = canvas.height / sourceHeight;
		const containScale = Math.min(widthRatio, heightRatio);
		if (containScale <= 0 || !Number.isFinite(containScale)) return null;
		return {
			height: Math.max(1, heightRatio / containScale),
			width: Math.max(1, widthRatio / containScale),
		};
	}, [editor, mediaAsset]);
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const resolvedTransform = resolveElementTransformAtTime({
		element,
		localTime,
	});
	const isReframeManagedVideo =
		element.type === "video" && (element.reframePresets?.length ?? 0) > 0;
	const fitMode = useMemo<"height" | "width" | null>(() => {
		if (!fitScales) return null;
		if (
			isNearlyEqual({
				leftValue: resolvedTransform.scale,
				rightValue: fitScales.height,
			})
		)
			return "height";
		if (
			isNearlyEqual({
				leftValue: resolvedTransform.scale,
				rightValue: fitScales.width,
			})
		)
			return "width";
		return null;
	}, [fitScales, resolvedTransform.scale]);

	const positionX = useKeyframedNumberProperty({
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: "transform.position.x",
		localTime,
		isPlayheadWithinElementRange,
		displayValue: Math.round(resolvedTransform.position.x).toString(),
		parse: (input) => parseNumericInput({ input }),
		valueAtPlayhead: resolvedTransform.position.x,
		buildBaseUpdates: ({ value }) => ({
			transform: {
				...element.transform,
				position: {
					...element.transform.position,
					x: value,
				},
			},
		}),
	});

	const positionY = useKeyframedNumberProperty({
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: "transform.position.y",
		localTime,
		isPlayheadWithinElementRange,
		displayValue: Math.round(resolvedTransform.position.y).toString(),
		parse: (input) => parseNumericInput({ input }),
		valueAtPlayhead: resolvedTransform.position.y,
		buildBaseUpdates: ({ value }) => ({
			transform: {
				...element.transform,
				position: {
					...element.transform.position,
					y: value,
				},
			},
		}),
	});

	const scale = useKeyframedNumberProperty({
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: "transform.scale",
		localTime,
		isPlayheadWithinElementRange,
		displayValue: Math.round(resolvedTransform.scale * 100).toString(),
		parse: (input) => {
			const parsed = parseNumericInput({ input });
			if (parsed === null) return null;
			return Math.max(parsed, 1) / 100;
		},
		valueAtPlayhead: resolvedTransform.scale,
		buildBaseUpdates: ({ value }) => ({
			transform: {
				...element.transform,
				scale: value,
			},
		}),
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
		onReset: () => scale.commitValue({ value: DEFAULT_TRANSFORM.scale }),
		isDefault: isPropertyAtDefault({
			hasAnimatedKeyframes: scale.hasAnimatedKeyframes,
			isPlayheadWithinElementRange,
			resolvedValue: resolvedTransform.scale,
			staticValue: element.transform.scale,
			defaultValue: DEFAULT_TRANSFORM.scale,
		}),
	};

	const rotation = useKeyframedNumberProperty({
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: "transform.rotate",
		localTime,
		isPlayheadWithinElementRange,
		displayValue: Math.round(resolvedTransform.rotate).toString(),
		parse: (input) => {
			const parsed = parseNumericInput({ input });
			if (parsed === null) return null;
			return clamp({ value: parsed, min: -360, max: 360 });
		},
		valueAtPlayhead: resolvedTransform.rotate,
		buildBaseUpdates: ({ value }) => ({
			transform: {
				...element.transform,
				rotate: value,
			},
		}),
	});

	const hasPositionKeyframe =
		positionX.isKeyframedAtTime || positionY.isKeyframedAtTime;

	const togglePositionKeyframe = () => {
		if (!isPlayheadWithinElementRange) return;

		if (positionX.keyframeIdAtTime || positionY.keyframeIdAtTime) {
			const keyframesToRemove: Array<{
				trackId: string;
				elementId: string;
				propertyPath: AnimationPropertyPath;
				keyframeId: string;
			}> = [];
			if (positionX.keyframeIdAtTime) {
				keyframesToRemove.push({
					trackId,
					elementId: element.id,
					propertyPath: "transform.position.x" as const,
					keyframeId: positionX.keyframeIdAtTime,
				});
			}
			if (positionY.keyframeIdAtTime) {
				keyframesToRemove.push({
					trackId,
					elementId: element.id,
					propertyPath: "transform.position.y" as const,
					keyframeId: positionY.keyframeIdAtTime,
				});
			}
			editor.timeline.removeKeyframes({ keyframes: keyframesToRemove });
			return;
		}

		editor.timeline.upsertKeyframes({
			keyframes: [
				{
					trackId,
					elementId: element.id,
					propertyPath: "transform.position.x",
					time: localTime,
					value: resolvedTransform.position.x,
				},
				{
					trackId,
					elementId: element.id,
					propertyPath: "transform.position.y",
					time: localTime,
					value: resolvedTransform.position.y,
				},
			],
		});
	};

	const isGeneratedCaptionText =
		element.type === "text" && (element.captionWordTimings?.length ?? 0) > 0;
	const commitScaleFromFit = ({ value }: { value: number }) => {
		const previousBaseScale = element.transform.scale;
		if (
			previousBaseScale <= 0 ||
			!Number.isFinite(previousBaseScale) ||
			!Number.isFinite(value)
		) {
			scale.commitValue({ value });
			return;
		}

		const ownedScaleKeyframeIds = new Set(
			[
				...(element.transitions?.in?.ownedKeyframes ?? []),
				...(element.transitions?.out?.ownedKeyframes ?? []),
			]
				.filter((owned) => owned.propertyPath === "transform.scale")
				.map((owned) => owned.keyframeId),
		);
		if (ownedScaleKeyframeIds.size === 0) {
			scale.commitValue({ value });
			return;
		}

		const ratio = value / previousBaseScale;
		const transitionScaleKeyframes = getElementKeyframes({
			animations: element.animations,
		}).filter(
			(keyframe) =>
				keyframe.propertyPath === "transform.scale" &&
				ownedScaleKeyframeIds.has(keyframe.id) &&
				typeof keyframe.value === "number",
		);
		if (transitionScaleKeyframes.length === 0) {
			scale.commitValue({ value });
			return;
		}

		// Rebase transition-owned scale keyframes with the same factor as base scale
		// so fit toggles don't collapse motion-blur-zoom to a different fit mode.
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: {
						transform: {
							...element.transform,
							scale: value,
						},
					},
				},
			],
		});
		editor.timeline.upsertKeyframes({
			keyframes: transitionScaleKeyframes.map((keyframe) => ({
				trackId,
				elementId: element.id,
				propertyPath: "transform.scale" as const,
				time: keyframe.time,
				value: (keyframe.value as number) * ratio,
				interpolation: keyframe.interpolation,
				keyframeId: keyframe.id,
			})),
		});
	};

	return (
		<Section collapsible sectionKey={`${element.type}:transform`}>
			<SectionHeader title="Transform" />
			<SectionContent>
				<SectionFields>
					{isReframeManagedVideo ? (
						<div className="rounded-sm border px-3 py-3">
							<div className="text-sm font-medium">Reframe-managed clip</div>
							<div className="text-muted-foreground mt-1 text-xs">
								Position and scale are driven by clip reframe presets and switch
								markers.
							</div>
							<Button
								type="button"
								size="sm"
								variant="secondary"
								className="mt-3"
								onClick={() => setActiveTab("reframe")}
							>
								Open Reframe Panel
							</Button>
						</div>
					) : (
						<>
							<SectionField
								label="Scale"
								beforeLabel={
									<KeyframeToggle
										isActive={scale.isKeyframedAtTime}
										isDisabled={!isPlayheadWithinElementRange}
										title="Toggle scale keyframe"
										onToggle={scale.toggleKeyframe}
									/>
								}
							>
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
										type="button"
										variant={isScaleLocked ? "secondary" : "ghost"}
										size="icon"
										aria-pressed={isScaleLocked}
										onClick={() => setIsScaleLocked((isLocked) => !isLocked)}
									>
										<HugeiconsIcon icon={Link05Icon} />
									</Button>
									{fitScales && (
										<Button
											type="button"
											variant={fitMode ? "secondary" : "ghost"}
											size="icon"
											title={
												fitMode === "height" ? "Fit full width" : "Fit full height"
											}
											aria-label={
												fitMode === "height"
													? "Fit media to full width"
													: "Fit media to full height"
											}
											onClick={() =>
												commitScaleFromFit({
													value:
														fitMode === "height"
															? fitScales.width
															: fitScales.height,
												})
											}
										>
											{fitMode === "height" ? (
												<Monitor className="size-4" />
											) : (
												<Smartphone className="size-4" />
											)}
										</Button>
									)}
								</div>
							</SectionField>
							<SectionField
								label="Position"
								beforeLabel={
									<KeyframeToggle
										isActive={hasPositionKeyframe}
										isDisabled={!isPlayheadWithinElementRange}
										title="Toggle position keyframe"
										onToggle={togglePositionKeyframe}
									/>
								}
							>
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
											positionX.commitValue({
												value: DEFAULT_TRANSFORM.position.x,
											})
										}
										isDefault={isPropertyAtDefault({
											hasAnimatedKeyframes: positionX.hasAnimatedKeyframes,
											isPlayheadWithinElementRange,
											resolvedValue: resolvedTransform.position.x,
											staticValue: element.transform.position.x,
											defaultValue: DEFAULT_TRANSFORM.position.x,
										})}
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
											positionY.commitValue({
												value: DEFAULT_TRANSFORM.position.y,
											})
										}
										isDefault={isPropertyAtDefault({
											hasAnimatedKeyframes: positionY.hasAnimatedKeyframes,
											isPlayheadWithinElementRange,
											resolvedValue: resolvedTransform.position.y,
											staticValue: element.transform.position.y,
											defaultValue: DEFAULT_TRANSFORM.position.y,
										})}
									/>
								</div>
							</SectionField>
						</>
					)}
					<SectionField
						label="Rotation"
						beforeLabel={
							<KeyframeToggle
								isActive={rotation.isKeyframedAtTime}
								isDisabled={!isPlayheadWithinElementRange}
								title="Toggle rotation keyframe"
								onToggle={rotation.toggleKeyframe}
							/>
						}
					>
						<div className="flex items-center gap-2">
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
									rotation.commitValue({ value: DEFAULT_TRANSFORM.rotate })
								}
								isDefault={isPropertyAtDefault({
									hasAnimatedKeyframes: rotation.hasAnimatedKeyframes,
									isPlayheadWithinElementRange,
									resolvedValue: resolvedTransform.rotate,
									staticValue: element.transform.rotate,
									defaultValue: DEFAULT_TRANSFORM.rotate,
								})}
							/>
						</div>
					</SectionField>
					{isGeneratedCaptionText && (
						<div className="flex items-center justify-between rounded-sm border px-2 py-2">
							<span className="text-muted-foreground text-xs">
								Anchor Y to safe area
							</span>
							<Checkbox
								checked={
									(element as TextElement).captionStyle
										?.anchorToSafeAreaBottom ?? true
								}
								onCheckedChange={(checked) =>
									editor.timeline.updateElements({
										updates: [
											{
												trackId,
												elementId: element.id,
												updates: {
													captionStyle: {
														...((element as TextElement).captionStyle ?? {}),
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
