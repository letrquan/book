# Book Current State

This is the implementation-backed product snapshot for Book as of 2026-08-24. Update this file
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
  fork, rewind, compaction with a selectable `summary` or `zero-mem` strategy, structured
  JSON-schema output, and prompt suggestions. `zero-mem` writes no summary checkpoints: it disables
  auto-compaction and retrieves query-specific evidence from the original transcript each turn.
- Print/headless and SDK hosts resolve a leading `/command` through the same registries,
  substitutions, and `allowed-tools`/`model` frontmatter enforcement as the TUI, perform the
  commands a non-interactive host can honestly perform, and refuse the rest before their own code
  runs. Plan mode works there too: `bypassPermissions` approves, a supplied `onUserQuestionRequired`
  handler decides, and a host with neither ends the run with the plan as its deliverable instead of
  rejecting and re-planning until the turn budget is gone.
- Anthropic Messages and OpenAI-compatible providers, provider auto-detection, model discovery,
  BYOK providers, configurable effort, retries, timeouts, and token/cost accounting.
- System prompt v2 (`book-system-prompt-v2`): content split by volatility across a cached static
  prefix, an uncached activation-class suffix, and a per-turn `<session-state>` block on the newest
  user turn; project instructions fenced and trust-labeled; three Anthropic cache breakpoints
  (last tool, system, moving last message) so the conversation itself is cached.
- File, patch, shell, Git, web, notebook, task, todo, plan, clarification, session-history, MCP,
  tool-search, skill, and managed-agent tools, subject to capability and permission intersections.
- MCP tools connect over stdio, Streamable HTTP, or legacy SSE. The interactive host prompts before
  using project declarations, answers server form elicitation, refreshes dynamic tool lists, and
  exposes `/mcp` plus `book mcp list|get|add|remove`; print/SDK modes use only user or
  already-approved servers, and `connectMcpServers()` itself refuses project-declared servers when
  a caller supplies no approved list, so the gate does not depend on each caller remembering it and declare the elicitation capability only when the caller supplies a
  handler. Elicitation requests Book cannot render faithfully — URL mode, or schemas outside the
  protocol's primitive subset — are declined. Permission rules scope to a server: a bare
  `mcp__<server>` rule covers every tool that server exposes, while `mcp__<server>__<tool>` stays
  exact.
- Layered settings (`~/.book`, project `.book`, local `.book`, and `--settings`), atomic writes,
  legacy `.bookrc.json` fallback and legacy-permissions migration, permissions whose `deny` rules
  bind in every permission mode, project-declared `permissions.allow` rules held until the user
  approves them (`ask`/`deny` apply immediately; `book doctor` reports what is withheld and how
  to grant it), trust-decision keys ignored from the checked-in project layer so a repository
  cannot approve its own MCP servers or allow rules, hooks, optional bubblewrap sandbox, themes, auto-memory, rewind
  snapshots, telemetry, and diagnostics. Every declared sandbox key is now read by an execution or
  permission path: `sandbox.allowUnsandboxedCommands` can refuse any command that would leave the
  namespace, and `sandbox.autoAllowBashIfSandboxed` can replace the default ask for a command that
  genuinely stays inside it. `book doctor` reports each MCP server with its resolved trust state,
  the sandbox policy actually being enforced — including the effective, not merely configured,
  state of those two keys — and managed-agent diagnostics.
- Managed explorer, reviewer, patcher, and validator agents with isolated worktrees where Git is
  available, read-only non-Git exploration, evidence publication/review, completion delivery,
  persistence, ownership checks, and recovery from interrupted storage writes. The built-in
  `reviewer` profile is reserved: a same-named user or project definition cannot replace its role,
  tools, isolation, or body — only model and effort tuning applies — and the suppressed definition
  is reported by `book doctor` with the layer it came from.
- Host-orchestrated `/review` over an immutable review target, with `--base`, path and
  `<base>...<head>` scoping, parallel specialized lenses under `--deep`, an independent
  falsification pass, coverage that fails closed, `REVIEW.md` calibration, evidence-gated `--fix`,
  and `npm run eval:review`. The sequencing is shared by the TUI and by print/headless/SDK hosts,
  which also emit the report as a stable machine projection (verdict, target, verbatim findings,
  and the pipeline's own coverage) under `json` and `stream-json`.
- Background shell jobs with session or explicit persistent lifetime, `/jobs` management, output
  inspection, stop/dismiss, restart reattachment in the interactive TUI, and SDK/stream-JSON
  lifecycle events. Persistent jobs outlive the process, and the TUI adopts the on-disk records at
  startup; print/SDK hosts adopt them only once they start a persistent job themselves.
- Metadata-first interoperable skills from `.claude/skills`, `.agents/skills`,
  `.opencode/skills`, and `.book/skills`, with explicit activation, consent, resource bounds,
  capability intersections, lifecycle diagnostics, safe-boundary reload, `$name` mention
  autocomplete over invocable skills in the input bar, and `npm run eval:skills`.

## Current Defaults

- Managed agents: `adaptive`; use `--agents manual` or `--agents off` for explicit-only or
  single-agent runs.
- Permission mode: `default` unless settings or `--permission-mode` selects another mode. A
  `permissions.deny` rule is evaluated for every tool ahead of the mode logic, so `auto`,
  `dontAsk`, and `bypassPermissions` cannot relax it; modes decide only what happens to calls no
  deny rule matched.
- Slash-command expansion: print/headless and SDK prompts expand a leading `/command` by default;
  `expandSlashCommands: false` on `HeadlessOptions` forwards every prompt to the model verbatim.
- Sandbox: `sandbox.enabled` is `false`, so no command is sandboxed until it is turned on, which
  leaves `sandbox.autoAllowBashIfSandboxed` (default `true`) inert under shipped defaults.
  `sandbox.allowUnsandboxedCommands` defaults to `true`, so unsandboxed execution stays permitted
  until it is explicitly refused.
- Compaction: `compactStrategy` is `summary`; `zero-mem` is opt-in through settings,
  `BOOK_COMPACT_STRATEGY`, `/config compact-strategy`, or the `/config` menu.
- Adaptive harness: `harness.mode` is `off`, which has no filesystem effect; `--harness-workflow`
  fails closed while it stays off.
- Tool discovery: `auto`; the practical core stays loaded and `ToolSearch` activates deferred
  authorized tools on the next turn.
- Tool execution: serial by default; only the reviewed read-only/Git set is scheduled in bounded
  waves (`toolExecution.maxConcurrent`, default `4`).
- Tool rows: transcripts show a tool's summary and result only. Call arguments are never rendered,
  and expanding a row reveals structured details or output rather than the parameters.
- Skills: discovered skills start in `manual` activation mode. Enable `auto` per skill only after
  representative evaluation.
- TUI renderer: `safe` on Windows, `incremental` on other interactive terminals. Windows users can
  opt into incremental rendering with `BOOK_TUI_RENDERER=incremental`.
- Web access: HTTPS and public destinations by default; HTTP and private-network exceptions require
  explicit environment opt-ins.

## Known Boundaries

- Project MCP declarations now have an explicit per-server trust boundary: repository-controlled
  servers are fingerprinted and require one-time approval before connection. A broader workspace
  trust database does not exist yet, so project settings, hooks, provider blocks, and project
  instructions must still be reviewed before opening an untrusted workspace. Shell substitution
  in a project `.book/commands/*.md` body is no longer among them: it carries the same per-item
  approval, keyed by command name and fingerprinted over the shell the body runs. All three
  per-item stores share one limit: they live in `<workspace>/.book/settings.local.json`, which
  is local only by convention, so a repository that commits that file rather than ignoring it
  supplies its own approvals. Relocating these decisions outside the working tree is the
  precondition for the workspace trust database, not a detail of it.
- Bubblewrap is optional and currently Linux-oriented; when unavailable, behavior follows the
  configured `sandbox.failIfUnavailable` policy and may run unsandboxed. Where it is available the
  boundary is real: sandboxed commands are spawned as a direct argument vector rather than a shell
  string, so no host shell parses the command, and declared `sandbox.filesystem` mounts are
  applied. `sandbox.network` domain rules cannot be expressed in bubblewrap and fail closed to no
  network rather than to the full host network. macOS `sandbox-exec` and a Windows equivalent are
  not implemented. `sandbox.autoAllowBashIfSandboxed` and `sandbox.allowUnsandboxedCommands` are
  consulted now, from one shared predicate over the three ways a command leaves the namespace
  (sandboxing disabled, an `excludedCommands` match, an unavailable backend), so the execution path
  and the permission path cannot disagree about a command. `allowUnsandboxedCommands: false`
  refuses any `Bash` command that would run outside the sandbox and names the setting and the
  reason; because `sandbox.enabled` defaults to `false`, that setting alone refuses every command
  until sandboxing is also turned on. `autoAllowBashIfSandboxed: true` removes only the default
  ask, and only for a genuinely sandboxed command: `permissions.deny` is evaluated first and is
  never softened, an explicit `permissions.ask` rule still prompts, any configured deny/ask rule at
  all keeps the default ask, and plan mode still refuses `Bash` independently of the verdict. It is
  inert under shipped defaults. `sandbox.excludedCommands` is still the only bypass a model-chosen
  command can trip by itself — a matching command runs on the host, and the only control over that
  is refusing unsandboxed execution wholesale, not an independent per-command approval.
- `compactStrategy: zero-mem` needs the optional `@huggingface/transformers` peer dependency and a
  locally cached embedding/NER pair under `BOOK_HOME/models/zero-mem`; downloads are refused unless
  `BOOK_ZERO_MEM_LOCAL_FILES_ONLY=false` is set once, and an unavailable model fails the turn with
  that instruction. Under `zero-mem`, auto-compaction is off, `/compact` only warms the index and
  reports that history was not replaced, and subagents keep the summary path.
- Managed-agent planning-task linkage, rerun, and task-aware cleanup from the background-job plan
  are not implemented; executable jobs and planning tasks remain separate.
- Background-job termination is judged on the POSIX process group rather than the direct child, so
  a `sh -c` wrapper's exit can no longer record `killed` while the real worker survives; a group
  holding an unreaped member still reads as alive until its reaper runs.
- `Stop` and `SessionEnd` fire once per run, after the terminal outcome settles and without the
  run's abort signal, so both survive cancellation; subagents fire neither and report through
  `SubagentStop`. Both are skipped on the early-return paths: a prompt blocked by a hook, context
  overflow, a run-budget stop, or a stream error.
- `/review` runs in print/headless and SDK hosts as well as the TUI: the shared sequencing lives in
  `src/review/host.ts`, the print host registers it through `src/commands/print-dispatch.ts`,
  `src/headless.ts` supplies the managed-agent runtime, and the review target is still resolved
  host-side. What remains TUI-only is `--fix`: a non-interactive host cannot approve a patcher's
  tool calls, so print mode refuses it with an explanation rather than patching unattended. In text
  output a print review emits nothing until it finishes. Its evaluation harness still scores reports
  captured from real runs rather than executing the pipeline over checked-in golden diffs, and the
  confidence threshold (70) and the per-pass timeout (10 minutes) are still fixed rather than
  configurable.
- Print/headless and SDK hosts run only the built-ins marked non-interactive — `/init`,
  `/security-review`, and `/review` — plus any `.book/commands/*.md` file. Every other built-in
  (session controls, pickers, panels, `/config`, `/export`, `/memory`) is refused before its own
  code runs, which ends the run with exit code 1; an unknown `/name` is still forwarded to the model
  verbatim.
  Shell substitution inside a custom command body still runs unsandboxed and outside the
  permission system, but a repository-declared body no longer reaches it unapproved: the
  decision is recorded in `.book/settings.local.json` under `commands.projectCommands`, the
  checked-in `.book/settings.json` layer is forbidden from writing that key, and an unapproved
  command is refused in the TUI and in print mode alike. The gate is fail-closed by
  construction — a host that passes
  no decision store is treated as having no decision — and the fingerprint digests the shell a
  body runs rather than its prose, so editing what runs re-asks and rewording does not. There is
  no interactive approval prompt yet: a pending decision is granted through `book config set`,
  which `book doctor` prints. Commands under `~/.book/commands` are user-owned and never gated.
- Plan approval outside the TUI depends on what the host supplied: `bypassPermissions` approves, an
  `onUserQuestionRequired` handler decides, and a host with neither ends the run with
  `plan.status: not_applied` and exit code 0. The SDK `result` event does not carry that `plan`
  object yet — `query()` callers read the stop from the forwarded `tool_use` / `tool_result` pair —
  and `QueryOptions` does not surface `expandSlashCommands`.
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
  before run setup. On the shipped ledger writer the eligibility check is always closed: it reports
  directory sync as unavailable, so no observe run produces promotion-eligible evidence today.
- Under `observe`, a run may use one of three built-in execution workflows selected manually through
  `harness.workflow` (settings) or `--harness-workflow` (run-scoped, not persisted, does not survive
  resume). `minimal` renders no prompt text and leaves provider messages byte-identical to a run with
  no harness; `safe-edit` and `verify-heavy` add bounded guidance to the dynamic prompt zone only.
  Nothing in the workflow surface is enforced: permissions, sandboxing, budgets, retries, compaction,
  checkpoint/resume, and tool contracts stay host-owned, unsupported requests are clamped and
  recorded as `capability_clamped` evidence, and a definition's free-form description is never
  rendered as an instruction. Each run records the requested and effective workflow, source, reason,
  registry and definition digests, override scope, and declared complexity. Selection fails closed at
  config load, at the CLI flag, and at the session run boundary when the harness is `off` or the ID
  is unknown or path-like; `book config set` rejects an unknown or path-like ID but not the `off`
  pairing, because it validates one settings layer, which does not determine the effective mode.
  Project-defined workflow files are not loaded, and there is still no automatic or learned
  selection.

## Verification

Use `npm run check` for formatting, lint, typecheck, architecture, unit, and contract checks.
Use `npm test` for the full build plus unit, contract, and integration tiers. Release validation is
`npm run release:check`; the stabilization policy is `npm run stabilization:check` with the GitHub
Actions environment variables described in [stabilization.md](stabilization.md).

Local verification for this refresh (2026-08-24): typecheck, lint, the architecture check, the
contract tier, and the unit files covering settings, commands, and the CLI were re-run for these
changes and pass. The full unit tier was not clean on this machine: eight cases in
`src/harness/evaluation/contract.test.ts` fail on an untouched checkout with
`fixture digest does not match its source tree`, a line-ending artefact of this Windows working
copy rather than a code defect.
