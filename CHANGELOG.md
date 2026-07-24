# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Native `rg` streaming for `Grep`, bounded `WebFetch`/`WebSearch` responses, rotating debug logs, terminal-shell TTL/cap cleanup, and the explicit `DismissShell` action.
- Repeatable `bench:runtime` coverage for snapshots, sessions, search, Grep, context construction, streaming updates, and retained resources.
- Managed-agent hardening with an outstanding spawn cap, paginated `AgentRead` result recovery, context-budgeted and idempotent completion delivery, bounded retries, per-record version-3 persistence, managed Git artifact cleanup, and per-run telemetry generations.
- Claude-style managed-agent contracts: purpose-named runs distinct from reusable profiles, durable automatic parent completion delivery, semantic lifecycle rows, a prompt-adjacent `/tasks` panel, resumable child transcripts, version-2 state migration, profile model resolution, compact lifecycle projections, advisory three-query Explore routing, actionable permission errors, multi-host runtime events, read-only non-Git Explore, and explicit third-party agent import previews.
- Claude-style inline managed-agent activity blocks: live child tool calls in the main transcript, compact `+N tool uses` overflow, bounded realtime result previews, and full-history child detail navigation.
- Provider-neutral `ToolSearch` with adaptive eager/deferred exposure, fuzzy catalog metadata, next-turn activation, MCP namespace discovery, and session-scoped LRU retention.
- A breaking ToolResult V2 contract for provider content, machine-readable data, actionable errors, metrics, artifacts, pagination, and TUI presentation. Persisted pre-V2 session results are upgraded while loading.
- Adaptive managed agents with built-in explorer/patcher/validator profiles, three-worker scheduling, resumable persisted transcripts, background lifecycle controls, and TUI/SDK/headless interfaces.
- Synthetic Git snapshots and per-agent worktrees that preserve dirty parent state, automatically commit patcher deltas, and atomically reject drift or conflicts.
- Typed evidence publishing and independent validator verdicts; `AgentApply` accepts only the exact candidate commit linked to a pass verdict.
- Named `Check` commands from `agents.checks` or standard package scripts, plus local paired evaluation metrics for `--agents off` versus `--agents adaptive`.
- Structured `AskUserQuestion` clarification flow with a step-by-step TUI wizard, free-text answers, SDK callbacks, stream-json observability, and root/subagent source attribution.
- Claude Code-style `/effort` command with direct level selection, a dedicated keyboard picker, model capability restrictions, and project-local default persistence.
- Reference-aware compact checkpoints retain a token-budgeted exact recent tail, grounded historical constraints, task episodes, and freshness-checked file observations.
- Bounded `SessionHistorySearch` / `SessionHistoryRead` tools recover compacted-away evidence through stable current-session references.
- Claude-style `/rewind` with a two-stage prompt/action picker, append-only conversation branching, content-addressed workspace checkpoints, Git HEAD drift protection, transactional rollback, and temporary storage under `--no-session-persistence`.

### Changed

- Session discovery now uses an atomic metadata index with linear JSONL replay and shared search/read indexes; rewind snapshots cache unchanged files, deduplicate manifest entry sets, and exclude workspace-local `.book/` state by default.
- Static prompt discovery, tool schema estimates, Git context, and streaming transcript projection are cached or incrementally updated, with adaptive flushing and a bounded streaming transcript window.
- Legacy permission migration runs during explicit startup, records a migration marker, skips identical settings writes, and serializes cross-process settings mutations.
- Replaced the separate Agent Center and profile tab with Claude Code's in-session task workflow: `main` and child rows below the prompt, empty-prompt Down then Enter to open a child transcript, `/tasks` for explicit management, `x` to stop or dismiss, and Esc to return.
- New sessions receive a short title from their first prompt, and the TUI shows session names instead of internal UUIDs.
- Provider visibility, system-prompt tool summaries, command/skill capabilities, role restrictions, permission modes, runtime availability, and execution now share one resolved tool surface.
- Tool schemas are closed and centrally validated; model-visible sandbox bypass, backend selection, and generic timeout controls moved back to host configuration.
- Managed agents are enabled by default in adaptive mode; use `--agents manual` for explicit-only delegation or `--agents off` for the single-agent baseline.
- Agent definition tool lists are now strict capabilities: missing/empty denies all tools, `*` explicitly inherits, argument globs are enforced at execution, and user-question/MCP/lifecycle tools are never injected implicitly.
- Redesigned the interactive TUI with matched quiet-editorial dark/light themes, a compact BOOK bookplate, inset user cards, open assistant typography, tree-style tool activity, a floating rounded composer, and softer picker/approval surfaces.
- Compaction now replaces only active model context. The append-only transcript and chronological compact boundaries remain visible, scrollable, and resumable.
- `/context` reports visible transcript size separately from active provider context.

### Security

- Managed snapshots include non-ignored untracked files in the local Git object database by default. Ignore secrets or set `agents.includeUntrackedInSnapshot` to `false` before delegation.
- Rewind snapshots intentionally include hidden, gitignored, and secret-like workspace files for complete local restoration, but keep file contents out of session JSON, logs, and model context; `.git` and workspace-local `.book/` state are excluded by default.

### Fixed

- Prevent context-window failures from oversized tool output by skipping binary `Grep` inputs, bounding search and generic tool results, preflighting complete provider requests, and compacting or clipping once before retrying recognized overflow errors.
- Apply interactive permission-mode changes immediately to the active agent loop.
- Keep mouse-wheel transcript scrolling while allowing terminal copy with Shift+drag.
- Deliver completed and failed subagent reports to the parent before automatically removing their terminal rows from the prompt-adjacent task panel.
- Prevent the first submitted TUI message from freezing during a cold rewind snapshot by yielding filesystem checkpoint work and rendering the optimistic turn first.
- Make `/theme` open a keyboard picker, apply the full app palette, persist the selection, resolve terminal auto mode correctly, and report invalid custom themes.
- Keep local slash-command output visible and resumable in the TUI without adding it to provider or compaction context.
- Add breathing room between transcript actions, keep general completed output collapsed, and show complete file-mutation diffs under Codex-style grouped file summaries with per-file collapse controls.

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
