"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEditor } from "@/hooks/use-editor";
import {
	useKeybindingsListener,
	useKeybindingDisabler,
} from "@/hooks/use-keybindings";
import { useEditorActions } from "@/hooks/actions/use-editor-actions";
import { prefetchFontAtlas } from "@/lib/fonts/google-fonts";
import { useProjectProcessStore } from "@/stores/project-process-store";
import { useProjectExitStore } from "@/stores/project-exit-store";
import { storageService } from "@/services/storage/service";
import { buildDefaultScene } from "@/lib/scenes";
import {
	DEFAULT_CANVAS_SIZE,
	DEFAULT_COLOR,
	DEFAULT_FPS,
} from "@/constants/project-constants";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { DEFAULT_BRAND_OVERLAYS } from "@/constants/brand-overlay-constants";
import type { TProject } from "@/types/project";
import { processMediaAssets } from "@/lib/media/processing";
import { buildClipTranscriptEntryFromLinkedExternalTranscript } from "@/lib/clips/transcript";
import { normalizeGeneratedCaptionsInProject } from "@/lib/captions/generated-caption-normalizer";
import {
	dedupeTranscriptEditsInTracks,
	syncAllCaptionsFromTranscriptEditsInTracks,
} from "@/lib/transcript-editor/sync-captions";
import { clearRuntimeCaches } from "@/lib/editor/runtime-cache-policy";

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
}

export function EditorProvider({ projectId, children }: EditorProviderProps) {
	const editor = useEditor();
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { disableKeybindings, enableKeybindings } = useKeybindingDisabler();
	const activeProject = editor.project.getActiveOrNull();

	useEffect(() => {
		if (isLoading) {
			disableKeybindings();
		} else {
			enableKeybindings();
		}
	}, [isLoading, disableKeybindings, enableKeybindings]);

	useEffect(() => {
		let cancelled = false;

		const bootstrapExternalProjectLocally = async ({
			externalProjectId,
		}: {
			externalProjectId: string;
		}): Promise<boolean> => {
			const response = await fetch(
				`/api/external-projects/${encodeURIComponent(externalProjectId)}`,
				{
					method: "GET",
					cache: "no-store",
				},
			);
			if (!response.ok) return false;
			const payload = (await response.json()) as {
				project?: {
					id: string;
					name: string | null;
					sourceSystem: "thumbnail_decoupled";
					externalProjectId: string;
					relativeKey: string | null;
				};
				transcript?: {
					transcriptText: string;
					segmentsJson: Array<{ text: string; start: number; end: number }>;
					segmentsCount: number;
					audioDurationSeconds: number | null;
					qualityMetaJson: Record<string, unknown> | null;
					updatedAt: string;
				};
			};

			const externalProject = payload.project;
			if (!externalProject) return false;

			const mainScene = buildDefaultScene({ name: "Main scene", isMain: true });
			const now = new Date();
			const transcript = payload.transcript;
			const transcriptKey = `${externalProject.sourceSystem}:${externalProject.externalProjectId}`;
			const localProject: TProject = {
				metadata: {
					id: externalProject.id,
					name: externalProject.name || "Imported Project",
					duration: 0,
					createdAt: now,
					updatedAt: now,
				},
				scenes: [mainScene],
				currentSceneId: mainScene.id,
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
				externalProjectLink: {
					sourceSystem: externalProject.sourceSystem,
					externalProjectId: externalProject.externalProjectId,
					opencutProjectId: externalProject.id,
					relativeKey: externalProject.relativeKey ?? undefined,
					linkedAt: now.toISOString(),
				},
				externalTranscriptCache: transcript
					? {
							[transcriptKey]: {
								sourceSystem: externalProject.sourceSystem,
								externalProjectId: externalProject.externalProjectId,
								transcriptText: transcript.transcriptText,
								segments: transcript.segmentsJson ?? [],
								segmentsCount: transcript.segmentsCount ?? 0,
								audioDurationSeconds: transcript.audioDurationSeconds ?? null,
								qualityMeta: transcript.qualityMetaJson ?? undefined,
								updatedAt: transcript.updatedAt ?? now.toISOString(),
							},
						}
					: undefined,
			};
			await storageService.saveProject({ project: localProject });
			return true;
		};

		const hydrateLinkedProjectUi = async ({
			externalProjectId,
		}: {
			externalProjectId: string;
		}) => {
			let sourceAsset =
				editor.media
					.getAssets()
					.find(
						(asset) =>
							!asset.ephemeral &&
							(asset.type === "video" || asset.type === "audio"),
					) ?? null;

			if (!sourceAsset) {
				try {
					const externalResponse = await fetch(
						`/api/external-projects/${encodeURIComponent(externalProjectId)}`,
						{
							method: "GET",
							cache: "no-store",
						},
					);
					if (!externalResponse.ok) return;
					const externalPayload = (await externalResponse.json()) as {
						project?: {
							id: string;
							sourceSystem: "thumbnail_decoupled";
							externalProjectId: string;
							sourceFilePath: string | null;
						};
					};
					const linkedProject = externalPayload.project;
					if (!linkedProject?.sourceFilePath) return;

					const mediaResponse = await fetch(
						`/api/external-projects/${encodeURIComponent(externalProjectId)}/media/source`,
						{
							method: "GET",
							cache: "no-store",
						},
					);
					if (mediaResponse.ok) {
						const mediaNameHeader = mediaResponse.headers.get(
							"x-source-media-name",
						);
						const blob = await mediaResponse.blob();
						const mediaName = mediaNameHeader || "linked-source-media";
						const mediaFile = new File([blob], mediaName, {
							type: blob.type || "application/octet-stream",
						});
						const processedAssets = await processMediaAssets({
							files: [mediaFile],
						});
						for (const asset of processedAssets) {
							await editor.media.addMediaAsset({
								projectId: externalProjectId,
								asset,
							});
						}
						sourceAsset =
							editor.media
								.getAssets()
								.find(
									(asset) =>
										!asset.ephemeral &&
										(asset.type === "video" || asset.type === "audio"),
								) ?? null;
					}
				} catch (error) {
					console.warn(
						"Failed to import linked source media into project",
						error,
					);
				}
			}

			if (!sourceAsset) return;
			const clipCacheKey = `${sourceAsset.id}:whisper-tiny:auto`;
			const currentProject = editor.project.getActive();
			if (currentProject.clipTranscriptCache?.[clipCacheKey]) {
				return;
			}

			try {
				const applyResponse = await fetch(
					`/api/external-projects/${encodeURIComponent(externalProjectId)}/transcript/apply`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({}),
					},
				);
				if (!applyResponse.ok) return;
				const applyPayload = (await applyResponse.json()) as {
					sourceSystem: "thumbnail_decoupled";
					externalProjectId: string;
					transcriptText: string;
					segments: Array<{ text: string; start: number; end: number }>;
					segmentsCount: number;
					audioDurationSeconds: number | null;
					qualityMeta?: Record<string, unknown>;
					updatedAt: string;
					suitability: { isSuitable: boolean; reasons: string[] };
				};
				if (!applyPayload.suitability.isSuitable) return;

				const transcriptEntry =
					buildClipTranscriptEntryFromLinkedExternalTranscript({
						asset: sourceAsset,
						modelId: "whisper-tiny",
						language: "auto",
						externalTranscript: {
							sourceSystem: applyPayload.sourceSystem,
							externalProjectId: applyPayload.externalProjectId,
							transcriptText: applyPayload.transcriptText,
							segments: applyPayload.segments,
							segmentsCount: applyPayload.segmentsCount,
							audioDurationSeconds: applyPayload.audioDurationSeconds,
							qualityMeta: applyPayload.qualityMeta,
							updatedAt: applyPayload.updatedAt,
						},
					});
				if (!transcriptEntry) return;

				const nextProject: TProject = {
					...currentProject,
					clipTranscriptCache: {
						...(currentProject.clipTranscriptCache ?? {}),
						[transcriptEntry.cacheKey]: transcriptEntry.transcript,
					},
				};
				editor.project.setActiveProject({ project: nextProject });
				editor.save.markDirty();
			} catch (error) {
				console.warn("Failed to hydrate linked transcript cache", error);
			}
		};

		const loadProject = async () => {
			try {
				setIsLoading(true);
				await editor.project.loadProject({ id: projectId });

				if (cancelled) return;

				const loadedProject = editor.project.getActiveOrNull();
				if (loadedProject) {
					const normalized = normalizeGeneratedCaptionsInProject({
						project: loadedProject,
					});
					const syncedScenes = normalized.project.scenes.map((scene) => {
						const deduped = dedupeTranscriptEditsInTracks({
							tracks: scene.tracks,
						});
						const baseTracks = deduped.changed ? deduped.tracks : scene.tracks;
						const synced = syncAllCaptionsFromTranscriptEditsInTracks({
							tracks: baseTracks,
						});
						const nextTracks = synced.changed ? synced.tracks : baseTracks;
						return nextTracks !== scene.tracks
							? { ...scene, tracks: nextTracks }
							: scene;
					});
					const hasSyncedChanges = syncedScenes.some(
						(scene, index) => scene !== normalized.project.scenes[index],
					);
					if (normalized.changed || hasSyncedChanges) {
						editor.project.setActiveProject({
							project: {
								...normalized.project,
								scenes: syncedScenes,
							},
						});
						editor.save.markDirty();
					}
				}

				setIsLoading(false);
				prefetchFontAtlas();
				const activeProject = editor.project.getActiveOrNull();
				if (activeProject?.externalProjectLink) {
					void hydrateLinkedProjectUi({
						externalProjectId: activeProject.metadata.id,
					});
				}
			} catch (err) {
				if (cancelled) return;

				const isNotFound =
					err instanceof Error &&
					(err.message.includes("not found") ||
						err.message.includes("does not exist"));

				if (isNotFound) {
					try {
						const bootstrapped = await bootstrapExternalProjectLocally({
							externalProjectId: projectId,
						});
						if (bootstrapped) {
							await editor.project.loadProject({ id: projectId });
							setIsLoading(false);
							prefetchFontAtlas();
							void hydrateLinkedProjectUi({
								externalProjectId: projectId,
							});
							return;
						}

						const newProjectId = await editor.project.createNewProject({
							name: "Untitled Project",
						});
						router.replace(`/editor/${newProjectId}`);
					} catch (_createErr) {
						setError("Failed to create project");
						setIsLoading(false);
					}
				} else {
					setError(
						err instanceof Error ? err.message : "Failed to load project",
					);
					setIsLoading(false);
				}
			}
		};

		loadProject();

		return () => {
			cancelled = true;
		};
	}, [projectId, editor, router]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm">{error}</p>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Loading project...</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Exiting project...</p>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorRuntimeBindings />
			{children}
		</>
	);
}

function EditorRuntimeBindings() {
	const editor = useEditor();
	const pathname = usePathname();
	const activeProject = editor.project.getActiveOrNull();
	const processes = useProjectProcessStore((state) => state.processes);
	const requestOpen = useProjectExitStore((state) => state.requestOpen);

	const hasActiveProjectProcesses = activeProject
		? processes.some(
				(process) => process.projectId === activeProject.metadata.id,
			)
		: false;

	useEffect(() => {
		const CHECK_INTERVAL_MS = 30_000;
		const PRESSURE_SAMPLES = 3;
		const FALLBACK_SOFT_LIMIT_MB = 768;
		const FALLBACK_HARD_LIMIT_MB = 1024;
		let highPressureCount = 0;
		let recovering = false;

		const getHeapStats = (): {
			usedHeapMb: number;
			heapLimitMb: number | null;
		} | null => {
			const memory = (
				performance as Performance & {
					memory?: {
						usedJSHeapSize?: number;
						jsHeapSizeLimit?: number;
					};
				}
			).memory;
			const usedBytes = memory?.usedJSHeapSize;
			if (typeof usedBytes !== "number" || !Number.isFinite(usedBytes))
				return null;
			const limitBytes = memory?.jsHeapSizeLimit;
			const heapLimitMb =
				typeof limitBytes === "number" && Number.isFinite(limitBytes)
					? limitBytes / (1024 * 1024)
					: null;
			return {
				usedHeapMb: usedBytes / (1024 * 1024),
				heapLimitMb,
			};
		};

		const runRecovery = async ({
			usedHeapMb,
			softLimitMb,
			hardLimitMb,
			isHardPressure,
		}: {
			usedHeapMb: number;
			softLimitMb: number;
			hardLimitMb: number;
			isHardPressure: boolean;
		}) => {
			if (recovering) return;
			recovering = true;
			try {
				clearRuntimeCaches({
					editor,
					policy: isHardPressure ? "memory-hard" : "memory-soft",
				});
				await editor.save.flush();
				await new Promise((resolve) => setTimeout(resolve, 350));
				const afterRecoveryHeapMb = getHeapStats()?.usedHeapMb ?? null;
				const shouldReload =
					usedHeapMb >= hardLimitMb ||
					(afterRecoveryHeapMb !== null &&
						afterRecoveryHeapMb >= softLimitMb * 0.92);
				if (!shouldReload || hasActiveProjectProcesses) return;
				console.warn(
					"Memory pressure persists after cache recovery; skipping auto-reload to avoid interrupting editing",
				);
			} catch (error) {
				console.warn("Memory recovery failed", error);
			} finally {
				recovering = false;
			}
		};

		const intervalId = window.setInterval(() => {
			if (document.hidden) return;
			const heapStats = getHeapStats();
			if (!heapStats) return;
			const { usedHeapMb, heapLimitMb } = heapStats;
			const softLimitMb =
				heapLimitMb !== null
					? Math.min(FALLBACK_SOFT_LIMIT_MB, heapLimitMb * 0.75)
					: FALLBACK_SOFT_LIMIT_MB;
			const hardLimitMb =
				heapLimitMb !== null
					? Math.min(FALLBACK_HARD_LIMIT_MB, heapLimitMb * 0.88)
					: FALLBACK_HARD_LIMIT_MB;
			const hardByRatio =
				heapLimitMb !== null && usedHeapMb >= heapLimitMb * 0.92;

			if (usedHeapMb >= softLimitMb) {
				highPressureCount += 1;
			} else {
				highPressureCount = 0;
			}
			const needsRecovery =
				usedHeapMb >= hardLimitMb ||
				highPressureCount >= PRESSURE_SAMPLES ||
				hardByRatio;
			if (!needsRecovery) return;
			void runRecovery({
				usedHeapMb,
				softLimitMb,
				hardLimitMb,
				isHardPressure: usedHeapMb >= hardLimitMb || hardByRatio,
			});
		}, CHECK_INTERVAL_MS);

		return () => {
			window.clearInterval(intervalId);
		};
	}, [editor, hasActiveProjectProcesses]);

	useEffect(() => {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editor.save.getIsDirty() && !hasActiveProjectProcesses) return;
			event.preventDefault();
			(event as unknown as { returnValue: string }).returnValue = "";
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [editor, hasActiveProjectProcesses]);

	useEffect(() => {
		const handleLinkClick = (event: MouseEvent) => {
			if (!hasActiveProjectProcesses) return;
			if (event.defaultPrevented) return;
			if (event.button !== 0) return;
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
				return;

			const target = event.target as HTMLElement | null;
			const link = target?.closest("a[href]") as HTMLAnchorElement | null;
			if (!link) return;
			if (link.target && link.target !== "_self") return;
			if (link.hasAttribute("download")) return;

			const url = new URL(link.href, window.location.origin);
			if (url.origin !== window.location.origin) return;
			const destination = `${url.pathname}${url.search}${url.hash}`;
			const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
			if (destination === current) return;
			if (url.pathname === pathname) return;

			event.preventDefault();
			requestOpen({ route: destination });
		};

		document.addEventListener("click", handleLinkClick, true);
		return () => {
			document.removeEventListener("click", handleLinkClick, true);
		};
	}, [hasActiveProjectProcesses, pathname, requestOpen]);

	useEditorActions();
	useKeybindingsListener();
	return null;
}
