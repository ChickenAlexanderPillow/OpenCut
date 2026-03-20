import { describe, expect, test } from "bun:test";
import { didRevealNewSourceRange } from "../clip-expansion";

describe("didRevealNewSourceRange", () => {
	test("returns true when expanding left reveals earlier source frames", () => {
		expect(
			didRevealNewSourceRange({
				before: { trimStart: 5, duration: 10 },
				after: { trimStart: 3, duration: 12 },
			}),
		).toBe(true);
	});

	test("returns true when expanding right reveals later source frames", () => {
		expect(
			didRevealNewSourceRange({
				before: { trimStart: 5, duration: 10 },
				after: { trimStart: 5, duration: 14 },
			}),
		).toBe(true);
	});

	test("returns false when only trimming inward", () => {
		expect(
			didRevealNewSourceRange({
				before: { trimStart: 5, duration: 10 },
				after: { trimStart: 6, duration: 8 },
			}),
		).toBe(false);
	});
});
