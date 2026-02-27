import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { EditorCore } from "@/core";

export type EditorSubscriptionKey =
	| "playback"
	| "timeline"
	| "scenes"
	| "project"
	| "media"
	| "renderer"
	| "selection";

const DEFAULT_SUBSCRIPTIONS: EditorSubscriptionKey[] = [
	"playback",
	"timeline",
	"scenes",
	"project",
	"media",
	"renderer",
	"selection",
];

export function useEditor({
	subscribeTo = DEFAULT_SUBSCRIPTIONS,
}: {
	subscribeTo?: readonly EditorSubscriptionKey[];
} = {}): EditorCore {
	const editor = useMemo(() => EditorCore.getInstance(), []);
	const versionRef = useRef(0);

	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			const handleStoreChange = () => {
				versionRef.current += 1;
				onStoreChange();
			};

			const unsubscribers: Array<() => void> = [];

			if (subscribeTo.includes("playback")) {
				unsubscribers.push(editor.playback.subscribe(handleStoreChange));
			}
			if (subscribeTo.includes("timeline")) {
				unsubscribers.push(editor.timeline.subscribe(handleStoreChange));
			}
			if (subscribeTo.includes("scenes")) {
				unsubscribers.push(editor.scenes.subscribe(handleStoreChange));
			}
			if (subscribeTo.includes("project")) {
				unsubscribers.push(editor.project.subscribe(handleStoreChange));
			}
			if (subscribeTo.includes("media")) {
				unsubscribers.push(editor.media.subscribe(handleStoreChange));
			}
			if (subscribeTo.includes("renderer")) {
				unsubscribers.push(editor.renderer.subscribe(handleStoreChange));
			}
			if (subscribeTo.includes("selection")) {
				unsubscribers.push(editor.selection.subscribe(handleStoreChange));
			}

			return () => {
				for (const unsubscribe of unsubscribers) {
					unsubscribe();
				}
			};
		},
		[editor, subscribeTo],
	);

	const getSnapshot = useCallback(() => versionRef.current, []);

	useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	return editor;
}
