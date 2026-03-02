import { create } from "zustand";
import type {
	ClipCandidate,
	ClipGenerationSession,
	ClipGenerationStatus,
	ClipTranscriptRef,
} from "@/types/clip-generation";

const INITIAL_STATE: ClipGenerationSession = {
	sourceMediaId: null,
	status: "idle",
	error: null,
	candidates: [],
	selectedCandidateIds: [],
	transcriptRef: null,
};

interface ClipGenerationStore extends ClipGenerationSession {
	setStatus: ({
		status,
		sourceMediaId,
	}: {
		status: ClipGenerationStatus;
		sourceMediaId?: string | null;
	}) => void;
	setError: ({ error }: { error: string }) => void;
	setCandidates: ({
		sourceMediaId,
		candidates,
		transcriptRef,
	}: {
		sourceMediaId: string;
		candidates: ClipCandidate[];
		transcriptRef: ClipTranscriptRef;
	}) => void;
	toggleCandidateSelection: ({ candidateId }: { candidateId: string }) => void;
	setSelectedCandidateIds: ({ candidateIds }: { candidateIds: string[] }) => void;
	reset: () => void;
}

export const useClipGenerationStore = create<ClipGenerationStore>()((set) => ({
	...INITIAL_STATE,
	setStatus: ({ status, sourceMediaId }) =>
		set((state) => ({
			...state,
			status,
			error: status === "error" ? state.error : null,
			sourceMediaId: sourceMediaId ?? state.sourceMediaId,
			...(status === "idle"
				? {
						sourceMediaId: null,
						candidates: [],
						selectedCandidateIds: [],
						transcriptRef: null,
					}
				: {}),
		})),
	setError: ({ error }) =>
		set((state) => ({
			...state,
			status: "error",
			error,
		})),
	setCandidates: ({ sourceMediaId, candidates, transcriptRef }) =>
		set(() => ({
			sourceMediaId,
			status: "ready",
			error: null,
			candidates,
			selectedCandidateIds: [],
			transcriptRef,
		})),
	toggleCandidateSelection: ({ candidateId }) =>
		set((state) => {
			const has = state.selectedCandidateIds.includes(candidateId);
			return {
				...state,
				selectedCandidateIds: has
					? state.selectedCandidateIds.filter((id) => id !== candidateId)
					: [...state.selectedCandidateIds, candidateId],
			};
		}),
	setSelectedCandidateIds: ({ candidateIds }) =>
		set((state) => ({
			...state,
			selectedCandidateIds: candidateIds,
		})),
	reset: () => set(() => ({ ...INITIAL_STATE })),
}));
