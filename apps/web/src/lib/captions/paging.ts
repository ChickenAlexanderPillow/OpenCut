export type CaptionPage = {
	chunkStart: number;
	pageSize: number;
};

function clampPageSize({
	pageSize,
	maxPageSize,
}: {
	pageSize: number;
	maxPageSize: number;
}): number {
	if (maxPageSize <= 0) return 0;
	return Math.max(1, Math.min(maxPageSize, Math.round(pageSize)));
}

export function isSentenceEndingWord(word: string): boolean {
	const trimmed = word.trim();
	if (!trimmed) return false;
	return /[.!?]["')\]]*$/.test(trimmed);
}

export function resolveSentenceBoundedPageSize({
	words,
	start,
	maxPageSize,
}: {
	words: string[];
	start: number;
	maxPageSize: number;
}): number {
	if (maxPageSize <= 1) return Math.max(1, maxPageSize);
	const endExclusive = Math.min(words.length, start + maxPageSize);
	for (let index = start; index < endExclusive; index++) {
		if (isSentenceEndingWord(words[index] ?? "")) {
			return Math.max(1, index - start + 1);
		}
	}
	return maxPageSize;
}

function rebalanceTrailingWidow({
	pages,
}: {
	pages: CaptionPage[];
}): CaptionPage[] {
	if (pages.length < 2) return pages;
	const nextPages = [...pages];
	const lastPage = nextPages[nextPages.length - 1];
	const previousPage = nextPages[nextPages.length - 2];
	if (!lastPage || !previousPage) return pages;
	if (lastPage.pageSize !== 1) return pages;
	if (previousPage.pageSize < 2) return pages;
	nextPages[nextPages.length - 2] = {
		...previousPage,
		pageSize: previousPage.pageSize - 1,
	};
	nextPages[nextPages.length - 1] = {
		chunkStart: lastPage.chunkStart - 1,
		pageSize: lastPage.pageSize + 1,
	};
	return nextPages;
}

export function buildCaptionPages({
	totalWords,
	activeWordIndex,
	wordsOnScreen,
	resolvePageSize,
	resolveMaxPageSize,
}: {
	totalWords: number;
	activeWordIndex: number;
	wordsOnScreen: number | null;
	resolvePageSize: (args: { start: number; maxWords: number }) => number;
	resolveMaxPageSize?: (args: {
		start: number;
		maxPageSize: number;
	}) => number;
}): {
	pages: CaptionPage[];
	activePage: CaptionPage | null;
} {
	if (totalWords <= 0) {
		return { pages: [], activePage: null };
	}

	if (wordsOnScreen === null || wordsOnScreen <= 0) {
		const page = { chunkStart: 0, pageSize: totalWords };
		return { pages: [page], activePage: page };
	}

	const pages: CaptionPage[] = [];
	let pageStart = 0;
	while (pageStart < totalWords) {
		const unsnappedMaxPageSize = Math.min(wordsOnScreen, totalWords - pageStart);
		const boundedMaxPageSize = resolveMaxPageSize
			? clampPageSize({
					pageSize: resolveMaxPageSize({
						start: pageStart,
						maxPageSize: unsnappedMaxPageSize,
					}),
					maxPageSize: unsnappedMaxPageSize,
				})
			: unsnappedMaxPageSize;
		const pageSize = clampPageSize({
			pageSize: resolvePageSize({
				start: pageStart,
				maxWords: boundedMaxPageSize,
			}),
			maxPageSize: boundedMaxPageSize,
		});
		pages.push({
			chunkStart: pageStart,
			pageSize,
		});
		pageStart += pageSize;
	}

	const rebalancedPages = rebalanceTrailingWidow({ pages });
	return {
		pages: rebalancedPages,
		activePage: resolveCaptionPageForWordIndex({
			pages: rebalancedPages,
			activeWordIndex,
		}),
	};
}

export function resolveCaptionPageForWordIndex({
	pages,
	activeWordIndex,
}: {
	pages: CaptionPage[];
	activeWordIndex: number;
}): CaptionPage | null {
	if (pages.length === 0) return null;
	if (activeWordIndex < 0) return pages[0] ?? null;
	for (const page of pages) {
		if (activeWordIndex < page.chunkStart + page.pageSize) {
			return page;
		}
	}
	return pages[pages.length - 1] ?? null;
}
