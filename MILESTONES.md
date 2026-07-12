# Book Milestone Plan

Goal: make Book a working Claude Code clone first, then a custom harness platform.

Each phase lists exactly what's missing and what to build. `[has]` = already exists. `[STUB]` = exists but delegates to agent instead of doing the real thing. `[MISSING]` = doesn't exist.

---

## Phase 1: Make it actually work as a Claude Code clone

### 1a. Anthropic provider [has] ✅ (2026-07-03)
Without this, Book can't use Claude models at all. Currently only OpenAI-compatible.

- [x] `src/provider/anthropic.ts` — Anthropic Messages API streaming (SSE)
- [x] `src/provider/index.ts` — Auto-detect provider from `baseUrl`
- [x] Support `cache_control` blocks for prompt caching
- [x] Support extended thinking (`thinking` param, `--effort` flag)
- [x] `stream_options.include_usage` for token tracking
- [x] **CLI flags**: `--effort` (low/medium/high/xhigh/max)
- [x] `--effort` also writable via `BOOK_EFFORT` env var
- [x] Use adaptive thinking by default: `thinking: {type: "adaptive", display: "omitted"}`
- [x] Anthropic SSE events handled: message_start, content_block_start/delta/stop, message_delta/stop, ping, error
- [x] Message format conversion: system prompt extraction, tool results → tool_result blocks
- [x] Tool definition conversion: OpenAI format → Anthropic `{name, description, input_schema}`

### 1b. CLAUDE.md loader [has] ✅ (2026-07-04)
Book starts every session with Claude-Code-style project instructions loaded.

- [x] Walk tree from workspace to root, collecting CLAUDE.md files
- [x] `~/.claude/CLAUDE.md` (user-global, always loaded)
- [x] `./CLAUDE.md` or `./.claude/CLAUDE.md` (project, version-controlled)
- [x] `CLAUDE.local.md` (personal, gitignored)
- [x] `.claude/rules/*.md` (modular rules; currently injected as standing prompt guidance)
- [x] Merge order: user → project → local → rules (later wins)

### 1c. Rich system prompt [has] ✅ (2026-07-09)
Book now builds a structured Claude-Code-style prompt from local project context, split into a cacheable static prefix and dynamic per-turn suffix.

- [x] Inject CLAUDE.md content
- [x] Inject auto memory (MEMORY.md index)
- [x] Inject git branch/status
- [x] Inject platform info (OS, hostname, date)
- [x] Inject skill listing with descriptions
- [x] Inject slash command listing
- [x] Inject subagent listing
- [x] Inject agent todo list (when non-empty)
- [x] Inject MCP tool descriptions (via active ToolDefinition descriptions)
- [x] Two-zone: cached static prefix + dynamic per-turn suffix — `buildSystemPromptZones()` emits cached prefix + dynamic suffix; Anthropic caches only the static system block.
- [x] Structure: persona → CLAUDE.md/rules → context → tools → memory → guardrails

### 1d. Auto memory system [has] ✅ (2026-07-04)
Without persistence, every session is amnesia. Memory makes the agent compound across sessions.

- [x] File-based store in `~/.book/projects/<project>/memory/` — `memory-store.ts` `getProjectMemoryDir()`
- [x] `MEMORY.md` index (first 200 lines loaded at session start) — `loadMemoryContext()`, `DEFAULT_MAX_INDEX_LINES = 200`
- [x] 4 memory types: user, feedback, project, reference — `MEMORY_TYPES`
- [x] YAML frontmatter on each memory file — `renderMemoryMarkdown()` writes `type/status/source/created/updated/confidence/tags`
- [x] Write memories on user corrections/confirmations — `memory-autosave.ts` `detectMemoryCandidate()` + `maybeCaptureMemoryCandidate()`, called from `agent/loop.ts` on every user turn
- [x] `/memory` command showing loaded files, toggle auto-save — handler in `tui/app.tsx`, subcommands `status|inbox|approve|discard|on|off|path`
- [x] Settings: `enabled`, `autoSave`, `requireApproval` — `memorySettingsSchema` in `settings.ts`

**Beyond spec (approval flow):** auto-captured candidates land in `.inbox/` as `pending`; `/memory approve` or `/memory discard` commits them, with symlink + path-escape guards (`approveMemoryCandidate`/`discardMemoryCandidate`). `secret-detect.ts` rejects secrets/unfit text before writing. `agent/context.ts` injects the loaded `MEMORY.md` index into the system prompt (feeds 1c's "Inject auto memory" item).

### 1e. Missing tools (basic coverage)

**Task tools** [has] ✅ (2026-07-06) — CC deprecated TodoWrite for these:
- [x] `TaskCreate` — create a task with status/dependencies/metadata
- [x] `TaskList` — list all tasks
- [x] `TaskGet` — get task details
- [x] `TaskUpdate` — update status, dependencies, delete tasks
- [x] `TaskStop` — stop an in-progress tool-managed task (background process/subagent stopping deferred until shell/background infra exists)

Task state is shared via `AgentConfig` across agent-loop invocations in a session; blocked tasks cannot be moved to `in_progress`, and completed/deleted dependencies unblock dependents.

**Shell tools** [has] ✅ (2026-07-06):
- [x] `BashOutput` — read output from a backgrounded shell by ID
- [x] `KillShell` — terminate a backgrounded shell by ID
- [x] `run_in_background` param on Bash

Background shell state is shared via `AgentConfig` for TUI/headless session continuity. Background stdout/stderr pipes are unrefed, spawn failures are surfaced before returning a shell ID, explicit background timeouts terminate shells, and `KillShell` waits for process exit before reporting terminal status. Session-exit cleanup and TaskStop ownership integration are deferred until shell ownership semantics are defined.

**Plan mode tools** [has] ✅ (2026-07-09):
- [x] `EnterPlanMode` — agent enters plan mode (read-only tools auto-approved)
- [x] `ExitPlanMode` — agent presents plan for user approval

Plan mode is enforced in the agent loop: read-only exploration/status tools auto-run, mutating tools are blocked with `SKIPPED`, and `ExitPlanMode` gates leaving plan mode on host approval (TUI prompt; headless rejects by default unless bypassing permissions).

**Code intelligence** [MISSING]:
- `LSP` — go-to-definition, find-references, diagnostics, hover

**Other tools** [PARTIAL ✅ 2026-07-11]:
- [x] `NotebookEdit` — replace/delete cells by ID, insert at the beginning or after a target, preserve unrelated notebook data, and return file mutation diffs
- [ ] `ReportFindings` — structured code-review findings output
- [ ] `ToolSearch` — deferred tool loading to keep initial context lean
- [ ] `Workflow` — multi-agent orchestration scripts (pipeline/parallel)
- [ ] `Monitor` — run command in background, react to each output line

### 1f. Built-in slash commands that actually work [PARTIAL ✅ 2026-07-03]

The STUB commands now do the real thing locally (no longer delegate to the agent for local-side work). Several previously-missing commands were added; the rest are blocked on subsystems from later phases (1b/1d/1h/1i, Phase 2) and are annotated with their blocker.

| Command | Book status | What CC actually does |
|---------|-------------|----------------------|
| `/init` | ✅ real (tool-restricted prompt → agent analyzes + writes CLAUDE.md) | Generates CLAUDE.md from codebase analysis |
| `/model` | ✅ real (arrow-key picker + effort axis; `/model <name>` switches) | Opens model picker UI with effort level |
| `/config` | ✅ real (no-arg dump, `key=value` persist to settings.local.json, `--help`) | Opens settings interface, supports key=value |
| `/permissions` | ✅ real (toggle view of mode + allow/ask/deny rules) | Interactive dialog: add/remove rules, view scopes |
| `/cost` | ✅ real (token counts + local USD estimate from PRICING table) | Shows real session cost with per-model breakdown |
| `/memory` | ✅ real (reads `~/.book/projects/<slug>/memory/` + MEMORY.md index) | Shows loaded files, toggle auto-save, browse |
| `/diff` | ✅ real (`git diff` output locally) | Shows git diff |
| `/export` | ✅ real (writes messages to file) | Exports conversation to file |
| `/skills` | ✅ real (toggle listing of discovered skills) | List available skills |
| `/compact` | exists | OK |
| `/clear` | exists | OK |
| `/help` | exists | OK |
| `/status` | exists | OK |
| `/theme` | exists | OK |
| `/doctor` | basic CLI command | Full diagnostic with fix-it button |
| `/usage` | ✅ real (NEW) — session cost & token usage (alias `/stats`) | — |
| `/context` | ✅ real (NEW) — message/tool-call counts + char/4 token estimate, ambient context breakdown | — |
| `/review` | ✅ real (NEW) — tool-restricted prompt drives an agent review of the current diff | — |
| `/security-review` | ✅ real (NEW) — OWASP-shaped agent audit of the current diff | — |
| `/release-notes` | ✅ real (NEW) — installed version + CHANGELOG.md tail | — |
| `/feedback` | ✅ real (NEW) — writes a non-secret session snapshot to `.book/feedback/` | — |

**Still-missing built-in commands** (blocked on later phases, not implemented here):
- `/vim` — toggle vim editing mode **(blocked on 1h: vim input mode)**
- `/keybindings` — create/edit keyboard shortcuts config **(blocked on 1i: keybindings)**
- `/terminal-setup` — configure Shift+Enter for terminal **(blocked on 1h/1i)**
- `/agents` / `/subagents` — manage subagents (create, edit, list) **(needs richer subagent infra)**
- `/workflows` — list/manage workflows **(blocked on 1e: Workflow tool)**
- `/plugin` — manage plugins **(Phase 3: plugin system)**
- `/mcp` — manage MCP servers interactively **(needs interactive MCP manager)**
- `/add-dir` — add additional working directories **(blocked on 1g: `--add-dir` flag)**
- `/ide` — connect to IDE extension **(Phase 3)**
- `/rewind` — roll back to checkpoint **(needs checkpoint/restore infra)**
- `/resume` — resume a previous session (interactive picker) **(headless `--resume` exists; interactive TUI picker + hot-swap of history is new work)**

> `/memory` is fully wired now that 1d's auto-write + approval flow have landed — candidates are captured to `.inbox/` and surface in `/memory inbox` for review, `/memory approve|discard` commits them. `/usage` tracks the active model only; a per-model breakdown across a multi-model session is deferred (needs accounting plumbing in Phase 2/3).

### 1g. CLI flags [MISSING]

Book has: `--workspace`, `--model`, `--print`, `--output-format`, `--input-format`, `--max-turns`, `--max-budget-usd`, `--permission-mode`, `--verbose`, `--json-schema`, `--resume`, `--continue`, `--session-id`, `--name`, `--no-session-persistence`, `--fork-session`, `--scrollback`, `--settings`, `--no-settings`, `--effort`

> Deferred in the 2026-07-09 milestone pass: this slice focused on 1c prompt caching and 1h/1i TUI keybindings. CLI flag plumbing touches CLI/headless/TUI/SDK paths and should be handled in a dedicated follow-up.

Missing:
- `--system-prompt <text>` — inject one-off system prompt
- `--context <text>` — add extra context text
- `--allowed-tools <list>` — restrict tools (e.g. `Read,Grep`)
- `--disallowed-tools <list>` — block specific tools
- `--bare` — minimal mode: skip plugins, MCP, auto memory, CLAUDE.md
- `--add-dir <path>` — add additional working directories
- `--agents <json>` — spawn background agents from CLI
- `--bg <prompt>` — run a background session
- `--fallback-model <model>` — fallback model chain
- `--mcp-config <path>` — MCP server config file
- `--plugin-dir <path>` — plugin directory
- `--dangerously-skip-permissions` — skip all permission prompts
- `--debug <filter>` — debug logging with filter

### 1h. Input/editing features [PARTIAL ✅ 2026-07-09]

- [x] **Multiline input quick win** — Ctrl+J and terminal-supported Shift+Enter append a newline without submitting
- [ ] **Vim mode** — vim keybindings in the input area (hjkl, visual mode, operators)
- [ ] **Ctrl+R history search** — reverse search through command history
- [ ] **External editor** — Ctrl+G to open prompt in $EDITOR
- [ ] **Image paste** — Ctrl+V to paste image from clipboard
- [ ] **Stash prompt** — Ctrl+S to stash current input
- [ ] **Fullscreen rendering** — alt-screen mode (Book uses pi-style scrollback, CC has fullscreen mode with mouse support)
- [ ] **Terminal bell** — notification when Claude finishes a response

### 1i. Keyboard shortcuts [PARTIAL ✅ 2026-07-09]

Book has: Esc (cancel), Ctrl+C (cancel current turn), Ctrl+T (tasks), Ctrl+L (redraw), Ctrl+J / Shift+Enter (newline, terminal support permitting), Alt+M (cycle mode), Meta+P (model picker), Up/Down (history), Ctrl+/ (keyboard shortcuts reference)

Missing:
- Ctrl+R — reverse history search
- Ctrl+G — open external editor
- Ctrl+S — stash current prompt
- Ctrl+V — paste image
- Meta+O — toggle fast mode
- Meta+T — toggle extended thinking
- Ctrl+X Ctrl+K — kill all background agents

---

## Phase 2: Harness platform (what makes it YOUR platform)

Once Phase 1 is done, Book is a working CC clone. Phase 2 is where it diverges — these are the extension points for your own experiments.

### 2a. Provider abstraction [MISSING]
The agent loop hard-imports the provider. Make it pluggable.

- `Provider` interface: `stream(messages, tools, opts) → AsyncGenerator<ProviderStreamEvent>`
- Provider factory in config — select by `baseUrl` or explicit `--provider` flag
- Mock provider for testing (no network needed)

### 2b. Agent loop hooks [MISSING]
Intercept every stage of the loop without forking.

- `onPreModelCall(messages, tools)` — modify messages/tools before API call
- `onPostModelCall(response)` — inspect model response
- `onPreToolDispatch(toolCall)` — intercept/modify individual tool calls
- `onPostToolDispatch(result)` — inspect tool results
- `onCompactionDecision(usage)` — override compaction trigger
- `onTurnComplete(turn)` — per-turn telemetry
- Dynamic tool registration at runtime
- Custom system prompt parts (register a function → string)
- Configurable compaction strategy
- `--harness <path>` CLI flag to load a harness module

### 2c. Working SDK [MISSING]
The `query()` SDK parses its own stdout JSON. Fix it to emit typed events directly.

- Emit typed events: `system`, `text`, `tool_use`, `tool_result`, `error`, `result`, `done`
- Session resume in headless mode (currently broken)
- CI-friendly exit codes (0=success, 1=error, 2=max turns/failed)
- `--max-budget-usd` enforced (stop loop when cost exceeds budget)
- `--json-schema` wired through provider for structured output

---

## Phase 3: Polish (later)

- **Plugin system** — marketplace, discovery, `/plugin` command
- **Cost tracking** — per-model pricing, `/cost` with breakdown, usage attribution
- **Scheduled tasks** — cron-based execution, `/schedule`, `/loop`
- **IDE integration** — VS Code extension basics (at minimum LSP integration)
- **Multi-repo** — `--add-dir`, cross-directory tool access
- **Bundled skills** — `/batch`, `/code-review`, `/simplify`, `/init` (real implementation)
- **Auth/OAuth** — `/login`, credential management
- **Observability** — OpenTelemetry, structured logging
- **Concurrent tool execution** — parallelize independent tool calls
- **Worktree isolation** — subagents in isolated git worktrees
