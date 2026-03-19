import { describe, expect, test } from "bun:test";
import {
	BLUE_HIGHLIGHT_CAPTION_TEXT_PROPS,
	resolveBlueHighlightCaptionPreset,
} from "@/constants/caption-presets";

describe("caption presets", () => {
	test("uses the updated blue highlight background color", () => {
		expect(BLUE_HIGHLIGHT_CAPTION_TEXT_PROPS.background.color).toBe("#000000e5");
		expect(resolveBlueHighlightCaptionPreset().textProps.background.color).toBe(
			"#000000e5",
		);
	});
});
