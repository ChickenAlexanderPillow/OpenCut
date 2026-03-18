import { usePreviewInteraction } from "@/hooks/use-preview-interaction";
import { TransformHandles } from "./transform-handles";
import { SnapGuides } from "./snap-guides";
import { TextEditOverlay } from "./text-edit-overlay";
import {
	canvasToOverlay,
	getDisplayScale,
} from "@/lib/preview/preview-coords";
import { useEditor } from "@/hooks/use-editor";
import { usePreviewStore } from "@/stores/preview-store";
import { getPreviewCanvasSize } from "@/lib/preview/preview-format";

export function PreviewInteractionOverlay({
	canvasRef,
	containerRef,
}: {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
	containerRef: React.RefObject<HTMLDivElement | null>;
}) {
	const {
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onDoubleClick,
		snapLines,
		hoveredSplitSlotId,
		splitSlotRegions,
		activeSplitSlotId,
		editingText,
		commitTextEdit,
		cancelTextEdit,
	} = usePreviewInteraction({ canvasRef });
	const editor = useEditor({ subscribeTo: ["project"] });
	const { previewFormatVariant } = usePreviewStore();
	const projectCanvas = editor.project.getActive().settings.canvasSize;
	const canvasSize = getPreviewCanvasSize({
		projectWidth: projectCanvas.width,
		projectHeight: projectCanvas.height,
		previewFormatVariant,
	});
	const canvasRect = canvasRef.current?.getBoundingClientRect() ?? null;
	const containerRect = containerRef.current?.getBoundingClientRect() ?? null;
	const displayScale =
		canvasRect && containerRect
			? getDisplayScale({ canvasRect, canvasSize })
			: null;

	return (
		<div className="absolute inset-0">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: canvas overlay, pointer-only interaction */}
			<div
				className="absolute inset-0 pointer-events-auto"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onDoubleClick={onDoubleClick}
			/>
			{canvasRect &&
				containerRect &&
				displayScale &&
				splitSlotRegions.map((region) => {
					const center = canvasToOverlay({
						canvasX: region.bounds.cx,
						canvasY: region.bounds.cy,
						canvasRect,
						containerRect,
						canvasSize,
					});
					const isActive = region.slotId === activeSplitSlotId;
					const isHovered = region.slotId === hoveredSplitSlotId;
					return (
						<div
							key={region.slotId}
							className="pointer-events-none absolute rounded-sm transition-colors"
							style={{
								left: center.x - (region.bounds.width * displayScale.x) / 2,
								top: center.y - (region.bounds.height * displayScale.y) / 2,
								width: region.bounds.width * displayScale.x,
								height: region.bounds.height * displayScale.y,
								border: isActive
									? "2px solid rgba(255,255,255,0.92)"
									: isHovered
										? "2px solid rgba(255,255,255,0.55)"
										: "1px solid rgba(255,255,255,0.2)",
								background: isActive
									? "rgba(255,255,255,0.08)"
									: isHovered
										? "rgba(255,255,255,0.04)"
										: "transparent",
							}}
						>
							{isHovered && !isActive && (
								<div className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/75">
									Double-click to edit
								</div>
							)}
						</div>
					);
				})}
			{editingText ? (
				<TextEditOverlay
					canvasRef={canvasRef}
					containerRef={containerRef}
					trackId={editingText.trackId}
					elementId={editingText.elementId}
					element={editingText.element}
					onCommit={commitTextEdit}
					onCancel={cancelTextEdit}
				/>
			) : (
				<TransformHandles canvasRef={canvasRef} containerRef={containerRef} />
			)}
			<SnapGuides
				lines={snapLines}
				canvasRef={canvasRef}
				containerRef={containerRef}
			/>
		</div>
	);
}
