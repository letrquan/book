# CLAUDE.md

## Project: Book — AI Coding Agent CLI

Book is an open-source, provider-agnostic alternative to Claude Code. It provides an interactive terminal UI (TUI) and headless/CI mode for AI-assisted coding.

**Tech stack**: TypeScript, ES2022/ESM, React (via Ink v6) for TUI, tsup for building, Vitest for testing, Zod for config validation.

**Version**: `0.1.0` (see `package.json` / `CHANGELOG.md`). Roadmap lives in `MILESTONES.md`.

## Architecture

```
src/
  index.ts              CLI entry (Commander.js) — flags + `doctor` / `config` subcommands
  cli/
    run.ts              Main interactive / headless action wiring
    doctor.ts           `book doctor`
    config-cmd.ts       `book config` get/set/list
    scrollback.ts       Terminal-native scrollback mode
    exit.ts             Process exit abstraction
    utils.ts            Shared CLI helpers
  sdk.ts                Programmatic SDK (`query()` async generator)
  types.ts              All shared types (no runtime imports)
  config.ts             Config loading (env vars, settings.json, legacy .bookrc.json)
  settings.ts           Zod schemas for settings
  settings-loader.ts    Layered settings resolver (~/.book → .book → .book/settings.local.json)
  settings-redaction.ts Redact secrets when dumping settings
  frontmatter.ts        Shared YAML frontmatter parser
  permissions.ts        Permission rule parsing/evaluation
  hooks.ts              Lifecycle hook runner (JSON-over-stdio contract)
  sandbox.ts            Bash sandbox via bubblewrap
  claude-md.ts          CLAUDE.md / rules tree-walk loader
  skills.ts             Skill discovery from .book/skills/
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
  memory-store.ts       File-based auto-memory store + MEMORY.md index
  memory-autosave.ts    Detect/capture memory candidates from user turns
  memory-display.ts     /memory rendering helpers
  agent/
    loop.ts             Core agent loop (runAgentLoop)
    context.ts          System prompt builder (two-zone cache split), message formatter
    compact.ts          Context compaction logic
  commands/
    builtins.ts         Built-in slash command catalog
    builtins-prompts.ts Prompt bodies for agent-backed commands (/init, /review, …)
    init-prompt.ts      /init prompt template
    loader.ts           Slash command discovery from .book/commands/*.md
    resolve.ts          Argument parsing, variable/shell substitution, env var resolution
    filter.ts           Command menu filtering
    recent.ts           Recent-command helpers
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
    registry.ts         Tool registry (createRegistry, createDefaultRegistry)
    aliases.ts          Tool name aliases (legacy → canonical)
    primary-arg.ts      Extract primary arg from tool args
    glob-regex.ts       Glob-to-regex converter
    path-utils.ts       Path safety helpers
    tool-capabilities.ts  Read-only / mutating / plan-mode capability flags
    file.ts             Read/Write/Edit/MultiEdit/Glob/Grep
    notebook.ts         NotebookEdit
    shell.ts            Bash / BashOutput / KillShell (+ run_in_background)
    git.ts              Git tools
    web.ts              WebFetch/WebSearch
    todo.ts             TodoWrite tool
    tasks.ts            TaskCreate/List/Get/Update/Stop
    plan-mode.ts        EnterPlanMode / ExitPlanMode
    ask-user-question.ts AskUserQuestion validation and pending-request tool
    diff.ts             Unified diff generator
    gitignore.ts        .gitignore loader
    skills-tool.ts      InvokeSkill tool
    task-tool.ts        Task (subagent) tool
  tui/
    app.tsx             Root Ink/React component (slash-command dispatch, overlays)
    theme.ts            Theme context and custom theme loader
    status-indicators.ts  Shared status icons
    mode-style.ts       Permission-mode labels/colors
    model-options.ts    Model picker data
    file-mentions.ts    @file mention resolution
    input-expansion.ts  Input expansion helpers
    mouse.ts            Mouse / scroll handling
    persist.ts          TUI-side session persistence helpers
    debug.ts            TUI debug instrumentation
    tool-traces.ts      Nested tool-trace bookkeeping
    transcript-scroll.ts  In-app transcript scrolling
    hooks/
      useAgent.ts       Core agent state hook
      useAnimation.ts   Animation hook
      useGitStatus.ts   Git status polling
      useTasks.ts       User task list hook
      message-accumulator.ts  Streaming message accumulation
      streaming-state.ts      Stream phase state
    components/
      CommandMenu.tsx         / command autocomplete menu
      FileMentionMenu.tsx     @ mention picker
      ChatPanel.tsx           Message list renderer
      TranscriptView.tsx      Transcript viewport
      InputBar.tsx            Text input with mode indicator
      StatusLine.tsx          Status bar
      ToolCallBlock.tsx       Collapsible tool call display
      tool-output.ts          Tool output formatting
      PermissionButtons.tsx   Permission prompt UI
      PlanApprovalButtons.tsx Plan-mode approval UI
      AskUserQuestionWizard.tsx Structured root/subagent question wizard
      AgentMessage.tsx        Assistant message renderer
      UserMessage.tsx         User message renderer
      MarkdownBlock.tsx       Markdown (tables, code, highlight)
      markdown-layout.ts      Width-aware markdown layout
      syntax-highlight.ts     Code fence highlighting
      word-wrap.ts            Display-width wrapping
      AgentTodoList.tsx       Agent todo list (TodoWrite)
      TaskList.tsx            User task list
      Bookplate.tsx           Compact editorial BOOK mark
      WelcomeScreen.tsx       Responsive startup welcome
      Spinner.tsx / WorkingIndicator.tsx
      Diff.tsx                Diff rendering
      ModelPicker.tsx         Model + effort picker
      ThemePicker.tsx         /theme palette picker
      ByokWizard.tsx          BYOK provider setup
      SessionPicker.tsx       /resume session picker
      ErrorBoundary.tsx       React error boundary for TUI
      transcript-messages.ts  Shared transcript message mapping
```

## Key conventions

- **No circular imports**: Entry points (`index.ts`, `sdk.ts`) are never imported by modules. TUI modules are leaves of the import graph.
- **Shared utilities live in dedicated files**: `frontmatter.ts`, `tools/aliases.ts`, `tools/primary-arg.ts`, `tools/glob-regex.ts`, `tui/status-indicators.ts`, `tui/mode-style.ts`.
- **Module-level mutable state is eliminated**: State flows through `ToolContext`, `AgentConfig`, or explicit parameters (session task/shell maps live on config for continuity).
- **Tool names**: PascalCase (Read, Write, GitStatus, WebFetch, TaskCreate, EnterPlanMode, …). Legacy snake_case names handled via `tools/aliases.ts` for execution only — not exposed as model-facing tools.
- **Permission modes** (internal): `default` | `auto` | `plan` | `accept-edits` | `dontAsk` | `bypassPermissions`. CLI/settings accept `acceptEdits` and normalize to `accept-edits`.
- **System prompt**: `buildSystemPromptZones()` produces a cacheable static prefix + dynamic per-turn suffix (Anthropic prompt caching).
- **`process.exit()` should use the `cli/exit.ts` abstraction** (allows test injection).

## Testing

- Framework: Vitest
- Run: `npm test` (single run), `npm run test:watch` (watch mode)
- Coverage: `npm run test:coverage`
- Tests are co-located with source (`*.test.ts` / `*.test.tsx`)
- Use `mkdtempSync` for temp directories (cleanup via `afterEach`)
- UI micro-benchmarks: `npm run bench:ui`

## Development

```bash
npm run typecheck    # Type-check only
npm test             # Run tests
npm run test:watch   # Watch mode
npm run build        # Build (tsup → dist/)
npm run dev          # Run directly via tsx
npm run lint         # ESLint
npm run format       # Prettier format
npm run format:check # Check formatting
npm run bench:ui     # TUI benchmarks
```

## Configuration

Settings are loaded in priority order (last wins):
1. `~/.book/settings.json` (user-global)
2. `.book/settings.json` (project)
3. `.book/settings.local.json` (local, gitignored)
4. `--settings <path>` CLI flag

Legacy `.bookrc.json` is still supported but deprecated. `--no-settings` skips all `settings.json` layers.

Env overrides commonly used in development: `BOOK_API_KEY`, `BOOK_BASE_URL`, `BOOK_MODEL`, `BOOK_PROVIDER`, `BOOK_EFFORT`, `BOOK_DEBUG*`.

## Notable product surfaces (keep docs in sync)

When changing these, update `README.md` / `CHANGELOG.md` / `MILESTONES.md` as appropriate:

- CLI flags and subcommands in `src/index.ts` + `src/cli/`
- Built-in slash commands in `src/commands/builtins.ts` (+ dispatch in `src/tui/app.tsx`)
- Default tool set in `src/tools/registry.ts` `createDefaultRegistry()`
- Permission modes in `src/types.ts` `PermissionMode`
- Memory paths and approval flow in `src/memory-store.ts` / `src/memory-autosave.ts`
