import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
	ClipCandidate,
	ClipGenerationSession,
	ClipGenerationStatus,
	ClipTranscriptRef,
} from "@/types/clip-generation";

const INITIAL_STATE: ClipGenerationSession = {
	sourceMediaId: null,
	status: "idle",
	progress: null,
	progressMessage: null,
	error: null,
	candidates: [],
	selectedCandidateIds: [],
	transcriptRef: null,
};

interface ClipGenerationStore extends ClipGenerationSession {
	setStatus: ({
		status,
		sourceMediaId,
		progress,
		progressMessage,
	}: {
		status: ClipGenerationStatus;
		sourceMediaId?: string | null;
		progress?: number | null;
		progressMessage?: string | null;
	}) => void;
	setProgress: ({
		sourceMediaId,
		progress,
		progressMessage,
	}: {
		sourceMediaId?: string | null;
		progress?: number | null;
		progressMessage?: string | null;
	}) => void;
	setError: ({ error }: { error: string }) => void;
	setCandidates: ({
		sourceMediaId,
		candidates,
		transcriptRef,
		status,
	}: {
		sourceMediaId: string;
		candidates: ClipCandidate[];
		transcriptRef: ClipTranscriptRef;
		status?: ClipGenerationStatus;
	}) => void;
	toggleCandidateSelection: ({ candidateId }: { candidateId: string }) => void;
	setSelectedCandidateIds: ({ candidateIds }: { candidateIds: string[] }) => void;
	hydrate: ({
		sourceMediaId,
		candidates,
		transcriptRef,
		error,
	}: {
		sourceMediaId: string;
		candidates: ClipCandidate[];
		transcriptRef: ClipTranscriptRef | null;
		error?: string | null;
	}) => void;
	reset: () => void;
}

export const useClipGenerationStore = create<ClipGenerationStore>()(
	persist(
		(set) => ({
			...INITIAL_STATE,
			setStatus: ({ status, sourceMediaId, progress, progressMessage }) =>
				set((state) => ({
					...state,
					status,
					error: status === "error" ? state.error : null,
					sourceMediaId: sourceMediaId ?? state.sourceMediaId,
					progress:
						typeof progress === "number"
							? Math.max(0, Math.min(100, progress))
							: progress === null
								? null
								: status === "ready" || status === "error" || status === "idle"
									? null
									: state.progress,
					progressMessage:
						typeof progressMessage === "string"
							? progressMessage
							: progressMessage === null
								? null
								: status === "ready" || status === "error" || status === "idle"
									? null
									: state.progressMessage,
					...(status === "idle"
						? {
								sourceMediaId: null,
								progress: null,
								progressMessage: null,
								candidates: [],
								selectedCandidateIds: [],
								transcriptRef: null,
							}
						: {}),
				})),
			setProgress: ({ sourceMediaId, progress, progressMessage }) =>
				set((state) => ({
					...state,
					sourceMediaId: sourceMediaId ?? state.sourceMediaId,
					progress:
						typeof progress === "number"
							? Math.max(0, Math.min(100, progress))
							: progress === null
								? null
								: state.progress,
					progressMessage:
						typeof progressMessage === "string"
							? progressMessage
							: progressMessage === null
								? null
								: state.progressMessage,
				})),
			setError: ({ error }) =>
				set((state) => ({
					...state,
					status: "error",
					progress: null,
					progressMessage: null,
					error,
				})),
			setCandidates: ({ sourceMediaId, candidates, transcriptRef, status }) =>
				set((state) => ({
					sourceMediaId,
					status: status ?? "ready",
					progress:
						status && status !== "ready"
							? state.progress
							: null,
					progressMessage:
						status && status !== "ready"
							? state.progressMessage
							: null,
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
			hydrate: ({ sourceMediaId, candidates, transcriptRef, error = null }) =>
				set((state) => ({
					...state,
					sourceMediaId,
					status: error ? "error" : "ready",
					progress: null,
					progressMessage: null,
					error,
					candidates,
					transcriptRef,
				})),
			reset: () => set(() => ({ ...INITIAL_STATE })),
		}),
		{
			name: "clip-generation-session:v1",
			version: 1,
		},
	),
);
