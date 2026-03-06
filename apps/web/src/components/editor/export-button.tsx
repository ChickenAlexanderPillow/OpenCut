"use client";

import { useState, useRef } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import { getExportMimeType, getExportFileExtension } from "@/lib/export";
import { Check, Copy, Download, RotateCcw } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportQuality,
	type ExportResult,
} from "@/types/export";
import {
	Section,
	SectionContent,
	SectionHeader,
} from "@/components/editor/panels/properties/section";
import { useEditor } from "@/hooks/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/constants/export-constants";
import { useProjectProcessStore } from "@/stores/project-process-store";

const EDITOR_SUBSCRIBE_PROJECT = ["project", "timeline"] as const;

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor({ subscribeTo: EDITOR_SUBSCRIBE_PROJECT });

	const handleExport = () => {
		setIsExportPopoverOpen(true);
	};

	const hasProject = !!editor.project.getActive();

	return (
		<Popover open={isExportPopoverOpen} onOpenChange={setIsExportPopoverOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					onClick={hasProject ? handleExport : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							handleExport();
						}
					}}
				>
					<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
						<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-4" />
						<span className="z-50 text-[0.875rem]">Export</span>
						<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
							<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
						</div>
					</div>
				</button>
			</PopoverTrigger>
			{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
		</Popover>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor({ subscribeTo: EDITOR_SUBSCRIBE_PROJECT });
	const activeProject = editor.project.getActive();
	const timelineViewState = editor.project.getTimelineViewState();
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [includeAudio, setIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const [isExporting, setIsExporting] = useState(false);
	const [progress, setProgress] = useState(0);
	const [exportResult, setExportResult] = useState<ExportResult | null>(null);
	const cancelRequestedRef = useRef(false);
	const processIdRef = useRef<string | null>(null);
	const { registerProcess, updateProcessLabel, removeProcess } =
		useProjectProcessStore();
	const timelineDuration = editor.timeline.getTotalDuration();
	const inPoint =
		typeof timelineViewState.inPoint === "number"
			? Math.max(0, Math.min(timelineDuration, timelineViewState.inPoint))
			: null;
	const outPoint =
		typeof timelineViewState.outPoint === "number"
			? Math.max(0, Math.min(timelineDuration, timelineViewState.outPoint))
			: null;
	const exportStartTime = inPoint ?? 0;
	const exportEndTime = outPoint ?? timelineDuration;
	const hasRangeExport =
		(inPoint !== null || outPoint !== null) && exportEndTime > exportStartTime;

	const handleExport = async () => {
		if (!activeProject) return;

		cancelRequestedRef.current = false;
		const wasPlayingBeforeExport = editor.playback.getIsPlaying();
		if (wasPlayingBeforeExport) {
			editor.playback.pause();
		}
		setIsExporting(true);
		setProgress(0);
		setExportResult(null);
		processIdRef.current = registerProcess({
			projectId: activeProject.metadata.id,
			kind: "export",
			label: "Exporting project...",
			cancel: () => {
				cancelRequestedRef.current = true;
			},
		});

		let result: ExportResult;
		try {
			result = await editor.project.export({
				options: {
					format,
					quality,
					fps: activeProject.settings.fps,
					includeAudio,
					startTime: hasRangeExport ? exportStartTime : 0,
					endTime: hasRangeExport ? exportEndTime : timelineDuration,
					onProgress: ({ progress }) => {
						setProgress(progress);
						if (processIdRef.current) {
							updateProcessLabel({
								id: processIdRef.current,
								label: `Exporting project... ${Math.round(progress * 100)}%`,
							});
						}
					},
					onCancel: () => cancelRequestedRef.current,
				},
			});
		} finally {
			setIsExporting(false);
			if (processIdRef.current) {
				removeProcess({ id: processIdRef.current });
				processIdRef.current = null;
			}
			if (wasPlayingBeforeExport && !cancelRequestedRef.current) {
				editor.playback.play();
			}
		}

		if (result.cancelled) {
			setExportResult(null);
			setProgress(0);
			return;
		}

		setExportResult(result);

		if (result.success && result.buffer) {
			const mimeType = getExportMimeType({ format });
			const extension = getExportFileExtension({ format });
			const blob = new Blob([result.buffer], { type: mimeType });
			const url = URL.createObjectURL(blob);

			const a = document.createElement("a");
			a.href = url;
			a.download = `${activeProject.metadata.name}${extension}`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);

			onOpenChange(false);
			setExportResult(null);
			setProgress(0);
		}
	};

	const handleCancel = () => {
		cancelRequestedRef.current = true;
		if (processIdRef.current) {
			removeProcess({ id: processIdRef.current });
			processIdRef.current = null;
		}
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								<div className="flex flex-col">
									<Section collapsible defaultOpen={false} hasBorderTop={false}>
										<SectionHeader title="Format" />
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">
														MP4 (H.264) - Better compatibility
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">
														WebM (VP9) - Smaller file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader title="Quality" />
										<SectionContent>
											<RadioGroup
												value={quality}
												onValueChange={(value) => {
													if (isExportQuality(value)) {
														setQuality(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="low" id="low" />
													<Label htmlFor="low">Low - Smallest file size</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="medium" id="medium" />
													<Label htmlFor="medium">Medium - Balanced</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="high" id="high" />
													<Label htmlFor="high">High - Recommended</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="very_high" id="very_high" />
													<Label htmlFor="very_high">
														Very High - Largest file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader title="Audio" />
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={includeAudio}
													onCheckedChange={(checked) =>
														setIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">
													Include audio in export
												</Label>
											</div>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader title="Range" />
										<SectionContent>
											<p className="text-muted-foreground text-xs">
												{hasRangeExport
													? `In/Out region (${exportStartTime.toFixed(2)}s - ${exportEndTime.toFixed(2)}s)`
													: "Full timeline"}
											</p>
										</SectionContent>
									</Section>
								</div>

								<div className="p-3 pt-0">
									<Button onClick={handleExport} className="w-full gap-2">
										<Download className="size-4" />
										Export
									</Button>
								</div>
							</>
						)}

						{isExporting && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground mb-2 text-sm">
											{Math.round(progress * 100)}%
										</p>
										<p className="text-muted-foreground mb-2 text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={handleCancel}
								>
									Cancel
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}
