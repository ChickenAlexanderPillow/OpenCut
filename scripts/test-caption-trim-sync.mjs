#!/usr/bin/env node

const profileDir = process.env.PLAYWRIGHT_PROFILE_DIR ?? "C:\\playwright-shared-profile";
const editorUrl = process.env.PLAYWRIGHT_EDITOR_URL?.trim() ?? "";
const preferHeadless =
	process.env.PLAYWRIGHT_HEADLESS === "1" ||
	process.env.PLAYWRIGHT_HEADLESS === "true";

function approxEqual(a, b, epsilon = 0.03) {
	return Math.abs(a - b) <= epsilon;
}

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
		return Boolean(editor?.timeline?.getTracks);
	});
	await page.waitForFunction(() => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		if (!editor) return false;
		try {
			const active = editor.project.getActive();
			const tracks = editor.timeline.getTracks();
			const hasProjectId = Boolean(active?.metadata?.id);
			return hasProjectId && tracks.length > 0;
		} catch {
			return false;
		}
	}, { timeout: 30_000 }).catch(() => {
		// Fall through to diagnostics below.
	});

	const initial = await page.evaluate(() => {
		const editor = globalThis.__opencut_editor_core_singleton__;
		if (!editor) return { error: "Editor singleton not found" };
		const tracks = editor.timeline.getTracks();
		const activeProject = (() => {
			try {
				return editor.project.getActive();
			} catch {
				return null;
			}
		})();
		const mediaWithTranscript = tracks.flatMap((track) =>
			track.elements.filter(
				(element) =>
					(element.type === "video" || element.type === "audio") &&
					(element.transcriptEdit?.words?.length ?? 0) > 0,
			),
		);
		const linkedCaptions = tracks
			.filter((track) => track.type === "text")
			.flatMap((track) => track.elements)
			.filter(
				(element) =>
					element.type === "text" &&
					(element.captionWordTimings?.length ?? 0) > 0 &&
					Boolean(element.captionSourceRef?.mediaElementId),
			);
		const mediaRecords = tracks.flatMap((track) =>
			track.elements
				.filter(
					(element) =>
						(element.type === "video" || element.type === "audio") &&
						(element.transcriptEdit?.words?.length ?? 0) > 0,
				)
				.map((element) => ({
					trackId: track.id,
					element,
				})),
		);
		for (const media of mediaRecords) {
			const linkedCaption = tracks
				.filter((track) => track.type === "text")
				.flatMap((track) => track.elements)
				.find(
					(element) =>
						element.type === "text" &&
						element.captionSourceRef?.mediaElementId === media.element.id &&
						(element.captionWordTimings?.length ?? 0) > 0,
				);
			if (!linkedCaption) continue;
			return {
				debug: {
					url: location.href,
					projectId: activeProject?.metadata?.id ?? null,
					trackCount: tracks.length,
					mediaWithTranscriptCount: mediaWithTranscript.length,
					linkedCaptionCount: linkedCaptions.length,
				},
				mediaElementId: media.element.id,
				captionElementId: linkedCaption.id,
				media: {
					startTime: media.element.startTime,
					duration: media.element.duration,
					trimStart: media.element.trimStart,
					trimEnd: media.element.trimEnd,
				},
				caption: {
					content: linkedCaption.content,
					startTime: linkedCaption.startTime,
					duration: linkedCaption.duration,
					wordTimings: linkedCaption.captionWordTimings ?? [],
				},
			};
		}
		return {
			error: "No media+linked-caption pair with transcript found",
			debug: {
				url: location.href,
				projectId: activeProject?.metadata?.id ?? null,
				trackCount: tracks.length,
				mediaWithTranscriptCount: mediaWithTranscript.length,
				linkedCaptionCount: linkedCaptions.length,
			},
		};
	});

	if (initial.error) {
		const debug = initial.debug
			? ` url=${initial.debug.url}, projectId=${initial.debug.projectId}, tracks=${initial.debug.trackCount}, mediaWithTranscript=${initial.debug.mediaWithTranscriptCount}, linkedCaptions=${initial.debug.linkedCaptionCount}`
			: "";
		throw new Error(`${initial.error}.${debug}`);
	}

	const trimDelta = Math.min(0.8, Math.max(0.2, initial.media.duration * 0.2));

	const mutateAndRead = async ({
		trimStart,
		trimEnd,
		startTime,
		duration,
	}) => {
		await page.evaluate(
			({ mediaElementId, trimStart, trimEnd, startTime, duration }) => {
				const editor = globalThis.__opencut_editor_core_singleton__;
				editor.timeline.updateElementTrim({
					elementId: mediaElementId,
					trimStart,
					trimEnd,
					startTime,
					duration,
				});
			},
			{
				mediaElementId: initial.mediaElementId,
				trimStart,
				trimEnd,
				startTime,
				duration,
			},
		);
		await page.waitForTimeout(120);
		return page.evaluate(({ mediaElementId, captionElementId }) => {
			const editor = globalThis.__opencut_editor_core_singleton__;
			const tracks = editor.timeline.getTracks();
			const media = tracks
				.flatMap((track) => track.elements)
				.find((element) => element.id === mediaElementId);
			const caption = tracks
				.filter((track) => track.type === "text")
				.flatMap((track) => track.elements)
				.find((element) => element.id === captionElementId);
			return {
				media: media
					? {
							startTime: media.startTime,
							duration: media.duration,
							trimStart: media.trimStart,
							trimEnd: media.trimEnd,
						}
					: null,
				caption: caption
					? {
							content: caption.content,
							startTime: caption.startTime,
							duration: caption.duration,
							wordTimings: caption.captionWordTimings ?? [],
						}
					: null,
			};
		}, {
			mediaElementId: initial.mediaElementId,
			captionElementId: initial.captionElementId,
		});
	};

	const trimmed = await mutateAndRead({
		trimStart: initial.media.trimStart + trimDelta,
		trimEnd: initial.media.trimEnd,
		startTime: initial.media.startTime + trimDelta,
		duration: initial.media.duration - trimDelta,
	});

	const untrimmed = await mutateAndRead({
		trimStart: initial.media.trimStart,
		trimEnd: initial.media.trimEnd,
		startTime: initial.media.startTime,
		duration: initial.media.duration,
	});

	const retrimmed = await mutateAndRead({
		trimStart: initial.media.trimStart + trimDelta,
		trimEnd: initial.media.trimEnd,
		startTime: initial.media.startTime + trimDelta,
		duration: initial.media.duration - trimDelta,
	});

	assert(trimmed.caption, "Caption missing after trim.");
	assert(untrimmed.caption, "Caption missing after untrim.");
	assert(retrimmed.caption, "Caption missing after second trim.");
	assert(untrimmed.media, "Media missing after untrim.");
	assert(retrimmed.media, "Media missing after second trim.");

	const baselineTimings = initial.caption.wordTimings;
	const restoredTimings = untrimmed.caption.wordTimings;

	assert(
		baselineTimings.length === restoredTimings.length,
		`Word timing count mismatch after untrim (${baselineTimings.length} vs ${restoredTimings.length}).`,
	);

	for (let i = 0; i < baselineTimings.length; i++) {
		const before = baselineTimings[i];
		const after = restoredTimings[i];
		assert(Boolean(before) && Boolean(after), `Missing timing at index ${i}.`);
		assert(before.word === after.word, `Word mismatch at index ${i}.`);
		assert(
			approxEqual(before.startTime, after.startTime),
			`Start time drift at ${i}: ${before.startTime} vs ${after.startTime}`,
		);
		assert(
			approxEqual(before.endTime, after.endTime),
			`End time drift at ${i}: ${before.endTime} vs ${after.endTime}`,
		);
	}

	const retrimWindowStart = retrimmed.media.startTime;
	const retrimWindowEnd = retrimmed.media.startTime + retrimmed.media.duration;
	for (const [index, timing] of retrimmed.caption.wordTimings.entries()) {
		assert(
			timing.endTime >= retrimWindowStart - 0.03,
			`Retrim timing ${index} ends before media window start.`,
		);
		assert(
			timing.startTime <= retrimWindowEnd + 0.03,
			`Retrim timing ${index} starts after media window end.`,
		);
	}

	console.log("PASS: Caption timings stayed in sync across trim -> untrim -> trim.");
	await context.close();
}

main().catch((error) => {
	console.error(`FAIL: ${error.message}`);
	process.exit(1);
});
