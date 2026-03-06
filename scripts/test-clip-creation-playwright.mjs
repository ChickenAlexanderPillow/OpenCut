#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = process.cwd();
const profileDir = process.env.PLAYWRIGHT_PROFILE_DIR ?? "C:\\playwright-shared-profile";
const preferHeadless =
	process.env.PLAYWRIGHT_HEADLESS === "1" ||
	process.env.PLAYWRIGHT_HEADLESS === "true";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttpReady({ url, timeoutMs = 120000 }) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeoutMs) {
		try {
			const response = await fetch(url, { method: "GET" });
			if (response.ok || response.status === 404) return;
		} catch (error) {
			lastError = error;
		}
		await sleep(1000);
	}
	throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function readProjectIdFromBrowserPaste() {
	const fallbackPath = path.join(repoRoot, "docs", "browser-paste.json");
	if (!fs.existsSync(fallbackPath)) return null;
	try {
		const raw = fs.readFileSync(fallbackPath, "utf8");
		const parsed = JSON.parse(raw);
		return parsed?.project?.metadata?.id ?? parsed?.project?.id ?? parsed?.projectId ?? null;
	} catch {
		return null;
	}
}

function readTranscriptFixtureFromBrowserPaste() {
	const fallbackPath = path.join(repoRoot, "docs", "browser-paste.json");
	if (!fs.existsSync(fallbackPath)) return null;
	try {
		const raw = fs.readFileSync(fallbackPath, "utf8");
		const parsed = JSON.parse(raw);
		const project = parsed?.project ?? parsed;
		const firstEntry = Object.values(project?.clipTranscriptCache ?? {})[0];
		if (!firstEntry) return null;
		const segments = Array.isArray(firstEntry.segments) ? firstEntry.segments : [];
		return {
			text: typeof firstEntry.text === "string" ? firstEntry.text : "",
			segments,
		};
	} catch {
		return null;
	}
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
			const context = await chromium.launchPersistentContext(profileDir, attempt.options);
			return { context, launcher: attempt.name };
		} catch (error) {
			lastError = error;
			console.warn(`Launch failed using ${attempt.name}`);
		}
	}
	throw lastError ?? new Error("Failed to launch browser.");
}

function resolveEditorUrl() {
	const explicit = process.env.PLAYWRIGHT_EDITOR_URL?.trim();
	if (explicit) return explicit;
	const projectId = readProjectIdFromBrowserPaste();
	if (projectId) return `http://localhost:3000/editor/${projectId}`;
	return "http://localhost:3000/editor";
}

async function clickGenerateForSourceMedia({ page, sourceName }) {
	const clicked = await page.evaluate(({ sourceName: wantedName }) => {
		const findContainerFromTitle = () => {
			const titled = Array.from(document.querySelectorAll("span[title]")).find(
				(node) => node.getAttribute("title") === wantedName,
			);
			if (!titled) return null;
			return titled.closest(".group");
		};

		const findContainerFromText = () => {
			const textMatch = Array.from(document.querySelectorAll("span"))
				.find((node) => node.textContent?.trim() === wantedName);
			if (!textMatch) return null;
			return textMatch.closest(".group");
		};

		const container = findContainerFromTitle() ?? findContainerFromText();
		const tryClick = (root) => {
			if (!root) return false;
			const button = root.querySelector(
				"div.absolute.top-2.right-2 button, div.absolute.top-0.right-0 button",
			);
			if (!button) return false;
			button.click();
			return true;
		};

		if (tryClick(container)) return true;

		// Fallback: click first visible clip-generation icon button in assets list/grid.
		const fallbackButton = Array.from(
			document.querySelectorAll("button.h-5.w-5"),
		).find((node) => {
			const parent = node.parentElement;
			if (!parent) return false;
			return Boolean(parent.querySelector("div.text-\\[10px\\]"));
		});
		if (fallbackButton) {
			fallbackButton.click();
			return true;
		}

		return false;
	}, { sourceName });

	if (!clicked) {
		throw new Error("Failed to locate Generate clips button for source media");
	}
}

async function main() {
	const editorUrl = resolveEditorUrl();
	const transcriptFixture = readTranscriptFixtureFromBrowserPaste();
	let dev = null;

	try {
		try {
			await waitForHttpReady({ url: "http://localhost:3000", timeoutMs: 4000 });
			console.log("Detected existing web server on http://localhost:3000");
		} catch {
			dev = spawn("bun", ["run", "dev:web"], {
				cwd: repoRoot,
				stdio: ["ignore", "pipe", "pipe"],
				shell: true,
			});
			dev.stdout.on("data", (chunk) => {
				process.stdout.write(`[dev] ${chunk}`);
			});
			dev.stderr.on("data", (chunk) => {
				process.stderr.write(`[dev:err] ${chunk}`);
			});
			await waitForHttpReady({ url: "http://localhost:3000", timeoutMs: 120000 });
		}

		let chromium;
		try {
			({ chromium } = await import("playwright"));
		} catch (_error) {
			throw new Error(
				"Missing dependency: playwright. Install with `bun add -d playwright`.",
			);
		}

		const { context, launcher } = await launchWithFallback({ chromium });
		console.log(`Using launcher: ${launcher}`);
		console.log(`Using profile: ${profileDir}`);
		console.log(`Opening editor: ${editorUrl}`);

		const pageHasSourceMedia = async (candidate) => {
			try {
				return await candidate.evaluate(() => {
					const editor = globalThis.__opencut_editor_core_singleton__;
					if (!editor?.media?.getAssets) return false;
					return editor.media
						.getAssets()
						.some(
							(asset) =>
								!asset.ephemeral &&
								(asset.type === "video" || asset.type === "audio"),
						);
				});
			} catch {
				return false;
			}
		};
		const editorPages = context.pages().filter((candidate) =>
			candidate.url().includes("/editor/"),
		);
		let page = null;
		for (const candidate of editorPages) {
			if (await pageHasSourceMedia(candidate)) {
				page = candidate;
				console.log(`Reusing existing editor tab: ${candidate.url()}`);
				break;
			}
		}
		if (!page) {
			page = context.pages()[0] ?? (await context.newPage());
			await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
		}
		await page.waitForFunction(
			() => Boolean(globalThis.__opencut_editor_core_singleton__?.media?.getAssets),
			{ timeout: 60000 },
		);

		const source = await page.evaluate(async ({ transcriptFixture: transcriptInput }) => {
			const editor = globalThis.__opencut_editor_core_singleton__;
			const assets = editor.media.getAssets().filter(
				(asset) => !asset.ephemeral && (asset.type === "video" || asset.type === "audio"),
			);
			let first = assets[0] ?? null;
			const active = editor.project.getActive();

			if (!first) {
				// Build a tiny WAV so clip generation has a concrete source media asset.
				const sampleRate = 16000;
				const durationSeconds = 1;
				const frameCount = sampleRate * durationSeconds;
				const wavBuffer = new ArrayBuffer(44 + frameCount * 2);
				const view = new DataView(wavBuffer);
				let offset = 0;
				const writeString = (value) => {
					for (let i = 0; i < value.length; i++) {
						view.setUint8(offset++, value.charCodeAt(i));
					}
				};
				const writeUint16 = (value) => {
					view.setUint16(offset, value, true);
					offset += 2;
				};
				const writeUint32 = (value) => {
					view.setUint32(offset, value, true);
					offset += 4;
				};
				writeString("RIFF");
				writeUint32(36 + frameCount * 2);
				writeString("WAVE");
				writeString("fmt ");
				writeUint32(16);
				writeUint16(1);
				writeUint16(1);
				writeUint32(sampleRate);
				writeUint32(sampleRate * 2);
				writeUint16(2);
				writeUint16(16);
				writeString("data");
				writeUint32(frameCount * 2);
				for (let i = 0; i < frameCount; i++) {
					view.setInt16(offset, 0, true);
					offset += 2;
				}
				const file = new File([wavBuffer], `clip-source-${Date.now()}.wav`, {
					type: "audio/wav",
					lastModified: Date.now(),
				});
				const objectUrl = URL.createObjectURL(file);
				await editor.media.addMediaAsset({
					projectId: active.metadata.id,
					asset: {
						name: file.name,
						type: "audio",
						file,
						url: objectUrl,
						duration: 0,
					},
				});
				first = editor
					.media
					.getAssets()
					.find(
						(asset) =>
							!asset.ephemeral &&
							(asset.type === "video" || asset.type === "audio") &&
							asset.name === file.name,
					) ?? null;
			}
			if (!first) return null;

			// Seed transcript cache so we can test candidate derivation deterministically.
			const fixtureSegments = Array.isArray(transcriptInput?.segments)
				? transcriptInput.segments
				: [];
			const fixtureText =
				typeof transcriptInput?.text === "string"
					? transcriptInput.text
					: fixtureSegments.map((segment) => segment.text).join(" ");
			const modelId = "whisper-medium";
			const language = "auto";
			const cacheKey = `${first.id}:${modelId}:${language}`;
			const durationForFingerprint =
				typeof first.duration === "number" && Number.isFinite(first.duration)
					? Number(first.duration.toFixed(3))
					: 0;
			const fingerprint = JSON.stringify({
				cacheVersion: 1,
				mediaId: first.id,
				modelId,
				language,
				fileSize: first.file.size,
				duration: durationForFingerprint,
			});

			const cache = { ...(active.clipGenerationCache ?? {}) };
			delete cache[first.id];
			const clipTranscriptCache = {
				...(active.clipTranscriptCache ?? {}),
				[cacheKey]: {
					cacheVersion: 1,
					mediaId: first.id,
					fingerprint,
					language,
					modelId,
					text: fixtureText,
					segments: fixtureSegments,
					updatedAt: new Date().toISOString(),
				},
			};

			// Mock scoring API to keep the test focused on client-side clip derivation flow.
			if (!window.__opencut_clip_score_mock_installed__) {
				const originalFetch = window.fetch.bind(window);
				window.fetch = async (input, init) => {
					const requestUrl =
						typeof input === "string" ? input : input instanceof Request ? input.url : "";
					if (requestUrl.includes("/api/clips/score")) {
						let payload = { candidates: [] };
						try {
							payload = init?.body ? JSON.parse(String(init.body)) : payload;
						} catch {}
						const candidates = (payload.candidates ?? []).map((candidate, index) => ({
							id: candidate.id,
							startTime: candidate.startTime,
							endTime: candidate.endTime,
							duration: candidate.duration,
							transcriptSnippet: candidate.transcriptSnippet,
							title: `Candidate ${index + 1}`,
							rationale: "Mocked score for deterministic E2E",
							scoreOverall: 78 - Math.min(12, index * 2),
							scoreBreakdown: {
								hook: 76,
								emotion: 70,
								shareability: 74,
								clarity: 82,
								momentum: 75,
							},
							failureFlags: [],
						}));
						return new Response(JSON.stringify({ candidates }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					return originalFetch(input, init);
				};
				window.__opencut_clip_score_mock_installed__ = true;
			}

			editor.project.setActiveProject({
				project: {
					...active,
					clipGenerationCache: cache,
					clipTranscriptCache,
				},
			});
			return {
				id: first.id,
				name: first.name,
				type: first.type,
				duration: first.duration ?? null,
				projectId: active?.metadata?.id ?? null,
			};
		}, { transcriptFixture });
		if (!source) {
			throw new Error("No source media found in project");
		}
		console.log(`Source media: ${source.name} (${source.id})`);

		// Ensure assets panel is visible before clicking media thumbnail action.
		const assetsTab = page.getByText("Assets", { exact: true }).first();
		if (await assetsTab.isVisible().catch(() => false)) {
			await assetsTab.click();
			await page.waitForTimeout(150);
		}

		await clickGenerateForSourceMedia({
			page,
			sourceName: source.name,
		});

		const resultHandle = await page.waitForFunction(
			({ sourceId }) => {
				const editor = globalThis.__opencut_editor_core_singleton__;
				if (!editor) return null;
				const project = editor.project.getActive();
				const entry = project.clipGenerationCache?.[sourceId];
				if (!entry) return null;
				const candidates = entry.candidates ?? [];
				if (candidates.length > 0 || entry.error) {
					return {
						candidateCount: candidates.length,
						error: entry.error ?? null,
						updatedAt: entry.updatedAt,
						topCandidate:
							candidates[0]
								? {
										id: candidates[0].id,
										startTime: candidates[0].startTime,
										endTime: candidates[0].endTime,
										scoreOverall: candidates[0].scoreOverall ?? null,
										title: candidates[0].title ?? null,
									}
								: null,
						clipTranscriptCacheKeys: Object.keys(project.clipTranscriptCache ?? {}),
					};
				}
				return null;
			},
			{ sourceId: source.id },
			{ timeout: 240000 },
		);
		const result = await resultHandle.jsonValue();

		console.log("Clip generation result:", JSON.stringify(result, null, 2));
		await context.close();

		if (!result || result.candidateCount <= 0) {
			throw new Error(
				`Clip generation did not produce candidates. Error: ${result?.error ?? "unknown"}`,
			);
		}
		console.log("PASS: Clip generation produced candidates.");
	} finally {
		if (dev && !dev.killed) {
			dev.kill("SIGTERM");
		}
	}
}

main().catch((error) => {
	console.error(`FAIL: ${error.message}`);
	process.exit(1);
});
