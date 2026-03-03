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
} from "@/types/timeline";
import { calculateTotalDuration } from "@/lib/timeline";
import {
	AddTrackCommand,
	RemoveTrackCommand,
	ToggleTrackMuteCommand,
	ToggleTrackVisibilityCommand,
	InsertElementCommand,
	UpdateElementTrimCommand,
	UpdateElementDurationCommand,
	DeleteElementsCommand,
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
import {
	applyBlueHighlightCaptionPreset,
} from "@/constants/caption-presets";

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
	}: {
		elementId: string;
		trimStart: number;
		trimEnd: number;
		startTime?: number;
		duration?: number;
		pushHistory?: boolean;
		rippleEnabled?: boolean;
	}): void {
		const command = new UpdateElementTrimCommand({
			elementId,
			trimStart,
			trimEnd,
			startTime,
			duration,
			rippleEnabled,
		});
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
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
	}: {
		trackId: string;
		volume: number;
	}): void {
		const clampedVolume = Math.max(0, Math.min(2, volume));
		const tracks = this.getTracks();
		const updatedTracks = tracks.map((track) => {
			if (track.id !== trackId || track.type !== "audio") return track;
			return {
				...track,
				volume: clampedVolume,
			};
		});
		this.updateTracks(updatedTracks);
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
		const command = new SplitElementsCommand({
			elements,
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
		return this.editor.scenes.getActiveScene()?.tracks ?? [];
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
		this.editor.scenes.updateSceneTracks({ tracks: newTracks });
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
			const element = track?.elements.find((item) => item.id === update.elementId);
			if (!this.isGeneratedCaptionElement(element)) continue;
			if (
				!this.shouldSyncCaptionUpdate({
					element,
					elementUpdates: update.updates,
				})
			) {
				continue;
			}

			for (const captionTrack of tracks.filter((item) => item.type === "text")) {
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
