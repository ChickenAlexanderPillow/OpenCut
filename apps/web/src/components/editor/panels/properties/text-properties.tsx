import { Textarea } from "@/components/ui/textarea";
import { FontPicker } from "@/components/ui/font-picker";
import type { TextElement } from "@/types/timeline";
import { NumberField } from "@/components/ui/number-field";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
} from "./section";
import { ColorPicker } from "@/components/ui/color-picker";
import { uppercase } from "@/utils/string";
import { clamp } from "@/utils/math";
import { useEditor } from "@/hooks/use-editor";
import { DEFAULT_COLOR } from "@/constants/project-constants";
import {
	createBlueHighlightCaptionStyle,
	createBlueHighlightCaptionTextProps,
} from "@/constants/caption-presets";
import {
	DEFAULT_LETTER_SPACING,
	DEFAULT_LINE_HEIGHT,
	DEFAULT_TEXT_BACKGROUND,
	DEFAULT_TEXT_ELEMENT,
	MAX_FONT_SIZE,
	MIN_FONT_SIZE,
} from "@/constants/text-constants";
import { usePropertyDraft } from "./hooks/use-property-draft";
import { TransformSection, BlendingSection } from "./sections";
import { HugeiconsIcon } from "@hugeicons/react";
import { TextFontIcon } from "@hugeicons/core-free-icons";
import { OcTextHeightIcon, OcTextWidthIcon } from "@opencut/ui/icons";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocalStorage } from "@/hooks/storage/use-local-storage";
import { toast } from "sonner";
import { RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";

function createOffsetConverter({
	defaultValue,
	scale = 1,
	min,
}: {
	defaultValue: number;
	scale?: number;
	min?: number;
}) {
	return {
		toDisplay: (value: number) => Math.round((value - defaultValue) * scale),
		fromDisplay: (display: number) => {
			const stored = defaultValue + display / scale;
			return min !== undefined ? Math.max(min, stored) : stored;
		},
	};
}

const lineHeightConverter = createOffsetConverter({
	defaultValue: DEFAULT_LINE_HEIGHT,
	scale: 10,
});
const paddingXConverter = createOffsetConverter({
	defaultValue: DEFAULT_TEXT_BACKGROUND.paddingX,
	min: 0,
});
const paddingYConverter = createOffsetConverter({
	defaultValue: DEFAULT_TEXT_BACKGROUND.paddingY,
	min: 0,
});

const CAPTION_WORD_PRESETS = {
	compact: 2,
	balanced: 3,
	extended: 5,
} as const;
const DEFAULT_KARAOKE_HIGHLIGHT_COLOR = "#FDE047";
const DEFAULT_KARAOKE_HIGHLIGHT_TEXT_COLOR = "#111111";
const DEFAULT_KARAOKE_HIGHLIGHT_OPACITY = 1;
const DEFAULT_KARAOKE_HIGHLIGHT_ROUNDNESS = 4;
const DEFAULT_KARAOKE_UNDERLINE_THICKNESS = 3;
const DEFAULT_CAPTION_BACKGROUND_FIT_MODE = "block";
const CAPTION_PRESETS_STORAGE_KEY = "caption-global-presets:v1";

type CaptionPresetSnapshot = {
	transform: TextElement["transform"];
	opacity: TextElement["opacity"];
	blendMode?: TextElement["blendMode"];
	fontSize: TextElement["fontSize"];
	fontFamily: TextElement["fontFamily"];
	color: TextElement["color"];
	background: TextElement["background"];
	textAlign: TextElement["textAlign"];
	fontWeight: TextElement["fontWeight"];
	fontStyle: TextElement["fontStyle"];
	textDecoration: TextElement["textDecoration"];
	letterSpacing?: TextElement["letterSpacing"];
	lineHeight?: TextElement["lineHeight"];
	captionStyle: NonNullable<TextElement["captionStyle"]>;
};

type CaptionGlobalPreset = {
	id: string;
	name: string;
	builtIn?: boolean;
	updatedAt: string;
	snapshot: CaptionPresetSnapshot;
};

const BUILTIN_BLUE_HIGHLIGHT_PRESET: CaptionGlobalPreset = {
	id: "builtin-blue-highlight",
	name: "Blue highlight",
	builtIn: true,
	updatedAt: new Date(0).toISOString(),
	snapshot: {
		...createBlueHighlightCaptionTextProps(),
		captionStyle: createBlueHighlightCaptionStyle(),
	},
};

type CaptionWordPreset = keyof typeof CAPTION_WORD_PRESETS;

function clampWordsOnScreen(value: number): number {
	return Math.max(1, Math.min(12, Math.round(value)));
}

function clampMaxLinesOnScreen(value: number): number {
	return Math.max(1, Math.min(4, Math.round(value)));
}

function clampHighlightOpacity(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function clampHighlightRoundness(value: number): number {
	return Math.max(0, Math.min(200, Math.round(value)));
}

function clampUnderlineThickness(value: number): number {
	return Math.max(1, Math.min(24, Math.round(value)));
}

function clampSafeAreaBottomOffset(value: number): number {
	return Math.max(-500, Math.min(500, Math.round(value)));
}

function getPresetFromWords(words: number): CaptionWordPreset | "custom" {
	if (words === CAPTION_WORD_PRESETS.compact) return "compact";
	if (words === CAPTION_WORD_PRESETS.balanced) return "balanced";
	if (words === CAPTION_WORD_PRESETS.extended) return "extended";
	return "custom";
}

function captureCaptionPresetSnapshot({
	element,
}: {
	element: TextElement;
}): CaptionPresetSnapshot {
	return {
		transform: element.transform,
		opacity: element.opacity,
		blendMode: element.blendMode,
		fontSize: element.fontSize,
		fontFamily: element.fontFamily,
		color: element.color,
		background: element.background,
		textAlign: element.textAlign,
		fontWeight: element.fontWeight,
		fontStyle: element.fontStyle,
		textDecoration: element.textDecoration,
		letterSpacing: element.letterSpacing,
		lineHeight: element.lineHeight,
		captionStyle: {
			fitInCanvas: element.captionStyle?.fitInCanvas ?? true,
			neverShrinkFont: element.captionStyle?.neverShrinkFont ?? false,
			karaokeWordHighlight: element.captionStyle?.karaokeWordHighlight ?? true,
			karaokeHighlightMode:
				element.captionStyle?.karaokeHighlightMode ?? "block",
			karaokeHighlightEaseInOnly:
				element.captionStyle?.karaokeHighlightEaseInOnly ?? false,
			karaokeScaleHighlightedWord:
				element.captionStyle?.karaokeScaleHighlightedWord ?? false,
			karaokeUnderlineThickness: clampUnderlineThickness(
				element.captionStyle?.karaokeUnderlineThickness ??
					DEFAULT_KARAOKE_UNDERLINE_THICKNESS,
			),
			karaokeHighlightColor:
				element.captionStyle?.karaokeHighlightColor ??
				DEFAULT_KARAOKE_HIGHLIGHT_COLOR,
			karaokeHighlightTextColor:
				element.captionStyle?.karaokeHighlightTextColor ??
				DEFAULT_KARAOKE_HIGHLIGHT_TEXT_COLOR,
			karaokeHighlightOpacity:
				element.captionStyle?.karaokeHighlightOpacity ??
				DEFAULT_KARAOKE_HIGHLIGHT_OPACITY,
			karaokeHighlightRoundness:
				element.captionStyle?.karaokeHighlightRoundness ??
				DEFAULT_KARAOKE_HIGHLIGHT_ROUNDNESS,
			backgroundFitMode:
				element.captionStyle?.backgroundFitMode ??
				DEFAULT_CAPTION_BACKGROUND_FIT_MODE,
			wordsOnScreen:
				element.captionStyle?.wordsOnScreen ?? CAPTION_WORD_PRESETS.balanced,
			maxLinesOnScreen: element.captionStyle?.maxLinesOnScreen ?? 2,
			wordDisplayPreset:
				element.captionStyle?.wordDisplayPreset ??
				getPresetFromWords(
					element.captionStyle?.wordsOnScreen ?? CAPTION_WORD_PRESETS.balanced,
				),
			linkedToCaptionGroup: true,
			anchorToSafeAreaBottom:
				element.captionStyle?.anchorToSafeAreaBottom ?? true,
			safeAreaBottomOffset: clampSafeAreaBottomOffset(
				element.captionStyle?.safeAreaBottomOffset ?? 0,
			),
		},
	};
}

export function TextProperties({
	element,
	trackId,
}: {
	element: TextElement;
	trackId: string;
}) {
	return (
		<div className="flex h-full flex-col">
			<ContentSection element={element} trackId={trackId} />
			<TransformSection element={element} trackId={trackId} />
			<BlendingSection element={element} trackId={trackId} />
			<CanvasFittingSection element={element} trackId={trackId} />
			<CaptionSection element={element} trackId={trackId} />
			<TypographySection element={element} trackId={trackId} />
			<SpacingSection element={element} trackId={trackId} />
			<BackgroundSection element={element} trackId={trackId} />
		</div>
	);
}

function CanvasFittingSection({
	element,
	trackId,
}: {
	element: TextElement;
	trackId: string;
}) {
	const editor = useEditor();
	const hasCaptionData = (element.captionWordTimings?.length ?? 0) > 0;
	if (hasCaptionData) {
		return null;
	}

	const safeAreaOffset = usePropertyDraft({
		displayValue: String(
			clampSafeAreaBottomOffset(
				(element.captionStyle?.anchorToSafeAreaTop ?? false)
					? (element.captionStyle?.safeAreaTopOffset ?? 0)
					: (element.captionStyle?.safeAreaBottomOffset ?? 0),
			),
		),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampSafeAreaBottomOffset(parsed);
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							captionStyle: {
								...(element.captionStyle ?? {}),
								...((element.captionStyle?.anchorToSafeAreaTop ?? false)
									? { safeAreaTopOffset: value }
									: { safeAreaBottomOffset: value }),
							},
						},
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	return (
		<Section collapsible sectionKey="text:canvas-fitting">
			<SectionHeader title="Canvas Fitting" />
			<SectionContent>
				<SectionFields>
					<div className="flex items-center justify-between rounded-sm border px-2 py-2">
						<span className="text-muted-foreground text-xs">
							Keep inside canvas
						</span>
						<Checkbox
							checked={element.captionStyle?.fitInCanvas ?? false}
							onCheckedChange={(checked) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													fitInCanvas: Boolean(checked),
												},
											},
										},
									],
								})
							}
						/>
					</div>
					<div className="flex items-center justify-between rounded-sm border px-2 py-2">
						<span className="text-muted-foreground text-xs">
							Never shrink font size
						</span>
						<Checkbox
							checked={element.captionStyle?.neverShrinkFont ?? false}
							onCheckedChange={(checked) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													neverShrinkFont: Boolean(checked),
												},
											},
										},
									],
								})
							}
						/>
					</div>
					<div className="flex items-center justify-between rounded-sm border px-2 py-2">
						<span className="text-muted-foreground text-xs">
							Anchor to safe area top
						</span>
						<Checkbox
							checked={element.captionStyle?.anchorToSafeAreaTop ?? false}
							onCheckedChange={(checked) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													anchorToSafeAreaTop: Boolean(checked),
													anchorToSafeAreaBottom: Boolean(checked)
														? false
														: (element.captionStyle?.anchorToSafeAreaBottom ??
															false),
												},
											},
										},
									],
								})
							}
						/>
					</div>
					<SectionField label="Y offset from safe area">
						<NumberField
							icon="Y"
							value={safeAreaOffset.displayValue}
							min={-500}
							max={500}
							onFocus={safeAreaOffset.onFocus}
							onChange={safeAreaOffset.onChange}
							onBlur={safeAreaOffset.onBlur}
							onScrub={safeAreaOffset.scrubTo}
							onScrubEnd={safeAreaOffset.commitScrub}
							onReset={() =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													...((element.captionStyle?.anchorToSafeAreaTop ??
														false)
														? { safeAreaTopOffset: 0 }
														: { safeAreaBottomOffset: 0 }),
												},
											},
										},
									],
								})
							}
							isDefault={
								clampSafeAreaBottomOffset(
									(element.captionStyle?.anchorToSafeAreaTop ?? false)
										? (element.captionStyle?.safeAreaTopOffset ?? 0)
										: (element.captionStyle?.safeAreaBottomOffset ?? 0),
								) === 0
							}
						/>
					</SectionField>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function CaptionSection({
	element,
	trackId,
}: {
	element: TextElement;
	trackId: string;
}) {
	const editor = useEditor();
	const hasCaptionData = (element.captionWordTimings?.length ?? 0) > 0;
	const isLinkedToGroup = element.captionStyle?.linkedToCaptionGroup !== false;

	const findSourceLinkedCaption = () => {
		const tracks = editor.timeline.getTracks();
		for (const textTrack of tracks.filter((item) => item.type === "text")) {
			for (const candidate of textTrack.elements) {
				if (candidate.type !== "text") continue;
				if (!candidate.name.startsWith("Caption ")) continue;
				if ((candidate.captionWordTimings?.length ?? 0) === 0) continue;
				if (candidate.id === element.id && textTrack.id === trackId) continue;
				if (candidate.captionStyle?.linkedToCaptionGroup === false) continue;
				return { trackId: textTrack.id, element: candidate };
			}
		}
		return null;
	};

	const [storedCaptionPresets, setStoredCaptionPresets, isPresetsReady] =
		useLocalStorage<CaptionGlobalPreset[]>({
			key: CAPTION_PRESETS_STORAGE_KEY,
			defaultValue: [BUILTIN_BLUE_HIGHLIGHT_PRESET],
		});
	const captionPresets = useMemo(() => {
		const withoutBuiltIn = storedCaptionPresets.filter(
			(preset) => preset.id !== BUILTIN_BLUE_HIGHLIGHT_PRESET.id,
		);
		return [BUILTIN_BLUE_HIGHLIGHT_PRESET, ...withoutBuiltIn];
	}, [storedCaptionPresets]);
	const [selectedCaptionPresetId, setSelectedCaptionPresetId] = useState(
		BUILTIN_BLUE_HIGHLIGHT_PRESET.id,
	);
	const [captionPresetName, setCaptionPresetName] = useState("");

	useEffect(() => {
		if (!isPresetsReady) return;
		if (captionPresets.length === 0) {
			setSelectedCaptionPresetId(BUILTIN_BLUE_HIGHLIGHT_PRESET.id);
			return;
		}
		if (captionPresets.some((preset) => preset.id === selectedCaptionPresetId)) {
			return;
		}
		setSelectedCaptionPresetId(captionPresets[0].id);
	}, [captionPresets, selectedCaptionPresetId, isPresetsReady]);

	const selectedCaptionPreset =
		captionPresets.find((preset) => preset.id === selectedCaptionPresetId) ??
		captionPresets[0];

	useEffect(() => {
		if (!selectedCaptionPreset) {
			setCaptionPresetName("");
			return;
		}
		setCaptionPresetName(selectedCaptionPreset.name);
	}, [selectedCaptionPreset]);

	const getLinkedCaptionTargets = () => {
		return editor.timeline
			.getTracks()
			.filter((track) => track.type === "text")
			.flatMap((textTrack) =>
				textTrack.elements
					.filter(
						(candidate) =>
							candidate.type === "text" &&
							candidate.name.startsWith("Caption ") &&
							(candidate.captionWordTimings?.length ?? 0) > 0 &&
							candidate.captionStyle?.linkedToCaptionGroup !== false,
					)
					.map((candidate) => ({
						trackId: textTrack.id,
						elementId: candidate.id,
						element: candidate,
					})),
			);
	};

	const applyCaptionPresetToLinkedCaptions = ({
		preset,
	}: {
		preset: CaptionGlobalPreset;
	}) => {
		const targets = getLinkedCaptionTargets();
		if (targets.length === 0) {
			toast.error("No linked captions found");
			return;
		}

		const normalizedCaptionStyle = {
			karaokeHighlightMode: "block" as const,
			karaokeUnderlineThickness: DEFAULT_KARAOKE_UNDERLINE_THICKNESS,
			...preset.snapshot.captionStyle,
		};

		editor.timeline.updateElements({
			updates: targets.map((target) => ({
				trackId: target.trackId,
				elementId: target.elementId,
				updates: {
					transform: preset.snapshot.transform,
					opacity: preset.snapshot.opacity,
					blendMode: preset.snapshot.blendMode,
					fontSize: preset.snapshot.fontSize,
					fontFamily: preset.snapshot.fontFamily,
					color: preset.snapshot.color,
					background: preset.snapshot.background,
					textAlign: preset.snapshot.textAlign,
					fontWeight: preset.snapshot.fontWeight,
					fontStyle: preset.snapshot.fontStyle,
					textDecoration: preset.snapshot.textDecoration,
					letterSpacing: preset.snapshot.letterSpacing,
					lineHeight: preset.snapshot.lineHeight,
					captionStyle: {
						...(target.element.captionStyle ?? {}),
						...normalizedCaptionStyle,
						linkedToCaptionGroup: true,
					},
				},
			})),
		});
	};

	const handleSaveNewCaptionPreset = () => {
		const name = captionPresetName.trim();
		if (!name) {
			toast.error("Preset name is required");
			return;
		}

		const presetId = `custom-${Date.now()}`;
		const preset: CaptionGlobalPreset = {
			id: presetId,
			name,
			updatedAt: new Date().toISOString(),
			snapshot: captureCaptionPresetSnapshot({ element }),
		};
		setStoredCaptionPresets({
			value: (previous) => {
				const withoutBuiltIn = previous.filter(
					(item) => item.id !== BUILTIN_BLUE_HIGHLIGHT_PRESET.id,
				);
				return [BUILTIN_BLUE_HIGHLIGHT_PRESET, ...withoutBuiltIn, preset];
			},
		});
		setSelectedCaptionPresetId(presetId);
		toast.success(`Saved preset "${name}"`);
	};

	const handleUpdateCaptionPreset = () => {
		if (!selectedCaptionPreset) return;
		if (selectedCaptionPreset.builtIn) {
			toast.error("Built-in presets cannot be updated");
			return;
		}
		const name = captionPresetName.trim();
		if (!name) {
			toast.error("Preset name is required");
			return;
		}

		setStoredCaptionPresets({
			value: (previous) => {
				const nextPreset: CaptionGlobalPreset = {
					id: selectedCaptionPreset.id,
					name,
					builtIn: selectedCaptionPreset.builtIn,
					updatedAt: new Date().toISOString(),
					snapshot: captureCaptionPresetSnapshot({ element }),
				};
				const existingIndex = previous.findIndex(
					(preset) => preset.id === selectedCaptionPreset.id,
				);
				if (existingIndex === -1) {
					return [...previous, nextPreset];
				}
				return previous.map((preset) =>
					preset.id === selectedCaptionPreset.id ? nextPreset : preset,
				);
			},
		});
		toast.success(`Updated preset "${name}"`);
	};

	const handleDeleteCaptionPreset = () => {
		if (!selectedCaptionPreset) return;
		if (selectedCaptionPreset.builtIn) {
			toast.error("Built-in presets cannot be deleted");
			return;
		}

		setStoredCaptionPresets({
			value: (previous) =>
				previous.filter((preset) => preset.id !== selectedCaptionPreset.id),
		});
		setSelectedCaptionPresetId(BUILTIN_BLUE_HIGHLIGHT_PRESET.id);
		toast.success(`Deleted preset "${selectedCaptionPreset.name}"`);
	};

	const currentWordsOnScreen = clampWordsOnScreen(
		element.captionStyle?.wordsOnScreen ?? CAPTION_WORD_PRESETS.balanced,
	);
	const currentPreset =
		element.captionStyle?.wordDisplayPreset ??
		getPresetFromWords(currentWordsOnScreen);
	const wordsOnScreen = usePropertyDraft({
		displayValue: currentWordsOnScreen.toString(),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampWordsOnScreen(parsed);
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							captionStyle: {
								...(element.captionStyle ?? {}),
								wordsOnScreen: value,
								wordDisplayPreset: getPresetFromWords(value),
							},
						},
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});
	const maxLinesOnScreen = usePropertyDraft({
		displayValue: String(
			clampMaxLinesOnScreen(element.captionStyle?.maxLinesOnScreen ?? 2),
		),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampMaxLinesOnScreen(parsed);
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							captionStyle: {
								...(element.captionStyle ?? {}),
								maxLinesOnScreen: value,
							},
						},
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});
	const safeAreaBottomOffset = usePropertyDraft({
		displayValue: String(
			clampSafeAreaBottomOffset(element.captionStyle?.safeAreaBottomOffset ?? 0),
		),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampSafeAreaBottomOffset(parsed);
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							captionStyle: {
								...(element.captionStyle ?? {}),
								safeAreaBottomOffset: value,
							},
						},
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});
	const highlightOpacity = usePropertyDraft({
		displayValue: String(
			Math.round(
				clampHighlightOpacity(
					element.captionStyle?.karaokeHighlightOpacity ??
						DEFAULT_KARAOKE_HIGHLIGHT_OPACITY,
				) * 100,
			),
		),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampHighlightOpacity(parsed / 100);
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							captionStyle: {
								...(element.captionStyle ?? {}),
								karaokeHighlightOpacity: value,
							},
						},
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});
	const highlightRoundness = usePropertyDraft({
		displayValue: String(
			clampHighlightRoundness(
				element.captionStyle?.karaokeHighlightRoundness ??
					DEFAULT_KARAOKE_HIGHLIGHT_ROUNDNESS,
			),
		),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampHighlightRoundness(parsed);
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							captionStyle: {
								...(element.captionStyle ?? {}),
								karaokeHighlightRoundness: value,
							},
						},
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});
	const underlineThickness = usePropertyDraft({
		displayValue: String(
			clampUnderlineThickness(
				element.captionStyle?.karaokeUnderlineThickness ??
					DEFAULT_KARAOKE_UNDERLINE_THICKNESS,
			),
		),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampUnderlineThickness(parsed);
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							captionStyle: {
								...(element.captionStyle ?? {}),
								karaokeUnderlineThickness: value,
							},
						},
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	if (!hasCaptionData) {
		return null;
	}

	return (
		<Section collapsible sectionKey="text:caption">
			<SectionHeader title="Caption" />
			<SectionContent>
				<SectionFields>
					<SectionField label="Global preset">
						<div className="flex gap-2">
							<Select
								value={selectedCaptionPresetId}
								onValueChange={setSelectedCaptionPresetId}
							>
								<SelectTrigger className="flex-1">
									<SelectValue placeholder="Select caption preset" />
								</SelectTrigger>
								<SelectContent>
									{captionPresets.map((preset) => (
										<SelectItem key={preset.id} value={preset.id}>
											{preset.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									if (!selectedCaptionPreset) return;
									applyCaptionPresetToLinkedCaptions({
										preset: selectedCaptionPreset,
									});
									toast.success(
										`Applied "${selectedCaptionPreset.name}" to linked captions`,
									);
								}}
							>
								Apply
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									if (!selectedCaptionPreset) return;
									applyCaptionPresetToLinkedCaptions({
										preset: selectedCaptionPreset,
									});
									setCaptionPresetName(selectedCaptionPreset.name);
									toast.success(
										`Reset to saved "${selectedCaptionPreset.name}"`,
									);
								}}
							>
								<RotateCcw />
								Reset
							</Button>
						</div>
					</SectionField>
					<SectionField label="Preset name">
						<Input
							size="sm"
							value={captionPresetName}
							onChange={(event) => setCaptionPresetName(event.target.value)}
							placeholder="Preset name"
						/>
						<div className="mt-2 grid grid-cols-3 gap-2">
							<Button size="sm" variant="secondary" onClick={handleSaveNewCaptionPreset}>
								<Save />
								Save New
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={handleUpdateCaptionPreset}
								disabled={!selectedCaptionPreset}
							>
								<RefreshCw />
								Update
							</Button>
							<Button
								size="sm"
								variant="destructive-foreground"
								onClick={handleDeleteCaptionPreset}
								disabled={!selectedCaptionPreset || selectedCaptionPreset.builtIn}
							>
								<Trash2 />
								Delete
							</Button>
						</div>
					</SectionField>
					<SectionField label="Word preset">
						<Select
							value={currentPreset}
							onValueChange={(value) => {
								if (value === "custom") {
									editor.timeline.updateElements({
										updates: [
											{
												trackId,
												elementId: element.id,
												updates: {
													captionStyle: {
														...(element.captionStyle ?? {}),
														wordDisplayPreset: "custom",
													},
												},
											},
										],
									});
									return;
								}

								const preset = value as CaptionWordPreset;
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													wordsOnScreen: CAPTION_WORD_PRESETS[preset],
													wordDisplayPreset: preset,
												},
											},
										},
									],
								});
							}}
						>
							<SelectTrigger>
								<SelectValue placeholder="Select preset" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="compact">Compact (2 words)</SelectItem>
								<SelectItem value="balanced">Balanced (3 words)</SelectItem>
								<SelectItem value="extended">Extended (5 words)</SelectItem>
								<SelectItem value="custom">Custom</SelectItem>
							</SelectContent>
						</Select>
					</SectionField>
					<SectionField label="Words on screen">
						<NumberField
							value={wordsOnScreen.displayValue}
							min={1}
							max={12}
							onFocus={wordsOnScreen.onFocus}
							onChange={wordsOnScreen.onChange}
							onBlur={wordsOnScreen.onBlur}
							onScrub={wordsOnScreen.scrubTo}
							onScrubEnd={wordsOnScreen.commitScrub}
							onReset={() =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													wordsOnScreen: CAPTION_WORD_PRESETS.balanced,
													wordDisplayPreset: "balanced",
												},
											},
										},
									],
								})
							}
							isDefault={currentWordsOnScreen === CAPTION_WORD_PRESETS.balanced}
							icon="W"
						/>
					</SectionField>
					<SectionField label="Max lines on screen">
						<NumberField
							value={maxLinesOnScreen.displayValue}
							min={1}
							max={4}
							onFocus={maxLinesOnScreen.onFocus}
							onChange={maxLinesOnScreen.onChange}
							onBlur={maxLinesOnScreen.onBlur}
							onScrub={maxLinesOnScreen.scrubTo}
							onScrubEnd={maxLinesOnScreen.commitScrub}
							onReset={() =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													maxLinesOnScreen: 2,
												},
											},
										},
									],
								})
							}
							isDefault={
								clampMaxLinesOnScreen(
									element.captionStyle?.maxLinesOnScreen ?? 2,
								) === 2
							}
							icon="L"
						/>
					</SectionField>
					<div className="flex items-center justify-between rounded-sm border px-2 py-2">
						<span className="text-muted-foreground text-xs">
							Link style across captions
						</span>
						<Checkbox
							checked={isLinkedToGroup}
							onCheckedChange={(checked) => {
								const shouldLink = Boolean(checked);
								if (!shouldLink) {
									editor.timeline.updateElements({
										updates: [
											{
												trackId,
												elementId: element.id,
												updates: {
													captionStyle: {
														...(element.captionStyle ?? {}),
														linkedToCaptionGroup: false,
													},
												},
											},
										],
									});
									return;
								}

								const source = findSourceLinkedCaption();
								const sourceElement = source?.element;
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												...(sourceElement
													? {
															transform: sourceElement.transform,
															opacity: sourceElement.opacity,
															blendMode: sourceElement.blendMode,
															fontSize: sourceElement.fontSize,
															fontFamily: sourceElement.fontFamily,
															color: sourceElement.color,
															background: sourceElement.background,
															textAlign: sourceElement.textAlign,
															fontWeight: sourceElement.fontWeight,
															fontStyle: sourceElement.fontStyle,
															textDecoration: sourceElement.textDecoration,
															letterSpacing: sourceElement.letterSpacing,
															lineHeight: sourceElement.lineHeight,
															captionStyle: {
																...(sourceElement.captionStyle ?? {}),
																linkedToCaptionGroup: true,
															},
														}
													: {
															captionStyle: {
																...(element.captionStyle ?? {}),
																linkedToCaptionGroup: true,
															},
														}),
											},
										},
									],
								});
							}}
						/>
					</div>
					<div className="flex items-center justify-between rounded-sm border px-2 py-2">
						<span className="text-muted-foreground text-xs">
							Keep inside canvas
						</span>
						<Checkbox
							checked={element.captionStyle?.fitInCanvas ?? true}
							onCheckedChange={(checked) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													fitInCanvas: Boolean(checked),
												},
											},
										},
									],
								})
							}
						/>
					</div>
					<SectionField label="Y offset from safe area">
						<NumberField
							icon="Y"
							value={safeAreaBottomOffset.displayValue}
							min={-500}
							max={500}
							onFocus={safeAreaBottomOffset.onFocus}
							onChange={safeAreaBottomOffset.onChange}
							onBlur={safeAreaBottomOffset.onBlur}
							onScrub={safeAreaBottomOffset.scrubTo}
							onScrubEnd={safeAreaBottomOffset.commitScrub}
							onReset={() =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													safeAreaBottomOffset: 0,
												},
											},
										},
									],
								})
							}
							isDefault={
								clampSafeAreaBottomOffset(
									element.captionStyle?.safeAreaBottomOffset ?? 0,
								) === 0
							}
						/>
					</SectionField>
					<div className="flex items-center justify-between rounded-sm border px-2 py-2">
						<span className="text-muted-foreground text-xs">
							Never shrink font size
						</span>
						<Checkbox
							checked={element.captionStyle?.neverShrinkFont ?? false}
							onCheckedChange={(checked) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													neverShrinkFont: Boolean(checked),
												},
											},
										},
									],
								})
							}
						/>
					</div>
					<div className="flex items-center justify-between rounded-sm border px-2 py-2">
						<span className="text-muted-foreground text-xs">
							Highlight spoken word
						</span>
						<Checkbox
							checked={element.captionStyle?.karaokeWordHighlight ?? true}
							onCheckedChange={(checked) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													karaokeWordHighlight: Boolean(checked),
												},
											},
										},
									],
								})
							}
						/>
					</div>
					<SectionField label="Highlight style">
						<Select
							value={element.captionStyle?.karaokeHighlightMode ?? "block"}
							onValueChange={(value) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													karaokeHighlightMode: value as
														| "block"
														| "underline"
														| "word",
												},
											},
										},
									],
								})
							}
						>
							<SelectTrigger>
								<SelectValue placeholder="Select highlight style" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="block">Block</SelectItem>
								<SelectItem value="underline">Underline</SelectItem>
								<SelectItem value="word">Word</SelectItem>
							</SelectContent>
						</Select>
					</SectionField>
					{(element.captionStyle?.karaokeHighlightMode ?? "block") ===
						"underline" && (
						<SectionField label="Underline thickness">
							<NumberField
								value={underlineThickness.displayValue}
								min={1}
								max={24}
								onFocus={underlineThickness.onFocus}
								onChange={underlineThickness.onChange}
								onBlur={underlineThickness.onBlur}
								onScrub={underlineThickness.scrubTo}
								onScrubEnd={underlineThickness.commitScrub}
								onReset={() =>
									editor.timeline.updateElements({
										updates: [
											{
												trackId,
												elementId: element.id,
												updates: {
													captionStyle: {
														...(element.captionStyle ?? {}),
														karaokeUnderlineThickness:
															DEFAULT_KARAOKE_UNDERLINE_THICKNESS,
													},
												},
											},
										],
									})
								}
								isDefault={
									clampUnderlineThickness(
										element.captionStyle?.karaokeUnderlineThickness ??
											DEFAULT_KARAOKE_UNDERLINE_THICKNESS,
									) === DEFAULT_KARAOKE_UNDERLINE_THICKNESS
								}
								icon="U"
							/>
						</SectionField>
					)}
					<div className="flex items-center justify-between rounded-sm border px-2 py-2">
						<span className="text-muted-foreground text-xs">
							Ease-in highlight only
						</span>
						<Checkbox
							checked={element.captionStyle?.karaokeHighlightEaseInOnly ?? false}
							onCheckedChange={(checked) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													karaokeHighlightEaseInOnly: Boolean(checked),
												},
											},
										},
									],
								})
							}
						/>
					</div>
					<div className="flex items-center justify-between rounded-sm border px-2 py-2">
						<span className="text-muted-foreground text-xs">
							Scale highlighted word (+10%)
						</span>
						<Checkbox
							checked={element.captionStyle?.karaokeScaleHighlightedWord ?? false}
							onCheckedChange={(checked) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													karaokeScaleHighlightedWord: Boolean(checked),
												},
											},
										},
									],
								})
							}
						/>
					</div>
					<SectionField label="Highlight color">
						<ColorPicker
							value={uppercase({
								string: (
									element.captionStyle?.karaokeHighlightColor ??
									DEFAULT_KARAOKE_HIGHLIGHT_COLOR
								).replace("#", ""),
							})}
							onChange={(color) =>
								editor.timeline.previewElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													karaokeHighlightColor: `#${color}`,
												},
											},
										},
									],
								})
							}
							onChangeEnd={() => editor.timeline.commitPreview()}
						/>
					</SectionField>
					<SectionField label="Highlight text color">
						<ColorPicker
							value={uppercase({
								string: (
									element.captionStyle?.karaokeHighlightTextColor ??
									DEFAULT_KARAOKE_HIGHLIGHT_TEXT_COLOR
								).replace("#", ""),
							})}
							onChange={(color) =>
								editor.timeline.previewElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													karaokeHighlightTextColor: `#${color}`,
												},
											},
										},
									],
								})
							}
							onChangeEnd={() => editor.timeline.commitPreview()}
						/>
					</SectionField>
					<SectionField label="Highlight opacity">
						<NumberField
							value={highlightOpacity.displayValue}
							min={0}
							max={100}
							onFocus={highlightOpacity.onFocus}
							onChange={highlightOpacity.onChange}
							onBlur={highlightOpacity.onBlur}
							onScrub={highlightOpacity.scrubTo}
							onScrubEnd={highlightOpacity.commitScrub}
							onReset={() =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													karaokeHighlightOpacity:
														DEFAULT_KARAOKE_HIGHLIGHT_OPACITY,
												},
											},
										},
									],
								})
							}
							isDefault={
								clampHighlightOpacity(
									element.captionStyle?.karaokeHighlightOpacity ??
										DEFAULT_KARAOKE_HIGHLIGHT_OPACITY,
								) === DEFAULT_KARAOKE_HIGHLIGHT_OPACITY
							}
							icon="%"
						/>
					</SectionField>
					<SectionField label="Highlight roundness">
						<NumberField
							value={highlightRoundness.displayValue}
							min={0}
							max={200}
							onFocus={highlightRoundness.onFocus}
							onChange={highlightRoundness.onChange}
							onBlur={highlightRoundness.onBlur}
							onScrub={highlightRoundness.scrubTo}
							onScrubEnd={highlightRoundness.commitScrub}
							onReset={() =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													karaokeHighlightRoundness:
														DEFAULT_KARAOKE_HIGHLIGHT_ROUNDNESS,
												},
											},
										},
									],
								})
							}
							isDefault={
								clampHighlightRoundness(
									element.captionStyle?.karaokeHighlightRoundness ??
										DEFAULT_KARAOKE_HIGHLIGHT_ROUNDNESS,
								) === DEFAULT_KARAOKE_HIGHLIGHT_ROUNDNESS
							}
							icon="R"
						/>
					</SectionField>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function ContentSection({
	element,
	trackId,
}: {
	element: TextElement;
	trackId: string;
}) {
	const editor = useEditor();
	const isTranscriptDrivenCaption =
		(element.captionWordTimings?.length ?? 0) > 0 ||
		element.captionSourceRef !== undefined;

	const transcriptDerivedContent = useMemo(() => {
		const timings = element.captionWordTimings ?? [];
		if (timings.length === 0) {
			return element.content ?? "";
		}
		return timings
			.map((timing) => timing.word)
			.filter((word) => word.trim().length > 0)
			.join(" ");
	}, [element.captionWordTimings, element.content]);

	const content = usePropertyDraft({
		displayValue: element.content,
		parse: (input) => input,
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{ trackId, elementId: element.id, updates: { content: value } },
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	return (
		<Section collapsible sectionKey="text:content" hasBorderTop={false}>
			<SectionHeader title="Content" />
			<SectionContent>
				{isTranscriptDrivenCaption ? (
					<div className="text-muted-foreground space-y-2 text-xs">
						<p>
							Content is transcript-driven for this caption. Edit words in the
							Transcript panel.
						</p>
						<Textarea
							value={transcriptDerivedContent}
							className="min-h-60"
							readOnly
						/>
					</div>
				) : (
					<Textarea
						placeholder="Name"
						value={content.displayValue}
						className="min-h-60"
						onFocus={content.onFocus}
						onChange={content.onChange}
						onBlur={content.onBlur}
					/>
				)}
			</SectionContent>
		</Section>
	);
}

function TypographySection({
	element,
	trackId,
}: {
	element: TextElement;
	trackId: string;
}) {
	const editor = useEditor();

	const fontSize = usePropertyDraft({
		displayValue: element.fontSize.toString(),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clamp({ value: parsed, min: MIN_FONT_SIZE, max: MAX_FONT_SIZE });
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{ trackId, elementId: element.id, updates: { fontSize: value } },
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	return (
		<Section collapsible sectionKey="text:typography">
			<SectionHeader title="Typography" />
			<SectionContent>
				<SectionFields>
					<SectionField label="Font">
						<FontPicker
							defaultValue={element.fontFamily}
							onValueChange={(value) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: { fontFamily: value },
										},
									],
								})
							}
						/>
					</SectionField>
					<SectionField label="Size">
						<NumberField
							value={fontSize.displayValue}
							min={MIN_FONT_SIZE}
							max={MAX_FONT_SIZE}
							onFocus={fontSize.onFocus}
							onChange={fontSize.onChange}
							onBlur={fontSize.onBlur}
							onScrub={fontSize.scrubTo}
							onScrubEnd={fontSize.commitScrub}
							onReset={() =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: { fontSize: DEFAULT_TEXT_ELEMENT.fontSize },
										},
									],
								})
							}
							isDefault={element.fontSize === DEFAULT_TEXT_ELEMENT.fontSize}
							icon={<HugeiconsIcon icon={TextFontIcon} />}
						/>
					</SectionField>
					<SectionField label="Color">
						<ColorPicker
							value={uppercase({
								string: (element.color || "FFFFFF").replace("#", ""),
							})}
							onChange={(color) =>
								editor.timeline.previewElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: { color: `#${color}` },
										},
									],
								})
							}
							onChangeEnd={() => editor.timeline.commitPreview()}
						/>
					</SectionField>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function SpacingSection({
	element,
	trackId,
}: {
	element: TextElement;
	trackId: string;
}) {
	const editor = useEditor();

	const letterSpacing = usePropertyDraft({
		displayValue: Math.round(
			element.letterSpacing ?? DEFAULT_LETTER_SPACING,
		).toString(),
		parse: (input) => {
			const parsed = parseFloat(input);
			return Number.isNaN(parsed) ? null : Math.round(parsed);
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{ trackId, elementId: element.id, updates: { letterSpacing: value } },
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	const lineHeight = usePropertyDraft({
		displayValue: lineHeightConverter
			.toDisplay(element.lineHeight ?? DEFAULT_LINE_HEIGHT)
			.toString(),
		parse: (input) => {
			const parsed = parseFloat(input);
			return Number.isNaN(parsed)
				? null
				: lineHeightConverter.fromDisplay(Math.round(parsed));
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{ trackId, elementId: element.id, updates: { lineHeight: value } },
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	return (
		<Section collapsible sectionKey="text:spacing" hasBorderBottom={false}>
			<SectionHeader title="Spacing" />
			<SectionContent>
				<div className="flex items-start gap-2">
					<SectionField label="Letter spacing" className="w-1/2">
						<NumberField
							value={letterSpacing.displayValue}
							onFocus={letterSpacing.onFocus}
							onChange={letterSpacing.onChange}
							onBlur={letterSpacing.onBlur}
							onScrub={letterSpacing.scrubTo}
							onScrubEnd={letterSpacing.commitScrub}
							onReset={() =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: { letterSpacing: DEFAULT_LETTER_SPACING },
										},
									],
								})
							}
							isDefault={
								(element.letterSpacing ?? DEFAULT_LETTER_SPACING) ===
								DEFAULT_LETTER_SPACING
							}
							icon={<OcTextWidthIcon size={14} />}
						/>
					</SectionField>
					<SectionField label="Line height" className="w-1/2">
						<NumberField
							value={lineHeight.displayValue}
							onFocus={lineHeight.onFocus}
							onChange={lineHeight.onChange}
							onBlur={lineHeight.onBlur}
							onScrub={lineHeight.scrubTo}
							onScrubEnd={lineHeight.commitScrub}
							onReset={() =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: { lineHeight: DEFAULT_LINE_HEIGHT },
										},
									],
								})
							}
							isDefault={
								(element.lineHeight ?? DEFAULT_LINE_HEIGHT) ===
								DEFAULT_LINE_HEIGHT
							}
							icon={<OcTextHeightIcon size={14} />}
						/>
					</SectionField>
				</div>
			</SectionContent>
		</Section>
	);
}

function BackgroundSection({
	element,
	trackId,
}: {
	element: TextElement;
	trackId: string;
}) {
	const editor = useEditor();
	const lastSelectedColor = useRef(DEFAULT_COLOR);
	const backgroundFitMode =
		element.captionStyle?.backgroundFitMode ??
		DEFAULT_CAPTION_BACKGROUND_FIT_MODE;

	const cornerRadius = usePropertyDraft({
		displayValue: Math.round(element.background.cornerRadius ?? 0).toString(),
		parse: (input) => {
			const parsed = parseFloat(input);
			return Number.isNaN(parsed) ? null : Math.max(0, Math.round(parsed));
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							background: { ...element.background, cornerRadius: value },
						},
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	const paddingX = usePropertyDraft({
		displayValue: paddingXConverter
			.toDisplay(
				element.background.paddingX ?? DEFAULT_TEXT_BACKGROUND.paddingX,
			)
			.toString(),
		parse: (input) => {
			const parsed = parseFloat(input);
			return Number.isNaN(parsed)
				? null
				: paddingXConverter.fromDisplay(Math.round(parsed));
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: { background: { ...element.background, paddingX: value } },
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	const paddingY = usePropertyDraft({
		displayValue: paddingYConverter
			.toDisplay(
				element.background.paddingY ?? DEFAULT_TEXT_BACKGROUND.paddingY,
			)
			.toString(),
		parse: (input) => {
			const parsed = parseFloat(input);
			return Number.isNaN(parsed)
				? null
				: paddingYConverter.fromDisplay(Math.round(parsed));
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: { background: { ...element.background, paddingY: value } },
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	const offsetX = usePropertyDraft({
		displayValue: Math.round(element.background.offsetX ?? 0).toString(),
		parse: (input) => {
			const parsed = parseFloat(input);
			return Number.isNaN(parsed) ? null : Math.round(parsed);
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: { background: { ...element.background, offsetX: value } },
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	const offsetY = usePropertyDraft({
		displayValue: Math.round(element.background.offsetY ?? 0).toString(),
		parse: (input) => {
			const parsed = parseFloat(input);
			return Number.isNaN(parsed) ? null : Math.round(parsed);
		},
		onPreview: (value) =>
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: { background: { ...element.background, offsetY: value } },
					},
				],
			}),
		onCommit: () => editor.timeline.commitPreview(),
	});

	return (
		<Section collapsible sectionKey="text:background">
			<SectionHeader title="Background" />
			<SectionContent>
				<SectionFields>
					<SectionField label="Background fit">
						<Select
							value={backgroundFitMode}
							onValueChange={(value) =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												captionStyle: {
													...(element.captionStyle ?? {}),
													backgroundFitMode: value as "block" | "line-fit",
												},
											},
										},
									],
								})
							}
						>
							<SelectTrigger>
								<SelectValue placeholder="Select fit mode" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="block">Connected (fit width)</SelectItem>
								<SelectItem value="line-fit">Per-line pills</SelectItem>
							</SelectContent>
						</Select>
					</SectionField>
					<SectionField label="Color">
						<ColorPicker
							value={
								element.background.color === "transparent"
									? lastSelectedColor.current.replace("#", "")
									: element.background.color.replace("#", "")
							}
							onChange={(color) => {
								const hexColor = `#${color}`;
								if (color !== "transparent") {
									lastSelectedColor.current = hexColor;
								}
								editor.timeline.previewElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												background: { ...element.background, color: hexColor },
											},
										},
									],
								});
							}}
							onChangeEnd={() => editor.timeline.commitPreview()}
							className={
								element.background.color === "transparent"
									? "pointer-events-none opacity-50"
									: ""
							}
						/>
					</SectionField>
					<div className="flex items-start gap-2">
						<SectionField label="Width" className="w-1/2">
							<NumberField
								icon="W"
								value={paddingX.displayValue}
								min={0}
								onFocus={paddingX.onFocus}
								onChange={paddingX.onChange}
								onBlur={paddingX.onBlur}
								onScrub={paddingX.scrubTo}
								onScrubEnd={paddingX.commitScrub}
								onReset={() =>
									editor.timeline.updateElements({
										updates: [
											{
												trackId,
												elementId: element.id,
												updates: {
													background: {
														...element.background,
														paddingX: DEFAULT_TEXT_BACKGROUND.paddingX,
													},
												},
											},
										],
									})
								}
								isDefault={
									(element.background.paddingX ??
										DEFAULT_TEXT_BACKGROUND.paddingX) ===
									DEFAULT_TEXT_BACKGROUND.paddingX
								}
							/>
						</SectionField>
						<SectionField label="Height" className="w-1/2">
							<NumberField
								icon="H"
								value={paddingY.displayValue}
								min={0}
								onFocus={paddingY.onFocus}
								onChange={paddingY.onChange}
								onBlur={paddingY.onBlur}
								onScrub={paddingY.scrubTo}
								onScrubEnd={paddingY.commitScrub}
								onReset={() =>
									editor.timeline.updateElements({
										updates: [
											{
												trackId,
												elementId: element.id,
												updates: {
													background: {
														...element.background,
														paddingY: DEFAULT_TEXT_BACKGROUND.paddingY,
													},
												},
											},
										],
									})
								}
								isDefault={
									(element.background.paddingY ??
										DEFAULT_TEXT_BACKGROUND.paddingY) ===
									DEFAULT_TEXT_BACKGROUND.paddingY
								}
							/>
						</SectionField>
					</div>
					<div className="flex items-start gap-2">
						<SectionField label="X-offset" className="w-1/2">
							<NumberField
								icon="X"
								value={offsetX.displayValue}
								onFocus={offsetX.onFocus}
								onChange={offsetX.onChange}
								onBlur={offsetX.onBlur}
								onScrub={offsetX.scrubTo}
								onScrubEnd={offsetX.commitScrub}
								onReset={() =>
									editor.timeline.updateElements({
										updates: [
											{
												trackId,
												elementId: element.id,
												updates: {
													background: { ...element.background, offsetX: 0 },
												},
											},
										],
									})
								}
								isDefault={(element.background.offsetX ?? 0) === 0}
							/>
						</SectionField>
						<SectionField label="Y-offset" className="w-1/2">
							<NumberField
								icon="Y"
								value={offsetY.displayValue}
								onFocus={offsetY.onFocus}
								onChange={offsetY.onChange}
								onBlur={offsetY.onBlur}
								onScrub={offsetY.scrubTo}
								onScrubEnd={offsetY.commitScrub}
								onReset={() =>
									editor.timeline.updateElements({
										updates: [
											{
												trackId,
												elementId: element.id,
												updates: {
													background: { ...element.background, offsetY: 0 },
												},
											},
										],
									})
								}
								isDefault={(element.background.offsetY ?? 0) === 0}
							/>
						</SectionField>
					</div>
					<SectionField label="Corner Radius">
						<NumberField
							icon="R"
							value={cornerRadius.displayValue}
							min={0}
							onFocus={cornerRadius.onFocus}
							onChange={cornerRadius.onChange}
							onBlur={cornerRadius.onBlur}
							onScrub={cornerRadius.scrubTo}
							onScrubEnd={cornerRadius.commitScrub}
							onReset={() =>
								editor.timeline.updateElements({
									updates: [
										{
											trackId,
											elementId: element.id,
											updates: {
												background: {
													...element.background,
													cornerRadius: 0,
												},
											},
										},
									],
								})
							}
							isDefault={(element.background.cornerRadius ?? 0) === 0}
						/>
					</SectionField>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
