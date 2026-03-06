import { getDefaultShortcuts } from "@/lib/actions";
import type { TActionWithOptionalArgs } from "@/lib/actions";
import type { KeybindingConfig, ShortcutKey } from "@/types/keybinding";

interface V4State {
	keybindings: KeybindingConfig;
	isCustomized: boolean;
}

function hasBindingForAction({
	keybindings,
	action,
}: {
	keybindings: KeybindingConfig;
	action: TActionWithOptionalArgs;
}): boolean {
	return Object.values(keybindings).some((boundAction) => boundAction === action);
}

export function v4ToV5({ state }: { state: unknown }): unknown {
	const v4 = state as V4State;
	const defaults = getDefaultShortcuts();
	const migrated = { ...v4.keybindings };

	// Add newly introduced default shortcuts without overriding user-custom keys.
	for (const [key, action] of Object.entries(defaults) as Array<
		[ShortcutKey, TActionWithOptionalArgs]
	>) {
		if (migrated[key]) continue;
		if (hasBindingForAction({ keybindings: migrated, action })) continue;
		migrated[key] = action;
	}

	return { ...v4, keybindings: migrated };
}
