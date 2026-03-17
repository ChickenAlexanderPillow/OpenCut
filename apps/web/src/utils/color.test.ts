import { describe, expect, test } from "bun:test";
import { appendAlpha, parseColorInput } from "@/utils/color";

describe("color alpha handling", () => {
	test("hex input with explicit alpha is preserved on commit", () => {
		const parsed = parseColorInput({
			input: "000000b9",
			format: "hex",
		});

		expect(parsed).toBe("000000b9");

		const committed =
			parsed && parsed.length > 6
				? parsed
				: appendAlpha({ rgbHex: parsed ?? "000000", alpha: 0.725 });

		expect(committed).toBe("000000b9");
	});
});
