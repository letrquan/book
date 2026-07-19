# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Structured `AskUserQuestion` clarification flow with a step-by-step TUI wizard, free-text answers, SDK callbacks, stream-json observability, and root/subagent source attribution.
- Claude Code-style `/effort` command with direct level selection, a dedicated keyboard picker, model capability restrictions, and project-local default persistence.
- Reference-aware compact checkpoints retain a token-budgeted exact recent tail, grounded historical constraints, task episodes, and freshness-checked file observations.
- Bounded `SessionHistorySearch` / `SessionHistoryRead` tools recover compacted-away evidence through stable current-session references.

### Changed

- Redesigned the interactive TUI with matched quiet-editorial dark/light themes, a compact BOOK bookplate, inset user cards, open assistant typography, tree-style tool activity, a floating rounded composer, and softer picker/approval surfaces.
- Compaction now replaces only active model context. The append-only transcript and chronological compact boundaries remain visible, scrollable, and resumable.
- `/context` reports visible transcript size separately from active provider context.

### Fixed

- Keep local slash-command output visible and resumable in the TUI without adding it to provider or compaction context.
- Keep the latest completed `Write`/`Edit`/`MultiEdit`/`NotebookEdit` diff visible as a bounded Claude Code-style preview, with line-background and inline word-level highlighting.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-14

First public-ready release of Book — an open-source, provider-agnostic AI coding agent CLI with a Claude Code–style terminal UI.

### Added

#### Core agent

- Agent loop with multi-turn tool use, mid-stream abort (`Esc`), and context compaction (`/compact`)
- Anthropic Messages API provider (SSE streaming, prompt caching, adaptive thinking, `--effort`)
- OpenAI-compatible provider with auto-detect from `baseUrl`, retries, and usage tracking
- BYOK provider setup and model filtering in the TUI
- Two-zone system prompt (cacheable static prefix + dynamic per-turn suffix)
- Session persistence (JSONL) with `--resume`, `--continue`, `--session-id`, `--fork-session`
- Headless/print mode (`-p`) with `text` / `json` / `stream-json` output
- Structured output via `--json-schema`
- Optional stream-json enrichments: hook events, partial messages, prompt suggestions

#### Tools

- File tools: `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `NotebookEdit`
- Shell: `Bash` with `run_in_background`, `BashOutput`, `KillShell`
- Git tools and unified diff rendering
- Web: `WebFetch`, `WebSearch`
- Task tools: `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskStop`
- Plan mode: `EnterPlanMode`, `ExitPlanMode` with host approval gate
- Skills (`InvokeSkill`) and subagent `Task` delegation
- MCP client (stdio transport)

#### Project context & memory

- CLAUDE.md / rules tree walk (user → project → local → `.claude/rules`)
- Auto-memory store under `~/.book/projects/<project>/memory/` with approval inbox
- Secret detection before memory writes
- Skills, slash commands, and subagents discovered from `.book/`

#### TUI

- Ink/React interactive UI with welcome banner and status line
- Markdown rendering (tables, code, syntax highlighting)
- Transparent tool-call display; collapse long tool output; Claude-style edit summaries
- `@file` mentions with fuzzy autocomplete (Tab / Enter)
- Slash-command palette with fuzzy search and categories
- Permission prompts with six modes and persistent allow/deny rules
- Responsive layout, Static message handoff, scrollback stability work
- Model picker and BYOK provider setup flow
- Debug instrumentation via `BOOK_DEBUG*` flags

#### CLI & config

- Layered settings: `~/.book/settings.json` → `.book/settings.json` → `.book/settings.local.json` → `--settings`
- `book doctor` and `book config` subcommands
- Built-in slash commands including `/help`, `/model`, `/config`, `/permissions`, `/memory`, `/cost`, `/usage`, `/context`, `/diff`, `/export`, `/skills`, `/review`, `/security-review`, `/release-notes`, `/feedback`, `/init`
- Permission modes: default, acceptEdits, plan, auto, dontAsk, bypassPermissions
- Optional bubblewrap sandbox and lifecycle hooks (JSON-over-stdio)

#### SDK

- Programmatic `query()` generator export for embedding Book in other tools

### Notes

- npm package name `book` is already taken on the public registry; this release is distributed via GitHub only.
- One ConPTY-based TUI integration test can flake under full parallel load on Windows; it passes in isolation.
- See [`MILESTONES.md`](./MILESTONES.md) for remaining Phase 1 parity work (LSP, more CLI flags, vim mode, etc.).

[0.1.0]: https://github.com/letrquan/book/releases/tag/v0.1.0
