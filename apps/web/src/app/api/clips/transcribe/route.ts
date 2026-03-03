import { NextResponse, type NextRequest } from "next/server";

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_SEGMENTS = 5000;
const FALLBACK_WORD_TIMING_MODEL = "whisper-1";
let rateLimitUnavailableLogged = false;

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

function normalizeSegmentsFromOpenAIPayload({
	payload,
}: {
	payload: unknown;
}): {
	segments: Array<{ text: string; start: number; end: number }>;
	granularity: "word" | "segment" | "none";
} {
	if (!payload || typeof payload !== "object") {
		return { segments: [], granularity: "none" };
	}

	const parsed = payload as {
		text?: string;
		transcript?: string;
		output_text?: string;
		words?: Array<{ word?: string; start?: number; end?: number }>;
		segments?: Array<{
			text?: string;
			transcript?: string;
			start?: number;
			end?: number;
			words?: Array<{ word?: string; start?: number; end?: number }>;
		}>;
	};

	const normalizeToken = ({ value }: { value: string }): string =>
		value.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

	const applyPunctuationFromTranscriptText = ({
		words,
		transcriptText,
	}: {
		words: Array<{ text: string; start: number; end: number }>;
		transcriptText: string;
	}): Array<{ text: string; start: number; end: number }> => {
		const transcriptTokens = transcriptText.match(/\S+/g) ?? [];
		if (transcriptTokens.length === 0) return words;

		let tokenCursor = 0;
		let matchedCount = 0;
		const mapped = words.map((word) => {
			const normalizedWord = normalizeToken({ value: word.text });
			if (!normalizedWord) return word;

			for (let i = tokenCursor; i < transcriptTokens.length; i++) {
				const candidate = transcriptTokens[i] ?? "";
				if (normalizeToken({ value: candidate }) === normalizedWord) {
					tokenCursor = i + 1;
					matchedCount += 1;
					return {
						...word,
						text: candidate,
					};
				}
			}

			return word;
		});

		const weakMatch = matchedCount < Math.ceil(words.length * 0.5);
		const nearEqualLength =
			Math.abs(transcriptTokens.length - words.length) <=
			Math.max(2, Math.floor(words.length * 0.15));
		if (weakMatch && nearEqualLength) {
			return words.map((word, index) => ({
				...word,
				text: transcriptTokens[index] ?? word.text,
			}));
		}

		return mapped;
	};

	const rootTranscriptText =
		parsed.text?.trim() ||
		parsed.transcript?.trim() ||
		parsed.output_text?.trim() ||
		"";

	const normalizeWordSpans = ({
		rawWords,
		transcriptText,
	}: {
		rawWords: Array<{ word?: string; start?: number; end?: number }>;
		transcriptText?: string;
	}): Array<{ text: string; start: number; end: number }> => {
		const words = rawWords
			.filter(
				(word) =>
					typeof word.word === "string" &&
					typeof word.start === "number" &&
					typeof word.end === "number",
			)
			.map((word) => ({
				text: word.word!.trim(),
				start: Math.max(0, word.start!),
				end: Math.max(word.start! + 0.01, word.end!),
			}))
			.filter((word) => word.text.length > 0)
			.slice(0, MAX_SEGMENTS);

		if (words.length === 0) return [];
		const punctuatedWords =
			typeof transcriptText === "string" && transcriptText.trim().length > 0
				? applyPunctuationFromTranscriptText({
						words,
						transcriptText,
					})
				: words;

		const normalized: Array<{ text: string; start: number; end: number }> = [];
		for (let i = 0; i < punctuatedWords.length; i++) {
			const previous = normalized[normalized.length - 1];
			const nextStart =
				previous && punctuatedWords[i].start < previous.end
					? previous.end
					: punctuatedWords[i].start;
			const nextEnd = Math.max(nextStart + 0.01, punctuatedWords[i].end);
			normalized.push({
				text: punctuatedWords[i].text,
				start: nextStart,
				end: nextEnd,
			});
		}
		return normalized;
	};

	const topLevelWords = normalizeWordSpans({
		rawWords: parsed.words ?? [],
		transcriptText: rootTranscriptText,
	});
	if (topLevelWords.length > 0) {
		return { segments: topLevelWords, granularity: "word" };
	}

	const nestedWords = normalizeWordSpans({
		rawWords: (parsed.segments ?? []).flatMap((segment) => segment.words ?? []),
		transcriptText:
			(parsed.segments ?? [])
				.map(
					(segment) =>
						segment.text?.trim() || segment.transcript?.trim() || "",
				)
				.filter((text) => text.length > 0)
				.join(" ") || rootTranscriptText,
	});
	if (nestedWords.length > 0) {
		return { segments: nestedWords, granularity: "word" };
	}

	const segmentSpans = (parsed.segments ?? [])
		.filter(
			(segment) =>
				typeof segment.text === "string" &&
				typeof segment.start === "number" &&
				typeof segment.end === "number" &&
				segment.text.trim().length > 0,
		)
		.slice(0, MAX_SEGMENTS)
		.map((segment) => ({
			text: segment.text!.trim(),
			start: Math.max(0, segment.start!),
			end: Math.max(segment.start! + 0.01, segment.end!),
		}));

	if (segmentSpans.length > 0) {
		return { segments: segmentSpans, granularity: "segment" };
	}
	return { segments: [], granularity: "none" };
}

async function callOpenAITranscriptions({
	apiKey,
	file,
	model,
	withWordGranularity,
}: {
	apiKey: string;
	file: File;
	model: string;
	withWordGranularity: boolean;
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
	if (withWordGranularity) {
		openAIForm.append("timestamp_granularities[]", "word");
		openAIForm.append("timestamp_granularities[]", "segment");
	}

	return await fetch(OPENAI_TRANSCRIPTIONS_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: openAIForm,
	});
}

export async function POST(request: NextRequest) {
	try {
		const { limited } = await runRateLimitIfAvailable({ request });
		if (limited) {
			return NextResponse.json({ error: "Too many requests" }, { status: 429 });
		}

		const openAiApiKey = process.env.OPENAI_API_KEY;
		if (!openAiApiKey) {
			return NextResponse.json(
				{ error: "OPENAI_API_KEY is not configured" },
				{ status: 500 },
			);
		}

		const form = await request.formData();
		const file = form.get("file");
		const model = (form.get("model") ?? "whisper-1").toString().trim() || "whisper-1";
		if (!(file instanceof File)) {
			return NextResponse.json({ error: "file is required" }, { status: 400 });
		}
		if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
			return NextResponse.json(
				{ error: "file size is invalid for clip transcription" },
				{ status: 400 },
			);
		}

		const requestedModel = model;
		let response = await callOpenAITranscriptions({
			apiKey: openAiApiKey,
			file,
			model: requestedModel,
			withWordGranularity: true,
		});
		let payload: unknown = null;
		let textBody = "";
		let usedModel = requestedModel;

		if (!response.ok) {
			textBody = await response.text();
			const shouldRetryWithoutWordGranularity =
				response.status === 400 &&
				textBody.toLowerCase().includes("timestamp_granularities");
			if (shouldRetryWithoutWordGranularity) {
				response = await callOpenAITranscriptions({
					apiKey: openAiApiKey,
					file,
					model: requestedModel,
					withWordGranularity: false,
				});
				if (!response.ok) {
					const retriedText = await response.text();
					return NextResponse.json(
						{
							error: `OpenAI transcription failed (${response.status}): ${retriedText}`,
						},
						{ status: 500 },
					);
				}
			} else {
				return NextResponse.json(
					{
						error: `OpenAI transcription failed (${response.status}): ${textBody}`,
					},
					{ status: 500 },
				);
			}
		}

		payload = await response.json();
		let normalized = normalizeSegmentsFromOpenAIPayload({ payload });
		if (
			normalized.granularity !== "word" &&
			requestedModel !== FALLBACK_WORD_TIMING_MODEL
		) {
			const fallbackResponse = await callOpenAITranscriptions({
				apiKey: openAiApiKey,
				file,
				model: FALLBACK_WORD_TIMING_MODEL,
				withWordGranularity: true,
			});
			if (fallbackResponse.ok) {
				const fallbackPayload = await fallbackResponse.json();
				const fallbackNormalized = normalizeSegmentsFromOpenAIPayload({
					payload: fallbackPayload,
				});
				if (fallbackNormalized.granularity === "word") {
					normalized = fallbackNormalized;
					usedModel = FALLBACK_WORD_TIMING_MODEL;
				}
			}
		}

		if (normalized.granularity !== "word") {
			return NextResponse.json(
				{
					error:
						"Transcription did not return word-level timestamps. Clip import requires per-word timing.",
					granularity: normalized.granularity,
					model: usedModel,
				},
				{ status: 422 },
			);
		}
		return NextResponse.json({
			segments: normalized.segments,
			granularity: normalized.granularity,
			model: usedModel,
		});
	} catch (error) {
		console.error("Clip transcription failed:", error);
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "Clip transcription failed",
			},
			{ status: 500 },
		);
	}
}
