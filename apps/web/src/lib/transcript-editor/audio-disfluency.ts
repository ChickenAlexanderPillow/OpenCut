import { decodeAudioToFloat32 } from "@/lib/media/audio";
import type { MediaAsset } from "@/types/assets";
import type { TranscriptEditWord } from "@/types/transcription";
import { normalizeTranscriptWords } from "@/lib/transcript-editor/core";

const ANALYSIS_WINDOW_SECONDS = 0.02;
const MIN_GAP_SECONDS = 0.08;
const MAX_GAP_SECONDS = 0.8;
const MIN_BURST_SECONDS = 0.05;
const MAX_BURST_SECONDS = 0.42;

export interface AudioDisfluencyCandidate {
	id: string;
	startTime: number;
	endTime: number;
	confidence: "medium" | "low";
	score: number;
	beforeText: string;
	afterText: string;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function quantile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = clamp(
		Math.floor((sorted.length - 1) * q),
		0,
		sorted.length - 1,
	);
	return sorted[index] ?? 0;
}

function computeWindowRms({
	samples,
	sampleRate,
}: {
	samples: Float32Array;
	sampleRate: number;
}): { rms: number[]; windowSeconds: number } {
	const windowSize = Math.max(
		64,
		Math.floor(sampleRate * ANALYSIS_WINDOW_SECONDS),
	);
	const windowCount = Math.max(1, Math.ceil(samples.length / windowSize));
	const rms: number[] = [];
	for (let index = 0; index < windowCount; index++) {
		const start = index * windowSize;
		const end = Math.min(samples.length, start + windowSize);
		let sumSquares = 0;
		for (let sampleIndex = start; sampleIndex < end; sampleIndex++) {
			const value = samples[sampleIndex] ?? 0;
			sumSquares += value * value;
		}
		rms.push(Math.sqrt(sumSquares / Math.max(1, end - start)));
	}
	return { rms, windowSeconds: windowSize / sampleRate };
}

export function detectAudioDisfluencyCandidatesFromSamples({
	samples,
	sampleRate,
	clipTrimStart,
	words,
}: {
	samples: Float32Array;
	sampleRate: number;
	clipTrimStart: number;
	words: TranscriptEditWord[];
}): AudioDisfluencyCandidate[] {
	const normalizedWords = normalizeTranscriptWords({ words }).filter(
		(word) => !word.removed,
	);
	if (normalizedWords.length < 2 || sampleRate <= 0 || samples.length === 0) {
		return [];
	}

	const analysis = computeWindowRms({ samples, sampleRate });
	const noiseFloor = quantile(analysis.rms, 0.2);
	const activeThreshold = Math.max(0.004, noiseFloor * 2.2);
	const candidates: AudioDisfluencyCandidate[] = [];

	for (let index = 0; index < normalizedWords.length - 1; index++) {
		const before = normalizedWords[index];
		const after = normalizedWords[index + 1];
		if (!before || !after) continue;
		const gapStart = before.endTime;
		const gapEnd = after.startTime;
		const gapDuration = gapEnd - gapStart;
		if (gapDuration < MIN_GAP_SECONDS || gapDuration > MAX_GAP_SECONDS)
			continue;

		const sourceGapStart = clipTrimStart + gapStart;
		const sourceGapEnd = clipTrimStart + gapEnd;
		const startIndex = clamp(
			Math.floor(sourceGapStart / analysis.windowSeconds),
			0,
			Math.max(0, analysis.rms.length - 1),
		);
		const endIndex = clamp(
			Math.ceil(sourceGapEnd / analysis.windowSeconds),
			startIndex + 1,
			analysis.rms.length,
		);

		let bestCandidate: AudioDisfluencyCandidate | null = null;
		let runStart = -1;
		let runPeak = 0;

		const flushRun = (runEndIndex: number) => {
			if (runStart < 0) return;
			const burstStart = runStart * analysis.windowSeconds;
			const burstEnd = runEndIndex * analysis.windowSeconds;
			const clippedStart = Math.max(sourceGapStart, burstStart);
			const clippedEnd = Math.min(sourceGapEnd, burstEnd);
			const duration = clippedEnd - clippedStart;
			if (duration < MIN_BURST_SECONDS || duration > MAX_BURST_SECONDS) {
				runStart = -1;
				runPeak = 0;
				return;
			}

			const burstMid = (clippedStart + clippedEnd) / 2;
			const gapMid = (sourceGapStart + sourceGapEnd) / 2;
			const midpointDistance = Math.abs(burstMid - gapMid);
			const centeredness =
				1 - midpointDistance / Math.max(0.001, gapDuration / 2);
			const strength = runPeak / Math.max(activeThreshold, 1e-6);
			const score = strength * 0.65 + centeredness * 0.35;
			const confidence =
				score >= 1.9 && duration <= 0.28 && gapDuration <= 0.5
					? "medium"
					: "low";
			const nextCandidate: AudioDisfluencyCandidate = {
				id: `audio-gap:${index}:${clippedStart.toFixed(3)}`,
				startTime: Math.max(0, clippedStart - clipTrimStart),
				endTime: Math.max(0.01, clippedEnd - clipTrimStart),
				confidence,
				score,
				beforeText: before.text,
				afterText: after.text,
			};
			if (!bestCandidate || nextCandidate.score > bestCandidate.score) {
				bestCandidate = nextCandidate;
			}
			runStart = -1;
			runPeak = 0;
		};

		for (let rmsIndex = startIndex; rmsIndex < endIndex; rmsIndex++) {
			const value = analysis.rms[rmsIndex] ?? 0;
			const active = value >= activeThreshold;
			if (active && runStart < 0) {
				runStart = rmsIndex;
				runPeak = value;
				continue;
			}
			if (active) {
				runPeak = Math.max(runPeak, value);
				continue;
			}
			flushRun(rmsIndex);
		}
		flushRun(endIndex);

		if (bestCandidate) {
			candidates.push(bestCandidate);
		}
	}

	return candidates
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.startTime - b.startTime;
		})
		.slice(0, 24);
}

export async function detectAudioDisfluencyCandidates({
	asset,
	clipTrimStart,
	words,
}: {
	asset: MediaAsset;
	clipTrimStart: number;
	words: TranscriptEditWord[];
}): Promise<AudioDisfluencyCandidate[]> {
	const decoded = await decodeAudioToFloat32({
		audioBlob: asset.file,
		fallbackUrl: asset.url,
	});
	return detectAudioDisfluencyCandidatesFromSamples({
		samples: decoded.samples,
		sampleRate: decoded.sampleRate,
		clipTrimStart,
		words,
	});
}
