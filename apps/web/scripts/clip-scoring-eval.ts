import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildClipCandidatesFromTranscriptV2 } from "@/lib/clips/v2/candidate-builder";
import { buildScoringPrompt } from "@/lib/clips/scoring";
import type {
	ClipCandidate,
	ClipCandidateDraft,
} from "@/types/clip-generation";
import type { TranscriptionSegment } from "@/types/transcription";

const DEFAULT_INPUT = resolve(process.cwd(), "../../docs/transcript-sample.md");
const DEFAULT_BASELINE = resolve(
	process.cwd(),
	"../../docs/transcript-sample.clips.run1.json",
);
const DEFAULT_CANDIDATE = resolve(
	process.cwd(),
	"../../docs/transcript-sample.clips.json",
);
const CONTEXT_PADDING_SECONDS = 10;
const CONTEXT_MAX_CHARS = 1600;

type ReportCandidate = {
	id: string;
	startTime: number;
	endTime: number;
	duration: number;
	title?: string;
	scoreOverall?: number;
};

type ClipRunReport = {
	inputPath?: string;
	model?: string;
	segments?: TranscriptionSegment[];
	transcriptText?: string;
	candidateDrafts?: ClipCandidateDraft[];
	mergedCandidates?: ClipCandidate[];
	selectedClipTranscripts?: ReportCandidate[];
};

function parseCliArg({
	name,
}: {
	name:
		| "input"
		| "baseline"
		| "candidate"
		| "mode"
		| "max-output";
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
	if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
	if (nums.length === 2) return nums[0] * 60 + nums[1];
	if (nums.length === 1) return nums[0];
	return null;
}

function parseExplicitTimestampLine(line: string): {
	start: number;
	end: number;
	text: string;
} | null {
	const bracketPattern = /^\s*[-*]?\s*\[(.+?)\]\s*(.+)$/;
	const directPattern =
		/^\s*[-*]?\s*(.+?)\s*(?:-->|->|-|to)\s*(.+?)\s*[:\-]?\s*(.+)$/i;

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

function truncateContext(context: string): string {
	if (context.length <= CONTEXT_MAX_CHARS) return context;
	return `${context.slice(0, CONTEXT_MAX_CHARS)}\n[Context truncated]`;
}

function formatSeconds(value: number): string {
	const totalSeconds = Math.max(0, value);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds - minutes * 60;
	return `${minutes.toString().padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function buildLocalScoringContext({
	segments,
	candidate,
}: {
	segments: TranscriptionSegment[];
	candidate: Pick<ClipCandidateDraft, "startTime" | "endTime" | "transcriptSnippet">;
}): string {
	const windowStart = Math.max(0, candidate.startTime - CONTEXT_PADDING_SECONDS);
	const windowEnd = candidate.endTime + CONTEXT_PADDING_SECONDS;
	const relevantSegments = segments.filter(
		(segment) => segment.end > windowStart && segment.start < windowEnd,
	);

	if (relevantSegments.length === 0) {
		return truncateContext(candidate.transcriptSnippet);
	}

	return truncateContext(
		relevantSegments
			.map(
				(segment) =>
					`[${formatSeconds(segment.start)}-${formatSeconds(segment.end)}] ${segment.text.trim()}`,
			)
			.join("\n"),
	);
}

function buildLegacyScoringPrompt({
	transcript,
	candidates,
}: {
	transcript: string;
	candidates: ClipCandidateDraft[];
}): string {
	return [
		"You are a social video clipping analyst.",
		"Score each candidate for short-form virality potential from 0 to 100.",
		"Prioritize clips likely to maximize completion rate, rewatches, comments, and shares while still being understandable as standalone moments.",
		"Return strict JSON only in this format:",
		'{"candidates":[{"id":"string","title":"string","rationale":"string","scoreOverall":0,"confidence":0,"failureFlags":["string"],"scoreBreakdown":{"hook":0,"emotion":0,"shareability":0,"clarity":0,"momentum":0}}]}',
		`Transcript:\n${transcript}`,
		`Candidates:\n${JSON.stringify(
			candidates.map((candidate) => ({
				id: candidate.id,
				startTime: candidate.startTime,
				endTime: candidate.endTime,
				duration: candidate.duration,
				transcriptSnippet: candidate.transcriptSnippet,
			})),
		)}`,
	].join("\n");
}

function overlapRatio({
	aStart,
	aEnd,
	bStart,
	bEnd,
}: {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
}): number {
	const intersection = Math.max(
		0,
		Math.min(aEnd, bEnd) - Math.max(aStart, bStart),
	);
	const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
	if (union <= 0) return 0;
	return intersection / union;
}

function average(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function loadTranscriptFixture(path: string): Promise<{
	segments: TranscriptionSegment[];
	transcriptText: string;
}> {
	const content = await readFile(path, "utf8");
	const segments = parseTranscriptMarkdown({ content });
	return {
		segments,
		transcriptText: segments.map((segment) => segment.text).join(" ").trim(),
	};
}

async function loadReport(path: string): Promise<ClipRunReport> {
	const raw = await readFile(path, "utf8");
	return JSON.parse(raw) as ClipRunReport;
}

async function runPromptEval({
	inputPath,
	maxOutput,
}: {
	inputPath: string;
	maxOutput: number;
}) {
	const { segments, transcriptText } = await loadTranscriptFixture(inputPath);
	if (segments.length === 0) {
		throw new Error(`No transcript segments parsed from ${inputPath}`);
	}

	const mediaDuration = Math.max(0, segments[segments.length - 1]?.end ?? 0);
	const candidateDrafts = buildClipCandidatesFromTranscriptV2({
		segments,
		mediaDuration,
		minClipSeconds: 20,
		targetClipSeconds: 36,
		maxClipSeconds: 65,
		maxOutput,
	});

	const localizedCandidates = candidateDrafts.map((candidate) => ({
		...candidate,
		scoringContext: buildLocalScoringContext({
			segments,
			candidate,
		}),
	}));

	const legacyBody = JSON.stringify({
		transcript: transcriptText,
		candidates: candidateDrafts,
	});
	const currentBody = JSON.stringify({
		candidates: localizedCandidates,
	});
	const legacyPrompt = buildLegacyScoringPrompt({
		transcript: transcriptText,
		candidates: candidateDrafts,
	});
	const currentPrompt = buildScoringPrompt({
		candidates: localizedCandidates,
	});
	const contextLengths = localizedCandidates.map(
		(candidate) => candidate.scoringContext?.length ?? 0,
	);

	console.log(`Input: ${inputPath}`);
	console.log(`Segments: ${segments.length}`);
	console.log(`Candidate drafts: ${candidateDrafts.length}`);
	console.log(`Transcript chars: ${transcriptText.length}`);
	console.log(`Legacy request body chars: ${legacyBody.length}`);
	console.log(`Current request body chars: ${currentBody.length}`);
	console.log(
		`Request reduction: ${(
			(1 - currentBody.length / Math.max(1, legacyBody.length)) *
			100
		).toFixed(1)}%`,
	);
	console.log(`Legacy prompt chars: ${legacyPrompt.length}`);
	console.log(`Current prompt chars: ${currentPrompt.length}`);
	console.log(
		`Prompt reduction: ${(
			(1 - currentPrompt.length / Math.max(1, legacyPrompt.length)) *
			100
		).toFixed(1)}%`,
	);
	console.log(
		`Local context chars avg/min/max: ${average(contextLengths).toFixed(1)}/${Math.min(...contextLengths, 0)}/${Math.max(...contextLengths, 0)}`,
	);
}

async function runReportEval({
	baselinePath,
	candidatePath,
}: {
	baselinePath: string;
	candidatePath: string;
}) {
	const baseline = await loadReport(baselinePath);
	const candidate = await loadReport(candidatePath);
	const baselineSelected = baseline.selectedClipTranscripts ?? [];
	const candidateSelected = candidate.selectedClipTranscripts ?? [];

	const matches = baselineSelected.map((left) => {
		const exact = candidateSelected.find((right) => right.id === left.id);
		if (exact) {
			return { left, right: exact, overlap: 1, matchType: "id" as const };
		}
		const bestByOverlap = candidateSelected
			.map((right) => ({
				right,
				overlap: overlapRatio({
					aStart: left.startTime,
					aEnd: left.endTime,
					bStart: right.startTime,
					bEnd: right.endTime,
				}),
			}))
			.sort((a, b) => b.overlap - a.overlap)[0];
		return {
			left,
			right: bestByOverlap?.right ?? null,
			overlap: bestByOverlap?.overlap ?? 0,
			matchType:
				(bestByOverlap?.overlap ?? 0) >= 0.5 ? ("window" as const) : ("none" as const),
		};
	});

	const strongMatches = matches.filter((match) => match.matchType !== "none");
	const exactMatches = matches.filter((match) => match.matchType === "id");
	const baselineScores = baselineSelected
		.map((item) => item.scoreOverall)
		.filter((value): value is number => typeof value === "number");
	const candidateScores = candidateSelected
		.map((item) => item.scoreOverall)
		.filter((value): value is number => typeof value === "number");
	const matchedScoreDrift = strongMatches
		.map((match) => {
			const leftScore = match.left.scoreOverall;
			const rightScore = match.right?.scoreOverall;
			if (typeof leftScore !== "number" || typeof rightScore !== "number") return null;
			return rightScore - leftScore;
		})
		.filter((value): value is number => value != null);

	console.log(`Baseline report: ${baselinePath}`);
	console.log(`Candidate report: ${candidatePath}`);
	console.log(`Baseline selected clips: ${baselineSelected.length}`);
	console.log(`Candidate selected clips: ${candidateSelected.length}`);
	console.log(`Exact ID overlap: ${exactMatches.length}/${baselineSelected.length}`);
	console.log(
		`Strong overlap (ID or >=50% time-window overlap): ${strongMatches.length}/${baselineSelected.length}`,
	);
	console.log(
		`Average selected score baseline/candidate: ${average(baselineScores).toFixed(1)}/${average(candidateScores).toFixed(1)}`,
	);
	console.log(
		`Average matched score drift (candidate - baseline): ${average(matchedScoreDrift).toFixed(1)}`,
	);

	for (const match of matches) {
		const rightId = match.right?.id ?? "none";
		console.log(
			`${match.left.id} -> ${rightId} | match=${match.matchType} | overlap=${match.overlap.toFixed(2)}`,
		);
	}
}

async function main() {
	const mode = parseCliArg({ name: "mode" }) ?? "both";
	const inputPath = resolve(parseCliArg({ name: "input" }) ?? DEFAULT_INPUT);
	const baselinePath = resolve(
		parseCliArg({ name: "baseline" }) ?? DEFAULT_BASELINE,
	);
	const candidatePath = resolve(
		parseCliArg({ name: "candidate" }) ?? DEFAULT_CANDIDATE,
	);
	const maxOutput = Number.parseInt(
		parseCliArg({ name: "max-output" }) ?? "18",
		10,
	);

	if ((mode === "prompt" || mode === "both") && !existsSync(inputPath)) {
		throw new Error(`Transcript input not found: ${inputPath}`);
	}
	if ((mode === "reports" || mode === "both") && !existsSync(baselinePath)) {
		throw new Error(`Baseline report not found: ${baselinePath}`);
	}
	if ((mode === "reports" || mode === "both") && !existsSync(candidatePath)) {
		throw new Error(`Candidate report not found: ${candidatePath}`);
	}

	if (mode === "prompt" || mode === "both") {
		await runPromptEval({
			inputPath,
			maxOutput: Number.isFinite(maxOutput) ? Math.max(1, maxOutput) : 18,
		});
	}
	if (mode === "both") {
		console.log("");
	}
	if (mode === "reports" || mode === "both") {
		await runReportEval({
			baselinePath,
			candidatePath,
		});
	}
}

main().catch((error) => {
	console.error("Clip scoring eval failed:", error);
	process.exit(1);
});
