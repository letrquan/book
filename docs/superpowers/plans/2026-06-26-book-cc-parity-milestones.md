# Book → Claude Code Parity — Milestone Plan

> **For agentic workers:** This plan is the master roadmap. Implement milestone-by-milestone; within a milestone, epics are roughly independent unless a dependency is listed. Reference the evidence base in `docs/superpowers/research/2026-06-26-book-cc-parity-gap-analysis.md`.

**Date:** 2026-06-26
**Goal product (north star):** Claude Code (`docs.claude.com`).
**Subject:** `book` AI coding agent CLI v0.1.0 (`I:/MyProject/02-AI-ML-Projects/book`).

---

## Executive summary

Book v0.1.0 is a working *scaffold*: Commander entry → Ink TUI → a single streaming agent loop → OpenAI-compatible provider → a pluggable tool registry (file/shell/git implemented, design/browser stubbed) → a 6-mode permission system with a persisted rule store → a Claude-Code-style theme-token set. That is a genuine foundation, but it is **two layers deep where Claude Code is ten**.

The gap falls into four buckets:

1. **Correctness bugs that break the core loop.** The most severe is that `context.ts` never threads `tool_calls` or tool-result messages back into the provider request — so the model has *no memory of what its tools returned* across turns. Combined with a bogus `max_turns` body param, no 429 retry, and no abort, the agent is unreliable even for single tasks. These must be fixed first.
2. **Tool & agent parity.** Book lacks `TodoWrite`, `Task` (subagents), `MultiEdit`, `WebFetch`, `WebSearch`, `replace_all`, real `Grep` output modes, `.gitignore` respect, and image input. It also uses non-standard tool names. Without `TodoWrite` and `Task`, book cannot do long or parallel work.
3. **Headless & session.** No `--print`/`-p`, no session persistence, no resume, no compaction. This blocks CI/scripted use entirely — a stated Claude Code pillar ("run it in CI, pipe logs into it").
4. **Extensibility surfaces.** Book has none of the four Claude Code surfaces — skills, subagents, hooks, MCP — nor plugins, output styles, or layered settings. The whole `.book/` convention does not exist.

The plan below sequences these into **nine milestones (M1–M9)**. M1 hardens the foundation; M2–M3 reach tool + headless parity; M4–M5 add permissions/sandbox + hooks; M6–M7 add skills/slash-commands and subagents/MCP; M8 opens the SDK; M9 polishes UX. **Recommended first milestone: M1** (foundation hardening) — it is small, removes the critical correctness bug, and unblocks every later milestone.

---

## Milestones at a glance

| Milestone | Title | Goal | Effort rollup |
|---|---|---|---|
| M1 | Foundation Hardening | Fix the bugs that make the loop unreliable; real tests | S–M |
| M2 | Tool Parity | CC tool names + MultiEdit/TodoWrite/WebFetch/Grep modes/.gitignore | M–L |
| M3 | Headless & Sessions | `--print`, output formats, session persistence, resume, compaction | L |
| M4 | Permissions & Layered Settings | `Tool(spec)` rules, settings.json layering, live reload, bash sandbox | L–XL |
| M5 | Hooks | 11 lifecycle events, JSON-stdio, config, exit-code/block semantics | L |
| M6 | Slash Commands & Skills | `.book/commands` + `.book/skills` (SKILL.md, model-invoked, budgets) | M–L |
| M7 | Subagents & MCP | `.book/agents` + `Task` tool + MCP client (`mcp__` tools) | XL |
| M8 | Agent SDK | Programmatic `query()` API, `book -p` for CI | L |
| M9 | UX Polish | Fullscreen/scroll, diff view, vim, themes, status line, `/help` palette | L |

**Dependency graph:**
```
M1 ─┬─> M2 ─> M3 ─┬─> M6 ─> M7
    │            │
    ├─> M4 ──────┼─> M5 ─┬─> M7
    │            │       └─> M8
    └────────────┴─> M9 (can start UI scaffolding after M1)
```
- M2, M4, M9 can all start once M1 lands.
- M3 needs M2 (standard tool names help JSON output).
- M5 (hooks) needs M4 (settings layering to store hooks config).
- M6 (skills) needs M3 (session/compaction so skill listings don't blow context).
- M7 (subagents/MCP) needs M5 (SubagentStop hook) + M6 (skill/agent file conventions).
- M8 (SDK) needs M3 (headless) and reuses M7's agent primitives.

---

## M1 — Foundation Hardening

**Goal:** Make the agent loop actually correct and reliable. No new features — just fix the bugs that break what exists, and add the tests that should have been there.
**DONE when:** (a) the model can see its own tool results across turns; (b) 429s retry with backoff; (c) Ctrl+C cancels a stream cleanly; (d) `npm test` covers context/loop/provider/tools; (e) `book` runs end-to-end on a real prompt without phantom bugs.

### Epic M1.1 — Thread tool calls & results into provider messages 🔴 critical · effort S
- **Closes gap:** A/B1 (tool results discarded).
- **What:** `src/agent/context.ts buildMessages()` must emit, for each assistant message, `content` **and** `tool_calls` (OpenAI shape: `{id, type:'function', function:{name, arguments}}`), and for each tool result a `role:'tool'` message (`{tool_call_id, content}`). Verify the provider type accepts these.
- **Files:** `src/agent/context.ts`, `src/types.ts` (Message already carries toolCalls/toolResults — wire them through).
- **Depends on:** nothing.

### Epic M1.2 — Fix provider request body 🔴 critical · effort S
- **Closes gap:** B2.
- **What:** Remove `max_turns` from the request body in `src/provider/openai-compatible.ts`. Pass `max_tokens`/`max_completion_tokens` only if the model config requests it. Keep `stream:true`.
- **Files:** `src/provider/openai-compatible.ts`.

### Epic M1.3 — 429 backoff + retry 🟠 high · effort S
- **Closes gap:** B3.
- **What:** On HTTP 429 (and 5xx), retry with exponential backoff (1s→2s→4s→8s, cap 3 retries) honoring `Retry-After` when present. Surface "Rate limited, retrying…" via `onError`-equivalent but do not abort the loop.
- **Files:** `src/provider/openai-compatible.ts`.

### Epic M1.4 — Abort / cancel mid-stream 🟠 high · effort M
- **Closes gap:** B4.
- **What:** Plumb an `AbortController` from `useAgent` → `runAgentLoop` → `chatCompletionStream`. Esc / Ctrl+C while thinking aborts the in-flight fetch, finalizes the partial assistant message, and returns to the prompt. Wire Ink's `useInput` Esc-while-thinking (currently Esc only cancels pending permission).
- **Files:** `src/agent/loop.ts`, `src/provider/openai-compatible.ts`, `src/tui/hooks/useAgent.ts`, `src/tui/app.tsx`.

### Epic M1.5 — Real token accounting 🟡 medium · effort M
- **Closes gap:** B8.
- **What:** Parse `usage` from the final SSE chunk (or non-stream response) and emit a structured `onUsage({prompt, completion, total, cost?})` callback. `StatusLine` shows real numbers; lay a `CostAccumulator` for later `--max-budget-usd`/`/cost`.
- **Files:** `src/provider/openai-compatible.ts`, `src/types.ts` (extend `AgentLoopCallbacks`), `src/tui/hooks/useAgent.ts`, `src/tui/components/StatusLine.tsx`.

### Epic M1.6 — Test the core 🟡 medium · effort M
- **Closes gap:** B10.
- **What:** Add `vitest` tests: `context.test.ts` (tool_calls/tool messages emitted correctly, ordering), `loop.test.ts` (with a fake provider yielding canned stream events — verify sequential exec, maxTurns, permission deny path), `provider.test.ts` (SSE parsing, 429 retry, abort), `tools/file.test.ts` (edit replace_all, grep output_mode), `permissionStore.test.ts` (deny→ask→allow ordering).
- **Files:** new `src/**/*.test.ts`.
- **Depends on:** M1.1, M1.2 (so tests assert the fixed behavior).

---

## M2 — Tool Parity

**Goal:** Bring the built-in tool suite to Claude Code's surface area and naming so prompts, permission rules, and hooks translate 1:1.
**DONE when:** tools are named `Read/Write/Edit/MultiEdit/Glob/Grep/Bash/TodoWrite/WebFetch/WebSearch`; `Edit` supports `replace_all` and returns a diff; `Grep` supports `output_mode` + context lines; `Glob`/`Grep` respect `.gitignore`; `TodoWrite` drives the existing TaskList UI.

### Epic M2.1 — Rename tools + add `replace_all` + diff 🟠 high · effort S
- **Closes gaps:** C (rename, B6).
- **What:** Rename `read_file→Read`, `write_file→Write`, `edit_file→Edit`, `glob→Glob`, `grep→Grep`, `bash→Bash`. Add `replace_all?: boolean` to `Edit`. Return a unified diff in the tool result output so `ToolCallBlock` can render it. Keep `git_*` tools (CC has no first-class git tool — it uses `Bash(git …)`; decide: keep `git_*` as convenience aliases or drop in favor of Bash + permission rules).
- **Files:** `src/tools/file.ts`, `src/tools/shell.ts`, `src/tools/git.ts`, `src/tools/registry.ts`, `src/tui/components/ToolCallBlock.tsx` (diff renderer), `src/agent/context.ts` (system prompt tool names).
- **Migration:** keep old names as aliases for one release to avoid breaking saved permission rules.

### Epic M2.2 — `MultiEdit` 🟡 medium · effort S
- **Closes gap:** C.
- **What:** New tool applying an ordered list of `{oldString,newString,replaceAll?}` edits atomically (all-or-nothing). 
- **Files:** `src/tools/file.ts`.

### Epic M2.3 — `Grep` output modes + context + multiline 🟠 high · effort M
- **Closes gap:** C.
- **What:** Add `output_mode` (`content` default / `files_with_matches` / `count`), `-n`/`-A`/`-B`/`-C` context, `multiline` flag, `head_limit`. Use ripgrep (`rg`) when available (matches CC), fall back to JS regex. Truncate large output.
- **Files:** `src/tools/file.ts`.

### Epic M2.4 — `.gitignore` respect 🟠 high · effort S
- **Closes gap:** B5.
- **What:** Wire the already-installed `ignore` package into `Glob`/`Grep`/`Read`'s file discovery. Add `respectGitignore` config (default true).
- **Files:** `src/tools/file.ts`, `src/config.ts`.

### Epic M2.5 — `TodoWrite` 🔴 critical · effort M
- **Closes gap:** C.
- **What:** Implement the model-driven todo tool: `todos: [{content, status: 'pending'|'in_progress'|'completed', activeForm}]`. Enforce "only one in_progress at a time". Feed the list into the existing `useTasks`/`TaskList` UI (rename concept: these are *agent* todos, distinct from user `/task`). Inject the current todo state into the system prompt each turn so the model tracks progress.
- **Files:** new `src/tools/todo.ts`, `src/tools/registry.ts`, `src/tui/hooks/useTasks.ts`, `src/tui/components/TaskList.tsx`, `src/agent/context.ts`.
- **Depends on:** M1.1 (so tool results round-trip).

### Epic M2.6 — `WebFetch` + `WebSearch` 🟠/🟡 · effort M
- **Closes gap:** C.
- **What:** `WebFetch(url, prompt)` fetches + converts HTML→markdown (use a small dep or `undici`+regex), then the model summarizes via a sub-prompt. `WebSearch(query)` calls a search backend (pluggable; default to a configured endpoint). Respect `WebFetch(domain:…)` permission rules (M4).
- **Files:** new `src/tools/web.ts`, `src/tools/registry.ts`.

### Epic M2.7 — Decide design/browser tools 🟡 medium · effort M/L
- **Closes gap:** B9.
- **What:** Either implement `design_*` as real prompt-based analysis tools (or remove them), and either wire CDP for `browser_*` (dep `chrome-remote-interface`) or remove and document `--chrome` as future. Recommend: remove stubs for now, re-add browser in M9 as an MCP/CDP module.
- **Files:** `src/tools/design.ts`, `src/tools/browser.ts`, `src/tools/registry.ts`, `.bookrc.json`.

---

## M3 — Headless & Sessions

**Goal:** Make `book` scriptable and resumable — the Unix-philosophy core CC sells ("pipe logs into it, run it in CI").
**DONE when:** `book -p "query"` prints a result and exits; `--output-format json|stream-json` emits machine-readable turns; sessions persist to `~/.book/sessions/`; `book -r <id>` and `book -c` resume; `/compact` and `autoCompactEnabled` trim context.

### Epic M3.1 — `--print` / `-p` + output formats 🔴 critical · effort L
- **Closes gaps:** D.
- **What:** New headless mode in `src/index.ts`: when `-p`/`--print` is set, skip the Ink render and run `runAgentLoop` directly, printing text (default), JSON (final result), or `stream-json` (one event object per turn/tool/text chunk). Support `--input-format stream-json` for programmatic input. Honor `--max-turns` and `--max-budget-usd` (print-only).
- **Files:** `src/index.ts`, new `src/headless.ts` (or `src/print.ts`), `src/agent/loop.ts` (extract a renderer-agnostic core).
- **Depends on:** M1.1, M1.4 (abort), M2.1 (tool names in JSON).

### Epic M3.2 — `--json-schema` structured output 🟡 medium · effort M
- **Closes gap:** D.
- **What:** Print-mode only: after the agent finishes, run a final constrained generation against the provided JSON Schema (or instruct the model to emit JSON and validate). 
- **Files:** `src/headless.ts`, `src/provider/openai-compatible.ts`.

### Epic M3.3 — Session persistence + resume 🔴 critical · effort L
- **Closes gaps:** D.
- **What:** Persist each session to `~/.book/sessions/<uuid>.jsonl` (one record per message/turn). `--session-id`, `--resume <id|name>`, `--continue`/`-c` (most recent in cwd), `--fork-session`, `--no-session-persistence`, `--name`/`-n`. Add `book resume` picker (interactive) and a `/resume` slash command. `cleanupPeriodDays` (default 30).
- **Files:** new `src/session/store.ts`, `src/session/resume.ts`, `src/index.ts`, `src/tui/` (picker component).
- **Depends on:** M3.1.

### Epic M3.4 — Context compaction 🟠 high · effort L
- **Closes gap:** A.
- **What:** When estimated context approaches the model limit, summarize older turns into a compact message (model-driven; fire `PreCompact` hook from M5). `/compact` slash command + `autoCompactEnabled` (default true). Keep system prompt + recent N turns verbatim.
- **Files:** `src/agent/loop.ts`, `src/agent/context.ts`, new `src/agent/compact.ts`.
- **Depends on:** M1.5 (real token accounting), M3.3 (persist before compact).

---

## M4 — Permissions & Layered Settings

**Goal:** Replace the single `.bookrc.json` with Claude Code's layered `settings.json` model and bring permission rules + sandbox to parity.
**DONE when:** settings load from managed > CLI > local > project > user with array-merge + live reload; `permissions.{allow,ask,deny}` use `Tool(specifier)` syntax evaluated deny→ask→allow; bash sandbox is available (opt-in) with filesystem/network/credentials restrictions.

### Epic M4.1 — Settings layering + live reload 🟠 high · effort L
- **Closes gap:** E.
- **What:** New `src/settings/` module loading `.book/settings.json` (project, committed), `.book/settings.local.json` (gitignored), `~/.book/settings.json` (user), and `managed-settings.json` (managed). Precedence: managed > CLI > local > project > user. Arrays concatenate+dedupe (except `fallbackModel`, managed `availableModels`). Watch files; reload + fire `ConfigChange` (M5). Add `--settings`, `--setting-sources`. Migrate `.bookrc.json` → `.book/settings.json` (read legacy file with a deprecation warning).
- **Files:** new `src/settings/loader.ts`, `src/settings/merge.ts`, `src/settings/watch.ts`; `src/config.ts` (thin wrapper); `src/index.ts`.
- **Depends on:** M1 (stable types).

### Epic M4.2 — `Tool(specifier)` permission rules 🟠 high · effort M
- **Closes gap:** E.
- **What:** Extend `PermissionStore` to parse `Tool` and `Tool(specifier)` with per-tool matchers: `Bash(npm run *)`, `Read(./.env)`, `Edit(./src/**)`, `WebFetch(domain:example.com)`, `mcp__server__*`, `Agent(name)`. Evaluate **deny → ask → allow**, first match wins (already the store's order — add config arrays). Wire `permissions.{allow,ask,deny,defaultMode,additionalDirectories,disableBypassPermissionsMode}` from settings. Add `--allowedTools`, `--disallowedTools`, `--tools`, `--permission-mode`, `--add-dir` flags.
- **Files:** `src/tui/permissionStore.ts` (or new `src/permissions/`), `src/agent/loop.ts`, `src/index.ts`.
- **Depends on:** M4.1, M2.1 (standard tool names).

### Epic M4.3 — Read-only auto-allow + default bash allowlist 🟡 medium · effort S
- **Closes gap:** E.
- **What:** Auto-allow read-only commands (`ls`, `cat`, `git status`, `git diff`, `git log`) without prompting (CC's `READ_ONLY_AUTO_ALLOW_REASON`). Make the list configurable.
- **Files:** `src/permissions/` (new), `src/agent/loop.ts`.

### Epic M4.4 — Bash sandbox 🟠 high · effort XL
- **Closes gap:** E.
- **What:** Implement `sandbox.*` (start macOS Seatbelt / Linux bubblewrap; WSL2 via bwrap). `enabled`, `autoAllowBashIfSandboxed`, `excludedCommands`, `filesystem.{allowWrite,denyWrite,denyRead,allowRead}`, `credentials.{files,envVars}`, `network.{allowedDomains,deniedDomains,allowLocalBinding,allowUnixSockets}`. Bring-your-own proxy ports. `failIfUnavailable`. This is large — scope a minimal v1 (filesystem write-deny + network domain allowlist) and iterate.
- **Files:** new `src/sandbox/` (platform adapters), `src/tools/shell.ts`.
- **Depends on:** M4.1, M4.2. *Can be deferred* behind M5–M7 if sandboxing isn't immediately needed; flag as optional in v1.

---

## M5 — Hooks

**Goal:** Deterministic, non-LLM control points across the agent lifecycle, matching CC's event set and JSON-stdio contract.
**DONE when:** hooks are configurable in `.book/settings.json` under `hooks`; the 11 events fire; a `PreToolUse` hook can block (exit 2) or rewrite; `UserPromptSubmit` can rewrite input; `ConfigChange` fires on settings reload; `--init`/`--init-only`/`--maintenance` run Setup matchers.

### Epic M5.1 — Hook engine + event set 🟠 high · effort L
- **Closes gap:** F.
- **What:** New `src/hooks/` module. Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`, `SessionStart`, `SessionEnd`, `PreCompact`, `ConfigChange`, `Setup` (`init`/`maintenance` matchers). Each hook = `{event, matcher?, command}`. Run the command, pass JSON event payload on stdin, parse JSON stdout. Exit code 2 = block (for PreToolUse/UserPromptSubmit); JSON `hookSpecificOutput` can rewrite input or supply permission decisions. Blocking vs async.
- **Files:** new `src/hooks/runner.ts`, `src/hooks/events.ts`, `src/hooks/schema.ts`; call sites in `src/agent/loop.ts` (PreToolUse/PostToolUse/Stop), `src/tui/hooks/useAgent.ts` (UserPromptSubmit), `src/session/` (SessionStart/End), `src/agent/compact.ts` (PreCompact), `src/settings/watch.ts` (ConfigChange).
- **Depends on:** M4.1 (settings to store hooks).

### Epic M5.2 — `Setup` matchers + `--init` flags 🟢 low · effort S
- **Closes gap:** F.
- **What:** `--init`, `--init-only`, `--maintenance` (print mode) run `Setup` hooks with the `init`/`maintenance` matcher, then optionally exit. Useful for CI bootstrap.
- **Files:** `src/index.ts`, `src/hooks/runner.ts`.

### Epic M5.3 — HTTP hooks + allowlists 🟢 low · effort M
- **Closes gap:** F.
- **What:** Support `type:'http'` hooks targeting a URL; enforce `allowedHttpHookUrls` (glob) and `httpHookAllowedEnvVars` (env interpolation allowlist). `allowManagedHooksOnly` gating.
- **Files:** `src/hooks/runner.ts`, `src/settings/`.

---

## M6 — Slash Commands & Skills

**Goal:** The first two extensibility surfaces, both as Markdown+frontmatter files discovered by convention.
**DONE when:** `.book/commands/*.md` (and `~/.book/commands/`) define slash commands invoked by `/name`; `.book/skills/SKILL.md` files are injected into the model's context each turn with a 1% listing budget and can be model-invoked; `--disable-slash-commands` and `--bare` toggle them.

### Epic M6.1 — Slash commands as files 🟠 high · effort M
- **Closes gap:** G.
- **What:** Discover `~/.book/commands/*.md` + `.book/commands/*.md`. Parse YAML frontmatter (`argument-hint`, `allowed-tools`, `model`, `description`). Body = prompt injected on `/name [args]`. Add `/help` listing all commands. Support `$ARGUMENTS`, `$1`… substitution. `--disable-slash-commands` disables.
- **Files:** new `src/commands/loader.ts`, `src/tui/components/HelpPalette.tsx`, `src/tui/app.tsx`, `src/index.ts`.

### Epic M6.2 — Skills (model-invoked) 🟡 medium · effort L
- **Closes gap:** G.
- **What:** Discover `~/.book/skills/` + `.book/skills/` `SKILL.md` (frontmatter: `name`, `description`, `when_to_use`). Inject a *listing* (name+description) into the system prompt each turn under a `skillListingBudgetFraction` (default 1% of context). When the model invokes a skill (via a `Skill` tool or `/name`), load its full body. `maxSkillDescriptionChars` (1536), `skillOverrides` (`on`/`name-only`/`user-invocable-only`/`off`), `disableBundledSkills`. Collapse least-used to bare names when over budget.
- **Files:** new `src/skills/loader.ts`, `src/skills/listing.ts` (budget math), `src/agent/context.ts` (inject listing), `src/tools/` (`Skill` tool or `/skill` command), `src/settings/`.
- **Depends on:** M3.4 (compaction protects context budget), M4.1 (settings for overrides).

### Epic M6.3 — BOOK.md memory + `@import` 🟠 high · effort M
- **Closes gap:** A.
- **What:** Load memory files: `~/.book/BOOK.md` (user), `BOOK.md`/`.book/BOOK.md` (project), `BOOK.local.md` (local). Concatenate into the system prompt. Support `@path/to/file.md` imports. `claudeMdExcludes` glob. `autoMemoryEnabled`/`autoMemoryDirectory` for model-written memory.
- **Files:** new `src/memory/loader.ts`, `src/agent/context.ts`.
- **Depends on:** M4.1 (settings), M3.3 (session for auto-memory writes).

### Epic M6.4 — Output styles 🟡 medium · effort M
- **Closes gap:** G.
- **What:** `outputStyle` setting (`default`/`explanatory`/`learning` or custom `.book/output-styles/*.md`). Adjusts the system prompt. `/output-style` slash command.
- **Files:** new `src/styles/`, `src/agent/context.ts`.

---

## M7 — Subagents & MCP

**Goal:** The remaining two extensibility surfaces — isolated-context subagents and the MCP open protocol — plus plugin packaging groundwork.
**DONE when:** `.book/agents/*.md` define subagents; the `Task` tool dispatches them with scoped tools/model and isolated context (parallel-capable); MCP servers from `.book/mcp.json` + `~/.book.json` expose `mcp__<server>__<tool>` tools over stdio/SSE/HTTP; `/mcp` and `/agents` slash commands manage them.

### Epic M7.1 — Subagents + `Task` tool 🔴 critical · effort L
- **Closes gap:** G/C.
- **What:** Discover `~/.book/agents/` + `.book/agents/` Markdown (frontmatter: `name`, `description`, `tools`, `model`). Implement the `Task` tool: `subagent_type`, `description`, `prompt`. Spawn a nested `runAgentLoop` with the subagent's system prompt, restricted tool set, and a *fresh* context window — only its final result returns to the lead. Allow parallel dispatch (Promise.all). `SubagentStop` hook fires. `--agents` inline JSON; `--agent` run-as. Subagent colors already in `DEFAULT_THEME.subagentColors`.
- **Files:** new `src/agents/loader.ts`, `src/agents/subagent.ts` (nested loop), `src/tools/task.ts`, `src/agent/loop.ts` (parallel tool execution support — currently sequential), `src/tui/components/` (subagent block rendering).
- **Depends on:** M5.1 (SubagentStop hook), M6 (file conventions), M1.4 (abort propagates to subagents).

### Epic M7.2 — MCP client 🟠 high · effort XL
- **Closes gap:** G.
- **What:** Implement an MCP client: load servers from `.book/mcp.json` (project) + `~/.book.json` (user) + `--mcp-config` + `managed-mcp.json`. Transports: stdio (spawn server), SSE, HTTP. Discover tools/resources/prompts; expose tools as `mcp__<server>__<tool>` in the registry, governed by the permission system. `--strict-mcp-config`. OAuth via `book mcp login`/`logout`. `allowedMcpServers`/`deniedMcpServers`/`allowManagedMcpServersOnly`. `/mcp` slash command to list/connect/status.
- **Files:** new `src/mcp/client.ts`, `src/mcp/transport/{stdio,sse,http}.ts`, `src/mcp/registry.ts`, `src/tools/registry.ts`, `src/index.ts` (subcommand `book mcp`).
- **Depends on:** M4.2 (permission rules for `mcp__*`), M2.1 (tool naming), M7.1 (subagents can call MCP tools).

### Epic M7.3 — Checkpointing + `/rewind` 🟡 medium · effort M
- **Closes gap:** C/F.
- **What:** `fileCheckpointingEnabled` (default true): snapshot files before each `Edit`/`Write`/`MultiEdit` to `.book/checkpoints/`. `/rewind` restores prior state (interactive picker of checkpoints). What is restored: file contents (not conversation — that's `--resume`).
- **Files:** new `src/checkpoint/`, `src/tools/file.ts`, `src/tui/` (`/rewind` command).
- **Depends on:** M2.1 (Edit/Write tools), M3.3 (session concept).

---

## M8 — Agent SDK

**Goal:** Programmatic, non-interactive usage for embedding and CI — Claude Code's "Agent SDK".
**DONE when:** a `book` Node/TS SDK exports `query()` returning an async iterator of events; `book -p` is CI-stable with `--include-hook-events`, `--include-partial-messages`, `--prompt-suggestions`; `book doctor` diagnoses config.

### Epic M8.1 — SDK `query()` API 🟡 medium · effort L
- **Closes gap:** I.
- **What:** Export a programmatic `query({prompt, options})` from `book` that returns an async iterable of `{type, ...}` events (text, tool_call, tool_result, message, result). Options mirror CLI flags. `persistSession`, `settingSources`, `mcpConfig`, `agents`, `hooks`, `permissionMode`, `maxTurns`, `model`. Reuse M3.1's headless core.
- **Files:** new `src/sdk/query.ts`, `package.json` `exports` map, `src/index.ts`.
- **Depends on:** M3.1, M5, M7.1.

### Epic M8.2 — `book doctor` + `book config` + `book update` 🟠 high · effort M
- **Closes gap:** D.
- **What:** `book doctor` prints active settings sources, invalid entries, hook/MCP status, version. `book config get/set` (and `/config key=value`). `book update` self-update. `book install` (PATH install). `book setup-token` (for IDE/SDK auth).
- **Files:** `src/index.ts` (subcommands), new `src/cli/`.
- **Depends on:** M4.1.

### Epic M8.3 — `--include-hook-events` / `--include-partial-messages` / `--prompt-suggestions` 🟡 medium · effort M
- **Closes gap:** D.
- **What:** Stream-json enrichments: hook lifecycle events, partial assistant messages, and predicted next-prompt suggestions.
- **Files:** `src/headless.ts`.
- **Depends on:** M5, M3.1.

---

## M9 — UX Polish

**Goal:** Close the TUI/UX gaps so the interactive experience matches Claude Code, and wire the accessibility flags that exist but are inert.
**DONE when:** fullscreen alt-screen renderer with virtualized scrollback; diff rendering in `ToolCallBlock`; vim mode; multiline input; `@`-mentions and `!`-shell mode; `/help` palette with all slash commands; theme switching; custom status line; `--ax-screen-reader` wired.

### Epic M9.1 — Fullscreen renderer + scrollback 🟠 high · effort L
- **Closes gap:** H (B7).
- **What:** `tui: 'fullscreen'` setting → Ink alt-screen mode with virtualized scrolling (keep a ring buffer of messages, render only the viewport). PgUp/PgDn/Ctrl+U/Ctrl+D scrolling. Auto-scroll-to-bottom toggle.
- **Files:** `src/tui/app.tsx`, new `src/tui/scroll.ts`, `src/tui/components/ChatPanel.tsx`.
- **Depends on:** M1 (stable message model). *Can start in parallel with M2–M4.*

### Epic M9.2 — Diff rendering + tool-output expand/collapse 🟠 high · effort M
- **Closes gap:** H/C.
- **What:** Render `Edit`/`MultiEdit`/`Write` diffs (added/removed lines/words) using the theme's `diffAdded`/`diffRemoved`/`diffAddedWord` tokens (already in DEFAULT_THEME). Collapsible large tool output (Ctrl+E).
- **Files:** `src/tui/components/ToolCallBlock.tsx`, new `src/tui/components/Diff.tsx`.
- **Depends on:** M2.1 (diff in tool result).

### Epic M9.3 — Vim mode + multiline input + `@`/`!` 🟡 medium · effort M
- **Closes gap:** H.
- **What:** `editorMode: 'vim'` (normal/insert modes, basic motions). Multiline (Shift+Enter newline). `@path` file mention expands to file contents in the prompt. `!cmd` shell mode runs a command and inserts output. External editor via Ctrl+G.
- **Files:** `src/tui/components/InputBar.tsx`, new `src/tui/input/`.
- **Depends on:** M9.1.

### Epic M9.4 — Slash palette + `/help` + full command set 🟠 high · effort S
- **Closes gap:** H.
- **What:** `/help` palette listing built-in + custom commands (M6.1). Add built-in slash commands: `/compact /resume /config /model /permissions /cost /vim /output-style /hooks /statusline /agents /mcp /tui /focus /rename /memory /doctor`.
- **Files:** `src/tui/components/HelpPalette.tsx`, `src/tui/app.tsx`.
- **Depends on:** M6.1.

### Epic M9.5 — Theme switching + custom themes + `--ax-screen-reader` 🟡 medium · effort M
- **Closes gap:** H.
- **What:** `theme` setting (`auto`/`dark`/`light`/`dark-daltonized`/`light-daltonized`/`dark-ansi`/`light-ansi`/`custom:<slug>`). Load custom themes from `.book/themes/*.json`. `/theme` command. Wire the existing `accessibility.screenReader`/`reducedMotion` config to an actual flat renderer (CC's `--ax-screen-reader`).
- **Files:** `src/tui/theme.ts`, new `src/tui/themes/`, `src/config.ts`.
- **Depends on:** M4.1 (settings).

### Epic M9.6 — Custom status line + keyboard shortcuts + turn duration 🟢 low · effort M
- **Closes gap:** H.
- **What:** `statusLine: {type:'command', command}` runs a script each turn emitting a status row (JSON in/out). Configurable keyboard shortcuts. `showTurnDuration` ("Cooked for 1m 6s"). `showThinkingSummaries`. Notifications (`preferredNotifChannel`).
- **Files:** new `src/tui/statusline.ts`, `src/config.ts`, `src/tui/components/StatusLine.tsx`.

---

## Out of scope / later

Low-value or CC-proprietary items explicitly deferred:

- **Voice dictation** (`voice`/`voiceEnabled`) — platform-specific, low ROI for a coding CLI.
- **Plugin marketplace hosting** (`/plugin` marketplace browsing, `extraKnownMarketplaces`, `strictKnownMarketplaces`, `strictPluginOnlyCustomization`) — large surface; revisit after M6/M7 prove out the four atomic surfaces. Build the *packaging* format first (a plugin = a bundle dir of skills/agents/hooks/mcp), defer marketplace distribution.
- **Remote Control / claude.ai web sessions** (`--remote`, `--remote-control`, `--teleport`, `--channels`) — depends on Anthropic infrastructure; not portable.
- **Agent teams / teammate panes** (`teammateMode`, tmux/iTerm2 splits) — nice-to-have after M7.1 subagents.
- **IDE extensions** (VS Code / JetBrains) — separate concern; the SDK (M8) is the prerequisite.
- **Channels / claude.ai MCP connectors** — proprietary.
- **Enterprise managed-settings delivery** (MDM plist, registry, server-managed) — implement the *file-based* `managed-settings.json` + drop-in dir in M4.1; defer OS-policy delivery.
- **PR-from-session** (`--from-pr`), **deep links**, **Artifact tool** — narrow features.

---

## Next 3 epics to start (recommended)

1. **M1.1 — Thread tool calls & results into provider messages.** This is the single highest-leverage fix: without it, every multi-turn tool workflow is broken. Small, isolated, unblocks real testing of everything else.
2. **M1.2 + M1.3 — Fix provider body + 429 retry.** Together they make the provider trustworthy. Do them in the same PR as M1.1 since they all touch `context.ts`/`openai-compatible.ts`.
3. **M1.6 — Test the core.** Land alongside M1.1–M1.4 so the fixes are locked in and the foundation for M2 (tool renaming) is safe.

After M1, the highest-value next milestone is **M2 (tool parity, especially `TodoWrite`)**, then **M3 (headless + sessions)** — together they make `book` genuinely useful as a Claude Code stand-in for scripted and long tasks.
