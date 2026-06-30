# M9 — UX Polish

**Date:** 2026-06-26
**Status:** Complete
**Depends on:** M1–M8 ✅

## Scope

Close the TUI/UX gaps so the interactive experience matches Claude Code.
The TUI already has an Ink-based renderer with ChatPanel, InputBar, StatusLine,
ToolCallBlock, PermissionButtons, AgentTodoList, TaskList, and Spinner components.
This milestone makes them feel polished and complete.

## Design decisions

1. **Fullscreen renderer is deferred** — Ink alt-screen mode requires significant
   refactoring (virtualized scrollback, ring buffer). The existing inline renderer works well.
   We'll add auto-scroll toggle and PgUp/PgDn scrolling instead.

2. **Diff rendering already exists** (Diff.tsx was built in the parallel workstream).
   We'll wire it into ToolCallBlock.

3. **Vim mode is deferred** — requires a custom input handler. We'll add basic keybinding
   customization instead.

4. **Theme switching** — already have ThemeContext + DEFAULT_THEME. We'll add `/theme`
   command and custom theme loading.

5. **Focus on what ships well**: improved input (multiline, `@`-mentions), `/help` palette
   with all commands, status line with real metrics, screen reader accessibility.

## Phases & Tasks

### Phase 1 — Input UX (2 tasks)

- [x] T9.1 Add multiline input (Shift+Enter for newline), `@`-mention file completion,
      and `!` shell command prefix in InputBar. `@path` expands to file contents.
      `!cmd` runs a shell command and inserts output.
- [x] T9.2 Wire accessibility flags: screenReader → flat rendering (no decorations),
      reducedMotion → disable animations. Test both flags.

### Phase 2 — Display UX (2 tasks)

- [x] T9.3 Wire diff rendering into ToolCallBlock — show colored diffs for Edit/Write/
      MultiEdit results using the existing theme tokens (`diffAdded`, `diffRemoved`).
      Add expand/collapse toggle (Ctrl+E already bound, wire it).
- [x] T9.4 Add auto-scroll toggle (Ctrl+S) and PgUp/PgDn scrolling in ChatPanel.
      Show turn duration in StatusLine. Add `/help` palette with all commands.

### Phase 3 — Theme & polish (2 tasks)

- [x] T9.5 Implement theme switching: `/theme dark|light|auto` command, load custom
      themes from `.book/themes/*.json`. Persist preference to settings.
- [x] T9.6 Add spinner tips, keyboard shortcut help, status line with real metrics
      (token count, turn count, mode indicator).

### Phase 4 — E2E verification (1 task)

- [x] T9.7 Full end-to-end: run interactive mode, verify all features. Run full test
      suite, tsc, build.
