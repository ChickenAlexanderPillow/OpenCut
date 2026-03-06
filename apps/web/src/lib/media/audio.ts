import type {
	AudioElement,
	LibraryAudioElement,
	TimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import type { TranscriptEditCutRange } from "@/types/transcription";
import { canElementHaveAudio } from "@/lib/timeline/element-utils";
import { canTracktHaveAudio } from "@/lib/timeline";
import { mediaSupportsAudio } from "@/lib/media/media-utils";
import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from "mediabunny";
import {
	buildCompressedCutBoundaryTimes,
	mapCompressedTimeToSourceTime,
} from "@/lib/transcript-editor/core";
import { TRANSCRIPT_CUT_AUDIO_SMOOTHING_SECONDS } from "@/lib/transcript-editor/constants";
import { getEffectiveTranscriptCutsForClipWindow } from "@/lib/transcript-editor/snapshot";

const MAX_AUDIO_CHANNELS = 2;
const EXPORT_SAMPLE_RATE = 44100;
const SILENCE_FLOOR = 1e-4;
const sharedDecodeContexts = new Map<string, AudioContext>();

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
	buffer: AudioBuffer;
	gain: number;
	transcriptCuts?: TranscriptEditCutRange[];
};

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
	const pendingElements: Array<Promise<CollectedAudioElement | null>> = [];

	for (const track of tracks) {
		if (canTracktHaveAudio(track) && track.muted) continue;
		const trackGain = canTracktHaveAudio(track)
			? mapTrackVolumeToGain(track.volume ?? 1)
			: 1;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (element.duration <= 0) continue;
			const effectiveTranscriptCuts =
				getEffectiveTranscriptCutsForClipWindow({
					transcriptEdit: element.transcriptEdit,
					trimStart: element.trimStart,
				});

			const isTrackMuted = canTracktHaveAudio(track) && track.muted;

			if (element.type === "audio") {
				pendingElements.push(
					(async () => {
						const elementGain = trackGain * clampGain(element.volume ?? 1);
						if (element.sourceType === "upload") {
							const mediaAsset = mediaMap.get(element.mediaId);
							if (!mediaAsset) {
								// Fallback for transient states where media metadata is not yet available.
								if (element.buffer) {
									return {
										buffer: element.buffer,
										startTime: element.startTime,
										duration: element.duration,
										trimStart: element.trimStart,
										trimEnd: element.trimEnd,
										transcriptCuts: effectiveTranscriptCuts,
										muted: element.muted || isTrackMuted,
										gain: elementGain,
									};
								}
								return null;
							}
							if (mediaAsset?.type === "video") {
								const resolvedAudio = await resolveAudioBufferForVideoElement({
									mediaAsset,
									audioContext,
									trimStart: element.trimStart,
									trimDuration: resolveSourceWindowDuration({
										duration: element.duration,
										cuts: effectiveTranscriptCuts,
									}),
								});
								if (!resolvedAudio) return null;
								return {
									buffer: resolvedAudio.buffer,
									startTime: element.startTime,
									duration: element.duration,
									// If decode is windowed, trimStart is already baked into the buffer.
									// For full-file fallback decode, preserve element trimStart.
									trimStart: resolvedAudio.windowed ? 0 : element.trimStart,
									trimEnd: element.trimEnd,
									transcriptCuts: effectiveTranscriptCuts,
									muted: element.muted || isTrackMuted,
									gain: elementGain,
								};
							}
						}
						if (element.buffer) {
							return {
								buffer: element.buffer,
								startTime: element.startTime,
								duration: element.duration,
								trimStart: element.trimStart,
								trimEnd: element.trimEnd,
								transcriptCuts: effectiveTranscriptCuts,
								muted: element.muted || isTrackMuted,
								gain: elementGain,
							};
						}

						const audioBuffer = await resolveAudioBufferForElement({
							element,
							mediaMap,
							audioContext,
						});
						if (!audioBuffer) return null;
						return {
							buffer: audioBuffer,
							startTime: element.startTime,
							duration: element.duration,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transcriptCuts: effectiveTranscriptCuts,
							muted: element.muted || isTrackMuted,
							gain: elementGain,
						};
					})(),
				);
				continue;
			}

			if (element.type === "video") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset || !mediaSupportsAudio({ media: mediaAsset })) continue;

				pendingElements.push(
					resolveAudioBufferForVideoElement({
						mediaAsset,
						audioContext,
						trimStart: element.trimStart,
						trimDuration: resolveSourceWindowDuration({
							duration: element.duration,
							cuts: effectiveTranscriptCuts,
						}),
					}).then((resolvedAudio) => {
						if (!resolvedAudio) return null;
						const elementMuted = element.muted ?? false;
						// If decode is windowed, trimStart is already baked into the buffer.
						// For full-file fallback decode, preserve element trimStart.
						return {
							buffer: resolvedAudio.buffer,
							startTime: element.startTime,
							duration: element.duration,
							trimStart: resolvedAudio.windowed ? 0 : element.trimStart,
							trimEnd: element.trimEnd,
							transcriptCuts: effectiveTranscriptCuts,
							muted: elementMuted || isTrackMuted,
							gain: trackGain,
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
			const effectiveTranscriptCuts =
				getEffectiveTranscriptCutsForClipWindow({
					transcriptEdit: element.transcriptEdit,
					trimStart: element.trimStart,
				});

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
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	gain: number;
	transcriptCuts?: TranscriptEditCutRange[];
}

export interface AudioClipSource {
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
	transcriptCuts?: TranscriptEditCutRange[];
}

function buildTranscriptAudioRevision({
	transcriptEdit,
}: {
	transcriptEdit:
		| {
				updatedAt: string;
				words: Array<{ id: string; text: string; removed?: boolean }>;
				cuts: Array<{ start: number; end: number; reason: string }>;
		  }
		| undefined;
}): string {
	if (!transcriptEdit) return "";
	const effectiveCuts = transcriptEdit.cuts
		.filter(
			(cut) =>
				Number.isFinite(cut.start) &&
				Number.isFinite(cut.end) &&
				cut.end > cut.start,
		)
		.map((cut) => ({
			start: Math.max(0, cut.start),
			end: Math.max(0, cut.end),
			reason: cut.reason ?? "remove",
		}))
		.sort((left, right) => left.start - right.start || left.end - right.end);
	let hash = 5381;
	const updateHash = (value: string): void => {
		for (let index = 0; index < value.length; index++) {
			hash = (hash * 33) ^ value.charCodeAt(index);
		}
	};
	// Audio graph changes should only track effective cut boundaries.
	for (const cut of effectiveCuts) {
		updateHash(cut.start.toFixed(3));
		updateHash(cut.end.toFixed(3));
		updateHash(cut.reason);
	}
	return `${effectiveCuts.length}:${(hash >>> 0).toString(36)}`;
}

function clampGain(value: number): number {
	return Math.max(0, Math.min(2, value));
}

function mapTrackVolumeToGain(trackVolume: number): number {
	const clamped = clampGain(trackVolume);
	// Perceptual taper: low control values attenuate more strongly.
	if (clamped <= 1) {
		return clamped * clamped * clamped;
	}
	return 1 + (clamped - 1);
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
}: {
	element: LibraryAudioElement;
	gain: number;
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
			file,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			gain,
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
}: {
	element: LibraryAudioElement;
	muted: boolean;
	gain: number;
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
			transcriptRevision: buildTranscriptAudioRevision({
				transcriptEdit: element.transcriptEdit,
			}),
			transcriptCuts: getEffectiveTranscriptCutsForClipWindow({
				transcriptEdit: element.transcriptEdit,
				trimStart: element.trimStart,
			}),
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
}: {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset;
	gain: number;
}): AudioMixSource {
	return {
		file: mediaAsset.file,
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		gain,
		transcriptCuts: getEffectiveTranscriptCutsForClipWindow({
			transcriptEdit: element.transcriptEdit,
			trimStart: element.trimStart,
		}),
	};
}

function collectMediaAudioClip({
	element,
	mediaAsset,
	muted,
	gain,
}: {
	element: TimelineElement;
	mediaAsset: MediaAsset;
	muted: boolean;
	gain: number;
}): AudioClipSource {
	return {
		id: element.id,
		sourceKey: mediaAsset.id,
		file: mediaAsset.file,
		mediaIdentity: {
			id: mediaAsset.id,
			type: mediaAsset.type,
			size: mediaAsset.file.size,
			lastModified: mediaAsset.file.lastModified,
		},
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		muted,
		gain,
		transcriptRevision:
			"transcriptEdit" in element
				? buildTranscriptAudioRevision({
						transcriptEdit: element.transcriptEdit,
					})
				: "",
		transcriptCuts:
			"transcriptEdit" in element
				? getEffectiveTranscriptCutsForClipWindow({
						transcriptEdit: element.transcriptEdit,
						trimStart: element.trimStart,
					})
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
	const pendingLibrarySources: Array<Promise<AudioMixSource | null>> = [];

	for (const track of tracks) {
		if (canTracktHaveAudio(track) && track.muted) continue;
		const trackGain = canTracktHaveAudio(track)
			? mapTrackVolumeToGain(track.volume ?? 1)
			: 1;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			const isElementMuted =
				"muted" in element ? (element.muted ?? false) : false;
			if (isElementMuted) continue;

			if (element.type === "audio") {
				const elementGain = trackGain * clampGain(element.volume ?? 1);
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset, gain: elementGain }),
					);
				} else {
					pendingLibrarySources.push(
						fetchLibraryAudioSource({ element, gain: elementGain }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset) continue;

				if (mediaSupportsAudio({ media: mediaAsset })) {
					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset, gain: trackGain }),
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
	const pendingLibraryClips: Array<Promise<AudioClipSource | null>> = [];

	for (const track of tracks) {
		const isTrackMuted = canTracktHaveAudio(track) && track.muted;
		const trackGain = canTracktHaveAudio(track)
			? mapTrackVolumeToGain(track.volume ?? 1)
			: 1;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;

			const isElementMuted =
				"muted" in element ? (element.muted ?? false) : false;
			const muted = isTrackMuted || isElementMuted;

			if (element.type === "audio") {
				const elementGain = trackGain * clampGain(element.volume ?? 1);
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
							gain: elementGain,
						}),
					);
				} else {
					pendingLibraryClips.push(
						fetchLibraryAudioClip({ element, muted, gain: elementGain }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset) continue;

				if (mediaSupportsAudio({ media: mediaAsset })) {
					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
							gain: trackGain,
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
	sampleRate = EXPORT_SAMPLE_RATE,
	audioContext,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	duration: number;
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
		const outputBuffer = context.createBuffer(
			outputChannels,
			outputLength,
			sampleRate,
		);

		for (const element of audioElements) {
			if (element.muted) continue;

			mixAudioChannels({
				element,
				outputBuffer,
				outputLength,
				sampleRate,
			});
		}

		return outputBuffer;
	} finally {
		if (ownsContext) {
			void context.close().catch(() => undefined);
		}
	}
}

function mixAudioChannels({
	element,
	outputBuffer,
	outputLength,
	sampleRate,
}: {
	element: CollectedAudioElement;
	outputBuffer: AudioBuffer;
	outputLength: number;
	sampleRate: number;
}): void {
	const { buffer, startTime, trimStart, duration: elementDuration } = element;
	const gain = clampGain(element.gain);
	const transcriptCuts = element.transcriptCuts ?? [];
	const cutBoundaries =
		transcriptCuts.length > 0
			? buildCompressedCutBoundaryTimes({ cuts: transcriptCuts })
			: [];

	const sourceStartSample = Math.floor(trimStart * buffer.sampleRate);
	const outputStartSample = Math.floor(startTime * sampleRate);
	const resampledLength = Math.floor(elementDuration * sampleRate);

	const outputChannels = 2;
	for (let channel = 0; channel < outputChannels; channel++) {
		const outputData = outputBuffer.getChannelData(channel);
		const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
		const sourceData = buffer.getChannelData(sourceChannel);
		let boundaryIndex = 0;

		for (let i = 0; i < resampledLength; i++) {
			const outputIndex = outputStartSample + i;
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
