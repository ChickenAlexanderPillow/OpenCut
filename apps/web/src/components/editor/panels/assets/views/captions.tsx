import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useState, useRef } from "react";
import { extractTimelineAudio } from "@/lib/media/mediabunny";
import { useEditor } from "@/hooks/use-editor";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import {
	BLUE_HIGHLIGHT_CAPTION_STYLE,
	BLUE_HIGHLIGHT_CAPTION_TEXT_PROPS,
} from "@/constants/caption-presets";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	TRANSCRIPT_CACHE_VERSION,
	TRANSCRIPTION_LANGUAGES,
} from "@/constants/transcription-constants";
import type {
	TranscriptionLanguage,
	TranscriptionProgress,
} from "@/types/transcription";
import type { MediaAsset } from "@/types/assets";
import { transcriptionService } from "@/services/transcription/service";
import { decodeAudioToFloat32 } from "@/lib/media/audio";
import {
	buildCaptionChunks,
	type CaptionGenerationMode,
} from "@/lib/transcription/caption";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Database, Languages, WandSparkles } from "lucide-react";
import { useTranscriptionStatusStore } from "@/stores/transcription-status-store";
import { useProjectProcessStore } from "@/stores/project-process-store";
import { evaluateTranscriptSuitability } from "@/lib/external-projects/transcript-suitability";

export function Captions() {
	const editor = useEditor();
	const transcriptionStatus = useTranscriptionStatusStore();
	const { registerProcess, updateProcessLabel, removeProcess } =
		useProjectProcessStore();
	const [selectedLanguage, setSelectedLanguage] =
		useState<TranscriptionLanguage>("auto");
	const [includeSceneTitle, setIncludeSceneTitle] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);
	const [processingStep, setProcessingStep] = useState("");
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const buildTranscriptFingerprint = ({
		mediaAssets,
	}: {
		mediaAssets: MediaAsset[];
	}) => {
		const mediaIndex = new Map(mediaAssets.map((m) => [m.id, m]));
		const tracks = editor.timeline.getTracks();
		const audioSignature = tracks.flatMap((track) =>
			track.elements
				.filter(
					(element) => element.type === "audio" || element.type === "video",
				)
				.map((element) => {
					const mediaId = "mediaId" in element ? element.mediaId : "";
					const media = mediaId ? mediaIndex.get(mediaId) : null;
					return {
						type: element.type,
						mediaId,
						startTime: element.startTime,
						duration: element.duration,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						muted: "muted" in element ? (element.muted ?? false) : false,
						fileSize: media?.file.size ?? 0,
						lastModified: media?.file.lastModified ?? 0,
					};
				}),
		);

		return JSON.stringify({
			cacheVersion: TRANSCRIPT_CACHE_VERSION,
			modelId: DEFAULT_TRANSCRIPTION_MODEL,
			language: selectedLanguage === "auto" ? "auto" : selectedLanguage,
			audioSignature,
		});
	};

	const getCacheEntry = () => {
		const mediaAssets = editor.media.getAssets();
		const cacheFingerprint = buildTranscriptFingerprint({ mediaAssets });
		const cacheKey = `${DEFAULT_TRANSCRIPTION_MODEL}:${selectedLanguage}`;
		const activeProject = editor.project.getActive();
		const cached = activeProject.transcriptionCache?.[cacheKey];
		if (!cached) return null;
		if ((cached.cacheVersion ?? 1) !== TRANSCRIPT_CACHE_VERSION) return null;
		if (cached.fingerprint !== cacheFingerprint) return null;
		return cached;
	};

	const getLinkedTranscriptEntry = () => {
		const activeProject = editor.project.getActive();
		const entries = Object.values(activeProject.externalTranscriptCache ?? {});
		if (entries.length === 0) return null;
		const suitable = entries
			.map((entry) => ({
				entry,
				suitability: evaluateTranscriptSuitability({
					transcriptText: entry.transcriptText,
					segments: entry.segments,
					audioDurationSeconds: entry.audioDurationSeconds,
				}),
			}))
			.filter((item) => item.suitability.isSuitable)
			.sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt));
		return suitable[0]?.entry ?? null;
	};

	const upsertSceneTitleTrack = () => {
		const activeScene = editor.scenes.getActiveScene();
		const tracks = editor.timeline.getTracks();
		const totalDuration = editor.timeline.getTotalDuration();
		const titleDuration = totalDuration > 0 ? Math.min(5, totalDuration) : 5;
		const titleElement = {
			...DEFAULT_TEXT_ELEMENT,
			name: "Scene Title",
			content: activeScene.name,
			startTime: 0,
			duration: titleDuration,
			fontSize: 30,
			color: "#ffffff",
			strokeColor: "#000000",
			strokeWidth: 2,
			background: {
				...DEFAULT_TEXT_ELEMENT.background,
				color: "transparent",
			},
			captionStyle: {
				isSceneTitle: true,
				anchorToSafeAreaBottom: false,
				anchorToSafeAreaTop: true,
				safeAreaTopOffset: 0,
			},
		};
		const existing = tracks
			.filter((track) => track.type === "text")
			.flatMap((track) =>
				track.elements
					.filter((element) => element.captionStyle?.isSceneTitle === true)
					.map((element) => ({ trackId: track.id, elementId: element.id })),
			)[0];

		if (existing) {
			editor.timeline.updateElements({
				updates: [
					{
						trackId: existing.trackId,
						elementId: existing.elementId,
						updates: titleElement,
					},
				],
			});
			return;
		}

		const titleTrackId = editor.timeline.addTrack({
			type: "text",
			index: 0,
		});
		editor.timeline.insertElement({
			placement: { mode: "explicit", trackId: titleTrackId },
			element: titleElement,
		});
	};

	const removeSceneTitleTrack = () => {
		const tracks = editor.timeline.getTracks();
		const sceneTitleElements = tracks
			.filter((track) => track.type === "text")
			.flatMap((track) =>
				track.elements
					.filter((element) => element.captionStyle?.isSceneTitle === true)
					.map((element) => ({ trackId: track.id, elementId: element.id })),
			);
		const affectedTrackIds = new Set(sceneTitleElements.map((item) => item.trackId));

		if (sceneTitleElements.length === 0) return;
		editor.timeline.deleteElements({ elements: sceneTitleElements });

		const latestTracks = editor.timeline.getTracks();
		for (const track of latestTracks) {
			if (!affectedTrackIds.has(track.id)) continue;
			if (track.type !== "text") continue;
			if (track.elements.length > 0) continue;
			editor.timeline.removeTrack({ trackId: track.id });
		}
	};

	const handleProgress = (
		progress: TranscriptionProgress,
		operationId?: string,
		processId?: string,
	) => {
		if (progress.status === "loading-model") {
			setProcessingStep(`Loading model ${Math.round(progress.progress)}%`);
		} else if (progress.status === "transcribing") {
			setProcessingStep("Transcribing...");
		}
		transcriptionStatus.update({
			operationId,
			message: progress.message ?? "Generating transcript...",
			progress: progress.progress,
		});
		if (processId) {
			updateProcessLabel({
				id: processId,
				label:
					progress.message ??
					`Transcription ${Math.round(progress.progress)}%`,
			});
		}
	};

	const generateCaptionsFromSegments = ({
		segments,
		includeSceneTitleTrack,
	}: {
		segments: { text: string; start: number; end: number }[];
		includeSceneTitleTrack?: boolean;
	}) => {
		if (includeSceneTitleTrack) {
			upsertSceneTitleTrack();
		}

		const captionChunks = buildCaptionChunks({
			segments,
			mode: "segment" satisfies CaptionGenerationMode,
		});

		const captionTrackId = editor.timeline.addTrack({
			type: "text",
			index: 0,
		});

		for (let i = 0; i < captionChunks.length; i++) {
			const caption = captionChunks[i];
			editor.timeline.insertElement({
				placement: { mode: "explicit", trackId: captionTrackId },
				element: {
					...DEFAULT_TEXT_ELEMENT,
					name: `Caption ${i + 1}`,
					content: caption.text,
					duration: caption.duration,
					startTime: caption.startTime,
					captionWordTimings: caption.wordTimings,
					...BLUE_HIGHLIGHT_CAPTION_TEXT_PROPS,
					captionStyle: {
						...BLUE_HIGHLIGHT_CAPTION_STYLE,
						fitInCanvas: true,
						karaokeWordHighlight: true,
					},
				},
			});
		}
	};

	const handleTranscribeAndGenerateCaptions = async () => {
		let transcriptionOperationId: string | undefined;
		let projectProcessId: string | undefined;
		try {
			setIsProcessing(true);
			setError(null);
			const mediaAssets = editor.media.getAssets();
			const cacheFingerprint = buildTranscriptFingerprint({ mediaAssets });
			const cacheKey = `${DEFAULT_TRANSCRIPTION_MODEL}:${selectedLanguage}`;
			const activeProject = editor.project.getActive();
			const cached = activeProject.transcriptionCache?.[cacheKey];

			let result: {
				text: string;
				segments: { text: string; start: number; end: number }[];
			};
			const linkedTranscript = getLinkedTranscriptEntry();
			if (linkedTranscript) {
				setProcessingStep("Using linked transcript");
				result = {
					text: linkedTranscript.transcriptText,
					segments: linkedTranscript.segments,
				};
			} else if (cached && cached.fingerprint === cacheFingerprint) {
				setProcessingStep("Using cached transcript...");
				result = { text: cached.text, segments: cached.segments };
			} else {
				transcriptionOperationId = transcriptionStatus.start("Extracting audio...");
				projectProcessId = registerProcess({
					projectId: activeProject.metadata.id,
					kind: "transcription",
					label: "Generating transcript...",
					cancel: () => transcriptionService.cancel(),
				});
				setProcessingStep("Extracting audio...");
				const audioBlob = await extractTimelineAudio({
					tracks: editor.timeline.getTracks(),
					mediaAssets,
					totalDuration: editor.timeline.getTotalDuration(),
				});

				setProcessingStep("Preparing audio...");
				const { samples, sampleRate } = await decodeAudioToFloat32({
					audioBlob,
				});

				result = await transcriptionService.transcribe({
					audioData: samples,
					sampleRate,
					language: selectedLanguage === "auto" ? undefined : selectedLanguage,
					onProgress: (progress) =>
						handleProgress(
							progress,
							transcriptionOperationId,
							projectProcessId,
						),
				});

				const updatedProject = {
					...activeProject,
					transcriptionCache: {
						...(activeProject.transcriptionCache ?? {}),
						[cacheKey]: {
							cacheVersion: TRANSCRIPT_CACHE_VERSION,
							fingerprint: cacheFingerprint,
							language: selectedLanguage,
							modelId: DEFAULT_TRANSCRIPTION_MODEL,
							text: result.text,
							segments: result.segments,
							updatedAt: new Date().toISOString(),
						},
					},
				};
				editor.project.setActiveProject({ project: updatedProject });
				editor.save.markDirty();
			}

			setProcessingStep("Generating captions...");
			generateCaptionsFromSegments({
				segments: result.segments,
				includeSceneTitleTrack: includeSceneTitle,
			});
		} catch (error) {
			console.error("Transcription failed:", error);
			setError(
				error instanceof Error ? error.message : "An unexpected error occurred",
			);
		} finally {
			setIsProcessing(false);
			setProcessingStep("");
			transcriptionStatus.stop(transcriptionOperationId);
			if (projectProcessId) {
				removeProcess({ id: projectProcessId });
			}
		}
	};

	const handleGenerateCaptionsFromCachedTranscript = async () => {
		try {
			setIsProcessing(true);
			setError(null);
			const cached = getCacheEntry();
			if (!cached) {
				toast.error(
					"No valid cached transcript for current timeline/language. Run transcription once first.",
				);
				return;
			}
			setProcessingStep("Generating captions from cache...");
			generateCaptionsFromSegments({
				segments: cached.segments,
				includeSceneTitleTrack: includeSceneTitle,
			});
		} finally {
			setIsProcessing(false);
			setProcessingStep("");
		}
	};

	const handleLanguageChange = ({ value }: { value: string }) => {
		if (value === "auto") {
			setSelectedLanguage("auto");
			return;
		}

		const matchedLanguage = TRANSCRIPTION_LANGUAGES.find(
			(language) => language.code === value,
		);
		if (!matchedLanguage) return;
		setSelectedLanguage(matchedLanguage.code);
	};

	const hasValidCachedTranscript = Boolean(getCacheEntry());

	return (
		<PanelView
			title="Captions"
			ref={containerRef}
			contentClassName="space-y-3 pb-3"
		>
			<div className="rounded-md border p-3 space-y-2">
				<div className="flex items-center gap-2">
					<Languages className="text-muted-foreground size-4" />
					<Label>Transcript</Label>
				</div>
				<Select
					value={selectedLanguage}
					onValueChange={(value) => handleLanguageChange({ value })}
				>
					<SelectTrigger>
						<SelectValue placeholder="Select a language" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="auto">Auto detect</SelectItem>
						{TRANSCRIPTION_LANGUAGES.map((language) => (
							<SelectItem key={language.code} value={language.code}>
								{language.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="rounded-md border p-3 space-y-2">
				<div className="flex items-center gap-2">
					<WandSparkles className="text-muted-foreground size-4" />
					<Label>Generate</Label>
				</div>
				<div className="flex items-center justify-between rounded-sm border px-2 py-2">
					<div className="space-y-0.5">
						<p className="text-sm font-medium">Add scene title track</p>
						<p className="text-muted-foreground text-xs">
							Uses scene name as a 5s editable title at safe-area top.
						</p>
					</div>
					<Checkbox
						checked={includeSceneTitle}
						onCheckedChange={(checked) => {
							const enabled = Boolean(checked);
							setIncludeSceneTitle(enabled);
							if (enabled) {
								upsertSceneTitleTrack();
							} else {
								removeSceneTitleTrack();
							}
						}}
					/>
				</div>
				{error && (
					<div className="bg-destructive/10 border-destructive/20 rounded-md border p-3">
						<p className="text-destructive text-sm">{error}</p>
					</div>
				)}

				<Button
					className="w-full"
					onClick={handleTranscribeAndGenerateCaptions}
					disabled={isProcessing}
				>
					{!isProcessing && <WandSparkles className="mr-1 size-4" />}
					{isProcessing && <Spinner className="mr-1" />}
					{isProcessing ? processingStep : "Transcribe + generate captions"}
				</Button>
				<Button
					className="w-full"
					variant="outline"
					onClick={handleGenerateCaptionsFromCachedTranscript}
					disabled={isProcessing || !hasValidCachedTranscript}
				>
					<Database className="mr-1 size-4" />
					Generate captions from cached transcript
				</Button>
			</div>

		</PanelView>
	);
}
