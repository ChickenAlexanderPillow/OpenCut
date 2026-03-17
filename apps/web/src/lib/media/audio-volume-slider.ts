import { clamp } from "@/utils/math";

const AUDIO_VOLUME_MIN = 0;
const AUDIO_VOLUME_UNITY = 1;
const AUDIO_VOLUME_MAX = 2;
const AUDIO_VOLUME_UNITY_POSITION = 0.35;

export function clampAudioVolume({ volume }: { volume: number }): number {
	return clamp({
		value: volume,
		min: AUDIO_VOLUME_MIN,
		max: AUDIO_VOLUME_MAX,
	});
}

export function audioVolumeToSliderPosition({
	volume,
}: {
	volume: number;
}): number {
	const clampedVolume = clampAudioVolume({ volume });
	if (clampedVolume <= AUDIO_VOLUME_UNITY) {
		return (clampedVolume / AUDIO_VOLUME_UNITY) * AUDIO_VOLUME_UNITY_POSITION;
	}
	return (
		AUDIO_VOLUME_UNITY_POSITION +
		((clampedVolume - AUDIO_VOLUME_UNITY) /
			(AUDIO_VOLUME_MAX - AUDIO_VOLUME_UNITY)) *
			(1 - AUDIO_VOLUME_UNITY_POSITION)
	);
}

export function sliderPositionToAudioVolume({
	position,
}: {
	position: number;
}): number {
	const clampedPosition = clamp({
		value: position,
		min: 0,
		max: 1,
	});
	if (clampedPosition <= AUDIO_VOLUME_UNITY_POSITION) {
		return clampAudioVolume({
			volume:
				(clampedPosition / AUDIO_VOLUME_UNITY_POSITION) * AUDIO_VOLUME_UNITY,
		});
	}
	return clampAudioVolume({
		volume:
			AUDIO_VOLUME_UNITY +
			((clampedPosition - AUDIO_VOLUME_UNITY_POSITION) /
				(1 - AUDIO_VOLUME_UNITY_POSITION)) *
				(AUDIO_VOLUME_MAX - AUDIO_VOLUME_UNITY),
	});
}
