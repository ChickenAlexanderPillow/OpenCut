# AGENTS.md

## Overview

Privacy-first video editor, with a focus on simplicity and ease of use.

## Lib vs Utils

- `lib/` - domain logic (specific to this app)
- `utils/` - small helper utils (generic, could be copy-pasted into any other app)

## Core Editor System

The editor uses a **singleton EditorCore** that manages all editor state through specialized managers.

### Architecture

```
EditorCore (singleton)
├── playback: PlaybackManager
├── timeline: TimelineManager
├── scene: SceneManager
├── project: ProjectManager
├── media: MediaManager
└── renderer: RendererManager
```

### When to Use What

#### In React Components

**Always use the `useEditor()` hook:**

```typescript
import { useEditor } from '@/hooks/use-editor';

function MyComponent() {
  const editor = useEditor();
  const tracks = editor.timeline.getTracks();

  // Call methods
  editor.timeline.addTrack({ type: 'media' });

  // Display data (auto re-renders on changes)
  return <div>{tracks.length} tracks</div>;
}
```

The hook:

- Returns the singleton instance
- Subscribes to all manager changes
- Automatically re-renders when state changes

#### Outside React Components

**Use `EditorCore.getInstance()` directly:**

```typescript
// In utilities, event handlers, or non-React code
import { EditorCore } from "@/core";

const editor = EditorCore.getInstance();
await editor.export({ format: "mp4", quality: "high" });
```

## Actions System

Actions are the trigger layer for user-initiated operations. The single source of truth is `@/lib/actions/definitions.ts`.

**To add a new action:**

1. Add it to `ACTIONS` in `@/lib/actions/definitions.ts`:

```typescript
export const ACTIONS = {
  "my-action": {
    description: "What the action does",
    category: "editing",
    defaultShortcuts: ["ctrl+m"],
  },
  // ...
};
```

2. Add handler in `@/hooks/use-editor-actions.ts`:

```typescript
useActionHandler(
  "my-action",
  () => {
    // implementation
  },
  undefined,
);
```

**In components, use `invokeAction()` for user-triggered operations:**

```typescript
import { invokeAction } from '@/lib/actions';

// Good - uses action system
const handleSplit = () => invokeAction("split-selected");

// Avoid - bypasses UX layer (toasts, validation feedback)
const handleSplit = () => editor.timeline.splitElements({ ... });
```

Direct `editor.xxx()` calls are for internal use (commands, tests, complex multi-step operations).

## Reserved Shortcuts

When adding features, do not overwrite these existing shortcuts without explicitly reviewing and updating both `@/lib/actions/definitions.ts` and this section.

Action-backed shortcuts from `@/lib/actions/definitions.ts`:

- `Space`, `K` - Play/Pause
- `L` - Seek forward 1 second
- `J` - Seek backward 1 second
- `Right` - Frame step forward
- `Left` - Frame step backward
- `Shift+Right` - Jump forward 5 seconds
- `Shift+Left` - Jump backward 5 seconds
- `Home`, `Enter` - Go to timeline start
- `End` - Go to timeline end
- `S` - Split at playhead
- `Q` - Split and remove left
- `W` - Split and remove right
- `Backspace`, `Delete` - Delete selected
- `Ctrl+C` - Copy selected
- `Ctrl+V` - Paste at playhead
- `N` - Toggle snapping
- `Ctrl+A` - Select all
- `Ctrl+D` - Duplicate selected
- `I` - Set in point
- `O` - Set out point
- `Ctrl+Z` - Undo
- `Ctrl+Shift+Z`, `Ctrl+Y` - Redo

Custom non-action shortcuts currently implemented directly in UI code:

- `` ` `` - Add/split reframe section at playhead for the selected video clip
- `1` - Apply the first visible reframe angle in the tray
- `2` - Apply the second visible reframe angle in the tray
- `3` - Apply the third visible reframe angle in the tray
- `4` - Apply split-screen balanced mode to the active angle section
- `5` - Apply split-screen unbalanced mode to the active angle section
- `=` - Swap top and bottom split-screen bindings

If any shortcut is added, removed, or reassigned, update this section in the same change.

## Commands System

Commands handle undo/redo. They live in `@/lib/commands/` organized by domain (timeline, media, scene).

Each command extends `Command` from `@/lib/commands/base-command` and implements:

- `execute()` - saves current state, then does the mutation
- `undo()` - restores the saved state

Actions and commands work together: actions are "what triggered this", commands are "how to do it (and undo it)".

## Root Cause Fixes

Prefer fixing the underlying cause of a bug or inconsistency instead of adding fallback logic to mask it.

- Do not add defensive fallbacks just to make broken state appear to work.
- Trace failures to the source manager, command, action, or data flow and correct the real issue there.
- Only introduce a fallback when it is a deliberate product requirement, and document why the root cause cannot be solved directly.
- If a fallback is unavoidable, treat it as temporary unless there is a clear long-term reason for it.

## Playwright Session Policy

Use shared browser storage for any stateful browser validation (auth/session/project-local data).

- Do not rely on MCP Playwright browser state for stateful validation.
- Use the local shared-profile launcher: `bun run e2e:shared-profile`.
- Default shared profile path: `C:\playwright-shared-profile`.
- If launch fails, close Chrome/Chromium windows using that profile and retry.
- Optional env overrides:
  - `PLAYWRIGHT_PROFILE_DIR`
  - `PLAYWRIGHT_EDITOR_URL`
  - `PLAYWRIGHT_HEADLESS`
  - `PLAYWRIGHT_AUTO_EXIT_MS`
