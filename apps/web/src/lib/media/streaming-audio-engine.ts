import type { MediaAsset } from "@/types/assets";
import type { TimelineTrack } from "@/types/timeline";
import type { TranscriptEditCutRange } from "@/types/transcription";
import {
	buildCompressedCutBoundaryTimes,
	mapCompressedTimeToSourceTime,
} from "@/lib/transcript-editor/core";
import {
	collectAudioClips,
	decodeMediaFileToAudioBuffer,
} from "@/lib/media/audio";
import {
	clearAudioDecodeCache,
	getAudioDecodeCacheStats,
	getOrDecodeClipWindow,
	setAudioDecodeCacheBudget,
} from "@/lib/media/audio-decode-cache";
import {
	buildAudioGraphRevision,
	diffAudioGraphRevisions,
	type AudioGraphDiff,
	type AudioGraphRevision,
} from "@/lib/media/audio-graph-diff";

export interface StreamingClip {
	id: string;
	sourceKey: string;
	file: File;
	mediaIdentity: {
		id: string;
		type: MediaAsset["type"] | "library-audio";
		size: number;
		lastModified: number;
	};
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	muted: boolean;
	gain: number;
	transcriptRevision: string;
	transcriptCuts: TranscriptEditCutRange[];
}

export interface AudioHealthSnapshot {
	startupMs: number | null;
	cacheHitRate: number;
	dropouts: number;
	missingClips: number;
	reschedules: number;
}

type ScheduledNode = {
	key: string;
	clipId: string;
	source: AudioBufferSourceNode;
	gain: GainNode;
	endAtContextTime: number;
};

type DecodedClipWindow = {
	buffer: AudioBuffer;
	sourceWindowStart: number;
	sourceWindowEnd: number;
};

type DecodeWindowRequest = {
	requestKey: string;
	sourceWindowStart: number;
	sourceWindowDuration: number;
};

function clampTime(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function estimateWindowPeak({
	buffer,
	offsetSeconds,
	durationSeconds,
	maxSamples = 2048,
}: {
	buffer: AudioBuffer;
	offsetSeconds: number;
	durationSeconds: number;
	maxSamples?: number;
}): number {
	if (!Number.isFinite(offsetSeconds) || !Number.isFinite(durationSeconds))
		return 0;
	const startSample = Math.max(
		0,
		Math.floor(offsetSeconds * buffer.sampleRate),
	);
	const windowSamples = Math.max(
		1,
		Math.floor(durationSeconds * buffer.sampleRate),
	);
	const endSample = Math.max(
		startSample + 1,
		Math.min(buffer.length, startSample + windowSamples),
	);
	const length = Math.max(1, endSample - startSample);
	const stride = Math.max(1, Math.floor(length / Math.max(1, maxSamples)));
	let peak = 0;
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const data = buffer.getChannelData(channel);
		for (let index = startSample; index < endSample; index += stride) {
			const value = Math.abs(data[index] ?? 0);
			if (value > peak) peak = value;
		}
	}
	return peak;
}

function hasStructuralClipChange({
	previous,
	next,
}: {
	previous: StreamingClip;
	next: StreamingClip;
}): boolean {
	return (
		previous.sourceKey !== next.sourceKey ||
		previous.mediaIdentity.id !== next.mediaIdentity.id ||
		previous.mediaIdentity.type !== next.mediaIdentity.type ||
		previous.mediaIdentity.size !== next.mediaIdentity.size ||
		previous.mediaIdentity.lastModified !== next.mediaIdentity.lastModified ||
		previous.startTime !== next.startTime ||
		previous.duration !== next.duration ||
		previous.trimStart !== next.trimStart ||
		previous.trimEnd !== next.trimEnd ||
		previous.transcriptRevision !== next.transcriptRevision
	);
}

export class StreamingTimelineAudioEngine {
	private clips: StreamingClip[] = [];
	private revision: AudioGraphRevision | null = null;
	private scheduledByKey = new Map<string, ScheduledNode>();
	private scheduledUntilByClipId = new Map<string, number>();
	private lastScheduledEndAtContextByClipId = new Map<string, number>();
	private schedulerTimer: number | null = null;
	private schedulerBusy = false;
	private pendingTick = false;
	private decodeInFlightByKey = new Map<string, Promise<DecodedClipWindow | null>>();
	private decodedWindowByKey = new Map<string, DecodedClipWindow>();
	private lastDecodedWindowByClipId = new Map<string, DecodedClipWindow>();
	private isPlaying = false;
	private transportGeneration = 0;
	private timelineAnchorTime = 0;
	private contextAnchorTime = 0;
	private startupRequestedAt: number | null = null;
	private startupMs: number | null = null;
	private cacheHits = 0;
	private cacheMisses = 0;
	private dropouts = 0;
	private missingClips = 0;
	private reschedules = 0;
	private readonly lookaheadSeconds = 2.5;
	private readonly scheduleQuantumSeconds = 2;
	private readonly schedulerIntervalMs = 50;
	private readonly minSegmentDurationSeconds = 1 / 120;
	private readonly boundaryToleranceSeconds = 1 / 1000;
	private readonly boundaryCrossfadeSeconds = 0.01;
	private readonly unscheduleFadeSeconds = 0.01;
	private readonly slipCrossfadeSeconds = 0.012;
	private readonly decodeSlipThresholdSeconds = 0.004;
	private readonly decodePaddingSeconds = 1.5;
	private readonly decodeChunkSeconds = 12;
	private readonly maxDecodedWindows = 96;

	constructor(
		private readonly audioContext: AudioContext,
		private readonly destinationNode: AudioNode,
	) {
		const memoryHint =
			typeof navigator !== "undefined" &&
			typeof (navigator as Navigator & { deviceMemory?: number })
				.deviceMemory === "number"
				? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ??
					4)
				: 4;
		const budgetMb = memoryHint <= 4 ? 128 : 192;
		setAudioDecodeCacheBudget({ maxBytes: budgetMb * 1024 * 1024 });
	}

	async prepare({
		tracks,
		mediaAssets,
		playhead: _playhead,
	}: {
		tracks: TimelineTrack[];
		mediaAssets: MediaAsset[];
		playhead: number;
	}): Promise<{ diff: AudioGraphDiff; revision: AudioGraphRevision }> {
		const previousClipsById = new Map(
			this.clips.map((clip) => [clip.id, clip]),
		);
		const collected = await collectAudioClips({ tracks, mediaAssets });
		const clips: StreamingClip[] = collected
			.filter((clip) => clip.duration > 0)
			.map((clip) => ({
				...clip,
				transcriptCuts: clip.transcriptCuts ?? [],
			}));
		const nextRevision = buildAudioGraphRevision({ clips });
		const diff = diffAudioGraphRevisions({
			previous: this.revision,
			next: nextRevision,
		});
		const gainOnlyClipIds = new Set<string>();
		const structuralChangedClipIds = new Set<string>();
		for (const clipId of diff.addedClipIds)
			structuralChangedClipIds.add(clipId);
		for (const clipId of diff.removedClipIds)
			structuralChangedClipIds.add(clipId);
		for (const clipId of diff.updatedClipIds) {
			const previousClip = previousClipsById.get(clipId);
			const nextClip = clips.find((clip) => clip.id === clipId);
			if (!previousClip || !nextClip) {
				structuralChangedClipIds.add(clipId);
				continue;
			}
			if (hasStructuralClipChange({ previous: previousClip, next: nextClip })) {
				structuralChangedClipIds.add(clipId);
				continue;
			}
			if (
				previousClip.gain !== nextClip.gain ||
				previousClip.muted !== nextClip.muted
			) {
				gainOnlyClipIds.add(clipId);
			}
		}

		this.clips = clips;
		this.revision = nextRevision;
		return {
			diff: {
				...diff,
				structuralChangedClipIds,
				gainOnlyClipIds,
			},
			revision: nextRevision,
		};
	}

	start({ atTime }: { atTime: number }): void {
		this.transportGeneration += 1;
		this.isPlaying = true;
		this.startupRequestedAt = performance.now();
		this.startupMs = null;
		this.timelineAnchorTime = clampTime(atTime);
		this.contextAnchorTime = this.audioContext.currentTime;
		this.startScheduler();
	}

	seek({ time }: { time: number }): void {
		this.timelineAnchorTime = clampTime(time);
		this.contextAnchorTime = this.audioContext.currentTime;
		this.clearScheduledNodes();
		void this.tick();
	}

	stop(): void {
		this.transportGeneration += 1;
		this.isPlaying = false;
		this.stopScheduler();
		this.clearScheduledNodes();
	}

	updateGraph({
		diff,
		playhead,
	}: {
		diff: AudioGraphDiff;
		playhead: number;
	}): void {
		if (!this.isPlaying) return;
		const structuralChangedClipIds =
			diff.structuralChangedClipIds ?? diff.changedClipIds;
		const gainOnlyClipIds = diff.gainOnlyClipIds ?? new Set<string>();
		if (gainOnlyClipIds.size > 0) {
			this.applyGainUpdates({ clipIds: gainOnlyClipIds });
			void this.tick();
		}
		if (structuralChangedClipIds.size === 0) return;
		this.reschedules += 1;
		this.unscheduleClipIds({ clipIds: structuralChangedClipIds });
		this.seek({ time: playhead });
	}

	async prewarm({
		playhead,
		horizonSeconds = 2,
	}: {
		playhead: number;
		horizonSeconds?: number;
	}): Promise<void> {
		const windowStart = clampTime(playhead);
		const windowEnd = windowStart + Math.max(0.25, horizonSeconds);
		const candidates = this.clips
			.filter((clip) => !clip.muted)
			.filter(
				(clip) =>
					clip.startTime < windowEnd &&
					clip.startTime + clip.duration > windowStart,
			)
			.slice(0, 8);
		await Promise.all(
			candidates.map((clip) => {
				const request = this.buildDecodeWindowRequest({
					clip,
					timelineNow: windowStart,
					timelineHorizon: windowEnd,
				});
				return this.decodeClipBuffer({
					clip,
					request,
				}).then((decoded) => {
					if (!decoded) return;
					this.decodedWindowByKey.set(request.requestKey, decoded);
					this.lastDecodedWindowByClipId.set(clip.id, decoded);
					this.trimDecodedWindowCache();
				});
			}),
		);
	}

	clearCaches(): void {
		clearAudioDecodeCache();
	}

	getClockTime(): number {
		if (!this.isPlaying) return this.timelineAnchorTime;
		return (
			this.timelineAnchorTime +
			(this.audioContext.currentTime - this.contextAnchorTime)
		);
	}

	getHealth(): AudioHealthSnapshot {
		const total = this.cacheHits + this.cacheMisses;
		return {
			startupMs: this.startupMs,
			cacheHitRate: total === 0 ? 0 : this.cacheHits / total,
			dropouts: this.dropouts,
			missingClips: this.missingClips,
			reschedules: this.reschedules,
		};
	}

	getDiagnostics(): {
		cache: ReturnType<typeof getAudioDecodeCacheStats>;
		health: AudioHealthSnapshot;
		clipCount: number;
	} {
		return {
			cache: getAudioDecodeCacheStats(),
			health: this.getHealth(),
			clipCount: this.clips.length,
		};
	}

	dispose(): void {
		this.stop();
	}

	private startScheduler(): void {
		this.stopScheduler();
		if (typeof window === "undefined") return;
		this.schedulerTimer = window.setInterval(() => {
			void this.tick();
		}, this.schedulerIntervalMs);
		void this.tick();
	}

	private stopScheduler(): void {
		if (this.schedulerTimer !== null && typeof window !== "undefined") {
			window.clearInterval(this.schedulerTimer);
			this.schedulerTimer = null;
		}
	}

	private clearScheduledNodes(): void {
		for (const node of this.scheduledByKey.values()) {
			this.unscheduleNode({ node, softStop: this.isPlaying });
		}
		this.scheduledByKey.clear();
		this.scheduledUntilByClipId.clear();
		this.lastScheduledEndAtContextByClipId.clear();
	}

	private unscheduleClipIds({ clipIds }: { clipIds: Set<string> }): void {
		if (clipIds.size === 0) return;
		for (const [key, node] of this.scheduledByKey.entries()) {
			if (!clipIds.has(node.clipId)) continue;
			this.unscheduleNode({ node, softStop: this.isPlaying });
			this.scheduledByKey.delete(key);
		}
		for (const clipId of clipIds) {
			this.scheduledUntilByClipId.delete(clipId);
			this.lastScheduledEndAtContextByClipId.delete(clipId);
		}
	}

	private unscheduleNode({
		node,
		softStop,
	}: {
		node: ScheduledNode;
		softStop: boolean;
	}): void {
		if (!softStop) {
			try {
				node.source.stop();
			} catch {}
			node.source.disconnect();
			node.gain.disconnect();
			return;
		}
		const now = this.audioContext.currentTime;
		const fadeOutEnd = now + this.unscheduleFadeSeconds;
		try {
			const currentValue = node.gain.gain.value;
			node.gain.gain.cancelScheduledValues(now);
			node.gain.gain.setValueAtTime(currentValue, now);
			node.gain.gain.linearRampToValueAtTime(0, fadeOutEnd);
			node.source.stop(fadeOutEnd + 0.001);
		} catch {
			try {
				node.source.stop();
			} catch {}
		}
		if (typeof window !== "undefined") {
			window.setTimeout(
				() => {
					try {
						node.source.disconnect();
					} catch {}
					try {
						node.gain.disconnect();
					} catch {}
				},
				Math.ceil((this.unscheduleFadeSeconds + 0.02) * 1000),
			);
		}
	}

	private applyGainUpdates({ clipIds }: { clipIds: Set<string> }): void {
		if (clipIds.size === 0) return;
		const now = this.audioContext.currentTime;
		const gainByClipId = new Map(
			this.clips.map((clip) => [clip.id, clip.muted ? 0 : clip.gain]),
		);
		for (const node of this.scheduledByKey.values()) {
			if (!clipIds.has(node.clipId)) continue;
			const targetGain = gainByClipId.get(node.clipId);
			if (typeof targetGain !== "number") continue;
			node.gain.gain.cancelScheduledValues(now);
			node.gain.gain.setTargetAtTime(targetGain, now, 0.08);
		}
	}

	private async tick(): Promise<void> {
		if (!this.isPlaying) return;
		if (this.schedulerBusy) {
			this.pendingTick = true;
			return;
		}

		const runGeneration = this.transportGeneration;
		this.schedulerBusy = true;
		try {
			if (!this.isPlaying || runGeneration !== this.transportGeneration) return;
			const timelineNow = this.getClockTime();
			const contextNow = this.audioContext.currentTime;
			const contextHorizon = contextNow + this.lookaheadSeconds;
			const timelineHorizon = timelineNow + (contextHorizon - contextNow);

			for (const [key, node] of this.scheduledByKey.entries()) {
				if (node.endAtContextTime <= contextNow - 0.05) {
					this.scheduledByKey.delete(key);
				}
			}

			let hadRenderable = false;
			let hadScheduled = false;

			for (const clip of this.clips) {
				if (!this.isPlaying || runGeneration !== this.transportGeneration) {
					break;
				}
				if (clip.muted || clip.gain <= 0) continue;
				const clipEnd = clip.startTime + clip.duration;
				if (clip.startTime >= timelineHorizon || clipEnd <= timelineNow)
					continue;
				hadRenderable = true;

				const decodedWindow = this.getOrQueueDecodedWindow({
					clip,
					timelineNow,
					timelineHorizon,
				});
				if (!decodedWindow) {
					continue;
				}

				const scheduledForClip = this.scheduleClipWindow({
					clip,
					decodedWindow,
					timelineNow,
					timelineHorizon,
					contextNow,
					runGeneration,
				});
				hadScheduled = hadScheduled || scheduledForClip;
			}

			if (hadRenderable && !hadScheduled) {
				this.dropouts += 1;
			}
		} finally {
			this.schedulerBusy = false;
			if (this.pendingTick) {
				this.pendingTick = false;
				void this.tick();
			}
		}
	}

	private getOrQueueDecodedWindow({
		clip,
		timelineNow,
		timelineHorizon,
	}: {
		clip: StreamingClip;
		timelineNow: number;
		timelineHorizon: number;
	}): DecodedClipWindow | null {
		const request = this.buildDecodeWindowRequest({
			clip,
			timelineNow,
			timelineHorizon,
		});
		const resolved = this.decodedWindowByKey.get(request.requestKey);
		if (resolved) return resolved;

		const inFlight = this.decodeInFlightByKey.get(request.requestKey);
		if (!inFlight) {
			const promise = this.decodeClipBuffer({
				clip,
				request,
			})
				.then((decoded) => {
					if (decoded) {
						this.decodedWindowByKey.set(request.requestKey, decoded);
						this.lastDecodedWindowByClipId.set(clip.id, decoded);
						this.trimDecodedWindowCache();
						return decoded;
					}
					this.missingClips += 1;
					return null;
				})
				.catch(() => null)
				.finally(() => {
					this.decodeInFlightByKey.delete(request.requestKey);
				});
			this.decodeInFlightByKey.set(request.requestKey, promise);
		}

		const fallback = this.lastDecodedWindowByClipId.get(clip.id) ?? null;
		if (!fallback) return null;
		const requestedSourceNow =
			clip.trimStart +
			this.mapCompressedLocalTimeToSource({
				clip,
				compressedLocal: Math.max(
					0,
					Math.min(clip.duration, timelineNow - clip.startTime),
				),
			});
		return requestedSourceNow >= fallback.sourceWindowStart &&
			requestedSourceNow < fallback.sourceWindowEnd
			? fallback
			: null;
	}

	private trimDecodedWindowCache(): void {
		while (this.decodedWindowByKey.size > this.maxDecodedWindows) {
			const oldestKey = this.decodedWindowByKey.keys().next().value as
				| string
				| undefined;
			if (!oldestKey) break;
			this.decodedWindowByKey.delete(oldestKey);
		}
	}

	private buildDecodeWindowRequest({
		clip,
		timelineNow,
		timelineHorizon,
	}: {
		clip: StreamingClip;
		timelineNow: number;
		timelineHorizon: number;
	}): DecodeWindowRequest {
		const sourceTimelineWindow = this.computeSourceWindowForTimelineRange({
			clip,
			timelineNow,
			timelineHorizon,
		});
		const quantizedWindowStart = Math.max(
			0,
			Math.floor(sourceTimelineWindow.sourceWindowStart * 2) / 2,
		);
		const quantizedWindowDuration = Math.max(
			0.25,
			Math.ceil(sourceTimelineWindow.sourceWindowDuration * 2) / 2,
		);
		return {
			requestKey: [
				clip.id,
				clip.sourceKey,
				clip.transcriptRevision,
				this.audioContext.sampleRate,
				quantizedWindowStart.toFixed(3),
				quantizedWindowDuration.toFixed(3),
			].join("|"),
			sourceWindowStart: quantizedWindowStart,
			sourceWindowDuration: quantizedWindowDuration,
		};
	}

	private async decodeClipBuffer({
		clip,
		request,
	}: {
		clip: StreamingClip;
		request: DecodeWindowRequest;
	}): Promise<DecodedClipWindow | null> {
		const result = await getOrDecodeClipWindow({
			keyParts: {
				mediaId: clip.mediaIdentity.id,
				mediaType: clip.mediaIdentity.type,
				fileSize: clip.mediaIdentity.size,
				lastModified: clip.mediaIdentity.lastModified,
				sampleRate: this.audioContext.sampleRate,
				channels: 2,
				decodeMode: "windowed",
				trimStart: request.sourceWindowStart,
				duration: request.sourceWindowDuration,
				transcriptRevision: clip.transcriptRevision,
				sourceUrl: clip.sourceKey,
			},
			decode: async () => {
				try {
					return await decodeMediaFileToAudioBuffer({
						file: clip.file,
						sampleRate: this.audioContext.sampleRate,
						trimStart: request.sourceWindowStart,
						trimDuration: request.sourceWindowDuration,
					});
				} catch (error) {
					console.warn(
						"Failed to decode clip audio for streaming playback:",
						error,
					);
					return null;
				}
			},
		});
		if (result.cacheHit) {
			this.cacheHits += 1;
		} else {
			this.cacheMisses += 1;
		}
		if (!result.buffer) return null;
		const decodedDuration = result.buffer.length / result.buffer.sampleRate;
		return {
			buffer: result.buffer,
			sourceWindowStart: request.sourceWindowStart,
			sourceWindowEnd: request.sourceWindowStart + decodedDuration,
		};
	}

	private computeSourceWindowForTimelineRange({
		clip,
		timelineNow,
		timelineHorizon,
	}: {
		clip: StreamingClip;
		timelineNow: number;
		timelineHorizon: number;
	}): {
		sourceWindowStart: number;
		sourceWindowDuration: number;
	} {
		const clipStart = clip.startTime;
		const localNow = Math.max(
			0,
			Math.min(clip.duration, timelineNow - clipStart),
		);
		const localHorizon = Math.max(
			localNow,
			Math.min(clip.duration, timelineHorizon - clipStart),
		);
		const sourceNow =
			clip.trimStart +
			this.mapCompressedLocalTimeToSource({
				clip,
				compressedLocal: localNow,
			});
		const sourceHorizon =
			clip.trimStart +
			this.mapCompressedLocalTimeToSource({
				clip,
				compressedLocal: localHorizon,
			});
		const clipSourceDuration = this.mapCompressedLocalTimeToSource({
			clip,
			compressedLocal: clip.duration,
		});
		const clipSourceStart = Math.max(0, clip.trimStart);
		const sourceClipEnd = clipSourceStart + Math.max(0, clipSourceDuration);
		const chunkStep = Math.max(1, this.decodeChunkSeconds / 2);
		const focusStart = Math.max(
			clipSourceStart,
			sourceNow - this.decodePaddingSeconds,
		);
		const alignedStart =
			Math.floor((focusStart - clipSourceStart) / chunkStep) * chunkStep +
			clipSourceStart;
		let chunkStart = Math.max(
			clipSourceStart,
			Math.min(alignedStart, sourceClipEnd - this.decodeChunkSeconds),
		);
		let chunkDuration = Math.min(
			this.decodeChunkSeconds,
			Math.max(0.25, sourceClipEnd - chunkStart),
		);
		const requiredEnd = Math.min(
			sourceClipEnd,
			Math.max(
				sourceHorizon + this.decodePaddingSeconds,
				sourceNow + this.lookaheadSeconds,
			),
		);
		if (chunkStart + chunkDuration < requiredEnd) {
			chunkStart = Math.max(
				clipSourceStart,
				Math.min(
					requiredEnd - this.decodeChunkSeconds,
					sourceClipEnd - this.decodeChunkSeconds,
				),
			);
			chunkDuration = Math.min(
				this.decodeChunkSeconds,
				Math.max(0.25, sourceClipEnd - chunkStart),
			);
		}
		return {
			sourceWindowStart: chunkStart,
			sourceWindowDuration: chunkDuration,
		};
	}

	private scheduleClipWindow({
		clip,
		decodedWindow,
		timelineNow,
		timelineHorizon,
		contextNow,
		runGeneration,
	}: {
		clip: StreamingClip;
		decodedWindow: DecodedClipWindow;
		timelineNow: number;
		timelineHorizon: number;
		contextNow: number;
		runGeneration: number;
	}): boolean {
		const buffer = decodedWindow.buffer;
		let scheduledAny = false;
		const clipStart = clip.startTime;
		const clipEnd = clip.startTime + clip.duration;
		const windowStart = Math.max(clipStart, timelineNow);
		const extendedHorizon = Math.min(
			clipEnd,
			timelineHorizon + this.scheduleQuantumSeconds,
		);
		const quantizedWindowEnd =
			clipStart +
			Math.min(
				clip.duration,
				Math.ceil((extendedHorizon - clipStart) / this.scheduleQuantumSeconds) *
					this.scheduleQuantumSeconds,
			);
		const windowEnd = Math.min(clipEnd, quantizedWindowEnd);
		const alreadyScheduledUntil =
			this.scheduledUntilByClipId.get(clip.id) ?? windowStart;
		const effectiveWindowStart = Math.max(windowStart, alreadyScheduledUntil);
		if (windowEnd <= effectiveWindowStart) return false;

		const segmentPoints = this.buildSegmentPoints({
			clip,
			localStart: effectiveWindowStart - clipStart,
			localEnd: windowEnd - clipStart,
		});
		for (let index = 0; index < segmentPoints.length - 1; index++) {
			if (!this.isPlaying || runGeneration !== this.transportGeneration) break;
			const localSegmentStart = segmentPoints[index];
			const localSegmentEnd = segmentPoints[index + 1];
			if (
				typeof localSegmentStart !== "number" ||
				typeof localSegmentEnd !== "number" ||
				localSegmentEnd - localSegmentStart < this.minSegmentDurationSeconds
			) {
				continue;
			}
			const timelineSegmentStart = clipStart + localSegmentStart;
			const timelineSegmentEnd = clipStart + localSegmentEnd;
			const key = `${clip.id}:${timelineSegmentStart.toFixed(4)}:${timelineSegmentEnd.toFixed(4)}`;
			if (this.scheduledByKey.has(key)) continue;

			const localPlaybackStart = Math.max(
				localSegmentStart,
				timelineNow - clipStart,
			);
			const playbackDuration = localSegmentEnd - localPlaybackStart;
			if (playbackDuration < this.minSegmentDurationSeconds) continue;

			const timelinePlaybackStart = clipStart + localPlaybackStart;
			const desiredContextStart =
				contextNow + Math.max(0, timelinePlaybackStart - timelineNow);
			const sourceAbsoluteOffset =
				clip.trimStart +
				this.mapCompressedLocalTimeToSource({
					clip,
					compressedLocal: localPlaybackStart,
				});
			const availableDuration =
				decodedWindow.sourceWindowEnd - sourceAbsoluteOffset;
			let boundedPlaybackDuration = Math.min(
				playbackDuration,
				Math.max(0, availableDuration),
			);
			if (boundedPlaybackDuration < this.minSegmentDurationSeconds) continue;
			const naturalStartBoundary =
				this.isClipOrTranscriptBoundary({
					clip,
					localTime: localPlaybackStart,
				}) || localPlaybackStart <= this.boundaryToleranceSeconds;
			const _naturalEndBoundary =
				this.isClipOrTranscriptBoundary({
					clip,
					localTime: localPlaybackStart + boundedPlaybackDuration,
				}) ||
				Math.abs(
					localPlaybackStart + boundedPlaybackDuration - clip.duration,
				) <= this.boundaryToleranceSeconds;
			let contextStart = desiredContextStart;
			let sourceAbsoluteStart = sourceAbsoluteOffset;
			let boundaryLeadSeconds = 0;
			const previousEndAtContext =
				this.lastScheduledEndAtContextByClipId.get(clip.id) ?? null;
			if (previousEndAtContext !== null && !naturalStartBoundary) {
				const decodeSlip = desiredContextStart - previousEndAtContext;
				const desiredLead =
					decodeSlip > this.decodeSlipThresholdSeconds
						? Math.min(this.slipCrossfadeSeconds, decodeSlip)
						: this.boundaryCrossfadeSeconds;
				const maxLeadFromNow = Math.max(
					0,
					desiredContextStart - (contextNow + 0.002),
				);
				const maxLeadFromOffset = Math.max(
					0,
					sourceAbsoluteOffset - decodedWindow.sourceWindowStart,
				);
				boundaryLeadSeconds = Math.min(
					desiredLead,
					maxLeadFromNow,
					maxLeadFromOffset,
				);
				if (boundaryLeadSeconds > 0) {
					contextStart = desiredContextStart - boundaryLeadSeconds;
					sourceAbsoluteStart = sourceAbsoluteOffset - boundaryLeadSeconds;
					const desiredContextEnd =
						desiredContextStart + boundedPlaybackDuration;
					const availableFromAdjustedStart =
						decodedWindow.sourceWindowEnd - sourceAbsoluteStart;
					boundedPlaybackDuration = Math.min(
						desiredContextEnd - contextStart,
						Math.max(0, availableFromAdjustedStart),
					);
				}
			}
			const sourceOffset = Math.max(
				0,
				sourceAbsoluteStart - decodedWindow.sourceWindowStart,
			);
			if (boundedPlaybackDuration < this.minSegmentDurationSeconds) continue;
			if (!this.isPlaying || runGeneration !== this.transportGeneration) break;

			const source = this.audioContext.createBufferSource();
			source.buffer = buffer;
			const scheduledPeak = estimateWindowPeak({
				buffer,
				offsetSeconds: sourceOffset,
				durationSeconds: boundedPlaybackDuration,
			});
			if (typeof window !== "undefined") {
				window.dispatchEvent(
					new CustomEvent("opencut:audio-schedule-level", {
						detail: {
							clipId: clip.id,
							peak: scheduledPeak,
							duration: boundedPlaybackDuration,
						},
					}),
				);
			}
			const gainNode = this.audioContext.createGain();
			const hasFadeIn =
				naturalStartBoundary ||
				boundaryLeadSeconds > 0 ||
				previousEndAtContext === null;
			const hasFadeOut = true;
			const fadeSeconds = Math.min(
				hasFadeIn || hasFadeOut
					? Math.max(boundaryLeadSeconds, this.boundaryCrossfadeSeconds)
					: this.boundaryCrossfadeSeconds,
				boundedPlaybackDuration / 2,
			);
			if (hasFadeIn) {
				gainNode.gain.setValueAtTime(0, contextStart);
				gainNode.gain.linearRampToValueAtTime(
					clip.gain,
					contextStart + fadeSeconds,
				);
			} else {
				gainNode.gain.setValueAtTime(clip.gain, contextStart);
			}
			if (hasFadeOut) {
				gainNode.gain.setValueAtTime(
					clip.gain,
					Math.max(
						contextStart + (hasFadeIn ? fadeSeconds : 0),
						contextStart + boundedPlaybackDuration - fadeSeconds,
					),
				);
				gainNode.gain.linearRampToValueAtTime(
					0,
					contextStart + boundedPlaybackDuration,
				);
			} else {
				gainNode.gain.setValueAtTime(
					clip.gain,
					contextStart + boundedPlaybackDuration,
				);
			}

			source.connect(gainNode);
			gainNode.connect(this.destinationNode);
			const scheduledNode: ScheduledNode = {
				key,
				clipId: clip.id,
				source,
				gain: gainNode,
				endAtContextTime: contextStart + boundedPlaybackDuration,
			};
			this.scheduledByKey.set(key, scheduledNode);
			scheduledAny = true;

			source.addEventListener("ended", () => {
				source.disconnect();
				gainNode.disconnect();
				this.scheduledByKey.delete(key);
			});
			source.start(contextStart, sourceOffset, boundedPlaybackDuration);
			source.stop(contextStart + boundedPlaybackDuration + 0.01);
			const scheduledTimelineEnd =
				timelinePlaybackStart +
				Math.max(
					0,
					Math.min(playbackDuration, boundedPlaybackDuration),
				);
			this.scheduledUntilByClipId.set(
				clip.id,
				Math.max(
					this.scheduledUntilByClipId.get(clip.id) ?? 0,
					scheduledTimelineEnd,
				),
			);
			this.lastScheduledEndAtContextByClipId.set(
				clip.id,
				Math.max(
					this.lastScheduledEndAtContextByClipId.get(clip.id) ?? 0,
					contextStart + boundedPlaybackDuration,
				),
			);

			if (this.startupMs === null && this.startupRequestedAt !== null) {
				this.startupMs = performance.now() - this.startupRequestedAt;
				if (typeof window !== "undefined") {
					window.dispatchEvent(
						new CustomEvent("opencut:audio-diagnostics", {
							detail: {
								type: "startup-latency",
								startupMs: this.startupMs,
							},
						}),
					);
				}
			}
		}
		return scheduledAny;
	}

	private buildSegmentPoints({
		clip,
		localStart,
		localEnd,
	}: {
		clip: StreamingClip;
		localStart: number;
		localEnd: number;
	}): number[] {
		const clipLocalCuts = this.getClipLocalTranscriptCuts({ clip });
		if (clipLocalCuts.length === 0) {
			return [localStart, localEnd];
		}

		const boundaries = buildCompressedCutBoundaryTimes({
			cuts: clipLocalCuts,
		});
		const points = [localStart];
		for (const boundary of boundaries) {
			if (boundary <= localStart || boundary >= localEnd) continue;
			points.push(boundary);
		}
		points.push(localEnd);
		points.sort((left, right) => left - right);
		return points;
	}

	private mapCompressedLocalTimeToSource({
		clip,
		compressedLocal,
	}: {
		clip: StreamingClip;
		compressedLocal: number;
	}): number {
		const clipLocalCuts = this.getClipLocalTranscriptCuts({ clip });
		if (clipLocalCuts.length === 0) {
			return compressedLocal;
		}
		return mapCompressedTimeToSourceTime({
			compressedTime: compressedLocal,
			cuts: clipLocalCuts,
		});
	}

	private isClipOrTranscriptBoundary({
		clip,
		localTime,
	}: {
		clip: StreamingClip;
		localTime: number;
	}): boolean {
		if (
			localTime <= this.boundaryToleranceSeconds ||
			Math.abs(localTime - clip.duration) <= this.boundaryToleranceSeconds
		) {
			return true;
		}
		const clipLocalCuts = this.getClipLocalTranscriptCuts({ clip });
		if (clipLocalCuts.length === 0) {
			return false;
		}
		const boundaries = buildCompressedCutBoundaryTimes({
			cuts: clipLocalCuts,
		});
		return boundaries.some(
			(boundary) =>
				Math.abs(boundary - localTime) <= this.boundaryToleranceSeconds,
		);
	}

	private getClipLocalTranscriptCuts({
		clip,
	}: {
		clip: StreamingClip;
	}): TranscriptEditCutRange[] {
		if (!clip.transcriptCuts || clip.transcriptCuts.length === 0) return [];
		const trimStart = Math.max(0, clip.trimStart);
		const localCuts: TranscriptEditCutRange[] = [];
		for (const cut of clip.transcriptCuts) {
			const start = cut.start - trimStart;
			const end = cut.end - trimStart;
			if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
			if (end <= 0) continue;
			localCuts.push({
				start: Math.max(0, start),
				end: Math.max(0, end),
				reason: cut.reason,
			});
		}
		return localCuts;
	}
}
