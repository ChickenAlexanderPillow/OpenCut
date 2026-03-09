import type { MutableRefObject } from "react";
import type { TAction } from "./definitions";

export type { TAction };

export type TActionArgsMap = {
	"seek-forward": { seconds: number } | undefined;
	"seek-backward": { seconds: number } | undefined;
	"jump-forward": { seconds: number } | undefined;
	"jump-backward": { seconds: number } | undefined;
	"generate-viral-clips": { sourceMediaId: string } | undefined;
	"import-selected-viral-clips": { candidateIds: string[] } | undefined;
	"transcript-toggle-word":
		| { trackId: string; elementId: string; wordId: string }
		| undefined;
	"transcript-update-word":
		| { trackId: string; elementId: string; wordId: string; text: string }
		| undefined;
	"transcript-update-words":
		| {
				trackId: string;
				elementId: string;
				updates: Array<{ wordId: string; text: string }>;
		  }
		| undefined;
	"transcript-set-words-removed":
		| {
				trackId: string;
				elementId: string;
				wordIds: string[];
				removed: boolean;
		  }
		| undefined;
	"transcript-remove-fillers": { trackId: string; elementId: string } | undefined;
	"transcript-remove-pauses":
		| { trackId: string; elementId: string; thresholdSeconds?: number }
		| undefined;
	"transcript-restore-all": { trackId: string; elementId: string } | undefined;
	"transcript-split-segment-ui":
		| { trackId: string; elementId: string; wordId: string }
		| undefined;
	"rebuild-captions-for-clip":
		| { trackId: string; elementId: string }
		| undefined;
	"apply-transition-in":
		| {
				presetId: string;
				durationSeconds?: number;
				trackId?: string;
				elementId?: string;
		  }
		| undefined;
	"apply-transition-out":
		| {
				presetId: string;
				durationSeconds?: number;
				trackId?: string;
				elementId?: string;
		  }
		| undefined;
	"remove-transition-in":
		| {
				trackId?: string;
				elementId?: string;
		  }
		| undefined;
	"remove-transition-out":
		| {
				trackId?: string;
				elementId?: string;
		  }
		| undefined;
	"caption-run-drift-check": undefined;
	"select-all-captions": { trackId?: string } | undefined;
	"clear-viral-clips-session": undefined;
};

type TKeysWithValueUndefined<T> = {
	[K in keyof T]: undefined extends T[K] ? K : never;
}[keyof T];

export type TActionWithArgs = keyof TActionArgsMap;

export type TActionWithOptionalArgs =
	| TActionWithNoArgs
	| TKeysWithValueUndefined<TActionArgsMap>;

export type TActionWithNoArgs = Exclude<TAction, TActionWithArgs>;

export type TArgOfAction<A extends TAction> = A extends TActionWithArgs
	? TActionArgsMap[A]
	: undefined;

export type TActionFunc<A extends TAction> = A extends TActionWithArgs
	? (arg: TArgOfAction<A>, trigger?: TInvocationTrigger) => void
	: (_?: undefined, trigger?: TInvocationTrigger) => void;

export type TInvocationTrigger = "keypress" | "mouseclick";

export type TBoundActionList = {
	[A in TAction]?: Array<TActionFunc<A>>;
};

export type TActionHandlerOptions =
	| MutableRefObject<boolean>
	| boolean
	| undefined;
