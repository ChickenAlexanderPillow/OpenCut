import { describe, expect, test } from "bun:test";
import {
	createWaveformEnvelope,
	getWaveformMinMaxInRange,
	selectWaveformPeaksForDisplay,
	type WaveformEnvelope,
	WAVEFORM_ENVELOPE_VERSION,
} from "@/lib/media/waveform-envelope";

function createTestAudioBuffer({
	channelData,
	sampleRate = 4,
}: {
	channelData: number[][];
	sampleRate?: number;
}): AudioBuffer {
	const channels = channelData.map((channel) => Float32Array.from(channel));
	return {
		numberOfChannels: channels.length,
		length: channels[0]?.length ?? 0,
		sampleRate,
		duration: (channels[0]?.length ?? 0) / sampleRate,
		getChannelData: (index: number) => channels[index] ?? new Float32Array(),
	} as AudioBuffer;
}

describe("waveform-envelope", () => {
	test("captures min and max dynamics per fixed source-time bucket", () => {
		const buffer = createTestAudioBuffer({
			channelData: [[-1, -0.25, 0.75, 0.5]],
		});

		const envelope = createWaveformEnvelope({
			buffer,
			bucketsPerSecond: 2,
		});

		expect(envelope.version).toBe(WAVEFORM_ENVELOPE_VERSION);
		expect(envelope.sourceDurationSeconds).toBe(1);
		expect(envelope.peaks).toEqual([-1, -0.25, 0.5, 0.75]);
	});

	test("selects an exact source-time window without trim-ratio drift", () => {
		const envelope: WaveformEnvelope = {
			version: WAVEFORM_ENVELOPE_VERSION,
			sourceDurationSeconds: 2,
			bucketsPerSecond: 4,
			peaks: [-1, -0.8, -0.6, -0.4, -0.3, 0.1, -0.1, 0.4, 0, 0.2, 0.1, 0.6, -0.2, 0.3, -0.5, 0.9],
		};

		const visible = selectWaveformPeaksForDisplay({
			envelope,
			startTime: 0.5,
			endTime: 1.5,
		});

		expect(visible).toEqual([-0.3, 0.1, -0.1, 0.4, 0, 0.2, 0.1, 0.6]);
	});

	test("downsamples display peaks while preserving the strongest min/max range", () => {
		const envelope: WaveformEnvelope = {
			version: WAVEFORM_ENVELOPE_VERSION,
			sourceDurationSeconds: 1,
			bucketsPerSecond: 4,
			peaks: [-0.1, 0.1, -0.8, 0.7, -0.3, 0.2, -0.4, 0.9],
		};

		const visible = selectWaveformPeaksForDisplay({
			envelope,
			startTime: 0,
			endTime: 1,
			targetBucketCount: 2,
		});

		expect(visible).toEqual([-0.8, 0.7, -0.4, 0.9]);
	});

	test("aggregates exact min/max values for arbitrary source ranges", () => {
		const envelope: WaveformEnvelope = {
			version: WAVEFORM_ENVELOPE_VERSION,
			sourceDurationSeconds: 1,
			bucketsPerSecond: 4,
			peaks: [-0.1, 0.1, -0.8, 0.7, -0.3, 0.2, -0.4, 0.9],
		};

		expect(
			getWaveformMinMaxInRange({
				envelope,
				startTime: 0.25,
				endTime: 0.75,
			}),
		).toEqual({ min: -0.8, max: 0.7 });
	});
});
