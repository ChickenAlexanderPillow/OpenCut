import { config as loadEnv } from "dotenv";
import { resolve, join } from "node:path";
import { mkdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildClipCandidatesFromTranscript } from "@/lib/clips/candidate-builder";
import {
	mergeScoredCandidates,
	selectTopCandidatesWithQualityGate,
} from "@/lib/clips/scoring";
import { OpenAIViralityScoringProvider } from "@/lib/clips/providers/openai-provider";

const execFileAsync = promisify(execFile);
const OPENAI_AUDIO_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const CHUNK_SECONDS = 60;

loadEnv({ path: resolve(process.cwd(), ".env.local"), override: false });
loadEnv({ path: resolve(process.cwd(), ".env"), override: false });

async function getMediaDurationSeconds({ filePath }: { filePath: string }): Promise<number> {
	const { stdout } = await execFileAsync("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"json",
		filePath,
	]);
	const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
	const duration = Number(parsed.format?.duration ?? "0");
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Error("Failed to probe media duration");
	}
	return duration;
}

async function extractAudioChunk({
	inputPath,
	chunkPath,
	startSeconds,
	durationSeconds,
}: {
	inputPath: string;
	chunkPath: string;
	startSeconds: number;
	durationSeconds: number;
}): Promise<void> {
	await execFileAsync("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-ss",
		startSeconds.toFixed(3),
		"-t",
		durationSeconds.toFixed(3),
		"-i",
		inputPath,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"16000",
		"-c:a",
		"pcm_s16le",
		chunkPath,
	]);
}

function parseTranscriptionSegments(payload: unknown): Array<{
	text: string;
	start: number;
	end: number;
}> {
	if (typeof payload !== "object" || payload === null) return [];
	const maybeSegments = (payload as { segments?: unknown }).segments;
	if (!Array.isArray(maybeSegments)) return [];
	return maybeSegments
		.map((segment) => {
			if (typeof segment !== "object" || segment === null) return null;
			const item = segment as { text?: unknown; start?: unknown; end?: unknown };
			if (
				typeof item.text !== "string" ||
				typeof item.start !== "number" ||
				typeof item.end !== "number"
			) {
				return null;
			}
			return {
				text: item.text,
				start: item.start,
				end: item.end,
			};
		})
		.filter((segment): segment is NonNullable<typeof segment> => segment !== null)
		.filter((segment) => segment.end > segment.start);
}

async function transcribeChunkWithOpenAI({
	apiKey,
	chunkPath,
	chunkIndex,
}: {
	apiKey: string;
	chunkPath: string;
	chunkIndex: number;
}): Promise<{ text: string; segments: Array<{ text: string; start: number; end: number }> }> {
	const chunkBytes = await readFile(chunkPath);
	const chunkFile = new File([chunkBytes], `aga-chunk-${chunkIndex + 1}.wav`, {
		type: "audio/wav",
	});

	const formData = new FormData();
	formData.append("model", "whisper-1");
	formData.append("response_format", "verbose_json");
	formData.append("file", chunkFile, chunkFile.name);

	const response = await fetch(OPENAI_AUDIO_TRANSCRIBE_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: formData,
	});
	if (!response.ok) {
		throw new Error(
			`OpenAI transcription failed on chunk ${chunkIndex + 1} (${response.status}): ${await response.text()}`,
		);
	}
	const payload = (await response.json()) as unknown;
	const text =
		typeof (payload as { text?: unknown }).text === "string"
			? ((payload as { text: string }).text ?? "")
			: "";
	const segments = parseTranscriptionSegments(payload);
	return { text, segments };
}

async function main() {
	const mediaPathArg = process.argv[2];
	if (!mediaPathArg) {
		throw new Error("Usage: bun run test:clips:aga -- \"C:\\path\\to\\video.mp4\"");
	}
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error("OPENAI_API_KEY is missing");
	}

	const filePath = resolve(mediaPathArg);
	const fileStat = await stat(filePath);
	const duration = await getMediaDurationSeconds({ filePath });
	const chunkCount = Math.max(1, Math.ceil(duration / CHUNK_SECONDS));
	const tempDir = join(tmpdir(), "opencut-aga-e2e-chunks");
	await mkdir(tempDir, { recursive: true });

	console.log(`Testing clip pipeline on: ${filePath}`);
	console.log(`File size: ${(fileStat.size / (1024 * 1024 * 1024)).toFixed(2)} GB`);
	console.log(`Media duration: ${duration.toFixed(2)}s`);
	console.log(`Transcribing in ${chunkCount} chunk(s) of ${CHUNK_SECONDS}s`);

	const mergedSegments: Array<{ text: string; start: number; end: number }> = [];
	const mergedTextParts: string[] = [];

	try {
		for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
			const start = chunkIndex * CHUNK_SECONDS;
			const end = Math.min(duration, start + CHUNK_SECONDS);
			const chunkDuration = Math.max(0.1, end - start);
			const chunkPath = join(tempDir, `aga-chunk-${chunkIndex + 1}.wav`);

			console.log(
				`Chunk ${chunkIndex + 1}/${chunkCount}: ${start.toFixed(1)}s-${end.toFixed(1)}s`,
			);
			await extractAudioChunk({
				inputPath: filePath,
				chunkPath,
				startSeconds: start,
				durationSeconds: chunkDuration,
			});

			const transcription = await transcribeChunkWithOpenAI({
				apiKey,
				chunkPath,
				chunkIndex,
			});
			await unlink(chunkPath).catch(() => undefined);

			const adjustedSegments = transcription.segments
				.map((segment) => ({
					text: segment.text,
					start: segment.start + start,
					end: segment.end + start,
				}))
				.filter((segment) => segment.end > segment.start);
			mergedSegments.push(...adjustedSegments);
			if (transcription.text.trim()) {
				mergedTextParts.push(transcription.text.trim());
			}
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}

	if (mergedSegments.length === 0) {
		throw new Error("No transcript segments extracted from AGA media");
	}

	const transcriptSegments = mergedSegments.sort((a, b) => a.start - b.start);
	const transcriptText = mergedTextParts.join(" ").trim();
	console.log(`Transcript ready: ${transcriptSegments.length} segments`);

	const drafts = buildClipCandidatesFromTranscript({
		segments: transcriptSegments,
		mediaDuration: duration,
	});
	if (drafts.length === 0) {
		throw new Error("No clip candidate drafts generated");
	}
	console.log(`Candidate drafts: ${drafts.length}`);

	const scorer = new OpenAIViralityScoringProvider({
		apiKey,
		model: "gpt-5-mini",
	});
	const scoredText = await scorer.scoreCandidates({
		transcript: transcriptText,
		candidates: drafts,
	});
	const merged = mergeScoredCandidates({
		drafts,
		scoredText,
	});
	const selected = selectTopCandidatesWithQualityGate({
		candidates: merged,
		minScore: 60,
		maxCount: 5,
	});
	if (selected.length === 0) {
		throw new Error("No clips passed quality gate");
	}

	console.log(`SUCCESS: ${selected.length} clips selected`);
	for (const [index, clip] of selected.entries()) {
		console.log(
			`#${index + 1} ${clip.startTime}-${clip.endTime}s score=${clip.scoreOverall} ${clip.title}`,
		);
	}
}

main().catch((error) => {
	console.error("AGA clip E2E failed:", error);
	process.exit(1);
});
