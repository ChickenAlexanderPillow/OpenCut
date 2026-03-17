import type { AnimationPropertyPath, ElementAnimations } from "./animation";
import type { BlendMode, Transform } from "./rendering";
import type {
	TranscriptEditCutRange,
	TranscriptCutTimeDomain,
	TranscriptEditWord,
	TranscriptDraftState,
	TranscriptAppliedState,
	TranscriptCompileState,
	TranscriptProjectionSource,
	TranscriptSegmentUi,
} from "./transcription";

export interface Bookmark {
	time: number;
	note?: string;
	color?: string;
	duration?: number;
}

export interface TScene {
	id: string;
	name: string;
	isMain: boolean;
	tracks: TimelineTrack[];
	bookmarks: Bookmark[];
	createdAt: Date;
	updatedAt: Date;
}

export type TrackType = "video" | "text" | "audio" | "sticker";

export interface TrackEqEffect {
	enabled: boolean;
	lowGainDb: number;
	midGainDb: number;
	highGainDb: number;
	midFrequency: number;
	highFrequency: number;
}

export interface TrackCompressorEffect {
	enabled: boolean;
	thresholdDb: number;
	ratio: number;
	attackSeconds: number;
	releaseSeconds: number;
	makeupGainDb: number;
}

export interface TrackDeEsserEffect {
	enabled: boolean;
	amountDb: number;
	frequency: number;
	q: number;
}

export interface TrackLimiterEffect {
	enabled: boolean;
	ceilingDb: number;
	releaseSeconds: number;
}

export interface TrackAudioEffects {
	eq: TrackEqEffect;
	compressor: TrackCompressorEffect;
	deesser: TrackDeEsserEffect;
	limiter: TrackLimiterEffect;
}

export interface VideoReframePresetTransform {
	position: Transform["position"];
	scale: number;
}

export interface VideoReframePreset {
	id: string;
	name: string;
	transform: VideoReframePresetTransform;
	autoSeeded?: boolean;
}

export interface VideoReframeSwitch {
	id: string;
	time: number;
	presetId: string;
}

export type VideoSplitScreenLayoutPreset = "top-bottom";

export type VideoSplitScreenSlotMode = "follow-active" | "fixed-preset";

export interface VideoSplitScreenSlotTransformOverride {
	position: Transform["position"];
	scale: number;
}

export interface VideoSplitScreenSlotBinding {
	slotId: string;
	mode: VideoSplitScreenSlotMode;
	presetId?: string | null;
	transformOverride?: VideoSplitScreenSlotTransformOverride | null;
}

export interface VideoSplitScreenSection {
	id: string;
	startTime: number;
	enabled?: boolean;
	slots: VideoSplitScreenSlotBinding[];
}

export interface VideoSplitScreen {
	enabled: boolean;
	layoutPreset: VideoSplitScreenLayoutPreset;
	slots: VideoSplitScreenSlotBinding[];
	sections?: VideoSplitScreenSection[];
}

interface BaseTrack {
	id: string;
	name: string;
}

export interface VideoTrack extends BaseTrack {
	type: "video";
	elements: (VideoElement | ImageElement)[];
	isMain: boolean;
	muted: boolean;
	volume?: number;
	audioEffects?: TrackAudioEffects;
	hidden: boolean;
}

export interface TextTrack extends BaseTrack {
	type: "text";
	elements: TextElement[];
	hidden: boolean;
}

export interface AudioTrack extends BaseTrack {
	type: "audio";
	elements: AudioElement[];
	muted: boolean;
	volume?: number;
	audioEffects?: TrackAudioEffects;
}

export interface StickerTrack extends BaseTrack {
	type: "sticker";
	elements: StickerElement[];
	hidden: boolean;
}

export type TimelineTrack = VideoTrack | TextTrack | AudioTrack | StickerTrack;

export interface TimelineGapSelection {
	trackId: string;
	startTime: number;
	endTime: number;
}

export type { Transform } from "./rendering";

interface BaseAudioElement extends BaseTimelineElement {
	type: "audio";
	volume: number;
	muted?: boolean;
	buffer?: AudioBuffer;
	transcriptDraft?: TranscriptDraftState;
	transcriptApplied?: TranscriptAppliedState;
	transcriptCompileState?: TranscriptCompileState;
	transcriptEdit?: {
		version: 1;
		source: "word-level";
		words: TranscriptEditWord[];
		cuts: TranscriptEditCutRange[];
		cutTimeDomain?: TranscriptCutTimeDomain;
		projectionSource?: TranscriptProjectionSource;
		segmentsUi?: TranscriptSegmentUi[];
		updatedAt: string;
	};
}

export interface UploadAudioElement extends BaseAudioElement {
	sourceType: "upload";
	mediaId: string;
}

export interface LibraryAudioElement extends BaseAudioElement {
	sourceType: "library";
	sourceUrl: string;
}

export type AudioElement = UploadAudioElement | LibraryAudioElement;

interface BaseTimelineElement {
	id: string;
	name: string;
	duration: number;
	startTime: number;
	trimStart: number;
	trimEnd: number;
	animations?: ElementAnimations;
}

export interface VideoElement extends BaseTimelineElement {
	type: "video";
	mediaId: string;
	muted?: boolean;
	hidden?: boolean;
	transcriptDraft?: TranscriptDraftState;
	transcriptApplied?: TranscriptAppliedState;
	transcriptCompileState?: TranscriptCompileState;
	transcriptEdit?: {
		version: 1;
		source: "word-level";
		words: TranscriptEditWord[];
		cuts: TranscriptEditCutRange[];
		cutTimeDomain?: TranscriptCutTimeDomain;
		projectionSource?: TranscriptProjectionSource;
		segmentsUi?: TranscriptSegmentUi[];
		updatedAt: string;
	};
	transform: Transform;
	reframePresets?: VideoReframePreset[];
	reframeSwitches?: VideoReframeSwitch[];
	defaultReframePresetId?: string | null;
	reframeSeededBy?: "subject-aware-v1";
	splitScreen?: VideoSplitScreen;
	opacity: number;
	blendMode?: BlendMode;
	transitions?: ElementTransitions;
}

export interface ImageElement extends BaseTimelineElement {
	type: "image";
	mediaId: string;
	hidden?: boolean;
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	transitions?: ElementTransitions;
}

export interface TextElement extends BaseTimelineElement {
	type: "text";
	content: string;
	fontSize: number;
	fontFamily: string;
	color: string;
	strokeColor?: string;
	strokeWidth?: number;
	background: {
		color: string;
		cornerRadius?: number;
		paddingX?: number;
		paddingY?: number;
		offsetX?: number;
		offsetY?: number;
	};
	textAlign: "left" | "center" | "right";
	fontWeight: "normal" | "bold";
	fontStyle: "normal" | "italic";
	textDecoration: "none" | "underline" | "line-through";
	letterSpacing?: number;
	lineHeight?: number;
	hidden?: boolean;
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	transitions?: ElementTransitions;
	captionStyle?: {
		fitInCanvas?: boolean;
		neverShrinkFont?: boolean;
		karaokeWordHighlight?: boolean;
		karaokeHighlightMode?: "block" | "underline" | "word";
		karaokeHighlightEaseInOnly?: boolean;
		karaokeScaleHighlightedWord?: boolean;
		karaokeUnderlineThickness?: number;
		karaokeHighlightColor?: string;
		karaokeHighlightTextColor?: string;
		karaokeHighlightOpacity?: number;
		karaokeHighlightRoundness?: number;
		backgroundFitMode?: "block" | "line-fit";
		wordsOnScreen?: number;
		maxLinesOnScreen?: number;
		wordDisplayPreset?: "compact" | "balanced" | "extended" | "custom";
		linkedToCaptionGroup?: boolean;
		isSceneTitle?: boolean;
		anchorToSafeAreaBottom?: boolean;
		safeAreaBottomOffset?: number;
		anchorToSafeAreaTop?: boolean;
		safeAreaTopOffset?: number;
		splitScreenOverrides?: {
			enabled?: boolean;
			anchorToSplitViewport?: boolean;
			slotAnchor?: "auto" | "top" | "bottom" | "left" | "right";
			fitInCanvas?: boolean;
			wordsOnScreen?: number;
			maxLinesOnScreen?: number;
			anchorToSafeAreaBottom?: boolean;
			safeAreaBottomOffset?: number;
			anchorToSafeAreaTop?: boolean;
			safeAreaTopOffset?: number;
		};
	};
	captionWordTimings?: Array<{
		word: string;
		startTime: number;
		endTime: number;
		hidden?: boolean;
	}>;
	captionVisibilityWindows?: Array<{
		startTime: number;
		endTime: number;
	}>;
	captionSourceRef?: {
		mediaElementId: string;
		transcriptVersion: number;
	};
}

export interface StickerElement extends BaseTimelineElement {
	type: "sticker";
	stickerId: string;
	hidden?: boolean;
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	transitions?: ElementTransitions;
}

export interface TransitionOwnedKeyframeRef {
	propertyPath: AnimationPropertyPath;
	keyframeId: string;
}

export interface AppliedTransition {
	presetId: string;
	duration: number;
	ownedKeyframes: TransitionOwnedKeyframeRef[];
	appliedAt: string;
}

export interface ElementTransitions {
	in?: AppliedTransition;
	out?: AppliedTransition;
}

export type VisualElement =
	| VideoElement
	| ImageElement
	| TextElement
	| StickerElement;

export type TimelineElement =
	| AudioElement
	| VideoElement
	| ImageElement
	| TextElement
	| StickerElement;

export type ElementType = TimelineElement["type"];

export type CreateUploadAudioElement = Omit<UploadAudioElement, "id">;
export type CreateLibraryAudioElement = Omit<LibraryAudioElement, "id">;
export type CreateAudioElement =
	| CreateUploadAudioElement
	| CreateLibraryAudioElement;
export type CreateVideoElement = Omit<VideoElement, "id">;
export type CreateImageElement = Omit<ImageElement, "id">;
export type CreateTextElement = Omit<TextElement, "id">;
export type CreateStickerElement = Omit<StickerElement, "id">;
export type CreateTimelineElement =
	| CreateAudioElement
	| CreateVideoElement
	| CreateImageElement
	| CreateTextElement
	| CreateStickerElement;

export interface ElementDragState {
	isDragging: boolean;
	elementId: string | null;
	trackId: string | null;
	startMouseX: number;
	startMouseY: number;
	startElementTime: number;
	clickOffsetTime: number;
	currentTime: number;
	currentMouseY: number;
}

export interface DropTarget {
	trackIndex: number;
	isNewTrack: boolean;
	insertPosition: "above" | "below" | null;
	xPosition: number;
}

export interface ComputeDropTargetParams {
	elementType: ElementType;
	mouseX: number;
	mouseY: number;
	tracks: TimelineTrack[];
	playheadTime: number;
	isExternalDrop: boolean;
	elementDuration: number;
	pixelsPerSecond: number;
	zoomLevel: number;
	verticalDragDirection?: "up" | "down" | null;
	startTimeOverride?: number;
	excludeElementId?: string;
}

export interface ClipboardItem {
	trackId: string;
	trackType: TrackType;
	element: CreateTimelineElement;
	sourceElementId?: string;
}
