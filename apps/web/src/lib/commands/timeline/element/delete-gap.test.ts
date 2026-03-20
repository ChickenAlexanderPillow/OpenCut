import { beforeEach, describe, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import { DEFAULT_BRAND_OVERLAYS } from "@/constants/brand-overlay-constants";
import {
	DEFAULT_CANVAS_SIZE,
	DEFAULT_COLOR,
	DEFAULT_FPS,
} from "@/constants/project-constants";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { compileTranscriptDraft } from "@/lib/transcript-editor/state";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import type { TProject } from "@/types/project";
import type {
	AudioElement,
	AudioTrack,
	TextElement,
	TextTrack,
	TScene,
	VideoElement,
	VideoTrack,
} from "@/types/timeline";

function createAudioElement({
	startTime,
}: {
	startTime: number;
}): AudioElement {
	const transcriptDraft = {
		version: 1 as const,
		source: "word-level" as const,
		words: [
			{ id: "audio-1:word:0", text: "hello", startTime: 0.0, endTime: 0.3 },
			{ id: "audio-1:word:1", text: "world", startTime: 0.35, endTime: 0.75 },
		],
		cuts: [],
		updatedAt: "2026-03-20T12:00:00.000Z",
	};

	return {
		id: "audio-1",
		type: "audio",
		name: "Audio",
		startTime,
		duration: 2,
		trimStart: 0,
		trimEnd: 0,
		volume: 1,
		sourceType: "upload",
		mediaId: "shared-media-1",
		transcriptDraft,
		transcriptEdit: transcriptDraft,
		transcriptApplied: compileTranscriptDraft({
			mediaElementId: "audio-1",
			draft: transcriptDraft,
			mediaStartTime: startTime,
			mediaDuration: 2,
		}),
		transcriptCompileState: {
			status: "idle",
			updatedAt: transcriptDraft.updatedAt,
		},
	};
}

function createVideoElement({
	startTime,
}: {
	startTime: number;
}): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video",
		startTime,
		duration: 2,
		trimStart: 0,
		trimEnd: 0,
		mediaId: "shared-media-1",
		muted: false,
		transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
	};
}

function createCaption(audio: AudioElement): TextElement {
	const payload = audio.transcriptApplied?.captionPayload;
	if (!payload) {
		throw new Error("Expected transcript-applied caption payload");
	}
	return {
		...DEFAULT_TEXT_ELEMENT,
		id: "caption-1",
		name: "Caption 1",
		content: payload.content,
		startTime: payload.startTime,
		duration: payload.duration,
		captionWordTimings: payload.wordTimings,
		captionSourceRef: {
			mediaElementId: audio.id,
			transcriptVersion: 1,
		},
		captionStyle: {
			...(DEFAULT_TEXT_ELEMENT.captionStyle ?? {}),
			linkedToCaptionGroup: true,
		},
	};
}

function initializeEditor(): EditorCore {
	const editor = EditorCore.getInstance();
	const audio = createAudioElement({ startTime: 5 });
	const video = createVideoElement({ startTime: 5 });
	const caption = createCaption(audio);

	const audioTrack: AudioTrack = {
		id: "track-audio-1",
		type: "audio",
		name: "Audio",
		muted: false,
		elements: [audio],
	};
	const videoTrack: VideoTrack = {
		id: "track-video-1",
		type: "video",
		name: "Video",
		isMain: true,
		muted: false,
		hidden: false,
		elements: [video],
	};
	const textTrack: TextTrack = {
		id: "track-text-1",
		type: "text",
		name: "Captions",
		hidden: false,
		elements: [caption],
	};
	const scene: TScene = {
		id: "scene-1",
		name: "Main",
		isMain: true,
		tracks: [videoTrack, audioTrack, textTrack],
		bookmarks: [],
		createdAt: new Date("2026-03-20T12:00:00.000Z"),
		updatedAt: new Date("2026-03-20T12:00:00.000Z"),
	};
	const project: TProject = {
		metadata: {
			id: "project-1",
			name: "Delete Gap",
			duration: 7,
			createdAt: new Date("2026-03-20T12:00:00.000Z"),
			updatedAt: new Date("2026-03-20T12:00:00.000Z"),
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

describe("DeleteGapCommand", () => {
	beforeEach(() => {
		EditorCore.reset();
	});

	test("deleting a gap before video shifts aligned audio companion and linked caption", () => {
		const editor = initializeEditor();

		editor.timeline.deleteGap({
			gap: {
				trackId: "track-video-1",
				startTime: 0,
				endTime: 5,
			},
		});

		const videoTrack = editor.timeline.getTrackById({ trackId: "track-video-1" });
		expect(videoTrack?.type).toBe("video");
		if (videoTrack?.type !== "video") return;
		expect(videoTrack.elements[0]?.startTime).toBeCloseTo(0, 6);

		const textTrack = editor.timeline.getTrackById({ trackId: "track-text-1" });
		expect(textTrack?.type).toBe("text");
		if (textTrack?.type !== "text") return;
		const caption = textTrack.elements[0];
		expect(caption?.startTime).toBeCloseTo(0, 6);
		expect(caption?.duration).toBeCloseTo(videoTrack.elements[0]?.duration ?? 0, 6);
		expect(caption?.captionSourceRef?.mediaElementId).toBe("video-1");
		expect(caption?.captionWordTimings?.[0]?.startTime).toBeCloseTo(0, 6);
	});
});
