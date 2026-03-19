import { describe, expect, test } from "bun:test";
import {
	getEditableSplitSlotRegions,
	resolveEditableSplitSlotState,
	updateSplitSlotBindingsWithTransform,
} from "@/lib/reframe/split-slot-edit";
import type { VideoElement } from "@/types/timeline";

function createVideoElement(): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video",
		startTime: 0,
		duration: 4,
		trimStart: 0,
		trimEnd: 0,
		mediaId: "video-media-1",
		muted: false,
		transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
		reframePresets: [
			{
				id: "preset-top",
				name: "Top",
				transform: { scale: 1.2, position: { x: 0, y: -20 } },
			},
			{
				id: "preset-bottom",
				name: "Bottom",
				transform: { scale: 1.1, position: { x: 0, y: 20 } },
			},
		],
		defaultReframePresetId: "preset-top",
		reframeSwitches: [
			{
				id: "switch-1",
				time: 2,
				presetId: "preset-bottom",
			},
		],
		splitScreen: {
			enabled: false,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			slots: [
				{ slotId: "top", mode: "fixed-preset", presetId: "preset-top" },
				{
					slotId: "bottom",
					mode: "fixed-preset",
					presetId: "preset-bottom",
				},
			],
			sections: [
				{
					id: "split-section-1",
					startTime: 1,
					enabled: true,
					slots: [
						{ slotId: "top", mode: "fixed-preset", presetId: "preset-top" },
						{
							slotId: "bottom",
							mode: "fixed-preset",
							presetId: "preset-bottom",
						},
					],
				},
				{
					id: "split-section-2",
					startTime: 3,
					enabled: false,
					slots: [
						{ slotId: "top", mode: "fixed-preset", presetId: "preset-top" },
						{
							slotId: "bottom",
							mode: "fixed-preset",
							presetId: "preset-bottom",
						},
					],
				},
			],
		},
	};
}

describe("split slot edit regions", () => {
	test("uses a full-canvas region for the active slot in non-split sections", () => {
		const editableState = resolveEditableSplitSlotState({
			element: createVideoElement(),
			localTime: 3.5,
		});

		expect(editableState).not.toBeNull();
		if (!editableState) return;
		expect(editableState.isSplitActive).toBe(false);
		expect(editableState.singleViewSlotId).toBe("bottom");

		const regions = getEditableSplitSlotRegions({
			editableState,
			canvasWidth: 1080,
			canvasHeight: 1920,
		});

		expect(regions).toEqual([
			{
				slotId: "bottom",
				bounds: {
					cx: 540,
					cy: 960,
					width: 1080,
					height: 1920,
					rotation: 0,
				},
			},
		]);
	});

	test("uses split viewport regions inside active split sections", () => {
		const editableState = resolveEditableSplitSlotState({
			element: createVideoElement(),
			localTime: 1.5,
		});

		expect(editableState).not.toBeNull();
		if (!editableState) return;
		expect(editableState.isSplitActive).toBe(true);

		const regions = getEditableSplitSlotRegions({
			editableState,
			canvasWidth: 1080,
			canvasHeight: 1920,
		});

		expect(regions).toHaveLength(2);
		expect(regions[0]?.bounds.height).toBeGreaterThan(900);
		expect(regions[1]?.bounds.height).toBeGreaterThan(900);
		expect(
			(regions[0]?.bounds.height ?? 0) + (regions[1]?.bounds.height ?? 0),
		).toBeLessThanOrEqual(1920);
	});

	test("ignores manual slot reframes while auto-only mode is active", () => {
		const element = createVideoElement();
		const updated = updateSplitSlotBindingsWithTransform({
			bindings: element.splitScreen?.slots ?? [],
			slotId: "top",
			nextTransform: {
				position: { x: 42, y: -18 },
				scale: 1.65,
			},
			element,
			localTime: 1.5,
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
		});

		expect(updated).toEqual(element.splitScreen?.slots ?? []);
	});
});
