import { describe, expect, test } from "bun:test";
import {
	computeCappedEvenDimensions,
	normalizeTargetFps,
	resolveImportVideoProfile,
	selectVideoBitrate,
} from "@/services/transcoding/import-profile";

describe("import transcoding profile", () => {
	test("1080p landscape stays <=1080 and uses 5 Mbps tier", () => {
		const profile = resolveImportVideoProfile({
			sourceInfo: { width: 1920, height: 1080, fps: 30 },
		});
		expect(profile.outputWidth).toBe(1080);
		expect(profile.outputHeight).toBe(606);
		expect(profile.videoBitrate).toBe(5_000_000);
		expect(profile.targetFps).toBe(30);
	});

	test("vertical 4K preserves orientation with long edge capped at 1080", () => {
		const profile = resolveImportVideoProfile({
			sourceInfo: { width: 2160, height: 3840, fps: 30 },
		});
		expect(profile.outputWidth).toBe(606);
		expect(profile.outputHeight).toBe(1080);
		expect(profile.videoBitrate).toBe(5_000_000);
	});

	test("source fps 24 remains 24", () => {
		expect(normalizeTargetFps({ fps: 24 })).toBe(24);
	});

	test("source fps 60 is capped to 30", () => {
		expect(normalizeTargetFps({ fps: 60 })).toBe(30);
	});

	test("audio-only profile implication uses AAC 128k", () => {
		const profile = resolveImportVideoProfile({
			sourceInfo: { width: 640, height: 360, fps: 30 },
		});
		expect(profile.audioBitrate).toBe(128_000);
	});

	test("480p and 720p bitrate tiers are selected correctly", () => {
		const p480 = computeCappedEvenDimensions({ width: 854, height: 480 });
		const p720 = computeCappedEvenDimensions({ width: 1280, height: 720 });
		expect(selectVideoBitrate(p480)).toBe(1_800_000);
		expect(selectVideoBitrate(p720)).toBe(3_000_000);
	});
});
