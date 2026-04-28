import {
	DEFAULT_TEXT_BACKGROUND,
	DEFAULT_TEXT_ELEMENT,
} from "@/constants/text-constants";
import { MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS } from "@/lib/transcript-editor/constants";
import type { TextElement } from "@/types/timeline";

export const BLUE_HIGHLIGHT_CAPTION_STYLE: NonNullable<TextElement["captionStyle"]> =
	{
		fitInCanvas: true,
		neverShrinkFont: true,
		karaokeWordHighlight: true,
		karaokeHighlightMode: "block",
		karaokeHighlightEaseInOnly: false,
		karaokeScaleHighlightedWord: false,
		karaokeUnderlineThickness: 3,
		karaokeHighlightColor: "#3B82F6",
		karaokeHighlightTextColor: "#FFFFFF",
		karaokeHighlightOpacity: 1,
		karaokeHighlightRoundness: 0,
		backgroundFitMode: "line-fit",
		wordsOnScreen: 6,
		maxLinesOnScreen: 1,
		keepVisibleDuringPausesForSeconds: MIN_PLAYABLE_TRANSCRIPT_GAP_SECONDS,
		wordDisplayPreset: "custom",
		linkedToCaptionGroup: true,
		anchorToSafeAreaBottom: true,
		safeAreaBottomOffset: 0,
		splitScreenOverrides: {
			enabled: true,
			anchorToSplitViewport: true,
			dividerPlacement: "on-divider",
			fontSize: 4,
			backgroundPaddingY: DEFAULT_TEXT_BACKGROUND.paddingY - 5,
			wordsOnScreen: 3,
			maxLinesOnScreen: 1,
			anchorToSafeAreaBottom: true,
			safeAreaBottomOffset: 0,
		},
	};

export const BLUE_HIGHLIGHT_CAPTION_TEXT_PROPS: Pick<
	TextElement,
	| "transform"
	| "opacity"
	| "blendMode"
	| "fontSize"
	| "fontFamily"
	| "color"
	| "strokeColor"
	| "strokeWidth"
	| "strokeSoftness"
	| "shadowColor"
	| "shadowOpacity"
	| "shadowDistance"
	| "shadowAngle"
	| "shadowSoftness"
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
	fontSize: 5,
	fontFamily: "Arial",
	color: DEFAULT_TEXT_ELEMENT.color,
	strokeColor: DEFAULT_TEXT_ELEMENT.strokeColor,
	strokeWidth: DEFAULT_TEXT_ELEMENT.strokeWidth,
	strokeSoftness: DEFAULT_TEXT_ELEMENT.strokeSoftness,
	shadowColor: DEFAULT_TEXT_ELEMENT.shadowColor,
	shadowOpacity: DEFAULT_TEXT_ELEMENT.shadowOpacity,
	shadowDistance: DEFAULT_TEXT_ELEMENT.shadowDistance,
	shadowAngle: DEFAULT_TEXT_ELEMENT.shadowAngle,
	shadowSoftness: DEFAULT_TEXT_ELEMENT.shadowSoftness,
	background: {
		...DEFAULT_TEXT_ELEMENT.background,
		color: "#000000e5",
	},
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
	| "strokeColor"
	| "strokeWidth"
	| "strokeSoftness"
	| "shadowColor"
	| "shadowOpacity"
	| "shadowDistance"
	| "shadowAngle"
	| "shadowSoftness"
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

export function resolveBlueHighlightCaptionPreset(): {
	textProps: Pick<
		TextElement,
		| "transform"
		| "opacity"
		| "blendMode"
		| "fontSize"
		| "fontFamily"
		| "color"
		| "strokeColor"
		| "strokeWidth"
		| "strokeSoftness"
		| "shadowColor"
		| "shadowOpacity"
		| "shadowDistance"
		| "shadowAngle"
		| "shadowSoftness"
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
