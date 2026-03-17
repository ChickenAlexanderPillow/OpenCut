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

function createVideoElement(): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video",
		startTime: 0,
		duration: 2,
		trimStart: 0,
		trimEnd: 0,
		mediaId: "video-media-1",
		muted: false,
		transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
	};
}

function createVideoElementWithLinkedReframe({
	id,
	name,
	startTime,
	mediaId = "video-media-1",
}: {
	id: string;
	name: string;
	startTime: number;
	mediaId?: string;
}): VideoElement {
	return {
		id,
		type: "video",
		name,
		startTime,
		duration: 4,
		trimStart: 0,
		trimEnd: 0,
		mediaId,
		muted: false,
		transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
		reframePresets: [
			{
				id: "preset-subject",
				name: "Subject",
				transform: { scale: 1.1, position: { x: 12, y: -8 } },
				autoSeeded: false,
			},
			{
				id: "preset-guest",
				name: "Guest",
				transform: { scale: 1.05, position: { x: -18, y: 6 } },
				autoSeeded: false,
			},
		],
		defaultReframePresetId: "preset-subject",
		splitScreen: {
			enabled: true,
			layoutPreset: "top-bottom",
			viewportBalance: "balanced",
			slots: [
				{
					slotId: "top",
					mode: "fixed-preset",
					presetId: "preset-subject",
				},
				{
					slotId: "bottom",
					mode: "fixed-preset",
					presetId: "preset-guest",
				},
			],
			sections: [
				{
					id: "split-section-1",
					startTime: 1,
					enabled: true,
					slots: [
						{
							slotId: "top",
							mode: "fixed-preset",
							presetId: "preset-subject",
						},
						{
							slotId: "bottom",
							mode: "fixed-preset",
							presetId: "preset-guest",
						},
					],
				},
			],
		},
		opacity: 1,
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

function initializeEditorWithPairedVideoAudio(): EditorCore {
	const editor = EditorCore.getInstance();
	const audio = createAudioElement();
	const video = createVideoElement();
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
	const scene: TScene = {
		id: "scene-1",
		name: "Main scene",
		isMain: true,
		tracks: [videoTrack, audioTrack],
		bookmarks: [],
		createdAt: new Date("2026-03-13T10:00:00.000Z"),
		updatedAt: new Date("2026-03-13T10:00:00.000Z"),
	};
	const project: TProject = {
		metadata: {
			id: "project-1",
			name: "Paired Trim",
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

function initializeEditorWithLinkedReframeVideos(): EditorCore {
	const editor = EditorCore.getInstance();
	const sourceVideo = createVideoElementWithLinkedReframe({
		id: "video-source",
		name: "Source Video",
		startTime: 0,
	});
	const independentVideo = createVideoElementWithLinkedReframe({
		id: "video-independent",
		name: "Independent Video",
		startTime: 5,
	});
	const scene: TScene = {
		id: "scene-1",
		name: "Main scene",
		isMain: true,
		tracks: [
			{
				id: "track-video-1",
				type: "video",
				name: "Video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [sourceVideo, independentVideo],
			},
		],
		bookmarks: [],
		createdAt: new Date("2026-03-13T10:00:00.000Z"),
		updatedAt: new Date("2026-03-13T10:00:00.000Z"),
	};
	const project: TProject = {
		metadata: {
			id: "project-1",
			name: "Linked Reframe Video",
			duration: 10,
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

	test("trimming a paired video also trims aligned uploaded audio with a different media id", () => {
		const editor = initializeEditorWithPairedVideoAudio();

		editor.timeline.updateElementTrim({
			elementId: "video-1",
			trimStart: 0,
			trimEnd: 0.5,
			duration: 1.5,
		});

		const videoTrack = editor.timeline.getTrackById({ trackId: "track-video-1" });
		expect(videoTrack?.type).toBe("video");
		if (videoTrack?.type !== "video") return;

		const audioTrack = editor.timeline.getTrackById({ trackId: "track-audio-1" });
		expect(audioTrack?.type).toBe("audio");
		if (audioTrack?.type !== "audio") return;

		expect(videoTrack.elements[0]?.duration).toBeCloseTo(1.5, 3);
		expect(videoTrack.elements[0]?.trimEnd).toBeCloseTo(0.5, 3);
		expect(audioTrack.elements[0]?.duration).toBeCloseTo(1.5, 3);
		expect(audioTrack.elements[0]?.trimEnd).toBeCloseTo(0.5, 3);
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

	test("split video descendants keep linked reframe framing in sync without affecting unrelated same-media clips", () => {
		const editor = initializeEditorWithLinkedReframeVideos();

		const splitResult = editor.timeline.splitElements({
			elements: [{ trackId: "track-video-1", elementId: "video-source" }],
			splitTime: 2,
		});
		const rightClipId = splitResult[0]?.elementId;
		expect(rightClipId).toBeDefined();
		if (!rightClipId) return;

		const videoTrackAfterSplit = editor.timeline.getTrackById({
			trackId: "track-video-1",
		});
		expect(videoTrackAfterSplit?.type).toBe("video");
		if (videoTrackAfterSplit?.type !== "video") return;

		const leftClip = videoTrackAfterSplit.elements.find(
			(element) => element.id === "video-source",
		);
		const rightClip = videoTrackAfterSplit.elements.find(
			(element) => element.id === rightClipId,
		);
		const independentClip = videoTrackAfterSplit.elements.find(
			(element) => element.id === "video-independent",
		);
		expect(leftClip?.type).toBe("video");
		expect(rightClip?.type).toBe("video");
		expect(independentClip?.type).toBe("video");
		if (
			leftClip?.type !== "video" ||
			rightClip?.type !== "video" ||
			independentClip?.type !== "video"
		) {
			return;
		}

		expect(leftClip.linkedReframeSourceId).toBeDefined();
		expect(rightClip.linkedReframeSourceId).toBe(leftClip.linkedReframeSourceId);
		expect(independentClip.linkedReframeSourceId).toBeUndefined();

		editor.timeline.updateVideoReframePreset({
			trackId: "track-video-1",
			elementId: leftClip.id,
			presetId: "preset-subject",
			updates: {
				transform: {
					scale: 1.42,
					position: { x: 44, y: -26 },
				},
			},
		});

		editor.timeline.updateVideoSplitScreen({
			trackId: "track-video-1",
			elementId: leftClip.id,
			updates: {
				...(leftClip.splitScreen ?? {
					enabled: true,
					layoutPreset: "top-bottom",
					viewportBalance: "balanced",
					slots: [],
					sections: [],
				}),
				viewportBalance: "unbalanced",
				slots: [
					{
						slotId: "top",
						mode: "fixed-preset",
						presetId: "preset-subject",
						transformAdjustmentsBySlotId: {
							"unbalanced:top": {
								sourceCenterOffset: { x: 24, y: -12 },
								scaleMultiplier: 1.18,
							},
						},
					},
					{
						slotId: "bottom",
						mode: "fixed-preset",
						presetId: "preset-guest",
					},
				],
			},
		});

		const videoTrackAfterUpdate = editor.timeline.getTrackById({
			trackId: "track-video-1",
		});
		expect(videoTrackAfterUpdate?.type).toBe("video");
		if (videoTrackAfterUpdate?.type !== "video") return;

		const syncedLeftClip = videoTrackAfterUpdate.elements.find(
			(element) => element.id === leftClip.id,
		);
		const syncedRightClip = videoTrackAfterUpdate.elements.find(
			(element) => element.id === rightClip.id,
		);
		const unchangedIndependentClip = videoTrackAfterUpdate.elements.find(
			(element) => element.id === independentClip.id,
		);
		expect(syncedLeftClip?.type).toBe("video");
		expect(syncedRightClip?.type).toBe("video");
		expect(unchangedIndependentClip?.type).toBe("video");
		if (
			syncedLeftClip?.type !== "video" ||
			syncedRightClip?.type !== "video" ||
			unchangedIndependentClip?.type !== "video"
		) {
			return;
		}

		expect(syncedRightClip.reframePresets).toEqual(syncedLeftClip.reframePresets);
		expect(syncedRightClip.splitScreen?.viewportBalance).toBe("unbalanced");
		expect(syncedRightClip.splitScreen?.slots).toEqual(
			syncedLeftClip.splitScreen?.slots,
		);
		expect(syncedRightClip.splitScreen?.sections?.map((section) => section.slots)).toEqual(
			syncedLeftClip.splitScreen?.sections?.map((section) => section.slots),
		);
		expect(unchangedIndependentClip.reframePresets?.find((preset) => preset.id === "preset-subject")?.transform).toEqual({
			scale: 1.1,
			position: { x: 12, y: -8 },
		});
		expect(unchangedIndependentClip.splitScreen?.viewportBalance).toBe("balanced");
	});
});
