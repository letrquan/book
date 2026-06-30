# Book ↔ Claude Code — Gap Analysis

**Date:** 2026-06-26
**Goal product (reference):** Claude Code (`docs.claude.com` — Overview, CLI reference, Settings reference, Hooks reference, Subagents, Plugins, MCP).
**Subject:** `book` AI coding agent CLI v0.1.0 (`I:/MyProject/02-AI-ML-Projects/book`).
**Method:** Direct read of every file in `src/`, plus targeted extraction from the scraped CC docs (`cc_cli.txt`, `cc_settings.txt`, `cc_overview.txt`) and the clean research note `_research/extensibility-philosophy.md`.

This document is the evidence base for the companion plan `docs/superpowers/plans/2026-06-26-book-cc-parity-milestones.md`. Every gap below is grounded in either (a) a CC doc passage or (b) a line of book source.

---

## 1. What book actually has today (verified from source)

| Layer | Real | Partial | Stub/Broken |
|---|---|---|---|
| CLI entry (`src/index.ts`) | Commander, `-w/--workspace`, `-m/--model` | — | No other flags, no subcommands, no print mode |
| Config (`src/config.ts`) | Zod schema, `.bookrc.json` (workspace → `~/`), env vars | — | No `settings.json` layering, no live reload, no managed/enterprise |
| Types (`src/types.ts`) | Message/ToolCall/ToolResult/AgentConfig/PermissionMode(6)/ThemeTokens | Theme tokens are a faithful CC-style token set | — |
| Provider (`src/provider/openai-compatible.ts`) | SSE streaming, tool-call delta assembly | — | **Bug: sends `max_turns` in body** (not an OpenAI param); no 429 backoff/retry; no abort; no token counting; no vision; no structured output |
| Context (`src/agent/context.ts`) | Hardcoded system prompt (OS/workspace/date) | — | **CRITICAL: never emits `tool_calls`/tool-result messages** → model has no memory of tool results across turns |
| Agent loop (`src/agent/loop.ts`) | Linear streaming loop, maxTurns, sequential tool exec, 6 permission modes, PermissionStore consult | — | No compaction, no subagents, no parallel tools, no abort, no checkpoints, no hooks, no todos |
| File tools (`src/tools/file.ts`) | read/write/edit/glob/grep | — | edit = single `replace` (no `replace_all`, no multi-edit, no diff); grep ignores `.gitignore`, caps 100 files/500 lines, no `output_mode`, no `-A/-B/-C`, no multiline |
| Shell (`src/tools/shell.ts`) | bash via `exec` (cwd/timeout/maxBuffer/env) | — | No sandbox, no allow/deny rules, no background, no stdin, no PTY |
| Git (`src/tools/git.ts`) | status/diff/log/commit/branch (execSync) | — | No add, no checkout, no PR creation; commit is `commit -m` only |
| Design (`src/tools/design.ts`) | — | — | **STUB** — returns canned string |
| Browser (`src/tools/browser.ts`) | — | — | **STUB** — returns error, no CDP |
| TUI app (`src/tui/app.tsx`) | Ink render, `/clear` `/exit` `/task` handling, Ctrl+T tasks, Alt+M mode, Esc cancel perm | — | No `/help`, no scroll, no fullscreen alt-screen |
| InputBar | single-line TextInput, up/down history (in-memory), Shift+Tab cycle mode, Tab suggestion | — | No multiline, no vim, no `@`-mentions, no image paste, no `!` shell mode |
| ChatPanel | renders messages top-to-bottom | flexGrow column | **No scrollback/virtualization** — overflows terminal; no diff rendering |
| StatusLine | model/turn/tokens/mode/git-branch/tasks row | token count is `len/4` estimate | No cost/USD, no real usage from provider |
| ToolCallBlock | spinner → `[OK]`/`[ERR]`, primary arg, truncated output | — | No diff preview, no expand/collapse of large output, no per-tool rendering |
| PermissionStore | `~/.book/permissions.json`, deny→ask→allow, `allowAlways()` project scope, glob on primary arg | — | No `deny`/`ask` persistence UI, no rule editing, no scope precedence |
| Theme | ThemeContext + `useTheme()`, DEFAULT_THEME | — | No theme switching, no dark/light/ansi/daltonized variants, no custom theme files |
| Tests | (planned) `config.test.ts` | — | Only config test planned; no loop/provider/tool tests |

**Confirmed absent (zero code):** print/headless mode, session resume/continue, compaction, checkpointing/`/rewind`, hooks, MCP, subagents/Task tool, skills, slash-command files, plugins, output styles, TodoWrite, MultiEdit, WebFetch, WebSearch, NotebookEdit, image/vision input, abort/cancel, `/help` `/compact` `/resume` `/config` `/model` `/agents` `/mcp` `/permissions` `/init` `/cost` `/vim` `/output-style`, keyboard-shortcut config, status-line customization, voice, advisor, fast mode, enterprise/managed settings, telemetry controls, IDE integration.

---

## 2. Claude Code feature inventory (grounded in scraped docs)

### 2.1 CLI flags (`cc_cli.txt` line 1136, the complete flags table)

Verified CC flags and whether book has any analogue:

| Flag | CC behavior | Book |
|---|---|---|
| `--print` / `-p` | Non-interactive; print response & exit | **missing** |
| `--output-format` | `text`/`json`/`stream-json` (print mode) | **missing** |
| `--input-format` | `text`/`stream-json` (print mode) | **missing** |
| `--json-schema` | Validated JSON output via schema (print mode) | **missing** |
| `--resume` / `-r` | Resume session by ID/name or interactive picker | **missing** |
| `--continue` / `-c` | Load most recent conversation in cwd | **missing** |
| `--fork-session` | New session ID on resume | **missing** |
| `--session-id` | Specific UUID for the session | **missing** |
| `--no-session-persistence` | Don't save sessions (print mode) | **missing** |
| `--max-turns` | Cap agentic turns (print mode) | partial: `config.maxTurns` only, no flag |
| `--max-budget-usd` | Dollar spend cap (print mode) | **missing** |
| `--model` | Model alias or full ID | **present** (`-m`) |
| `--fallback-model` | Ordered fallback chain on overload | **missing** |
| `--permission-mode` | `default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions` | partial: mode exists in loop, no startup flag |
| `--dangerously-skip-permissions` | = `bypassPermissions` | partial: mode reachable via cycle only |
| `--allow-dangerously-skip-permissions` | Add bypass to Shift+Tab cycle | **missing** |
| `--allowedTools` / `--allowed-tools` | Allow rules (`Bash(git log *)`) | **missing** |
| `--disallowedTools` | Deny rules; `*`/`mcp__*` remove tools | **missing** |
| `--tools` | Restrict built-in tool set (`Bash,Edit,Read`) | **missing** |
| `--add-dir` | Extra working dirs (file access only) | **missing** |
| `--append-system-prompt` | Append to default system prompt | **missing** |
| `--append-system-prompt-file` | Append from file | **missing** |
| `--system-prompt` | Replace system prompt | **missing** |
| `--system-prompt-file` | Replace from file | **missing** |
| `--mcp-config` | Load MCP servers from JSON | **missing** |
| `--strict-mcp-config` | Only use `--mcp-config` servers | **missing** |
| `--agents` | Inline subagents JSON | **missing** |
| `--agent` | Run main thread as a named subagent | **missing** |
| `--bare` | Skip auto-discovery (hooks/skills/plugins/MCP/CLAUDE.md) | **missing** |
| `--safe-mode` | Disable ALL customizations | **missing** |
| `--disable-slash-commands` | Disable all skills & commands | **missing** |
| `--include-partial-messages` | Partial streaming events (stream-json) | **missing** |
| `--include-hook-events` | Hook lifecycle events in stream | **missing** |
| `--verbose` | Full turn-by-turn output | **missing** |
| `--debug` | Debug with category filter (`api,hooks`) | **missing** |
| `--debug-file` | Debug logs to file | **missing** |
| `--effort` | `low`/`medium`/`high`/`xhigh`/`max` | **missing** |
| `--name` / `-n` | Session display name | **missing** |
| `--ide` | Auto-connect IDE | **missing** |
| `--init` | Run Setup `init` hooks (print mode) | **missing** |
| `--init-only` | Run Setup+SessionStart then exit | **missing** |
| `--maintenance` | Run Setup `maintenance` hooks | **missing** |
| `--bg` / `--background` | Background agent, return session ID | **missing** |
| `--exec` | PTY-backed shell job (with `--bg`) | **missing** |
| `--remote` / `--remote-control` / `--teleport` | claude.ai web session | out-of-scope |
| `--channels` / `--dangerously-load-development-channels` | MCP channel notifications | out-of-scope |
| `--chrome` / `--no-chrome` | Chrome integration toggle | **missing** |
| `--plugin-dir` / `--plugin-url` | Load plugin for session | **missing** |
| `--setting-sources` | `user,project,local` subset | **missing** |
| `--settings` | Inline/file settings override | **missing** |
| `--from-pr` | Resume sessions linked to a PR | out-of-scope |
| `--ax-screen-reader` | Flat, no-border, no-animation render | partial: `accessibility.screenReader` exists in config but unused |
| `--version` / `-v` | Version | **present** (Commander) |
| `--help` | Help | **present** (Commander) |

### 2.2 Subcommands (`cc_cli.txt`)
`claude mcp …` (add/list/remove/login/logout/get), `claude agents`, `claude plugin …` (install/marketplace), `claude config`, `claude setup-token`, `claude update`, `claude doctor`, `claude install`, `claude migrate-installer`. **Book has none** — only the bare `book` invocation.

### 2.3 Interactive slash commands
CC ships `/help /clear /compact /resume /config /model /agents /mcp /permissions /init /review /cost /vim /output-style /hooks /statusline /release-notes /doctor /add-dir /fast /effort /advisor /skills /plugin /workflows /tui /focus /rename /memory` and more. **Book has `/clear /exit /task` inline only** — no `/help`, no palette.

### 2.4 Settings (`cc_settings.txt`)

**Configuration scopes** (4 tiers, precedence high→low): Managed (server/MDM/registry/`managed-settings.json` + drop-in `managed-settings.d/`) > CLI args > Local (`.claude/settings.local.json`, gitignored) > Project (`.claude/settings.json`, committed) > User (`~/.claude/settings.json`). Arrays (e.g. `permissions.allow`, `sandbox.filesystem.allowWrite`) **concatenate & dedupe** across scopes; exceptions: `fallbackModel` and managed `availableModels` are whole-value. **Live reload** via file watch; `ConfigChange` hook fires on each change. Book: single `.bookrc.json`, no layering, no live reload.

**Settings-key catalog (sampled, all absent in book):** `advisorModel`, `agent`, `apiKeyHelper`, `attribution`, `autoCompactEnabled`, `autoMemoryEnabled`/`autoMemoryDirectory`, `autoMode`, `cleanupPeriodDays`, `defaultShell`, `disableAllHooks`, `disableBundledSkills`, `disableWorkflows`, `editorMode` (vim), `effortLevel`, `fallbackModel`, `fileCheckpointingEnabled`, `includeGitInstructions`, `language`, `maxSkillDescriptionChars`, `model`/`modelOverrides`/`availableModels`/`enforceAvailableModels`, `outputStyle`, `permissions.{allow,ask,deny,additionalDirectories,defaultMode,disableBypassPermissionsMode}`, `preferredNotifChannel`, `showThinkingSummaries`, `showTurnDuration`, `skillListingBudgetFraction`, `skillOverrides`, `spinnerTipsEnabled`, `statusLine`, `theme`, `tui` (fullscreen vs classic), `verbose`, `viewMode`, `voice`, plus the full **`sandbox.*`** subtree (`enabled`, `autoAllowBashIfSandboxed`, `excludedCommands`, `filesystem.{allowWrite,denyWrite,denyRead,allowRead}`, `credentials.{files,envVars}`, `network.{allowedDomains,deniedDomains,allowLocalBinding,allowUnixSockets}`) and **plugin** keys (`enabledPlugins`, `extraKnownMarketplaces`, `strictKnownMarketplaces`, `strictPluginOnlyCustomization`).

**Permission rule syntax:** `Tool` or `Tool(specifier)`. Evaluated **deny → ask → allow**, first match wins. Specifiers per tool: `Bash(npm run *)`, `Read(./.env)`, `WebFetch(domain:example.com)`, `mcp__server__tool`. Book has a rule store but no `Tool(specifier)` syntax parser, no `deny`/`ask` array config, no WebFetch/MCP matchers.

### 2.5 Built-in tools & hooks (`cc_cli.txt` Tools/Hooks/Checkpointing sections + extensibility-philosophy.md)

**Tools (exact CC names):** `Bash` (timeout, `run_in_terminal`, background, MCP), `Read` (image/PDF, offset/limit), `Write`, `Edit` (`old_string`/`new_string`, `replace_all`), `MultiEdit`, `Glob`, `Grep` (`output_mode`: `content`/`files_with_matches`/`count`, `-A/-B/-C`, multiline), `NotebookEdit`, `TodoWrite` (model-driven todos: `pending`/`in_progress`/`completed` + `activeForm`), `Task` (subagent dispatch: `description`/`prompt`/`tools`/`model`), `WebFetch`, `WebSearch`, `mcp__<server>__<tool>`. Book tool names are `read_file`/`write_file`/`edit_file`/`glob`/`grep`/`bash`/`git_*`/`design_*`/`browser_*` — **non-standard**, missing `replace_all`, MultiEdit, TodoWrite, Task, WebFetch, WebSearch, NotebookEdit, MCP.

**Hooks (lifecycle events):** `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`, `SessionStart`, `SessionEnd`, `PreCompact`, `ConfigChange`, `Setup` (with `init`/`maintenance` matchers). JSON-over-stdio; matcher = tool-name regex; exit code 2 blocks; can rewrite input (`UserPromptSubmit`/`PreToolUse`). Live reload. Book: **none**.

**Checkpointing:** `fileCheckpointingEnabled` snapshots files before each edit; `/rewind` restores. Book: **none**.

### 2.6 Extensibility surfaces (extensibility-philosophy.md — the four surfaces)

1. **Slash commands** = Markdown + YAML frontmatter in `~/.claude/commands/` + `.claude/commands/`. Frontmatter: `argument-hint`, `allowed-tools`, `model`. Body = injected prompt.
2. **Skills** = `SKILL.md` + frontmatter (`name`, `description`, `when_to_use`). **Model-triggered** autonomous invocation. Anti-clutter budgets: `skillListingBudgetFraction` (default 1% of context), `maxSkillDescriptionChars` (1536), `skillOverrides` (`on`/`name-only`/`user-invocable-only`/`off`), `disableBundledSkills`. `--disable-slash-commands` covers both.
3. **Subagents/agents** = `.claude/agents/*.md` (name, description, tools, model) + `--agents` inline. Isolated context, scoped tools, `Task` tool dispatch, parallel/background (`--bg`/`claude agents`), agent teams.
4. **Hooks** (above) — config in `settings.json` under `hooks`.
5. **Plugins** = marketplace bundles of the four surfaces; `/plugin` command; `enabledPlugins`, `extraKnownMarketplaces`, `strictKnownMarketplaces`, `strictPluginOnlyCustomization` (lock any of `[skills,agents,hooks,mcp]`).
6. **MCP** = `.mcp.json` (project) + `~/.claude.json` (user) + `--mcp-config` + `managed-mcp.json`. Transports: stdio/SSE/HTTP. Tools appear as `mcp__<server>__<tool>`. `claude mcp login`/`logout` (OAuth). `/mcp` command.
7. **Agent SDK** = programmatic `query()`/agent SDK; `claude -p` for CI; hooks for CI; non-interactive.
8. **Memory** = `CLAUDE.md` (user `~/.claude/CLAUDE.md`, project `CLAUDE.md`/`.claude/CLAUDE.md`, local `CLAUDE.local.md`) + auto-memory dir. `@import` support.

**Book has none of these.** No `.book/` convention exists.

---

## 3. Critical correctness bugs (must fix before any feature work)

| # | Bug | Evidence | Severity |
|---|---|---|---|
| B1 | **Tool results are discarded** — `context.ts buildMessages()` emits only `system` + `user`/`assistant.content`; never adds `tool_calls` to assistant messages nor `tool` role messages for results | `src/agent/context.ts` lines 24-35 | **CRITICAL** |
| B2 | Provider sends `max_turns` in request body (not an OpenAI param; should be omitted or `max_completion_tokens`) | `src/provider/openai-compatible.ts` body construction | high |
| B3 | No 429 backoff/retry — provider yields a single error and the loop returns | `openai-compatible.ts` 429 branch | high |
| B4 | No abort/cancel — Ctrl+C during streaming kills the process; no `AbortController` wired into `chatCompletionStream`/loop | `loop.ts`, `useAgent.ts` (no AbortController despite `abortRef` in old plan) | high |
| B5 | `grep`/`glob` ignore `.gitignore` (raw fast-glob, no `ignore` plugin wired) despite `ignore` being a dependency | `src/tools/file.ts` | medium |
| B6 | `edit_file` uses `String.replace` (replaces only first occurrence; silent on duplicates) and reports no diff | `src/tools/file.ts` | medium |
| B7 | `ChatPanel` has no scrollback — messages render in an unbounded `flexGrow` column; long sessions overflow/clip | `src/tui/components/ChatPanel.tsx` | high |
| B8 | Token count is `assistantContent.length/4` — not real usage; `StatusLine` "tokens" is fictional | `loop.ts` `onTokenCount`, `StatusLine.tsx` | medium |
| B9 | Design & browser tools are stubs that always succeed/fail with canned text | `src/tools/design.ts`, `src/tools/browser.ts` | medium |
| B10 | No tests beyond a planned `config.test.ts` (loop/provider/tools untested) | `package.json`, absence of `*.test.ts` | medium |

---

## 4. Gap inventory by area (for milestone assignment)

> Severity: 🔴critical 🟠high 🟡medium 🟢low. Effort: S/M/L/XL.

### A. Agent core & context
| Feature | CC | Book | Sev | Eff |
|---|---|---|---|---|
| Thread tool_calls + tool results into provider messages | yes | broken (B1) | 🔴 | S |
| Context-window compaction (`/compact`, `autoCompactEnabled`, `PreCompact`) | yes | missing | 🟠 | L |
| CLAUDE.md/BOOK.md memory loading (user/project/local) + `@import` | yes | missing | 🟠 | M |
| System prompt from file / append / replace flags | yes | missing | 🟡 | S |
| Extended thinking / thinking summaries | yes | missing | 🟡 | M |
| Effort levels (`--effort`) | yes | missing | 🟢 | S |

### B. Provider & cost
| Feature | CC | Book | Sev | Eff |
|---|---|---|---|---|
| Fix `max_turns` body bug (B2) | — | bug | 🔴 | S |
| 429 backoff + retry (B3) | yes | missing | 🟠 | S |
| AbortController cancel mid-stream (B4) | yes | missing | 🟠 | M |
| Real token/cost tracking from API usage | yes | missing | 🟡 | M |
| Fallback model chain (`--fallback-model`) | yes | missing | 🟡 | M |
| Model tiers main/fast/small | yes | missing | 🟡 | M |
| Prompt caching hints | yes | missing | 🟢 | M |
| Vision/image input | yes | missing | 🟡 | L |

### C. Tools (parity)
| Feature | CC | Book | Sev | Eff |
|---|---|---|---|---|
| `Edit` with `replace_all` + diff preview (B6) | yes | partial | 🟠 | S |
| `MultiEdit` | yes | missing | 🟡 | S |
| `Grep` `output_mode` + context lines + multiline | yes | partial | 🟠 | M |
| `Glob`/`Grep` respect `.gitignore` (B5) | yes | missing | 🟠 | S |
| `TodoWrite` (model-driven todos) | yes | missing | 🔴 | M |
| `Task` subagent dispatch | yes | missing | 🔴 | L |
| `WebFetch` | yes | missing | 🟠 | M |
| `WebSearch` | yes | missing | 🟡 | M |
| `NotebookEdit` | yes | missing | 🟢 | L |
| Rename tools to CC names (`Read`/`Write`/`Edit`/`Glob`/`Grep`/`Bash`) | yes | non-standard | 🟡 | S |
| Realize design tools or drop them | — | stub | 🟡 | M |
| Realize browser/CDP tools or drop them | yes (`--chrome`) | stub | 🟡 | L |

### D. CLI & headless
| Feature | CC | Book | Sev | Eff |
|---|---|---|---|---|
| `--print`/`-p` headless mode | yes | missing | 🔴 | L |
| `--output-format` text/json/stream-json | yes | missing | 🟠 | M |
| `--input-format` stream-json | yes | missing | 🟡 | M |
| `--json-schema` structured output | yes | missing | 🟡 | M |
| `--resume`/`-r`/`--continue`/`-c`/`--fork-session`/`--session-id` | yes | missing | 🔴 | L |
| Session persistence to disk + `--no-session-persistence` | yes | missing | 🔴 | L |
| `--max-turns`/`--max-budget-usd` (print mode) | yes | missing | 🟡 | S |
| `--permission-mode` startup flag | yes | partial | 🟠 | S |
| `--allowedTools`/`--disallowedTools`/`--tools` | yes | missing | 🟠 | M |
| `--add-dir` | yes | missing | 🟡 | S |
| `--append-system-prompt{,-file}`/`--system-prompt{,-file}` | yes | missing | 🟡 | S |
| `--bare`/`--safe-mode`/`--disable-slash-commands` | yes | missing | 🟡 | S |
| `--verbose`/`--debug`/`--debug-file` | yes | missing | 🟡 | M |
| `--name`/`-n` session name | yes | missing | 🟢 | S |
| Subcommands: `mcp`, `config`, `doctor`, `update`, `install` | yes | missing | 🟠 | L |

### E. Permissions & sandbox
| Feature | CC | Book | Sev | Eff |
|---|---|---|---|---|
| `Tool(specifier)` rule syntax + deny→ask→allow config arrays | yes | partial (store exists, no parser/arrays) | 🟠 | M |
| `permissions.{allow,ask,deny,defaultMode,additionalDirectories}` in settings | yes | missing | 🟠 | M |
| Bash sandbox (`sandbox.*` filesystem/network/credentials) | yes | missing | 🟠 | XL |
| `autoAllowBashIfSandboxed` + read-only auto-allow | yes | missing | 🟡 | M |
| `disableBypassPermissionsMode` | yes | missing | 🟡 | S |
| Settings layering + live reload | yes | missing | 🟠 | L |

### F. Hooks
| Feature | CC | Book | Sev | Eff |
|---|---|---|---|---|
| Hook system (11 events, JSON-stdio, matcher, exit-code-2 block, input rewrite) | yes | missing | 🟠 | L |
| `hooks` config in settings.json (4 scopes) | yes | missing | 🟠 | M |
| HTTP hooks + URL/env allowlists | yes | missing | 🟢 | M |
| `--init`/`--init-only`/`--maintenance` Setup matchers | yes | missing | 🟢 | S |

### G. Extensibility surfaces
| Feature | CC | Book | Sev | Eff |
|---|---|---|---|---|
| Slash commands as `.book/commands/*.md` | yes | missing | 🟠 | M |
| Skills (`SKILL.md`, model-invoked, listing budgets) | yes | missing | 🟡 | L |
| Subagents (`.book/agents/*.md` + `Task`) | yes | missing | 🔴 | L |
| MCP client (`.book/mcp.json`, stdio/SSE/HTTP, `mcp__` tools) | yes | missing | 🟠 | XL |
| Plugins (marketplace, `/plugin`) | yes | missing | 🟢 | XL |
| Output styles | yes | missing | 🟡 | M |
| `--bare`/`--safe-mode` discovery toggles | yes | missing | 🟡 | S |

### H. TUI / UX
| Feature | CC | Book | Sev | Eff |
|---|---|---|---|---|
| Scrollback / fullscreen alt-screen (`tui: fullscreen`) | yes | missing (B7) | 🟠 | L |
| Diff rendering for edits | yes | missing | 🟠 | M |
| Vim mode (`editorMode`) | yes | missing | 🟡 | M |
| Multiline input | yes | missing | 🟡 | M |
| `@`-file mentions + `!`-shell mode | yes | missing | 🟡 | M |
| `/help` + slash-command palette | yes | missing | 🟠 | S |
| Slash commands: `/compact /resume /config /model /permissions /cost /vim …` | yes | missing | 🟠 | M |
| Custom status line (`statusLine` command) | yes | missing | 🟢 | M |
| Custom keyboard shortcuts | yes | missing | 🟢 | M |
| Theme switching (dark/light/ansi/daltonized + custom) | yes | missing | 🟡 | M |
| `--ax-screen-reader` (wire existing config flag) | yes | partial | 🟡 | S |
| Turn duration / thinking summaries display | yes | missing | 🟢 | S |
| Image paste | yes | missing | 🟡 | L |

### I. Enterprise / SDK / IDE
| Feature | CC | Book | Sev | Eff |
|---|---|---|---|---|
| Managed/enterprise settings (MDM/registry/`managed-settings.json` drop-ins) | yes | missing | 🟢 | L |
| Agent SDK (programmatic `query()`) | yes | missing | 🟡 | L |
| VS Code / JetBrains IDE extension | yes | missing | 🟢 | XL |
| Telemetry/privacy toggles (`env`, OTEL helpers) | yes | missing | 🟢 | M |
| Voice dictation | yes | missing | 🟢 | L |

---

## 5. Sources
1. `cc_cli.txt` — CLI reference (flags table at line 1136; Tools/Hooks/Checkpointing/Interactive-mode sections).
2. `cc_settings.txt` — Settings reference (scopes, precedence, full settings-key catalog, permission rule syntax, sandbox subtree, plugin/MCP governance) lines 1131–1824.
3. `cc_overview.txt` — Overview (composability, Unix philosophy, the four surfaces, MCP as open standard, agent teams).
4. `_research/extensibility-philosophy.md` — authoritative clean synthesis: hooks event table, subagents/Task, MCP, plugins, skill anti-clutter budgets, scopes.
5. `src/**` — every book source file read directly for the implementation audit.
