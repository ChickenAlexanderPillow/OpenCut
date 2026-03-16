"use client";

import { useEditor } from "@/hooks/use-editor";
import { formatTimeCode } from "@/lib/time";
import { invokeAction } from "@/lib/actions";
import { EditableTimecode } from "@/components/editable-timecode";
import { Button } from "@/components/ui/button";
import {
	FullScreenIcon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loader2, Repeat, SkipBack, SkipForward } from "lucide-react";

export function PreviewToolbar({
	isFullscreen,
	onToggleFullscreen,
}: {
	isFullscreen: boolean;
	onToggleFullscreen: () => void;
}) {
	const editor = useEditor({
		subscribeTo: ["playback", "timeline", "project"],
	});
	const isPlaying = editor.playback.getIsPlaying();
	const blockedReason = editor.playback.getBlockedReason();
	const isPlaybackBlocked = blockedReason !== null;
	const isLoopEnabled = editor.playback.getIsLoopEnabled();
	const currentTime = editor.playback.getCurrentTime();
	const totalDuration = editor.timeline.getTotalDuration();
	const fps = editor.project.getActive().settings.fps;
	const { start: playbackStart, end: playbackEnd } =
		editor.playback.getPlaybackBounds();
	const hasInPoint = editor.playback.getInPoint() !== null;
	const hasOutPoint = editor.playback.getOutPoint() !== null;

	return (
		<div className="grid grid-cols-[1fr_auto_1fr] items-center pb-3 pt-5 px-5">
			<div className="flex items-center">
				<EditableTimecode
					time={currentTime}
					duration={totalDuration}
					format="HH:MM:SS:FF"
					fps={fps}
					enableScrub={true}
					onTimeChange={({ time }) =>
						editor.playback.seek({
							time: Math.max(playbackStart, Math.min(playbackEnd, time)),
						})
					}
					className="text-center"
				/>
				<span className="text-muted-foreground px-2 font-mono text-xs">/</span>
				<span className="text-muted-foreground font-mono text-xs">
					{formatTimeCode({
						timeInSeconds: totalDuration,
						format: "HH:MM:SS:FF",
						fps,
					})}
				</span>
			</div>

			<div className="flex items-center gap-1 px-1">
				<Button
					variant="text"
					size="sm"
					className="h-9 w-9 min-w-9 p-0"
					onClick={() => invokeAction("goto-start")}
					title={hasInPoint ? "Jump to in point" : "Jump to start"}
				>
					<SkipBack className="size-4" />
				</Button>
				<Button
					variant="text"
					size="sm"
					className="h-9 w-9 min-w-9 overflow-visible p-0"
					onClick={() => invokeAction("toggle-play")}
					disabled={isPlaybackBlocked}
					title={blockedReason ?? undefined}
				>
					{isPlaybackBlocked ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<HugeiconsIcon icon={isPlaying ? PauseIcon : PlayIcon} />
					)}
				</Button>
				<Button
					variant={isLoopEnabled ? "secondary" : "text"}
					size="sm"
					className="h-9 w-9 min-w-9 p-0"
					onClick={() => invokeAction("toggle-loop-playback")}
					title={isLoopEnabled ? "Disable loop" : "Enable loop"}
				>
					<Repeat className="size-4" />
				</Button>
				<Button
					variant="text"
					size="sm"
					className="h-9 w-9 min-w-9 p-0"
					onClick={() => invokeAction("goto-end")}
					title={hasOutPoint ? "Jump to out point" : "Jump to end"}
				>
					<SkipForward className="size-4" />
				</Button>
			</div>

			<div className="justify-self-end flex items-center">
				<Button
					variant="text"
					onClick={onToggleFullscreen}
					title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
				>
					<HugeiconsIcon icon={FullScreenIcon} />
				</Button>
			</div>
		</div>
	);
}
