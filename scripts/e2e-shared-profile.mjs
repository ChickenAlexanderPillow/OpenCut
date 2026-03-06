#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const profileDir = process.env.PLAYWRIGHT_PROFILE_DIR ?? "C:\\playwright-shared-profile";
const editorUrl = process.env.PLAYWRIGHT_EDITOR_URL?.trim() ?? "";
const preferHeadless =
	process.env.PLAYWRIGHT_HEADLESS === "1" ||
	process.env.PLAYWRIGHT_HEADLESS === "true";
const autoExitMs = Number(process.env.PLAYWRIGHT_AUTO_EXIT_MS ?? 0);

function hasProfileLock(dir) {
	const lockCandidates = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
	return lockCandidates.some((name) => fs.existsSync(path.join(dir, name)));
}

async function launchWithFallback({ chromium }) {
	const commonOptions = {
		headless: preferHeadless,
		viewport: { width: 1600, height: 1000 },
	};

	const attempts = [
		{
			name: "Chrome channel",
			options: {
				...commonOptions,
				channel: "chrome",
			},
		},
		{
			name: "Playwright Chromium",
			options: commonOptions,
		},
		{
			name: "Playwright Chromium (forced headless)",
			options: {
				...commonOptions,
				headless: true,
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
			console.warn(`Launch failed using ${attempt.name}.`);
		}
	}
	throw lastError ?? new Error("Failed to launch persistent context.");
}

async function main() {
	let chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch (_error) {
		console.error(
			"Missing dependency: playwright. Install it with `bun add -d playwright` or `npm i -D playwright`.",
		);
		process.exit(1);
	}

	if (!fs.existsSync(profileDir)) {
		fs.mkdirSync(profileDir, { recursive: true });
	}
	if (hasProfileLock(profileDir)) {
		console.warn(
			`Profile lock detected in ${profileDir}. Close all Chrome/Chromium windows using this profile first.`,
		);
	}

	const { context, launcher } = await launchWithFallback({ chromium });

	const existingEditorPage = context
		.pages()
		.find((candidate) => candidate.url().includes("/editor/"));
	const page = existingEditorPage ?? context.pages()[0] ?? (await context.newPage());
	console.log(`Using profile: ${profileDir}`);
	console.log(`Browser launcher: ${launcher}`);
	if (editorUrl.length > 0) {
		console.log(`Opening: ${editorUrl}`);
		await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
	} else if (page.url().includes("/editor/")) {
		console.log(`Reusing editor tab: ${page.url()}`);
	} else {
		console.log("No PLAYWRIGHT_EDITOR_URL provided; browser opened without navigation.");
	}

	console.log("Browser is open with shared storage profile.");
	if (autoExitMs > 0) {
		console.log(`Auto-closing in ${autoExitMs}ms (PLAYWRIGHT_AUTO_EXIT_MS).`);
		setTimeout(async () => {
			await context.close();
			process.exit(0);
		}, autoExitMs);
		return;
	}
	console.log("Press Ctrl+C in this terminal when done.");

	process.on("SIGINT", async () => {
		await context.close();
		process.exit(0);
	});
}

main().catch((error) => {
	console.error(error);
	console.error(
		"If this is a profile lock issue, close all Chrome/Chromium windows and retry.",
	);
	process.exit(1);
});
