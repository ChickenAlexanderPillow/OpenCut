import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { useEditor } from "@/hooks/use-editor";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { buildTextElement } from "@/lib/timeline/element-utils";

export function TextView() {
	const editor = useEditor();
	const sceneName = editor.scenes.getActiveScene().name;

	const handleAddToTimeline = ({ currentTime }: { currentTime: number }) => {
		const activeScene = editor.scenes.getActiveScene();
		if (!activeScene) return;

		const element = buildTextElement({
			raw: DEFAULT_TEXT_ELEMENT,
			startTime: currentTime,
		});

		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	const upsertSceneTitlePreset = () => {
		const activeScene = editor.scenes.getActiveScene();
		const tracks = editor.timeline.getTracks();
		const totalDuration = editor.timeline.getTotalDuration();
		const titleDuration = totalDuration > 0 ? Math.min(5, totalDuration) : 5;
		const titleRaw = {
			...DEFAULT_TEXT_ELEMENT,
			name: "Scene Title",
			content: activeScene.name,
			duration: titleDuration,
			fontSize: 3,
			color: "#ffffff",
			strokeColor: "#000000",
			strokeWidth: 2,
			background: {
				...DEFAULT_TEXT_ELEMENT.background,
				color: "transparent",
			},
			captionStyle: {
				isSceneTitle: true,
				fitInCanvas: true,
				neverShrinkFont: false,
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
						updates: {
							...titleRaw,
							startTime: 0,
						},
					},
				],
			});
			return;
		}

		const trackId = editor.timeline.addTrack({
			type: "text",
			index: 0,
		});
		editor.timeline.insertElement({
			placement: { mode: "explicit", trackId },
			element: buildTextElement({
				raw: titleRaw,
				startTime: 0,
			}),
		});
	};

	return (
		<PanelView title="Text">
			<div className="grid grid-cols-2 gap-2">
				<DraggableItem
					name="Default text"
					preview={
						<div className="bg-accent flex size-full items-center justify-center rounded">
							<span className="text-xs select-none">Default text</span>
						</div>
					}
					dragData={{
						id: "temp-text-id",
						type: DEFAULT_TEXT_ELEMENT.type,
						name: DEFAULT_TEXT_ELEMENT.name,
						content: DEFAULT_TEXT_ELEMENT.content,
					}}
					aspectRatio={1}
					onAddToTimeline={handleAddToTimeline}
					shouldShowLabel
					containerClassName="w-full"
				/>
				<DraggableItem
					name="Scene title"
					preview={
						<div className="bg-accent relative size-full overflow-hidden rounded">
							<div className="absolute top-2 left-2 right-2 h-0.5 rounded bg-white/15" />
							<div className="absolute top-3 left-2 right-2 text-center text-[11px] font-semibold text-white [text-shadow:_-1px_-1px_0_#000,_1px_-1px_0_#000,_-1px_1px_0_#000,_1px_1px_0_#000]">
								{sceneName}
							</div>
						</div>
					}
					dragData={{
						id: "scene-title-text-preset",
						type: "text",
						name: "Scene Title",
						content: sceneName,
						raw: {
							duration: 5,
							fontSize: 3,
							color: "#ffffff",
							strokeColor: "#000000",
							strokeWidth: 2,
							background: {
								...DEFAULT_TEXT_ELEMENT.background,
								color: "transparent",
							},
							captionStyle: {
								isSceneTitle: true,
								fitInCanvas: true,
								neverShrinkFont: false,
								anchorToSafeAreaBottom: false,
								anchorToSafeAreaTop: true,
								safeAreaTopOffset: 0,
							},
						},
					}}
					aspectRatio={1}
					onAddToTimeline={() => upsertSceneTitlePreset()}
					shouldShowLabel
					containerClassName="w-full"
					isDraggable={false}
				/>
			</div>
		</PanelView>
	);
}
