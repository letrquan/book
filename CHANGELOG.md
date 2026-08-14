# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- The CLI now defaults `NODE_ENV` to `production` before React loads, so the TUI renders with
  production React instead of the 2-3x slower development build (an explicitly set `NODE_ENV`
  still wins). `npm run bench:ui` measures production mode to match. Combined with new render-path
  caching — a revision-stable transcript viewport snapshot, per-message row-estimate reuse in the
  virtualized transcript, a stable streaming timeline identity, memoized layout-revision hashing,
  and fast paths in `displayWidth` — long-transcript streaming updates and unrelated managed-trace
  updates render 3-4x faster and back inside their latency budgets.
- Background shells and long-running Bash commands no longer make the TUI sluggish. Shell output
  events are coalesced to a 250ms refresh and the shell list bails out when nothing it renders has
  changed, so raw stdout/stderr chunk frequency no longer drives full App re-renders and Yoga
  layout passes. The shell detail view reads its output tail in a polling effect instead of doing
  synchronous file I/O inside App's render. Running tool rows tick their elapsed time once per
  second (previously 10x/s) with second granularity, and stop ticking entirely under reduced
  motion. Large tool-output previews measure bytes with one call over the whole output instead of
  allocating a Buffer measurement per line, and the markdown sniff over expanded output is
  memoized.
- Managed children now publish and review evidence through their owning agent manager instead of
  being rejected as owned by another live Book process.
- Provider-emitted `parent:`, `default:`, and `tool:` wrappers resolve to an existing registered
  tool, and `glob_files` resolves to `Glob`; unrelated namespaced commands remain rejected.
- Vitest runs no longer append synthetic tool calls to the user-global `book tool-stats` history.
- Windows now defaults to the full-frame TUI renderer so deep transcript scrolling cannot corrupt
  or erase the fixed input and status footer. Incremental rendering remains available through an
  explicit `BOOK_TUI_RENDERER=incremental` override.
- Mouse-wheel scrolling now reaches conversation history when the Windows CLI runs from WSL,
  instead of being translated into Up/Down prompt-history navigation by the outer terminal.
- Stopping a background job on Linux and macOS no longer records `killed` while the job's processes
  keep running. Background commands run through `sh -c`, which forks the real worker, so the shell
  wrapper dies from SIGTERM even when the worker ignores it — and both the persistent job runner
  and the session-lifetime shell manager read that wrapper's exit as proof the tree had gone, so
  they never escalated to SIGKILL. Termination now escalates and reports success based on whether
  the job's process group still holds a process, so an orphaned worker can no longer keep ports,
  file handles, and CPU behind a terminal `killed` record. Windows already terminated the tree
  through `taskkill /T /F` and is unchanged.

### Added

- Experimental execution workflows for the observe-mode harness. `harness.workflow` (settings) and
  `--harness-workflow <id>` (run-scoped) select one of three validated built-ins — `minimal`,
  `safe-edit`, and `verify-heavy` — from a hashed registry. `minimal` renders no prompt text and
  leaves provider messages byte-identical to a run with no harness. Workflows are bounded guidance
  only: permissions, sandboxing, budgets, retries, compaction, checkpoint/resume, and tool contracts
  remain host-owned, unsupported requests are clamped and recorded as `capability_clamped` evidence,
  and a definition's free-form description is never rendered as an instruction. Every run records the
  requested and effective workflow, source, reason, registry/definition digests, override scope, and
  declared complexity. Selection fails closed — a workflow chosen while `harness.mode` is `off`, an
  unknown ID, or a path-like ID is rejected by `book config set` and at startup rather than silently
  ignored. Project-defined workflow files are not loaded.
- MCP servers can now prompt the user mid-tool-call through form elicitation. The TUI renders the
  requested fields — text, number, yes/no, and filterable choice lists — labelled with the server
  that asked, and returns the answer inside the open call; declining or cancelling answers the
  server instead of leaving it waiting. The elicitation capability is declared only when a host can
  actually prompt, so headless and SDK runs (unless they pass `onElicit`) leave servers to fail such
  requests themselves rather than block. Answers are validated against the requested schema before
  they are sent, and requests Book cannot render faithfully — URL mode, or schemas outside the
  protocol's primitive subset — are declined.
- MCP now uses the official protocol SDK and works in the interactive TUI as well as print and SDK
  runs. It supports stdio, Streamable HTTP, and legacy SSE servers; content blocks, structured
  errors, cancellation, pagination, negotiated metadata, dynamic `tools/list_changed` refresh,
  bounded diagnostics, and graceful remote-session termination. Project `.mcp.json` servers require
  fingerprinted one-time approval, while `/mcp`, `book mcp list|get|add|remove`, `book doctor`, and
  server-scoped permission rules (`mcp__server`) expose and control the resulting surface without
  printing header or environment secrets.
- `harness.mode: observe` now records an append-only run-evidence ledger without changing run
  behavior. Every root user request gets one canonical JSONL stream under
  `BOOK_HOME/projects/<workspace-id>/harness/v1/runs/`, written by a single writer with canonical
  JSON records, a SHA-256 previous-record hash chain, and a signed terminal seal that reports
  durability, drop/error counters, and fail-closed evidence eligibility. Persisted events pass an
  allowlist redaction policy (no prompts, tool arguments or output, file paths, commands, URLs, or
  secrets); turn, tool, usage, retry, stall, permission, and managed-agent handoff facts are
  captured as bounded scalars with OpenTelemetry-mapped names pinned to Semantic Conventions
  v1.44.0. Headless multi-turn runs defer each root seal until linked continuation turns finish;
  managed continuations join the originating root stream as explicit child runs. Retention cleanup
  honors evidence pins, truncated or tampered streams read as inspectable-but-incomplete, and
  `off` remains the inert default with no filesystem effect.
- New empty startup sessions now open with an optional full-screen magical fire sequence that
  burns into the Book welcome. It is deterministic, skippable with Esc or typing, automatically
  bypassed for reduced-motion and screen-reader modes, and configurable through `/config` or
  `ui.startupAnimation`.
- Adaptive-harness evaluations now have a reusable external-process runner that provisions fresh
  workspace, `BOOK_HOME`, user-config, cache, and temporary directories; copies only explicitly
  allowlisted ambient variables; bounds captured output; and distinguishes failure, timeout,
  cancellation, and spawn errors. Timeout and cancellation terminate the evaluator process tree
  with bounded graceful and forced teardown. This is a reproducibility boundary for trusted
  built-in fixtures, not a security sandbox for project-controlled commands. `npm run eval:edit`
  now runs every trial through this boundary with managed agents disabled and generated isolated
  settings that preserve the resolved provider-facing model ID, model metadata, retry policy, and
  whether output-token and reasoning-effort options were explicitly configured. The provider-backed
  `npm run eval:compact` benchmark now uses the same isolated settings and secret references, and
  `npm run eval:skills` parses its observation corpus in a bounded disposable worker. Ambient run
  snapshots now use schema version 2 to identify isolated evaluation Book-home contents with a
  bounded secret-safe digest while normalizing evaluator-owned temporary paths and run IDs. The
  same snapshot now fingerprints effective command and skill registries from content digests
  without retaining command or skill bodies. The runner now owns and reports prompt date, random
  seed, exact dirty/untracked runtime revision, and materialized-fixture revision. Provider-backed
  edit and compaction evaluations fail closed unless terminal, ambient, accounting, usage, pricing,
  model identity, Book-home isolation, and single-agent run-boundary evidence are eligible;
  paired compact comparisons also reject mismatched ambient, pricing, budget, or resolved-model
  identities; compact reports use schema version 3 and evaluator workers reject stale or malformed
  report shapes;
  compaction includes reducer calls and treats retried or usage-less attempts as partial evidence.
  Offline skill-observation reports explicitly mark provider-run eligibility as not applicable while
  retaining the same runner controls. These changes make Tier A/B ready for trusted built-in Phase 0
  work without admitting Tier C project-controlled or adversarial execution.
- Architecture checks now keep offline harness evaluation code out of the live agent runtime,
  prevent evaluators from importing live execution modules, and keep permission/sandbox kernel
  modules independent from harness policy.
- `BOOK_HOME` can now relocate Book's user-global state from `~/.book`, including settings,
  sessions, memory, managed-agent state, jobs, rewind snapshots, telemetry, tool output, MCP
  configuration, and user-level discovery. Project-local `.book/` state remains unchanged.
- `/skills` now opens a keyboard-driven skill manager with Codex/Claude Code-inspired
  visibility controls (`auto`, `name-only`, `manual`, and `off`), explicit-use handoff,
  scope/path details, reload support, and a matching entry in `/config`.
- Skills now use metadata-first `SKILL.md` discovery with portable `.agents/skills` compatibility,
  `.claude/skills` and OpenCode roots, lazy bodies/resources, scoped tool intersections, consent
  policies, lifecycle diagnostics, and debounced safe-boundary reloads. Existing `.book/skills`
  packages continue to work; third-party skills can be migrated by placing the same package under
  `.agents/skills/<name>/`. `/skills status` provides a body-free runtime report with catalog and
  prompt-omission diagnostics, active frames, effective tools, validation failures, and recent
  lifecycle outcomes. Conflicting skill restrictions now fail visibly instead of activating an
  empty tool surface, resource reads verify content digests against post-discovery substitution,
  and `npm run eval:skills` gates implicit rollout using privacy-safe activation metrics. Newly
  discovered skills default to explicit/manual use until that evaluation supports enabling `auto`.

- Unified `/jobs` TUI management for managed agents and background shell jobs, with `/tasks` kept
  as an alias. Background shells support session or explicit persistent lifetimes, bounded output,
  optional parent-agent completion delivery, restart reattachment, stop/dismiss controls, and SDK/
  stream-json lifecycle events. Finished and stopped shell rows leave the active UI automatically
  while a one-time completion notice remains available.

- Streaming assistant responses now use the same Markdown layout as completed replies while
  keeping a bounded, throttled live tail for responsive rendering of large outputs.

- `/config` now opens a visual settings menu for model, effort, theme, memory capture, and
  subagent profile models. Explorer, patcher, validator, and custom profiles can select an
  existing configured model or reset to parent-model inheritance without editing JSON.

- `AskUserQuestion` now explicitly advertises single- and multi-select questions to models.

- Added terminal-screen regression coverage and made patched Ink incremental rendering the default
  interactive mode through `BOOK_TUI_RENDERER`. The stable full-frame renderer remains available
  as `BOOK_TUI_RENDERER=safe`, while active TUI animations share pausable clocks to reduce render
  churn.

- Persistent tool-use telemetry and a `book tool-stats` subcommand for measuring tool use across
  sessions. Each finalized tool call appends one JSON line to `~/.book/telemetry/tool-use.jsonl`
  (best-effort, off the hot path, size-rotated; captured at the final-status point so plan/user
  mutations are reflected), recording the tool, status, a derived `isFailure` flag (only `error`/
  `timed_out` — blocks/cancellations never count), error code, duration, retries, model, and
  subagent attribution. `book tool-stats` reports per-tool calls/fail rate/p50/p95/retry rate, a
  per-model split, and top error codes (`--json`, `--since <days>`, `--all`, `--prune`). Gated by
  `observability.toolTelemetry` (default on) with `observability.toolTelemetryRetentionDays` as the
  reporting/prune window. Separate from the ephemeral in-session counters in `/usage`.

- Fresh-context plan handoff: an "Approve, fresh context" option (shortcut `F`) at the plan-approval
  prompt stops the planning turn and starts a new conversation seeded with only the approved plan —
  the implementation runs with a clean context window, like Codex/Claude Code handoff.
- Model-conditional mutation guidance: the system prompt recommends `ApplyPatch` to GPT/Codex-family
  models (known picker models resolve by provider metadata) and exact-replace `Edit`/`MultiEdit` to
  everything else, with a per-model `editFormat` (`patch` | `replace` | `whole`) settings override
  under `provider.<name>.models.<id>`. In plan mode the guidance instead directs the model to
  explore read-only and call `ExitPlanMode`.
- Cross-harness tool-argument aliases, declared on each tool definition: Claude Code-style
  spellings (`file_path`, `old_string`, `new_string`, `replace_all`, nested MultiEdit `edits[]`
  keys, Grep `glob`/`-A`/`-B`/`-C`, ApplyPatch `input`) normalize to canonical arguments before
  hook and permission evaluation — aliased spellings cannot bypass path-scoped permission rules —
  and `invalid_arguments` errors list the allowed argument names.
- Grep `path` (directory or file scope) and `C` (symmetric context) parameters on both the native
  `rg` and portable backends; scoped portable searches still honor root-anchored `.gitignore`
  patterns.
- Whitespace-tolerant Edit/MultiEdit recovery: trailing-whitespace and uniform-indent-shift
  relaxations apply only on a unique match, re-indent the replacement (rejecting matches whose
  replacement cannot shift consistently), annotate the result, never apply to `replaceAll`, and
  yield to the event loop with abort support on large files.
- An advisory identical-retry circuit breaker that appends escalated guidance to the tool's own
  remediation when a call repeats with the same arguments and error (retryable transient failures
  exempt), plus structured remediation now rendered into model-facing error text as `Fix:` lines —
  preserved even when oversized errors are clipped.
- Per-session tool call/failure counters surfaced in `/usage` (text report and TUI card, with
  totals and failing tools listed first). Only real errors and timeouts count as failures; user
  denials, plan-mode blocks, and cancellations do not.
- `npm run eval:edit` — a deterministic edit-reliability eval (~25 fixture tasks) run against the
  configured model via the SDK, reporting per-task results to `.book/reports/`.
- Bounded, session-wide concurrent execution for explicitly reviewed read-only file and Git tools,
  with ordered serial barriers, all-settled sibling results, duplicate-call rejection, and shared
  root/managed-child scheduling.
- Codex-style `AGENTS.md` project-instruction discovery alongside the existing Claude-style
  `CLAUDE.md` and `.claude/rules` loader.
- Resilient managed-agent persistence with fsynced atomic writes, bounded Windows contention
  retries, per-target locks, process leases, orphan-temp recovery, background coalescing, typed
  retryable tool failures, and non-modal degraded/recovered storage events.
- A clear 30-day local retention policy for expired sessions and rotated debug logs; the active
  session and current debug log are always preserved.
- Canonical `ApplyPatch` file mutation with exact contextual hunks, LF/CRLF and BOM preservation,
  multi-file staging, atomic verification, rollback, per-file artifacts, legacy permission/hook
  compatibility, and the `apply_patch` provider alias.
- Native `rg` streaming for `Grep`, bounded `WebFetch`/`WebSearch` responses, rotating debug logs, terminal-shell TTL/cap cleanup, and the explicit `DismissShell` action.
- Claude Code-style queued follow-up input: Enter queues while a turn is running, Up recalls the newest queued message, Enter resubmits edits, and Esc cancels queue editing without interrupting the active turn.
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

- Detailed tool rows now keep raw call parameter lists out of both visual and screen-reader
  transcripts while retaining concise summaries and result output.
- Documentation now reflects the current proprietary/source-distributed package status, shipped
  CLI and runtime surfaces, open security boundaries, and implementation status of historical
  roadmap documents.
- `WebFetch` now returns structured provenance and Markdown/text/sanitized-HTML formats, uses a
  real HTML parser, preserves bounded complete output through the shared tool-output path, rejects
  binary content, and treats its legacy `prompt` argument as metadata instead of claiming to
  perform extraction. `WebSearch` now works without configuration through a built-in Exa MCP
  provider with a fixed endpoint, bounded responses, and result/domain/recency/country controls.
- Web tools are explicitly parallel-safe but remain permission-gated network operations, including
  in plan mode. Remembered fetch approval is scoped to the URL origin; cross-origin redirects must
  be fetched as a separately approved call.
- Improved TUI streaming responsiveness by batching first-turn updates at a sustainable cadence,
  avoiding idle accumulator wakeups, and limiting the active transcript window to the available
  terminal height while output is streaming. Live Markdown now uses a bounded plain-text tail and
  defers full decoration until completion.
- Smoothed mouse-wheel history navigation with three-row wheel steps, low-latency event-loop
  coalescing, isolated transcript content, and support for coalesced terminal reports.
- Reduced managed-agent render fan-out, bounded completed transcript hydration with keyboard/mouse
  history expansion, accelerated terminal-width measurement, and batched noisy render diagnostics.

- BYOK providers and the active model selection now persist to the user-global `~/.book/settings.json`
  instead of the per-project `.book/settings.local.json`, so a provider added in one folder (its
  credentials, model catalog, and default model) is shared across every project rather than
  re-entered per folder. Provider removal (`Alt+D` in `/model` / `/providers`) targets the global
  file, and removable rows are labeled `[BYOK]` (previously `[local BYOK]`). Saving a model or
  provider also clears any stale same-key override from the current folder's
  `.book/settings.local.json` (which would otherwise shadow the new global value), so an
  already-used folder picks up the global choice immediately. Existing per-project provider entries
  are still read via the layered resolver but are no longer managed from the picker.
- **Breaking:** `Edit`/`MultiEdit`/`NotebookEdit` — and `Write` over an existing file — now require
  the file to have been Read or `@`-mentioned in the session first (`file_not_observed`);
  previously only staleness after an observation was checked. `ApplyPatch` is exempt (context
  hunks self-anchor), contexts without an observation ledger are unaffected, observation keys are
  case-folded on Windows, and child agents inherit a copy of the parent's observations.
- `ApplyPatch` is no longer described as the universally preferred mutation tool; the preference is
  model-conditional (see Added) and tool descriptions are neutral.
- Tool concurrency is now an explicit policy rather than an idempotence side effect; preparation,
  hooks, permission prompts, interactive tools, mutations, shell commands, and lifecycle actions
  remain serial by default.
- Strengthened the stable agent system prompt with end-to-end persistence, evidence-first tool
  use, failed-call recovery, tighter scope control, behavior-level verification, final diff review,
  and explicit authorization scope.
- Session discovery now uses an atomic metadata index with linear JSONL replay and shared search/read indexes; rewind snapshots cache unchanged files, deduplicate manifest entry sets, and exclude workspace-local `.book/` state by default.
- Static prompt discovery, tool schema estimates, Git context, and streaming transcript projection are cached or incrementally updated, with adaptive flushing and a bounded streaming transcript window.
- Legacy permission migration runs during explicit startup, records a migration marker, skips identical settings writes, and serializes cross-process settings mutations.
- Replaced the separate Agent Center and profile tab with Claude Code's in-session task workflow: a flat `main`-plus-children panel below the prompt, empty-prompt Tab to cycle focus straight into each child's transcript (wrapping back to `main`), `/tasks` for explicit management, `x` to stop or dismiss, and Esc to return.
- New sessions receive a short title from their first prompt, and the TUI shows session names instead of internal UUIDs.
- Provider visibility, system-prompt tool summaries, command/skill capabilities, role restrictions, permission modes, runtime availability, and execution now share one resolved tool surface.
- Tool schemas are closed and centrally validated; model-visible sandbox bypass, backend selection, and generic timeout controls moved back to host configuration.
- Managed agents are enabled by default in adaptive mode; use `--agents manual` for explicit-only delegation or `--agents off` for the single-agent baseline.
- Agent definition tool lists are now strict capabilities: missing/empty denies all tools, `*` explicitly inherits, argument globs are enforced at execution, and user-question/MCP/lifecycle tools are never injected implicitly.
- Redesigned the interactive TUI with matched quiet-editorial dark/light themes, a compact BOOK bookplate, inset user cards, open assistant typography, tree-style tool activity, a floating rounded composer, and softer picker/approval surfaces.
- Compaction now replaces only active model context. The append-only transcript and chronological compact boundaries remain visible, scrollable, and resumable.
- `/context` reports visible transcript size separately from active provider context.

### Security

- Hardened `WebFetch` against SSRF and DNS rebinding by requiring HTTPS unless explicitly enabled,
  rejecting embedded credentials and local/private/special-use destinations, validating every DNS
  result again at connection time, manually bounding redirects, and refusing cross-origin redirect
  hops. Dangerous HTTP/private-network exceptions require explicit host environment opt-in.
- Managed snapshots include non-ignored untracked files in the local Git object database by default. Ignore secrets or set `agents.includeUntrackedInSnapshot` to `false` before delegation.
- Rewind snapshots intentionally include hidden, gitignored, and secret-like workspace files for complete local restoration, but keep file contents out of session JSON, logs, and model context; `.git` and workspace-local `.book/` state are excluded by default.

### Fixed

- Show a lightweight placeholder (or the live stream) instead of the main welcome screen when opening a child transcript that has not produced output yet.
- Queue concurrent permission requests instead of superseding earlier prompts, propagate
  cancellation into foreground shell processes, and give aborted tools a bounded cooperative
  teardown window before releasing their execution slot.
- Use a 64,000-token output fallback for models without published output metadata instead of consuming the entire fallback context window.
- Prevent context-window failures from oversized tool output by skipping binary `Grep` inputs, bounding search and generic tool results, preflighting complete provider requests, and compacting or clipping once before retrying recognized overflow errors.
- Apply interactive permission-mode changes immediately to the active agent loop.
- Keep mouse-wheel transcript scrolling while allowing terminal copy with Shift+drag.
- Reconcile transcript height after descendant-local updates so throttled Markdown remains reachable
  without restoring per-wheel full-content measurement.
- Deliver completed and failed subagent reports to the parent before automatically removing their terminal rows from the prompt-adjacent task panel.
- Prevent the first submitted TUI message from freezing during a cold rewind snapshot by yielding filesystem checkpoint work and rendering the optimistic turn first.
- Make `/theme` open a keyboard picker, apply the full app palette, persist the selection, resolve terminal auto mode correctly, and report invalid custom themes.
- Keep local slash-command output visible and resumable in the TUI without adding it to provider or compaction context.
- Add breathing room between transcript actions, keep general completed output collapsed, and show complete file-mutation diffs under Codex-style grouped file summaries with per-file collapse controls.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-14

First public-ready release of Book, a provider-agnostic AI coding agent CLI with a Claude Code-style terminal UI.

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
