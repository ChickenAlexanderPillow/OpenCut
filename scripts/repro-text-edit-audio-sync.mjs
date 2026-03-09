#!/usr/bin/env node

const profileDir =
	process.env.PLAYWRIGHT_PROFILE_DIR ?? "C:\\playwright-shared-profile";
const editorUrl = process.env.PLAYWRIGHT_EDITOR_URL?.trim() ?? "";
const preferHeadless =
	process.env.PLAYWRIGHT_HEADLESS === "1" ||
	process.env.PLAYWRIGHT_HEADLESS === "true";

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchWithFallback({ chromium }) {
	const attempts = [
		{
			name: "Chrome channel",
			options: {
				channel: "chrome",
				headless: preferHeadless,
				viewport: { width: 1600, height: 1000 },
			},
		},
		{
			name: "Playwright Chromium",
			options: {
				headless: preferHeadless,
				viewport: { width: 1600, height: 1000 },
			},
		},
	];
	let lastError = null;
	for (const attempt of attempts) {
		try {
			const context = await chromium.launchPersistentContext(
				profileDir,
				attempt.options,
			);
			return { context, launcher: attempt.name };
		} catch (error) {
			lastError = error;
			console.warn(`Launch failed using ${attempt.name}`);
		}
	}
	throw lastError ?? new Error("Failed to launch browser.");
}

async function ensureEditorPage({ context, page }) {
	if (editorUrl.length > 0) {
		await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
		return page;
	}
	if (page.url().includes("/editor/")) return page;
	const existingEditorPage = context
		.pages()
		.find((candidate) => candidate.url().includes("/editor/"));
	if (existingEditorPage) return existingEditorPage;
	await page.goto("http://localhost:3000/projects", {
		waitUntil: "domcontentloaded",
		timeout: 60_000,
	});
	const firstProjectLink = page.locator('a[href^="/editor/"]').first();
	await firstProjectLink.waitFor({ state: "visible", timeout: 30_000 });
	await firstProjectLink.click();
	await page.waitForURL(/\/editor\//, { timeout: 60_000 });
	return page;
}

async function installRecorder({ page }) {
	await page.waitForFunction(
		() => Boolean(globalThis.__opencut_editor_core_singleton__?.timeline?.getTracks),
		{ timeout: 30_000 },
	);
	await page.evaluate(() => {
		const existing = globalThis.__opencut_text_edit_repro__;
		if (existing?.reset) {
			existing.reset();
			return;
		}

		const events = [];
		const pushEvent = (type, detail = {}) => {
			events.push({
				timestamp: new Date().toISOString(),
				perfNow: performance.now(),
				type,
				...detail,
			});
			if (events.length > 1000) {
				events.splice(0, events.length - 1000);
			}
		};

		window.addEventListener("opencut:audio-prepared-clips", (event) => {
			pushEvent("audio-prepared-clips", {
				clips: event.detail?.clips ?? [],
			});
		});
		window.addEventListener("opencut:audio-schedule-level", (event) => {
			pushEvent("audio-schedule", {
				clipId: event.detail?.clipId ?? "",
				sourceKey: event.detail?.sourceKey ?? "",
				transcriptRevision: event.detail?.transcriptRevision ?? "",
				transcriptCuts: event.detail?.transcriptCuts ?? [],
				peak: Number(event.detail?.peak ?? 0),
				duration: Number(event.detail?.duration ?? 0),
				timelineSegmentStart: Number(event.detail?.timelineSegmentStart ?? 0),
				timelineSegmentEnd: Number(event.detail?.timelineSegmentEnd ?? 0),
				localPlaybackStart: Number(event.detail?.localPlaybackStart ?? 0),
				sourceAbsoluteStart: Number(event.detail?.sourceAbsoluteStart ?? 0),
				sourceAbsoluteOffset: Number(event.detail?.sourceAbsoluteOffset ?? 0),
			});
		});
		window.addEventListener("opencut:audio-output-level", (event) => {
			pushEvent("audio-output", {
				peak: Number(event.detail?.peak ?? 0),
				isPlaying: Boolean(event.detail?.isPlaying),
				silent: Boolean(event.detail?.silent),
			});
		});

		globalThis.__opencut_text_edit_repro__ = {
			reset() {
				events.splice(0, events.length);
			},
			getEvents() {
				return events.slice();
			},
			getState() {
				const editor = globalThis.__opencut_editor_core_singleton__;
				const tracks = editor?.timeline?.getTracks?.() ?? [];
				const words = Array.from(
					document.querySelectorAll("[data-word-id]"),
					(node) => ({
						wordId: node.getAttribute("data-word-id"),
						text: node.textContent?.trim() ?? "",
					}),
				);
				return {
					playbackTime: editor?.playback?.getCurrentTime?.() ?? null,
					isPlaying: editor?.playback?.getIsPlaying?.() ?? false,
					tracksCount: tracks.length,
					visibleWords: words,
				};
			},
		};
	});
}

async function selectActiveMediaClip({ page }) {
	const firstMediaClip = page
		.locator(
			'[data-timeline-element-type="video"], [data-timeline-element-type="audio"]',
		)
		.first();
	await firstMediaClip.waitFor({ state: "visible", timeout: 30_000 });
	await firstMediaClip.click();
	await wait(400);
}

async function main() {
	let chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch {
		console.error("Missing dependency: playwright.");
		process.exit(1);
	}

	const { context, launcher } = await launchWithFallback({ chromium });
	const page = await ensureEditorPage({
		context,
		page: context.pages()[0] ?? (await context.newPage()),
	});
	await installRecorder({ page });

	try {
		console.log(`Using launcher: ${launcher}`);
		console.log(`Using page: ${page.url()}`);

		await selectActiveMediaClip({ page });

		try {
			const transcriptButton = page.getByRole("button", {
				name: /Transcript & Captions/i,
			});
			if (
				await transcriptButton.isVisible({ timeout: 2000 }).catch(() => false)
			) {
				await transcriptButton.click();
				await wait(600);
			}
		} catch {}

		try {
			const restoreAllButton = page.getByRole("button", { name: /Restore All/i });
			if (await restoreAllButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
				await restoreAllButton.click();
				await wait(600);
			}
		} catch {}

		const words = await page
			.locator("[data-word-id]")
			.evaluateAll((nodes) =>
				nodes.slice(0, 12).map((node) => ({
					wordId: node.getAttribute("data-word-id"),
					text: node.textContent?.trim() ?? "",
				})),
			);

		if (words.length < 3) {
			throw new Error(`Expected transcript words, found ${words.length}.`);
		}

		const targets = words.slice(1, 4);
		for (const target of targets) {
			await page.locator(`[data-word-id="${target.wordId}"]`).click();
			await wait(350);
		}

		await page.evaluate(() => {
			globalThis.__opencut_editor_core_singleton__?.playback?.seek?.({ time: 0 });
		});
		await wait(250);

		await page.keyboard.press("Space");
		await wait(3500);
		await page.keyboard.press("Space");
		await wait(500);

		const result = await page.evaluate(() => {
			const recorder = globalThis.__opencut_text_edit_repro__;
			return {
				state: recorder?.getState?.() ?? null,
				events: recorder?.getEvents?.() ?? [],
			};
		});

		console.log(JSON.stringify(result, null, 2));
		await context.close();
	} catch (error) {
		await context.close();
		throw error;
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
