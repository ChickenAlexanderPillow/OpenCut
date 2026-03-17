import { Slider } from "@/components/ui/slider";
import { useEditor } from "@/hooks/use-editor";
import {
	audioVolumeToSliderPosition,
	sliderPositionToAudioVolume,
} from "@/lib/media/audio-volume-slider";
import type { AudioElement } from "@/types/timeline";

export function AudioProperties({
	_element: element,
}: {
	_element: AudioElement;
}) {
	const editor = useEditor({ subscribeTo: ["timeline"] });
	const track = editor.timeline
		.getTracks()
		.find(
			(candidate) =>
				candidate.type === "audio" &&
				candidate.elements.some(
					(trackElement) => trackElement.id === element.id,
				),
		);

	return (
		<div className="space-y-5 p-5">
			<div>
				<h3 className="text-sm font-medium">{element.name}</h3>
				<p className="text-muted-foreground text-xs">
					Clip controls stay here. Channel strip effects live on
					{track ? ` ${track.name}` : " the parent track"} in the mixer rail.
				</p>
			</div>
			<div className="space-y-2">
				<div className="flex items-center justify-between text-xs uppercase tracking-[0.16em]">
					<span>Clip volume</span>
					<span>{Math.round((element.volume ?? 1) * 100)}%</span>
				</div>
				<Slider
					min={0}
					max={1}
					step={0.005}
					value={[
						audioVolumeToSliderPosition({
							volume: element.volume ?? 1,
						}),
					]}
					onValueChange={([value]) => {
						if (!track) return;
						const nextVolume = sliderPositionToAudioVolume({
							position: value ?? 0,
						});
						editor.timeline.updateElements({
							updates: [
								{
									trackId: track.id,
									elementId: element.id,
									updates: { volume: nextVolume },
								},
							],
							pushHistory: false,
						});
					}}
					onValueCommit={([value]) => {
						if (!track) return;
						const nextVolume = sliderPositionToAudioVolume({
							position: value ?? 0,
						});
						editor.timeline.updateElements({
							updates: [
								{
									trackId: track.id,
									elementId: element.id,
									updates: { volume: nextVolume },
								},
							],
						});
					}}
				/>
			</div>
			<div className="flex items-center justify-between rounded border px-3 py-2 text-sm">
				<span>Muted</span>
				<button
					type="button"
					className={`rounded px-2 py-1 text-xs ${
						element.muted
							? "bg-destructive text-destructive-foreground"
							: "bg-muted"
					}`}
					onClick={() => {
						if (!track) return;
						editor.timeline.toggleElementsMuted({
							elements: [{ trackId: track.id, elementId: element.id }],
						});
					}}
				>
					{element.muted ? "On" : "Off"}
				</button>
			</div>
			<div className="text-muted-foreground rounded border p-3 text-xs">
				Track effects available in mixer: EQ, compressor, de-esser, limiter.
			</div>
		</div>
	);
}
