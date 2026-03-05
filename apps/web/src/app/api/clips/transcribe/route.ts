import { webEnv } from "@opencut/env/web";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

const OPENAI_TRANSCRIPTIONS_URL =
	"https://api.openai.com/v1/audio/transcriptions";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_WORDS = 20000;
const CLIP_TRANSCRIPTION_CACHE_TTL_MS = 15 * 60 * 1000;
const CLIP_TRANSCRIPTION_CACHE_MAX_ENTRIES = 500;
let rateLimitUnavailableLogged = false;

type ClipTranscriptionSuccessPayload = {
	segments: Array<{ text: string; start: number; end: number }>;
	granularity: "word";
	engine: string;
	model: string;
	timingsMs?: Record<string, number>;
	audioDurationSeconds?: number;
	wordCount?: number;
};

const clipTranscriptionResultCache = new Map<
	string,
	{
		value: ClipTranscriptionSuccessPayload;
		expiresAt: number;
	}
>();
const clipTranscriptionInFlight = new Map<
	string,
	Promise<ClipTranscriptionSuccessPayload>
>();

const localResponseSchema = z.object({
	text: z.string().optional(),
	language: z.string().optional(),
	model: z.string().min(1),
	engine: z.literal("whisperx").or(z.literal("local-whisperx")).optional(),
	timings_ms: z.record(z.string(), z.number().finite().nonnegative()).optional(),
	audio_duration_seconds: z.number().finite().nonnegative().optional(),
	word_count: z.number().int().nonnegative().optional(),
	words: z
		.array(
			z.object({
				word: z.string().min(1),
				start: z.number().finite().nonnegative(),
				end: z.number().finite().nonnegative(),
			}),
		)
		.min(1)
		.max(MAX_WORDS),
});

class LocalTranscriptionValidationError extends Error {}
class LocalTranscriptionUnavailableError extends Error {}

function getCachedClipTranscription({
	cacheKey,
}: {
	cacheKey: string;
}): ClipTranscriptionSuccessPayload | null {
	const cached = clipTranscriptionResultCache.get(cacheKey);
	if (!cached) return null;
	if (Date.now() >= cached.expiresAt) {
		clipTranscriptionResultCache.delete(cacheKey);
		return null;
	}
	clipTranscriptionResultCache.delete(cacheKey);
	clipTranscriptionResultCache.set(cacheKey, cached);
	return cached.value;
}

function setCachedClipTranscription({
	cacheKey,
	value,
}: {
	cacheKey: string;
	value: ClipTranscriptionSuccessPayload;
}): void {
	if (!cacheKey) return;
	const now = Date.now();

	for (const [key, entry] of clipTranscriptionResultCache) {
		if (entry.expiresAt <= now) {
			clipTranscriptionResultCache.delete(key);
		}
	}

	clipTranscriptionResultCache.set(cacheKey, {
		value,
		expiresAt: now + CLIP_TRANSCRIPTION_CACHE_TTL_MS,
	});

	while (clipTranscriptionResultCache.size > CLIP_TRANSCRIPTION_CACHE_MAX_ENTRIES) {
		const oldest = clipTranscriptionResultCache.keys().next().value;
		if (!oldest) break;
		clipTranscriptionResultCache.delete(oldest);
	}
}

function isRateLimitDisabled(): boolean {
	return (process.env.DISABLE_RATE_LIMIT ?? "false").toLowerCase() === "true";
}

async function runRateLimitIfAvailable({
	request,
}: {
	request: NextRequest;
}): Promise<{ limited: boolean }> {
	if (isRateLimitDisabled()) {
		return { limited: false };
	}

	try {
		const rateLimitModule = await import("@/lib/rate-limit");
		return await rateLimitModule.checkRateLimit({ request });
	} catch (error) {
		if (!rateLimitUnavailableLogged) {
			const message =
				error instanceof Error ? error.message : "Unknown rate-limit error";
			console.warn(
				`Rate limiting disabled for clips transcription route (continuing without limit): ${message}`,
			);
			rateLimitUnavailableLogged = true;
		}
		return { limited: false };
	}
}

function normalizeLocalWords({
	words,
}: {
	words: Array<{ word: string; start: number; end: number }>;
}): Array<{ text: string; start: number; end: number }> {
	const normalized: Array<{ text: string; start: number; end: number }> = [];
	for (let i = 0; i < words.length; i++) {
		const previous = normalized[normalized.length - 1];
		const text = words[i].word.trim();
		if (text.length === 0) continue;
		const start =
			previous && words[i].start < previous.end ? previous.end : words[i].start;
		const end = Math.max(start + 0.01, words[i].end);
		normalized.push({
			text,
			start,
			end,
		});
	}
	return normalized;
}

function hasMonotonicWords({
	words,
}: {
	words: Array<{ word: string; start: number; end: number }>;
}): boolean {
	let previousStart = -1;
	let previousEnd = -1;
	for (const word of words) {
		if (word.start < 0 || word.end < 0) return false;
		if (word.end < word.start) return false;
		if (previousStart >= 0 && word.start < previousStart) return false;
		if (previousEnd >= 0 && word.end < previousEnd) return false;
		previousStart = word.start;
		previousEnd = word.end;
	}
	return true;
}

async function callLocalWhisperX({
	file,
	requestedModel,
}: {
	file: File;
	requestedModel: string;
}): Promise<{
	segments: Array<{ text: string; start: number; end: number }>;
	model: string;
	engine: "local-whisperx";
	timingsMs?: Record<string, number>;
	audioDurationSeconds?: number;
	wordCount?: number;
}> {
	if (!webEnv.LOCAL_TRANSCRIBE_URL) {
		throw new Error("LOCAL_TRANSCRIBE_URL is not configured");
	}

	const form = new FormData();
	form.append("file", file, file.name || "clip.wav");
	form.append(
		"model",
		requestedModel || webEnv.LOCAL_TRANSCRIBE_MODEL || "medium",
	);
	form.append("device", webEnv.LOCAL_TRANSCRIBE_DEVICE || "cuda");
	form.append(
		"compute_type",
		webEnv.LOCAL_TRANSCRIBE_COMPUTE_TYPE || "int8_float16",
	);
	form.append(
		"vad_filter",
		(process.env.LOCAL_TRANSCRIBE_VAD_FILTER ?? "false").trim() || "false",
	);

	const controller = new AbortController();
	const timeout = webEnv.LOCAL_TRANSCRIBE_TIMEOUT_MS ?? 120000;
	const timeoutId = setTimeout(
		() => controller.abort("Local transcription timed out"),
		timeout,
	);

	try {
		let response: Response;
		try {
			response = await fetch(
				`${webEnv.LOCAL_TRANSCRIBE_URL.replace(/\/$/, "")}/v1/transcribe-word-timestamps`,
				{
					method: "POST",
					headers: webEnv.LOCAL_TRANSCRIBE_API_KEY
						? { Authorization: `Bearer ${webEnv.LOCAL_TRANSCRIBE_API_KEY}` }
						: undefined,
					body: form,
					signal: controller.signal,
				},
			);
		} catch (error) {
			throw new LocalTranscriptionUnavailableError(
				error instanceof Error
					? error.message
					: "Local transcription service unavailable",
			);
		}

		if (!response.ok) {
			const body = await response.text();
			if (response.status === 422) {
				throw new LocalTranscriptionValidationError(
					body || "Local whisperX returned invalid word-level output",
				);
			}
			throw new LocalTranscriptionUnavailableError(
				`Local transcription service failed (${response.status}): ${body}`,
			);
		}

		const parsed = localResponseSchema.safeParse(await response.json());
		if (!parsed.success) {
			throw new LocalTranscriptionValidationError(
				"Local whisperX returned malformed word-level output",
			);
		}
		const payload = parsed.data;
		if (!hasMonotonicWords({ words: payload.words })) {
			throw new LocalTranscriptionValidationError(
				"Local whisperX returned non-monotonic word timings",
			);
		}
		const segments = normalizeLocalWords({ words: payload.words });
		if (segments.length === 0) {
			throw new LocalTranscriptionValidationError(
				"Local whisperX returned empty word timings",
			);
		}

		return {
			segments,
			model: payload.model,
			engine: "local-whisperx",
			timingsMs: payload.timings_ms,
			audioDurationSeconds: payload.audio_duration_seconds,
			wordCount: payload.word_count,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

async function callOpenAITranscriptions({
	apiKey,
	file,
	model,
}: {
	apiKey: string;
	file: File;
	model: string;
}): Promise<Response> {
	const normalizedModel = model.toLowerCase();
	const responseFormat = normalizedModel.startsWith("gpt-4o")
		? "json"
		: "verbose_json";
	const openAIForm = new FormData();
	openAIForm.append("file", file, file.name || "clip.wav");
	openAIForm.append("model", model);
	openAIForm.append("response_format", responseFormat);
	openAIForm.append("temperature", "0");
	openAIForm.append("timestamp_granularities[]", "word");
	openAIForm.append("timestamp_granularities[]", "segment");

	return await fetch(OPENAI_TRANSCRIPTIONS_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: openAIForm,
	});
}

function normalizeOpenAIWordPayload({
	payload,
}: {
	payload: unknown;
}): Array<{ text: string; start: number; end: number }> {
	if (!payload || typeof payload !== "object") return [];
	const parsed = payload as {
		words?: Array<{ word?: string; start?: number; end?: number }>;
		segments?: Array<{
			words?: Array<{ word?: string; start?: number; end?: number }>;
		}>;
	};
	const rawWords = [
		...(parsed.words ?? []),
		...(parsed.segments ?? []).flatMap((segment) => segment.words ?? []),
	];
	return normalizeLocalWords({
		words: rawWords
			.filter(
				(word) =>
					typeof word.word === "string" &&
					typeof word.start === "number" &&
					typeof word.end === "number",
			)
			.map((word) => ({
				word: word.word ?? "",
				start: word.start ?? 0,
				end: word.end ?? 0,
			})),
	});
}

export async function POST(request: NextRequest) {
	try {
		const { limited } = await runRateLimitIfAvailable({ request });
		if (limited) {
			return NextResponse.json({ error: "Too many requests" }, { status: 429 });
		}

		const form = await request.formData();
		const file = form.get("file");
		const cacheKeyValue = form.get("cacheKey");
		const cacheKey =
			typeof cacheKeyValue === "string" ? cacheKeyValue.toString().trim() : "";
		const model =
			(form.get("model") ?? webEnv.LOCAL_TRANSCRIBE_MODEL ?? "medium")
				.toString()
				.trim() || "medium";
		if (!(file instanceof File)) {
			return NextResponse.json({ error: "file is required" }, { status: 400 });
		}
		if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
			return NextResponse.json(
				{ error: "file size is invalid for clip transcription" },
				{ status: 400 },
			);
		}

		const runTranscription = async (): Promise<ClipTranscriptionSuccessPayload> => {
			const startedAt = Date.now();
			if (webEnv.LOCAL_TRANSCRIBE_ENABLED) {
				try {
					const result = await callLocalWhisperX({
						file,
						requestedModel: model,
					});
					console.info("Clip transcription metrics", {
						engine: result.engine,
						model: result.model,
						durationMs: Date.now() - startedAt,
						audioDurationSeconds: result.audioDurationSeconds ?? null,
						wordCount: result.wordCount ?? result.segments.length,
						timingsMs: result.timingsMs ?? null,
					});
					return {
						segments: result.segments,
						granularity: "word",
						engine: result.engine,
						model: result.model,
						timingsMs: result.timingsMs,
						audioDurationSeconds: result.audioDurationSeconds,
						wordCount: result.wordCount ?? result.segments.length,
					};
				} catch (error) {
					const message =
						error instanceof Error
							? error.message
							: "Local transcription service unavailable";
					const isWordTimingValidationError =
						error instanceof LocalTranscriptionValidationError;
					const isServiceUnavailable =
						error instanceof LocalTranscriptionUnavailableError;
					if (!webEnv.LOCAL_TRANSCRIBE_FALLBACK_OPENAI) {
						const status = isWordTimingValidationError
							? 422
							: isServiceUnavailable
								? 503
								: 500;
						throw new Error(`HTTP_${status}:${message}`);
					}
				}
			}

			const openAiApiKey = webEnv.OPENAI_API_KEY;
			if (!openAiApiKey) {
				throw new Error(
					"HTTP_503:Local transcription unavailable and OPENAI_API_KEY is not configured for fallback",
				);
			}

			const openAiResponse = await callOpenAITranscriptions({
				apiKey: openAiApiKey,
				file,
				model: "whisper-1",
			});
			if (!openAiResponse.ok) {
				const body = await openAiResponse.text();
				throw new Error(
					`HTTP_500:OpenAI transcription failed (${openAiResponse.status}): ${body}`,
				);
			}

			const segments = normalizeOpenAIWordPayload({
				payload: await openAiResponse.json(),
			});
			if (segments.length === 0) {
				throw new Error(
					"HTTP_422:Transcription did not return word-level timestamps. Clip import requires per-word timing.",
				);
			}
			console.info("Clip transcription metrics", {
				engine: "openai-fallback",
				model: "whisper-1",
				durationMs: Date.now() - startedAt,
				wordCount: segments.length,
			});

			return {
				segments,
				granularity: "word",
				engine: "openai-fallback",
				model: "whisper-1",
			};
		};

		if (cacheKey) {
			const cached = getCachedClipTranscription({ cacheKey });
			if (cached) {
				return NextResponse.json(cached);
			}

			const inFlight = clipTranscriptionInFlight.get(cacheKey);
			if (inFlight) {
				try {
					return NextResponse.json(await inFlight);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.startsWith("HTTP_")) {
						const [statusPart, ...rest] = message.split(":");
						const status = Number(statusPart.replace("HTTP_", "")) || 500;
						return NextResponse.json(
							{ error: rest.join(":") || "Clip transcription failed" },
							{ status },
						);
					}
					throw error;
				}
			}

			const task = runTranscription();
			clipTranscriptionInFlight.set(cacheKey, task);
			try {
				const payload = await task;
				setCachedClipTranscription({ cacheKey, value: payload });
				return NextResponse.json(payload);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith("HTTP_")) {
					const [statusPart, ...rest] = message.split(":");
					const status = Number(statusPart.replace("HTTP_", "")) || 500;
					return NextResponse.json(
						{ error: rest.join(":") || "Clip transcription failed" },
						{ status },
					);
				}
				throw error;
			} finally {
				clipTranscriptionInFlight.delete(cacheKey);
			}
		}

		try {
			return NextResponse.json(await runTranscription());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.startsWith("HTTP_")) {
				const [statusPart, ...rest] = message.split(":");
				const status = Number(statusPart.replace("HTTP_", "")) || 500;
				return NextResponse.json(
					{ error: rest.join(":") || "Clip transcription failed" },
					{ status },
				);
			}
			throw error;
		}
	} catch (error) {
		console.error("Clip transcription failed:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Clip transcription failed",
			},
			{ status: 500 },
		);
	}
}
