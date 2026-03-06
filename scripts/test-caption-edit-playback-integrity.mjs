#!/usr/bin/env node

const profileDir = process.env.PLAYWRIGHT_PROFILE_DIR ?? "C:\\playwright-shared-profile";
const editorUrl = process.env.PLAYWRIGHT_EDITOR_URL?.trim() ?? "";
const preferHeadless =
	process.env.PLAYWRIGHT_HEADLESS === "1" ||
	process.env.PLAYWRIGHT_HEADLESS === "true";

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
	const existingEditorPage = context
		.pages()
		.find((candidate) => candidate.url().includes("/editor/"));
	const page = existingEditorPage ?? context.pages()[0] ?? (await context.newPage());
	console.log(`Using launcher: ${launcher}`);
	console.log(`Using profile: ${profileDir}`);
	if (editorUrl.length > 0) {
		console.log(`Opening: ${editorUrl}`);
		await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
	} else if (!page.url().includes("/editor/")) {
		throw new Error(
			"No editor tab found in shared profile. Open your target editor project first or set PLAYWRIGHT_EDITOR_URL.",
		);
	} else {
		console.log(`Reusing editor tab: ${page.url()}`);
	}

	await page.waitForFunction(() => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		if (!editor?.timeline?.getTracks) return false;
		const tracks = editor.timeline.getTracks();
		return tracks.length > 0;
	}, { timeout: 30_000 });

	const result = await page.evaluate(async () => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		if (!editor) {
			return { ok: false, error: "Editor singleton not found" };
		}
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		const resolvePair = () => {
			const tracks = editor.timeline.getTracks();
			for (const track of tracks) {
				for (const element of track.elements) {
					if (element.type !== "video" && element.type !== "audio") continue;

					const captionTrack = tracks.find((candidate) =>
						candidate.type === "text" &&
						candidate.elements.some(
							(caption) =>
								caption.type === "text" &&
								caption.captionSourceRef?.mediaElementId === element.id,
						),
					);
					if (!captionTrack || captionTrack.type !== "text") continue;
					const caption = captionTrack.elements.find(
						(candidate) =>
							candidate.type === "text" &&
							candidate.captionSourceRef?.mediaElementId === element.id,
					);
					if (!caption) continue;
					return {
						mediaTrackId: track.id,
						mediaElementId: element.id,
						captionElementId: caption.id,
					};
				}
			}
			return null;
		};

		const pair = resolvePair();
		if (!pair) {
			return { ok: false, error: "No transcript-linked media/caption pair found" };
		}

		const scheduleEventTimes = [];
		const outputEvents = [];
		const onSchedule = () => {
			scheduleEventTimes.push(performance.now());
		};
		const onOutput = (event) => {
			const detail = event.detail ?? {};
			outputEvents.push({
				t: performance.now(),
				peak: Number(detail.peak ?? 0),
				isPlaying: Boolean(detail.isPlaying),
			});
		};
		window.addEventListener("opencut:audio-schedule-level", onSchedule);
		window.addEventListener("opencut:audio-output-level", onOutput);

		const readState = () => {
			const tracks = editor.timeline.getTracks();
			const media = tracks
				.flatMap((track) => track.elements)
				.find((element) => element.id === pair.mediaElementId);
			const caption = tracks
				.filter((track) => track.type === "text")
				.flatMap((track) => track.elements)
				.find((element) => element.id === pair.captionElementId);
			return { media, caption };
		};

		const assertLinked = ({ stage }) => {
			const { media, caption } = readState();
			if (!media) throw new Error(`${stage}: media missing`);
			if (!caption) throw new Error(`${stage}: caption missing`);
			if (caption.type !== "text") throw new Error(`${stage}: caption not text`);
			if (Math.abs(caption.startTime - media.startTime) > 0.0001) {
				throw new Error(
					`${stage}: caption start drift ${caption.startTime} vs ${media.startTime}`,
				);
			}
			if (Math.abs(caption.duration - media.duration) > 0.0001) {
				throw new Error(
					`${stage}: caption duration drift ${caption.duration} vs ${media.duration}`,
				);
			}
			const mediaStart = media.startTime;
			const mediaEnd = media.startTime + media.duration;
			for (const [index, timing] of (caption.captionWordTimings ?? []).entries()) {
				if (timing.startTime > mediaEnd + 0.03) {
					throw new Error(`${stage}: timing ${index} starts after media end`);
				}
				if (timing.endTime < mediaStart - 0.03) {
					throw new Error(`${stage}: timing ${index} ends before media start`);
				}
			}
		};

		const initial = readState();
		if (!initial.media || !initial.caption) {
			return { ok: false, error: "Initial media/caption missing" };
		}
		const baseStart = initial.media.startTime;
		const baseDuration = initial.media.duration;
		const baseTrimStart = initial.media.trimStart;
		const baseTrimEnd = initial.media.trimEnd;
		const moveDelta = Math.min(0.6, Math.max(0.2, baseDuration * 0.2));
		const trimDelta = Math.min(0.35, Math.max(0.1, baseDuration * 0.12));

		editor.playback.play();
		await sleep(350);

		for (let i = 0; i < 3; i++) {
			const targetStart = baseStart + (i % 2 === 0 ? moveDelta : 0);
			editor.timeline.updateElementStartTime({
				elements: [{ trackId: pair.mediaTrackId, elementId: pair.mediaElementId }],
				startTime: targetStart,
			});
			await sleep(160);
			assertLinked({ stage: `move-${i}` });

			editor.timeline.updateElementTrim({
				elementId: pair.mediaElementId,
				trimStart: baseTrimStart + trimDelta,
				trimEnd: baseTrimEnd,
				startTime: targetStart + trimDelta,
				duration: Math.max(0.2, baseDuration - trimDelta),
			});
			await sleep(180);
			assertLinked({ stage: `trim-${i}` });

			editor.timeline.updateElementTrim({
				elementId: pair.mediaElementId,
				trimStart: baseTrimStart,
				trimEnd: baseTrimEnd,
				startTime: targetStart,
				duration: baseDuration,
			});
			await sleep(180);
			assertLinked({ stage: `restore-${i}` });
		}

		const beforePause = performance.now();
		editor.playback.pause();
		await sleep(650);

		const scheduleAfterPause = scheduleEventTimes.filter((t) => t > beforePause + 80).length;
		const outputAfterPause = outputEvents.filter((entry) => entry.t > beforePause + 120);
		const maxPeakAfterPause = outputAfterPause.reduce(
			(max, entry) => Math.max(max, entry.peak),
			0,
		);

		window.removeEventListener("opencut:audio-schedule-level", onSchedule);
		window.removeEventListener("opencut:audio-output-level", onOutput);

		const finalState = readState();
		if (!finalState.media || !finalState.caption) {
			return { ok: false, error: "Final media/caption missing" };
		}
		if (editor.playback.getIsPlaying()) {
			return { ok: false, error: "Playback still active after pause" };
		}
		if (maxPeakAfterPause > 0.02) {
			return {
				ok: false,
				error: `Audio not silent enough after pause (peak=${maxPeakAfterPause.toFixed(4)})`,
			};
		}
		if (scheduleAfterPause > 1) {
			return {
				ok: false,
				error: `Unexpected audio schedule activity after pause (${scheduleAfterPause})`,
			};
		}

		return {
			ok: true,
			metrics: {
				scheduleAfterPause,
				maxPeakAfterPause,
				outputEventsCaptured: outputEvents.length,
			},
		};
	});

	assert(result?.ok, result?.error ?? "Unknown test failure");
	console.log("PASS: caption/media linkage and playback integrity", result.metrics ?? {});
	await context.close();
}

main().catch((error) => {
	console.error(`FAIL: ${error.message}`);
	process.exit(1);
});
