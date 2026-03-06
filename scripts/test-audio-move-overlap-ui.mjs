#!/usr/bin/env node

const profileDir = process.env.PLAYWRIGHT_PROFILE_DIR ?? "C:\\playwright-shared-profile";
const editorUrl = process.env.PLAYWRIGHT_EDITOR_URL?.trim() ?? "";
const preferHeadless =
	process.env.PLAYWRIGHT_HEADLESS === "1" ||
	process.env.PLAYWRIGHT_HEADLESS === "true";
const iterations = Math.max(4, Number(process.env.PLAYWRIGHT_MOVE_OVERLAP_ITERS ?? 14));

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

async function resolveEditorPage({ context, page }) {
	if (editorUrl.length > 0) {
		console.log(`Opening: ${editorUrl}`);
		await page.goto(editorUrl, {
			waitUntil: "domcontentloaded",
			timeout: 180_000,
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
	if (existingEditorPage) return existingEditorPage;

	throw new Error(
		"No editor tab found in shared profile. Open your target editor project first or set PLAYWRIGHT_EDITOR_URL.",
	);
}

async function dismissBlockingOverlays({ page }) {
	for (let index = 0; index < 3; index++) {
		await page.keyboard.press("Escape").catch(() => {});
		await page.waitForTimeout(80);
	}
	await page.evaluate(() => {
		const overlays = document.querySelectorAll(
			'div[data-state="open"][data-aria-hidden="true"]',
		);
		for (const overlay of overlays) {
			(overlay).remove();
		}
	});
}

async function setupFixture({ page }) {
	return await page.evaluate(async () => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		if (!editor) return { ok: false, error: "Editor singleton not found" };
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		await editor.project.createNewProject({
			name: `Move overlap ${new Date().toISOString()}`,
		});
		const activeProject = editor.project.getActive();
		const projectId = activeProject?.metadata?.id ?? activeProject?.id ?? null;
		if (!projectId) return { ok: false, error: "No active project id" };

		const sampleRate = 48_000;
		const duration = 7;
		const frameCount = Math.floor(sampleRate * duration);
		const pcm = new Float32Array(frameCount);
		// Simple stable tone for easy leak detection in timeline gaps.
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
		const write16 = (value) => {
			view.setUint16(offset, value, true);
			offset += 2;
		};
		const write32 = (value) => {
			view.setUint32(offset, value, true);
			offset += 4;
		};
		writeString("RIFF");
		write32(36 + dataSize);
		writeString("WAVE");
		writeString("fmt ");
		write32(16);
		write16(1);
		write16(1);
		write32(sampleRate);
		write32(byteRate);
		write16(blockAlign);
		write16(16);
		writeString("data");
		write32(dataSize);
		for (let index = 0; index < frameCount; index++) {
			const sample = Math.max(-1, Math.min(1, pcm[index]));
			view.setInt16(
				offset,
				sample < 0 ? sample * 0x8000 : sample * 0x7fff,
				true,
			);
			offset += 2;
		}

		const file = new File([wavBuffer], `move-overlap-${Date.now()}.wav`, {
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
		if (!asset) return { ok: false, error: "Failed to add fixture audio asset" };

		const beforeElementIds = new Set(
			editor.timeline.getTracks().flatMap((track) => track.elements).map((element) => element.id),
		);
		editor.timeline.insertElement({
			element: {
				type: "audio",
				sourceType: "upload",
				mediaId: asset.id,
				name: "Move overlap clip",
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
			return { ok: false, error: "Failed to insert fixture timeline element" };
		}

		editor.playback.pause();
		editor.playback.seek({ time: 0 });
		editor.timeline.updateElementStartTime({
			elements: [{ trackId, elementId }],
			startTime: 0,
		});

		const priorMonitor = globalThis.__opencut_move_overlap_monitor__;
		if (priorMonitor?.cleanup) {
			try {
				priorMonitor.cleanup();
			} catch {}
		}

		const monitor = {
			output: [],
			schedule: [],
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
				timelineSegmentStart: Number(detail.timelineSegmentStart ?? Number.NaN),
				timelineSegmentEnd: Number(detail.timelineSegmentEnd ?? Number.NaN),
				contextStart: Number(detail.contextStart ?? Number.NaN),
			});
		};
		window.addEventListener("opencut:audio-output-level", onOutput);
		window.addEventListener("opencut:audio-schedule-level", onSchedule);

		globalThis.__opencut_move_overlap_monitor__ = {
			monitor,
			cleanup: () => {
				window.removeEventListener("opencut:audio-output-level", onOutput);
				window.removeEventListener("opencut:audio-schedule-level", onSchedule);
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

async function getPlaybackState({ page, elementId }) {
	return await page.evaluate(({ elementId: innerElementId }) => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		if (!editor) {
			return { ok: false, error: "Editor singleton not found" };
		}
		const tracks = editor.timeline.getTracks();
		let startTime = null;
		for (const track of tracks) {
			const element = track.elements.find((candidate) => candidate.id === innerElementId);
			if (!element) continue;
			startTime = element.startTime;
			break;
		}
		if (startTime === null) {
			return { ok: false, error: "Fixture element not found" };
		}
		return {
			ok: true,
			perfNow: performance.now(),
			currentTime: editor.playback.getCurrentTime(),
			startTime,
			isPlaying: editor.playback.getIsPlaying(),
		};
	}, { elementId });
}

async function readMoveWindowMetrics({
	page,
	moveAtPerfMs,
	gapDurationMs,
	newStartTime,
}) {
	return await page.evaluate(
		({
			moveAtPerfMs: innerMoveAtPerfMs,
			gapDurationMs: innerGapDurationMs,
			newStartTime: innerNewStartTime,
		}) => {
			const monitor = globalThis.__opencut_move_overlap_monitor__?.monitor;
			if (!monitor) {
				return { ok: false, error: "Move overlap monitor missing" };
			}
			const gapWindowStart = innerMoveAtPerfMs + 100;
			const gapWindowEnd = gapWindowStart + innerGapDurationMs;
			const gapOutput = monitor.output.filter(
				(entry) =>
					entry.t >= gapWindowStart &&
					entry.t <= gapWindowEnd &&
					entry.isPlaying,
			);
			const maxGapPeak = gapOutput.reduce(
				(max, entry) => Math.max(max, entry.peak),
				0,
			);
			const gapTailStart = gapWindowStart + innerGapDurationMs * 0.55;
			const gapTailOutput = monitor.output.filter(
				(entry) =>
					entry.t >= gapTailStart &&
					entry.t <= gapWindowEnd &&
					entry.isPlaying,
			);
			const maxGapTailPeak = gapTailOutput.reduce(
				(max, entry) => Math.max(max, entry.peak),
				0,
			);

			const postMoveSchedule = monitor.schedule.filter(
				(entry) => entry.t >= innerMoveAtPerfMs + 80,
			);
			const staleScheduleCount = postMoveSchedule.filter(
				(entry) =>
					Number.isFinite(entry.timelineSegmentEnd) &&
					entry.timelineSegmentEnd < innerNewStartTime - 0.03,
			).length;
			const freshScheduleCount = postMoveSchedule.filter(
				(entry) =>
					Number.isFinite(entry.timelineSegmentStart) &&
					entry.timelineSegmentStart >= innerNewStartTime - 0.03,
			).length;

			return {
				ok: true,
				maxGapPeak,
				maxGapTailPeak,
				staleScheduleCount,
				freshScheduleCount,
				postMoveScheduleCount: postMoveSchedule.length,
			};
		},
		{ moveAtPerfMs, gapDurationMs, newStartTime },
	);
}

async function readResumePeak({ page }) {
	return await page.evaluate(() => {
		const monitor = globalThis.__opencut_move_overlap_monitor__?.monitor;
		if (!monitor) {
			return { ok: false, error: "Move overlap monitor missing" };
		}
		const now = performance.now();
		const windowStart = now - 400;
		const activeOutput = monitor.output.filter(
			(entry) => entry.t >= windowStart && entry.isPlaying,
		);
		const maxPeak = activeOutput.reduce((max, entry) => Math.max(max, entry.peak), 0);
		return {
			ok: true,
			maxPeak,
		};
	});
}

async function resetForIteration({ page, fixture }) {
	await page.evaluate(({ fixture: innerFixture }) => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		if (!editor) return;
		editor.playback.pause();
		editor.playback.seek({ time: 0 });
		editor.timeline.updateElementStartTime({
			elements: [{ trackId: innerFixture.trackId, elementId: innerFixture.elementId }],
			startTime: 0,
		});
	}, { fixture });
}

async function cleanupFixture({ page, fixture }) {
	await page.evaluate(async ({ fixture: innerFixture }) => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		if (!editor) return;
		editor.playback.pause();
		editor.playback.seek({ time: 0 });
		const monitorState = globalThis.__opencut_move_overlap_monitor__;
		if (monitorState?.cleanup) {
			try {
				monitorState.cleanup();
			} catch {}
		}
		globalThis.__opencut_move_overlap_monitor__ = null;

		const tracks = editor.timeline.getTracks();
		const location = tracks
			.flatMap((track) => track.elements.map((element) => ({ track, element })))
			.find(({ element }) => element.id === innerFixture.elementId);
		if (location) {
			editor.timeline.deleteElements({
				elements: [{ trackId: location.track.id, elementId: location.element.id }],
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
	const page = await resolveEditorPage({ context, page: initialPage });
	console.log(`Using launcher: ${launcher}`);
	console.log(`Using profile: ${profileDir}`);

	await page.waitForFunction(() => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		return Boolean(editor?.timeline?.getTracks && editor?.playback?.play);
	}, { timeout: 30_000 });
	await page.waitForSelector('section[aria-label="Timeline"]', { timeout: 30_000 });

	const fixture = await setupFixture({ page });
	assert(fixture?.ok, fixture?.error ?? "Failed to setup move-overlap fixture");
	await dismissBlockingOverlays({ page });

	const findings = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		await resetForIteration({ page, fixture });
		await dismissBlockingOverlays({ page });

		await page.evaluate(() => {
			const editor = globalThis.__opencut_editor_core_singleton__;
			editor?.playback.play();
		});
		await page.waitForTimeout(180);

		const preMoveState = await getPlaybackState({
			page,
			elementId: fixture.elementId,
		});
		assert(preMoveState?.ok, preMoveState?.error ?? "Failed reading pre-move state");
		assert(preMoveState.isPlaying, `Iteration ${iteration + 1}: playback did not start`);

		const postMoveState = await page.evaluate(
			({ fixture: innerFixture, iteration: innerIteration }) => {
				const editor = globalThis.__opencut_editor_core_singleton__;
				if (!editor) {
					return { ok: false, error: "Editor singleton missing while moving clip" };
				}
				const currentTime = editor.playback.getCurrentTime();
				const targetStart = currentTime + 1.7 + (innerIteration % 3) * 0.25;
				editor.timeline.updateElementStartTime({
					elements: [
						{
							trackId: innerFixture.trackId,
							elementId: innerFixture.elementId,
						},
					],
					startTime: targetStart,
				});
				const tracks = editor.timeline.getTracks();
				let startTime = null;
				for (const track of tracks) {
					const element = track.elements.find(
						(candidate) => candidate.id === innerFixture.elementId,
					);
					if (!element) continue;
					startTime = element.startTime;
					break;
				}
				if (startTime === null) {
					return { ok: false, error: "Moved fixture element not found" };
				}
				return {
					ok: true,
					perfNow: performance.now(),
					currentTime: editor.playback.getCurrentTime(),
					startTime,
				};
			},
			{ fixture, iteration },
		);
		assert(postMoveState?.ok, postMoveState?.error ?? "Failed moving clip during playback");

		const gapSeconds = Math.max(0, postMoveState.startTime - postMoveState.currentTime);
		const gapDurationMs = Math.max(280, Math.min(2200, Math.floor((gapSeconds - 0.14) * 1000)));
		await page.waitForTimeout(gapDurationMs);

		const gapMetrics = await readMoveWindowMetrics({
			page,
			moveAtPerfMs: postMoveState.perfNow,
			gapDurationMs,
			newStartTime: postMoveState.startTime,
		});
		assert(gapMetrics?.ok, gapMetrics?.error ?? "Failed reading gap metrics");

		await page.waitForTimeout(420);
		const resumePeak = await readResumePeak({ page });
		assert(resumePeak?.ok, resumePeak?.error ?? "Failed reading resume peak");

		await page.evaluate(() => {
			const editor = globalThis.__opencut_editor_core_singleton__;
			editor?.playback.pause();
		});
		await page.waitForTimeout(120);

		findings.push({
			iteration: iteration + 1,
			gapSeconds: Number(gapSeconds.toFixed(3)),
			maxGapPeak: Number(gapMetrics.maxGapPeak.toFixed(4)),
			maxGapTailPeak: Number(gapMetrics.maxGapTailPeak.toFixed(4)),
			resumePeak: Number(resumePeak.maxPeak.toFixed(4)),
			staleScheduleCount: gapMetrics.staleScheduleCount,
			freshScheduleCount: gapMetrics.freshScheduleCount,
		});
	}

	await cleanupFixture({ page, fixture });
	await context.close();

	const failures = findings.filter(
		(item) =>
			item.staleScheduleCount > 0 ||
			(item.staleScheduleCount > 0 && item.freshScheduleCount > 0),
	);
	assert(
		failures.length === 0,
		[
			`Detected ${failures.length} move-overlap failures`,
			JSON.stringify(failures, null, 2),
		].join("\n"),
	);

	console.log("PASS: audio move overlap playback", {
		iterations,
		maxGapPeak: Number(Math.max(...findings.map((item) => item.maxGapPeak)).toFixed(4)),
		maxGapTailPeak: Number(
			Math.max(...findings.map((item) => item.maxGapTailPeak)).toFixed(4),
		),
		minResumePeak: Number(Math.min(...findings.map((item) => item.resumePeak)).toFixed(4)),
		maxStaleScheduleCount: Math.max(
			...findings.map((item) => item.staleScheduleCount),
		),
	});
}

main().catch((error) => {
	console.error(`FAIL: ${error.message}`);
	process.exit(1);
});
