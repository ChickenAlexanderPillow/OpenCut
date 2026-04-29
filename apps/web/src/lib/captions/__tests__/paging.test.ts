import { describe, expect, test } from "bun:test";
import {
	buildCaptionPages,
	resolveSentenceBoundedPageSize,
} from "@/lib/captions/paging";

describe("buildCaptionPages", () => {
	test("rebalances a trailing one-word page into the previous page", () => {
		const result = buildCaptionPages({
			totalWords: 4,
			activeWordIndex: 3,
			wordsOnScreen: 3,
			resolvePageSize: ({ maxWords }) => maxWords,
		});

		expect(result.pages).toEqual([
			{ chunkStart: 0, pageSize: 2 },
			{ chunkStart: 2, pageSize: 2 },
		]);
		expect(result.activePage).toEqual({ chunkStart: 2, pageSize: 2 });
	});

	test("rebalances a larger trailing widow after page sizing", () => {
		const result = buildCaptionPages({
			totalWords: 7,
			activeWordIndex: 6,
			wordsOnScreen: 6,
			resolvePageSize: ({ maxWords }) => maxWords,
		});

		expect(result.pages).toEqual([
			{ chunkStart: 0, pageSize: 5 },
			{ chunkStart: 5, pageSize: 2 },
		]);
		expect(result.activePage).toEqual({ chunkStart: 5, pageSize: 2 });
	});

	test("does not rebalance when everything fits on one page", () => {
		const result = buildCaptionPages({
			totalWords: 1,
			activeWordIndex: 0,
			wordsOnScreen: 3,
			resolvePageSize: ({ maxWords }) => maxWords,
		});

		expect(result.pages).toEqual([{ chunkStart: 0, pageSize: 1 }]);
	});

	test("does not rebalance when the previous page only has one word", () => {
		const result = buildCaptionPages({
			totalWords: 2,
			activeWordIndex: 1,
			wordsOnScreen: 1,
			resolvePageSize: ({ maxWords }) => maxWords,
		});

		expect(result.pages).toEqual([
			{ chunkStart: 0, pageSize: 1 },
			{ chunkStart: 1, pageSize: 1 },
		]);
	});

	test("applies sentence bounding before the widow rebalance step", () => {
		const words = ["Hello.", "world", "again", "today"];
		const result = buildCaptionPages({
			totalWords: words.length,
			activeWordIndex: 3,
			wordsOnScreen: 3,
			resolveMaxPageSize: ({ start, maxPageSize }) =>
				resolveSentenceBoundedPageSize({
					words,
					start,
					maxPageSize,
				}),
			resolvePageSize: ({ maxWords }) => maxWords,
		});

		expect(result.pages).toEqual([
			{ chunkStart: 0, pageSize: 1 },
			{ chunkStart: 1, pageSize: 3 },
		]);
	});
});
