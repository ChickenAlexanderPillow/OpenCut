"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	GridViewIcon,
	LeftToRightListDashIcon,
	MusicNote03Icon,
	PauseIcon,
	PlayIcon,
	SortingOneNineIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { FolderOpen } from "lucide-react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { cn } from "@/utils/ui";

const STORAGE_KEY = "opencut.music.sourceRoot";
const DEFAULT_MUSIC_ROOT = "C:\\Users\\Design\\Music";

type LocalMusicFile = {
	name: string;
	relativePath: string;
	directory: string;
	extension: string;
	sizeBytes: number;
	modifiedAt: string;
};

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleDateString();
}

export function MusicView() {
	const { mediaViewMode, setMediaViewMode } = useAssetsPanelStore();
	const [root, setRoot] = useState(DEFAULT_MUSIC_ROOT);
	const [rootInput, setRootInput] = useState(DEFAULT_MUSIC_ROOT);
	const [files, setFiles] = useState<LocalMusicFile[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [sortBy, setSortBy] = useState<"name" | "size" | "modified">("name");
	const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
	const [activePreviewPath, setActivePreviewPath] = useState<string | null>(
		null,
	);

	const folderPickerRef = useRef<HTMLInputElement | null>(null);
	const previewAudioRef = useRef<HTMLAudioElement | null>(null);

	const loadFiles = useCallback(
		async ({ rootOverride }: { rootOverride?: string } = {}) => {
			setIsLoading(true);
			try {
				const selectedRoot =
					rootOverride && rootOverride.trim().length > 0
						? rootOverride.trim()
						: DEFAULT_MUSIC_ROOT;
				const search = new URLSearchParams({ root: selectedRoot });
				const response = await fetch(`/api/music/local?${search.toString()}`, {
					cache: "no-store",
				});
				const payload = (await response.json()) as {
					root?: string;
					files?: LocalMusicFile[];
					error?: string;
				};
				if (!response.ok || payload.error) {
					throw new Error(payload.error || "Failed to read music folder");
				}

				const resolvedRoot =
					payload.root && payload.root.length > 0 ? payload.root : selectedRoot;
				setRoot(resolvedRoot);
				setRootInput(resolvedRoot);
				window.localStorage.setItem(STORAGE_KEY, resolvedRoot);
				setFiles(payload.files ?? []);
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to load music folder",
				);
			} finally {
				setIsLoading(false);
			}
		},
		[],
	);

	const resolveAbsoluteFolderFromSelection = useCallback(
		({ files }: { files: FileList }): string | null => {
			if (files.length === 0) return null;
			const firstFile = files[0] as File & {
				path?: string;
				webkitRelativePath?: string;
			};
			if (!firstFile.path) return null;
			const filePath = firstFile.path.replace(/\//g, "\\");
			const relativePath = (firstFile.webkitRelativePath ?? "").replace(
				/\//g,
				"\\",
			);
			if (!relativePath) {
				const lastSeparator = filePath.lastIndexOf("\\");
				return lastSeparator > 0 ? filePath.slice(0, lastSeparator) : null;
			}
			const suffix = `\\${relativePath}`;
			if (filePath.toLowerCase().endsWith(suffix.toLowerCase())) {
				return filePath.slice(0, filePath.length - suffix.length);
			}
			const lastSeparator = filePath.lastIndexOf("\\");
			return lastSeparator > 0 ? filePath.slice(0, lastSeparator) : null;
		},
		[],
	);

	const handleFolderPicked = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const selectedFiles = event.target.files;
			if (!selectedFiles || selectedFiles.length === 0) return;
			const absolutePath = resolveAbsoluteFolderFromSelection({
				files: selectedFiles,
			});
			if (!absolutePath) {
				toast.error(
					"Could not resolve absolute folder path in this browser. Enter path manually.",
				);
				event.target.value = "";
				return;
			}
			setRootInput(absolutePath);
			void loadFiles({ rootOverride: absolutePath });
			event.target.value = "";
		},
		[loadFiles, resolveAbsoluteFolderFromSelection],
	);

	useEffect(() => {
		const savedRoot = window.localStorage.getItem(STORAGE_KEY)?.trim();
		const initialRoot =
			savedRoot && savedRoot.length > 0 && savedRoot !== "/host-music"
				? savedRoot
				: DEFAULT_MUSIC_ROOT;
		void loadFiles({ rootOverride: initialRoot });
	}, [loadFiles]);

	useEffect(() => {
		return () => {
			previewAudioRef.current?.pause();
			previewAudioRef.current = null;
		};
	}, []);

	const togglePreview = useCallback(
		async ({ file }: { file: LocalMusicFile }) => {
			if (!previewAudioRef.current) {
				previewAudioRef.current = new Audio();
				previewAudioRef.current.addEventListener("ended", () =>
					setActivePreviewPath(null),
				);
			}
			const player = previewAudioRef.current;
			const sourceUrl = `/api/music/local/source?path=${encodeURIComponent(file.relativePath)}&root=${encodeURIComponent(root)}`;
			if (activePreviewPath === file.relativePath && !player.paused) {
				player.pause();
				setActivePreviewPath(null);
				return;
			}
			try {
				player.pause();
				player.src = sourceUrl;
				player.currentTime = 0;
				await player.play();
				setActivePreviewPath(file.relativePath);
			} catch (error) {
				console.error("Failed to preview local music", error);
				toast.error("Preview failed");
				setActivePreviewPath(null);
			}
		},
		[activePreviewPath, root],
	);

	const sortedFiles = useMemo(() => {
		const next = [...files];
		next.sort((a, b) => {
			let valueA: string | number;
			let valueB: string | number;
			if (sortBy === "name") {
				valueA = a.name.toLowerCase();
				valueB = b.name.toLowerCase();
			} else if (sortBy === "size") {
				valueA = a.sizeBytes;
				valueB = b.sizeBytes;
			} else {
				valueA = new Date(a.modifiedAt).getTime();
				valueB = new Date(b.modifiedAt).getTime();
			}
			if (valueA < valueB) return sortOrder === "asc" ? -1 : 1;
			if (valueA > valueB) return sortOrder === "asc" ? 1 : -1;
			return 0;
		});
		return next;
	}, [files, sortBy, sortOrder]);

	const actions = (
		<div>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							onClick={() =>
								setMediaViewMode(mediaViewMode === "grid" ? "list" : "grid")
							}
						>
							{mediaViewMode === "grid" ? (
								<HugeiconsIcon icon={LeftToRightListDashIcon} />
							) : (
								<HugeiconsIcon icon={GridViewIcon} />
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{mediaViewMode === "grid"
							? "Switch to list view"
							: "Switch to grid view"}
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<DropdownMenu>
						<TooltipTrigger asChild>
							<DropdownMenuTrigger asChild>
								<Button size="icon" variant="ghost">
									<HugeiconsIcon icon={SortingOneNineIcon} />
								</Button>
							</DropdownMenuTrigger>
						</TooltipTrigger>
						<DropdownMenuContent align="end">
							{(["name", "size", "modified"] as const).map((key) => (
								<DropdownMenuItem
									key={key}
									onClick={() => {
										if (sortBy === key) {
											setSortOrder(sortOrder === "asc" ? "desc" : "asc");
										} else {
											setSortBy(key);
											setSortOrder("asc");
										}
									}}
								>
									{key === "modified"
										? "Date modified"
										: key.charAt(0).toUpperCase() + key.slice(1)}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
					<TooltipContent>Sort by {sortBy}</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		</div>
	);

	return (
		<PanelView title="Music" actions={actions}>
			<div className="space-y-2">
				<div className="flex items-center gap-2 px-2">
					<input
						ref={folderPickerRef}
						type="file"
						className="hidden"
						onChange={handleFolderPicked}
						{...({
							webkitdirectory: "true",
							directory: "",
							mozdirectory: "",
						} as Record<string, string>)}
					/>
					<Button
						size="icon"
						variant="outline"
						onClick={() => folderPickerRef.current?.click()}
						title="Pick music folder"
					>
						<FolderOpen className="size-4" />
					</Button>
					<Input
						value={rootInput}
						onChange={({ currentTarget }) => setRootInput(currentTarget.value)}
						placeholder={DEFAULT_MUSIC_ROOT}
					/>
					<Button
						size="sm"
						variant="outline"
						onClick={() => void loadFiles({ rootOverride: rootInput })}
						disabled={isLoading}
					>
						Scan
					</Button>
				</div>
				<div className="text-muted-foreground px-2 text-xs break-all">
					Source: {root}
				</div>

				{isLoading ? (
					<div className="text-muted-foreground px-2 py-6 text-sm">
						Scanning folder...
					</div>
				) : sortedFiles.length === 0 ? (
					<div className="text-muted-foreground px-2 py-6 text-sm">
						No audio files found in selected folder.
					</div>
				) : mediaViewMode === "grid" ? (
					<div
						className="grid gap-2"
						style={{ gridTemplateColumns: "repeat(auto-fill, 160px)" }}
					>
						{sortedFiles.map((file) => {
							const isPlaying = activePreviewPath === file.relativePath;
							return (
								<div
									key={file.relativePath}
									className="group relative flex h-auto w-full flex-col gap-1 p-1"
								>
									<div className="bg-accent relative aspect-video overflow-hidden rounded-sm border">
										<div className="text-muted-foreground flex size-full flex-col items-center justify-center">
											<HugeiconsIcon
												icon={MusicNote03Icon}
												className="size-6"
											/>
											<span className="mt-1 text-[10px]">
												{file.extension.toUpperCase()}
											</span>
										</div>
										<Button
											size="icon"
											variant="secondary"
											className="absolute top-2 right-2 size-6"
											onClick={() => void togglePreview({ file })}
										>
											<HugeiconsIcon
												icon={isPlaying ? PauseIcon : PlayIcon}
												className="size-3.5"
											/>
										</Button>
									</div>
									<div className="text-muted-foreground text-[0.7rem]">
										<div className="truncate" title={file.name}>
											{file.name}
										</div>
										<div className="truncate" title={file.directory}>
											{file.directory || "Music"} -{" "}
											{formatBytes(file.sizeBytes)}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				) : (
					<div className="space-y-1">
						{sortedFiles.map((file) => {
							const isPlaying = activePreviewPath === file.relativePath;
							return (
								<div
									key={file.relativePath}
									className={cn(
										"group flex h-8 w-full items-center gap-3 px-1 rounded-sm",
										"hover:bg-accent/40",
									)}
								>
									<div className="relative size-6 flex-shrink-0 overflow-hidden rounded-[0.35rem] border">
										<div className="text-muted-foreground flex size-full items-center justify-center">
											<HugeiconsIcon
												icon={MusicNote03Icon}
												className="size-4"
											/>
										</div>
									</div>
									<div className="min-w-0 flex-1 truncate text-sm">
										{file.name}
									</div>
									<div className="text-muted-foreground w-28 text-xs text-right">
										{formatDate(file.modifiedAt)}
									</div>
									<Button
										size="icon"
										variant="ghost"
										className="size-7"
										onClick={() => void togglePreview({ file })}
									>
										<HugeiconsIcon
											icon={isPlaying ? PauseIcon : PlayIcon}
											className="size-4"
										/>
									</Button>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</PanelView>
	);
}
