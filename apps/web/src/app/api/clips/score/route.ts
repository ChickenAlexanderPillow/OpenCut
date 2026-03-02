import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { OpenAIViralityScoringProvider } from "@/lib/clips/providers/openai-provider";
import { mergeScoredCandidates } from "@/lib/clips/scoring";

const MAX_TRANSCRIPT_CHARS = 20000;

const requestSchema = z.object({
	transcript: z.string().min(1),
	candidates: z.array(
		z.object({
			id: z.string().min(1),
			startTime: z.number(),
			endTime: z.number(),
			duration: z.number(),
			transcriptSnippet: z.string(),
			localScore: z.number(),
		}),
	),
});

function truncateTranscript({ transcript }: { transcript: string }): string {
	if (transcript.length <= MAX_TRANSCRIPT_CHARS) {
		return transcript;
	}
	return `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n[Transcript truncated for scoring context length]`;
}

async function runRateLimitIfAvailable({
	request,
}: {
	request: NextRequest;
}): Promise<{ limited: boolean }> {
	try {
		const rateLimitModule = await import("@/lib/rate-limit");
		return await rateLimitModule.checkRateLimit({ request });
	} catch (error) {
		// Keep clip scoring available when optional infra/env (e.g. Upstash) is not configured.
		console.warn("Rate limit check unavailable for clips scoring route:", error);
		return { limited: false };
	}
}

export async function POST(request: NextRequest) {
	try {
		const { limited } = await runRateLimitIfAvailable({ request });
		if (limited) {
			return NextResponse.json({ error: "Too many requests" }, { status: 429 });
		}

		const validation = requestSchema.safeParse(await request.json());
		if (!validation.success) {
			return NextResponse.json(
				{
					error: "Invalid payload",
					details: validation.error.flatten().fieldErrors,
				},
				{ status: 400 },
			);
		}

		const openAiApiKey = process.env.OPENAI_API_KEY;
		if (!openAiApiKey) {
			return NextResponse.json(
				{
					error: "OPENAI_API_KEY is not configured",
				},
				{ status: 500 },
			);
		}

		const provider = new OpenAIViralityScoringProvider({
			apiKey: openAiApiKey,
			model: "gpt-5-mini",
		});
		const scoredText = await provider.scoreCandidates({
			transcript: truncateTranscript({ transcript: validation.data.transcript }),
			candidates: validation.data.candidates,
		});
		const candidates = mergeScoredCandidates({
			drafts: validation.data.candidates,
			scoredText,
		});

		return NextResponse.json({ candidates });
	} catch (error) {
		console.error("Clip scoring failed:", error);
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "Failed to score clips",
			},
			{ status: 500 },
		);
	}
}
