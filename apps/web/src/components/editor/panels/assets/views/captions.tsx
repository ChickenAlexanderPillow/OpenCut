import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useState, useRef, useCallback } from "react";
import { extractTimelineAudio } from "@/lib/media/mediabunny";
import { useEditor } from "@/hooks/use-editor";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	DEFAULT_WORDS_PER_CAPTION,
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
import {
	Database,
	Languages,
	ListChecks,
	Sparkles,
	WandSparkles,
} from "lucide-react";
import { useTranscriptionStatusStore } from "@/stores/transcription-status-store";
import { useProjectProcessStore } from "@/stores/project-process-store";
import { evaluateTranscriptSuitability } from "@/lib/external-projects/transcript-suitability";

export function Captions() {
	const editor = useEditor();
	const transcriptionStatus = useTranscriptionStatusStore();
	const { registerProcess, updateProcessLabel, removeProcess } =
		useProjectProcessStore();

	const getInitialCaptionBehavior = useCallback(() => {
		const tracks = editor.timeline.getTracks();
		for (const track of tracks) {
			if (track.type !== "text") continue;
			for (const element of track.elements) {
				if (element.type !== "text") continue;
				if (!element.name.startsWith("Caption ")) continue;
				return {
					fitInCanvas: element.captionStyle?.fitInCanvas ?? true,
					karaokeWordHighlight:
						element.captionStyle?.karaokeWordHighlight ?? true,
				};
			}
		}
		return {
			fitInCanvas: true,
			karaokeWordHighlight: true,
		};
	}, [editor]);

	const initialCaptionBehavior = getInitialCaptionBehavior();
	const [selectedLanguage, setSelectedLanguage] =
		useState<TranscriptionLanguage>("auto");
	const [isProcessing, setIsProcessing] = useState(false);
	const [processingStep, setProcessingStep] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [fitCaptionsInCanvas, setFitCaptionsInCanvas] = useState(
		initialCaptionBehavior.fitInCanvas,
	);
	const [highlightSpokenWord, setHighlightSpokenWord] = useState(
		initialCaptionBehavior.karaokeWordHighlight,
	);
	const [captionGenerationMode, setCaptionGenerationMode] =
		useState<CaptionGenerationMode>("segment");
	const [wordsPerCaption, setWordsPerCaption] = useState(
		DEFAULT_WORDS_PER_CAPTION,
	);
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
	}: {
		segments: { text: string; start: number; end: number }[];
	}) => {
		const captionChunks = buildCaptionChunks({
			segments,
			mode: captionGenerationMode,
			wordsPerChunk: wordsPerCaption,
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
					fontSize: 65,
					fontWeight: "bold",
					captionStyle: {
						fitInCanvas: fitCaptionsInCanvas,
						karaokeWordHighlight: highlightSpokenWord,
						karaokeHighlightMode: "block",
						karaokeHighlightEaseInOnly: false,
						karaokeScaleHighlightedWord: false,
						karaokeUnderlineThickness: 3,
						karaokeHighlightColor: "#3B82F6",
						karaokeHighlightTextColor: "#FFFFFF",
						karaokeHighlightOpacity: 1,
						karaokeHighlightRoundness: 24,
						backgroundFitMode: "block",
						neverShrinkFont: false,
						wordsOnScreen: 3,
						maxLinesOnScreen: 2,
						wordDisplayPreset: "balanced",
						linkedToCaptionGroup: true,
						anchorToSafeAreaBottom: true,
						safeAreaBottomOffset: 0,
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
				setProcessingStep("Using linked transcript...");
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
			generateCaptionsFromSegments({ segments: result.segments });
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
			generateCaptionsFromSegments({ segments: cached.segments });
		} finally {
			setIsProcessing(false);
			setProcessingStep("");
		}
	};

	const handleSelectAllCaptions = () => {
		const tracks = editor.timeline.getTracks();
		const elements = tracks
			.filter((track) => track.type === "text")
			.flatMap((track) =>
				track.elements
					.filter(
						(element) =>
							element.type === "text" &&
							element.name.startsWith("Caption ") &&
							element.captionStyle?.linkedToCaptionGroup !== false,
					)
					.map((element) => ({
						trackId: track.id,
						elementId: element.id,
					})),
			);

		if (elements.length === 0) {
			toast.error("No captions found");
			return;
		}

		editor.selection.setSelectedElements({ elements });
		toast.success(`Selected ${elements.length} caption(s)`);
	};

	const applyCaptionBehaviorToExisting = useCallback(
		({
			fitInCanvas,
			karaokeWordHighlight,
		}: {
			fitInCanvas: boolean;
			karaokeWordHighlight: boolean;
		}) => {
			const tracks = editor.timeline.getTracks();
			const updates = tracks
				.filter((track) => track.type === "text")
				.flatMap((track) =>
					track.elements
						.filter(
							(element) =>
								element.type === "text" && element.name.startsWith("Caption "),
						)
						.map((element) => ({
							trackId: track.id,
							elementId: element.id,
							updates: {
								captionStyle: {
									...(element.captionStyle ?? {}),
									fitInCanvas,
									karaokeWordHighlight,
								},
							},
						})),
				);

			if (updates.length > 0) {
				editor.timeline.updateElements({ updates, pushHistory: false });
			}
		},
		[editor],
	);

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
					<Sparkles className="text-muted-foreground size-4" />
					<Label>Caption options</Label>
				</div>
				<div className="space-y-1.5">
					<Label>Caption grouping</Label>
					<Select
						value={captionGenerationMode}
						onValueChange={(value) =>
							setCaptionGenerationMode(value as CaptionGenerationMode)
						}
					>
						<SelectTrigger>
							<SelectValue placeholder="Select grouping mode" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="segment">Segment (recommended)</SelectItem>
							<SelectItem value="chunked">Chunked</SelectItem>
						</SelectContent>
					</Select>
				</div>
				{captionGenerationMode === "chunked" && (
					<div className="space-y-1.5">
						<Label>Words per caption chunk</Label>
						<Select
							value={String(wordsPerCaption)}
							onValueChange={(value) =>
								setWordsPerCaption(Math.max(1, Number.parseInt(value, 10) || 1))
							}
						>
							<SelectTrigger>
								<SelectValue placeholder="Words per chunk" />
							</SelectTrigger>
							<SelectContent>
								{[2, 3, 4, 5, 6].map((value) => (
									<SelectItem key={value} value={String(value)}>
										{value} words
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}
				<div className="flex items-center gap-2">
					<Checkbox
						id="captions-fit-canvas"
						checked={fitCaptionsInCanvas}
						onCheckedChange={(value) => {
							const next = Boolean(value);
							setFitCaptionsInCanvas(next);
							applyCaptionBehaviorToExisting({
								fitInCanvas: next,
								karaokeWordHighlight: highlightSpokenWord,
							});
						}}
					/>
					<Label htmlFor="captions-fit-canvas">
						Keep captions inside canvas bounds
					</Label>
				</div>
				<div className="flex items-center gap-2">
					<Checkbox
						id="captions-highlight-word"
						checked={highlightSpokenWord}
						onCheckedChange={(value) => {
							const next = Boolean(value);
							setHighlightSpokenWord(next);
							applyCaptionBehaviorToExisting({
								fitInCanvas: fitCaptionsInCanvas,
								karaokeWordHighlight: next,
							});
						}}
					/>
					<Label htmlFor="captions-highlight-word">
						Highlight current spoken word
					</Label>
				</div>
			</div>

			<div className="rounded-md border p-3 space-y-2">
				<div className="flex items-center gap-2">
					<WandSparkles className="text-muted-foreground size-4" />
					<Label>Generate</Label>
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

			<div className="rounded-md border p-3 space-y-2">
				<div className="flex items-center gap-2">
					<ListChecks className="text-muted-foreground size-4" />
					<Label>Manage captions</Label>
				</div>
				<Button
					className="w-full"
					variant="outline"
					onClick={handleSelectAllCaptions}
					disabled={isProcessing}
				>
					<ListChecks className="mr-1 size-4" />
					Select all captions in timeline
				</Button>
			</div>
		</PanelView>
	);
}
