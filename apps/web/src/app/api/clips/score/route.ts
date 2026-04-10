import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { OpenAIViralityScoringProvider } from "@/lib/clips/providers/openai-provider";
import { mergeScoredCandidates } from "@/lib/clips/scoring";

let rateLimitUnavailableLogged = false;

function isRateLimitDisabled(): boolean {
	return (process.env.DISABLE_RATE_LIMIT ?? "false").toLowerCase() === "true";
}

const requestSchema = z.object({
	candidates: z.array(
		z.object({
			id: z.string().min(1),
			startTime: z.number(),
			endTime: z.number(),
			duration: z.number(),
			transcriptSnippet: z.string(),
			localScore: z.number(),
			scoringContext: z.string().optional(),
		}),
	),
});

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
		// Keep clip scoring available when optional infra/env is down/unavailable.
		if (!rateLimitUnavailableLogged) {
			const message =
				error instanceof Error ? error.message : "Unknown rate-limit error";
			console.warn(
				`Rate limiting disabled for clips scoring route (continuing without limit): ${message}`,
			);
			rateLimitUnavailableLogged = true;
		}
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
