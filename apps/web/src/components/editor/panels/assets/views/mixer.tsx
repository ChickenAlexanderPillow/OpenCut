"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { Slider } from "@/components/ui/slider";
import { useEditor } from "@/hooks/use-editor";
import {
	audioVolumeToSliderPosition,
	sliderPositionToAudioVolume,
} from "@/lib/media/audio-volume-slider";
import { canTracktHaveAudio } from "@/lib/timeline";
import { normalizeTrackAudioEffects } from "@/lib/media/track-audio-effects";
import type {
	AudioTrack,
	TrackAudioEffects,
	VideoTrack,
} from "@/types/timeline";
import { ChevronDown, ChevronRight } from "lucide-react";

type TrackMeter = {
	peak: number;
	rmsDb: number;
	silent: boolean;
};

export function MixerView() {
	const editor = useEditor({ subscribeTo: ["timeline"] });
	const [trackLevels, setTrackLevels] = useState<Record<string, TrackMeter>>(
		{},
	);
	const tracks = editor.timeline.getTracks().filter(canTracktHaveAudio);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const handleTrackLevels = (event: Event) => {
			const detail = (
				event as CustomEvent<{
					tracks: Array<{
						trackId: string;
						peak: number;
						rmsDb: number;
						silent: boolean;
					}>;
				}>
			).detail;
			if (!detail) return;
			const next: Record<string, TrackMeter> = {};
			for (const track of detail.tracks) {
				next[track.trackId] = {
					peak: track.peak,
					rmsDb: track.rmsDb,
					silent: track.silent,
				};
			}
			setTrackLevels(next);
		};
		window.addEventListener("opencut:audio-track-levels", handleTrackLevels);
		return () => {
			window.removeEventListener(
				"opencut:audio-track-levels",
				handleTrackLevels,
			);
		};
	}, []);

	return (
		<PanelView title="Mixer" contentClassName="space-y-3 pb-3">
			<div className="space-y-3">
				{tracks.length === 0 ? (
					<div className="text-muted-foreground rounded-md border p-3 text-sm">
						No audio-capable tracks yet.
					</div>
				) : (
					tracks.map((track) => (
						<TrackMixerStrip
							key={track.id}
							track={track}
							level={trackLevels[track.id]}
							onVolumeChange={(nextVolume, pushHistory) =>
								editor.timeline.setAudioTrackVolume({
									trackId: track.id,
									volume: nextVolume,
									pushHistory,
								})
							}
							onToggleMute={() =>
								editor.timeline.toggleTrackMute({
									trackId: track.id,
								})
							}
							onEffectChange={(effect, updates, pushHistory) =>
								editor.timeline.updateTrackAudioEffect({
									trackId: track.id,
									effect,
									updates,
									pushHistory,
								})
							}
						/>
					))
				)}
			</div>
		</PanelView>
	);
}

function TrackMixerStrip({
	track,
	level,
	onVolumeChange,
	onToggleMute,
	onEffectChange,
}: {
	track: AudioTrack | VideoTrack;
	level?: TrackMeter;
	onVolumeChange: (value: number, pushHistory: boolean) => void;
	onToggleMute: () => void;
	onEffectChange: <TEffect extends keyof TrackAudioEffects>(
		effect: TEffect,
		updates: Partial<TrackAudioEffects[TEffect]>,
		pushHistory: boolean,
	) => void;
}) {
	const effects = normalizeTrackAudioEffects(track.audioEffects);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({
		eq: true,
		compressor: false,
		deesser: false,
		limiter: false,
	});
	const peakPercent = Math.max(
		4,
		Math.min(100, Math.round((level?.peak ?? 0) * 100)),
	);

	return (
		<div className="bg-muted/25 rounded-md border p-3">
			<div className="mb-3 flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium">{track.name}</div>
					<div className="text-muted-foreground text-[10px] uppercase tracking-[0.16em]">
						{track.type} channel
					</div>
				</div>
				<div className="flex h-12 w-2 items-end overflow-hidden rounded-sm bg-black/10">
					<div
						className={`w-full rounded-sm transition-all ${
							level?.silent ? "bg-muted-foreground/30" : "bg-emerald-500"
						}`}
						style={{ height: `${peakPercent}%` }}
					/>
				</div>
			</div>
			<div className="mb-2 flex items-center gap-2">
				<button
					type="button"
					className={`rounded border px-2 py-1 text-xs ${
						track.muted
							? "border-destructive text-destructive"
							: "text-muted-foreground"
					}`}
					onClick={onToggleMute}
				>
					{track.muted ? "Muted" : "Mute"}
				</button>
				<div className="text-muted-foreground text-[10px]">
					{Math.round((track.volume ?? 1) * 100)}%
				</div>
				<div className="text-muted-foreground ml-auto text-[10px]">
					{Math.round(level?.rmsDb ?? -120)} dB
				</div>
			</div>
			<Slider
				min={0}
				max={1}
				step={0.005}
				value={[
					audioVolumeToSliderPosition({
						volume: track.volume ?? 1,
					}),
				]}
				onValueChange={([value]) =>
					onVolumeChange(
						sliderPositionToAudioVolume({ position: value ?? 0 }),
						false,
					)
				}
				onValueCommit={([value]) =>
					onVolumeChange(
						sliderPositionToAudioVolume({ position: value ?? 0 }),
						true,
					)
				}
			/>
			<div className="mt-3 space-y-2">
				<EffectModule
					title="EQ"
					expanded={expanded.eq}
					enabled={effects.eq.enabled}
					onToggleExpanded={() =>
						setExpanded((current) => ({ ...current, eq: !current.eq }))
					}
					onToggleEnabled={(enabled) => onEffectChange("eq", { enabled }, true)}
				>
					<EffectSlider
						label="Low"
						min={-18}
						max={18}
						step={0.5}
						value={effects.eq.lowGainDb}
						onChange={(value, pushHistory) =>
							onEffectChange("eq", { lowGainDb: value }, pushHistory)
						}
					/>
					<EffectSlider
						label="Mid"
						min={-18}
						max={18}
						step={0.5}
						value={effects.eq.midGainDb}
						onChange={(value, pushHistory) =>
							onEffectChange("eq", { midGainDb: value }, pushHistory)
						}
					/>
					<EffectSlider
						label="High"
						min={-18}
						max={18}
						step={0.5}
						value={effects.eq.highGainDb}
						onChange={(value, pushHistory) =>
							onEffectChange("eq", { highGainDb: value }, pushHistory)
						}
					/>
				</EffectModule>
				<EffectModule
					title="Compressor"
					expanded={expanded.compressor}
					enabled={effects.compressor.enabled}
					onToggleExpanded={() =>
						setExpanded((current) => ({
							...current,
							compressor: !current.compressor,
						}))
					}
					onToggleEnabled={(enabled) =>
						onEffectChange("compressor", { enabled }, true)
					}
				>
					<EffectSlider
						label="Threshold"
						min={-60}
						max={0}
						step={1}
						value={effects.compressor.thresholdDb}
						onChange={(value, pushHistory) =>
							onEffectChange("compressor", { thresholdDb: value }, pushHistory)
						}
					/>
					<EffectSlider
						label="Ratio"
						min={1}
						max={20}
						step={0.1}
						value={effects.compressor.ratio}
						onChange={(value, pushHistory) =>
							onEffectChange("compressor", { ratio: value }, pushHistory)
						}
					/>
					<EffectSlider
						label="Makeup"
						min={0}
						max={18}
						step={0.5}
						value={effects.compressor.makeupGainDb}
						onChange={(value, pushHistory) =>
							onEffectChange("compressor", { makeupGainDb: value }, pushHistory)
						}
					/>
				</EffectModule>
				<EffectModule
					title="DeEsser"
					expanded={expanded.deesser}
					enabled={effects.deesser.enabled}
					onToggleExpanded={() =>
						setExpanded((current) => ({
							...current,
							deesser: !current.deesser,
						}))
					}
					onToggleEnabled={(enabled) =>
						onEffectChange("deesser", { enabled }, true)
					}
				>
					<EffectSlider
						label="Amount"
						min={0}
						max={18}
						step={0.5}
						value={effects.deesser.amountDb}
						onChange={(value, pushHistory) =>
							onEffectChange("deesser", { amountDb: value }, pushHistory)
						}
					/>
					<EffectSlider
						label="Focus"
						min={3500}
						max={10000}
						step={100}
						value={effects.deesser.frequency}
						onChange={(value, pushHistory) =>
							onEffectChange("deesser", { frequency: value }, pushHistory)
						}
						formatValue={(value) => `${Math.round(value / 100) / 10} kHz`}
					/>
				</EffectModule>
				<EffectModule
					title="Limiter"
					expanded={expanded.limiter}
					enabled={effects.limiter.enabled}
					onToggleExpanded={() =>
						setExpanded((current) => ({
							...current,
							limiter: !current.limiter,
						}))
					}
					onToggleEnabled={(enabled) =>
						onEffectChange("limiter", { enabled }, true)
					}
				>
					<EffectSlider
						label="Ceiling"
						min={-12}
						max={0}
						step={0.5}
						value={effects.limiter.ceilingDb}
						onChange={(value, pushHistory) =>
							onEffectChange("limiter", { ceilingDb: value }, pushHistory)
						}
					/>
					<EffectSlider
						label="Release"
						min={0.01}
						max={0.3}
						step={0.01}
						value={effects.limiter.releaseSeconds}
						onChange={(value, pushHistory) =>
							onEffectChange("limiter", { releaseSeconds: value }, pushHistory)
						}
						formatValue={(value) => `${value.toFixed(2)}s`}
					/>
				</EffectModule>
			</div>
		</div>
	);
}

function EffectModule({
	title,
	expanded,
	enabled,
	onToggleExpanded,
	onToggleEnabled,
	children,
}: {
	title: string;
	expanded: boolean;
	enabled: boolean;
	onToggleExpanded: () => void;
	onToggleEnabled: (enabled: boolean) => void;
	children: ReactNode;
}) {
	return (
		<div className="rounded border">
			<div className="flex items-center gap-2 px-2 py-1.5">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium"
					onClick={onToggleExpanded}
				>
					{expanded ? (
						<ChevronDown className="size-3.5" />
					) : (
						<ChevronRight className="size-3.5" />
					)}
					{title}
				</button>
				<button
					type="button"
					className={`rounded px-1.5 py-0.5 text-[10px] ${
						enabled
							? "bg-primary text-primary-foreground"
							: "bg-muted text-muted-foreground"
					}`}
					onClick={() => onToggleEnabled(!enabled)}
				>
					{enabled ? "On" : "Off"}
				</button>
			</div>
			{expanded ? (
				<div className="space-y-2 border-t p-2">{children}</div>
			) : null}
		</div>
	);
}

function EffectSlider({
	label,
	value,
	min,
	max,
	step,
	onChange,
	formatValue,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number, pushHistory: boolean) => void;
	formatValue?: (value: number) => string;
}) {
	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em]">
				<span>{label}</span>
				<span>{formatValue ? formatValue(value) : value.toFixed(1)}</span>
			</div>
			<Slider
				min={min}
				max={max}
				step={step}
				value={[value]}
				onValueChange={([nextValue]) => onChange(nextValue ?? value, false)}
				onValueCommit={([nextValue]) => onChange(nextValue ?? value, true)}
			/>
		</div>
	);
}
