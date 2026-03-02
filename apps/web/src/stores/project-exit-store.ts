import { create } from "zustand";

interface ProjectExitState {
	isOpen: boolean;
	pendingRoute: string | null;
	requestOpen: ({ route }: { route: string | null }) => void;
	close: () => void;
	clearPendingRoute: () => void;
}

export const useProjectExitStore = create<ProjectExitState>()((set) => ({
	isOpen: false,
	pendingRoute: null,
	requestOpen: ({ route }) =>
		set(() => ({
			isOpen: true,
			pendingRoute: route,
		})),
	close: () =>
		set(() => ({
			isOpen: false,
		})),
	clearPendingRoute: () =>
		set(() => ({
			pendingRoute: null,
		})),
}));
