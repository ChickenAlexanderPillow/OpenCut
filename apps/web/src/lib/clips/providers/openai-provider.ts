import type {
	ScoreCandidatesParams,
	ViralityScoringProvider,
} from "@/lib/clips/providers/types";
import { buildScoringPrompt } from "@/lib/clips/scoring";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function extractTextFromResponsesPayload({ payload }: { payload: unknown }): string {
	if (typeof payload !== "object" || payload === null) {
		throw new Error("Invalid OpenAI response payload");
	}

	const objectPayload = payload as Record<string, unknown>;
	if (typeof objectPayload.output_text === "string") {
		return objectPayload.output_text;
	}

	const output = objectPayload.output;
	if (!Array.isArray(output)) {
		throw new Error("OpenAI response did not include output text");
	}

	for (const item of output) {
		if (typeof item !== "object" || item === null) continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (typeof part !== "object" || part === null) continue;
			const maybePart = part as { type?: unknown; text?: unknown };
			if (maybePart.type === "output_text" && typeof maybePart.text === "string") {
				return maybePart.text;
			}
		}
	}

	throw new Error("Unable to extract text from OpenAI response");
}

export class OpenAIViralityScoringProvider implements ViralityScoringProvider {
	constructor(
		private params: {
			apiKey: string;
			model?: string;
		},
	) {}

	async scoreCandidates({
		transcript,
		candidates,
	}: ScoreCandidatesParams): Promise<string> {
		const prompt = buildScoringPrompt({
			transcript,
			candidates,
		});
		const response = await fetch(OPENAI_RESPONSES_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.params.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.params.model ?? "gpt-5-mini",
				input: prompt,
			}),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`OpenAI scoring failed (${response.status}): ${body}`);
		}

		const payload = (await response.json()) as unknown;
		return extractTextFromResponsesPayload({ payload });
	}
}
