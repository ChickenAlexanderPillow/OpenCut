import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import type { TextElement } from "@/types/timeline";

const CAPTION_PRESETS_STORAGE_KEY = "caption-global-presets:v1";
const BUILTIN_BLUE_HIGHLIGHT_PRESET_ID = "builtin-blue-highlight";

export const BLUE_HIGHLIGHT_CAPTION_STYLE: NonNullable<TextElement["captionStyle"]> =
	{
		fitInCanvas: true,
		neverShrinkFont: false,
		karaokeWordHighlight: true,
		karaokeHighlightMode: "block",
		karaokeHighlightEaseInOnly: false,
		karaokeScaleHighlightedWord: false,
		karaokeUnderlineThickness: 3,
		karaokeHighlightColor: "#3B82F6",
		karaokeHighlightTextColor: "#FFFFFF",
		karaokeHighlightOpacity: 1,
		karaokeHighlightRoundness: 24,
		backgroundFitMode: "block",
		wordsOnScreen: 3,
		maxLinesOnScreen: 2,
		wordDisplayPreset: "balanced",
		linkedToCaptionGroup: true,
		anchorToSafeAreaBottom: true,
		safeAreaBottomOffset: 0,
	};

export const BLUE_HIGHLIGHT_CAPTION_TEXT_PROPS: Pick<
	TextElement,
	| "transform"
	| "opacity"
	| "blendMode"
	| "fontSize"
	| "fontFamily"
	| "color"
	| "background"
	| "textAlign"
	| "fontWeight"
	| "fontStyle"
	| "textDecoration"
	| "letterSpacing"
	| "lineHeight"
> = {
	transform: DEFAULT_TEXT_ELEMENT.transform,
	opacity: DEFAULT_TEXT_ELEMENT.opacity,
	blendMode: DEFAULT_TEXT_ELEMENT.blendMode,
	fontSize: 65,
	fontFamily: DEFAULT_TEXT_ELEMENT.fontFamily,
	color: DEFAULT_TEXT_ELEMENT.color,
	background: DEFAULT_TEXT_ELEMENT.background,
	textAlign: DEFAULT_TEXT_ELEMENT.textAlign,
	fontWeight: "bold",
	fontStyle: DEFAULT_TEXT_ELEMENT.fontStyle,
	textDecoration: DEFAULT_TEXT_ELEMENT.textDecoration,
	letterSpacing: DEFAULT_TEXT_ELEMENT.letterSpacing,
	lineHeight: DEFAULT_TEXT_ELEMENT.lineHeight,
};

export function createBlueHighlightCaptionTextProps(): Pick<
	TextElement,
	| "transform"
	| "opacity"
	| "blendMode"
	| "fontSize"
	| "fontFamily"
	| "color"
	| "background"
	| "textAlign"
	| "fontWeight"
	| "fontStyle"
	| "textDecoration"
	| "letterSpacing"
	| "lineHeight"
> {
	return {
		...BLUE_HIGHLIGHT_CAPTION_TEXT_PROPS,
		transform: {
			...BLUE_HIGHLIGHT_CAPTION_TEXT_PROPS.transform,
			position: {
				...BLUE_HIGHLIGHT_CAPTION_TEXT_PROPS.transform.position,
			},
		},
		background: {
			...BLUE_HIGHLIGHT_CAPTION_TEXT_PROPS.background,
		},
	};
}

export function createBlueHighlightCaptionStyle(): NonNullable<TextElement["captionStyle"]> {
	return {
		...BLUE_HIGHLIGHT_CAPTION_STYLE,
	};
}

function getBlueHighlightPresetSnapshotFromLocalStorage(): {
	textProps: Pick<
		TextElement,
		| "transform"
		| "opacity"
		| "blendMode"
		| "fontSize"
		| "fontFamily"
		| "color"
		| "background"
		| "textAlign"
		| "fontWeight"
		| "fontStyle"
		| "textDecoration"
		| "letterSpacing"
		| "lineHeight"
	>;
	captionStyle: NonNullable<TextElement["captionStyle"]>;
} | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		const raw = window.localStorage.getItem(CAPTION_PRESETS_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Array<{
			id?: string;
			snapshot?: {
				transform?: TextElement["transform"];
				opacity?: TextElement["opacity"];
				blendMode?: TextElement["blendMode"];
				fontSize?: TextElement["fontSize"];
				fontFamily?: TextElement["fontFamily"];
				color?: TextElement["color"];
				background?: TextElement["background"];
				textAlign?: TextElement["textAlign"];
				fontWeight?: TextElement["fontWeight"];
				fontStyle?: TextElement["fontStyle"];
				textDecoration?: TextElement["textDecoration"];
				letterSpacing?: TextElement["letterSpacing"];
				lineHeight?: TextElement["lineHeight"];
				captionStyle?: NonNullable<TextElement["captionStyle"]>;
			};
		}>;
		const builtInPreset = parsed.find(
			(entry) =>
				entry.id === BUILTIN_BLUE_HIGHLIGHT_PRESET_ID &&
				entry.snapshot != null,
		)?.snapshot;
		if (!builtInPreset) return null;
		if (
			!builtInPreset.transform ||
			!builtInPreset.background ||
			!builtInPreset.captionStyle
		) {
			return null;
		}
		return {
			textProps: {
				transform: builtInPreset.transform,
				opacity: builtInPreset.opacity ?? DEFAULT_TEXT_ELEMENT.opacity,
				blendMode: builtInPreset.blendMode ?? DEFAULT_TEXT_ELEMENT.blendMode,
				fontSize: builtInPreset.fontSize ?? 65,
				fontFamily: builtInPreset.fontFamily ?? DEFAULT_TEXT_ELEMENT.fontFamily,
				color: builtInPreset.color ?? DEFAULT_TEXT_ELEMENT.color,
				background: builtInPreset.background,
				textAlign: builtInPreset.textAlign ?? DEFAULT_TEXT_ELEMENT.textAlign,
				fontWeight: builtInPreset.fontWeight ?? "bold",
				fontStyle: builtInPreset.fontStyle ?? DEFAULT_TEXT_ELEMENT.fontStyle,
				textDecoration:
					builtInPreset.textDecoration ?? DEFAULT_TEXT_ELEMENT.textDecoration,
				letterSpacing:
					builtInPreset.letterSpacing ?? DEFAULT_TEXT_ELEMENT.letterSpacing,
				lineHeight: builtInPreset.lineHeight ?? DEFAULT_TEXT_ELEMENT.lineHeight,
			},
			captionStyle: builtInPreset.captionStyle,
		};
	} catch {
		return null;
	}
}

export function resolveBlueHighlightCaptionPreset(): {
	textProps: Pick<
		TextElement,
		| "transform"
		| "opacity"
		| "blendMode"
		| "fontSize"
		| "fontFamily"
		| "color"
		| "background"
		| "textAlign"
		| "fontWeight"
		| "fontStyle"
		| "textDecoration"
		| "letterSpacing"
		| "lineHeight"
	>;
	captionStyle: NonNullable<TextElement["captionStyle"]>;
} {
	const snapshot = getBlueHighlightPresetSnapshotFromLocalStorage();
	if (snapshot) {
		return {
			textProps: {
				...snapshot.textProps,
				transform: {
					...snapshot.textProps.transform,
					position: {
						...snapshot.textProps.transform.position,
					},
				},
				background: {
					...snapshot.textProps.background,
				},
			},
			captionStyle: {
				...snapshot.captionStyle,
			},
		};
	}
	return {
		textProps: createBlueHighlightCaptionTextProps(),
		captionStyle: createBlueHighlightCaptionStyle(),
	};
}

export function applyBlueHighlightCaptionPreset({
	element,
}: {
	element: TextElement;
}): TextElement {
	const preset = resolveBlueHighlightCaptionPreset();
	return {
		...element,
		...preset.textProps,
		captionStyle: preset.captionStyle,
	};
}
