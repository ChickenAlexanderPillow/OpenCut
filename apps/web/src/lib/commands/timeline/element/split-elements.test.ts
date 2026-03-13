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
} from "@/types/timeline";

function createAudioElement(): AudioElement {
	const transcriptDraft = {
		version: 1 as const,
		source: "word-level" as const,
		words: [
			{ id: "audio-1:word:0", text: "alpha", startTime: 0.0, endTime: 0.3 },
			{ id: "audio-1:word:1", text: "beta", startTime: 0.35, endTime: 0.75 },
			{ id: "audio-1:word:2", text: "gamma", startTime: 1.05, endTime: 1.35 },
			{ id: "audio-1:word:3", text: "delta", startTime: 1.4, endTime: 1.8 },
		],
		cuts: [],
		segmentsUi: [
			{
				id: "audio-1:seg:0",
				wordStartIndex: 0,
				wordEndIndex: 1,
				label: "Intro",
			},
			{
				id: "audio-1:seg:1",
				wordStartIndex: 2,
				wordEndIndex: 3,
				label: "Outro",
			},
		],
		updatedAt: "2026-03-13T10:00:00.000Z",
	};

	return {
		id: "audio-1",
		type: "audio",
		name: "Narration",
		startTime: 0,
		duration: 2,
		trimStart: 0,
		trimEnd: 0,
		volume: 1,
		sourceType: "upload",
		mediaId: "media-1",
		transcriptDraft,
		transcriptEdit: transcriptDraft,
		transcriptApplied: compileTranscriptDraft({
			mediaElementId: "audio-1",
			draft: transcriptDraft,
			mediaStartTime: 0,
			mediaDuration: 2,
		}),
		transcriptCompileState: {
			status: "idle",
			updatedAt: transcriptDraft.updatedAt,
		},
	};
}

function createCaption(audio: AudioElement): TextElement {
	const payload = audio.transcriptApplied?.captionPayload;
	if (!payload) {
		throw new Error("Caption payload missing");
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
	const audio = createAudioElement();
	const caption = createCaption(audio);
	const audioTrack: AudioTrack = {
		id: "track-audio-1",
		type: "audio",
		name: "Audio",
		muted: false,
		elements: [audio],
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
		name: "Main scene",
		isMain: true,
		tracks: [audioTrack, textTrack],
		bookmarks: [],
		createdAt: new Date("2026-03-13T10:00:00.000Z"),
		updatedAt: new Date("2026-03-13T10:00:00.000Z"),
	};
	const project: TProject = {
		metadata: {
			id: "project-1",
			name: "Split Captions",
			duration: 2,
			createdAt: new Date("2026-03-13T10:00:00.000Z"),
			updatedAt: new Date("2026-03-13T10:00:00.000Z"),
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


describe("SplitElementsCommand", () => {
	beforeEach(() => {
		EditorCore.reset();
	});

	test("splits transcript-driven captions and keeps split transcript state aligned", () => {
		const editor = initializeEditor();

		editor.timeline.splitElements({
			elements: [{ trackId: "track-audio-1", elementId: "audio-1" }],
			splitTime: 1,
		});

		const audioTrack = editor.timeline.getTrackById({ trackId: "track-audio-1" });
		expect(audioTrack?.type).toBe("audio");
		if (audioTrack?.type !== "audio") return;

		expect(audioTrack.elements).toHaveLength(2);
		const leftAudio = audioTrack.elements[0];
		const rightAudio = audioTrack.elements[1];
		expect(leftAudio.transcriptDraft?.words.map((word) => word.text)).toEqual([
			"alpha",
			"beta",
		]);
		expect(rightAudio.transcriptDraft?.words.map((word) => word.text)).toEqual([
			"gamma",
			"delta",
		]);
		expect(leftAudio.transcriptDraft?.segmentsUi?.[0]?.label).toBe("Intro");
		expect(rightAudio.transcriptDraft?.segmentsUi?.[0]?.label).toBe("Outro");
		expect(leftAudio.transcriptApplied?.captionPayload?.content).toBe("alpha beta");
		expect(rightAudio.transcriptApplied?.captionPayload?.content).toBe("gamma delta");

		const textTrack = editor.timeline.getTrackById({ trackId: "track-text-1" });
		expect(textTrack?.type).toBe("text");
		if (textTrack?.type !== "text") return;

		expect(textTrack.elements).toHaveLength(2);
		const [leftCaption, rightCaption] = textTrack.elements;
		expect(leftCaption.content).toBe("alpha beta");
		expect(rightCaption.content).toBe("gamma delta");
		expect(leftCaption.captionSourceRef?.mediaElementId).toBe(leftAudio.id);
		expect(rightCaption.captionSourceRef?.mediaElementId).toBe(rightAudio.id);
		expect(leftCaption.duration).toBeCloseTo(leftAudio.duration, 3);
		expect(rightCaption.duration).toBeCloseTo(rightAudio.duration, 3);
		expect(leftCaption.captionWordTimings?.map((timing) => timing.word)).toEqual([
			"alpha",
			"beta",
		]);
		expect(rightCaption.captionWordTimings?.map((timing) => timing.word)).toEqual([
			"gamma",
			"delta",
		]);
	});

	test("trimming the start of a split right clip keeps linked caption timings aligned", () => {
		const editor = initializeEditor();

		const rightSideElements = editor.timeline.splitElements({
			elements: [{ trackId: "track-audio-1", elementId: "audio-1" }],
			splitTime: 1,
		});
		const rightClipId = rightSideElements[0]?.elementId;
		expect(rightClipId).toBeDefined();
		if (!rightClipId) return;

		editor.timeline.updateElementTrim({
			elementId: rightClipId,
			trimStart: 1.2,
			trimEnd: 0,
			startTime: 1.2,
			duration: 0.8,
		});

		const audioTrack = editor.timeline.getTrackById({ trackId: "track-audio-1" });
		expect(audioTrack?.type).toBe("audio");
		if (audioTrack?.type !== "audio") return;

		const rightAudio = audioTrack.elements.find((element) => element.id === rightClipId);
		expect(rightAudio).toBeDefined();
		if (!rightAudio) return;
		expect(rightAudio.startTime).toBeCloseTo(1.2, 3);
		expect(rightAudio.duration).toBeCloseTo(0.8, 3);
		expect(rightAudio.transcriptDraft?.words.map((word) => word.text)).toEqual([
			"gamma",
			"delta",
		]);
		expect(rightAudio.transcriptApplied?.captionPayload?.wordTimings[0]?.startTime).toBeCloseTo(
			1.2,
			3,
		);

		const textTrack = editor.timeline.getTrackById({ trackId: "track-text-1" });
		expect(textTrack?.type).toBe("text");
		if (textTrack?.type !== "text") return;

		const rightCaption = textTrack.elements.find(
			(element) => element.captionSourceRef?.mediaElementId === rightClipId,
		);
		expect(rightCaption).toBeDefined();
		if (!rightCaption) return;
		expect(rightCaption.startTime).toBeCloseTo(1.2, 3);
		expect(rightCaption.duration).toBeCloseTo(0.8, 3);
		expect(rightCaption.captionWordTimings?.[0]?.startTime).toBeCloseTo(1.2, 3);
		expect(rightCaption.captionWordTimings?.[0]?.endTime).toBeCloseTo(1.35, 3);
		expect(rightCaption.captionWordTimings?.[1]?.startTime).toBeCloseTo(1.4, 3);
		expect(rightCaption.captionWordTimings?.[1]?.endTime).toBeCloseTo(1.8, 3);
	});

	test("resize-style trim preview followed by commit keeps split right caption synced", () => {
		const editor = initializeEditor();

		const rightSideElements = editor.timeline.splitElements({
			elements: [{ trackId: "track-audio-1", elementId: "audio-1" }],
			splitTime: 1,
		});
		const rightClipId = rightSideElements[0]?.elementId;
		expect(rightClipId).toBeDefined();
		if (!rightClipId) return;

		const audioTrackBeforePreview = editor.timeline.getTrackById({
			trackId: "track-audio-1",
		});
		expect(audioTrackBeforePreview?.type).toBe("audio");
		if (audioTrackBeforePreview?.type !== "audio") return;
		const rightAudioBeforePreview = audioTrackBeforePreview.elements.find(
			(element) => element.id === rightClipId,
		);
		expect(rightAudioBeforePreview).toBeDefined();
		if (!rightAudioBeforePreview) return;

		editor.timeline.updateElementTrim({
			elementId: rightClipId,
			trimStart: 1.2,
			trimEnd: 0,
			startTime: 1.2,
			duration: 0.8,
			pushHistory: false,
			captionSyncMode: "trim-only",
			transcriptProjectionBase: rightAudioBeforePreview.transcriptDraft
				? {
						transcriptEdit: rightAudioBeforePreview.transcriptDraft,
						trimStart: rightAudioBeforePreview.trimStart,
				  }
				: undefined,
		});

		editor.timeline.updateElementTrim({
			elementId: rightClipId,
			trimStart: 1.2,
			trimEnd: 0,
			startTime: 1.2,
			duration: 0.8,
			transcriptProjectionBase: rightAudioBeforePreview.transcriptDraft
				? {
						transcriptEdit: rightAudioBeforePreview.transcriptDraft,
						trimStart: rightAudioBeforePreview.trimStart,
				  }
				: undefined,
		});

		const textTrack = editor.timeline.getTrackById({ trackId: "track-text-1" });
		expect(textTrack?.type).toBe("text");
		if (textTrack?.type !== "text") return;

		const rightCaption = textTrack.elements.find(
			(element) => element.captionSourceRef?.mediaElementId === rightClipId,
		);
		expect(rightCaption).toBeDefined();
		if (!rightCaption) return;
		expect(rightCaption.startTime).toBeCloseTo(1.2, 3);
		expect(rightCaption.duration).toBeCloseTo(0.8, 3);
		expect(rightCaption.captionWordTimings?.[0]?.startTime).toBeCloseTo(1.2, 3);
		expect(rightCaption.captionWordTimings?.[1]?.endTime).toBeCloseTo(1.8, 3);
	});

	test("extending the kept left split clip restores captions from original transcript source", () => {
		const editor = initializeEditor();

		editor.timeline.splitElements({
			elements: [{ trackId: "track-audio-1", elementId: "audio-1" }],
			splitTime: 1,
		});

		const audioTrackAfterSplit = editor.timeline.getTrackById({
			trackId: "track-audio-1",
		});
		expect(audioTrackAfterSplit?.type).toBe("audio");
		if (audioTrackAfterSplit?.type !== "audio") return;
		const leftAudio = audioTrackAfterSplit.elements.find(
			(element) => element.startTime === 0,
		);
		const rightAudio = audioTrackAfterSplit.elements.find(
			(element) => element.startTime === 1,
		);
		expect(leftAudio).toBeDefined();
		expect(rightAudio).toBeDefined();
		if (!leftAudio || !rightAudio) return;

		editor.timeline.deleteElements({
			elements: [{ trackId: "track-audio-1", elementId: rightAudio.id }],
		});

		editor.timeline.updateElementTrim({
			elementId: leftAudio.id,
			trimStart: 0,
			trimEnd: 0,
			startTime: 0,
			duration: 2,
		});

		const audioTrack = editor.timeline.getTrackById({ trackId: "track-audio-1" });
		expect(audioTrack?.type).toBe("audio");
		if (audioTrack?.type !== "audio") return;
		const restoredAudio = audioTrack.elements.find((element) => element.id === leftAudio.id);
		expect(restoredAudio).toBeDefined();
		if (!restoredAudio) return;
		expect(restoredAudio.duration).toBeCloseTo(2, 3);
		expect(restoredAudio.transcriptDraft?.words.map((word) => word.text)).toEqual([
			"alpha",
			"beta",
			"gamma",
			"delta",
		]);

		const textTrack = editor.timeline.getTrackById({ trackId: "track-text-1" });
		expect(textTrack?.type).toBe("text");
		if (textTrack?.type !== "text") return;
		const restoredCaption = textTrack.elements.find(
			(element) => element.captionSourceRef?.mediaElementId === leftAudio.id,
		);
		expect(restoredCaption).toBeDefined();
		if (!restoredCaption) return;
		expect(restoredCaption.content).toBe("alpha beta gamma delta");
		expect(restoredCaption.duration).toBeCloseTo(2, 3);
		expect(restoredCaption.captionWordTimings?.map((timing) => timing.word)).toEqual([
			"alpha",
			"beta",
			"gamma",
			"delta",
		]);
	});

	test("splitting an already split right clip keeps transcript-driven captions aligned", () => {
		const editor = initializeEditor();

		const firstRightSide = editor.timeline.splitElements({
			elements: [{ trackId: "track-audio-1", elementId: "audio-1" }],
			splitTime: 1,
		});
		const firstRightClipId = firstRightSide[0]?.elementId;
		expect(firstRightClipId).toBeDefined();
		if (!firstRightClipId) return;

		editor.timeline.splitElements({
			elements: [{ trackId: "track-audio-1", elementId: firstRightClipId }],
			splitTime: 1.4,
		});

		const audioTrack = editor.timeline.getTrackById({ trackId: "track-audio-1" });
		expect(audioTrack?.type).toBe("audio");
		if (audioTrack?.type !== "audio") return;
		expect(audioTrack.elements).toHaveLength(3);

		const [leftAudio, middleAudio, rightAudio] = audioTrack.elements;
		expect(leftAudio.transcriptDraft?.words.map((word) => word.text)).toEqual([
			"alpha",
			"beta",
		]);
		expect(middleAudio.transcriptDraft?.words.map((word) => word.text)).toEqual([
			"gamma",
		]);
		expect(rightAudio.transcriptDraft?.words.map((word) => word.text)).toEqual([
			"delta",
		]);

		const textTrack = editor.timeline.getTrackById({ trackId: "track-text-1" });
		expect(textTrack?.type).toBe("text");
		if (textTrack?.type !== "text") return;
		expect(textTrack.elements).toHaveLength(3);

		const [leftCaption, middleCaption, rightCaption] = textTrack.elements;
		expect(leftCaption.content).toBe("alpha beta");
		expect(middleCaption.content).toBe("gamma");
		expect(rightCaption.content).toBe("delta");
		expect(middleCaption.captionSourceRef?.mediaElementId).toBe(middleAudio.id);
		expect(rightCaption.captionSourceRef?.mediaElementId).toBe(rightAudio.id);
		expect(middleCaption.startTime).toBeCloseTo(middleAudio.startTime, 3);
		expect(middleCaption.duration).toBeCloseTo(middleAudio.duration, 3);
		expect(middleCaption.captionWordTimings?.[0]?.startTime).toBeCloseTo(1.05, 3);
		expect(middleCaption.captionWordTimings?.[0]?.endTime).toBeCloseTo(1.35, 3);
		expect(rightCaption.startTime).toBeCloseTo(rightAudio.startTime, 3);
		expect(rightCaption.duration).toBeCloseTo(rightAudio.duration, 3);
		expect(rightCaption.captionWordTimings?.[0]?.startTime).toBeCloseTo(1.4, 3);
		expect(rightCaption.captionWordTimings?.[0]?.endTime).toBeCloseTo(1.8, 3);
	});
});
