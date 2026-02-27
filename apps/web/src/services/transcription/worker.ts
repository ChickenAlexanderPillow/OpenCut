import {
	pipeline,
	type AutomaticSpeechRecognitionPipeline,
	type AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers";
import type { TranscriptionSegment } from "@/types/transcription";
import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_STRIDE_SECONDS,
} from "@/constants/transcription-constants";

export type WorkerMessage =
	| { type: "init"; modelId: string }
	| {
			type: "transcribe";
			audio: Float32Array;
			sampleRate: number;
			language: string;
	  }
	| { type: "cancel" };

export type WorkerResponse =
	| { type: "init-progress"; progress: number }
	| { type: "init-complete" }
	| { type: "init-error"; error: string }
	| { type: "transcribe-progress"; progress: number }
	| {
			type: "transcribe-complete";
			text: string;
			segments: TranscriptionSegment[];
	  }
	| { type: "transcribe-error"; error: string }
	| { type: "cancelled" };

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let currentModelId: string | null = null;
let cancelled = false;
let lastReportedProgress = -1;
const fileBytes = new Map<string, { loaded: number; total: number }>();
const TRANSCRIPTION_SAMPLE_RATE = 16000;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			await handleInit({ modelId: message.modelId });
			break;
		case "transcribe":
			await handleTranscribe({
				audio: message.audio,
				sampleRate: message.sampleRate,
				language: message.language,
			});
			break;
		case "cancel":
			cancelled = true;
			self.postMessage({ type: "cancelled" } satisfies WorkerResponse);
			break;
	}
};

async function handleInit({ modelId }: { modelId: string }) {
	lastReportedProgress = -1;
	fileBytes.clear();

	try {
		currentModelId = resolveWordTimestampModelId({ requestedModelId: modelId });
		transcriber = (await pipeline("automatic-speech-recognition", currentModelId, {
			dtype: "q4",
			device: "auto",
			progress_callback: (progressInfo: {
				status?: string;
				file?: string;
				loaded?: number;
				total?: number;
			}) => {
				const file = progressInfo.file;
				if (!file) return;

				const loaded = progressInfo.loaded ?? 0;
				const total = progressInfo.total ?? 0;

				if (progressInfo.status === "progress" && total > 0) {
					fileBytes.set(file, { loaded, total });
				} else if (progressInfo.status === "done") {
					const existing = fileBytes.get(file);
					if (existing) {
						fileBytes.set(file, {
							loaded: existing.total,
							total: existing.total,
						});
					}
				}

				// sum all bytes
				let totalLoaded = 0;
				let totalSize = 0;
				for (const { loaded, total } of fileBytes.values()) {
					totalLoaded += loaded;
					totalSize += total;
				}

				if (totalSize === 0) return;

				const overallProgress = (totalLoaded / totalSize) * 100;
				const roundedProgress = Math.floor(overallProgress);

				if (roundedProgress !== lastReportedProgress) {
					lastReportedProgress = roundedProgress;
					self.postMessage({
						type: "init-progress",
						progress: roundedProgress,
					} satisfies WorkerResponse);
				}
			},
		})) as unknown as AutomaticSpeechRecognitionPipeline;

		self.postMessage({ type: "init-complete" } satisfies WorkerResponse);
	} catch (error) {
		self.postMessage({
			type: "init-error",
			error: error instanceof Error ? error.message : "Failed to load model",
		} satisfies WorkerResponse);
	}
}

async function handleTranscribe({
	audio,
	sampleRate,
	language,
}: {
	audio: Float32Array;
	sampleRate: number;
	language: string;
}) {
	if (!transcriber) {
		self.postMessage({
			type: "transcribe-error",
			error: "Model not initialized",
		} satisfies WorkerResponse);
		return;
	}

	cancelled = false;

	try {
		const modelInputAudio =
			sampleRate === TRANSCRIPTION_SAMPLE_RATE
				? audio
				: resampleTo16kHz({
						audio,
						sourceSampleRate: sampleRate,
					});

		let rawResult: Awaited<ReturnType<AutomaticSpeechRecognitionPipeline>>;
		try {
			// Prefer word timestamps for accurate karaoke highlighting.
			rawResult = await transcriber(modelInputAudio, {
				chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
				stride_length_s: DEFAULT_STRIDE_SECONDS,
				language: language === "auto" ? undefined : language,
				return_timestamps: "word" as unknown as true,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error ?? "");
			const requiresAttentionExports =
				message.includes("cross attentions") ||
				message.includes("output_attentions=True");

			if (!requiresAttentionExports) {
				throw error;
			}

			const nextModelId = resolveWordTimestampModelId({
				requestedModelId: currentModelId ?? "",
			});
			if (nextModelId !== currentModelId) {
				currentModelId = nextModelId;
				transcriber = (await pipeline(
					"automatic-speech-recognition",
					nextModelId,
					{
						dtype: "q4",
						device: "auto",
					},
				)) as unknown as AutomaticSpeechRecognitionPipeline;
			}

			// Retry with a word-timestamp capable model.
			if (!transcriber) {
				throw new Error("Transcriber unavailable after model switch");
			}
			rawResult = await transcriber(modelInputAudio, {
				chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
				stride_length_s: DEFAULT_STRIDE_SECONDS,
				language: language === "auto" ? undefined : language,
				return_timestamps: "word" as unknown as true,
			});
		}

		if (cancelled) return;

		const result: AutomaticSpeechRecognitionOutput = Array.isArray(rawResult)
			? rawResult[0]
			: rawResult;

		const segments: TranscriptionSegment[] = [];

		if (result.chunks) {
			for (const chunk of result.chunks) {
				if (chunk.timestamp && chunk.timestamp.length >= 2) {
					segments.push({
						text: chunk.text,
						start: chunk.timestamp[0] ?? 0,
						end: chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0,
					});
				}
			}
		}

		self.postMessage({
			type: "transcribe-complete",
			text: result.text,
			segments,
		} satisfies WorkerResponse);
	} catch (error) {
		if (cancelled) return;
		self.postMessage({
			type: "transcribe-error",
			error: error instanceof Error ? error.message : "Transcription failed",
		} satisfies WorkerResponse);
	}
}

function resolveWordTimestampModelId({
	requestedModelId,
}: {
	requestedModelId: string;
}): string {
	if (requestedModelId.includes("_timestamped")) {
		return requestedModelId;
	}

	switch (requestedModelId) {
		case "onnx-community/whisper-tiny":
			return "onnx-community/whisper-tiny_timestamped";
		case "onnx-community/whisper-small":
			return "onnx-community/whisper-small_timestamped";
		case "onnx-community/whisper-medium":
			return "onnx-community/whisper-medium_timestamped";
		default:
			// Conservative fallback that is known to support word-level timestamps.
			return "onnx-community/whisper-small_timestamped";
	}
}

function resampleTo16kHz({
	audio,
	sourceSampleRate,
}: {
	audio: Float32Array;
	sourceSampleRate: number;
}): Float32Array {
	if (
		sourceSampleRate <= 0 ||
		!Number.isFinite(sourceSampleRate) ||
		sourceSampleRate === TRANSCRIPTION_SAMPLE_RATE
	) {
		return audio;
	}

	const targetLength = Math.max(
		1,
		Math.round((audio.length * TRANSCRIPTION_SAMPLE_RATE) / sourceSampleRate),
	);
	const output = new Float32Array(targetLength);
	const ratio = sourceSampleRate / TRANSCRIPTION_SAMPLE_RATE;

	for (let i = 0; i < targetLength; i++) {
		const srcIndex = i * ratio;
		const left = Math.floor(srcIndex);
		const right = Math.min(left + 1, audio.length - 1);
		const weight = srcIndex - left;
		output[i] = audio[left] * (1 - weight) + audio[right] * weight;
	}

	return output;
}
