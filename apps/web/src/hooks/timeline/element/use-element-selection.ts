import { useCallback, useSyncExternalStore } from "react";
import { useEditor } from "@/hooks/use-editor";
import type { TimelineGapSelection } from "@/types/timeline";

type ElementRef = { trackId: string; elementId: string };

export function useElementSelection() {
	const editor = useEditor({ subscribeTo: [] });
	const selectedElements = useSyncExternalStore(
		(listener) => editor.selection.subscribe(listener),
		() => editor.selection.getSelectedElements(),
	);
	const selectedGap = useSyncExternalStore(
		(listener) => editor.selection.subscribe(listener),
		() => editor.selection.getSelectedGap(),
	);

	const isElementSelected = useCallback(
		({ trackId, elementId }: ElementRef) =>
			selectedElements.some(
				(element) =>
					element.trackId === trackId && element.elementId === elementId,
			),
		[selectedElements],
	);

	const selectElement = useCallback(
		({ trackId, elementId }: ElementRef) => {
			editor.selection.setSelectedElements({
				elements: [{ trackId, elementId }],
			});
		},
		[editor],
	);

	const addElementToSelection = useCallback(
		({ trackId, elementId }: ElementRef) => {
			const alreadySelected = selectedElements.some(
				(element) =>
					element.trackId === trackId && element.elementId === elementId,
			);
			if (alreadySelected) return;

			editor.selection.setSelectedElements({
				elements: [...selectedElements, { trackId, elementId }],
			});
		},
		[selectedElements, editor],
	);

	const removeElementFromSelection = useCallback(
		({ trackId, elementId }: ElementRef) => {
			editor.selection.setSelectedElements({
				elements: selectedElements.filter(
					(element) =>
						!(element.trackId === trackId && element.elementId === elementId),
				),
			});
		},
		[selectedElements, editor],
	);

	const toggleElementSelection = useCallback(
		({ trackId, elementId }: ElementRef) => {
			const alreadySelected = selectedElements.some(
				(element) =>
					element.trackId === trackId && element.elementId === elementId,
			);

			if (alreadySelected) {
				removeElementFromSelection({ trackId, elementId });
			} else {
				addElementToSelection({ trackId, elementId });
			}
		},
		[selectedElements, addElementToSelection, removeElementFromSelection],
	);

	const clearElementSelection = useCallback(() => {
		editor.selection.clearSelection();
	}, [editor]);

	const selectGap = useCallback(
		({ gap }: { gap: TimelineGapSelection }) => {
			editor.selection.setSelectedGap({ gap });
		},
		[editor],
	);

	const clearGapSelection = useCallback(() => {
		editor.selection.setSelectedGap({ gap: null });
	}, [editor]);

	const isGapSelected = useCallback(
		({ gap }: { gap: TimelineGapSelection }) =>
			selectedGap !== null &&
			selectedGap.trackId === gap.trackId &&
			Math.abs(selectedGap.startTime - gap.startTime) < 1e-6 &&
			Math.abs(selectedGap.endTime - gap.endTime) < 1e-6,
		[selectedGap],
	);

	const setElementSelection = useCallback(
		({ elements }: { elements: ElementRef[] }) => {
			editor.selection.setSelectedElements({ elements });
		},
		[editor],
	);

	/**
	 * Handles click interaction on an element.
	 * - Regular click: select only this element
	 * - Multi-key click (Ctrl/Cmd): toggle this element in selection
	 */
	const handleElementClick = useCallback(
		({
			trackId,
			elementId,
			isMultiKey,
		}: ElementRef & { isMultiKey: boolean }) => {
			if (isMultiKey) {
				toggleElementSelection({ trackId, elementId });
			} else {
				selectElement({ trackId, elementId });
			}
		},
		[toggleElementSelection, selectElement],
	);

	return {
		selectedElements,
		selectedGap,
		isElementSelected,
		isGapSelected,
		selectElement,
		selectGap,
		setElementSelection,
		addElementToSelection,
		removeElementFromSelection,
		toggleElementSelection,
		clearElementSelection,
		clearGapSelection,
		handleElementClick,
	};
}
