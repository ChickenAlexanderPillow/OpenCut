import type { AudioElement, VideoElement } from "@/types/timeline";

export type SourceWindowTiming = Pick<
	VideoElement | AudioElement,
	"trimStart" | "duration"
>;

export function didRevealNewSourceRange({
	before,
	after,
	tolerance = 1e-6,
}: {
	before: SourceWindowTiming;
	after: SourceWindowTiming;
	tolerance?: number;
}): boolean {
	const beforeStart = before.trimStart;
	const beforeEnd = before.trimStart + before.duration;
	const afterStart = after.trimStart;
	const afterEnd = after.trimStart + after.duration;

	return (
		afterStart < beforeStart - tolerance || afterEnd > beforeEnd + tolerance
	);
}
