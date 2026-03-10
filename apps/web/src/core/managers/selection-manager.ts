import type { EditorCore } from "@/core";
import type { TimelineGapSelection } from "@/types/timeline";

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

function areGapSelectionsEqual({
	previous,
	next,
}: {
	previous: TimelineGapSelection | null;
	next: TimelineGapSelection | null;
}): boolean {
	if (previous === next) return true;
	if (previous === null || next === null) return previous === next;
	return (
		previous.trackId === next.trackId &&
		Math.abs(previous.startTime - next.startTime) < 1e-6 &&
		Math.abs(previous.endTime - next.endTime) < 1e-6
	);
}

export class SelectionManager {
	private selectedElements: ElementRef[] = [];
	private selectedGap: TimelineGapSelection | null = null;
	private listeners = new Set<() => void>();

	constructor(editor: EditorCore) {
		void editor;
	}

	getSelectedElements(): ElementRef[] {
		return this.selectedElements;
	}

	getSelectedGap(): TimelineGapSelection | null {
		return this.selectedGap;
	}

	setSelectedElements({ elements }: { elements: ElementRef[] }): void {
		const elementsUnchanged = areSelectionsEqual({
			previous: this.selectedElements,
			next: elements,
		});
		if (elementsUnchanged && this.selectedGap === null) {
			return;
		}
		this.selectedElements = elements;
		this.selectedGap = null;
		this.notify();
	}

	setSelectedGap({ gap }: { gap: TimelineGapSelection | null }): void {
		if (
			areGapSelectionsEqual({ previous: this.selectedGap, next: gap }) &&
			this.selectedElements.length === 0
		) {
			return;
		}
		this.selectedElements = [];
		this.selectedGap = gap;
		this.notify();
	}

	clearSelection(): void {
		if (this.selectedElements.length === 0 && this.selectedGap === null) return;
		this.selectedElements = [];
		this.selectedGap = null;
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
