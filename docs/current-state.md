# Book Current State

This is the implementation-backed product snapshot for Book as of 2026-08-04. Update this file
when a user-facing surface changes; the README is the usage guide and this page is the status
reference for roadmap and design documents.

## Release Identity

- Package version: `0.1.0` (`package.json` is still `private: true`).
- Distribution: source checkout, GitHub tag, or a locally built/link-installed CLI. There is no
  published npm package for this repository.
- License: proprietary, all rights reserved; see the README.
- Runtime: Node.js 22.13 or newer; CI exercises Node.js 22 and 24 on Ubuntu and Windows.
- Build: `tsup` emits ESM CLI, SDK, and job-runner bundles plus declarations into `dist/`.

## Shipped Surfaces

- Interactive Ink/React TUI, print/headless mode, JSON and stream-JSON output, session resume,
  fork, rewind, compaction, structured JSON-schema output, and prompt suggestions.
- Anthropic Messages and OpenAI-compatible providers, provider auto-detection, model discovery,
  BYOK providers, configurable effort, retries, timeouts, and token/cost accounting.
- System prompt v2 (`book-system-prompt-v2`): content split by volatility across a cached static
  prefix, an uncached activation-class suffix, and a per-turn `<session-state>` block on the newest
  user turn; project instructions fenced and trust-labeled; three Anthropic cache breakpoints
  (last tool, system, moving last message) so the conversation itself is cached.
- File, patch, shell, Git, web, notebook, task, todo, plan, clarification, session-history, MCP,
  tool-search, skill, and managed-agent tools, subject to capability and permission intersections.
- MCP tools connect over stdio, Streamable HTTP, or legacy SSE. The interactive host prompts before
  using project declarations, refreshes dynamic tool lists, and exposes `/mcp` plus
  `book mcp list|get|add|remove`; print/SDK modes use only user or already-approved servers.
- Layered settings (`~/.book`, project `.book`, local `.book`, and `--settings`), atomic writes,
  legacy `.bookrc.json` migration, permissions, hooks, optional bubblewrap sandbox, themes,
  auto-memory, rewind snapshots, telemetry, and diagnostics.
- Managed explorer, reviewer, patcher, and validator agents with isolated worktrees where Git is
  available, read-only non-Git exploration, evidence publication/review, completion delivery,
  persistence, ownership checks, and recovery from interrupted storage writes.
- Host-orchestrated `/review` over an immutable review target, with `--base`, path and
  `<base>...<head>` scoping, parallel specialized lenses under `--deep`, an independent
  falsification pass, coverage that fails closed, `REVIEW.md` calibration, evidence-gated `--fix`,
  and `npm run eval:review`.
- Background shell jobs with session or explicit persistent lifetime, `/jobs` management, output
  inspection, stop/dismiss, restart reattachment, and SDK/stream-JSON lifecycle events.
- Metadata-first interoperable skills from `.claude/skills`, `.agents/skills`,
  `.opencode/skills`, and `.book/skills`, with explicit activation, consent, resource bounds,
  capability intersections, lifecycle diagnostics, safe-boundary reload, and `npm run eval:skills`.

## Current Defaults

- Managed agents: `adaptive`; use `--agents manual` or `--agents off` for explicit-only or
  single-agent runs.
- Permission mode: `default` unless settings or `--permission-mode` selects another mode.
- Tool discovery: `auto`; the practical core stays loaded and `ToolSearch` activates deferred
  authorized tools on the next turn.
- Tool execution: serial by default; only the reviewed read-only/Git set is scheduled in bounded
  waves (`toolExecution.maxConcurrent`, default `4`).
- Skills: discovered skills start in `manual` activation mode. Enable `auto` per skill only after
  representative evaluation.
- TUI renderer: `safe` on Windows, `incremental` on other interactive terminals. Windows users can
  opt into incremental rendering with `BOOK_TUI_RENDERER=incremental`.
- Web access: HTTPS and public destinations by default; HTTP and private-network exceptions require
  explicit environment opt-ins.

## Known Boundaries

- Project MCP declarations now have an explicit per-server trust boundary: repository-controlled
  servers are fingerprinted and require one-time approval before connection. A broader workspace
  trust database does not exist yet, so project settings, hooks, provider blocks, custom command
  shell substitutions, and project instructions must still be reviewed before opening an untrusted
  workspace.
- Bubblewrap is optional and currently Linux-oriented; when unavailable, behavior follows the
  configured `sandbox.failIfUnavailable` policy and may run unsandboxed. Where it is available the
  boundary is real: sandboxed commands are spawned as a direct argument vector rather than a shell
  string, so no host shell parses the command, and declared `sandbox.filesystem` mounts are
  applied. `sandbox.network` domain rules cannot be expressed in bubblewrap and fail closed to no
  network rather than to the full host network. macOS `sandbox-exec` and a Windows equivalent are
  not implemented.
- Managed-agent planning-task linkage, rerun, and task-aware cleanup from the background-job plan
  are not implemented; executable jobs and planning tasks remain separate.
- `/review` is TUI-only: the `review` command effect is handled in `src/tui/app.tsx`, so
  print/headless hosts cannot run it. Its evaluation harness scores reports captured from real runs
  rather than executing the pipeline over checked-in golden diffs. The confidence threshold (70) and
  the per-pass timeout (10 minutes) are fixed rather than configurable.
- The adaptive-harness roadmap is not a live learning system. Tier A/B attribution, accounting, and
  evaluator preconditions are verified for trusted built-in, single-agent evaluation, but Phase 0
  remains inactive until a dedicated status change. The edit-reliability, compaction, and skill
  evaluation entry points use that boundary with bounded process-tree teardown; provider-backed
  evaluations receive generated settings that retain effective provider model IDs, model metadata,
  and retry policy without writing resolved secrets to settings. Edit trials also retain
  provider-option explicitness, while compaction keeps its predeclared benchmark output limits.
  Ambient snapshot schema version 2 records a bounded content identity for isolated evaluation
  Book homes, fingerprints effective command and skill registries, and normalizes disposable paths
  and evaluation IDs across otherwise equivalent arms. Evaluator reports retain runner-owned date,
  seed, runtime, and fixture identities; provider-backed edit/compaction success is rejected when
  run evidence is ineligible, and compact paired probes reject mismatched ambient/pricing/budget/
  resolved-model identities, while offline skill observation marks provider eligibility as not
  applicable. Tier C project-controlled execution, workspace trust, permission ceilings, and
  container-grade isolation remain blocked; automatic workflow selection and evolution phases remain
  inactive.
  `harness.mode` accepts `off` (inert default, no filesystem effect) and `observe`, which records an
  append-only per-root evidence ledger — hash-chained canonical JSONL with a signed seal, allowlist
  redaction, drop/error counters, fail-closed eligibility, and OTel-mapped event names — without
  changing user- or provider-visible run behavior. `shadow`, `active`, and `learn` still fail
  before run setup.
- Under `observe`, a run may use one of three built-in execution workflows selected manually through
  `harness.workflow` (settings) or `--harness-workflow` (run-scoped, not persisted, does not survive
  resume). `minimal` renders no prompt text and leaves provider messages byte-identical to a run with
  no harness; `safe-edit` and `verify-heavy` add bounded guidance to the dynamic prompt zone only.
  Nothing in the workflow surface is enforced: permissions, sandboxing, budgets, retries, compaction,
  checkpoint/resume, and tool contracts stay host-owned, unsupported requests are clamped and
  recorded as `capability_clamped` evidence, and a definition's free-form description is never
  rendered as an instruction. Each run records the requested and effective workflow, source, reason,
  registry and definition digests, override scope, and declared complexity. Selection fails closed at
  `book config set`, at config load, at the CLI flag, and at the session run boundary when the
  harness is `off` or the ID is unknown or path-like. Project-defined workflow files are not loaded,
  and there is still no automatic or learned selection.

## Verification

Use `npm run check` for formatting, lint, typecheck, architecture, unit, and contract checks.
Use `npm test` for the full build plus unit, contract, and integration tiers. Release validation is
`npm run release:check`; the stabilization policy is `npm run stabilization:check` with the GitHub
Actions environment variables described in [stabilization.md](stabilization.md).

Local verification for this documentation audit (2026-08-04): source formatting, lint, typecheck,
and architecture checks passed; the unit tier passed 1,694 tests with 5 skipped, and the contract
tier passed 29 tests.
