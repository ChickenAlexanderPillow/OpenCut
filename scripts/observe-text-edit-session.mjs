#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const profileDir =
	process.env.PLAYWRIGHT_PROFILE_DIR ?? "C:\\playwright-shared-profile";
const editorUrl = process.env.PLAYWRIGHT_EDITOR_URL?.trim() ?? "";
const preferHeadless =
	process.env.PLAYWRIGHT_HEADLESS === "1" ||
	process.env.PLAYWRIGHT_HEADLESS === "true";
const pollMs = Math.max(250, Number(process.env.PLAYWRIGHT_OBSERVER_POLL_MS ?? 1000));
const logDir = path.join(process.cwd(), ".tmp");
const logFile = path.join(logDir, "text-edit-observer.jsonl");

function ensureLogDir() {
	if (!fs.existsSync(logDir)) {
		fs.mkdirSync(logDir, { recursive: true });
	}
}

function appendLog(entry) {
	ensureLogDir();
	fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
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
		await page.goto(editorUrl, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
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
	return page;
}

async function installObserver({ page }) {
	await page.waitForFunction(
		() => Boolean(globalThis.__opencut_editor_core_singleton__?.timeline?.getTracks),
		{ timeout: 30_000 },
	);
	await page.evaluate(() => {
		if (globalThis.__opencut_text_edit_observer__) return;

		const MAX_EVENTS = 400;
		const events = [];
		const pushEvent = (type, detail = {}) => {
			events.push({
				timestamp: new Date().toISOString(),
				perfNow: performance.now(),
				type,
				...detail,
			});
			if (events.length > MAX_EVENTS) {
				events.splice(0, events.length - MAX_EVENTS);
			}
		};

		window.addEventListener("opencut:audio-output-level", (event) => {
			const detail = event.detail ?? {};
			pushEvent("audio-output", {
				peak: Number(detail.peak ?? 0),
				rms: Number(detail.rms ?? 0),
				isPlaying: Boolean(detail.isPlaying),
				silent: Boolean(detail.silent),
			});
		});

		window.addEventListener("opencut:audio-graph-state", (event) => {
			const detail = event.detail ?? {};
			pushEvent("audio-graph", {
				isDirty: Boolean(detail.isDirty),
				pendingRebuild: Boolean(detail.pendingRebuild),
				staleForMs: Number(detail.staleForMs ?? 0),
				reason: String(detail.reason ?? ""),
			});
		});

		window.addEventListener("opencut:timeline-playback-state", (event) => {
			const detail = event.detail ?? {};
			pushEvent("playback-state", {
				isPlaying: Boolean(detail.isPlaying),
			});
		});

		window.addEventListener("opencut:audio-prepared-clips", (event) => {
			const detail = event.detail ?? {};
			pushEvent("audio-prepared-clips", {
				clips: Array.isArray(detail.clips) ? detail.clips.slice(0, 24) : [],
			});
		});

		window.addEventListener("opencut:audio-schedule-level", (event) => {
			const detail = event.detail ?? {};
			pushEvent("audio-schedule", {
				clipId: String(detail.clipId ?? ""),
				sourceKey: String(detail.sourceKey ?? ""),
				transcriptRevision: String(detail.transcriptRevision ?? ""),
				transcriptCuts: Array.isArray(detail.transcriptCuts)
					? detail.transcriptCuts.slice(0, 12)
					: [],
				peak: Number(detail.peak ?? 0),
				duration: Number(detail.duration ?? 0),
				timelineSegmentStart: Number(detail.timelineSegmentStart ?? 0),
				timelineSegmentEnd: Number(detail.timelineSegmentEnd ?? 0),
				contextStart: Number(detail.contextStart ?? 0),
			});
		});

		document.addEventListener(
			"click",
			(event) => {
				const target =
					event.target instanceof HTMLElement
						? event.target.closest("[data-word-id],button,[role='button']")
						: null;
				if (!target) return;
				pushEvent("ui-click", {
					wordId: target.getAttribute("data-word-id"),
					label:
						target.getAttribute("aria-label") ??
						target.textContent?.trim()?.slice(0, 80) ??
						"",
					tagName: target.tagName,
				});
			},
			true,
		);

		document.addEventListener(
			"keydown",
			(event) => {
				pushEvent("ui-keydown", {
					key: event.key,
					ctrlKey: event.ctrlKey,
					metaKey: event.metaKey,
					shiftKey: event.shiftKey,
				});
			},
			true,
		);

		document.addEventListener(
			"selectionchange",
			() => {
				const selection = document.getSelection();
				const text = selection?.toString()?.trim() ?? "";
				if (!text) return;
				pushEvent("ui-selection", {
					text: text.slice(0, 120),
				});
			},
			true,
		);

		globalThis.__opencut_text_edit_observer__ = {
			drainEvents() {
				const drained = events.splice(0, events.length);
				return drained;
			},
			snapshot() {
				const editor = globalThis.__opencut_editor_core_singleton__;
				if (!editor) return { error: "missing-editor" };
				const tracks = editor.timeline.getTracks();
				const selected = editor.selection.getSelectedElements?.() ?? [];
				const selectedIds = new Set(selected.map((item) => item.elementId));
				let activeMedia = null;
				let activeCaption = null;

				for (const track of tracks) {
					for (const element of track.elements) {
						if (
							!activeMedia &&
							selectedIds.has(element.id) &&
							(element.type === "video" || element.type === "audio")
						) {
							activeMedia = element;
						}
						if (
							!activeCaption &&
							selectedIds.has(element.id) &&
							element.type === "text" &&
							element.captionSourceRef?.mediaElementId
						) {
							activeCaption = element;
						}
					}
				}

				if (!activeMedia && activeCaption?.captionSourceRef?.mediaElementId) {
					for (const track of tracks) {
						for (const element of track.elements) {
							if (
								(element.type === "video" || element.type === "audio") &&
								element.id === activeCaption.captionSourceRef.mediaElementId
							) {
								activeMedia = element;
								break;
							}
						}
						if (activeMedia) break;
					}
				}

				if (!activeCaption && activeMedia) {
					for (const track of tracks) {
						if (track.type !== "text") continue;
						const caption = track.elements.find(
							(element) =>
								element.type === "text" &&
								element.captionSourceRef?.mediaElementId === activeMedia.id,
						);
						if (caption) {
							activeCaption = caption;
							break;
						}
					}
				}

				const mediaDraft = activeMedia?.transcriptDraft ?? activeMedia?.transcriptEdit ?? null;
				const mediaApplied = activeMedia?.transcriptApplied ?? null;
				const removedWordCount =
					mediaDraft?.words?.filter((word) => Boolean(word.removed)).length ?? 0;
				const audioHealth = editor.audio?.getAudioHealth?.() ?? null;

				return {
					timestamp: new Date().toISOString(),
					playback: {
						time: editor.playback.getCurrentTime(),
						isPlaying: editor.playback.getIsPlaying(),
						blockedReason: editor.playback.getBlockedReason?.() ?? null,
					},
					audioHealth,
					activeMedia: activeMedia
						? {
								id: activeMedia.id,
								type: activeMedia.type,
								startTime: activeMedia.startTime,
								duration: activeMedia.duration,
								trimStart: activeMedia.trimStart,
								trimEnd: activeMedia.trimEnd,
								compileState: activeMedia.transcriptCompileState ?? null,
								draftUpdatedAt: mediaDraft?.updatedAt ?? null,
								appliedUpdatedAt: mediaApplied?.updatedAt ?? null,
								removedWordCount,
								removedRangeCount: mediaApplied?.removedRanges?.length ?? 0,
								removedRanges:
									mediaApplied?.removedRanges?.slice(0, 8).map((cut) => ({
										start: cut.start,
										end: cut.end,
										reason: cut.reason,
									})) ?? [],
								playableDuration: mediaApplied?.timeMap?.playableDuration ?? null,
						  }
						: null,
					activeCaption: activeCaption
						? {
								id: activeCaption.id,
								startTime: activeCaption.startTime,
								duration: activeCaption.duration,
								sourceRef: activeCaption.captionSourceRef ?? null,
								wordTimings:
									(activeCaption.captionWordTimings ?? []).slice(0, 8).map((timing) => ({
										word: timing.word,
										startTime: timing.startTime,
										endTime: timing.endTime,
									})),
						  }
						: null,
				};
			},
		};
	});
}

function isEditorPage(page) {
	if (!page || page.isClosed()) return false;
	const url = page.url();
	return url.includes("/editor/") || url.includes("/projects");
}

async function resolveObservedPage({ context, currentPage }) {
	if (isEditorPage(currentPage)) return currentPage;
	const existing = context.pages().find((candidate) => isEditorPage(candidate));
	if (existing) return existing;
	const freshPage = await context.newPage();
	await freshPage.goto(editorUrl || "http://localhost:3000/projects", {
		waitUntil: "domcontentloaded",
		timeout: 60_000,
	});
	return freshPage;
}

async function main() {
	let chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch (_error) {
		console.error(
			"Missing dependency: playwright. Install with `bun add -d playwright`.",
		);
		process.exit(1);
	}

	const { context, launcher } = await launchWithFallback({ chromium });
	let page = await ensureEditorPage({
		context,
		page: context.pages()[0] ?? (await context.newPage()),
	});
	await installObserver({ page });

	console.log(`Using launcher: ${launcher}`);
	console.log(`Using profile: ${profileDir}`);
	console.log(`Observing: ${page.url()}`);
	console.log(`Writing logs to: ${logFile}`);
	console.log("Drive the UI in this browser window. Press Ctrl+C here when done.");

	appendLog({
		timestamp: new Date().toISOString(),
		type: "observer-start",
		url: page.url(),
	});

	const interval = setInterval(async () => {
		try {
			page = await resolveObservedPage({ context, currentPage: page });
			await installObserver({ page });
			const snapshot = await page.evaluate(
				() => globalThis.__opencut_text_edit_observer__?.snapshot?.() ?? null,
			);
			const events = await page.evaluate(
				() => globalThis.__opencut_text_edit_observer__?.drainEvents?.() ?? [],
			);
			if (snapshot) {
				appendLog({ type: "snapshot", ...snapshot });
				const media = snapshot.activeMedia;
				const playback = snapshot.playback;
				console.log(
					`[${snapshot.timestamp}] t=${playback.time?.toFixed?.(2) ?? "?"} playing=${Boolean(playback.isPlaying)} blocked=${playback.blockedReason ?? "none"} media=${media?.id ?? "none"} removedWords=${media?.removedWordCount ?? 0} removedRanges=${media?.removedRangeCount ?? 0}`,
				);
			}
			for (const event of events) {
				appendLog(event);
			}
		} catch (error) {
			console.warn("Observer poll failed:", error?.message ?? error);
			appendLog({
				timestamp: new Date().toISOString(),
				type: "observer-poll-failed",
				message: error?.message ?? String(error),
			});
		}
	}, pollMs);

	const shutdown = async () => {
		clearInterval(interval);
		appendLog({
			timestamp: new Date().toISOString(),
			type: "observer-stop",
		});
		await context.close();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
