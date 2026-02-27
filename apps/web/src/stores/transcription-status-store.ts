import { create } from "zustand";

interface TranscriptionStatusState {
	isRunning: boolean;
	message: string;
	progress: number | null;
	activeOperationId: string | null;
	start: (message?: string) => string;
	update: (params: {
		operationId?: string;
		message?: string;
		progress?: number | null;
	}) => void;
	stop: (operationId?: string) => void;
}

export const useTranscriptionStatusStore = create<TranscriptionStatusState>()(
	(set) => ({
		isRunning: false,
		message: "",
		progress: null,
		activeOperationId: null,
		start: (message = "Generating transcript...") => {
			const operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
			set({
				isRunning: true,
				message,
				progress: null,
				activeOperationId: operationId,
			});
			return operationId;
		},
		update: ({ operationId, message, progress }) =>
			set((state) => {
				if (operationId && state.activeOperationId !== operationId) {
					return state;
				}
				return {
					isRunning: true,
					message: message ?? state.message,
					progress:
						typeof progress === "number"
							? Math.max(0, Math.min(100, progress))
							: progress === null
								? null
								: state.progress,
					activeOperationId: state.activeOperationId,
				};
			}),
		stop: (operationId) =>
			set((state) => {
				if (operationId && state.activeOperationId !== operationId) {
					return state;
				}
				return {
					isRunning: false,
					message: "",
					progress: null,
					activeOperationId: null,
				};
			}),
	}),
);
