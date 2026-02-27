import type {
	TranscriptionLanguage,
	TranscriptionResult,
	TranscriptionProgress,
	TranscriptionModelId,
} from "@/types/transcription";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	TRANSCRIPTION_MODELS,
} from "@/constants/transcription-constants";
import type { WorkerMessage, WorkerResponse } from "./worker";

type ProgressCallback = (progress: TranscriptionProgress) => void;

const MODEL_INIT_TIMEOUT_MS = 3 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000;
const MODEL_INIT_STALL_AFTER_100_MS = 20 * 1000;
const MODEL_INIT_MAX_ATTEMPTS = 2;

class TranscriptionService {
	private worker: Worker | null = null;
	private currentModelId: TranscriptionModelId | null = null;
	private isInitialized = false;
	private isInitializing = false;

	async transcribe({
		audioData,
		sampleRate,
		language = "auto",
		modelId = DEFAULT_TRANSCRIPTION_MODEL,
		onProgress,
	}: {
		audioData: Float32Array;
		sampleRate: number;
		language?: TranscriptionLanguage;
		modelId?: TranscriptionModelId;
		onProgress?: ProgressCallback;
	}): Promise<TranscriptionResult> {
		await this.ensureWorker({ modelId, onProgress });

		return new Promise((resolve, reject) => {
			if (!this.worker) {
				reject(new Error("Worker not initialized"));
				return;
			}
			const timeout = setTimeout(() => {
				this.worker?.removeEventListener("message", handleMessage);
				this.terminate();
				reject(
					new Error(
						`Transcription timed out after ${Math.round(
							TRANSCRIBE_TIMEOUT_MS / 1000,
						)}s`,
					),
				);
			}, TRANSCRIBE_TIMEOUT_MS);

			const handleMessage = (event: MessageEvent<WorkerResponse>) => {
				const response = event.data;

				switch (response.type) {
					case "transcribe-progress":
						onProgress?.({
							status: "transcribing",
							progress: response.progress,
							message: "Transcribing audio...",
						});
						break;

					case "transcribe-complete":
						this.worker?.removeEventListener("message", handleMessage);
						clearTimeout(timeout);
						resolve({
							text: response.text,
							segments: response.segments,
							language,
						});
						break;

					case "transcribe-error":
						this.worker?.removeEventListener("message", handleMessage);
						clearTimeout(timeout);
						reject(new Error(response.error));
						break;

					case "cancelled":
						this.worker?.removeEventListener("message", handleMessage);
						clearTimeout(timeout);
						reject(new Error("Transcription cancelled"));
						break;
				}
			};

			this.worker.addEventListener("message", handleMessage);

			this.worker.postMessage({
				type: "transcribe",
				audio: audioData,
				sampleRate,
				language,
			} satisfies WorkerMessage);
		});
	}

	cancel() {
		this.worker?.postMessage({ type: "cancel" } satisfies WorkerMessage);
	}

	private async ensureWorker({
		modelId,
		onProgress,
	}: {
		modelId: TranscriptionModelId;
		onProgress?: ProgressCallback;
	}): Promise<void> {
		const needsNewModel = this.currentModelId !== modelId;

		if (this.worker && this.isInitialized && !needsNewModel) {
			return;
		}

		if (this.isInitializing && !needsNewModel) {
			await this.waitForInit();
			return;
		}

		this.terminate();
		this.isInitializing = true;
		this.isInitialized = false;

		const model = TRANSCRIPTION_MODELS.find((m) => m.id === modelId);
		if (!model) {
			throw new Error(`Unknown model: ${modelId}`);
		}

		let lastError: Error | null = null;
		for (let attempt = 1; attempt <= MODEL_INIT_MAX_ATTEMPTS; attempt++) {
			try {
				await this.initializeWorkerOnce({
					modelId,
					modelName: model.name,
					huggingFaceModelId: model.huggingFaceId,
					onProgress,
				});
				return;
			} catch (error) {
				lastError =
					error instanceof Error
						? error
						: new Error("Unknown model initialization error");
				this.terminate();
				if (attempt < MODEL_INIT_MAX_ATTEMPTS) {
					onProgress?.({
						status: "loading-model",
						progress: 0,
						message: `Retrying ${model.name} model initialization... (${attempt + 1}/${MODEL_INIT_MAX_ATTEMPTS})`,
					});
				}
			}
		}
		this.isInitializing = false;
		throw (
			lastError ??
			new Error(
				`Failed to initialize ${model.name} after ${MODEL_INIT_MAX_ATTEMPTS} attempts`,
			)
		);
	}

	private async initializeWorkerOnce({
		modelId,
		modelName,
		huggingFaceModelId,
		onProgress,
	}: {
		modelId: TranscriptionModelId;
		modelName: string;
		huggingFaceModelId: string;
		onProgress?: ProgressCallback;
	}): Promise<void> {
		this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		});

		return new Promise((resolve, reject) => {
			if (!this.worker) {
				reject(new Error("Failed to create worker"));
				return;
			}

			let initSettled = false;
			let sawHundredProgress = false;
			let lastProgressTimestamp = Date.now();
			const cleanup = () => {
				if (!this.worker) return;
				this.worker.removeEventListener("message", handleMessage);
				clearTimeout(timeout);
				if (stallInterval !== null) {
					clearInterval(stallInterval);
				}
			};

			const fail = (error: Error) => {
				if (initSettled) return;
				initSettled = true;
				this.isInitializing = false;
				cleanup();
				reject(error);
			};

			const succeed = () => {
				if (initSettled) return;
				initSettled = true;
				this.isInitialized = true;
				this.isInitializing = false;
				this.currentModelId = modelId;
				cleanup();
				resolve();
			};

			const timeout = setTimeout(() => {
				fail(
					new Error(
						`Model initialization timed out after ${Math.round(
							MODEL_INIT_TIMEOUT_MS / 1000,
						)}s (${huggingFaceModelId})`,
					),
				);
			}, MODEL_INIT_TIMEOUT_MS);

			const stallInterval = setInterval(() => {
				if (!sawHundredProgress) return;
				if (Date.now() - lastProgressTimestamp < MODEL_INIT_STALL_AFTER_100_MS) {
					return;
				}
				fail(
					new Error(
						`Model initialization stalled at 100% for ${Math.round(
							MODEL_INIT_STALL_AFTER_100_MS / 1000,
						)}s (${huggingFaceModelId})`,
					),
				);
			}, 1000);

			const handleMessage = (event: MessageEvent<WorkerResponse>) => {
				const response = event.data;

				switch (response.type) {
					case "init-progress":
						lastProgressTimestamp = Date.now();
						if (response.progress >= 100) {
							sawHundredProgress = true;
						}
						onProgress?.({
							status: "loading-model",
							progress: response.progress,
							message: `Loading ${modelName} model (${huggingFaceModelId})...`,
						});
						break;

					case "init-complete":
						succeed();
						break;

					case "init-error":
						fail(new Error(response.error));
						break;
				}
			};

			this.worker.addEventListener("message", handleMessage);

			this.worker.postMessage({
				type: "init",
				modelId: huggingFaceModelId,
			} satisfies WorkerMessage);
		});
	}

	private waitForInit(): Promise<void> {
		return new Promise((resolve) => {
			const checkInit = () => {
				if (this.isInitialized) {
					resolve();
				} else if (!this.isInitializing) {
					resolve();
				} else {
					setTimeout(checkInit, 100);
				}
			};
			checkInit();
		});
	}

	terminate() {
		this.worker?.terminate();
		this.worker = null;
		this.isInitialized = false;
		this.isInitializing = false;
		this.currentModelId = null;
	}
}

export const transcriptionService = new TranscriptionService();
