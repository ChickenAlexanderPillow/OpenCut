"use client";

import { Button } from "../ui/button";
import { useRef, useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import Link from "next/link";
import { RenameProjectDialog } from "./dialogs/rename-project-dialog";
import { DeleteProjectDialog } from "./dialogs/delete-project-dialog";
import { useRouter } from "next/navigation";
import { FaDiscord } from "react-icons/fa6";
import { ExportButton } from "./export-button";
import { ThemeToggle } from "../theme-toggle";
import { DEFAULT_LOGO_URL, SOCIAL_LINKS } from "@/constants/site-constants";
import { toast } from "sonner";
import { useEditor } from "@/hooks/use-editor";
import { CommandIcon, Logout05Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ShortcutsDialog } from "./dialogs/shortcuts-dialog";
import Image from "next/image";
import { cn } from "@/utils/ui";
import { useTranscriptionStatusStore } from "@/stores/transcription-status-store";
import { useProjectProcessStore } from "@/stores/project-process-store";
import { useProjectExitStore } from "@/stores/project-exit-store";
import { Loader2, XCircle } from "lucide-react";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

export function EditorHeader() {
	return (
		<header className="bg-background flex h-[3.4rem] items-center justify-between px-3 pt-0.5">
			<div className="flex items-center gap-1">
				<ProjectDropdown />
				<EditableProjectName />
			</div>
			<nav className="flex items-center gap-2">
				<TranscriptionStatusIndicator />
				<ExportButton />
				<ThemeToggle />
			</nav>
		</header>
	);
}

function TranscriptionStatusIndicator() {
	const { isRunning, message, progress } = useTranscriptionStatusStore();
	if (!isRunning) return null;

	return (
		<div className="flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs">
			<Loader2 className="size-3.5 animate-spin" />
			<span className="max-w-56 truncate">
				{message || "Generating transcript..."}
				{typeof progress === "number" ? ` ${Math.round(progress)}%` : ""}
			</span>
		</div>
	);
}

function ProjectDropdown() {
	const [openDialog, setOpenDialog] = useState<
		"delete" | "rename" | "shortcuts" | null
	>(null);
	const [isExiting, setIsExiting] = useState(false);
	const router = useRouter();
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const { isOpen, pendingRoute, requestOpen, close, clearPendingRoute } =
		useProjectExitStore();
	const {
		processes,
		cancelProcess,
		cancelProcessesForProject,
		clearProcessesForProject,
	} = useProjectProcessStore();
	const activeProjectProcesses = processes.filter(
		(process) => process.projectId === activeProject.metadata.id,
	);
	const hasActiveProjectProcesses = activeProjectProcesses.length > 0;

	const handleExit = async ({ route }: { route: string | null }) => {
		if (isExiting) return;
		setIsExiting(true);

		try {
			cancelProcessesForProject({ projectId: activeProject.metadata.id });
			await editor.project.prepareExit();
		} catch (error) {
			console.error("Failed to prepare project exit:", error);
		} finally {
			clearProcessesForProject({ projectId: activeProject.metadata.id });
			editor.project.closeProject();
			close();
			clearPendingRoute();
			router.push(route || "/projects");
		}
	};

	const handleExitProjectClick = ({ route }: { route: string | null }) => {
		if (hasActiveProjectProcesses) {
			requestOpen({ route });
			return;
		}

		void handleExit({ route });
	};

	const handleSaveProjectName = async (newName: string) => {
		if (
			activeProject &&
			newName.trim() &&
			newName !== activeProject.metadata.name
		) {
			try {
				await editor.project.renameProject({
					id: activeProject.metadata.id,
					name: newName.trim(),
				});
			} catch (error) {
				toast.error("Failed to rename project", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
			} finally {
				setOpenDialog(null);
			}
		}
	};

	const handleDeleteProject = async () => {
		if (activeProject) {
			try {
				await editor.project.deleteProjects({
					ids: [activeProject.metadata.id],
				});
				router.push("/projects");
			} catch (error) {
				toast.error("Failed to delete project", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
			} finally {
				setOpenDialog(null);
			}
		}
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon" className="p-1 rounded-sm size-8">
						<Image
							src={DEFAULT_LOGO_URL}
							alt="Project thumbnail"
							width={32}
							height={32}
							className="invert dark:invert-0 size-5"
						/>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="z-100 w-44">
					<DropdownMenuItem
						onClick={() => handleExitProjectClick({ route: "/projects" })}
						disabled={isExiting}
						icon={<HugeiconsIcon icon={Logout05Icon} />}
					>
						Exit project
					</DropdownMenuItem>

					<DropdownMenuItem
						onClick={() => setOpenDialog("shortcuts")}
						icon={<HugeiconsIcon icon={CommandIcon} />}
					>
						Shortcuts
					</DropdownMenuItem>

					<DropdownMenuSeparator />

					<DropdownMenuItem asChild icon={<FaDiscord className="!size-4" />}>
						<Link
							href={SOCIAL_LINKS.discord}
							target="_blank"
							rel="noopener noreferrer"
						>
							Discord
						</Link>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<RenameProjectDialog
				isOpen={openDialog === "rename"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "rename" : null)}
				onConfirm={(newName) => handleSaveProjectName(newName)}
				projectName={activeProject?.metadata.name || ""}
			/>
			<DeleteProjectDialog
				isOpen={openDialog === "delete"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "delete" : null)}
				onConfirm={handleDeleteProject}
				projectNames={[activeProject?.metadata.name || ""]}
			/>
			<ShortcutsDialog
				isOpen={openDialog === "shortcuts"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "shortcuts" : null)}
			/>
			<Dialog
				open={isOpen && hasActiveProjectProcesses}
				onOpenChange={(next) => {
					if (next) {
						requestOpen({ route: pendingRoute });
						return;
					}
					close();
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Leave project?</DialogTitle>
						<DialogDescription>
							Any running project tasks will be canceled if you leave now.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						{activeProjectProcesses.length === 0 ? (
							<div className="text-sm text-muted-foreground">
								No active background processes for this project.
							</div>
						) : (
							<div className="space-y-2">
								<div className="text-sm font-medium">Active processes</div>
								{activeProjectProcesses.map((process) => (
									<div
										key={process.id}
										className="flex items-center justify-between rounded-md border px-3 py-2"
									>
										<div className="min-w-0">
											<div className="truncate text-sm">{process.label}</div>
											<div className="text-xs text-muted-foreground">
												{process.kind}
											</div>
										</div>
										<Button
											size="sm"
											variant="outline"
											onClick={() => cancelProcess({ id: process.id })}
											className="gap-1"
										>
											<XCircle className="size-3.5" />
											Cancel
										</Button>
									</div>
								))}
							</div>
						)}
					</DialogBody>
					<DialogFooter>
						<Button
							variant="secondary"
							onClick={() => close()}
							disabled={isExiting}
						>
							Stay
						</Button>
						<Button
							onClick={() => handleExit({ route: pendingRoute })}
							disabled={isExiting}
						>
							{isExiting ? "Leaving..." : "Leave project"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function EditableProjectName() {
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const [isEditing, setIsEditing] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const originalNameRef = useRef("");

	const projectName = activeProject?.metadata.name || "";

	const startEditing = () => {
		if (isEditing) return;
		originalNameRef.current = projectName;
		setIsEditing(true);

		requestAnimationFrame(() => {
			inputRef.current?.select();
		});
	};

	const saveEdit = async () => {
		if (!inputRef.current || !activeProject) return;
		const newName = inputRef.current.value.trim();
		setIsEditing(false);

		if (!newName) {
			inputRef.current.value = originalNameRef.current;
			return;
		}

		if (newName !== originalNameRef.current) {
			try {
				await editor.project.renameProject({
					id: activeProject.metadata.id,
					name: newName,
				});
			} catch (error) {
				toast.error("Failed to rename project", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
			}
		}
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Enter") {
			event.preventDefault();
			inputRef.current?.blur();
		} else if (event.key === "Escape") {
			event.preventDefault();
			if (inputRef.current) {
				inputRef.current.value = originalNameRef.current;
			}
			setIsEditing(false);
			inputRef.current?.blur();
		}
	};

	return (
		<input
			ref={inputRef}
			type="text"
			defaultValue={projectName}
			readOnly={!isEditing}
			onClick={startEditing}
			onBlur={saveEdit}
			onKeyDown={handleKeyDown}
			style={{ fieldSizing: "content" }}
			className={cn(
				"text-[0.9rem] h-8 px-2 py-1 rounded-sm bg-transparent outline-none cursor-pointer hover:bg-accent hover:text-accent-foreground",
				isEditing && "ring-1 ring-ring cursor-text hover:bg-transparent",
			)}
		/>
	);
}
