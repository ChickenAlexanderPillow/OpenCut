export function resolveRequestedClipTranscriptionLanguage({
	language,
}: {
	language: FormDataEntryValue | null;
}): string | null {
	if (typeof language !== "string") return null;
	const normalized = language.trim().toLowerCase();
	if (!normalized || normalized === "auto") return null;
	return normalized;
}

export function buildOpenAITranscriptionFormData({
	file,
	model,
	language,
}: {
	file: File;
	model: string;
	language?: string | null;
}): FormData {
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
	if (language) {
		openAIForm.append("language", language);
	}
	return openAIForm;
}

export function buildLocalWhisperXFormData({
	file,
	requestedModel,
	language,
	defaultModel,
	device,
	computeType,
	vadFilter,
	diarize,
}: {
	file: File;
	requestedModel: string;
	language?: string | null;
	defaultModel: string;
	device: string;
	computeType: string;
	vadFilter: string;
	diarize?: boolean;
}): FormData {
	const form = new FormData();
	form.append("file", file, file.name || "clip.wav");
	form.append("model", requestedModel || defaultModel);
	form.append("device", device);
	form.append("compute_type", computeType);
	form.append("vad_filter", vadFilter);
	if (diarize) {
		form.append("diarize", "true");
	}
	if (language) {
		form.append("language", language);
	}
	return form;
}
