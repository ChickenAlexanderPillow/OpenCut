import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";

type FakeMeasureContext = {
	font: string;
	textAlign: CanvasTextAlign;
	measureText: (text: string) => TextMetrics;
};

function readFontSizeFromFont(font: string): number {
	const match = /(\d+(?:\.\d+)?)px/.exec(font);
	return match ? Number.parseFloat(match[1]) : 16;
}

describe("getElementBounds text background scaling", () => {
	beforeEach(() => {
		const fakeContext: FakeMeasureContext = {
			font: "",
			textAlign: "center",
			measureText(text: string) {
				const fontSize = readFontSizeFromFont(this.font);
				const width = text.length * fontSize * 0.6;
				return {
					width,
					actualBoundingBoxAscent: fontSize * 0.8,
					actualBoundingBoxDescent: fontSize * 0.2,
				} as TextMetrics;
			},
		};

		Object.defineProperty(globalThis, "document", {
			value: {
				createElement: (tag: string) => {
					if (tag !== "canvas") return {};
					return {
						width: 0,
						height: 0,
						getContext: (kind: string) => (kind === "2d" ? fakeContext : null),
					};
				},
			},
			configurable: true,
		});
	});

	test("square preview keeps caption background size aligned to the project height", async () => {
		const { getElementBounds } = await import("../element-bounds");

		const element = {
			...DEFAULT_TEXT_ELEMENT,
			id: "caption-1",
			content: "Caption",
			duration: 10,
			background: {
				...DEFAULT_TEXT_ELEMENT.background,
				color: "#000000",
			},
		};

		const verticalBounds = getElementBounds({
			element,
			canvasSize: { width: 1080, height: 1920 },
		});
		const squareBounds = getElementBounds({
			element,
			canvasSize: { width: 1080, height: 1080 },
			backgroundReferenceCanvasSize: { width: 1080, height: 1920 },
		});

		expect(verticalBounds).not.toBeNull();
		expect(squareBounds).not.toBeNull();
		if (!verticalBounds || !squareBounds) return;

		expect(squareBounds.width).toBeLessThan(verticalBounds.width);
		expect(squareBounds.height).toBeLessThan(verticalBounds.height);
		expect(squareBounds.width / verticalBounds.width).toBeGreaterThan(0.7);
		expect(squareBounds.height / verticalBounds.height).toBeGreaterThan(0.7);
	});
});
