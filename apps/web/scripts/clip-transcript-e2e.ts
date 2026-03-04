import { config as loadEnv } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildClipCandidatesFromTranscriptV2 } from "@/lib/clips/v2/candidate-builder";
import {
	mergeScoredCandidates,
	parseScoredCandidatesFromText,
	selectTopCandidatesWithQualityGate,
} from "@/lib/clips/scoring";
import { clipTranscriptSegmentsForWindow } from "@/lib/clips/transcript";
import { OpenAIViralityScoringProvider } from "@/lib/clips/providers/openai-provider";
import type { TranscriptionSegment } from "@/types/transcription";

loadEnv({ path: resolve(process.cwd(), ".env.local"), override: false });
loadEnv({ path: resolve(process.cwd(), ".env"), override: false });

const DEFAULT_INPUT = resolve(process.cwd(), "../../docs/transcript-sample.md");
const DEFAULT_OUTPUT = resolve(
	process.cwd(),
	"../../docs/transcript-sample.clips.json",
);

function parseCliArg({
	name,
}: {
	name: "input" | "output" | "model" | "min-score" | "max-count";
}): string | null {
	const prefix = `--${name}=`;
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith(prefix)) {
			return arg.slice(prefix.length).trim();
		}
	}
	return null;
}

function parseTimeToken(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		return Number.parseFloat(trimmed);
	}
	const parts = trimmed.split(":").map((part) => part.trim());
	if (parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
	const nums = parts.map((part) => Number.parseFloat(part));
	if (nums.some((part) => !Number.isFinite(part))) return null;

	if (nums.length === 3) {
		return nums[0] * 3600 + nums[1] * 60 + nums[2];
	}
	if (nums.length === 2) {
		return nums[0] * 60 + nums[1];
	}
	if (nums.length === 1) {
		return nums[0];
	}
	return null;
}

function parseExplicitTimestampLine(line: string): {
	start: number;
	end: number;
	text: string;
} | null {
	const bracketPattern = /^\s*[-*]?\s*\[(.+?)\]\s*(.+)$/;
	const directPattern = /^\s*[-*]?\s*(.+?)\s*(?:-->|->|-|to)\s*(.+?)\s*[:\-]?\s*(.+)$/i;

	const bracketMatch = line.match(bracketPattern);
	if (bracketMatch) {
		const range = bracketMatch[1] ?? "";
		const text = (bracketMatch[2] ?? "").trim();
		if (!text) return null;
		const rangeParts = range.split(/-->|->|-|to/i).map((part) => part.trim());
		if (rangeParts.length < 2) return null;
		const start = parseTimeToken(rangeParts[0] ?? "");
		const end = parseTimeToken(rangeParts[1] ?? "");
		if (start == null || end == null || end <= start) return null;
		return { start, end, text };
	}

	const directMatch = line.match(directPattern);
	if (!directMatch) return null;
	const start = parseTimeToken(directMatch[1] ?? "");
	const end = parseTimeToken(directMatch[2] ?? "");
	const text = (directMatch[3] ?? "").trim();
	if (start == null || end == null || end <= start || !text) return null;
	return { start, end, text };
}

function buildSegmentsFromPlainText({
	text,
	wordsPerSecond = 2.8,
	minSegmentDuration = 2.5,
	gapSeconds = 0.2,
}: {
	text: string;
	wordsPerSecond?: number;
	minSegmentDuration?: number;
	gapSeconds?: number;
}): TranscriptionSegment[] {
	const normalized = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^#+\s+/gm, "")
		.replace(/\r/g, "")
		.replace(/\n+/g, " ")
		.trim();
	if (!normalized) return [];

	const sentences = normalized
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);

	const segments: TranscriptionSegment[] = [];
	let cursor = 0;
	for (const sentence of sentences) {
		const words = sentence.match(/\S+/g) ?? [];
		const estimatedDuration = Math.max(
			minSegmentDuration,
			words.length / Math.max(0.1, wordsPerSecond),
		);
		const start = cursor;
		const end = start + estimatedDuration;
		segments.push({
			start: Number(start.toFixed(3)),
			end: Number(end.toFixed(3)),
			text: sentence,
		});
		cursor = end + gapSeconds;
	}
	return segments;
}

function parseTranscriptMarkdown({
	content,
}: {
	content: string;
}): TranscriptionSegment[] {
	const lines = content.split(/\r?\n/);
	const explicitSegments = lines
		.map((line) => parseExplicitTimestampLine(line))
		.filter((segment): segment is NonNullable<typeof segment> => segment != null)
		.map((segment) => ({
			start: Number(segment.start.toFixed(3)),
			end: Number(segment.end.toFixed(3)),
			text: segment.text,
		}));

	if (explicitSegments.length > 0) {
		return explicitSegments.sort((a, b) => a.start - b.start);
	}

	return buildSegmentsFromPlainText({ text: content });
}

function buildWindowTranscriptText({
	segments,
	startTime,
	endTime,
}: {
	segments: TranscriptionSegment[];
	startTime: number;
	endTime: number;
}): string {
	return clipTranscriptSegmentsForWindow({
		segments,
		startTime,
		endTime,
	})
		.map((segment) => segment.text.trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

function countScoredCandidates({
	scoredText,
}: {
	scoredText: string;
}): number | null {
	try {
		const parsed = parseScoredCandidatesFromText({ text: scoredText });
		return parsed.candidates.length;
	} catch {
		return null;
	}
}

async function main() {
	const openAiApiKey = process.env.OPENAI_API_KEY;
	if (!openAiApiKey) {
		throw new Error("OPENAI_API_KEY is missing in apps/web/.env.local or apps/web/.env");
	}

	const inputPath = resolve(parseCliArg({ name: "input" }) ?? DEFAULT_INPUT);
	const outputPath = resolve(parseCliArg({ name: "output" }) ?? DEFAULT_OUTPUT);
	const model = parseCliArg({ name: "model" }) ?? "gpt-5-mini";
	const minScore = Number.parseFloat(parseCliArg({ name: "min-score" }) ?? "56");
	const maxCount = Number.parseInt(parseCliArg({ name: "max-count" }) ?? "5", 10);

	if (!existsSync(inputPath)) {
		throw new Error(`Transcript file not found: ${inputPath}`);
	}

	const sourceMarkdown = await readFile(inputPath, "utf8");
	const segments = parseTranscriptMarkdown({ content: sourceMarkdown });
	if (segments.length === 0) {
		throw new Error(
			`No transcript segments could be parsed from ${inputPath}. Add timestamped lines like [00:00:02 --> 00:00:08] text.`,
		);
	}

	const mediaDuration = Math.max(
		0,
		segments[segments.length - 1]?.end ?? 0,
	);
	const transcriptText = segments.map((segment) => segment.text).join(" ").trim();

	const candidateDrafts = buildClipCandidatesFromTranscriptV2({
		segments,
		mediaDuration,
		minClipSeconds: 20,
		targetClipSeconds: 36,
		maxClipSeconds: 65,
		maxOutput: 18,
	});
	if (candidateDrafts.length === 0) {
		throw new Error("No candidate windows were produced from this transcript");
	}

	const provider = new OpenAIViralityScoringProvider({
		apiKey: openAiApiKey,
		model,
	});
	const scoredTextAttempt1 = await provider.scoreCandidates({
		transcript: transcriptText,
		candidates: candidateDrafts,
	});
	const scoredCountAttempt1 = countScoredCandidates({
		scoredText: scoredTextAttempt1,
	});
	const needsRetry =
		scoredCountAttempt1 == null || scoredCountAttempt1 !== candidateDrafts.length;
	const scoredTextAttempt2 = needsRetry
		? await provider.scoreCandidates({
				transcript: transcriptText,
				candidates: candidateDrafts,
			})
		: null;
	const scoredCountAttempt2 =
		scoredTextAttempt2 == null
			? null
			: countScoredCandidates({
					scoredText: scoredTextAttempt2,
				});
	const chooseAttempt2 =
		scoredTextAttempt2 != null &&
		(scoredCountAttempt2 ?? -1) > (scoredCountAttempt1 ?? -1);
	const scoredText = chooseAttempt2 ? scoredTextAttempt2! : scoredTextAttempt1;
	const finalScoredCount = chooseAttempt2
		? scoredCountAttempt2
		: scoredCountAttempt1;

	const mergedCandidates = mergeScoredCandidates({
		drafts: candidateDrafts,
		scoredText,
	});

	const selectedCandidates = selectTopCandidatesWithQualityGate({
		candidates: mergedCandidates,
		minScore: Number.isFinite(minScore) ? minScore : 56,
		maxCount: Number.isFinite(maxCount) ? Math.max(1, maxCount) : 5,
		excludeFailureFlags: ["cutoff_start"],
	});

	const output = {
		generatedAt: new Date().toISOString(),
		inputPath,
		model,
		mediaDuration,
		transcriptText,
		segmentsCount: segments.length,
		candidateDraftCount: candidateDrafts.length,
		mergedCandidateCount: mergedCandidates.length,
		selectedCandidateCount: selectedCandidates.length,
		diagnostics: {
			contractViolation: {
				draftCount: candidateDrafts.length,
				attempt1ScoredCount: scoredCountAttempt1,
				retried: needsRetry,
				attempt2ScoredCount: scoredCountAttempt2,
				finalScoredCount,
				hasViolation:
					finalScoredCount == null || finalScoredCount !== candidateDrafts.length,
				fallbackFilledCount: Math.max(
					0,
					candidateDrafts.length - (finalScoredCount ?? 0),
				),
			},
			selectedStartsCleanCount: selectedCandidates.filter(
				(candidate) => candidate.qaDiagnostics?.startsClean === true,
			).length,
			selectedEndsCleanCount: selectedCandidates.filter(
				(candidate) => candidate.qaDiagnostics?.endsClean === true,
			).length,
			selectedTailQuestionSetupCount: selectedCandidates.filter(
				(candidate) => candidate.qaDiagnostics?.hasTailQuestionSetup === true,
			).length,
			selectedConsequenceChainCount: selectedCandidates.filter(
				(candidate) => candidate.qaDiagnostics?.hasConsequenceChain === true,
			).length,
			selectedStrongStanceCount: selectedCandidates.filter(
				(candidate) => candidate.qaDiagnostics?.hasStrongStance === true,
			).length,
			selectedWithFeedbackCount: selectedCandidates.filter(
				(candidate) =>
					(candidate.userFeedback?.rating ?? candidate.userRating ?? 0) !== 0 ||
					Boolean(
						(candidate.userComment ?? candidate.userFeedback?.comment ?? "").trim(),
					),
			).length,
		},
		segments,
		candidateDrafts,
		mergedCandidates,
		selectedClipTranscripts: selectedCandidates.map((candidate, index) => ({
			rank: index + 1,
			id: candidate.id,
			startTime: candidate.startTime,
			endTime: candidate.endTime,
			duration: candidate.duration,
			title: candidate.title,
			scoreOverall: candidate.scoreOverall,
			scoreBreakdown: candidate.scoreBreakdown,
			failureFlags: candidate.failureFlags ?? [],
			qaDiagnostics: candidate.qaDiagnostics,
			userRating: candidate.userRating ?? 0,
			userComment: candidate.userComment ?? "",
			userFeedback: candidate.userFeedback ?? null,
			rationale: candidate.rationale,
			transcript: buildWindowTranscriptText({
				segments,
				startTime: candidate.startTime,
				endTime: candidate.endTime,
			}),
		})),
		rawScoredResponseText: scoredText,
	};

	await writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");

	console.log(
		`Transcript clip test complete: drafts=${candidateDrafts.length}, selected=${selectedCandidates.length}`,
	);
	console.log(`Wrote JSON report: ${outputPath}`);
}

main().catch((error) => {
	console.error("Transcript clip test failed:", error);
	process.exit(1);
});
