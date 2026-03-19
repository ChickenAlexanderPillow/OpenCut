"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, type PointerEventHandler } from "react";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { AssetsPanel } from "@/components/editor/panels/assets";
import { PropertiesPanel } from "@/components/editor/panels/properties";
import { Timeline } from "@/components/editor/panels/timeline";
import { PreviewPanel } from "@/components/editor/panels/preview";
import { EditorHeader } from "@/components/editor/editor-header";
import { EditorProvider } from "@/components/providers/editor-provider";
import { Onboarding } from "@/components/editor/onboarding";
import { MigrationDialog } from "@/components/editor/dialogs/migration-dialog";
import { usePanelStore } from "@/stores/panel-store";
import { usePasteMedia } from "@/hooks/use-paste-media";
import { useEditor } from "@/hooks/use-editor";
import { usePreviewStore } from "@/stores/preview-store";

export default function Editor() {
	const params = useParams();
	const projectId = params.project_id as string;

	return (
		<EditorProvider projectId={projectId}>
			<div className="bg-background flex h-screen w-screen flex-col overflow-hidden">
				<EditorHeader />
				<div className="min-h-0 min-w-0 flex-1">
					<EditorLayout />
				</div>
				<Onboarding />
				<MigrationDialog />
			</div>
		</EditorProvider>
	);
}

function EditorLayout() {
	usePasteMedia();
	const { layoutPreset, panels, setPanel } = usePanelStore();
	const editor = useEditor({ subscribeTo: [] });
	const setPreviewFormatVariant = usePreviewStore(
		(state) => state.setPreviewFormatVariant,
	);
	const handlePointerDownCapture: PointerEventHandler<
		keyof HTMLElementTagNameMap
	> = useCallback(
		(event) => {
			const target = event.target as HTMLElement | null;
			if (!target) return;

			if (target.closest('[data-editor-selection-root="timeline"]')) return;
			if (target.closest('[data-editor-selection-root="preview"]')) return;
			if (target.closest('[data-editor-selection-root="properties"]')) return;
			if (target.closest('[data-editor-selection-root="assets"]')) return;
			if (target.closest("[data-radix-popper-content-wrapper]")) return;
			if (
				target.closest(
					'input, textarea, select, button, a, [role="button"], [contenteditable="true"]',
				)
			) {
				return;
			}

			editor.selection.clearSelection();
		},
		[editor],
	);

	useEffect(() => {
		if (layoutPreset !== "right-preview") return;
		setPreviewFormatVariant({ variant: "portrait" });
	}, [layoutPreset, setPreviewFormatVariant]);

	if (layoutPreset === "right-preview") {
		return (
			<RightPreviewLayout
				panels={panels}
				setPanel={setPanel}
				onPointerDownCapture={handlePointerDownCapture}
			/>
		);
	}

	return (
		<DefaultLayout
			panels={panels}
			setPanel={setPanel}
			onPointerDownCapture={handlePointerDownCapture}
		/>
	);
}

function DefaultLayout({
	panels,
	setPanel,
	onPointerDownCapture,
}: {
	panels: ReturnType<typeof usePanelStore.getState>["panels"];
	setPanel: ReturnType<typeof usePanelStore.getState>["setPanel"];
	onPointerDownCapture: PointerEventHandler<keyof HTMLElementTagNameMap>;
}) {
	return (
		<ResizablePanelGroup
			direction="vertical"
			className="size-full gap-[0.18rem]"
			onPointerDownCapture={onPointerDownCapture}
			onLayout={(sizes) => {
				setPanel("mainContent", sizes[0] ?? panels.mainContent);
				setPanel("timeline", sizes[1] ?? panels.timeline);
			}}
		>
			<ResizablePanel
				defaultSize={panels.mainContent}
				minSize={30}
				maxSize={85}
				className="min-h-0 overflow-hidden"
			>
				<ResizablePanelGroup
					direction="horizontal"
					className="size-full gap-[0.19rem] px-3"
					onLayout={(sizes) => {
						if ((sizes[0] ?? 0) > 0) {
							setPanel("tools", sizes[0] ?? panels.tools);
						}
						if ((sizes[1] ?? 0) > 0) {
							setPanel("preview", sizes[1] ?? panels.preview);
						}
						if ((sizes[2] ?? 0) > 0) {
							setPanel("properties", sizes[2] ?? panels.properties);
						}
					}}
				>
					<ResizablePanel
						defaultSize={Math.max(panels.tools, 22)}
						minSize={20}
						maxSize={40}
						className="min-w-0 overflow-hidden"
						onResize={(size) => {
							if (size > 0) {
								setPanel("tools", size);
							}
						}}
					>
						<AssetsPanel />
					</ResizablePanel>

					<ResizableHandle />

					<ResizablePanel
						defaultSize={Math.max(panels.preview, 30)}
						minSize={30}
						className="min-h-0 min-w-0 flex-1 overflow-hidden"
						onResize={(size) => {
							if (size > 0) {
								setPanel("preview", size);
							}
						}}
					>
						<PreviewPanel />
					</ResizablePanel>

					<ResizableHandle />

					<ResizablePanel
						defaultSize={Math.max(panels.properties, 15)}
						minSize={15}
						maxSize={40}
						className="min-w-0 overflow-hidden"
						onResize={(size) => {
							if (size > 0) {
								setPanel("properties", size);
							}
						}}
					>
						<PropertiesPanel />
					</ResizablePanel>
				</ResizablePanelGroup>
			</ResizablePanel>

			<ResizableHandle />

			<ResizablePanel
				defaultSize={Math.max(panels.timeline, 15)}
				minSize={15}
				maxSize={70}
				className="min-h-0 overflow-hidden px-3 pb-3"
				onResize={(size) => {
					if (size > 0) {
						setPanel("timeline", size);
					}
				}}
			>
				<Timeline />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}

function RightPreviewLayout({
	panels,
	setPanel,
	onPointerDownCapture,
}: {
	panels: ReturnType<typeof usePanelStore.getState>["panels"];
	setPanel: ReturnType<typeof usePanelStore.getState>["setPanel"];
	onPointerDownCapture: PointerEventHandler<keyof HTMLElementTagNameMap>;
}) {
	const previewDefaultSize = Math.min(Math.max(panels.preview, 22), 24);

	return (
		<ResizablePanelGroup
			direction="horizontal"
			className="size-full gap-[0.18rem] px-3 pb-3"
			onPointerDownCapture={onPointerDownCapture}
			onLayout={(sizes) => {
				setPanel("preview", sizes[1] ?? panels.preview);
			}}
		>
			<ResizablePanel
				defaultSize={Math.max(100 - previewDefaultSize, 0)}
				minSize={34}
				className="min-h-0 min-w-0 overflow-hidden"
			>
				<ResizablePanelGroup
					direction="vertical"
					className="size-full gap-[0.18rem]"
					onLayout={(sizes) => {
						setPanel("mainContent", sizes[0] ?? panels.mainContent);
						setPanel("timeline", sizes[1] ?? panels.timeline);
					}}
				>
					<ResizablePanel
						defaultSize={panels.mainContent}
						minSize={28}
						className="min-h-0 overflow-hidden"
					>
						<ResizablePanelGroup
							direction="horizontal"
							className="size-full gap-[0.19rem]"
							onLayout={(sizes) => {
								if ((sizes[0] ?? 0) > 0) {
									setPanel("tools", sizes[0] ?? panels.tools);
								}
								if ((sizes[1] ?? 0) > 0) {
									setPanel("properties", sizes[1] ?? panels.properties);
								}
							}}
						>
							<ResizablePanel
								defaultSize={Math.max(panels.tools, 25)}
								minSize={22}
								maxSize={75}
								className="min-w-0 overflow-hidden"
								onResize={(size) => {
									if (size > 0) {
										setPanel("tools", size);
									}
								}}
							>
								<AssetsPanel />
							</ResizablePanel>

							<ResizableHandle />

							<ResizablePanel
								defaultSize={Math.max(panels.properties, 25)}
								minSize={25}
								maxSize={75}
								className="min-w-0 overflow-hidden"
								onResize={(size) => {
									if (size > 0) {
										setPanel("properties", size);
									}
								}}
							>
								<PropertiesPanel />
							</ResizablePanel>
						</ResizablePanelGroup>
					</ResizablePanel>

					<ResizableHandle />

					<ResizablePanel
						defaultSize={Math.max(panels.timeline, 18)}
						minSize={18}
						maxSize={72}
						className="min-h-0 overflow-hidden"
						onResize={(size) => {
							if (size > 0) {
								setPanel("timeline", size);
							}
						}}
					>
						<Timeline />
					</ResizablePanel>
				</ResizablePanelGroup>
			</ResizablePanel>

			<ResizableHandle />

			<ResizablePanel
				defaultSize={previewDefaultSize}
				minSize={22}
				maxSize={30}
				className="min-h-0 min-w-0 overflow-hidden"
				onResize={(size) => {
					if (size > 0) {
						setPanel("preview", size);
					}
				}}
			>
				<PreviewPanel />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
