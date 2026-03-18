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
	selectedSplitEditSlotIdByElementId: Record<string, string | null>;
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
	setSelectedSplitEditSlotId: (params: {
		elementId: string;
		slotId: string | null;
	}) => void;
	clearSelectedPresetId: (params: { elementId: string }) => void;
	clearSelectedSplitPreviewSlots: (params: { elementId: string }) => void;
	clearSelectedSplitEditSlotId: (params: { elementId: string }) => void;
	clearSelectedSectionStartTime: (params: { elementId: string }) => void;
}

export const useReframeStore = create<ReframeStore>((set) => ({
	selectedPresetIdByElementId: {},
	selectedSplitPreviewByElementId: {},
	selectedSplitEditSlotIdByElementId: {},
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
			const nextSplitEditSlotIdByElementId = {
				...state.selectedSplitEditSlotIdByElementId,
			};
			if (presetId) {
				delete nextSplitEditSlotIdByElementId[elementId];
			}
			return {
				selectedPresetIdByElementId: {
					...state.selectedPresetIdByElementId,
					[elementId]: presetId,
				},
				selectedSplitPreviewByElementId: nextSplitPreviewByElementId,
				selectedSplitEditSlotIdByElementId: nextSplitEditSlotIdByElementId,
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
	setSelectedSplitEditSlotId: ({ elementId, slotId }) =>
		set((state) => {
			if (state.selectedSplitEditSlotIdByElementId[elementId] === slotId) {
				return state;
			}
			return {
				selectedSplitEditSlotIdByElementId: {
					...state.selectedSplitEditSlotIdByElementId,
					[elementId]: slotId,
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
	clearSelectedSplitEditSlotId: ({ elementId }) =>
		set((state) => {
			if (!(elementId in state.selectedSplitEditSlotIdByElementId)) {
				return state;
			}
			const next = { ...state.selectedSplitEditSlotIdByElementId };
			delete next[elementId];
			return {
				selectedSplitEditSlotIdByElementId: next,
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
