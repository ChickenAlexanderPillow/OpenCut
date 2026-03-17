import { create } from "zustand";

import type { VideoSplitScreenSlotBinding } from "@/types/timeline";

interface ReframeStore {
	selectedPresetIdByElementId: Record<string, string | null>;
	selectedSplitPreviewSlotsByElementId: Record<
		string,
		VideoSplitScreenSlotBinding[] | null
	>;
	selectedSectionStartTimeByElementId: Record<string, number | null>;
	setSelectedPresetId: (params: {
		elementId: string;
		presetId: string | null;
	}) => void;
	setSelectedSplitPreviewSlots: (params: {
		elementId: string;
		slots: VideoSplitScreenSlotBinding[] | null;
	}) => void;
	setSelectedSectionStartTime: (params: {
		elementId: string;
		startTime: number | null;
	}) => void;
	clearSelectedPresetId: (params: { elementId: string }) => void;
	clearSelectedSplitPreviewSlots: (params: { elementId: string }) => void;
	clearSelectedSectionStartTime: (params: { elementId: string }) => void;
}

export const useReframeStore = create<ReframeStore>((set) => ({
	selectedPresetIdByElementId: {},
	selectedSplitPreviewSlotsByElementId: {},
	selectedSectionStartTimeByElementId: {},
	setSelectedPresetId: ({ elementId, presetId }) =>
		set((state) => {
			if (
				state.selectedPresetIdByElementId[elementId] === presetId &&
				(!presetId || !(elementId in state.selectedSplitPreviewSlotsByElementId))
			) {
				return state;
			}
			const nextSplitPreviewSlotsByElementId = {
				...state.selectedSplitPreviewSlotsByElementId,
			};
			if (presetId) {
				delete nextSplitPreviewSlotsByElementId[elementId];
			}
			return {
				selectedPresetIdByElementId: {
					...state.selectedPresetIdByElementId,
					[elementId]: presetId,
				},
				selectedSplitPreviewSlotsByElementId: nextSplitPreviewSlotsByElementId,
			};
		}),
	setSelectedSplitPreviewSlots: ({ elementId, slots }) =>
		set((state) => {
			if (
				state.selectedSplitPreviewSlotsByElementId[elementId] === slots &&
				(!slots?.length || state.selectedPresetIdByElementId[elementId] === null)
			) {
				return state;
			}
			const nextPresetIdsByElementId = {
				...state.selectedPresetIdByElementId,
			};
			if (slots?.length) {
				nextPresetIdsByElementId[elementId] = null;
			}
			return {
				selectedPresetIdByElementId: nextPresetIdsByElementId,
				selectedSplitPreviewSlotsByElementId: {
					...state.selectedSplitPreviewSlotsByElementId,
					[elementId]: slots,
				},
			};
		}),
	setSelectedSectionStartTime: ({ elementId, startTime }) =>
		set((state) => {
			if (
				state.selectedSectionStartTimeByElementId[elementId] === startTime
			) {
				return state;
			}
			return {
				selectedSectionStartTimeByElementId: {
					...state.selectedSectionStartTimeByElementId,
					[elementId]: startTime,
				},
			};
		}),
	clearSelectedPresetId: ({ elementId }) =>
		set((state) => {
			if (!(elementId in state.selectedPresetIdByElementId)) {
				return state;
			}
			const next = { ...state.selectedPresetIdByElementId };
			delete next[elementId];
			return {
				selectedPresetIdByElementId: next,
			};
		}),
	clearSelectedSplitPreviewSlots: ({ elementId }) =>
		set((state) => {
			if (!(elementId in state.selectedSplitPreviewSlotsByElementId)) {
				return state;
			}
			const next = { ...state.selectedSplitPreviewSlotsByElementId };
			delete next[elementId];
			return {
				selectedSplitPreviewSlotsByElementId: next,
			};
		}),
	clearSelectedSectionStartTime: ({ elementId }) =>
		set((state) => {
			if (!(elementId in state.selectedSectionStartTimeByElementId)) {
				return state;
			}
			const next = { ...state.selectedSectionStartTimeByElementId };
			delete next[elementId];
			return {
				selectedSectionStartTimeByElementId: next,
			};
		}),
}));
