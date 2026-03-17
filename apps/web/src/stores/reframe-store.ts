import { create } from "zustand";

import type {
	VideoSplitScreenSlotBinding,
	VideoSplitScreenViewportBalance,
} from "@/types/timeline";

interface SplitPreviewState {
	slots: VideoSplitScreenSlotBinding[] | null;
	viewportBalance?: VideoSplitScreenViewportBalance;
}

interface ReframeStore {
	selectedPresetIdByElementId: Record<string, string | null>;
	selectedSplitPreviewByElementId: Record<string, SplitPreviewState | null>;
	selectedSectionStartTimeByElementId: Record<string, number | null>;
	setSelectedPresetId: (params: {
		elementId: string;
		presetId: string | null;
	}) => void;
	setSelectedSplitPreviewSlots: (params: {
		elementId: string;
		slots: VideoSplitScreenSlotBinding[] | null;
		viewportBalance?: VideoSplitScreenViewportBalance;
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
	selectedSplitPreviewByElementId: {},
	selectedSectionStartTimeByElementId: {},
	setSelectedPresetId: ({ elementId, presetId }) =>
		set((state) => {
			if (
				state.selectedPresetIdByElementId[elementId] === presetId &&
				(!presetId || !(elementId in state.selectedSplitPreviewByElementId))
			) {
				return state;
			}
			const nextSplitPreviewByElementId = {
				...state.selectedSplitPreviewByElementId,
			};
			if (presetId) {
				delete nextSplitPreviewByElementId[elementId];
			}
			return {
				selectedPresetIdByElementId: {
					...state.selectedPresetIdByElementId,
					[elementId]: presetId,
				},
				selectedSplitPreviewByElementId: nextSplitPreviewByElementId,
			};
		}),
	setSelectedSplitPreviewSlots: ({ elementId, slots, viewportBalance }) =>
		set((state) => {
			const nextPreview = slots
				? {
						slots,
						viewportBalance: viewportBalance ?? "balanced",
					}
				: null;
			if (
				state.selectedSplitPreviewByElementId[elementId] === nextPreview &&
				(!slots?.length ||
					state.selectedPresetIdByElementId[elementId] === null)
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
				selectedSplitPreviewByElementId: {
					...state.selectedSplitPreviewByElementId,
					[elementId]: nextPreview,
				},
			};
		}),
	setSelectedSectionStartTime: ({ elementId, startTime }) =>
		set((state) => {
			if (state.selectedSectionStartTimeByElementId[elementId] === startTime) {
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
			if (!(elementId in state.selectedSplitPreviewByElementId)) {
				return state;
			}
			const next = { ...state.selectedSplitPreviewByElementId };
			delete next[elementId];
			return {
				selectedSplitPreviewByElementId: next,
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
