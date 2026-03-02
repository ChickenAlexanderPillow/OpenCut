"use client";

import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { FPS_PRESETS } from "@/constants/project-constants";
import { useEditor } from "@/hooks/use-editor";
import { useEditorStore } from "@/stores/editor-store";
import { dimensionToAspectRatio } from "@/utils/geometry";
import {
	Section,
	SectionContent,
	SectionHeader,
} from "@/components/editor/panels/properties/section";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { evaluateTranscriptSuitability } from "@/lib/external-projects/transcript-suitability";

export function SettingsView() {
	const [open, setOpen] = useState(false);

	return (
		<PanelView contentClassName="px-0" hideHeader>
			<div className="flex flex-col">
				<Section hasBorderTop={false}>
					<SectionContent>
						<ProjectInfoContent />
					</SectionContent>
				</Section>
				<Popover open={open} onOpenChange={setOpen}>
					<Section className="cursor-pointer">
						<PopoverTrigger asChild>
							<div>
								<SectionHeader title="Background">
									<div className="size-4 rounded-sm bg-red-500" />
								</SectionHeader>
							</div>
						</PopoverTrigger>
					</Section>
					<PopoverContent>
						<div className="size-4 rounded-sm bg-red-500" />
					</PopoverContent>
				</Popover>
				<Section>
					<SectionContent>
						<LinkedThumbnailProjectSection />
					</SectionContent>
				</Section>
			</div>
		</PanelView>
	);
}

function ProjectInfoContent() {
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const { canvasPresets } = useEditorStore();

	const findPresetIndexByAspectRatio = ({
		presets,
		targetAspectRatio,
	}: {
		presets: Array<{ width: number; height: number }>;
		targetAspectRatio: string;
	}) => {
		for (let index = 0; index < presets.length; index++) {
			const preset = presets[index];
			const presetAspectRatio = dimensionToAspectRatio({
				width: preset.width,
				height: preset.height,
			});
			if (presetAspectRatio === targetAspectRatio) {
				return index;
			}
		}
		return -1;
	};

	const currentCanvasSize = activeProject.settings.canvasSize;
	const currentAspectRatio = dimensionToAspectRatio(currentCanvasSize);
	const originalCanvasSize = activeProject.settings.originalCanvasSize ?? null;
	const presetIndex = findPresetIndexByAspectRatio({
		presets: canvasPresets,
		targetAspectRatio: currentAspectRatio,
	});
	const originalPresetValue = "original";
	const selectedPresetValue =
		presetIndex !== -1 ? presetIndex.toString() : originalPresetValue;

	const handleAspectRatioChange = ({ value }: { value: string }) => {
		if (value === originalPresetValue) {
			const canvasSize = originalCanvasSize ?? currentCanvasSize;
			editor.project.updateSettings({
				settings: { canvasSize },
			});
			return;
		}
		const index = parseInt(value, 10);
		const preset = canvasPresets[index];
		if (preset) {
			editor.project.updateSettings({ settings: { canvasSize: preset } });
		}
	};

	const handleFpsChange = (value: string) => {
		const fps = parseFloat(value);
		editor.project.updateSettings({ settings: { fps } });
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<Label>Name</Label>
				<span className="leading-none text-sm">
					{activeProject.metadata.name}
				</span>
			</div>
			<div className="flex flex-col gap-2">
				<Label>Aspect ratio</Label>
				<Select
					value={selectedPresetValue}
					onValueChange={(value) => handleAspectRatioChange({ value })}
				>
					<SelectTrigger className="w-fit">
						<SelectValue placeholder="Select an aspect ratio" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={originalPresetValue}>Original</SelectItem>
						{canvasPresets.map((preset, index) => {
							const label = dimensionToAspectRatio({
								width: preset.width,
								height: preset.height,
							});
							return (
								<SelectItem key={label} value={index.toString()}>
									{label}
								</SelectItem>
							);
						})}
					</SelectContent>
				</Select>
			</div>
			<div className="flex flex-col gap-2">
				<Label>Frame rate</Label>
				<Select
					value={activeProject.settings.fps.toString()}
					onValueChange={handleFpsChange}
				>
					<SelectTrigger className="w-fit">
						<SelectValue placeholder="Select a frame rate" />
					</SelectTrigger>
					<SelectContent>
						{FPS_PRESETS.map((preset) => (
							<SelectItem key={preset.value} value={preset.value}>
								{preset.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</div>
	);
}

function LinkedThumbnailProjectSection() {
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const [externalProjectId, setExternalProjectId] = useState(
		activeProject.externalProjectLink?.externalProjectId ?? "",
	);
	const [isLinking, setIsLinking] = useState(false);
	const [isApplying, setIsApplying] = useState(false);

	const isLinked = Boolean(activeProject.externalProjectLink?.externalProjectId);
	const linkedLabel = isLinked ? "Linked" : "Unlinked";

	const applyLinkedTranscript = async () => {
		setIsApplying(true);
		try {
			const response = await fetch(
				`/api/external-projects/${encodeURIComponent(activeProject.metadata.id)}/transcript/apply`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				},
			);
			const json = (await response.json()) as
				| {
						error?: string;
						sourceSystem: "thumbnail_decoupled";
						externalProjectId: string;
						transcriptText: string;
						segments: Array<{ text: string; start: number; end: number }>;
						segmentsCount: number;
						audioDurationSeconds: number | null;
						qualityMeta?: Record<string, unknown>;
						updatedAt: string;
						suitability: {
							isSuitable: boolean;
							reasons: string[];
						};
				  }
				| { error: string };

			if (!response.ok || "error" in json) {
				throw new Error(json.error || "Failed to apply transcript");
			}

			const suitability = evaluateTranscriptSuitability({
				transcriptText: json.transcriptText,
				segments: json.segments,
				audioDurationSeconds: json.audioDurationSeconds,
			});
			if (!suitability.isSuitable) {
				toast.warning(
					`Linked transcript is currently unsuitable: ${suitability.reasons.join(", ")}`,
				);
			}

			const key = `${json.sourceSystem}:${json.externalProjectId}`;
			editor.project.setActiveProject({
				project: {
					...activeProject,
					externalProjectLink: {
						sourceSystem: json.sourceSystem,
						externalProjectId: json.externalProjectId,
						opencutProjectId: activeProject.metadata.id,
						linkedAt: new Date().toISOString(),
					},
					externalTranscriptCache: {
						...(activeProject.externalTranscriptCache ?? {}),
						[key]: {
							sourceSystem: json.sourceSystem,
							externalProjectId: json.externalProjectId,
							transcriptText: json.transcriptText,
							segments: json.segments,
							segmentsCount: json.segmentsCount,
							audioDurationSeconds: json.audioDurationSeconds,
							qualityMeta: json.qualityMeta,
							updatedAt: json.updatedAt,
						},
					},
				},
			});
			editor.save.markDirty();
			toast.success("Linked transcript applied");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to apply transcript",
			);
		} finally {
			setIsApplying(false);
		}
	};

	const handleLink = async () => {
		if (!externalProjectId.trim()) {
			toast.error("Enter a thumbnail project ID");
			return;
		}

		setIsLinking(true);
		try {
			const response = await fetch("/api/external-projects/link-thumbnail", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					opencutProjectId: activeProject.metadata.id,
					sourceSystem: "thumbnail_decoupled",
					externalProjectId: externalProjectId.trim(),
				}),
			});
			const json = (await response.json()) as
				| {
						error?: string;
						opencutProjectId: string;
						externalProjectId: string;
				  }
				| { error: string };
			if (!response.ok || "error" in json) {
				throw new Error(json.error || "Failed to link thumbnail project");
			}

			editor.project.setActiveProject({
				project: {
					...activeProject,
					externalProjectLink: {
						sourceSystem: "thumbnail_decoupled",
						externalProjectId: externalProjectId.trim(),
						opencutProjectId: activeProject.metadata.id,
						linkedAt: new Date().toISOString(),
					},
				},
			});
			editor.save.markDirty();
			await applyLinkedTranscript();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to link thumbnail project",
			);
		} finally {
			setIsLinking(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<Label>Linked Thumbnail Project</Label>
				<Badge variant={isLinked ? "default" : "secondary"}>{linkedLabel}</Badge>
			</div>
			<Input
				value={externalProjectId}
				onChange={(event) => setExternalProjectId(event.target.value)}
				placeholder="thumbnail project_id"
			/>
			<div className="flex items-center gap-2">
				<Button size="sm" onClick={handleLink} disabled={isLinking || isApplying}>
					{isLinking ? "Linking..." : "Link Project"}
				</Button>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => void applyLinkedTranscript()}
					disabled={isApplying || !isLinked}
				>
					{isApplying ? "Applying..." : "Apply Transcript Now"}
				</Button>
			</div>
		</div>
	);
}
