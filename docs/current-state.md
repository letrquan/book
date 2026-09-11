# Book Current State

This is the implementation-backed product snapshot for Book as of 2026-09-07. Update this file
when a user-facing surface changes; the README is the usage guide and this page is the status
reference for roadmap and design documents.

The last independent surface re-verification was 2026-08-26 and covered the interactive transcript
and terminal interaction path, reasoning/retry propagation, and headless/stream-JSON framing only
(surfaces not re-verified that run: project-declaration trust gates, providers, MCP, other
settings and sandbox behavior, managed agents, `/review`, background jobs, and skills). Sections
written since then were
authored alongside the implementation they describe and merged with it -- the residual compaction
tail (PR #192) and the permission-prompt preview (PR #188) -- and carry that evidence rather than a
fresh verification pass.

## Release Identity

- Package version: `0.2.0`, published as `@letrquan/book`.
- Distribution: `npm install -g @letrquan/book`, a source checkout, or a GitHub tag. The command
  is `book`; the package is scoped because the unscoped name was taken.
- License: PolyForm Small Business 1.0.0 — source-available, commercial use limited to companies
  under 100 people and 1,000,000 USD (2019) revenue. See `LICENSE`.
- Runtime: Node.js 22.13 or newer; CI exercises Node.js 22 and 24 on Ubuntu and Windows.
- Build: `tsup` emits ESM CLI, SDK, and job-runner bundles plus declarations into `dist/`.

## Shipped Surfaces

- Interactive Ink/React TUI, print/headless mode, JSON and stream-JSON output, session resume,
  fork, rewind, production summary compaction, structured JSON-schema output, and prompt
  suggestions.
- The permission prompt shows what it is asking consent for: a shell command in full, every
  line hard-wrapped to the card with any row cut marked and openable with `D`, and for
  `Edit`/`MultiEdit`/`Write`/`ApplyPatch` the diff the call would make, computed from the pending
  arguments against the file on disk before anything is written (`src/tools/mutation-preview.ts`,
  the tools' own matching and hunk application, rendered through `DiffBlock`). A preview that
  cannot be computed says why, which is the failure the tool would have reported.
- Every transcript row resolves its horizontal position through one grid module
  (`src/tui/layout.ts`). A row is `[gutter][content]`: a two-column gutter carries status, prose
  begins on the content column, content (prose, diffs, rules, the status line and the composer)
  takes the full terminal while floating chrome and aligned tool rows stay bounded at 120 columns
  (`panelGrid`, `MAX_ROW_MEASURE`) so a popover is not a giant empty box and right-aligned metadata
  stays near the row it belongs to, the aligned label column is sized per message rather
  than globally and renders inline instead of truncating when a label overflows, and bordered
  surfaces sit flush at column 0 so their one column of padding lands their text on that same
  content column. Tool rows and managed-agent blocks take the one deliberate step in from that
  column: they carry their own gutter a level deeper, so the work a turn did reads as nested under
  the prose that ordered it rather than hanging a column of status glyphs to its left. The grid
  narrows by exactly what it shifts, so every row keeps the same right edge and right-aligned
  metadata still lines up down the transcript. Sixteen non-test modules across the transcript path
  resolve through it. A few components outside that path — diff cards, subagent and
  background-shell rows, the command panel — still carry their own `marginLeft` and width
  arithmetic rather than deriving it from the grid, and are not covered by that guarantee.
- The interactive transcript enables SGR button-event mouse reports and handles wheel scrolling,
  single-click tool-summary expansion, and drag selection without feeding reports into the
  composer. Selection is extracted from the captured visible frame by terminal columns (including
  wide graphemes), painted as a temporary inverse overlay, and copied through OSC 52 plus a
  best-effort platform clipboard command; Shift+drag remains available for terminal-native
  selection. Frame updates repaint an active selection after Ink redraws.
- Print/headless and SDK hosts resolve a leading `/command` through the same registries,
  substitutions, and `allowed-tools`/`model` frontmatter enforcement as the TUI, perform the
  commands a non-interactive host can honestly perform, and refuse the rest before their own code
  runs. Plan mode works there too: `bypassPermissions` approves, a supplied `onUserQuestionRequired`
  handler decides, and a host with neither ends the run with the plan as its deliverable instead of
  rejecting and re-planning until the turn budget is gone.
- Provider-native reasoning and inline `<think>`, `<thinking>`, `<reasoning>`, and
  `<reasoning_context>` blocks are kept separate from answer prose: the TUI streams active
  thinking, collapses completed thoughts to a counted row in compact mode, and reopens them in
  detailed mode, while fenced-code examples remain ordinary answer content. Shared reasoning-tag
  helpers let the agent loop recognize closed reasoning-only completions, retry an empty turn once,
  and emit `reasoning`/`attempt_discarded` events so session and headless hosts preserve the
  boundary.
- Headless stream-JSON hosts forward shared reasoning, tool, question, managed-agent, evidence,
  retry-discard, and error events; host-performed slash commands produce a `command_result` record
  with human and machine projections. The input parser accepts fragmented chunks and CRLF line
  endings, bounds each record, and reports invalid JSON, invalid shapes, and oversized lines before
  a run proceeds.
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
  bind in every permission mode, project-declared `permissions.allow` rules and hook entries held
  until the user approves them (`ask`/`deny` apply immediately; `book doctor` reports what is
  withheld and how to grant it, disclosing each withheld hook's command, matcher, and environment,
  and `book trust hook|rule|command` records the decision), all four trust-decision keys ignored
  from both workspace layers and read instead from `~/.book/trust.json`, keyed by workspace path,
  so nothing a repository ships can approve its own MCP servers, allow rules, hook entries, or
  shell-substituting slash commands — a force-added `.book/settings.local.json` reaches a clone the
  same way a checked-in file does, and `book config set` refuses those four paths rather than
  writing a value nothing reads. Experimental capability opt-ins are
  likewise ignored from both workspace layers and must come from the user-global file, an explicit
  `--settings` document, or the process environment; all three writers (`book config set`, the
  `/config` slash command, and the TUI's local persistence) refuse them through one shared list. Other settings include hooks, the optional bubblewrap sandbox, themes,
  auto-memory, rewind snapshots, telemetry, and diagnostics. Every declared sandbox key is now read
  by an execution or permission path: `sandbox.allowUnsandboxedCommands` can refuse any command that
  would leave the
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
  and the pipeline's own coverage) under `json` and `stream-json`. A run announces its resolved
  target before spawning anything; in the TUI its agents are owned by the session so they show live
  in the agent panel and status line, and `Esc` cancels the run and stops them.
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
- Compaction: `compactStrategy` is fixed to the production `summary` path and is the only
  strategy. Every summary checkpoint carries a host-owned Carried Ledger
  (`src/agent/carried-ledger.ts`) of user-authored constraints, extracted deterministically from
  the user's own typed turns, readable but not writable by the reducer, not evictable by the
  fitter, capped at 32 entries / 1024 tokens / 35% of the checkpoint budget, and disclosed in the
  checkpoint header. It has no setting: it is always on and costs no extra model call. Since Phase 1
  (2026-09-05, revised 2026-09-06 after review) the tail an auto-compaction keeps verbatim is the
  residual of the post-compaction target rather than a flat 20k cap. The target is half the loop's
  preflight gate net of the measured request overhead, which is about 79k tokens of tail at the
  272k default window with the default output reserve and no overhead, and the per-result clip
  scales with it. The loop and the compactor share one budget resolver. The short 20k tail is kept
  by the recovery compaction after a provider rejects a request, and by any compaction that would
  otherwise retain everything. Measured over the eight-generation fidelity corpus:
  `verbatimUserRetention` 1.0 on both arms, final retention 0.667 at 32k and 0.833 at 272k, and
  post-history utilization 0.47 and 0.48 against the loop's gate, recorded as per-arm floors in
  `FIDELITY_ARMS`. Design: `plans/carried-ledger-plan.md`.
- Tool discovery: `auto`; the practical core stays loaded and `ToolSearch` activates deferred
  authorized tools on the next turn.
- Tool execution: serial by default; only the reviewed read-only/Git set is scheduled in bounded
  waves (`toolExecution.maxConcurrent`, default `4`).
- Tool rows: transcripts show a tool's summary and result only. Call arguments are never rendered,
  and expanding a row reveals structured details or output rather than the parameters.
- Skills: discovered skills start in `manual` activation mode. Enable `auto` per skill only after
  representative evaluation.
- TUI renderer: `safe` on Windows, `incremental` on other interactive terminals — and `safe`
  anywhere the Ink patch is absent, which is every npm install under npm 11, since it blocks the
  postinstall that applies it (`isInkIncrementalRendererPatched`). Windows users can
  opt into incremental rendering with `BOOK_TUI_RENDERER=incremental`.
- `Bash` shell: the platform default (`/bin/sh`) on macOS and Linux. On Windows, `BOOK_SHELL` or the
  `shell` setting, then Git Bash when Book was launched from one, then PowerShell 7, then Windows
  PowerShell 5.1, then an installed Git Bash, and `cmd.exe` only when nothing else exists
  (`src/shell-selection.ts`). Resolved once per session onto `AgentConfig`, reported by
  `book doctor`, and named in the Harness prompt section with that shell's own syntax rules. `shell`
  is stripped from both workspace layers and refused by `book config` there, like `auth`.
- Web access: HTTPS and public destinations by default; HTTP and private-network exceptions require
  explicit environment opt-ins.

## Long-Horizon Execution

Work aimed at running an objective unattended for days rather than hours. All of it is gated on
`continuation.enabled` (default off) except where noted.

- **Continuation.** `runAgentLoop` no longer ends at the model's first tool-free turn; it appends a
  host-authored user turn while the plan says work remains. Two independent brakes stop a run that
  is going nowhere: `noProgressLimit` (identical todos, file hashes and *executed* tool calls across
  boundaries) and `blockedToolTurnLimit`, which ends a run whose every tool call was refused on N
  consecutive turns. The second is enforced in unattended hosts regardless of
  `continuation.enabled`, because that spin predates continuation; it does not apply in the TUI or
  in plan mode, where a refusal is a person or a policy, not a stall.
- **Spend.** `--max-budget-usd` bounds the *objective*: enforced against inclusive cost so delegated
  work counts, carried across submitted prompts and across restarts, persisted from the inclusive
  total so managed-agent and subagent tokens survive a restart, and fail-closed on a ceiling that
  cannot be evaluated. The pre-call check is O(1) in responses.
- **Transport.** A dropped stream re-issues the turn against the history already on disk rather than
  ending the run, with a separate allowance for output-cap continuations. A re-issued request never
  ends on an assistant message, because that is prefill and is refused while thinking is enabled.
- **Liveness.** `<BOOK_HOME>/runs/<session-id>.json` carries turn, elapsed, spend, current todo,
  last tool, free disk and the terminal outcome, rewritten at each turn boundary and bounded in
  size; a `crash` field is written from the exit path when a process dies without one.
- **Restart.** Todos and the task DAG persist and restore, and a resumed session is told when a plan
  record existed but came back empty - never when one was simply never written.

## Known Boundaries

- Four classes of repository-controlled input carry an explicit trust boundary, each
  fingerprinted and requiring a one-time approval: project MCP declarations, project-declared
  allow rules, project-declared hook entries, and shell substitution in a project
  `.book/commands/*.md` body. All four now share one store — recorded per workspace in
  `~/.book/trust.json` and stripped from **both** workspace settings layers, so no file inside the
  working tree can answer for any of them, and a repository that force-adds
  `.book/settings.local.json` supplies nothing. `book trust hook|rule|command` records a decision
  one at a time; `book config set` refuses all four paths — plus `shell` —
  rather than writing a value nothing reads. Command decisions are keyed by command name and validated by a fingerprint over the
  shell the body runs rather than its prose, so editing what runs re-asks under the same name.
- Approvals recorded under `commands.projectCommands` before the move are not migrated: reading
  them back out of the workspace to convert them would extend exactly the trust the move
  withdraws. Each is asked once more, on the machine that decides.
- Except for the `shell` key, the local layer is otherwise ungated. Its own
  `hooks.<event>` entries, allow rules, and env run as if the user had written them, because
  distrusting a Git-tracked local layer needs provenance
  the synchronous resolver cannot currently obtain. Provider blocks, project instructions, and a
  checked-in `settings.local.json` must still be reviewed before opening an untrusted workspace.
- No interactive surface records these decisions yet, and the interactive host does not report
  them either. The MCP gate has a TUI prompt; the allow-rule, hook, and command gates do not, so
  in the primary mode a withheld hook simply never fires and a withheld command is refused until
  the user runs `book doctor`, which prints the `book trust …` grant for each. The withheld
  declaration notices are placed worse than the absence of a prompt implies:
  `collectWithheldProjectNotices` is called from `src/cli/run.ts` inside the print-mode branch,
  and neither `src/hook-approvals.ts` nor `src/permission-approvals.ts` has an importer anywhere
  under `src/tui/`. Print/headless and SDK runs report what they are skipping; the TUI is silent,
  so the mode most likely to open an unfamiliar repository is the one mode that discloses nothing
  about what that repository declared.
- The Windows shell ladder changes which interpreter parses a command, not what a command is
  allowed to do: `permissions` rules still match the command string the model wrote, so a rule
  written for one shell's syntax does not describe another's. The bubblewrap sandbox is unaffected
  because it remains unavailable on Windows.
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
  never softened, an explicit `permissions.ask` rule still prompts, any configured deny/ask rule
  at all keeps the default ask, and plan mode still refuses `Bash` independently of the verdict. It
  is inert under shipped defaults. `sandbox.excludedCommands` is still the only bypass a
  model-chosen command can trip by itself — a matching command runs on the host, and the only
  control over that is refusing unsandboxed execution wholesale, not an independent per-command
  approval.
- Configuration for a removed feature is reported, never fatal. `src/settings-removed.ts` knows
  which keys the subscription-auth, adaptive-harness and Zero-Mem removals left behind; validation
  discards a removed block silently, so `book doctor` lists what is still on the machine and what
  to delete — including `<BOOK_HOME>/auth.json`, which holds an OAuth refresh token nothing reads
  or revokes any more. A removed *value* of a surviving key is coerced rather than rejected, since
  `compactStrategy: "zero-mem"` would otherwise fail the whole document and stop Book from
  starting. The credential error names the removal when an `auth` block was the only credential.
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
  tool calls, so print mode refuses it with an explanation rather than patching unattended. A print
  review still writes nothing until it finishes — it has no surface to stream to, so the progress a
  TUI review shows (the announced target, live agents, `Esc` to cancel) has no counterpart there.
  Its evaluation harness still scores reports
  captured from real runs rather than executing the pipeline over checked-in golden diffs, and the
  confidence threshold (70) and the per-pass timeout (10 minutes) are still fixed rather than
  configurable.
- `--scrollback` is a reduced host: it calls the agent loop directly and builds no `SessionStore`,
  MCP session host, or slash-command registry, and it handles only `/exit` and `/clear`.
  `--scrollback -c` is silently inert rather than resuming a session, and any other leading
  `/name` reaches the model verbatim. Hooks fire inside the loop; sessions, MCP servers, and
  slash commands do not exist on this path.
- Mouse selection is a viewport feature: it copies cells from Ink's latest captured frame only, so
  history outside the visible frame is not selectable through Book's drag path. Shift+drag
  intentionally bypasses Book's handler for terminal-native selection. An OSC 52 write is not
  confirmation that a terminal clipboard accepted the text; the UI distinguishes the `terminal`
  fallback from a confirmed local clipboard command and reports failure when neither path succeeds.
- Reasoning-tag handling has two deliberately different readings. Rendering treats an unclosed
  recognized tag as thinking through the end of a streaming message, while empty-turn detection
  strips only closed tags and leaves an unclosed tag in answer text; this favors preserving a real
  answer over triggering a retry on ambiguous markup. One shape is carved out of that reading: a
  turn that is nothing but an unclosed reasoning block — the tag opens the content, is never
  closed, and no answer text stands beside it — gets the same single retry an empty turn gets,
  because there is no answer there to protect; if the retry comes back the same shape the text
  is kept as the answer rather than discarded. A reasoning-only/empty response receives at most
  one same-turn retry, and already-emitted attempt text is marked `attempt_discarded` rather than
  persisted as the replacement turn. Print mode's exit code does not change with the terminal
  outcome (see README, "Exit codes"): a failed outcome still exits 0.
- Print/headless and SDK hosts run only the built-ins marked non-interactive — `/init`,
  `/security-review`, and `/review` — plus any `.book/commands/*.md` file. Every other built-in
  (session controls, pickers, panels, `/config`, `/export`, `/memory`) is refused before its own
  code runs, which ends the run with exit code 1; an unknown `/name` is still forwarded to the
  model verbatim.
  Shell substitution inside a custom command body still runs unsandboxed and outside the
  permission system, but a repository-declared body no longer reaches it unapproved: the decision
  is recorded in `~/.book/trust.json`, keyed by workspace path and stripped from both workspace
  settings layers, and an unapproved command is refused in the TUI and in print mode alike. The
  gate is fail-closed by construction — a host that passes no decision store is treated as having
  no decision — and the fingerprint digests the shell a body runs rather than its prose, so
  editing what runs re-asks and rewording does not. There is no interactive approval prompt yet:
  a pending decision is granted with `book trust command`, which `book doctor` prints alongside
  the shell each withheld command would run. Commands under `~/.book/commands` are user-owned and
  never gated.
- Plan approval outside the TUI depends on what the host supplied: `bypassPermissions` approves, an
  `onUserQuestionRequired` handler decides, and a host with neither ends the run with
  `plan.status: not_applied` and exit code 0. The SDK `result` event does not carry that `plan`
  object yet — `query()` callers read the stop from the forwarded `tool_use` / `tool_result` pair —
  and `QueryOptions` does not surface `expandSlashCommands`.

## Verification

Use `npm run check` for formatting, lint, typecheck, architecture, unit, and contract checks.
Use `npm test` for the full build plus unit, contract, and integration tiers. Release validation is
`npm run release:check`; the stabilization policy is `npm run stabilization:check` with the GitHub
Actions environment variables described in [stabilization.md](stabilization.md).

Local verification for the previous snapshot (2026-08-25; tests were not re-run during this
refresh): `npm run check` (230 unit files, 2640 tests, 5 skipped; 7 contract files, 59 tests),
`npm run build`, and `npm run test:integration` (7 files, 97 tests, 10 skipped) all pass on Windows.
The counts above are carried forward from that run, not advanced here.
