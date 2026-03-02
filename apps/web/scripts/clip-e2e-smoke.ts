import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildClipCandidatesFromTranscript } from "@/lib/clips/candidate-builder";
import {
	mergeScoredCandidates,
	selectTopCandidatesWithQualityGate,
} from "@/lib/clips/scoring";
import { OpenAIViralityScoringProvider } from "@/lib/clips/providers/openai-provider";
import type { TranscriptionSegment } from "@/types/transcription";

loadEnv({ path: resolve(process.cwd(), ".env.local"), override: false });
loadEnv({ path: resolve(process.cwd(), ".env"), override: false });

function buildTestSegments(): TranscriptionSegment[] {
	return [
		{ start: 2, end: 9, text: "I tried the same growth tactic for 30 days." },
		{ start: 10, end: 16, text: "Day one looked flat and honestly frustrating." },
		{ start: 17, end: 27, text: "Then one tiny hook change doubled retention in a week." },
		{ start: 33, end: 40, text: "Most creators optimize edits before the first line." },
		{ start: 41, end: 52, text: "That is backwards if you want shareable moments." },
		{ start: 61, end: 70, text: "Here is the exact framework we used every post." },
		{ start: 71, end: 84, text: "First curiosity, then proof, then one concrete takeaway." },
		{ start: 92, end: 101, text: "We tested this on boring topics and still got lift." },
		{ start: 106, end: 118, text: "By week four comments switched from nice to save this." },
		{ start: 124, end: 138, text: "If you only copy one thing, rewrite your opening line." },
		{ start: 145, end: 156, text: "That single step made the biggest difference for us." },
		{ start: 164, end: 176, text: "Use this template and adapt it to your own niche." },
	];
}

async function main() {
	const openAiApiKey = process.env.OPENAI_API_KEY;
	if (!openAiApiKey) {
		throw new Error("OPENAI_API_KEY is missing in apps/web/.env.local or apps/web/.env");
	}

	if (!existsSync(resolve(process.cwd(), ".env.local"))) {
		console.warn("Warning: apps/web/.env.local not found; using process env and/or .env");
	}

	const segments = buildTestSegments();
	const transcript = segments.map((segment) => segment.text).join(" ");
	const mediaDuration = 180;

	const candidateDrafts = buildClipCandidatesFromTranscript({
		segments,
		mediaDuration,
	});
	if (candidateDrafts.length === 0) {
		throw new Error("No candidate windows produced from test transcript");
	}

	const provider = new OpenAIViralityScoringProvider({
		apiKey: openAiApiKey,
		model: "gpt-5-mini",
	});
	const scoredText = await provider.scoreCandidates({
		transcript,
		candidates: candidateDrafts,
	});
	const merged = mergeScoredCandidates({
		drafts: candidateDrafts,
		scoredText,
	});
	const selected = selectTopCandidatesWithQualityGate({
		candidates: merged,
		minScore: 60,
		maxCount: 5,
	});

	if (selected.length === 0) {
		throw new Error("No clips passed quality gate (>=60)");
	}

	console.log(`E2E OK: ${candidateDrafts.length} drafts -> ${merged.length} scored -> ${selected.length} selected`);
	for (const [index, candidate] of selected.entries()) {
		console.log(
			`#${index + 1} ${candidate.id} ${candidate.startTime}-${candidate.endTime}s score=${candidate.scoreOverall} title="${candidate.title}"`,
		);
	}
}

main().catch((error) => {
	console.error("Clip E2E smoke failed:", error);
	process.exit(1);
});
