import type {
	AudioTrack,
	TimelineTrack,
	TrackAudioEffects,
	VideoTrack,
} from "@/types/timeline";

export const DEFAULT_TRACK_AUDIO_EFFECTS: TrackAudioEffects = {
	eq: {
		enabled: false,
		lowGainDb: 0,
		midGainDb: 0,
		highGainDb: 0,
		midFrequency: 1200,
		highFrequency: 6500,
	},
	compressor: {
		enabled: false,
		thresholdDb: -24,
		ratio: 3,
		attackSeconds: 0.01,
		releaseSeconds: 0.18,
		makeupGainDb: 0,
	},
	deesser: {
		enabled: false,
		amountDb: 0,
		frequency: 6000,
		q: 3,
	},
	limiter: {
		enabled: false,
		ceilingDb: -1,
		releaseSeconds: 0.08,
	},
};

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

export function cloneDefaultTrackAudioEffects(): TrackAudioEffects {
	return {
		eq: { ...DEFAULT_TRACK_AUDIO_EFFECTS.eq },
		compressor: { ...DEFAULT_TRACK_AUDIO_EFFECTS.compressor },
		deesser: { ...DEFAULT_TRACK_AUDIO_EFFECTS.deesser },
		limiter: { ...DEFAULT_TRACK_AUDIO_EFFECTS.limiter },
	};
}

export function normalizeTrackAudioEffects(
	value: Partial<TrackAudioEffects> | null | undefined,
): TrackAudioEffects {
	const defaults = cloneDefaultTrackAudioEffects();
	const eq = (value?.eq ?? {}) as Partial<TrackAudioEffects["eq"]>;
	const compressor =
		(value?.compressor ?? {}) as Partial<TrackAudioEffects["compressor"]>;
	const deesser =
		(value?.deesser ?? {}) as Partial<TrackAudioEffects["deesser"]>;
	const limiter =
		(value?.limiter ?? {}) as Partial<TrackAudioEffects["limiter"]>;

	return {
		eq: {
			enabled: Boolean(eq.enabled),
			lowGainDb: clamp(eq.lowGainDb ?? defaults.eq.lowGainDb, -18, 18),
			midGainDb: clamp(eq.midGainDb ?? defaults.eq.midGainDb, -18, 18),
			highGainDb: clamp(eq.highGainDb ?? defaults.eq.highGainDb, -18, 18),
			midFrequency: clamp(
				eq.midFrequency ?? defaults.eq.midFrequency,
				250,
				4000,
			),
			highFrequency: clamp(
				eq.highFrequency ?? defaults.eq.highFrequency,
				3000,
				12000,
			),
		},
		compressor: {
			enabled: Boolean(compressor.enabled),
			thresholdDb: clamp(
				compressor.thresholdDb ?? defaults.compressor.thresholdDb,
				-60,
				0,
			),
			ratio: clamp(compressor.ratio ?? defaults.compressor.ratio, 1, 20),
			attackSeconds: clamp(
				compressor.attackSeconds ?? defaults.compressor.attackSeconds,
				0.001,
				0.1,
			),
			releaseSeconds: clamp(
				compressor.releaseSeconds ?? defaults.compressor.releaseSeconds,
				0.02,
				1,
			),
			makeupGainDb: clamp(
				compressor.makeupGainDb ?? defaults.compressor.makeupGainDb,
				0,
				18,
			),
		},
		deesser: {
			enabled: Boolean(deesser.enabled),
			amountDb: clamp(deesser.amountDb ?? defaults.deesser.amountDb, 0, 18),
			frequency: clamp(
				deesser.frequency ?? defaults.deesser.frequency,
				3500,
				10000,
			),
			q: clamp(deesser.q ?? defaults.deesser.q, 0.5, 8),
		},
		limiter: {
			enabled: Boolean(limiter.enabled),
			ceilingDb: clamp(
				limiter.ceilingDb ?? defaults.limiter.ceilingDb,
				-12,
				0,
			),
			releaseSeconds: clamp(
				limiter.releaseSeconds ?? defaults.limiter.releaseSeconds,
				0.01,
				0.3,
			),
		},
	};
}

export function getTrackAudioEffectsFingerprint(
	effects: TrackAudioEffects | undefined,
): string {
	const normalized = normalizeTrackAudioEffects(effects);
	return JSON.stringify(normalized);
}

export function normalizeAudioCapableTrack<
	TTrack extends AudioTrack | VideoTrack,
>(track: TTrack): TTrack {
	const nextVolume =
		typeof track.volume === "number" && Number.isFinite(track.volume)
			? Math.max(0, Math.min(2, track.volume))
			: 1;
	return {
		...track,
		volume: nextVolume,
		audioEffects: normalizeTrackAudioEffects(track.audioEffects),
	};
}

export function normalizeTimelineTrackAudioState(
	track: TimelineTrack,
): TimelineTrack {
	if (track.type !== "audio" && track.type !== "video") {
		return track;
	}
	return normalizeAudioCapableTrack(track);
}
