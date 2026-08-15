# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Book — AI Coding Agent CLI

Book is a proprietary, provider-agnostic alternative to Claude Code. It provides an interactive terminal UI (TUI), print/headless mode, an SDK, and managed background execution for AI-assisted coding.

**Tech stack**: TypeScript (ES2022/ESM, `moduleResolution: bundler`), React 19 via Ink 6.8.0 for the TUI, tsup for building, Vitest 4 for testing, Zod 3 for config validation. Node.js 22.13+.

**Version**: `0.1.0` plus the unreleased changes in `CHANGELOG.md`. `docs/current-state.md` is the authoritative status snapshot, `README.md` is the usage reference, and `MILESTONES.md` tracks remaining work.

## Architecture

```
src/
  index.ts              CLI entry (Commander.js) — flags + doctor/config/tool-stats subcommands
  sdk.ts                Programmatic SDK (`query()` async generator)
  job-runner.ts         Detached runner for persistent background shell jobs
  cli/                  run.ts (interactive/headless wiring), doctor.ts, config-cmd.ts,
                        scrollback.ts, exit.ts (process.exit abstraction), utils.ts
  types/                Shared domain types (no runtime imports). NOTE: a top-level
                        src/types.ts hub is FORBIDDEN by the architecture check.
  config.ts             Config loading (env vars, settings.json, legacy .bookrc.json)
  settings*.ts          schemas, layered resolution, atomic repository writes, migration,
                        redaction, and CLI-safe configuration access
  book-home.ts          BOOK_HOME resolution for user-global state
  frontmatter.ts        Shared YAML frontmatter parser
  permissions.ts        Permission rule parsing/evaluation
  hooks.ts              Lifecycle hook runner (JSON-over-stdio contract)
  sandbox.ts            Bash sandbox via bubblewrap
  claude-md.ts          CLAUDE.md / AGENTS.md / rules tree-walk loader
  skills.ts             Multi-root SKILL.md discovery/validation and prompt catalog
  skill-registry.ts     Lazy bodies/resources, activation frames, consent, and diagnostics
  skill-watcher.ts      Debounced safe-boundary skill reload
  subagent.ts           Subagent runner
  subagent-discovery.ts Subagent discovery from .book/agents/
  mcp.ts                MCP client (stdio transport)
  headless.ts           Headless/print mode runner
  stream-json.ts        Stream-JSON event helpers
  models.ts             Model id / effort helpers
  pricing.ts            Token → USD estimates for /cost and /usage
  context-report.ts     Context window breakdown for /context
  version-info.ts       Installed version + changelog tail
  debug-log.ts          Debug logging (BOOK_DEBUG*)
  secret-detect.ts      Reject secret/unfit text before memory writes
  async.ts              Small async utilities
  memory-*.ts           memory-store.ts (file store + MEMORY.md index),
                        memory-autosave.ts (capture candidates), memory-display.ts (/memory)
  jobs/                 Background shell manager, persistent state, and restart recovery
  agent/
    loop.ts             Core agent loop (runAgentLoop)
    context.ts          System prompt builder (two-zone cache split), message formatter
    compact.ts          Context compaction logic
    tool-discovery.ts   Capability-scoped tool activation / ToolSearch gating
  agents/               Managed-agent subsystem (explorer/patcher/validator profiles):
                        manager.ts, store.ts (atomic JSON state), profiles.ts,
                        profile-resolver.ts, capabilities.ts, git-isolation.ts (worktrees),
                        check.ts, evaluation.ts, completion-notification.ts, importer.ts,
                        activity.ts, projections.ts, diagnostics.ts, naming.ts, types.ts
  review/               Host-orchestrated /review pipeline:
                        scope.ts (argument parsing), target.ts (immutable review target: base sha,
                        changed files, unified diff), prompts.ts (single/lens/security builders),
                        orchestration.ts (runSingleReview, runDeepReview, coverage), runner.ts
                        (AgentManager adapters), parse-findings.ts + json.ts (tolerant JSON),
                        verify-findings.ts (falsification pass), findings.ts (dedupe/rank/filter),
                        fix.ts (--fix through patcher/validator evidence), config.ts (REVIEW.md),
                        evaluation.ts (precision/recall harness), types.ts
  rewind/               /rewind snapshots: snapshot-store.ts, environment.ts
  input/                file-mentions.ts (@file), input-expansion.ts
  commands/
    builtins.ts         Built-in slash command catalog
    builtins-prompts.ts Prompt bodies for agent-backed commands (/init, /review, …)
    init-prompt.ts      /init prompt template
    loader.ts           Slash command discovery from user/project .book/commands/*.md
    resolve.ts          Argument parsing, variable/shell substitution, env var resolution
    filter.ts / recent.ts  Command menu filtering, recent-command helpers
  provider/
    index.ts            Provider auto-detect (anthropic vs openai-compatible)
    anthropic.ts        Anthropic Messages SSE client (caching, thinking, effort)
    openai-compatible.ts  OpenAI-compatible streaming client (SSE, retry, abort)
    model-discovery.ts  Model listing for pickers / BYOK
  session/
    store.ts            JSONL session persistence
    resolve.ts          Launch-time session resolution (--resume/--continue/…)
    lifecycle.ts        Session start/end hooks + generation guards
  tools/
    registry.ts / registry-core.ts  Tool registry (createRegistry, createDefaultRegistry)
    catalog.ts          Provider-neutral capability catalog
    tool-search.ts      ToolSearch (activate authorized tools on next turn)
    capability-rules.ts Capability intersection (command/skill/agent/mode/state)
    tool-capabilities.ts  Read-only / mutating / plan-mode capability flags
    execution-scheduler.ts  Parallel-safe wave scheduling (see conventions)
    aliases.ts          Tool name aliases (legacy → canonical)
    primary-arg.ts / path-utils.ts / glob-regex.ts / gitignore.ts / schema.ts  helpers
    file.ts             Read/Write/Edit/MultiEdit/Glob/Grep
    patch.ts            ApplyPatch (preferred source-mutation tool; Codex-style envelope)
    mutation.ts / patch-rollback  Mutation orchestration + rollback
    file-provenance.ts  File freshness tracking for compaction reuse
    shell.ts            Bash / BashOutput / KillShell (+ run_in_background)
    git.ts              Git tools
    web.ts              WebFetch / WebSearch
    todo.ts             TodoWrite
    tasks.ts            TaskCreate/List/Get/Update/Stop
    agent-tools.ts      Managed-agent lifecycle tools (AgentSpawn/Read/Wait, Check, …)
    task-tool.ts        Task (subagent) tool
    session-history.ts  Session-reference retrieval for compacted context
    plan-mode.ts        EnterPlanMode / ExitPlanMode
    ask-user-question.ts  AskUserQuestion validation + pending-request tool
    notebook.ts         NotebookEdit
    skills-tool.ts      InvokeSkill / ReadSkillResource
    diff.ts             Unified diff generator
  test/                 Shared test doubles (scripted-provider, async-event-collector)
  tui/                  Ink/React TUI (see below) — a leaf of the import graph
  tui/__benchmarks__/   ui.bench.tsx (bench:ui), runtime.bench.ts (bench:runtime)
```

The `tui/` tree (root `app.tsx`, `hooks/`, and `components/`) is broad but discoverable; browse it directly. Key entry points: `tui/app.tsx` (slash-command dispatch, overlays), `tui/hooks/useAgent.ts` (core agent state), `tui/components/ChatPanel.tsx` / `TranscriptView.tsx` (rendering).

## Key conventions

`scripts/check-architecture.ts` (run via `npm run architecture:check`, part of `npm run check`) enforces these as hard rules — a violation fails the build:

- **No `src/types.ts` hub**: shared domain types live in `src/types/*`. A top-level `types.ts` file is rejected outright.
- **No import cycles** anywhere in `src/`.
- **Entry points are never imported**: implementation modules must not import `index.ts` or `sdk.ts`.
- **`tui/` is a leaf**: non-TUI code must not import from `tui/`.
- **No blocking child-process APIs**: production code must not use `execFileSync` / `execSync` / `spawnSync`. Use async spawns.

Other conventions:

- **Shared utilities live in dedicated files**: `frontmatter.ts`, `tools/aliases.ts`, `tools/primary-arg.ts`, `tools/glob-regex.ts`, `tui/status-indicators.ts`, `tui/mode-style.ts`.
- **Module-level mutable state is eliminated**: state flows through `ToolContext`, `AgentConfig`, or explicit parameters (session task/shell maps live on config for continuity).
- **Tool names**: PascalCase (Read, Write, GitStatus, WebFetch, TaskCreate, ApplyPatch, EnterPlanMode, …). Legacy snake_case names (e.g. `apply_patch`) map to canonical names via `tools/aliases.ts` for execution only — not exposed as model-facing tools.
- **Mutation-tool preference is model-conditional**: the system prompt steers GPT/Codex-family models to `ApplyPatch` (Codex-style `*** Begin Patch` envelope) and all other models to `Edit`/`MultiEdit` (`editFormatFor()` in `src/models.ts`; per-model `editFormat` override in settings). `Write` is for full-file replacement. Edit/MultiEdit/Write-to-existing require a prior Read/mention (`file_not_observed`). See README "File mutations".
- **Tool discovery**: a practical core stays loaded; `ToolSearch` activates up to five authorized tools on the next turn, always within the current command/skill/agent-role/permission-mode/state capability intersection (`tools/capability-rules.ts`).
- **Tool execution is serial by default**; only an explicitly reviewed parallel-safe set (`Read`, `Glob`, `Grep`, `GitStatus`, `GitDiff`, `GitLog`, `GitBranch`) runs in bounded ordered waves via `tools/execution-scheduler.ts`.
- **Permission modes** (internal): `default` | `auto` | `plan` | `accept-edits` | `dontAsk` | `bypassPermissions`. CLI/settings accept `acceptEdits` and normalize to `accept-edits`.
- **System prompt**: `buildSystemPromptZones()` produces a cacheable static prefix + dynamic per-turn suffix (Anthropic prompt caching).
- **`process.exit()` goes through the `cli/exit.ts` abstraction** (allows test injection).

## Testing

Framework: Vitest, with a shared `vitest.config.ts` base and three tiers (each its own config):

- `npm run test:unit` — deterministic unit suite (`vitest.unit.config.ts`, `maxWorkers: 1`). Excludes contract tests and the process/PTY-heavy integration set.
- `npm run test:contract` — `*.contract.test.ts` only (`vitest.contract.config.ts`).
- `npm run test:integration` — the heavy PTY/process/git-isolation tests, pinned to one worker (`vitest.integration.config.ts`, `maxWorkers: 1`).
- `npm test` — runs `pretest` (a full `npm run build`) then all three tiers in sequence. Prefer a single tier while iterating; the build step makes the full run slow.

Run a single test file or name (skip the build by targeting a config directly):

```bash
npx vitest run --config vitest.unit.config.ts src/pricing.test.ts
npx vitest run --config vitest.unit.config.ts -t "redacts provider secrets"
npm run test:watch     # watch mode (base config)
```

- Tests are co-located with source (`*.test.ts` / `*.test.tsx`; contract tests are `*.contract.test.ts`).
- Use `mkdtempSync` for temp directories (cleanup via `afterEach`).
- Shared test doubles live in `src/test/` (`scripted-provider`, `async-event-collector`).

## Development

```bash
npm run typecheck          # tsc --noEmit
npm run check              # format:check + lint + typecheck + architecture:check + unit + contract
                           #   (the closest thing to a pre-commit gate)
npm run architecture:check # enforce the layering rules above
npm run lint               # ESLint (--max-warnings 0)
npm run format             # Prettier write
npm run format:check       # Prettier check
npm run build              # tsup → dist/
npm run dev                # run directly via tsx (src/index.ts)
npm run bench:ui           # TUI micro-benchmarks
npm run bench:runtime      # runtime benchmarks
```

`npm run check` is the fast gate (no integration tests, no build). Run `npm test` before a release-grade change. Release tooling: `npm run release:check` (version + audit + package smoke).

## Configuration

Settings are loaded in priority order (last wins):

1. `~/.book/settings.json` (user-global)
2. `.book/settings.json` (project)
3. `.book/settings.local.json` (local, gitignored)
4. `--settings <path>` CLI flag

Scalar values take the highest-priority layer. Permission rules, hook lists, and `additionalDirectories` accumulate across layers; other arrays are replaced by the highest layer that defines them. Legacy `.bookrc.json` is still supported but deprecated. `--no-settings` skips all `settings.json` layers. Local writes are atomic and validate the whole document before replacing the file.

Env overrides commonly used in development: `BOOK_API_KEY`, `BOOK_BASE_URL`, `BOOK_MODEL`, `BOOK_COMPACT_MODEL`, `BOOK_PROVIDER`, `BOOK_EFFORT`, `BOOK_HOME`, `BOOK_WORKSPACE`, `BOOK_TUI_RENDERER`, and `BOOK_DEBUG*`.

## Notable product surfaces (keep docs in sync)

When changing these, update `README.md` / `CHANGELOG.md` / `MILESTONES.md` as appropriate:

- CLI flags and subcommands in `src/index.ts` + `src/cli/`
- Built-in slash commands in `src/commands/builtins.ts` (+ dispatch in `src/tui/app.tsx`)
- Default tool set in `src/tools/registry.ts` `createDefaultRegistry()`
- Permission modes: `PermissionMode` in `src/types/runtime.ts`
- Memory paths and approval flow in `src/memory-store.ts` / `src/memory-autosave.ts`
- Managed-agent behavior in `src/agents/` (README "Managed agents" is the detailed spec)
- `/review` pipeline behavior in `src/review/` (README "Code review" is the detailed spec). The
  review target is resolved by the host, never by the reviewer — reviewer agents have no diff tool,
  so prompt builders require a `ReviewTarget`.
- Background shell behavior in `src/jobs/` and `src/job-runner.ts`
- Skill behavior in `src/skills.ts`, `src/skill-registry.ts`, and `src/tools/skills-tool.ts`

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `letrquan/book` using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Domain documentation uses the single-context layout: `CONTEXT.md` and `docs/adr/` at the repository root. See `docs/agents/domain.md`.
