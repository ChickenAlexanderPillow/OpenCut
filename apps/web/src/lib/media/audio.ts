import type {
	AudioElement,
	LibraryAudioElement,
	TimelineElement,
	TimelineTrack,
	TrackAudioEffects,
	UploadAudioElement,
	VideoElement,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import type { TranscriptEditCutRange } from "@/types/transcription";
import { canElementHaveAudio } from "@/lib/timeline/element-utils";
import { canTracktHaveAudio } from "@/lib/timeline";
import { mediaSupportsAudio } from "@/lib/media/media-utils";
import { normalizeTimelineElementForInvariants } from "@/lib/timeline/element-timing";
import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from "mediabunny";
import {
	buildCompressedCutBoundaryTimes,
	mapCompressedTimeToSourceTime,
} from "@/lib/transcript-editor/core";
import { TRANSCRIPT_CUT_AUDIO_SMOOTHING_SECONDS } from "@/lib/transcript-editor/constants";
import { getEffectiveTranscriptCutsForClipWindow } from "@/lib/transcript-editor/snapshot";
import {
	getTranscriptAudioRevisionKey,
	getTranscriptApplied,
	getTranscriptDraft,
} from "@/lib/transcript-editor/state";
import {
	getTrackAudioEffectsFingerprint,
	normalizeTrackAudioEffects,
} from "@/lib/media/track-audio-effects";

const MAX_AUDIO_CHANNELS = 2;
const EXPORT_SAMPLE_RATE = 44100;
const SILENCE_FLOOR = 1e-4;
const COMPANION_ALIGNMENT_TOLERANCE_SECONDS = 0.05;
const COMPANION_OVERLAP_MIN_RATIO = 0.8;
const sharedDecodeContexts = new Map<string, AudioContext>();

export interface TrackAudioLevelSnapshot {
	trackId: string;
	peak: number;
	rms: number;
	rmsDb: number;
	silent: boolean;
}

function getTranscriptDraftLike(
	element: AudioElement | VideoElement,
): AudioElement["transcriptEdit"] | VideoElement["transcriptEdit"] | undefined {
	const draft = getTranscriptDraft(element);
	if (!draft) return undefined;
	return {
		version: draft.version,
		source: draft.source,
		words: draft.words,
		cuts: draft.cuts,
		cutTimeDomain: draft.cutTimeDomain,
		projectionSource: draft.projectionSource,
		segmentsUi: draft.segmentsUi,
		updatedAt: draft.updatedAt,
	};
}

function getAppliedTranscriptCuts(
	element: AudioElement | VideoElement,
): TranscriptEditCutRange[] {
	return getTranscriptApplied(element)?.removedRanges ?? [];
}

function hasStrongRangeOverlap({
	startA,
	endA,
	startB,
	endB,
	minRatio = COMPANION_OVERLAP_MIN_RATIO,
}: {
	startA: number;
	endA: number;
	startB: number;
	endB: number;
	minRatio?: number;
}): boolean {
	const aStart = Math.min(startA, endA);
	const aEnd = Math.max(startA, endA);
	const bStart = Math.min(startB, endB);
	const bEnd = Math.max(startB, endB);
	const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
	if (overlap <= 0) return false;
	const aDuration = Math.max(0.001, aEnd - aStart);
	const bDuration = Math.max(0.001, bEnd - bStart);
	return overlap / Math.min(aDuration, bDuration) >= minRatio;
}

function isAlignedCompanionAudio({
	video,
	audio,
}: {
	video: VideoElement;
	audio: UploadAudioElement;
}): boolean {
	const startAligned =
		Math.abs(video.startTime - audio.startTime) <=
		COMPANION_ALIGNMENT_TOLERANCE_SECONDS;
	const durationAligned =
		Math.abs(video.duration - audio.duration) <=
		COMPANION_ALIGNMENT_TOLERANCE_SECONDS;
	const trimStartAligned =
		Math.abs(video.trimStart - audio.trimStart) <=
		COMPANION_ALIGNMENT_TOLERANCE_SECONDS;
	const trimEndAligned =
		Math.abs(video.trimEnd - audio.trimEnd) <=
		COMPANION_ALIGNMENT_TOLERANCE_SECONDS;
	if (startAligned && durationAligned && trimStartAligned && trimEndAligned) {
		return true;
	}

	return (
		hasStrongRangeOverlap({
			startA: video.startTime,
			endA: video.startTime + video.duration,
			startB: audio.startTime,
			endB: audio.startTime + audio.duration,
		}) &&
		hasStrongRangeOverlap({
			startA: video.trimStart,
			endA: video.trimStart + video.duration,
			startB: audio.trimStart,
			endB: audio.trimStart + audio.duration,
		})
	);
}

function collectSuppressedCompanionMediaIds({
	tracks,
}: {
	tracks: TimelineTrack[];
}): {
	audioIds: Set<string>;
	videoIds: Set<string>;
	preferredVideoMediaIdByAudioId: Map<string, string>;
} {
	const videos: VideoElement[] = [];
	const uploadAudios: UploadAudioElement[] = [];

	for (const track of tracks) {
		if (track.type !== "video" && track.type !== "audio") continue;
		for (const element of track.elements) {
			if (element.type === "video") {
				videos.push(normalizeTimelineElementForInvariants({ element }));
				continue;
			}
			if (element.type === "audio" && element.sourceType === "upload") {
				uploadAudios.push(normalizeTimelineElementForInvariants({ element }));
			}
		}
	}

	const suppressedAudioIds = new Set<string>();
	const suppressedVideoIds = new Set<string>();
	const preferredVideoMediaIdByAudioId = new Map<string, string>();
	for (const audio of uploadAudios) {
		for (const video of videos) {
			if (!isAlignedCompanionAudio({ video, audio })) continue;
			// Prefer the explicit upload audio clip when a paired companion exists.
			// This avoids preview/export drift from mixing embedded video audio with
			// a separately tracked companion waveform/clip.
			suppressedVideoIds.add(video.id);
			preferredVideoMediaIdByAudioId.set(audio.id, video.mediaId);
			if (video.mediaId === audio.mediaId) {
				suppressedAudioIds.add(audio.id);
			}
		}
	}
	return {
		audioIds: suppressedAudioIds,
		videoIds: suppressedVideoIds,
		preferredVideoMediaIdByAudioId,
	};
}

function getSharedDecodeContext({
	sampleRate,
}: {
	sampleRate?: number;
}): AudioContext {
	const key =
		typeof sampleRate === "number" && Number.isFinite(sampleRate)
			? String(Math.floor(sampleRate))
			: "native";
	const existing = sharedDecodeContexts.get(key);
	if (existing && existing.state !== "closed") {
		return existing;
	}
	const created = createAudioContext(
		typeof sampleRate === "number" ? { sampleRate } : undefined,
	);
	sharedDecodeContexts.set(key, created);
	return created;
}

export type CollectedAudioElement = Omit<
	AudioElement,
	"type" | "mediaId" | "volume" | "id" | "name" | "sourceType" | "sourceUrl"
> & {
	trackId: string;
	buffer: AudioBuffer;
	gain: number;
	trackGain: number;
	trackAudioEffects: TrackAudioEffects;
	transcriptCuts?: TranscriptEditCutRange[];
};

export interface AudioTrackProcessing {
	trackId: string;
	trackGain: number;
	trackAudioEffects: TrackAudioEffects;
}

export function createAudioContext({
	sampleRate,
}: {
	sampleRate?: number;
} = {}): AudioContext {
	const AudioContextConstructor =
		window.AudioContext ||
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;

	return new AudioContextConstructor(sampleRate ? { sampleRate } : undefined);
}

export interface DecodedAudio {
	samples: Float32Array;
	sampleRate: number;
}

export function computePeakFromChannels({
	channels,
}: {
	channels: Float32Array[];
}): number {
	let peak = 0;
	for (const channel of channels) {
		for (let i = 0; i < channel.length; i++) {
			const value = Math.abs(channel[i] ?? 0);
			if (value > peak) peak = value;
		}
	}
	return peak;
}

export function isPeakSilent({
	peak,
	floor = SILENCE_FLOOR,
}: {
	peak: number;
	floor?: number;
}): boolean {
	return !Number.isFinite(peak) || peak < floor;
}

function resolveSourceWindowDuration({
	duration,
	cuts,
}: {
	duration: number;
	cuts?: TranscriptEditCutRange[];
}): number {
	if (!cuts || cuts.length === 0) return duration;
	return mapCompressedTimeToSourceTime({
		compressedTime: duration,
		cuts,
	});
}

async function readBlobArrayBufferWithFallback({
	audioBlob,
	fallbackUrl,
}: {
	audioBlob: Blob;
	fallbackUrl?: string;
}): Promise<ArrayBuffer> {
	try {
		return await audioBlob.arrayBuffer();
	} catch (primaryError) {
		if (!fallbackUrl) {
			throw primaryError;
		}

		const response = await fetch(fallbackUrl);
		if (!response.ok) {
			throw primaryError;
		}
		return await response.arrayBuffer();
	}
}

export async function decodeAudioToFloat32({
	audioBlob,
	fallbackUrl,
}: {
	audioBlob: Blob;
	fallbackUrl?: string;
}): Promise<DecodedAudio> {
	const audioContext = createAudioContext();
	const arrayBuffer = await readBlobArrayBufferWithFallback({
		audioBlob,
		fallbackUrl,
	});
	const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));

	// mix down to mono
	const numChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;
	const samples = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		let sum = 0;
		for (let channel = 0; channel < numChannels; channel++) {
			sum += audioBuffer.getChannelData(channel)[i];
		}
		samples[i] = sum / numChannels;
	}

	void audioContext.close().catch(() => undefined);

	return { samples, sampleRate: audioBuffer.sampleRate };
}

export async function collectAudioElements({
	tracks,
	mediaAssets,
	audioContext,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	audioContext: AudioContext;
}): Promise<CollectedAudioElement[]> {
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((media) => [media.id, media]),
	);
	const suppressedCompanionMediaIds = collectSuppressedCompanionMediaIds({
		tracks,
	});
	const pendingElements: Array<Promise<CollectedAudioElement | null>> = [];

	for (const track of tracks) {
		if (canTracktHaveAudio(track) && track.muted) continue;
		const trackProcessing = buildTrackAudioProcessing({ track });

		for (const element of track.elements) {
			const stableElement = normalizeTimelineElementForInvariants({ element });
			if (!canElementHaveAudio(stableElement)) continue;
			if (
				stableElement.type === "audio" &&
				stableElement.sourceType === "upload" &&
				suppressedCompanionMediaIds.audioIds.has(stableElement.id)
			) {
				continue;
			}
			if (
				stableElement.type === "video" &&
				suppressedCompanionMediaIds.videoIds.has(stableElement.id)
			) {
				continue;
			}
			if (stableElement.duration <= 0) continue;
			const effectiveTranscriptCuts = getAppliedTranscriptCuts(stableElement);

			const isTrackMuted = canTracktHaveAudio(track) && track.muted;

			if (stableElement.type === "audio") {
				pendingElements.push(
					(async () => {
						const elementGain = clampGain(stableElement.volume ?? 1);
						if (stableElement.sourceType === "upload") {
							const preferredVideoMediaId =
								suppressedCompanionMediaIds.preferredVideoMediaIdByAudioId.get(
									stableElement.id,
								);
							const mediaAsset = mediaMap.get(
								preferredVideoMediaId ?? stableElement.mediaId,
							);
							if (!mediaAsset) {
								// Fallback for transient states where media metadata is not yet available.
								if (stableElement.buffer) {
									return {
										trackId: track.id,
										buffer: stableElement.buffer,
										startTime: stableElement.startTime,
										duration: stableElement.duration,
										trimStart: stableElement.trimStart,
										trimEnd: stableElement.trimEnd,
										transcriptCuts: effectiveTranscriptCuts,
										muted: stableElement.muted || isTrackMuted,
										gain: elementGain,
										trackGain: trackProcessing.trackGain,
										trackAudioEffects: trackProcessing.trackAudioEffects,
									};
								}
								return null;
							}
							if (mediaAsset?.type === "video") {
								const resolvedAudio = await resolveAudioBufferForVideoElement({
									mediaAsset,
									audioContext,
									trimStart: stableElement.trimStart,
									trimDuration: resolveSourceWindowDuration({
										duration: stableElement.duration,
										cuts: effectiveTranscriptCuts,
									}),
								});
								if (!resolvedAudio) return null;
								return {
									trackId: track.id,
									buffer: resolvedAudio.buffer,
									startTime: stableElement.startTime,
									duration: stableElement.duration,
									// If decode is windowed, trimStart is already baked into the buffer.
									// For full-file fallback decode, preserve element trimStart.
									trimStart: resolvedAudio.windowed ? 0 : stableElement.trimStart,
									trimEnd: stableElement.trimEnd,
									transcriptCuts: effectiveTranscriptCuts,
									muted: stableElement.muted || isTrackMuted,
									gain: elementGain,
									trackGain: trackProcessing.trackGain,
									trackAudioEffects: trackProcessing.trackAudioEffects,
								};
							}
						}
						if (stableElement.buffer) {
							return {
								trackId: track.id,
								buffer: stableElement.buffer,
								startTime: stableElement.startTime,
								duration: stableElement.duration,
								trimStart: stableElement.trimStart,
								trimEnd: stableElement.trimEnd,
								transcriptCuts: effectiveTranscriptCuts,
								muted: stableElement.muted || isTrackMuted,
								gain: elementGain,
								trackGain: trackProcessing.trackGain,
								trackAudioEffects: trackProcessing.trackAudioEffects,
							};
						}

						const audioBuffer = await resolveAudioBufferForElement({
							element: stableElement,
							mediaMap,
							audioContext,
						});
						if (!audioBuffer) return null;
						return {
							trackId: track.id,
							buffer: audioBuffer,
							startTime: stableElement.startTime,
							duration: stableElement.duration,
							trimStart: stableElement.trimStart,
							trimEnd: stableElement.trimEnd,
							transcriptCuts: effectiveTranscriptCuts,
							muted: stableElement.muted || isTrackMuted,
							gain: elementGain,
							trackGain: trackProcessing.trackGain,
							trackAudioEffects: trackProcessing.trackAudioEffects,
						};
					})(),
				);
				continue;
			}

			if (stableElement.type === "video") {
				const mediaAsset = mediaMap.get(stableElement.mediaId);
				if (!mediaAsset || !mediaSupportsAudio({ media: mediaAsset })) continue;

				pendingElements.push(
					resolveAudioBufferForVideoElement({
						mediaAsset,
						audioContext,
						trimStart: stableElement.trimStart,
						trimDuration: resolveSourceWindowDuration({
							duration: stableElement.duration,
							cuts: effectiveTranscriptCuts,
						}),
					}).then((resolvedAudio) => {
						if (!resolvedAudio) return null;
						const elementMuted = stableElement.muted ?? false;
						// If decode is windowed, trimStart is already baked into the buffer.
						// For full-file fallback decode, preserve element trimStart.
						return {
							trackId: track.id,
							buffer: resolvedAudio.buffer,
							startTime: stableElement.startTime,
							duration: stableElement.duration,
							trimStart: resolvedAudio.windowed ? 0 : stableElement.trimStart,
							trimEnd: stableElement.trimEnd,
							transcriptCuts: effectiveTranscriptCuts,
							muted: elementMuted || isTrackMuted,
							gain: 1,
							trackGain: trackProcessing.trackGain,
							trackAudioEffects: trackProcessing.trackAudioEffects,
						};
					}),
				);
			}
		}
	}

	const resolvedElements = await Promise.all(pendingElements);
	const audioElements: CollectedAudioElement[] = [];
	for (const element of resolvedElements) {
		if (element) audioElements.push(element);
	}
	return audioElements;
}

async function resolveAudioBufferForElement({
	element,
	mediaMap,
	audioContext,
}: {
	element: AudioElement;
	mediaMap: Map<string, MediaAsset>;
	audioContext: AudioContext;
}): Promise<AudioBuffer | null> {
		try {
			if (element.buffer) return element.buffer;
			const effectiveTranscriptCuts = getAppliedTranscriptCuts(element);

		if (element.sourceType === "upload") {
			const asset = mediaMap.get(element.mediaId);
			if (!asset || (asset.type !== "audio" && asset.type !== "video"))
				return null;

			if (asset.type === "video") {
				const resolved = await resolveAudioBufferForVideoElement({
					mediaAsset: asset,
					audioContext,
					trimStart: element.trimStart,
					trimDuration: resolveSourceWindowDuration({
						duration: element.duration,
						cuts: effectiveTranscriptCuts,
					}),
				});
				return resolved?.buffer ?? null;
			}

			const arrayBuffer = await readBlobArrayBufferWithFallback({
				audioBlob: asset.file,
				fallbackUrl: asset.url,
			});
			return await audioContext.decodeAudioData(arrayBuffer.slice(0));
		}

		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		return await audioContext.decodeAudioData(arrayBuffer.slice(0));
	} catch (error) {
		console.warn("Failed to decode audio:", error);
		return null;
	}
}

async function resolveAudioBufferForVideoElement({
	mediaAsset,
	audioContext,
	trimStart = 0,
	trimDuration,
}: {
	mediaAsset: MediaAsset;
	audioContext: AudioContext;
	trimStart?: number;
	trimDuration?: number;
}): Promise<{ buffer: AudioBuffer; windowed: boolean } | null> {
	const input = new Input({
		source: new BlobSource(mediaAsset.file),
		formats: ALL_FORMATS,
	});

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return null;

		const sink = new AudioBufferSink(audioTrack);
		const targetSampleRate = audioContext.sampleRate;

		const chunks: AudioBuffer[] = [];
		let totalSamples = 0;

		const safeTrimStart = Math.max(0, trimStart);
		const safeTrimDuration =
			typeof trimDuration === "number" && Number.isFinite(trimDuration)
				? Math.max(0, trimDuration)
				: undefined;
		const trimEnd =
			typeof safeTrimDuration === "number"
				? safeTrimStart + safeTrimDuration
				: undefined;

		for await (const { buffer } of sink.buffers(safeTrimStart, trimEnd)) {
			chunks.push(buffer);
			totalSamples += buffer.length;
		}

		if (chunks.length === 0) return null;

		const nativeSampleRate = chunks[0].sampleRate;
		const numChannels = Math.min(
			MAX_AUDIO_CHANNELS,
			chunks[0].numberOfChannels,
		);

		const nativeChannels = Array.from(
			{ length: numChannels },
			() => new Float32Array(totalSamples),
		);
		let offset = 0;
		for (const chunk of chunks) {
			for (let channel = 0; channel < numChannels; channel++) {
				const sourceData = chunk.getChannelData(
					Math.min(channel, chunk.numberOfChannels - 1),
				);
				nativeChannels[channel].set(sourceData, offset);
			}
			offset += chunk.length;
		}

		// use OfflineAudioContext for high-quality resampling to target rate
		const outputSamples = Math.ceil(
			totalSamples * (targetSampleRate / nativeSampleRate),
		);
		const offlineContext = new OfflineAudioContext(
			numChannels,
			outputSamples,
			targetSampleRate,
		);

		const nativeBuffer = audioContext.createBuffer(
			numChannels,
			totalSamples,
			nativeSampleRate,
		);
		for (let ch = 0; ch < numChannels; ch++) {
			nativeBuffer.copyToChannel(nativeChannels[ch], ch);
		}

		const sourceNode = offlineContext.createBufferSource();
		sourceNode.buffer = nativeBuffer;
		sourceNode.connect(offlineContext.destination);
		sourceNode.start(0);

		const rendered = await offlineContext.startRendering();
		const renderedChannels = Array.from(
			{ length: rendered.numberOfChannels },
			(_, channel) => rendered.getChannelData(channel),
		);
		const renderedPeak = computePeakFromChannels({
			channels: renderedChannels,
		});
		// Some codec/container combos decode as near-silence through mediabunny while
		// browser decodeAudioData succeeds; force fallback in that case.
		if (isPeakSilent({ peak: renderedPeak })) {
			throw new Error(
				"Decoded near-silent audio via mediabunny; trying browser fallback",
			);
		}

		return {
			buffer: rendered,
			windowed: true,
		};
	} catch (error) {
		console.warn(
			"Failed to decode video audio with mediabunny, trying fallback:",
			error,
		);
		try {
			const arrayBuffer = await readBlobArrayBufferWithFallback({
				audioBlob: mediaAsset.file,
				fallbackUrl: mediaAsset.url,
			});
			return {
				buffer: await audioContext.decodeAudioData(arrayBuffer.slice(0)),
				windowed: false,
			};
		} catch (fallbackError) {
			console.warn("Video audio fallback decode failed:", fallbackError);
			return null;
		}
	} finally {
		input.dispose();
	}
}

interface AudioMixSource {
	trackId: string;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	gain: number;
	trackGain: number;
	trackAudioEffects: TrackAudioEffects;
	transcriptCuts?: TranscriptEditCutRange[];
}

export interface AudioClipSource {
	id: string;
	sourceKey: string;
	trackId: string;
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
	trackGain: number;
	trackAudioEffects: TrackAudioEffects;
	transcriptRevision: string;
	transcriptCuts?: TranscriptEditCutRange[];
}

function buildTranscriptAudioRevision({
	transcriptRevisionKey,
}: {
	transcriptRevisionKey?: string;
}): string {
	return transcriptRevisionKey ?? "";
}

function clampGain(value: number): number {
	return Math.max(0, Math.min(2, value));
}

export function mapTrackVolumeToGain(trackVolume: number): number {
	const clamped = clampGain(trackVolume);
	// Perceptual taper: low control values attenuate more strongly.
	if (clamped <= 1) {
		return clamped * clamped * clamped;
	}
	return 1 + (clamped - 1);
}

function dbToGain(value: number): number {
	return 10 ** (value / 20);
}

export function buildTrackAudioProcessing({
	track,
}: {
	track: TimelineTrack;
}): AudioTrackProcessing {
	const normalizedEffects = normalizeTrackAudioEffects(
		canTracktHaveAudio(track) ? track.audioEffects : undefined,
	);
	return {
		trackId: track.id,
		trackGain:
			canTracktHaveAudio(track) && !track.muted
				? mapTrackVolumeToGain(track.volume ?? 1)
				: 0,
		trackAudioEffects: normalizedEffects,
	};
}

export function connectTrackAudioEffects({
	audioContext,
	sourceNode,
	destinationNode,
	effects,
	trackGain,
}: {
	audioContext: AudioContext | OfflineAudioContext;
	sourceNode: AudioNode;
	destinationNode: AudioNode;
	effects: TrackAudioEffects;
	trackGain: number;
}): {
	inputNode: AudioNode;
	outputNode: GainNode;
	analyserNode: AnalyserNode;
} {
	let cursor: AudioNode = sourceNode;

	const lowShelf = audioContext.createBiquadFilter();
	lowShelf.type = "lowshelf";
	lowShelf.frequency.value = 180;
	lowShelf.gain.value = effects.eq.enabled ? effects.eq.lowGainDb : 0;
	cursor.connect(lowShelf);
	cursor = lowShelf;

	const midPeak = audioContext.createBiquadFilter();
	midPeak.type = "peaking";
	midPeak.frequency.value = effects.eq.midFrequency;
	midPeak.Q.value = 0.9;
	midPeak.gain.value = effects.eq.enabled ? effects.eq.midGainDb : 0;
	cursor.connect(midPeak);
	cursor = midPeak;

	const highShelf = audioContext.createBiquadFilter();
	highShelf.type = "highshelf";
	highShelf.frequency.value = effects.eq.highFrequency;
	highShelf.gain.value = effects.eq.enabled ? effects.eq.highGainDb : 0;
	cursor.connect(highShelf);
	cursor = highShelf;

	const deesser = audioContext.createBiquadFilter();
	deesser.type = "peaking";
	deesser.frequency.value = effects.deesser.frequency;
	deesser.Q.value = effects.deesser.q;
	deesser.gain.value = effects.deesser.enabled ? -effects.deesser.amountDb : 0;
	cursor.connect(deesser);
	cursor = deesser;

	const compressor = audioContext.createDynamicsCompressor();
	compressor.threshold.value = effects.compressor.enabled
		? effects.compressor.thresholdDb
		: 0;
	compressor.knee.value = effects.compressor.enabled ? 12 : 0;
	compressor.ratio.value = effects.compressor.enabled
		? effects.compressor.ratio
		: 1;
	compressor.attack.value = effects.compressor.attackSeconds;
	compressor.release.value = effects.compressor.releaseSeconds;
	cursor.connect(compressor);
	cursor = compressor;

	const makeupGain = audioContext.createGain();
	makeupGain.gain.value = effects.compressor.enabled
		? dbToGain(effects.compressor.makeupGainDb)
		: 1;
	cursor.connect(makeupGain);
	cursor = makeupGain;

	const limiter = audioContext.createDynamicsCompressor();
	limiter.threshold.value = effects.limiter.enabled
		? effects.limiter.ceilingDb
		: 0;
	limiter.knee.value = effects.limiter.enabled ? 0 : 40;
	limiter.ratio.value = effects.limiter.enabled ? 20 : 1;
	limiter.attack.value = effects.limiter.enabled ? 0.001 : 0.01;
	limiter.release.value = effects.limiter.releaseSeconds;
	cursor.connect(limiter);
	cursor = limiter;

	const outputGain = audioContext.createGain();
	outputGain.gain.value = trackGain;
	cursor.connect(outputGain);

	const analyserNode = audioContext.createAnalyser();
	analyserNode.fftSize = 1024;
	analyserNode.smoothingTimeConstant = 0.45;
	outputGain.connect(analyserNode);
	analyserNode.connect(destinationNode);

	return {
		inputNode: sourceNode,
		outputNode: outputGain,
		analyserNode,
	};
}

export async function renderTrackAudioEffectsOffline({
	buffer,
	effects,
	trackGain,
}: {
	buffer: AudioBuffer;
	effects: TrackAudioEffects;
	trackGain: number;
}): Promise<AudioBuffer> {
	if (buffer.length === 0) return buffer;
	const offlineContext = new OfflineAudioContext(
		buffer.numberOfChannels,
		buffer.length,
		buffer.sampleRate,
	);
	const source = offlineContext.createBufferSource();
	source.buffer = buffer;
	connectTrackAudioEffects({
		audioContext: offlineContext,
		sourceNode: source,
		destinationNode: offlineContext.destination,
		effects,
		trackGain,
	});
	source.start(0);
	return offlineContext.startRendering();
}

function getBoundarySmoothingGain({
	compressedTime,
	boundaries,
	fadeSeconds,
	boundaryIndex,
}: {
	compressedTime: number;
	boundaries: number[];
	fadeSeconds: number;
	boundaryIndex: number;
}): { gain: number; boundaryIndex: number } {
	if (boundaries.length === 0 || fadeSeconds <= 0) {
		return { gain: 1, boundaryIndex };
	}
	let nextBoundaryIndex = Math.max(0, boundaryIndex);
	while (
		nextBoundaryIndex < boundaries.length - 1 &&
		compressedTime > boundaries[nextBoundaryIndex + 1]
	) {
		nextBoundaryIndex += 1;
	}
	let nearestDistance = Number.POSITIVE_INFINITY;
	const currentBoundary = boundaries[nextBoundaryIndex];
	if (typeof currentBoundary === "number") {
		nearestDistance = Math.min(
			nearestDistance,
			Math.abs(compressedTime - currentBoundary),
		);
	}
	const nextBoundary = boundaries[nextBoundaryIndex + 1];
	if (typeof nextBoundary === "number") {
		nearestDistance = Math.min(
			nearestDistance,
			Math.abs(compressedTime - nextBoundary),
		);
	}
	if (nearestDistance >= fadeSeconds) {
		return { gain: 1, boundaryIndex: nextBoundaryIndex };
	}
	return {
		gain: Math.max(0, nearestDistance / fadeSeconds),
		boundaryIndex: nextBoundaryIndex,
	};
}

export async function decodeMediaFileToAudioBuffer({
	file,
	sampleRate,
	trimStart = 0,
	trimDuration,
}: {
	file: File;
	sampleRate?: number;
	trimStart?: number;
	trimDuration?: number;
}): Promise<AudioBuffer | null> {
	const context = getSharedDecodeContext({
		sampleRate: typeof sampleRate === "number" ? sampleRate : undefined,
	});
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const safeTrimStart = Number.isFinite(trimStart)
			? Math.max(0, trimStart)
			: 0;
		const safeTrimDuration =
			typeof trimDuration === "number" && Number.isFinite(trimDuration)
				? Math.max(0, trimDuration)
				: undefined;
		const trimEnd =
			typeof safeTrimDuration === "number"
				? safeTrimStart + safeTrimDuration
				: undefined;

		const audioTrack = await input.getPrimaryAudioTrack();
		if (audioTrack) {
			const sink = new AudioBufferSink(audioTrack);
			const chunks: AudioBuffer[] = [];
			let totalSamples = 0;
			for await (const { buffer } of sink.buffers(safeTrimStart, trimEnd)) {
				chunks.push(buffer);
				totalSamples += buffer.length;
			}
			if (chunks.length > 0 && totalSamples > 0) {
				const first = chunks[0];
				const channels = Math.max(1, first.numberOfChannels);
				const merged = context.createBuffer(
					channels,
					totalSamples,
					first.sampleRate,
				);
				for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
					const channelData = new Float32Array(totalSamples);
					let offset = 0;
					for (const chunk of chunks) {
						const sourceChannel = Math.min(
							channelIndex,
							chunk.numberOfChannels - 1,
						);
						channelData.set(chunk.getChannelData(sourceChannel), offset);
						offset += chunk.length;
					}
					merged.copyToChannel(channelData, channelIndex);
				}
				const mergedChannels = Array.from(
					{ length: merged.numberOfChannels },
					(_, channelIndex) => merged.getChannelData(channelIndex),
				);
				const mergedPeak = computePeakFromChannels({
					channels: mergedChannels,
				});
				if (!isPeakSilent({ peak: mergedPeak })) {
					return merged;
				}
			}
		}

		const arrayBuffer = await file.arrayBuffer();
		const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
		if (typeof safeTrimDuration !== "number") {
			return decoded;
		}
		const startSample = Math.max(
			0,
			Math.floor(safeTrimStart * decoded.sampleRate),
		);
		const endSample = Math.max(
			startSample,
			Math.min(
				decoded.length,
				Math.ceil((safeTrimStart + safeTrimDuration) * decoded.sampleRate),
			),
		);
		const sliceLength = Math.max(0, endSample - startSample);
		if (sliceLength <= 0) return null;
		const sliced = context.createBuffer(
			decoded.numberOfChannels,
			sliceLength,
			decoded.sampleRate,
		);
		for (
			let channelIndex = 0;
			channelIndex < decoded.numberOfChannels;
			channelIndex++
		) {
			const source = decoded.getChannelData(channelIndex);
			sliced.copyToChannel(
				source.subarray(startSample, endSample),
				channelIndex,
				0,
			);
		}
		return sliced;
	} catch (error) {
		console.warn("Failed to decode media file to audio buffer:", error);
		return null;
	} finally {
		input.dispose();
	}
}

async function fetchLibraryAudioSource({
	element,
	gain,
	trackId,
	trackGain,
	trackAudioEffects,
}: {
	element: LibraryAudioElement;
	gain: number;
	trackId: string;
	trackGain: number;
	trackAudioEffects: TrackAudioEffects;
}): Promise<AudioMixSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			trackId,
			file,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			gain,
			trackGain,
			trackAudioEffects,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

async function fetchLibraryAudioClip({
	element,
	muted,
	gain,
	trackId,
	trackGain,
	trackAudioEffects,
}: {
	element: LibraryAudioElement;
	muted: boolean;
	gain: number;
	trackId: string;
	trackGain: number;
	trackAudioEffects: TrackAudioEffects;
}): Promise<AudioClipSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			id: element.id,
			sourceKey: element.id,
			trackId,
			file,
			mediaIdentity: {
				id: element.id,
				type: "library-audio",
				size: file.size,
				lastModified: file.lastModified,
			},
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			muted,
			gain,
			trackGain,
			trackAudioEffects,
			transcriptRevision: buildTranscriptAudioRevision({
				transcriptRevisionKey: getTranscriptAudioRevisionKey(element),
			}),
			transcriptCuts: getAppliedTranscriptCuts(element),
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

function collectMediaAudioSource({
	element,
	mediaAsset,
	gain,
	trackId,
	trackGain,
	trackAudioEffects,
}: {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset;
	gain: number;
	trackId: string;
	trackGain: number;
	trackAudioEffects: TrackAudioEffects;
}): AudioMixSource {
	const stableElement = normalizeTimelineElementForInvariants({ element });
	return {
		trackId,
		file: mediaAsset.file,
		startTime: stableElement.startTime,
		duration: stableElement.duration,
		trimStart: stableElement.trimStart,
		trimEnd: stableElement.trimEnd,
		gain,
		trackGain,
		trackAudioEffects,
		transcriptCuts: getAppliedTranscriptCuts(stableElement),
	};
}

function collectMediaAudioClip({
	element,
	mediaAsset,
	muted,
	gain,
	trackId,
	trackGain,
	trackAudioEffects,
}: {
	element: TimelineElement;
	mediaAsset: MediaAsset;
	muted: boolean;
	gain: number;
	trackId: string;
	trackGain: number;
	trackAudioEffects: TrackAudioEffects;
}): AudioClipSource {
	const stableElement = normalizeTimelineElementForInvariants({
		element,
	});
	return {
		id: stableElement.id,
		sourceKey: mediaAsset.id,
		trackId,
		file: mediaAsset.file,
		mediaIdentity: {
			id: mediaAsset.id,
			type: mediaAsset.type,
			size: mediaAsset.file.size,
			lastModified: mediaAsset.file.lastModified,
		},
		startTime: stableElement.startTime,
		duration: stableElement.duration,
		trimStart: stableElement.trimStart,
		trimEnd: stableElement.trimEnd,
		muted,
		gain,
		trackGain,
		trackAudioEffects,
		transcriptRevision:
			"transcriptApplied" in stableElement || "transcriptEdit" in stableElement
				? buildTranscriptAudioRevision({
						transcriptRevisionKey: getTranscriptAudioRevisionKey(
							stableElement as AudioElement | VideoElement,
						),
					})
				: "",
		transcriptCuts:
			"transcriptApplied" in stableElement || "transcriptEdit" in stableElement
				? getAppliedTranscriptCuts(stableElement as AudioElement | VideoElement)
				: [],
	};
}

export async function collectAudioMixSources({
	tracks,
	mediaAssets,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
}): Promise<AudioMixSource[]> {
	const audioMixSources: AudioMixSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const suppressedCompanionMediaIds = collectSuppressedCompanionMediaIds({
		tracks,
	});
	const pendingLibrarySources: Array<Promise<AudioMixSource | null>> = [];

	for (const track of tracks) {
		if (canTracktHaveAudio(track) && track.muted) continue;
		const trackProcessing = buildTrackAudioProcessing({ track });

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (
				element.type === "audio" &&
				element.sourceType === "upload" &&
				suppressedCompanionMediaIds.audioIds.has(element.id)
			) {
				continue;
			}
			if (
				element.type === "video" &&
				suppressedCompanionMediaIds.videoIds.has(element.id)
			) {
				continue;
			}
			const isElementMuted =
				"muted" in element ? (element.muted ?? false) : false;
			if (isElementMuted) continue;

			if (element.type === "audio") {
				const elementGain = clampGain(element.volume ?? 1);
				if (element.sourceType === "upload") {
					const preferredVideoMediaId =
						suppressedCompanionMediaIds.preferredVideoMediaIdByAudioId.get(
							element.id,
						);
					const mediaAsset = mediaMap.get(
						preferredVideoMediaId ?? element.mediaId,
					);
					if (!mediaAsset) continue;

					audioMixSources.push(
						collectMediaAudioSource({
							element,
							mediaAsset,
							gain: elementGain,
							trackId: track.id,
							trackGain: trackProcessing.trackGain,
							trackAudioEffects: trackProcessing.trackAudioEffects,
						}),
					);
				} else {
					pendingLibrarySources.push(
						fetchLibraryAudioSource({
							element,
							gain: elementGain,
							trackId: track.id,
							trackGain: trackProcessing.trackGain,
							trackAudioEffects: trackProcessing.trackAudioEffects,
						}),
					);
				}
				continue;
			}

			if (element.type === "video") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset) continue;

				if (mediaSupportsAudio({ media: mediaAsset })) {
					audioMixSources.push(
						collectMediaAudioSource({
							element,
							mediaAsset,
							gain: 1,
							trackId: track.id,
							trackGain: trackProcessing.trackGain,
							trackAudioEffects: trackProcessing.trackAudioEffects,
						}),
					);
				}
			}
		}
	}

	const resolvedLibrarySources = await Promise.all(pendingLibrarySources);
	for (const source of resolvedLibrarySources) {
		if (source) audioMixSources.push(source);
	}

	return audioMixSources;
}

export async function collectAudioClips({
	tracks,
	mediaAssets,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
}): Promise<AudioClipSource[]> {
	const clips: AudioClipSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const suppressedCompanionMediaIds = collectSuppressedCompanionMediaIds({
		tracks,
	});
	const pendingLibraryClips: Array<Promise<AudioClipSource | null>> = [];

	for (const track of tracks) {
		const isTrackMuted = canTracktHaveAudio(track) && track.muted;
		const trackProcessing = buildTrackAudioProcessing({ track });

		for (const element of track.elements) {
			const stableElement = normalizeTimelineElementForInvariants({ element });
			if (!canElementHaveAudio(stableElement)) continue;
			if (
				stableElement.type === "audio" &&
				stableElement.sourceType === "upload" &&
				suppressedCompanionMediaIds.audioIds.has(stableElement.id)
			) {
				continue;
			}
			if (
				stableElement.type === "video" &&
				suppressedCompanionMediaIds.videoIds.has(stableElement.id)
			) {
				continue;
			}

			const isElementMuted =
				"muted" in stableElement ? (stableElement.muted ?? false) : false;
			const muted = isTrackMuted || isElementMuted;

			if (stableElement.type === "audio") {
				const elementGain = clampGain(stableElement.volume ?? 1);
				if (stableElement.sourceType === "upload") {
					const preferredVideoMediaId =
						suppressedCompanionMediaIds.preferredVideoMediaIdByAudioId.get(
							stableElement.id,
						);
					const mediaAsset = mediaMap.get(
						preferredVideoMediaId ?? stableElement.mediaId,
					);
					if (!mediaAsset) continue;

					clips.push(
						collectMediaAudioClip({
							element: stableElement,
							mediaAsset,
							muted,
							gain: elementGain,
							trackId: track.id,
							trackGain: trackProcessing.trackGain,
							trackAudioEffects: trackProcessing.trackAudioEffects,
						}),
					);
				} else {
					pendingLibraryClips.push(
						fetchLibraryAudioClip({
							element: stableElement,
							muted,
							gain: elementGain,
							trackId: track.id,
							trackGain: trackProcessing.trackGain,
							trackAudioEffects: trackProcessing.trackAudioEffects,
						}),
					);
				}
				continue;
			}

			if (stableElement.type === "video") {
				const mediaAsset = mediaMap.get(stableElement.mediaId);
				if (!mediaAsset) continue;

				if (mediaSupportsAudio({ media: mediaAsset })) {
					clips.push(
						collectMediaAudioClip({
							element: stableElement,
							mediaAsset,
							muted,
							gain: 1,
							trackId: track.id,
							trackGain: trackProcessing.trackGain,
							trackAudioEffects: trackProcessing.trackAudioEffects,
						}),
					);
				}
			}
		}
	}

	const resolvedLibraryClips = await Promise.all(pendingLibraryClips);
	for (const clip of resolvedLibraryClips) {
		if (clip) clips.push(clip);
	}

	return clips;
}

export async function createTimelineAudioBuffer({
	tracks,
	mediaAssets,
	duration,
	startTime = 0,
	sampleRate = EXPORT_SAMPLE_RATE,
	audioContext,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	duration: number;
	startTime?: number;
	sampleRate?: number;
	audioContext?: AudioContext;
}): Promise<AudioBuffer | null> {
	const context = audioContext ?? createAudioContext({ sampleRate });
	const ownsContext = !audioContext;
	try {
		const audioElements = await collectAudioElements({
			tracks,
			mediaAssets,
			audioContext: context,
		});

		if (audioElements.length === 0) return null;

		const outputChannels = 2;
		const outputLength = Math.ceil(duration * sampleRate);
		const outputBuffer = context.createBuffer(outputChannels, outputLength, sampleRate);
		const elementsByTrack = new Map<
			string,
			{
				elements: CollectedAudioElement[];
				trackGain: number;
				trackAudioEffects: TrackAudioEffects;
			}
		>();

		for (const element of audioElements) {
			if (element.muted) continue;
			const existing = elementsByTrack.get(element.trackId);
			if (existing) {
				existing.elements.push(element);
				continue;
			}
			elementsByTrack.set(element.trackId, {
				elements: [element],
				trackGain: element.trackGain,
				trackAudioEffects: element.trackAudioEffects,
			});
		}

		for (const {
			elements,
			trackGain,
			trackAudioEffects,
		} of elementsByTrack.values()) {
			const trackBuffer = context.createBuffer(
				outputChannels,
				outputLength,
				sampleRate,
			);
			for (const element of elements) {
				mixAudioChannels({
					element,
					outputBuffer: trackBuffer,
					outputLength,
					sampleRate,
					outputStartTime: startTime,
				});
			}
			const processedTrackBuffer = await renderTrackAudioEffectsOffline({
				buffer: trackBuffer,
				effects: trackAudioEffects,
				trackGain,
			});
			mixRenderedTrackBuffer({
				sourceBuffer: processedTrackBuffer,
				targetBuffer: outputBuffer,
			});
		}

		return outputBuffer;
	} finally {
		if (ownsContext) {
			void context.close().catch(() => undefined);
		}
	}
}

function mixRenderedTrackBuffer({
	sourceBuffer,
	targetBuffer,
}: {
	sourceBuffer: AudioBuffer;
	targetBuffer: AudioBuffer;
}): void {
	const channelCount = Math.min(
		sourceBuffer.numberOfChannels,
		targetBuffer.numberOfChannels,
	);
	const sampleCount = Math.min(sourceBuffer.length, targetBuffer.length);
	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		const source = sourceBuffer.getChannelData(channelIndex);
		const target = targetBuffer.getChannelData(channelIndex);
		for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
			target[sampleIndex] += source[sampleIndex] ?? 0;
		}
	}
}

function mixAudioChannels({
	element,
	outputBuffer,
	outputLength,
	sampleRate,
	outputStartTime,
}: {
	element: CollectedAudioElement;
	outputBuffer: AudioBuffer;
	outputLength: number;
	sampleRate: number;
	outputStartTime: number;
}): void {
	const { buffer, startTime, trimStart, duration: elementDuration } = element;
	const gain = clampGain(element.gain);
	const transcriptCuts = element.transcriptCuts ?? [];
	const cutBoundaries =
		transcriptCuts.length > 0
			? buildCompressedCutBoundaryTimes({ cuts: transcriptCuts })
			: [];

	const sourceStartSample = Math.floor(trimStart * buffer.sampleRate);
	const outputStartSample = Math.floor((startTime - outputStartTime) * sampleRate);
	const resampledLength = Math.floor(elementDuration * sampleRate);

	const outputChannels = 2;
	for (let channel = 0; channel < outputChannels; channel++) {
		const outputData = outputBuffer.getChannelData(channel);
		const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
		const sourceData = buffer.getChannelData(sourceChannel);
		let boundaryIndex = 0;

		for (let i = 0; i < resampledLength; i++) {
			const outputIndex = outputStartSample + i;
			if (outputIndex < 0) continue;
			if (outputIndex >= outputLength) break;

			const elapsedInTimelineSeconds = i / sampleRate;
			const sourceElapsedSeconds =
				transcriptCuts.length > 0
					? mapCompressedTimeToSourceTime({
							compressedTime: elapsedInTimelineSeconds,
							cuts: transcriptCuts,
						})
					: elapsedInTimelineSeconds;
			const sourcePosition =
				sourceStartSample + sourceElapsedSeconds * buffer.sampleRate;
			const leftIndex = Math.floor(sourcePosition);
			if (leftIndex >= sourceData.length) break;
			const rightIndex = Math.min(leftIndex + 1, sourceData.length - 1);
			const alpha = sourcePosition - leftIndex;
			const leftSample = sourceData[leftIndex] ?? 0;
			const rightSample = sourceData[rightIndex] ?? leftSample;
			const sample = leftSample * (1 - alpha) + rightSample * alpha;
			const smoothing =
				cutBoundaries.length > 0
					? getBoundarySmoothingGain({
							compressedTime: elapsedInTimelineSeconds,
							boundaries: cutBoundaries,
							fadeSeconds: TRANSCRIPT_CUT_AUDIO_SMOOTHING_SECONDS,
							boundaryIndex,
						})
					: { gain: 1, boundaryIndex };
			boundaryIndex = smoothing.boundaryIndex;

			outputData[outputIndex] += sample * gain * smoothing.gain;
		}
	}
}
