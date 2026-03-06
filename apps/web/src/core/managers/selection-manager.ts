import type { EditorCore } from "@/core";

type ElementRef = { trackId: string; elementId: string };

function areSelectionsEqual({
	previous,
	next,
}: {
	previous: ElementRef[];
	next: ElementRef[];
}): boolean {
	if (previous === next) return true;
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index++) {
		const prev = previous[index];
		const curr = next[index];
		if (!prev || !curr) return false;
		if (prev.trackId !== curr.trackId || prev.elementId !== curr.elementId) {
			return false;
		}
	}
	return true;
}

export class SelectionManager {
	private selectedElements: ElementRef[] = [];
	private listeners = new Set<() => void>();

	constructor(editor: EditorCore) {
		void editor;
	}

	getSelectedElements(): ElementRef[] {
		return this.selectedElements;
	}

	setSelectedElements({ elements }: { elements: ElementRef[] }): void {
		if (areSelectionsEqual({ previous: this.selectedElements, next: elements })) {
			return;
		}
		this.selectedElements = elements;
		this.notify();
	}

	clearSelection(): void {
		if (this.selectedElements.length === 0) return;
		this.selectedElements = [];
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
