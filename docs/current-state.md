# Book Current State

This is the implementation-backed product snapshot for Book as of 2026-08-04. Update this file
when a user-facing surface changes; the README is the usage guide and this page is the status
reference for roadmap and design documents.

## Release Identity

- Package version: `0.1.0` (`package.json` is still `private: true`).
- Distribution: source checkout, GitHub tag, or a locally built/link-installed CLI. There is no
  published npm package for this repository.
- License: proprietary, all rights reserved; see the README.
- Runtime: Node.js 20 or newer; CI exercises Node.js 20 and 24 on Ubuntu and Windows.
- Build: `tsup` emits ESM CLI, SDK, and job-runner bundles plus declarations into `dist/`.

## Shipped Surfaces

- Interactive Ink/React TUI, print/headless mode, JSON and stream-JSON output, session resume,
  fork, rewind, compaction, structured JSON-schema output, and prompt suggestions.
- Anthropic Messages and OpenAI-compatible providers, provider auto-detection, model discovery,
  BYOK providers, configurable effort, retries, timeouts, and token/cost accounting.
- File, patch, shell, Git, web, notebook, task, todo, plan, clarification, session-history, MCP,
  tool-search, skill, and managed-agent tools, subject to capability and permission intersections.
- MCP tools connect over stdio, Streamable HTTP, or legacy SSE. The interactive host prompts before
  using project declarations, refreshes dynamic tool lists, and exposes `/mcp` plus
  `book mcp list|get|add|remove`; print/SDK modes use only user or already-approved servers.
- Layered settings (`~/.book`, project `.book`, local `.book`, and `--settings`), atomic writes,
  legacy `.bookrc.json` migration, permissions, hooks, optional bubblewrap sandbox, themes,
  auto-memory, rewind snapshots, telemetry, and diagnostics.
- Managed explorer, patcher, and validator agents with isolated worktrees where Git is available,
  read-only non-Git exploration, evidence publication/review, completion delivery, persistence,
  ownership checks, and recovery from interrupted storage writes.
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
  configured `sandbox.failIfUnavailable` policy and may run unsandboxed.
- Managed-agent planning-task linkage, rerun, and task-aware cleanup from the background-job plan
  are not implemented; executable jobs and planning tasks remain separate.
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
  container-grade isolation remain blocked; workflow selection and evolution phases remain inactive.
  `harness.mode` accepts `off` (inert default, no filesystem effect) and `observe`, which records an
  append-only per-root evidence ledger — hash-chained canonical JSONL with a signed seal, allowlist
  redaction, drop/error counters, fail-closed eligibility, and OTel-mapped event names — without
  changing user- or provider-visible run behavior. `shadow`, `active`, and `learn` still fail
  before run setup.

## Verification

Use `npm run check` for formatting, lint, typecheck, architecture, unit, and contract checks.
Use `npm test` for the full build plus unit, contract, and integration tiers. Release validation is
`npm run release:check`; the stabilization policy is `npm run stabilization:check` with the GitHub
Actions environment variables described in [stabilization.md](stabilization.md).

Local verification for this documentation audit (2026-08-04): source formatting, lint, typecheck,
and architecture checks passed; the unit tier passed 1,694 tests with 5 skipped, and the contract
tier passed 29 tests.
