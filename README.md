# Book

AI coding agent CLI with rich terminal UI. A provider-agnostic alternative to Claude Code.

The implementation-backed status snapshot is [docs/current-state.md](./docs/current-state.md).
This repository is proprietary and is currently distributed from source/GitHub rather than npm.

## Features

- **Interactive TUI** (Ink/React) plus **print mode** (`-p`) with `text` / `json` / `stream-json` output for CI.
- **Providers**: Anthropic Messages API (prompt caching, adaptive thinking, `--effort`) and any OpenAI-compatible endpoint, auto-detected from `baseUrl` / `--provider`.
- **Project context**: walks the tree to load Codex-style `AGENTS.md` and Claude-style `CLAUDE.md` instructions (user-global → broad project → specific project → local/rules) into a fenced, trust-labeled block, alongside platform info and discovered skills, slash commands, and subagents. Content is split by how often it changes: a cached static prefix, an uncached suffix for activation-class policy, and a per-turn `<session-state>` block carrying date, git status, and mode on the newest user turn — so an edit or a mode toggle costs one turn of cache, not the whole conversation.
- **Auto-memory**: file-based store under `~/.book/projects/<project>/memory/` with a `MEMORY.md` index (first 200 lines auto-loaded). Four memory types (`user` / `feedback` / `project` / `reference`), YAML frontmatter, auto-capture on user corrections/confirmations, and an **approval flow** (`/memory inbox` → `/memory approve|discard`). Secret/unfit text is rejected before writing.
- **Sessions**: append-only JSONL persistence with automatic titles from the first prompt plus `--resume`, `--continue`, `--session-id`, `--name`, and `--fork-session`; in-TUI `/clear` / `/new` / `/reset`, `/resume`, reference-aware `/compact`, and Claude-style `/rewind` for conversation, code, or both. Compaction reduces provider context without deleting the scrollable transcript: recent turns stay exact, older evidence remains addressable by stable session references, and remembered file facts are freshness-checked before reuse.
- **Tools**: a provider-neutral capability catalog keeps a practical core loaded and uses `ToolSearch` to activate up to five authorized git, web, session, skill, agent, notebook, or MCP definitions on the next model turn. File, shell, task, clarification, and plan tools stay immediately available when permitted. Existing names such as `Read`, `Bash`, and `AgentSpawn` remain stable.
- **Slash commands**: built-ins including `/jobs`, `/agents`, `/agent`, `/init`, `/model`, `/effort`, `/config`, `/permissions`, `/cost`, `/usage`, `/context`, `/memory`, `/diff`, `/export`, `/skills`, `/review`, `/security-review`, `/release-notes`, `/feedback`, `/compact`, `/rewind`, `/clear`, `/resume`, plus custom commands from `.book/commands/*.md`.
- **Permissions**: allow/ask/deny rule matching with six modes — `default`, `acceptEdits` (`accept-edits`), `plan`, `auto`, `dontAsk`, `bypassPermissions` — see `/permissions` or `--permission-mode`.
- **Sandbox & hooks**: optional bubblewrap sandbox for Bash; lifecycle hooks (JSON-over-stdio) for `PreToolUse` / `PostToolUse` / session events. Review project-controlled hooks and provider/MCP settings before using an untrusted workspace.
- **Verified managed agents**: adaptive model-directed routing, purpose-named runs, compact parent-facing results, live TUI monitoring, profile model overrides, read-only non-Git exploration, resumable isolated worktrees, strict capabilities, typed evidence, independent validation, and explicit patch application. Built-in `explorer`, `patcher`, and `validator` profiles can be overridden under `.book/agents/`.
- **MCP**: interoperable MCP tool client with stdio, Streamable HTTP, and legacy SSE transports;
  interactive project-server approval, secret-safe diagnostics, dynamic tool discovery, and
  server-scoped permissions.
- **CLI helpers**: `book doctor` (diagnose env/config), `book config` (get/set/list settings), and `book tool-stats` (measure tool use across sessions — fail counts, rates, durations).

See [`docs/current-state.md`](./docs/current-state.md) for the verified product snapshot, [`MILESTONES.md`](./MILESTONES.md) for the current roadmap, and [`CHANGELOG.md`](./CHANGELOG.md) for release notes.

## Installation

Requires **Node.js 22.13+**.

```bash
# Clone (repo is currently private — use a machine with GitHub access)
git clone https://github.com/letrquan/book.git
cd book
npm install
npm run build
npm link   # makes `book` available globally

# Or install a tagged release without linking
npm install -g github:letrquan/book#v0.1.0
```

> **Note:** The unscoped npm name `book` is already taken on the public registry.
> v0.1.0 is distributed via GitHub only.

## Quick Start

```bash
# Interactive TUI mode
book

# Print mode (non-interactive)
book -p "What does this codebase do?"

# Headless JSON output
book -p "Refactor auth module" --output-format json

# Stream JSON (CI-friendly)
book -p "Run tests" --output-format stream-json

# Resume a previous session
book --resume <id-or-name>
book --continue  # most recent session in current directory

# Diagnose setup / edit settings from the shell
book doctor
book config list
book config get permissions.deny
book config set permissions.allow '["Read(*)","Glob(*)","Grep(*)"]'

# Manage MCP servers (JSON shape is compatible with the wider MCP ecosystem)
book mcp list
book mcp add github npx -- -y @modelcontextprotocol/server-github
book mcp add remote https://mcp.example.com/mcp --transport http --scope project \
  --header 'Authorization=${GITHUB_TOKEN}'
book mcp get github
book mcp remove github

# Inspect and measure tool use recorded across sessions
book tool-stats
book tool-stats --json          # machine-readable aggregate
book tool-stats --all           # ignore the retention window
book tool-stats --since 7       # only the last 7 days
```

### Common flags

| Flag                                  | Purpose                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `-w, --workspace <path>`              | Workspace root (default: cwd)                                                      |
| `-m, --model <model>`                 | Model override                                                                     |
| `-p, --print [prompt]`                | Non-interactive / CI mode                                                          |
| `--output-format <fmt>`               | `text` \| `json` \| `stream-json`                                                  |
| `--input-format <fmt>`                | `text` \| `stream-json` (print mode input)                                         |
| `--permission-mode <mode>`            | `default` \| `acceptEdits` \| `plan` \| `auto` \| `dontAsk` \| `bypassPermissions` |
| `--effort <level>`                    | Thinking effort: `low` \| `medium` \| `high` \| `xhigh` \| `max`                   |
| `--provider <type>`                   | `anthropic` \| `openai` \| `auto`                                                  |
| `--max-turns <n>`                     | Cap agent turns (print mode)                                                       |
| `--max-budget-usd <amount>`           | Cap spend (print mode)                                                             |
| `--json-schema <schema>`              | Structured JSON output (print mode)                                                |
| `-r, --resume <id\|name>`             | Resume a named/id session                                                          |
| `-c, --continue`                      | Resume most recent session here                                                    |
| `--session-id <uuid>`                 | Pin a session id                                                                   |
| `-n, --name <name>`                   | Display name for the session                                                       |
| `--fork-session`                      | On resume, fork to a new session id                                                |
| `--no-session-persistence`            | Do not write the session to disk                                                   |
| `--settings <path>` / `--no-settings` | Ad-hoc settings file, or skip all layers                                           |
| `--scrollback`                        | Terminal-native scrollback instead of full-screen TUI                              |
| `--agents <mode>`                     | `adaptive` (default) \| `manual` \| `off`                                          |
| `--verbose`                           | Full turn-by-turn output in print mode                                             |
| `--include-hook-events`               | Include hook lifecycle events in stream-JSON output                                |
| `--include-partial-messages`          | Include partial assistant text deltas in stream-JSON output                        |
| `--prompt-suggestions`                | Ask for follow-up prompt suggestions after completion                              |

## Configuration

Settings are loaded in priority order (later wins):

1. `~/.book/settings.json` (user-global)
2. `.book/settings.json` (project)
3. `.book/settings.local.json` (local, should be gitignored)
4. `--settings <path>` CLI flag

Set `BOOK_HOME` to replace the default `~/.book` user-state root. This relocates user settings,
sessions, memory, managed-agent state and worktrees, jobs, rewind snapshots, telemetry, tool output,
MCP configuration, and user-level skills, commands, agents, and `AGENTS.md` discovery. Project-local
`.book/` directories are unchanged.

### MCP servers

MCP declarations use the interoperable `{"mcpServers": {"name": {...}}}` shape. User-global
servers live at `~/.book/mcp.json` (or `$BOOK_HOME/mcp.json`) and project declarations live at
`.mcp.json`. A declaration may use the legacy stdio shape or an explicit transport:

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

Supported transports are `stdio`, Streamable HTTP (`http`), and legacy SSE (`sse`). Variable
references support `${NAME}` and `${NAME:-fallback}`; values are never shell-evaluated. URLs must
be absolute HTTP(S) URLs without embedded credentials. Header names are shown in status output,
but header values are redacted from logs, prompts, reports, and diagnostics.

Project servers are untrusted repository-controlled input. Book displays the exact non-secret
target and asks for one-time approval before launching or connecting; the decision is stored in
`.book/settings.local.json` and is invalidated when any command, argument, environment value,
working directory, URL, transport, or header value changes. Headless and SDK runs skip unapproved
project servers. `/mcp` shows live status in the TUI; `book mcp list|get|add|remove` manages
declarations. Permission rules may target one server (`mcp__github`) or one exact tool
(`mcp__github__create_issue`).

Servers may ask the user for input mid-call through MCP form elicitation — a project picker, a
confirmation, a missing parameter. The interactive TUI answers those requests: the form shows which
server is asking, offers its fields (text, number, yes/no, and choice lists, which filter as you
type), and returns the answer inside the still-open tool call. `D` declines, `Esc` cancels, and
either way the server is told rather than left waiting. URL-mode elicitation is not supported and is
declined.

Only the TUI can prompt. Headless (`--print`) runs, and SDK runs without an `onElicit` callback, do
not declare the capability at all, so a server fails such a request itself instead of blocking on a
prompt nobody will see. For unattended runs, pass the value explicitly in the tool call or give the
server a default — for example the Azure DevOps server reads `ado_mcp_project` from its `env` block
and skips the project prompt entirely.

Legacy `.bookrc.json` is still supported but deprecated. Use `--no-settings` to skip all `settings.json` layers (defaults + legacy only).

Scalar values use the highest-priority layer. Permission rules, hook lists, and
`additionalDirectories` accumulate in layer order; directory entries are normalized and
deduplicated. Other arrays are replaced by the highest-priority layer that defines them.

`book config set` and TUI preference changes validate the complete local document before writing.

Set `defaultMode` in user-global `~/.book/settings.json` to choose the permission mode used by
the TUI, print mode, scrollback, and SDK when no invocation-specific mode is supplied. The
`--permission-mode` CLI option and SDK `permissionMode` option override that default.
Project and local settings cannot select `bypassPermissions` as the startup default. Setting
`disableBypassPermissionsMode` to `true` also blocks explicit bypass requests and removes bypass
from the TUI mode cycle.
Writes use an atomic sibling-file replacement, and malformed or non-object
`.book/settings.local.json` files are never overwritten. The reported error includes the file and
invalid setting path; provider secrets are redacted.

Inside the TUI, `/config` opens a visual settings menu. Use it to change the main model, compact
strategy, compact model, effort, theme, memory auto-capture, startup fire, or the model assigned to
each managed-agent profile.
The startup fire plays only for a new, empty launch session and is skipped automatically for
screen-reader or reduced-motion mode. Press Esc to skip it. TUI preference changes are saved in
`.book/settings.local.json`; set `ui.startupAnimation` to `false` there to disable the effect.

### File mutations

Book exposes the same mutation tools to every model — `ApplyPatch`, `Edit`, `MultiEdit`, and
`Write` — but the system prompt's recommended tool is **model-conditional**: GPT/Codex-family
models (trained on the V4A patch envelope) are steered to `ApplyPatch`, and every other model
(Claude, Qwen, GLM, Gemini, Grok, unknown) is steered to exact-replace `Edit`/`MultiEdit`, the
format with the best cross-model compliance in published evals. Override per model in settings:

```json
{ "provider": { "myrouter": { "models": { "qc/qwen3.7-max": { "editFormat": "replace" } } } } }
```

`editFormat` accepts `patch`, `replace`, or `whole` (whole-file `Write`-first guidance).

`ApplyPatch` accepts a compact Codex-style envelope:

```text
*** Begin Patch
*** Update File: src/example.ts
@@
 const answer = 41
-return answer
+return answer + 1
*** End Patch
```

Use `*** Add File: path` with `+`-prefixed lines for new files and `*** Delete File: path` for
deletions. Update hunks use exact, unique context; reread the affected range and regenerate the
hunk after a `patch_context_not_found` or `ambiguous_patch_context` error. Patches preserve an
existing file's LF/CRLF convention and UTF-8 BOM, validate all files before writing, verify the
post-state, and roll back earlier files if a later commit fails. Binary and mixed-line-ending
updates are rejected rather than guessed.

Mutation reliability guardrails, tuned for heterogeneous models:

- **Read-before-edit is enforced.** `Edit`/`MultiEdit` (and `Write` over an existing file) fail
  with `file_not_observed` until the file has been Read or `@`-mentioned this session, and fail
  with `stale_file_observation` when it changed since last observed.
- **Whitespace-tolerant recovery.** When an exact `oldString` match fails, Book tries two
  deterministic relaxations — trailing-whitespace-insensitive and uniform-indent-shift — and
  applies one only when it matches a single location; the result notes the tolerance used.
  `replaceAll` always requires exact matches.
- **Cross-harness argument aliases.** Claude Code-style spellings (`file_path`, `old_string`,
  `new_string`, `replace_all`, Grep `glob`/`-A`/`-B`/`-C`, ApplyPatch `input`) are normalized to
  Book's canonical arguments before validation, and `invalid_arguments` errors list the allowed
  argument names.
- **Retry-loop braking.** Repeating a call that already failed with identical arguments returns
  escalated guidance instead of the same error; structured `Fix:` remediation lines are rendered
  into the model-facing error text.
- **Reliability visibility.** `/usage` shows per-tool call and failure counters for the session,
  and `npm run eval:edit` runs a deterministic ~25-task edit-reliability eval against the
  configured model, writing a report to `.book/reports/`.

`npm run eval:compact` runs a real-provider paired benchmark for `/compact`. Every probe runs
against the original history and the compacted history, so the report can separate baseline model
errors from compaction regressions. The default `--suite smoke` keeps the original five low-cost
static-recall probes. `--suite standard` runs 11 probes spanning static recall, knowledge updates,
conflict resolution, temporal reasoning, multi-hop synthesis, and abstention. Evidence is placed
early, late, or across the synthetic history, which remains larger than 6,000 estimated tokens.

The V2 report includes per-model and per-category accuracy, retained baseline answers, regressions,
improvements, JSON/tool protocol failures, compression ratio, prompt and net-token savings,
measured cost savings when model pricing is known, and token/cost break-even estimates that include
the one-time compaction call. Reports are written to `.book/reports/compact-eval-v2-*.{json,md}`.

```bash
npm run eval:compact -- --model 9router/qc/qwen3.7-max --suite smoke
npm run eval:compact -- --models 9router/ag/gemini-3.6-flash-high,9router/qc/qwen3.7-max --suite standard
npm run eval:compact -- --model 9router/qc/qwen3.7-max --suite standard --repeat 3 --include-no-history
```

Use repeated `--model` flags or comma-separated `--models` for cross-model comparisons. `--repeat`
measures run-to-run stability, `--include-no-history` detects probes that can pass without evidence,
and `--probes <count>` or `--context-window <tokens>` constrains cost and context. Experiments can
set `--checkpoint-tokens <tokens>` to override the reducer output cap without changing the
production default; the JSON report records the requested cap, realized checkpoint size, and full
checkpoint. `--compact-effort low|medium|high|xhigh|max` overrides reasoning effort only for the
compaction call, making it possible to test a cheaper reducer while keeping probe models fixed.
`--compact-model <model>` routes only the compaction call through another configured model, so a
cheaper reducer or a higher-fidelity reducer can be evaluated independently from the probe model.
The benchmark requires configured provider credentials and is not part of CI.

`npm run eval:zero-mem` adds a paper-aligned experimental third arm based on Zero-Mem
(arXiv:2607.29377v1). It uses BGE-M3 embeddings, non-generative BERT NER plus technical spans,
occurrence-weighted entity/context edges, query-conditioned sentence propagation, PageRank with
`gamma = 0.6`, semantic/session-aware trace regions, evidence closure, and deterministic evidence
and answer calibration. Original messages, actions, reasoning, tool observations, attachments, and
file observations remain the source of record; generated compact checkpoints are excluded.

The paper's complete implementation is not public, so this is a defensible reproduction rather
than an exact code replica. With provider credentials it compares full history, production
compaction, and Zero-Mem using the same final reader and the compact arm's context size as the
Zero-Mem evidence budget. Reader calls share a 1,024-token output cap across all arms.
`--retrieval-only` (or `--offline`) skips the reader but still runs the real local NER and BGE-M3
encoder. Model weights are cached outside the repository; set
`BOOK_ZERO_MEM_MODEL_CACHE` to choose a persistent cache directory.
Production sessions use cached weights only by default so selecting Zero-Mem never silently starts
a model download. Set `BOOK_ZERO_MEM_LOCAL_FILES_ONLY=false` explicitly for one run to populate the
cache, then remove it or set it back to `true`. Zero-Mem uses the optional
`@huggingface/transformers` peer; source checkouts install it for evaluation, while packaged
installations that enable Zero-Mem must install that peer explicitly.

```bash
BOOK_ZERO_MEM_MODEL_CACHE=/path/to/model-cache npm run eval:zero-mem -- --retrieval-only --suite standard
BOOK_ZERO_MEM_MODEL_CACHE=/path/to/model-cache npm run eval:zero-mem -- --model 9router/cmc/deepseek/deepseek-v4-flash --suite standard
```

`Write` remains appropriate for generated or intentional full-file replacement. The
`apply_patch` provider alias maps to `ApplyPatch`; legacy tools are not silently reinterpreted.

### Example `.book/settings.json`

```json
{
  "model": "claude-opus-4-6",
  "compactStrategy": "summary",
  "compactModel": "9router/ag/gemini-3.6-flash-high",
  "effort": "high",
  "defaultMode": "default",
  "permissions": {
    "allow": ["Read(*)", "Glob(*)", "Grep(*)"],
    "deny": ["Bash(rm *)", "Write(.env)"]
  },
  "sandbox": {
    "enabled": false
  },
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash(*)", "command": "my-validator" }]
  },
  "memory": {
    "enabled": true,
    "autoSave": true,
    "requireApproval": true
  },
  "ui": {
    "showThinking": true,
    "startupAnimation": true
  },
  "toolDiscovery": {
    "mode": "auto",
    "eagerToolCount": 10,
    "schemaTokenBudget": 8000,
    "maxLoadedTools": 15,
    "searchLimit": 5
  },
  "toolExecution": {
    "maxConcurrent": 4
  },
  "agents": {
    "mode": "adaptive",
    "maxConcurrent": 3,
    "maxSpawned": 8,
    "maxDepth": 1,
    "persist": true,
    "includeUntrackedInSnapshot": true,
    "telemetry": true,
    "retentionDays": 30,
    "checks": {
      "test": "npm test",
      "typecheck": "npm run typecheck"
    }
  }
}
```

`compactStrategy` accepts `summary` (default) or `zero-mem`. `summary` preserves the existing
LLM-generated checkpoint behavior. `zero-mem` keeps the original session transcript authoritative,
builds a session-scoped BGE-M3/NER index, incrementally indexes completed turns, and retrieves
query-specific evidence before each main-agent run. It does not persist retrieved evidence as a
checkpoint. Under Zero-Mem, manual `/compact` initializes or refreshes the index and reports
readiness without replacing conversation history. Set it from `/config` (shortcut `R`) or with
`/config compact-strategy zero-mem`; `BOOK_COMPACT_STRATEGY` overrides the setting.

`compactModel` is optional. When set, manual and automatic `/compact` calls use that configured
provider/model only for checkpoint generation while normal agent turns continue on `model`. The
`BOOK_COMPACT_MODEL` environment variable overrides the setting. This is useful when a cheaper
reducer preserves the active model's accuracy; validate the pairing with `npm run eval:compact`
before making it a shared default. You can set it without editing JSON:
open `/config` and choose **Compact model** (shortcut `C`), or run
`/config compact-model 9router/ag/gemini-3.6-flash-high` (or `/config compactModel=...`).

`toolDiscovery.mode` accepts `auto`, `eager`, or `deferred`. Auto mode sends all authorized definitions only when there are at most ten and their schemas fit the configured budget; otherwise the provider receives the practical core plus `ToolSearch`. Search never returns tools outside the current command, skill, agent-role, permission-mode, or runtime-state capability intersection.

Tool execution is serial by default. Consecutive calls explicitly reviewed as parallel-safe (`Read`, `Glob`, `Grep`, `GitStatus`, `GitDiff`, `GitLog`, and `GitBranch`) run as bounded ordered waves; every other call is a barrier. Preparation, hooks, mode checks, and permission prompts remain sequential, while wave results are published in provider order without discarding successful siblings when another fails. `toolExecution.maxConcurrent` sets the session-wide limit shared by the root and managed children (default `4`, maximum `8`).

### Tool-use telemetry

When `observability.toolTelemetry` is enabled (default), Book appends one JSON line per finalized tool call to `~/.book/telemetry/tool-use.jsonl` (override the directory with `BOOK_TOOL_TELEMETRY_DIR`). Each record captures the canonical tool, the final status the model saw, a derived `isFailure` flag (`error`/`timed_out` only — permission blocks, plan-mode blocks, user declines, and cancellations are never counted as failures), the error code, duration, retries, model, and subagent attribution. The write is best-effort and off the hot path; it never blocks or fails a session, and the active log is size-rotated into a single `.1` backup.

`book tool-stats` reads this log and reports, per tool, calls / failures / fail rate / p50 / p95 duration / retry rate, plus a per-model split and the most frequent error codes:

```
$ book tool-stats
Tool use — 1,204 calls across 37 sessions (2026-06-30 → 2026-07-27)
18 failed (1.5%)

TOOL          CALLS   FAIL   FAIL%      P50      P95   RETRY%
Bash            412     12    2.9%    120ms    2.1s      4.4%
ApplyPatch      210      4    1.9%     38ms    140ms     5.7%
Read            402      0    0.0%     15ms     34ms     0.0%
```

Use `--json` for a machine-readable aggregate, `--since <days>` to change the window, `--all` for full history, and `--prune` to drop records older than the window from disk. `observability.toolTelemetryRetentionDays` sets the default reporting window and the `--prune` target; disk use is otherwise bounded by log rotation. Records store outcomes and hashes only, never prompts or file contents. This is separate from the ephemeral in-session counters shown by `/usage`.

### Run evidence ledger (experimental)

`harness.mode` defaults to `off`, which is fully inert: no run identity, no timers, no files. Setting
it to `observe` records an append-only evidence ledger for each root request without changing what
the model sees or how the run behaves. Records land in
`~/.book/projects/<workspace-id>/harness/v1/runs/<yyyy-mm>/<root-run-id>.jsonl`, written by a single
writer as canonical JSON lines chained by SHA-256 record hashes and closed by a signed seal that
reports durability, dropped-event and storage-error counters, and evidence eligibility.

Persisted events are an allowlist of bounded scalars — turn, model-usage, tool start/finish,
permission decision, provider retry/stall, assistant-message, and managed-agent handoff facts, with
OpenTelemetry-mapped names pinned to Semantic Conventions v1.44.0. Prompts, completions, tool
arguments and output, file contents and paths, commands, URLs, and secrets are never written;
ambiguous values are omitted and accounted for. Observation is best-effort: a storage failure marks
the ledger incomplete and is reported to the host, but never fails or alters the user's run.
`shadow`, `active`, and `learn` are accepted by the schema but rejected before run setup.

### Execution workflows (experimental)

With `harness.mode = observe`, a run can use one of three built-in execution workflows. Select one
with `harness.workflow` in settings or `--harness-workflow <id>` for a single run; the CLI flag wins
and is never persisted, so a resumed process starts again from the settings value.

| Workflow       | Effect                                                                              |
| -------------- | ----------------------------------------------------------------------------------- |
| `minimal`      | Preserves current behavior. Adds no prompt text; provider messages match a run with no harness. |
| `safe-edit`    | Short plan before mutating work, narrow edits, targeted verification, extra confirmation. |
| `verify-heavy` | Explicit plan, deeper inspection, project verifiers, and stated evidence before completion. |

Workflows are **behavioral guidance, not enforcement**. Permissions, sandboxing, budgets, retries,
compaction, checkpoint/resume, and tool contracts stay owned by the trusted runtime; a workflow can
never broaden them. Requests the runtime does not implement are clamped and recorded rather than
silently ignored, and a workflow's free-form description is never rendered into the prompt.

The active workflow renders into the dynamic prompt zone, so switching workflows does not invalidate
the cached prompt prefix. Each run records the requested and effective workflow, its source and
reason, the registry and definition digests, every clamp, the override scope, and declared
complexity. Selection fails closed: a workflow chosen while `harness.mode` is `off` has no ledger to
record it, so both `book config set` and startup reject it, as they do an unknown or path-like ID.
Project-defined workflow files are not loaded; only built-in IDs resolve.

### Managed agents

Adaptive mode keeps targeted work inline and nudges the parent toward the read-only `explorer` profile after three successful root `Glob`/`Grep` queries. The reminder is advisory: the fourth lookup is still allowed. Broad exploration receives a purpose name such as `Trace authentication flow`; the reusable profile (`explorer`, `patcher`, or `validator`) remains separate. `--agents manual` keeps the same lifecycle tools but requires explicit user delegation; `--agents off` removes managed-agent tools and routing guidance.

Explorer and `reviewer` run in the parent workspace with a hard read-only capability boundary and do not require Git, snapshots, or worktrees. `reviewer` backs `/review`: it is restricted to `Read`, `Glob`, `Grep`, `GitStatus`, `GitLog`, and `GitBranch` — deliberately no diff tool, because the host supplies the review target. Because it is a trust boundary, a project agent definition named `reviewer` cannot replace its role, tools, isolation, or body; tune it through `agents.profiles.reviewer` instead. Such a definition is not silently discarded — `book doctor` reports which layer it came from and what to do about it. Patcher and validator runs retain synthetic Git snapshots and isolated worktrees under `~/.book/worktrees/<repo-hash>/<agent-id>`, with per-record state and transcripts under `~/.book/agents/<repo-hash>/records/`. `agents.maxConcurrent` controls active execution while `agents.maxSpawned` caps outstanding queued/running/waiting children; completed history does not consume the cap. Parent-facing lifecycle results contain compact summaries/evidence IDs, terminal handoffs preserve up to 50 KiB, and `AgentRead` retrieves larger results in bounded chunks. The TUI and SDK host can inspect detailed transcripts separately. A patcher commit cannot be applied until a distinct validator passes the exact candidate commit.

Child completion is delivered automatically to the correct parent session as a compact agent-update card and a persisted provider-facing notification; `AgentWait` is only an explicit synchronization barrier. Delivery is split into context-budgeted batches, retried with bounded backoff, and deduplicated by durable delivery ID before acknowledgement. Terminal rows freeze their duration and final preview, and lifecycle tool rows show semantic actions instead of serialized JSON prefixes.

Managed-agent state writes are atomic and coordinated per target. If Windows, an antivirus scanner, or another Book process temporarily holds a state file, running agents continue in memory while Book retries the newest pending state in the background. The TUI shows one non-modal storage warning and a short recovery notice. Operations that require durable setup before starting, including plans, snapshots, initial agent records, and evidence publication, fail cleanly with a retryable `agent_store_busy` error instead of leaving a partially started agent. Multiple Book processes may read the same repository store, but only the live owner may mutate an active agent.

Recoverable temp files and instance leases live beside managed-agent state under `~/.book/agents/<repo-hash>/`. Startup validates and promotes only the newest logical revision from an abandoned instance. Set `BOOK_DEBUG=1` to record safe `agent-store` lifecycle diagnostics such as degraded storage, retry recovery, stale-lock reclamation, and orphan-temp promotion; JSON payloads, prompts, transcripts, credentials, and environment values are not logged. See `docs/agent-store.md` for the storage and recovery policy.

Agent definition tool rules are strict capabilities. Missing or empty `tools` means no tools, while `*` explicitly inherits parent tools except recursive lifecycle, implicit user-question, and implicit MCP access. Argument rules such as `Bash(git status*)` are checked again at execution time. Built-in profiles use file/git tools and `Check`; arbitrary shell access requires an explicit custom-agent rule.

Running children and background shells appear in one flat job panel directly below the prompt, with `main` and each executable job listed at the same level. From an empty prompt, press Tab to cycle focus through `main` and the jobs. `/jobs` opens the panel for explicit management; `/tasks` remains an alias. Tab/Up/Down selects a row, Enter opens its transcript or output, `x` stops it, and Esc returns to the main prompt. Finished, failed, timed-out, and user-stopped jobs are removed from the active panel automatically; shell completion is preserved as a local notice and retained briefly for `BashOutput`/`DismissShell` compatibility.

`Bash` accepts `run_in_background: true` with an optional `title`, `max_runtime_ms`, `notify`, and `lifetime`. Session jobs are the default and end with Book. `lifetime: "persistent"` is explicit, receives a separate permission decision, and reattaches from repository-scoped state after Book restarts. `notify: "ui"` is the default, `"none"` suppresses completion delivery, and `"agent"` queues one bounded output tail for the parent model when it is idle. Persistent logs are bounded and are removed when the completed job is dismissed.

`/agents` explains where subagent definitions are configured rather than opening a second runtime dashboard. Import third-party Claude-style definitions with `/agents import <path>` to preview normalized tools and warnings, then `/agents import --confirm <path>` to install under `.book/agents/`. The lower-level `/agent <id>`, `/agent send <id> <message>`, `/agent stop <id>`, and `/agent apply <id> [evidence-id]` commands remain available for direct scripting and recovery.

Profile model precedence is invocation override, `agents.profiles.<name>.model`, definition frontmatter, then the parent model. `inherit` falls through rather than becoming a literal provider model. Stream-json and SDK hosts receive status, activity, question, permission, completion, and evidence events by default; high-volume child text deltas require `forwardSubagentText`.

> Snapshot privacy: non-ignored untracked files are written into the local Git object database so managed worktrees can reproduce the parent state. Ignore secrets and other sensitive local files before enabling agents. Dismissing or aging out an agent removes its managed worktree, branch, and orphaned snapshot ref. Agent telemetry stores metrics and hashes only, never prompts or file contents.

Book clears sessions and rotated debug-log backups after 30 days. Startup resolves and preserves the active session before cleanup, and the current debug log is never removed by age-based retention.

### Themes

Use `/theme` to open the keyboard theme picker, or switch directly with `/theme dark`, `/theme light`, or `/theme auto`. The selection is applied immediately and saved to `.book/settings.local.json` for the next launch. The built-in themes use a matched quiet-editorial palette with warm text, muted sage branding, terracotta user accents, and low-contrast surfaces.

Project themes can override any token in `.book/themes/<name>.json`. They appear automatically in the picker and can also be activated with `/theme <name>`. Theme files are partial and inherit unspecified values from the dark default:

```json
{
  "brand": "#AFC19D",
  "userAccent": "#D3A17E",
  "surface": "#20221D",
  "surfaceActive": "#30362B",
  "border": "#4B4D45",
  "selectionText": "#F3EEE4",
  "assistantAccent": "#AFC19D",
  "toolRail": "#6B7164"
}
```

### Environment variables

| Variable                                                                                          | Purpose                                                           |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `BOOK_API_KEY`                                                                                    | Default API key (or `{env:VAR}` in provider settings)             |
| `BOOK_BASE_URL`                                                                                   | Default OpenAI-compatible base URL                                |
| `BOOK_MODEL`                                                                                      | Default model                                                     |
| `BOOK_PROVIDER`                                                                                   | `anthropic` \| `openai` \| `auto`                                 |
| `BOOK_EFFORT`                                                                                     | Thinking effort level                                             |
| `BOOK_HOME`                                                                                       | User-state root (default `~/.book`)                               |
| `BOOK_WORKSPACE`                                                                                  | Default workspace                                                 |
| `BOOK_MAX_TOKENS` / `BOOK_MAX_TURNS`                                                              | Generation / turn limits                                          |
| `BOOK_COMPACT_STRATEGY`                                                                           | `summary` (default) or `zero-mem`                                 |
| `BOOK_COMPACT_MODEL`                                                                              | Model used only for compaction checkpoints                        |
| `BOOK_ZERO_MEM_MODEL_CACHE` / `BOOK_ZERO_MEM_LOCAL_FILES_ONLY`                                    | Zero-Mem model cache and download policy                          |
| `BOOK_RETRY_*` / `BOOK_REQUEST_TIMEOUT_MS` / `BOOK_STREAM_STALL_TIMEOUT_MS` / `BOOK_TOOL_RETRIES` | Retry and timeout tuning                                          |
| `BOOK_TOOL_TIMEOUT_MS` / `BOOK_TOOL_TELEMETRY_DIR`                                                | Tool timeout and telemetry location                               |
| `BOOK_WEB_ALLOW_HTTP`                                                                             | Opt into plain HTTP for `WebFetch` (disabled by default)          |
| `BOOK_WEB_ALLOW_PRIVATE_NETWORK`                                                                  | Opt into local/private web destinations (disabled by default)     |
| `BOOK_WEB_MAX_REDIRECTS`                                                                          | Same-origin redirect limit for `WebFetch` (default 5, maximum 10) |
| `BOOK_TUI_RENDERER`                                                                               | `safe`, `incremental`, or experimental scroll renderer            |
| `BOOK_DEBUG` / `BOOK_DEBUG_UI` / `BOOK_DEBUG_RENDER` / `BOOK_DEBUG_FLOW`                          | Debug logging flags                                               |
| `BOOK_DEBUG_FILE` / `BOOK_DEBUG_STDERR` / `BOOK_DEBUG_MAX_BYTES` / `BOOK_DEBUG_BACKUPS`           | Debug log destination and rotation controls                       |

`WebFetch` requires HTTPS by default, validates DNS results and the address used by the network
connection, blocks private/special-use destinations, and stops on cross-origin redirects so the
new origin receives its own permission decision. It returns Markdown by default; `format` can be
`markdown`, `text`, or sanitized `html`. `WebSearch` works without configuration through the
built-in Exa MCP provider and accepts optional `limit`, `domains`, `recencyDays`, and `country`
hints. Its provider endpoint is built in and cannot be overridden through settings or environment
variables.

The TUI defaults to the full-frame `safe` renderer on Windows to avoid ConPTY footer corruption
during deep transcript scrolling. Other interactive terminals default to `incremental`. Set
`BOOK_TUI_RENDERER=incremental` to opt into incremental rendering explicitly on Windows.

## Slash Commands

Create custom slash commands by adding Markdown files to `.book/commands/`:

```markdown
---
description: Check for spelling errors
---

Run a spell check on the codebase and fix any issues found.
```

Built-ins include session controls (`/clear`, `/resume`, `/compact`, `/rewind`, `/exit`,
`/help`), task and job controls (`/task`, `/jobs`, with `/tasks` as an alias), managed-agent
controls (`/agents`, `/agent`), config (`/model`, `/providers`,
`/effort [low|medium|high|xhigh|max]`, `/config`, `/permissions`, `/theme`), inspection
(`/status`, `/mcp`, `/cost`, `/usage` with `/stats` as an alias, `/context`, `/diff`, `/skills`,
`/memory`), local output and reload (`/export`, `/reload-skills`), release/support
(`/release-notes`, `/feedback`), agent prompts (`/init`, `/security-review`), and code review
(`/review`, see below).
`/model` switches models, while `/providers` opens the same picker for provider management. BYOK
providers you add - their credentials, model catalog, and active model selection - are saved to the
user-global `~/.book/settings.json` so they are shared across projects; such providers are labeled
`[BYOK]`, and selecting one of their models and pressing `Alt+D` removes it. `/effort` opens a
picker when called without an argument and saves successful selections to
`.book/settings.local.json`.

`/skills` opens the interactive skill manager. Select a skill with `↑`/`↓`, press `Space` to cycle its visibility (`auto`, `name-only`, `manual`, or `off`), press `E` to cycle execution consent (`inherit`, `ask`, or `deny`), and press `Enter` to prepare an explicit `$skill-name` request. `G` toggles the global emergency switch, `R` reloads the catalog, and `/reload-skills` performs the same reload from the command line. Overrides are saved in `.book/settings.local.json` under `skills.overrides`, `skills.execution`, and `skills.enabled`.

### Code review

`/review` is orchestrated by the host rather than run as an ordinary prompt. Book resolves the
change once — base commit, changed files, and a unified diff, including untracked files — and hands
that **immutable review target** to read-only `reviewer` agents. Reviewers never choose their own
scope, so a review cannot silently widen or drift onto unrelated changes.

```text
/review                       Review the working tree (tracked + untracked changes)
/review --base main           Review against the merge base with a ref
/review src/tools             Restrict the review to a file or directory
/review main...HEAD           Review a committed range
/review --deep                Four parallel lenses + an independent verification pass
/review --fix                 Deep review, then apply verified findings (implies --deep)
/review --help                Usage
```

A plain `/review` runs one structured pass. `--deep` fans out four specialized reviewers
(correctness, security, simplification, efficiency), merges and deduplicates their findings, drops
anything below 70% confidence, and then runs a **falsification pass**: an independent verifier tries
to disprove each candidate against the real code. Rejected findings are dropped; findings the
verifier could not reach stay `inconclusive` rather than being reported as real.

Coverage is explicit. If a reviewer fails, times out, or does not return the required JSON, the
report says so and the verdict is capped at `inconclusive` — a review never reports "clean" from
incomplete coverage. Output that fails the JSON contract is preserved verbatim in the report instead
of being discarded.

`--fix` applies only verified findings, one at a time, through the patcher → validator pipeline: a
patcher produces a patch candidate as evidence, a separate validator must approve that exact
evidence id (agents cannot approve their own work), and only then is it applied.

Drop a **`REVIEW.md`** at the workspace root to calibrate reviews for your repository — severity
conventions, known-noisy areas, project-specific rules. It is read fresh on every run and injected
as calibration only: it cannot change the output contract, disable verification, or broaden the
tools a reviewer may use.

To score the pipeline against a golden set, pair expectations with reports captured from real runs
and run `npm run eval:review -- <fixtures.json>`; it prints precision, recall, F1, usefulness rate,
and signal-to-noise ratio. See `evals/review/fixtures.example.json` for the format.

### Skills

Book reads interoperable directory packages whose entrypoint is `SKILL.md`:

```text
<root>/<skill-name>/
  SKILL.md
  references/   optional text references
  assets/       optional templates or other files
  scripts/      optional packaged scripts (never auto-executed)
```

`SKILL.md` must start with YAML frontmatter containing `name` and `description`. The body is loaded
only after activation; metadata, validation issues, resource manifests, and digests are available
for inspection without putting the body in the initial prompt. Use `references/` and `assets/` for
supporting material; Book reads declared resources only through `ReadSkillResource`, as untrusted
content. Scripts remain ordinary resources and can run only through Book's existing execution tools
and their normal approvals.

Discovery scans these roots from lowest to highest precedence: user `~/.claude/skills`, user
`~/.agents/skills`, user `~/.config/opencode/skills`, user `~/.book/skills`, then the matching
`.claude/skills`, `.agents/skills`, `.opencode/skills`, and `.book/skills` directories from the Git
root to the current working directory. Deeper project directories and native `.book` roots win;
duplicate names are shadowed rather than merged and are shown in `/skills` diagnostics. Skill
directories may be symlinked after canonical path and size checks; resource symlinks are rejected.

Visibility controls determine whether metadata participates in automatic matching: `auto` exposes
name and description, `name-only` exposes only the name, `manual` requires explicit `$skill-name`,
and `off` disables the skill. Project-sourced implicit activation requires consent. `ask` always
requests consent, while `deny` fails closed; no skill can grant tools, bypass permissions, alter the
sandbox, or execute a packaged script implicitly. Active instructions are scoped to the current run
by default (or the next model step for `lifetime: turn`) and tool declarations are intersections
with Book's existing authorized surface.

Newly discovered skills start in `manual` mode. After evaluating representative positive and
negative prompts, enable automatic matching per skill from `/skills` or by setting its override to
`auto`; this keeps implicit activation available without treating unmeasured skill descriptions as
a safe release default.

Use `/skills status` for a body-free runtime report containing the catalog digest, active and
previous activation frames, effective tool intersection, validation failures, prompt-catalog
omissions, and recent lifecycle outcomes. The equivalent settings shape is:

```json
{
  "skills": {
    "enabled": true,
    "overrides": {
      "review": "auto",
      "deploy": "manual"
    },
    "execution": {
      "deploy": "ask"
    }
  }
}
```

For portable packages, move an existing `.claude/skills/<name>/` or
`.opencode/skills/<name>/` directory to `.agents/skills/<name>/` without changing its `SKILL.md`.
Book continues to discover the compatibility locations, so migration can be gradual; use
`.book/skills/<name>/` only when the package intentionally depends on Book-specific behavior.

Book watches skill roots and applies changes at the next safe run boundary. If an editor, network
filesystem, or platform watcher misses an update, use `R` in the manager or `/reload-skills` and
inspect `/skills status`; watcher errors are also shown in the manager. Reload clears lazy body
caches, expires affected frames, refreshes the catalog digest, and invalidates agent context without
rewriting an in-flight request.

Activation quality can be gated with
`npm run eval:skills -- observations.jsonl [report.json] [report.md]`. The report measures precision,
recall, false-activation cost, prompt/body token cost, activation latency, consent prompts, task
completion, corrections, and skill-caused tool failures across direct, indirect, negative,
ambiguous, conflicting, disabled, invalid, missing-body, and missing-resource cases. Reports retain
prompt hashes and aggregate evidence rather than raw prompts, skill bodies, or resource contents.
Run `npm run eval:skills -- --help` to print the command syntax.

`/rewind` first selects an active user prompt, then restores Conversation, Code, or Both to the state immediately before that prompt. Files are captured into local content-addressed snapshots under `~/.book/rewind/`; `--no-session-persistence` uses temporary storage that is removed on exit. `.git` and workspace-local `.book/` state are never captured by default, Git HEAD and the index are never moved, and Code/Both are disabled when HEAD drifted or a checkpoint exceeded its safety limits. Use `.book/rewindignore` to override the default exclusions for dependency, build, cache, coverage, and virtual-environment directories, or to explicitly opt selected `.book` paths back in. Other hidden, gitignored, and secret-like workspace files remain restorable; their contents stay in local blobs and are never written to session JSON or model context.

## SDK Usage

```typescript
import { query } from 'book';

for await (const event of query('Explain this code', {
  workspace: process.cwd(),
  onUserQuestionRequired: async (request) => ({
    action: 'answer',
    answers: Object.fromEntries(
      request.questions.map((question) => [
        question.question,
        question.multiSelect ? [question.options[0].label] : question.options[0].label,
      ]),
    ),
  }),
})) {
  if (event.type === 'text') process.stdout.write(event.content);
  if (event.type === 'tool_use') console.log('tool:', event.toolCall.name);
  if (event.type === 'result') console.log('usage:', event.usage);
}
```

`AskUserQuestion` supports 1-4 questions, described single/multi-select choices, and free-text answers in the TUI. Print mode emits `user_question` / `user_question_result` stream events and declines deterministically when no callback is supplied. Managed workers additionally emit `agent_start`, `agent_update`, `agent_result`, `agent_question`, `evidence_update`, and `agent_apply`. Background shells emit `background_job_start`, `background_job_update`, `background_job_output`, `background_job_result`, and `background_job_dismiss` through stream JSON and the SDK.

Auth and model selection come from settings / env (`BOOK_API_KEY`, `BOOK_MODEL`, provider blocks), not from `query()` options. See `src/sdk.ts` for the full `QueryEvent` / `QueryOptions` surface.

For direct lifecycle control, create a manager with `createAgentManager(loadConfig(workspace))`; its public operations cover planning, spawning, listing, inspection, sending/resuming, waiting, stopping, evidence publishing/review, and validated application.

## Development

```bash
npm run typecheck    # TypeScript check
npm test             # Build, then run unit + contract + integration suites
npm run test:unit    # Deterministic unit suite
npm run test:contract
npm run test:integration # Isolated PTY/process suite (one worker)
npm run check        # Format, lint, types, architecture, unit, and contract checks
npm run test:watch   # Watch mode
npm run test:coverage
npm run build        # tsup → dist/
npm run dev          # Run via tsx
npm run lint         # ESLint
npm run format       # Prettier
npm run format:check
npm run bench:ui     # TUI micro-benchmarks
npm run bench:runtime # Runtime micro-benchmarks
npm run eval:edit    # Edit reliability evaluation (configured provider)
npm run eval:compact # Compaction paired evaluation (configured provider)
npm run eval:zero-mem # Zero-Mem retrieval/compaction comparison
npm run eval:skills  # Skill activation evaluation
npm run verify:ink-patch
npm run release:check # Version, audit, and package smoke checks
```

Main-branch runtime work also follows the [stabilization gate](docs/stabilization.md): three
consecutive green full CI runs and no open lifecycle or accounting regression issues.

## License

Copyright (c) 2026 letrquan. All rights reserved.

Proprietary software. No permission is granted to use, copy, modify, or distribute this software without prior written authorization.
