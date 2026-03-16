import { create } from "zustand";

interface ReframeStore {
	selectedPresetIdByElementId: Record<string, string | null>;
	selectedSectionStartTimeByElementId: Record<string, number | null>;
	setSelectedPresetId: (params: {
		elementId: string;
		presetId: string | null;
	}) => void;
	setSelectedSectionStartTime: (params: {
		elementId: string;
		startTime: number | null;
	}) => void;
	clearSelectedPresetId: (params: { elementId: string }) => void;
	clearSelectedSectionStartTime: (params: { elementId: string }) => void;
}

export const useReframeStore = create<ReframeStore>((set) => ({
	selectedPresetIdByElementId: {},
	selectedSectionStartTimeByElementId: {},
	setSelectedPresetId: ({ elementId, presetId }) =>
		set((state) => {
			if (state.selectedPresetIdByElementId[elementId] === presetId) {
				return state;
			}
			return {
				selectedPresetIdByElementId: {
					...state.selectedPresetIdByElementId,
					[elementId]: presetId,
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
