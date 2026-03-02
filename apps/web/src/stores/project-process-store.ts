import { create } from "zustand";

export type ProjectProcessKind =
	| "transcription"
	| "clip-generation"
	| "export"
	| "other";

export interface ProjectProcessItem {
	id: string;
	projectId: string;
	kind: ProjectProcessKind;
	label: string;
	startedAt: number;
	cancel?: () => void;
}

interface ProjectProcessState {
	processes: ProjectProcessItem[];
	registerProcess: (process: Omit<ProjectProcessItem, "id" | "startedAt">) => string;
	updateProcessLabel: (params: { id: string; label: string }) => void;
	removeProcess: (params: { id: string }) => void;
	cancelProcess: (params: { id: string }) => void;
	cancelProcessesForProject: (params: { projectId: string }) => void;
	clearProcessesForProject: (params: { projectId: string }) => void;
}

function createProcessId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useProjectProcessStore = create<ProjectProcessState>()((set, get) => ({
	processes: [],
	registerProcess: (process) => {
		const id = createProcessId();
		set((state) => ({
			processes: [
				...state.processes,
				{
					id,
					startedAt: Date.now(),
					...process,
				},
			],
		}));
		return id;
	},
	updateProcessLabel: ({ id, label }) =>
		set((state) => ({
			processes: state.processes.map((process) =>
				process.id === id ? { ...process, label } : process,
			),
		})),
	removeProcess: ({ id }) =>
		set((state) => ({
			processes: state.processes.filter((process) => process.id !== id),
		})),
	cancelProcess: ({ id }) => {
		const process = get().processes.find((item) => item.id === id);
		try {
			process?.cancel?.();
		} catch (error) {
			console.warn("Failed to cancel process:", error);
		}
		set((state) => ({
			processes: state.processes.filter((item) => item.id !== id),
		}));
	},
	cancelProcessesForProject: ({ projectId }) => {
		const projectProcesses = get().processes.filter(
			(process) => process.projectId === projectId,
		);
		for (const process of projectProcesses) {
			try {
				process.cancel?.();
			} catch (error) {
				console.warn("Failed to cancel process:", error);
			}
		}
		set((state) => ({
			processes: state.processes.filter(
				(process) => process.projectId !== projectId,
			),
		}));
	},
	clearProcessesForProject: ({ projectId }) =>
		set((state) => ({
			processes: state.processes.filter(
				(process) => process.projectId !== projectId,
			),
		})),
}));
