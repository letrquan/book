# Book AI Agent — Claude Code-Style TUI Redesign

**Date:** 2026-06-25
**Status:** Draft
**Approach:** B — Full TUI layer rewrite matching Claude Code patterns

## Overview

Rewrite the Book agent's terminal UI to match Claude Code's visual design patterns: fixed bottom input, collapsible tool results, permission system with mode cycling, color-tokenized theming, diff rendering, and interactive inline permission prompts. The agent core, tool system, and provider layers remain unchanged — only `src/tui/` and `src/agent/loop.ts` callbacks are modified.

## Layout Structure

```
┌─────────────────────────────────────────────────────────────┐
│  Chat Panel (flex-grow, scrollable)                         │
│                                                             │
│  ┌─ You ─────────────────────────────────────────────────┐ │
│  │  Add a login page                                      │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Book ────────────────────────────────────────────────┐ │
│  │  I'll start by exploring the project...               │ │
│  │                                                       │ │
│  │  ▼ read_file  src/App.tsx                  [OK]  45L  │ │
│  │  │  1: import React from 'react'                     │ │
│  │  │  2: import { Box } from 'ink'                    │ │
│  │                                                       │ │
│  │  ▶ glob  src/components/**/*.tsx                      │ │
│  │                                                       │ │
│  │  Now creating the Login component...                  │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  model: glm-5.2  │  turn 3/25  │  tokens 1.2k/128k         │
├─────────────────────────────────────────────────────────────┤
│  > _                                              [default] │
└─────────────────────────────────────────────────────────────┘
```

Key design decisions:
- **Input fixed at bottom** with permission mode badge
- **Status line** between chat and input: model, turns, tokens, git branch
- **Chat fills remaining space** — messages scroll naturally, no explicit height clamp
- **No header** — model/version info lives in status line
- **Collapsible tool calls** — default collapsed, only current tool expanded
- **User messages** labeled "You", agent messages labeled "Book"

## Component Tree

```
App
├── ChatPanel                    # flexGrow, scrollable message area
│   ├── UserMessage[]            # "You" label + content on dim bg
│   └── AgentMessage[]           # "Book" label + streaming text + tool calls
│       ├── Content              # Streaming text with spinner
│       └── ToolCallBlock[]      # Collapsible tool execution
│           ├── CollapsedRow     # Spinner/status, name, arg, timing
│           └── ExpandedBody     # Output, diff, or error
├── StatusLine                   # Model, turns, tokens, git branch
└── InputBar                     # Text input, mode badge, mode cycling
```

## Color System

Token-based theming, matching Claude Code's approach:

| Token | Color | Usage |
|-------|-------|-------|
| `brand` | cyan | Default borders, Book label, links, input border (default mode) |
| `brandAlt` | magenta | Tool names, plan mode border |
| `text` | white | Agent message body |
| `subtle` | gray | Timestamps, secondary info, collapsed arg display |
| `success` | green | `[OK]` badge, diff additions background |
| `error` | red | `[ERR]` badge, diff removals background |
| `warning` | yellow | Auto mode input border, near-limit token count |
| `inverse` | black on white | Selected permission button |
| `diffAdded` | green bg | Diff added lines |
| `diffRemoved` | red bg | Diff removed lines |

**Spinner gradient:** Braille frames cycle between `brand` (cyan) and `brandAlt` (magenta), creating a shimmer effect.

## Tool Call Display

Each tool call is a collapsible block:

**Collapsed state** (default):
```
  ▼ read_file  src/App.tsx                          [OK]   45L
```
Format: `{toggle} {name} {primaryArg} {status} {timing/size}`

**Expanded state** (toggle or Space):
```
  ▼ read_file  src/App.tsx                          [OK]   45L
  │  1: import React from 'react'
  │  2: import { Box } from 'ink'
  │  ...
```

**For diff results** (edit_file):
```
  ▼ edit_file  src/Login.tsx                        [OK]
  │  + import { useState } from 'react'
  │  - import { useEffect } from 'react'
  │  + const [count, setCount] = useState(0)
```

- `+` lines: green background (`diffAdded`)
- `-` lines: red background (`diffRemoved`)

**Behavior:**
- Previous tool call auto-collapses when new one starts (only current expanded)
- Click line or press Space to toggle expand/collapse
- Future: subagent tools get distinct colors from 8-color palette

## Permission System

### Modes (cycled with Shift+Tab, reflected in InputBar border color)

| Mode | Border | Behavior |
|------|--------|----------|
| `default` | cyan (`brand`) | Ask before bash, file writes, git commits |
| `auto` | yellow (`warning`) | Auto-approve all operations |
| `plan` | magenta (`brandAlt`) | Read-only — deny all writes and executions |
| `accept-edits` | green (`success`) | Auto-approve file edits, ask for bash/git |

### Inline Permission Prompt

When a tool needs approval, buttons appear within the agent message:

```
  ┌─ Book ────────────────────────────────────────────────┐
  │                                                       │
  │  I'll clean up the node_modules directory.            │
  │                                                       │
  │  ⏳ bash  rm -rf /node_modules          [needs approval]│
  │                                                       │
  │  [Run]   [Skip]   [Always allow bash]                 │
  └───────────────────────────────────────────────────────┘
```

- `←` `→` arrow keys navigate between buttons
- `Enter` selects highlighted button
- `Ctrl+E` toggles showing file/log details for the pending tool
- "Always allow" adds to per-session allowlist (for that specific tool name)
- Input is disabled while permission is pending
- Selected button shows inverse colors (`inverse` token)

## Agent Loop Changes

The `AgentLoopCallbacks` interface gets new callbacks:

```typescript
export interface AgentLoopCallbacks {
  // existing
  onText: (text: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult) => void;
  onError: (error: string) => void;
  onTurnStart: (turn: number) => void;
  onDone: () => void;
  // new
  onPermissionRequired: (toolCall: ToolCall) => Promise<'allow' | 'deny' | 'always'>;
  onTokenCount: (count: number) => void;
}
```

The agent loop pauses at tool execution when a tool is in the permission-check category (bash, write_file, edit_file, git_commit). It calls `onPermissionRequired`, waits for the promise to resolve, then either executes or skips the tool.

## Animation System

| Element | Animation |
|---------|-----------|
| Spinner (thinking) | Braille frames, brand↔brandAlt color cycling, 80ms interval |
| Spinner (tool running) | Dot frames, white, 80ms interval |
| AgentMessage border | Pulsing cyan/dim while streaming (500ms pulse) |
| Streaming text | Characters appear with typewriter effect (configurable speed) |
| Token count | Blinks red when >80% of context limit (500ms) |
| Permission buttons | No animation — toggles between normal/inverse instantly |

## Status Line

Single line between chat and input:

```
  model: sf/glm-5  │  turn 3/25  │  tokens 1.2k/128k  │  main ✓
```

Format: `model: {name} │ turn {n}/{max} │ tokens {used}/{limit} │ {git_branch} {status}`
- Git status: `✓` clean, `+2 ~1` staged/modified counts
- Token count blinks red when near limit
- Updated after each turn completes

## Input Bar

```
  > Type your prompt here...                      [default]
```

- `TextInput` from `ink-text-input` for text entry
- Placeholder text when empty
- Mode badge on right side: `[default]`, `[auto]`, `[plan]`, `[accept-edits]`
- `Shift+Tab` cycles permission mode
- Border color changes with mode
- `/` commands handled inline: `/clear` resets, `/exit` quits
- Disabled state shows "(thinking...)" instead of prompt

## File Map

```
src/
  tui/
    app.tsx                    # Root App — layout, keyboard handler, mode state
    components/
      ChatPanel.tsx            # Scrollable message list (flexGrow)
      UserMessage.tsx          # "You" label + user content
      AgentMessage.tsx         # "Book" label + streaming text + tool blocks
      ToolCallBlock.tsx        # Collapsible tool call (collapsed/expanded)
      StatusLine.tsx           # Model, turns, tokens, git branch
      InputBar.tsx             # Text input + mode badge + mode cycling
      PermissionButtons.tsx    # Inline [Run] [Skip] [Always allow] buttons
      Spinner.tsx              # Reusable braille/dot spinner
    hooks/
      useAnimation.ts          # useSpinner, useTypewriter, usePulse (updated)
      useAgent.ts              # Agent state + permission management (updated)
      useGitStatus.ts          # Git branch/status for StatusLine (new)
  agent/
    loop.ts                    # Agent loop — add onPermissionRequired, onTokenCount
  types.ts                     # Add PermissionMode, PermissionResult types
```

## What Stays Unchanged

- `src/tools/` — All tool implementations (file, shell, git, design, browser)
- `src/tools/registry.ts` — Tool registry
- `src/provider/openai-compatible.ts` — Provider streaming
- `src/agent/context.ts` — Context builder
- `src/config.ts` — Config loading
- `src/index.ts` — CLI entry point (minor change: pass new config options)

## Error Handling

| Scenario | Behavior |
|---------|----------|
| Permission denied | Tool shows `[SKIPPED]` badge, agent loop continues |
| Permission dialog closed (Escape) | Same as deny |
| Tool execution fails | `[ERR]` badge + error text in expanded view |
| Max turns exceeded | Red text in StatusLine |
| API error | Red error text in AgentMessage |
