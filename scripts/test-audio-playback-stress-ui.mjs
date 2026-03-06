#!/usr/bin/env node

const profileDir = process.env.PLAYWRIGHT_PROFILE_DIR ?? "C:\\playwright-shared-profile";
const editorUrl = process.env.PLAYWRIGHT_EDITOR_URL?.trim() ?? "";
const preferHeadless =
	process.env.PLAYWRIGHT_HEADLESS === "1" ||
	process.env.PLAYWRIGHT_HEADLESS === "true";
const loopCount = Math.max(8, Number(process.env.PLAYWRIGHT_STRESS_LOOPS ?? 24));

function assert(condition, message) {
	if (!condition) throw new Error(message);
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
		console.log(`Opening: ${editorUrl}`);
		await page.goto(editorUrl, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		return page;
	}

	if (page.url().includes("/editor/")) {
		console.log(`Reusing editor tab: ${page.url()}`);
		return page;
	}

	const existingEditorPage = context
		.pages()
		.find((candidate) => candidate.url().includes("/editor/"));
	if (existingEditorPage) {
		console.log(`Reusing editor tab: ${existingEditorPage.url()}`);
		return existingEditorPage;
	}

	throw new Error(
		"No editor tab found in shared profile. Open your target editor project first or set PLAYWRIGHT_EDITOR_URL.",
	);
}

async function setupStressFixture({ page }) {
	return await page.evaluate(async () => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		if (!editor) {
			return { ok: false, error: "Editor singleton not found" };
		}

		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		let activeProject = null;
		try {
			activeProject = editor.project.getActive();
		} catch {}
		if (!activeProject) {
			await editor.project.createNewProject({
				name: `Audio stress ${new Date().toISOString()}`,
			});
			activeProject = editor.project.getActive();
		}

		const projectId = activeProject?.metadata?.id ?? activeProject?.id ?? null;
		if (!projectId) {
			return { ok: false, error: "No active project id available" };
		}

		// Build a deterministic mono tone WAV so we can monitor output behavior.
		const sampleRate = 48_000;
		const duration = 6;
		const frameCount = Math.floor(sampleRate * duration);
		const pcm = new Float32Array(frameCount);
		for (let index = 0; index < frameCount; index++) {
			const t = index / sampleRate;
			pcm[index] = Math.sin(2 * Math.PI * 220 * t) * 0.1;
		}
		const bytesPerSample = 2;
		const blockAlign = bytesPerSample;
		const byteRate = sampleRate * blockAlign;
		const dataSize = frameCount * bytesPerSample;
		const wavBuffer = new ArrayBuffer(44 + dataSize);
		const view = new DataView(wavBuffer);
		let offset = 0;
		const writeString = (value) => {
			for (let index = 0; index < value.length; index++) {
				view.setUint8(offset++, value.charCodeAt(index));
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
		writeUint32(36 + dataSize);
		writeString("WAVE");
		writeString("fmt ");
		writeUint32(16);
		writeUint16(1);
		writeUint16(1);
		writeUint32(sampleRate);
		writeUint32(byteRate);
		writeUint16(blockAlign);
		writeUint16(16);
		writeString("data");
		writeUint32(dataSize);
		for (let index = 0; index < frameCount; index++) {
			const sample = Math.max(-1, Math.min(1, pcm[index]));
			view.setInt16(
				offset,
				sample < 0 ? sample * 0x8000 : sample * 0x7fff,
				true,
			);
			offset += 2;
		}

		const file = new File([wavBuffer], `audio-stress-${Date.now()}.wav`, {
			type: "audio/wav",
			lastModified: Date.now(),
		});
		const objectUrl = URL.createObjectURL(file);
		const beforeAssetIds = new Set(editor.media.getAssets().map((asset) => asset.id));
		await editor.media.addMediaAsset({
			projectId,
			asset: {
				name: file.name,
				type: "audio",
				file,
				url: objectUrl,
				duration,
			},
		});

		const asset = editor
			.media
			.getAssets()
			.find((candidate) => !beforeAssetIds.has(candidate.id) && candidate.name === file.name);
		if (!asset) {
			return { ok: false, error: "Failed to add stress audio asset" };
		}

		const beforeElementIds = new Set(
			editor.timeline.getTracks().flatMap((track) => track.elements).map((element) => element.id),
		);
		editor.timeline.insertElement({
			element: {
				type: "audio",
				sourceType: "upload",
				mediaId: asset.id,
				name: "Audio stress tone",
				startTime: 0,
				duration,
				trimStart: 0,
				trimEnd: 0,
				volume: 1,
				muted: false,
			},
			placement: { mode: "auto", trackType: "audio" },
		});

		await sleep(250);
		let trackId = null;
		let elementId = null;
		for (const track of editor.timeline.getTracks()) {
			for (const element of track.elements) {
				if (beforeElementIds.has(element.id)) continue;
				if (element.type !== "audio") continue;
				if (element.sourceType !== "upload" || element.mediaId !== asset.id) continue;
				trackId = track.id;
				elementId = element.id;
				break;
			}
			if (trackId && elementId) break;
		}
		if (!trackId || !elementId) {
			return { ok: false, error: "Failed to insert stress audio element" };
		}

		editor.playback.pause();
		editor.playback.seek({ time: 0 });

		const existing = globalThis.__opencut_audio_stress_monitor__;
		if (existing?.cleanup) {
			try {
				existing.cleanup();
			} catch {}
		}

		const monitor = {
			lastIsPlaying: editor.playback.getIsPlaying(),
			output: [],
			schedule: [],
			graph: [],
			playback: [],
		};

		const onOutput = (event) => {
			const detail = event.detail ?? {};
			monitor.output.push({
				t: performance.now(),
				peak: Number(detail.peak ?? 0),
				isPlaying: Boolean(detail.isPlaying),
			});
		};
		const onSchedule = (event) => {
			const detail = event.detail ?? {};
			monitor.schedule.push({
				t: performance.now(),
				clipId: String(detail.clipId ?? ""),
				peak: Number(detail.peak ?? 0),
				duration: Number(detail.duration ?? 0),
				isPlaying: monitor.lastIsPlaying,
			});
		};
		const onGraph = (event) => {
			const detail = event.detail ?? {};
			monitor.graph.push({
				t: performance.now(),
				isDirty: Boolean(detail.isDirty),
				pendingRebuild: Boolean(detail.pendingRebuild),
				staleForMs: Number(detail.staleForMs ?? 0),
			});
		};
		const onPlaybackState = (event) => {
			const detail = event.detail ?? {};
			monitor.lastIsPlaying = Boolean(detail.isPlaying);
			monitor.playback.push({
				t: performance.now(),
				isPlaying: monitor.lastIsPlaying,
			});
		};

		window.addEventListener("opencut:audio-output-level", onOutput);
		window.addEventListener("opencut:audio-schedule-level", onSchedule);
		window.addEventListener("opencut:audio-graph-state", onGraph);
		window.addEventListener("opencut:timeline-playback-state", onPlaybackState);

		globalThis.__opencut_audio_stress_monitor__ = {
			monitor,
			cleanup: () => {
				window.removeEventListener("opencut:audio-output-level", onOutput);
				window.removeEventListener("opencut:audio-schedule-level", onSchedule);
				window.removeEventListener("opencut:audio-graph-state", onGraph);
				window.removeEventListener("opencut:timeline-playback-state", onPlaybackState);
			},
		};

		return {
			ok: true,
			projectId,
			assetId: asset.id,
			trackId,
			elementId,
		};
	});
}

async function dismissBlockingOverlays({ page }) {
	for (let attempt = 0; attempt < 3; attempt++) {
		await page.keyboard.press("Escape").catch(() => {});
		await page.waitForTimeout(80);
	}
	await page.evaluate(() => {
		const closeButtons = Array.from(
			document.querySelectorAll('button[aria-label="Close"], button[title="Close"]'),
		);
		for (const button of closeButtons) {
			if (button instanceof HTMLButtonElement && !button.disabled) {
				button.click();
			}
		}
	});
	await page.waitForTimeout(80);
	await page.evaluate(() => {
		const overlays = document.querySelectorAll(
			'div[data-state="open"][data-aria-hidden="true"]',
		);
		for (const overlay of overlays) {
			(overlay).remove();
		}
	});
}

async function collectLoopMetrics({ page }) {
	return await page.evaluate(() => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		const monitorState = globalThis.__opencut_audio_stress_monitor__?.monitor;
		if (!editor || !monitorState) {
			return { ok: false, error: "Monitor missing during loop metrics collection" };
		}

		const now = performance.now();
		const pausedWindowStart = now - 280;
		const pausedOutput = monitorState.output.filter((entry) => entry.t >= pausedWindowStart);
		const pausedSchedule = monitorState.schedule.filter(
			(entry) => entry.t >= pausedWindowStart && !entry.isPlaying,
		);
		const playWindowStart = now - 620;
		const playOutput = monitorState.output.filter(
			(entry) => entry.t >= playWindowStart && entry.isPlaying,
		);

		const maxPeakWhilePaused = pausedOutput.reduce(
			(max, entry) => Math.max(max, entry.peak),
			0,
		);
		const maxPeakWhilePlaying = playOutput.reduce(
			(max, entry) => Math.max(max, entry.peak),
			0,
		);
		const graphDirtyNow = editor.audio.getAudioGraphState().isDirty;

		return {
			ok: true,
			isPlayingAfterPause: editor.playback.getIsPlaying(),
			maxPeakWhilePaused,
			maxPeakWhilePlaying,
			pausedScheduleCount: pausedSchedule.length,
			graphDirtyNow,
		};
	});
}

async function collectSummary({ page }) {
	return await page.evaluate(() => {
		const monitorState = globalThis.__opencut_audio_stress_monitor__?.monitor;
		if (!monitorState) {
			return { ok: false, error: "Monitor missing during summary collection" };
		}
		const maxPausedPeak = monitorState.output
			.filter((entry) => !entry.isPlaying)
			.reduce((max, entry) => Math.max(max, entry.peak), 0);
		const maxPlayingPeak = monitorState.output
			.filter((entry) => entry.isPlaying)
			.reduce((max, entry) => Math.max(max, entry.peak), 0);
		const scheduleWhilePaused = monitorState.schedule.filter(
			(entry) => !entry.isPlaying,
		).length;

		return {
			ok: true,
			outputEvents: monitorState.output.length,
			scheduleEvents: monitorState.schedule.length,
			graphEvents: monitorState.graph.length,
			playbackEvents: monitorState.playback.length,
			maxPausedPeak,
			maxPlayingPeak,
			scheduleWhilePaused,
		};
	});
}

async function cleanupFixture({ page, fixture }) {
	await page.evaluate(async ({ fixture: innerFixture }) => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		if (!editor) return;
		const monitorState = globalThis.__opencut_audio_stress_monitor__;
		if (monitorState?.cleanup) {
			try {
				monitorState.cleanup();
			} catch {}
		}
		globalThis.__opencut_audio_stress_monitor__ = null;

		editor.playback.pause();
		editor.playback.seek({ time: 0 });

		const tracks = editor.timeline.getTracks();
		const location = tracks
			.flatMap((track) => track.elements.map((element) => ({ track, element })))
			.find(({ element }) => element.id === innerFixture.elementId);
		if (location) {
			editor.timeline.deleteElements({
				elements: [
					{ trackId: location.track.id, elementId: location.element.id },
				],
			});
		}

		try {
			await editor.media.removeMediaAsset({
				projectId: innerFixture.projectId,
				id: innerFixture.assetId,
			});
		} catch {}
	}, { fixture });
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
	const initialPage = context.pages()[0] ?? (await context.newPage());
	const page = await ensureEditorPage({ context, page: initialPage });
	console.log(`Using launcher: ${launcher}`);
	console.log(`Using profile: ${profileDir}`);

	await page.waitForFunction(() => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		return Boolean(editor?.timeline?.getTracks && editor?.playback?.play);
	}, { timeout: 30_000 });
	await page.waitForSelector('section[aria-label="Timeline"]', { timeout: 30_000 });

	const fixture = await setupStressFixture({ page });
	assert(fixture?.ok, fixture?.error ?? "Failed to setup stress fixture");
	await dismissBlockingOverlays({ page });

	const elementLocator = page.locator(
		`[data-timeline-element-id="${fixture.elementId}"]`,
	);
	await elementLocator.first().waitFor({ state: "visible", timeout: 30_000 });

	const loopFindings = [];
	for (let loopIndex = 0; loopIndex < loopCount; loopIndex++) {
		await dismissBlockingOverlays({ page });
		await page.click('section[aria-label="Timeline"]', {
			position: { x: 220, y: 120 },
			force: true,
		});
		await page.keyboard.press("Space");
		await page.waitForTimeout(220);

		const box = await elementLocator.first().boundingBox();
		assert(box, `Timeline element bounding box missing at loop ${loopIndex}`);
		const startX = box.x + box.width * 0.5;
		const startY = box.y + box.height * 0.5;
		const playDragDelta = loopIndex % 2 === 0 ? 120 : -90;
		await page.mouse.move(startX, startY);
		await page.mouse.down();
		await page.mouse.move(startX + playDragDelta, startY, { steps: 12 });
		await page.mouse.up();

		await page.waitForTimeout(120);
		await page.keyboard.press("Space");
		await page.waitForTimeout(360);

		const boxPaused = await elementLocator.first().boundingBox();
		assert(
			boxPaused,
			`Timeline element bounding box missing in paused drag at loop ${loopIndex}`,
		);
		const pausedX = boxPaused.x + boxPaused.width * 0.5;
		const pausedY = boxPaused.y + boxPaused.height * 0.5;
		const pausedDragDelta = loopIndex % 2 === 0 ? -60 : 70;
		await page.mouse.move(pausedX, pausedY);
		await page.mouse.down();
		await page.mouse.move(pausedX + pausedDragDelta, pausedY, { steps: 10 });
		await page.mouse.up();
		await page.waitForTimeout(120);

		const loopMetrics = await collectLoopMetrics({ page });
		assert(loopMetrics?.ok, loopMetrics?.error ?? "Failed to collect loop metrics");
		loopFindings.push({
			loop: loopIndex + 1,
			...loopMetrics,
		});
	}

	const summary = await collectSummary({ page });
	assert(summary?.ok, summary?.error ?? "Failed to collect stress summary");

	const badLoops = loopFindings.filter(
		(loop) =>
			loop.isPlayingAfterPause ||
			loop.maxPeakWhilePaused > 0.03 ||
			loop.pausedScheduleCount > 1,
	);

	await cleanupFixture({ page, fixture });
	await context.close();

	assert(
		badLoops.length === 0,
		[
			`Detected ${badLoops.length} failing stress loops`,
			JSON.stringify(
				badLoops.map((loop) => ({
					loop: loop.loop,
					isPlayingAfterPause: loop.isPlayingAfterPause,
					maxPeakWhilePaused: Number(loop.maxPeakWhilePaused.toFixed(4)),
					pausedScheduleCount: loop.pausedScheduleCount,
				})),
				null,
				2,
			),
		].join("\n"),
	);

	console.log(
		"PASS: audio playback UI stress",
		{
			loops: loopCount,
			maxPausedPeak: Number(summary.maxPausedPeak.toFixed(4)),
			maxPlayingPeak: Number(summary.maxPlayingPeak.toFixed(4)),
			scheduleWhilePaused: summary.scheduleWhilePaused,
			outputEvents: summary.outputEvents,
			scheduleEvents: summary.scheduleEvents,
			graphEvents: summary.graphEvents,
		},
	);
}

main().catch((error) => {
	console.error(`FAIL: ${error.message}`);
	process.exit(1);
});
