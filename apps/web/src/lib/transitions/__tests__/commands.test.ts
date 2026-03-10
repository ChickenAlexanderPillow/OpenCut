import { beforeEach, describe, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import { DEFAULT_BRAND_OVERLAYS } from "@/constants/brand-overlay-constants";
import {
	DEFAULT_CANVAS_SIZE,
	DEFAULT_COLOR,
	DEFAULT_FPS,
} from "@/constants/project-constants";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import {
	buildApplyTransitionCommand,
	buildRemoveTransitionCommand,
} from "@/lib/transitions/commands";
import type { TProject } from "@/types/project";
import type { TextElement, TextTrack, TScene } from "@/types/timeline";

function createCaptionElement(): TextElement {
	return {
		id: "caption-1",
		type: "text",
		name: "Caption 1",
		content: "hello world",
		startTime: 0,
		duration: 2,
		trimStart: 0,
		trimEnd: 0,
		fontSize: 64,
		fontFamily: "Geist",
		color: "#ffffff",
		background: {
			color: "transparent",
		},
		textAlign: "center",
		fontWeight: "bold",
		fontStyle: "normal",
		textDecoration: "none",
		transform: {
			scale: 1,
			position: { x: 0, y: 0 },
			rotate: 0,
		},
		opacity: 1,
		captionWordTimings: [
			{ word: "hello", startTime: 0, endTime: 0.6 },
			{ word: "world", startTime: 0.7, endTime: 1.2 },
		],
		captionStyle: {
			linkedToCaptionGroup: true,
		},
	};
}

function initializeEditorWithCaption(): EditorCore {
	const editor = EditorCore.getInstance();
	const captionTrack: TextTrack = {
		id: "track-text-1",
		type: "text",
		name: "Captions",
		hidden: false,
		elements: [createCaptionElement()],
	};
	const scene: TScene = {
		id: "scene-1",
		name: "Main scene",
		isMain: true,
		tracks: [captionTrack],
		bookmarks: [],
		createdAt: new Date("2026-03-10T00:00:00.000Z"),
		updatedAt: new Date("2026-03-10T00:00:00.000Z"),
	};
	const project: TProject = {
		metadata: {
			id: "project-1",
			name: "Transition Undo",
			duration: 2,
			createdAt: new Date("2026-03-10T00:00:00.000Z"),
			updatedAt: new Date("2026-03-10T00:00:00.000Z"),
		},
		scenes: [scene],
		currentSceneId: scene.id,
		settings: {
			fps: DEFAULT_FPS,
			canvasSize: DEFAULT_CANVAS_SIZE,
			originalCanvasSize: null,
			background: {
				type: "color",
				color: DEFAULT_COLOR,
			},
		},
		brandOverlays: {
			selectedBrandId: DEFAULT_BRAND_OVERLAYS.selectedBrandId,
			logo: { ...DEFAULT_BRAND_OVERLAYS.logo },
		},
		version: CURRENT_PROJECT_VERSION,
	};

	editor.project.setActiveProject({ project });
	editor.scenes.initializeScenes({
		scenes: project.scenes,
		currentSceneId: project.currentSceneId,
	});

	return editor;
}

function getCaption(editor: EditorCore): TextElement {
	const track = editor.timeline.getTrackById({ trackId: "track-text-1" });
	const element = track?.elements[0];
	if (!element || element.type !== "text") {
		throw new Error("Caption element not found");
	}
	return element;
}

function expectCommand<T>(command: T | null): T {
	expect(command).not.toBeNull();
	if (command === null) {
		throw new Error("Expected command to be created");
	}
	return command;
}

describe("transition commands", () => {
	beforeEach(() => {
		EditorCore.reset();
	});

	test("apply transition undo removes both metadata and owned keyframes", () => {
		const editor = initializeEditorWithCaption();
		const initial = getCaption(editor);

		const command = buildApplyTransitionCommand({
			targets: [{ trackId: "track-text-1", element: initial }],
			side: "in",
			presetId: "fade",
			generateId: (() => {
				let index = 0;
				return () => `kf-${++index}`;
			})(),
			appliedAt: "2026-03-10T12:00:00.000Z",
		});

		editor.command.execute({ command: expectCommand(command) });

		const applied = getCaption(editor);
		expect(applied.transitions?.in?.presetId).toBe("fade");
		expect(applied.transitions?.in?.ownedKeyframes).toHaveLength(2);
		expect(applied.animations?.channels.opacity?.keyframes).toHaveLength(2);

		editor.command.undo();

		const undone = getCaption(editor);
		expect(undone.transitions?.in).toBeUndefined();
		expect(undone.animations?.channels.opacity).toBeUndefined();

		editor.command.redo();

		const redone = getCaption(editor);
		expect(redone.transitions?.in?.presetId).toBe("fade");
		expect(redone.animations?.channels.opacity?.keyframes).toHaveLength(2);
	});

	test("remove transition undo restores both metadata and owned keyframes", () => {
		const editor = initializeEditorWithCaption();
		const applyCommand = buildApplyTransitionCommand({
			targets: [{ trackId: "track-text-1", element: getCaption(editor) }],
			side: "in",
			presetId: "fade",
			generateId: (() => {
				let index = 0;
				return () => `kf-${++index}`;
			})(),
			appliedAt: "2026-03-10T12:00:00.000Z",
		});
		editor.command.execute({ command: expectCommand(applyCommand) });

		const removeCommand = buildRemoveTransitionCommand({
			targets: [{ trackId: "track-text-1", element: getCaption(editor) }],
			side: "in",
		});

		editor.command.execute({ command: expectCommand(removeCommand) });

		const removed = getCaption(editor);
		expect(removed.transitions?.in).toBeUndefined();
		expect(removed.animations?.channels.opacity).toBeUndefined();

		editor.command.undo();

		const restored = getCaption(editor);
		expect(restored.transitions?.in?.presetId).toBe("fade");
		expect(restored.animations?.channels.opacity?.keyframes).toHaveLength(2);
	});
});
