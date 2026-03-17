import type { EditorCore } from "@/core";
import type {
	AnimationInterpolation,
	AnimationPropertyPath,
	AnimationValue,
} from "@/types/animation";
import type {
	TrackType,
	TimelineTrack,
	TimelineElement,
	ClipboardItem,
	TextElement,
	VideoElement,
	AudioElement,
	TimelineGapSelection,
	TrackAudioEffects,
	VideoReframePreset,
	VideoSplitScreen,
	VideoSplitScreenSection,
} from "@/types/timeline";
import { calculateTotalDuration } from "@/lib/timeline";
import { expandElementIdsWithAlignedCompanions } from "@/lib/timeline/companion-media";
import {
	AddTrackCommand,
	RemoveTrackCommand,
	ToggleTrackMuteCommand,
	ToggleTrackVisibilityCommand,
	InsertElementCommand,
	UpdateElementTrimCommand,
	UpdateElementDurationCommand,
	DeleteElementsCommand,
	DeleteGapCommand,
	DuplicateElementsCommand,
	ToggleElementsVisibilityCommand,
	ToggleElementsMutedCommand,
	UpdateElementCommand,
	SplitElementsCommand,
	PasteCommand,
	UpdateElementStartTimeCommand,
	MoveElementCommand,
	TracksSnapshotCommand,
	UpsertKeyframeCommand,
	RemoveKeyframeCommand,
	RetimeKeyframeCommand,
} from "@/lib/commands/timeline";
import { BatchCommand, PreviewTracker } from "@/lib/commands";
import type { InsertElementParams } from "@/lib/commands/timeline/element/insert-element";
import { applyBlueHighlightCaptionPreset } from "@/constants/caption-presets";
import { normalizeTimelineTracksForInvariants } from "@/lib/timeline/element-timing";
import {
	buildVideoReframePreset,
	getReframePresetById,
	normalizeVideoReframeState,
	replaceOrInsertSplitSection,
	replaceOrInsertReframeSwitch,
} from "@/lib/reframe/video-reframe";
import { generateUUID } from "@/utils/id";

export class TimelineManager {
	private listeners = new Set<() => void>();
	private previewTracker = new PreviewTracker<TimelineTrack[]>();

	constructor(private editor: EditorCore) {}

	addTrack({ type, index }: { type: TrackType; index?: number }): string {
		const command = new AddTrackCommand(type, index);
		this.editor.command.execute({ command });
		return command.getTrackId();
	}

	removeTrack({ trackId }: { trackId: string }): void {
		const command = new RemoveTrackCommand(trackId);
		this.editor.command.execute({ command });
	}

	insertElement({ element, placement }: InsertElementParams): void {
		const normalizedElement =
			element.type === "text" && (element.captionWordTimings?.length ?? 0) > 0
				? (() => {
						const textElement = element as TextElement;
						const presetElement = applyBlueHighlightCaptionPreset({
							element: textElement,
						});
						return {
							...presetElement,
							...textElement,
							transform: textElement.transform ?? presetElement.transform,
							background: textElement.background ?? presetElement.background,
							captionStyle: {
								...(presetElement.captionStyle ?? {}),
								...(textElement.captionStyle ?? {}),
							},
						};
					})()
				: element;
		const command = new InsertElementCommand({
			element: normalizedElement,
			placement,
		});
		this.editor.command.execute({ command });
	}

	updateElementTrim({
		elementId,
		trimStart,
		trimEnd,
		startTime,
		duration,
		pushHistory = true,
		rippleEnabled = false,
		transcriptProjectionBase,
		captionSyncMode = "full",
	}: {
		elementId: string;
		trimStart: number;
		trimEnd: number;
		startTime?: number;
		duration?: number;
		pushHistory?: boolean;
		rippleEnabled?: boolean;
		transcriptProjectionBase?: {
			transcriptEdit:
				| VideoElement["transcriptDraft"]
				| AudioElement["transcriptDraft"];
			trimStart: number;
		};
		captionSyncMode?: "full" | "trim-only";
	}): void {
		const command = new UpdateElementTrimCommand({
			elementId,
			trimStart,
			trimEnd,
			startTime,
			duration,
			rippleEnabled,
			transcriptProjectionBase,
			captionSyncMode,
		});
		if (!pushHistory) {
			const currentTracks = this.getTracks();
			this.previewTracker.begin({ state: currentTracks });
			command.execute();
			return;
		}

		const previewSnapshot = this.previewTracker.end();
		if (previewSnapshot !== null) {
			command.execute();
			const updatedTracks = this.getTracks();
			const snapshotCommand = new TracksSnapshotCommand(
				previewSnapshot,
				updatedTracks,
			);
			this.editor.command.push({ command: snapshotCommand });
			return;
		}

		this.editor.command.execute({ command });
	}

	updateElementDuration({
		trackId,
		elementId,
		duration,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		duration: number;
		pushHistory?: boolean;
	}): void {
		const command = new UpdateElementDurationCommand(
			trackId,
			elementId,
			duration,
		);
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
	}

	updateElementStartTime({
		elements,
		startTime,
	}: {
		elements: { trackId: string; elementId: string }[];
		startTime: number;
	}): void {
		const command = new UpdateElementStartTimeCommand(elements, startTime);
		this.editor.command.execute({ command });
	}

	moveElement({
		sourceTrackId,
		targetTrackId,
		elementId,
		newStartTime,
		createTrack,
		rippleEnabled = false,
	}: {
		sourceTrackId: string;
		targetTrackId: string;
		elementId: string;
		newStartTime: number;
		createTrack?: { type: TrackType; index: number };
		rippleEnabled?: boolean;
	}): void {
		const command = new MoveElementCommand({
			sourceTrackId,
			targetTrackId,
			elementId,
			newStartTime,
			createTrack,
			rippleEnabled,
		});
		this.editor.command.execute({ command });
	}

	toggleTrackMute({ trackId }: { trackId: string }): void {
		const command = new ToggleTrackMuteCommand(trackId);
		this.editor.command.execute({ command });
	}

	toggleTrackVisibility({ trackId }: { trackId: string }): void {
		const command = new ToggleTrackVisibilityCommand(trackId);
		this.editor.command.execute({ command });
	}

	setAudioTrackVolume({
		trackId,
		volume,
		pushHistory = true,
	}: {
		trackId: string;
		volume: number;
		pushHistory?: boolean;
	}): void {
		const clampedVolume = Math.max(0, Math.min(2, volume));
		const currentTracks = this.getTracks();
		const updatedTracks = currentTracks.map((track) => {
			if (track.id !== trackId) return track;
			if (track.type !== "audio" && track.type !== "video") return track;
			return {
				...track,
				volume: clampedVolume,
			};
		});
		if (!pushHistory) {
			this.previewTracker.begin({ state: currentTracks });
			this.updateTracks(updatedTracks);
			return;
		}

		const previewSnapshot = this.previewTracker.end();
		if (previewSnapshot !== null) {
			this.updateTracks(updatedTracks);
			const command = new TracksSnapshotCommand(previewSnapshot, updatedTracks);
			this.editor.command.push({ command });
			return;
		}

		const command = new TracksSnapshotCommand(currentTracks, updatedTracks);
		this.editor.command.execute({ command });
	}

	setTrackAudioEffects({
		trackId,
		audioEffects,
		pushHistory = true,
	}: {
		trackId: string;
		audioEffects: TrackAudioEffects;
		pushHistory?: boolean;
	}): void {
		const currentTracks = this.getTracks();
		const updatedTracks = currentTracks.map((track) => {
			if (track.id !== trackId) return track;
			if (track.type !== "audio" && track.type !== "video") return track;
			return {
				...track,
				audioEffects,
			};
		});

		if (!pushHistory) {
			this.previewTracker.begin({ state: currentTracks });
			this.updateTracks(updatedTracks);
			return;
		}

		const previewSnapshot = this.previewTracker.end();
		if (previewSnapshot !== null) {
			this.updateTracks(updatedTracks);
			const command = new TracksSnapshotCommand(previewSnapshot, updatedTracks);
			this.editor.command.push({ command });
			return;
		}

		const command = new TracksSnapshotCommand(currentTracks, updatedTracks);
		this.editor.command.execute({ command });
	}

	updateTrackAudioEffect<
		TEffect extends keyof TrackAudioEffects,
	>({
		trackId,
		effect,
		updates,
		pushHistory = true,
	}: {
		trackId: string;
		effect: TEffect;
		updates: Partial<TrackAudioEffects[TEffect]>;
		pushHistory?: boolean;
	}): void {
		const track = this.getTrackById({ trackId });
		if (!track || (track.type !== "audio" && track.type !== "video")) return;
		this.setTrackAudioEffects({
			trackId,
			audioEffects: {
				...(track.audioEffects as TrackAudioEffects),
				[effect]: {
					...(track.audioEffects?.[effect] ?? {}),
					...updates,
				},
			} as TrackAudioEffects,
			pushHistory,
		});
	}

	createVideoReframePreset({
		trackId,
		elementId,
		name,
		transform,
		autoSeeded = false,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		name: string;
		transform: VideoReframePreset["transform"];
		autoSeeded?: boolean;
		pushHistory?: boolean;
	}): string | null {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element) return null;
		const preset = buildVideoReframePreset({
			name,
			transform,
			autoSeeded,
		});
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				reframePresets: [...(element.reframePresets ?? []), preset],
				defaultReframePresetId:
					element.defaultReframePresetId ?? preset.id,
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
		return preset.id;
	}

	updateVideoReframePreset({
		trackId,
		elementId,
		presetId,
		updates,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		presetId: string;
		updates: Partial<VideoReframePreset>;
		pushHistory?: boolean;
	}): void {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element) return;
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				reframePresets: (element.reframePresets ?? []).map((preset) =>
					preset.id === presetId
						? {
								...preset,
								...updates,
								transform: {
									...preset.transform,
									...(updates.transform ?? {}),
									position: {
										...preset.transform.position,
										...(updates.transform?.position ?? {}),
									},
								},
						  }
						: preset,
				),
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
	}

	duplicateVideoReframePreset({
		trackId,
		elementId,
		presetId,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		presetId: string;
		pushHistory?: boolean;
	}): string | null {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element) return null;
		const sourcePreset = getReframePresetById({ element, presetId });
		if (!sourcePreset) return null;
		const duplicatedPreset = {
			...sourcePreset,
			id: generateUUID(),
			name: `${sourcePreset.name} Copy`,
			autoSeeded: false,
		};
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				reframePresets: [...(element.reframePresets ?? []), duplicatedPreset],
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
		return duplicatedPreset.id;
	}

	deleteVideoReframePreset({
		trackId,
		elementId,
		presetId,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		presetId: string;
		pushHistory?: boolean;
	}): void {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element) return;
		const remainingPresets = (element.reframePresets ?? []).filter(
			(preset) => preset.id !== presetId,
		);
		const fallbackPresetId = remainingPresets[0]?.id ?? null;
		const nextSwitches = (element.reframeSwitches ?? []).flatMap((entry) => {
			if (entry.presetId !== presetId) {
				return [entry];
			}
			if (!fallbackPresetId) {
				return [];
			}
			return [{ ...entry, presetId: fallbackPresetId }];
		});
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				reframePresets: remainingPresets,
				reframeSwitches: nextSwitches,
				defaultReframePresetId:
					element.defaultReframePresetId === presetId
						? fallbackPresetId
						: element.defaultReframePresetId,
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
	}

	setVideoDefaultReframePreset({
		trackId,
		elementId,
		presetId,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		presetId: string;
		pushHistory?: boolean;
	}): void {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element) return;
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				defaultReframePresetId: presetId,
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
	}

	upsertVideoReframeSwitch({
		trackId,
		elementId,
		time,
		presetId,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		time: number;
		presetId: string;
		pushHistory?: boolean;
	}): string | null {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element) return null;
		const switchId = generateUUID();
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				reframeSwitches: replaceOrInsertReframeSwitch({
					switches: element.reframeSwitches,
					nextSwitch: {
						id: switchId,
						time,
						presetId,
					},
					duration: element.duration,
				}),
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
		return (
			nextElement.reframeSwitches?.find(
				(entry) => Math.abs(entry.time - time) < 1 / 1000,
			)?.id ?? switchId
		);
	}

	updateVideoReframeSwitch({
		trackId,
		elementId,
		switchId,
		updates,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		switchId: string;
		updates: Partial<NonNullable<VideoElement["reframeSwitches"]>[number]>;
		pushHistory?: boolean;
	}): void {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element) return;
		const existing = (element.reframeSwitches ?? []).find(
			(entry) => entry.id === switchId,
		);
		if (!existing) return;
		const remaining = (element.reframeSwitches ?? []).filter(
			(entry) => entry.id !== switchId,
		);
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				reframeSwitches: replaceOrInsertReframeSwitch({
					switches: remaining,
					nextSwitch: {
						...existing,
						...updates,
					},
					duration: element.duration,
				}),
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
	}

	removeVideoReframeSwitch({
		trackId,
		elementId,
		switchId,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		switchId: string;
		pushHistory?: boolean;
	}): void {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element) return;
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				reframeSwitches: (element.reframeSwitches ?? []).filter(
					(entry) => entry.id !== switchId,
				),
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
	}

	clearVideoReframeSwitches({
		trackId,
		elementId,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		pushHistory?: boolean;
	}): void {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element || (element.reframeSwitches?.length ?? 0) === 0) return;
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				reframeSwitches: [],
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
	}

	updateVideoSplitScreen({
		trackId,
		elementId,
		updates,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		updates: Partial<VideoSplitScreen> | null;
		pushHistory?: boolean;
	}): void {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element) return;
		const nextSplitScreen = updates
			? {
					...(element.splitScreen ?? {
						enabled: true,
						layoutPreset: "top-bottom" as const,
						slots: [],
						sections: [],
					}),
					...updates,
			  }
			: undefined;
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				splitScreen: nextSplitScreen,
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
	}

	upsertVideoSplitScreenSection({
		trackId,
		elementId,
		time,
		enabled = true,
		slots,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		time: number;
		enabled?: boolean;
		slots: VideoSplitScreenSection["slots"];
		pushHistory?: boolean;
	}): string | null {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element) return null;
		const splitScreen = element.splitScreen;
		if (!splitScreen) return null;
		const sectionId = generateUUID();
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				splitScreen: {
					...splitScreen,
					sections: replaceOrInsertSplitSection({
						sections: splitScreen.sections,
						nextSection: {
							id: sectionId,
							startTime: time,
							enabled,
							slots,
						},
						duration: element.duration,
					}),
				},
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
		return (
			nextElement.splitScreen?.sections?.find(
				(section) => Math.abs(section.startTime - time) < 1 / 1000,
			)?.id ?? sectionId
		);
	}

	removeVideoSplitScreenSection({
		trackId,
		elementId,
		sectionId,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		sectionId: string;
		pushHistory?: boolean;
	}): void {
		const element = this.getVideoElement({ trackId, elementId });
		if (!element?.splitScreen) return;
		const nextElement = normalizeVideoReframeState({
			element: {
				...element,
				splitScreen: {
					...element.splitScreen,
					sections: (element.splitScreen.sections ?? []).filter(
						(section) => section.id !== sectionId,
					),
				},
			},
		});
		this.updateSingleVideoElement({
			trackId,
			elementId,
			nextElement,
			pushHistory,
		});
	}

	splitElements({
		elements,
		splitTime,
		retainSide = "both",
		rippleEnabled = false,
	}: {
		elements: { trackId: string; elementId: string }[];
		splitTime: number;
		retainSide?: "both" | "left" | "right";
		rippleEnabled?: boolean;
	}): { trackId: string; elementId: string }[] {
		const companionExpandedIds = expandElementIdsWithAlignedCompanions({
			tracks: this.getTracks(),
			elementIds: elements.map((element) => element.elementId),
		});
		const expandedElements = this.getTracks().flatMap((track) =>
			track.elements
				.filter((element) => companionExpandedIds.has(element.id))
				.map((element) => ({
					trackId: track.id,
					elementId: element.id,
				})),
		);
		const command = new SplitElementsCommand({
			elements: expandedElements,
			splitTime,
			retainSide,
			rippleEnabled,
		});
		this.editor.command.execute({ command });
		return command.getRightSideElements();
	}

	getTotalDuration(): number {
		return calculateTotalDuration({ tracks: this.getTracks() });
	}

	getTrackById({ trackId }: { trackId: string }): TimelineTrack | null {
		return this.getTracks().find((track) => track.id === trackId) ?? null;
	}

	getElementsWithTracks({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): Array<{ track: TimelineTrack; element: TimelineElement }> {
		const result: Array<{ track: TimelineTrack; element: TimelineElement }> =
			[];

		for (const { trackId, elementId } of elements) {
			const track = this.getTrackById({ trackId });
			const element = track?.elements.find(
				(trackElement) => trackElement.id === elementId,
			);

			if (track && element) {
				result.push({ track, element });
			}
		}

		return result;
	}

	pasteAtTime({
		time,
		clipboardItems,
	}: {
		time: number;
		clipboardItems: ClipboardItem[];
	}): { trackId: string; elementId: string }[] {
		const command = new PasteCommand(time, clipboardItems);
		this.editor.command.execute({ command });
		return command.getPastedElements();
	}

	deleteElements({
		elements,
		rippleEnabled = false,
	}: {
		elements: { trackId: string; elementId: string }[];
		rippleEnabled?: boolean;
	}): void {
		const command = new DeleteElementsCommand({ elements, rippleEnabled });
		this.editor.command.execute({ command });
	}

	deleteGap({ gap }: { gap: TimelineGapSelection }): void {
		const command = new DeleteGapCommand({ gap });
		this.editor.command.execute({ command });
	}

	updateElements({
		updates,
		pushHistory = true,
	}: {
		updates: Array<{
			trackId: string;
			elementId: string;
			updates: Partial<Record<string, unknown>>;
		}>;
		pushHistory?: boolean;
	}): void {
		const expandedUpdates = this.expandLinkedCaptionUpdates({ updates });
		if (expandedUpdates.length === 0) return;
		const effectiveCommands = expandedUpdates.map(
			({ trackId, elementId, updates: elementUpdates }) =>
				new UpdateElementCommand(trackId, elementId, elementUpdates),
		);
		const command =
			effectiveCommands.length === 1
				? effectiveCommands[0]
				: new BatchCommand(effectiveCommands);
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
	}

	upsertKeyframes({
		keyframes,
	}: {
		keyframes: Array<{
			trackId: string;
			elementId: string;
			propertyPath: AnimationPropertyPath;
			time: number;
			value: AnimationValue;
			interpolation?: AnimationInterpolation;
			keyframeId?: string;
		}>;
	}): void {
		if (keyframes.length === 0) return;
		const commands = keyframes.map(
			({
				trackId,
				elementId,
				propertyPath,
				time,
				value,
				interpolation,
				keyframeId,
			}) =>
				new UpsertKeyframeCommand({
					trackId,
					elementId,
					propertyPath,
					time,
					value,
					interpolation,
					keyframeId,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	removeKeyframes({
		keyframes,
	}: {
		keyframes: Array<{
			trackId: string;
			elementId: string;
			propertyPath: AnimationPropertyPath;
			keyframeId: string;
		}>;
	}): void {
		if (keyframes.length === 0) return;
		const commands = keyframes.map(
			({ trackId, elementId, propertyPath, keyframeId }) =>
				new RemoveKeyframeCommand({
					trackId,
					elementId,
					propertyPath,
					keyframeId,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	retimeKeyframe({
		trackId,
		elementId,
		propertyPath,
		keyframeId,
		time,
	}: {
		trackId: string;
		elementId: string;
		propertyPath: AnimationPropertyPath;
		keyframeId: string;
		time: number;
	}): void {
		const command = new RetimeKeyframeCommand({
			trackId,
			elementId,
			propertyPath,
			keyframeId,
			nextTime: time,
		});
		this.editor.command.execute({ command });
	}

	isPreviewActive(): boolean {
		return this.previewTracker.isActive();
	}

	previewElements({
		updates,
	}: {
		updates: Array<{
			trackId: string;
			elementId: string;
			updates: Partial<Record<string, unknown>>;
		}>;
	}): void {
		const expandedUpdates = this.expandLinkedCaptionUpdates({ updates });
		const tracks = this.getTracks();
		this.previewTracker.begin({ state: tracks });

		let updatedTracks = tracks;
		for (const {
			trackId,
			elementId,
			updates: elementUpdates,
		} of expandedUpdates) {
			updatedTracks = updatedTracks.map((track) => {
				if (track.id !== trackId) return track;
				const newElements = track.elements.map((element) =>
					element.id === elementId
						? { ...element, ...elementUpdates }
						: element,
				);
				return { ...track, elements: newElements } as TimelineTrack;
			});
		}
		this.updateTracks(updatedTracks);
	}

	commitPreview(): void {
		const snapshot = this.previewTracker.end();
		if (snapshot === null) return;
		const currentTracks = this.getTracks();
		const command = new TracksSnapshotCommand(snapshot, currentTracks);
		this.editor.command.push({ command });
	}

	discardPreview(): void {
		const snapshot = this.previewTracker.end();
		if (snapshot !== null) {
			this.updateTracks(snapshot);
		}
	}

	duplicateElements({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): { trackId: string; elementId: string }[] {
		const command = new DuplicateElementsCommand({ elements });
		this.editor.command.execute({ command });
		return command.getDuplicatedElements();
	}

	toggleElementsVisibility({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): void {
		const command = new ToggleElementsVisibilityCommand(elements);
		this.editor.command.execute({ command });
	}

	toggleElementsMuted({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): void {
		const command = new ToggleElementsMutedCommand(elements);
		this.editor.command.execute({ command });
	}

	getTracks(): TimelineTrack[] {
		try {
			return this.editor.scenes.getActiveScene().tracks ?? [];
		} catch {
			// During initial boot (including SSR/prerender), no active scene may exist yet.
			return [];
		}
	}

	private getVideoElement({
		trackId,
		elementId,
	}: {
		trackId: string;
		elementId: string;
	}): VideoElement | null {
		const track = this.getTrackById({ trackId });
		if (!track || track.type !== "video") return null;
		const element = track.elements.find((entry) => entry.id === elementId);
		return element?.type === "video" ? normalizeVideoReframeState({ element }) : null;
	}

	private updateSingleVideoElement({
		trackId,
		elementId,
		nextElement,
		pushHistory,
	}: {
		trackId: string;
		elementId: string;
		nextElement: VideoElement;
		pushHistory: boolean;
	}): void {
		const currentTracks = this.getTracks();
		const updatedTracks = currentTracks.map((track) => {
			if (track.id !== trackId || track.type !== "video") return track;
			return {
				...track,
				elements: track.elements.map((element) =>
					element.id === elementId ? nextElement : element,
				),
			} as TimelineTrack;
		});

		if (!pushHistory) {
			this.previewTracker.begin({ state: currentTracks });
			this.updateTracks(updatedTracks);
			return;
		}

		const previewSnapshot = this.previewTracker.end();
		if (previewSnapshot !== null) {
			this.updateTracks(updatedTracks);
			const command = new TracksSnapshotCommand(previewSnapshot, updatedTracks);
			this.editor.command.push({ command });
			return;
		}

		const command = new TracksSnapshotCommand(currentTracks, updatedTracks);
		this.editor.command.execute({ command });
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

	updateTracks(newTracks: TimelineTrack[]): void {
		const currentTracks = this.getTracks();
		const projectFps = (() => {
			try {
				return this.editor.project.getActive().settings.fps;
			} catch {
				return 30;
			}
		})();
		const normalizedTracks = normalizeTimelineTracksForInvariants({
			tracks: newTracks,
			fps: projectFps,
		});
		if (currentTracks === normalizedTracks) return;
		this.editor.scenes.updateSceneTracks({ tracks: normalizedTracks });
		this.notify();
	}

	private isGeneratedCaptionElement(
		element: TimelineElement | undefined,
	): element is TextElement {
		return Boolean(
			element &&
				element.type === "text" &&
				element.name.startsWith("Caption ") &&
				(element.captionWordTimings?.length ?? 0) > 0,
		);
	}

	private isCaptionLinked(element: TextElement): boolean {
		return element.captionStyle?.linkedToCaptionGroup !== false;
	}

	private shouldSyncCaptionUpdate({
		element,
		elementUpdates,
	}: {
		element: TextElement;
		elementUpdates: Partial<Record<string, unknown>>;
	}): boolean {
		if (!this.isCaptionLinked(element)) return false;

		const captionStyleUpdate = elementUpdates.captionStyle as
			| TextElement["captionStyle"]
			| undefined;
		if (captionStyleUpdate?.linkedToCaptionGroup === false) {
			return false;
		}

		const excludedKeys = new Set([
			"content",
			"name",
			"startTime",
			"duration",
			"trimStart",
			"trimEnd",
			"captionWordTimings",
		]);
		return Object.keys(elementUpdates).some((key) => !excludedKeys.has(key));
	}

	private expandLinkedCaptionUpdates({
		updates,
	}: {
		updates: Array<{
			trackId: string;
			elementId: string;
			updates: Partial<Record<string, unknown>>;
		}>;
	}): Array<{
		trackId: string;
		elementId: string;
		updates: Partial<Record<string, unknown>>;
	}> {
		const tracks = this.getTracks();
		const trackById = new Map(tracks.map((track) => [track.id, track]));

		const getElement = ({
			trackId,
			elementId,
		}: {
			trackId: string;
			elementId: string;
		}): TimelineElement | undefined => {
			const track = trackById.get(trackId);
			return track?.elements.find((element) => element.id === elementId);
		};

		const normalizeUpdatesForTarget = ({
			trackId,
			elementId,
			updates: rawUpdates,
		}: {
			trackId: string;
			elementId: string;
			updates: Partial<Record<string, unknown>>;
		}): Partial<Record<string, unknown>> => {
			const element = getElement({ trackId, elementId });
			if (!this.isGeneratedCaptionElement(element)) {
				return rawUpdates;
			}

			const captionStyleUpdate = rawUpdates.captionStyle as
				| Record<string, unknown>
				| undefined;
			if (!captionStyleUpdate) {
				return rawUpdates;
			}

			return {
				...rawUpdates,
				captionStyle: {
					...(element.captionStyle ?? {}),
					...captionStyleUpdate,
				},
			};
		};
		const result = new Map<
			string,
			{
				trackId: string;
				elementId: string;
				updates: Partial<Record<string, unknown>>;
			}
		>();

		const upsert = ({
			trackId,
			elementId,
			updates: elementUpdates,
		}: {
			trackId: string;
			elementId: string;
			updates: Partial<Record<string, unknown>>;
		}) => {
			const key = `${trackId}:${elementId}`;
			const previous = result.get(key);
			const normalized = normalizeUpdatesForTarget({
				trackId,
				elementId,
				updates: elementUpdates,
			});
			const mergedCaptionStyle =
				previous?.updates.captionStyle && normalized.captionStyle
					? {
							...(previous.updates.captionStyle as Record<string, unknown>),
							...(normalized.captionStyle as Record<string, unknown>),
						}
					: normalized.captionStyle;
			const mergedUpdates: Partial<Record<string, unknown>> = {
				...(previous?.updates ?? {}),
				...normalized,
			};
			if (mergedCaptionStyle) {
				mergedUpdates.captionStyle = mergedCaptionStyle;
			}
			result.set(key, {
				trackId,
				elementId,
				updates: mergedUpdates,
			});
		};

		for (const update of updates) {
			upsert(update);
		}

		for (const update of updates) {
			const track = tracks.find((item) => item.id === update.trackId);
			const element = track?.elements.find(
				(item) => item.id === update.elementId,
			);
			if (!this.isGeneratedCaptionElement(element)) continue;
			if (
				!this.shouldSyncCaptionUpdate({
					element,
					elementUpdates: update.updates,
				})
			) {
				continue;
			}

			for (const captionTrack of tracks.filter(
				(item) => item.type === "text",
			)) {
				for (const captionElement of captionTrack.elements) {
					if (!this.isGeneratedCaptionElement(captionElement)) continue;
					if (!this.isCaptionLinked(captionElement)) continue;
					if (
						captionTrack.id === update.trackId &&
						captionElement.id === update.elementId
					) {
						continue;
					}

					const nextUpdates = { ...update.updates };
					if (nextUpdates.captionStyle) {
						nextUpdates.captionStyle = {
							...(captionElement.captionStyle ?? {}),
							...(nextUpdates.captionStyle as Record<string, unknown>),
							linkedToCaptionGroup:
								captionElement.captionStyle?.linkedToCaptionGroup ?? true,
						};
					}

					upsert({
						trackId: captionTrack.id,
						elementId: captionElement.id,
						updates: nextUpdates,
					});
				}
			}
		}

		return Array.from(result.values());
	}
}
