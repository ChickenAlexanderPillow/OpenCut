"use client";

import { resolveSafeAreaPreset } from "@/constants/safe-area-constants";

export function SafeAreaOverlay({
	canvasWidth,
	canvasHeight,
}: {
	canvasWidth: number;
	canvasHeight: number;
}) {
	const preset = resolveSafeAreaPreset({
		width: canvasWidth,
		height: canvasHeight,
	});
	if (!preset) return null;

	const { top, right, bottom, left } = preset.inset;

	return (
		<div className="pointer-events-none absolute inset-0 z-20">
			<div
				className="absolute border border-dashed border-emerald-300/95 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
				style={{
					left: `${left * 100}%`,
					right: `${right * 100}%`,
					top: `${top * 100}%`,
					bottom: `${bottom * 100}%`,
				}}
			/>
		</div>
	);
}
