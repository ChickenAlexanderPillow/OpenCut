import { usePreviewInteraction } from "@/hooks/use-preview-interaction";
import { TransformHandles } from "./transform-handles";
import { SnapGuides } from "./snap-guides";
import { TextEditOverlay } from "./text-edit-overlay";
import { canvasToOverlay, getDisplayScale } from "@/lib/preview/preview-coords";
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
		onPointerLeave,
		onPointerCancel,
		snapLines,
		hoveredSplitSlotId,
		selectedSplitSlotId,
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
				style={{
					cursor: hoveredSplitSlotId || activeSplitSlotId ? "grab" : "default",
				}}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onDoubleClick={onDoubleClick}
				onPointerLeave={onPointerLeave}
				onPointerCancel={onPointerCancel}
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
					const isSelected = region.slotId === selectedSplitSlotId;
					const isActive = region.slotId === activeSplitSlotId;
					const isHovered = region.slotId === hoveredSplitSlotId;
					return (
						<div
							key={region.slotId}
							className="pointer-events-none absolute transition-colors"
							style={{
								left: center.x - (region.bounds.width * displayScale.x) / 2,
								top: center.y - (region.bounds.height * displayScale.y) / 2,
								width: region.bounds.width * displayScale.x,
								height: region.bounds.height * displayScale.y,
								border: isSelected
									? "2px solid rgba(59,130,246,0.95)"
									: isActive
										? "2px solid rgba(255,255,255,0.92)"
										: isHovered
											? "2px solid rgba(255,255,255,0.55)"
											: "1px solid rgba(255,255,255,0.2)",
								background: "transparent",
							}}
						></div>
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
