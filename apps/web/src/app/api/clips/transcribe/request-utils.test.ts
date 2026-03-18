import { describe, expect, test } from "bun:test";
import {
	buildLocalWhisperXFormData,
	buildOpenAITranscriptionFormData,
	resolveRequestedClipTranscriptionLanguage,
} from "./request-utils";

describe("clip transcription request utils", () => {
	test("normalizes requested language and drops auto", () => {
		expect(
			resolveRequestedClipTranscriptionLanguage({ language: " en " }),
		).toBe("en");
		expect(
			resolveRequestedClipTranscriptionLanguage({ language: "AUTO" }),
		).toBeNull();
		expect(
			resolveRequestedClipTranscriptionLanguage({ language: null }),
		).toBeNull();
	});

	test("includes explicit language in local whisperx form data", () => {
		const file = new File(["test"], "clip.wav", { type: "audio/wav" });
		const form = buildLocalWhisperXFormData({
			file,
			requestedModel: "medium",
			language: "en",
			defaultModel: "medium",
			device: "cuda",
			computeType: "int8_float16",
			vadFilter: "false",
		});

		expect(form.get("language")).toBe("en");
		expect(form.get("model")).toBe("medium");
	});

	test("includes explicit language in openai transcription form data", () => {
		const file = new File(["test"], "clip.wav", { type: "audio/wav" });
		const form = buildOpenAITranscriptionFormData({
			file,
			model: "whisper-1",
			language: "en",
		});

		expect(form.get("language")).toBe("en");
		expect(form.get("model")).toBe("whisper-1");
		expect(form.getAll("timestamp_granularities[]")).toEqual([
			"word",
			"segment",
		]);
	});
});
