# CLAUDE.md

## Project: Book — AI Coding Agent CLI

Book is an open-source, provider-agnostic alternative to Claude Code. It provides an interactive terminal UI (TUI) and headless/CI mode for AI-assisted coding.

**Tech stack**: TypeScript, ES2022/ESM, React (via Ink v6) for TUI, tsup for building, Vitest for testing, Zod for config validation.

## Architecture

```
src/
  index.ts          CLI entry (Commander.js)
  sdk.ts            Programmatic SDK (query() generator)
  types.ts          All shared types (no runtime imports)
  config.ts         Config loading (env vars, settings.json, legacy .bookrc.json)
  settings.ts       Zod schemas for settings
  settings-loader.ts  Layered settings resolver (~/.book → .book → .book/settings.local.json)
  frontmatter.ts    Shared YAML frontmatter parser
  permissions.ts    Permission rule parsing/evaluation
  hooks.ts          Lifecycle hook runner (JSON-over-stdio contract)
  sandbox.ts        Bash sandbox via bubblewrap
  skills.ts         Skill discovery from .book/skills/
  subagent.ts       Subagent discovery and runner
  mcp.ts            MCP client (stdio transport)
  headless.ts       Headless/print mode runner
  stream-json.ts    (future) Shared stream-JSON parser
  agent/
    loop.ts         Core agent loop (runAgentLoop)
    context.ts      System prompt builder, message formatter
    compact.ts      Context compaction logic
  commands/
    loader.ts       Slash command discovery from .book/commands/
  provider/
    openai-compatible.ts  OpenAI-compatible streaming client (SSE, retry, abort)
  session/
    store.ts        JSONL session persistence
  tools/
    registry.ts     Tool registry (createRegistry, createDefaultRegistry)
    aliases.ts      Tool name aliases (legacy → canonical)
    primary-arg.ts  Extract primary arg from tool args
    glob-regex.ts   Glob-to-regex converter
    file.ts         Read/Write/Edit/MultiEdit/Glob/Grep
    shell.ts        Bash tool
    git.ts          Git tools
    web.ts          WebFetch/WebSearch
    todo.ts         TodoWrite tool
    diff.ts         Unified diff generator
    gitignore.ts    .gitignore loader
    skills-tool.ts  InvokeSkill tool
    task-tool.ts    Task (subagent) tool
  tui/
    app.tsx         Root Ink/React component
    theme.ts        Theme context and custom theme loader
    status-indicators.ts  Shared status icons
    hooks/
      useAgent.ts   Core agent state hook
      useAnimation.ts  Animation hook
      useGitStatus.ts  Git status polling
      useTasks.ts   User task list hook
    components/
      ChatPanel.tsx       Message list renderer
      InputBar.tsx        Text input with mode indicator
      StatusLine.tsx      Status bar
      ToolCallBlock.tsx   Collapsible tool call display
      PermissionButtons.tsx  Permission prompt UI
      AgentMessage.tsx    Assistant message renderer
      UserMessage.tsx     User message renderer
      AgentTodoList.tsx   Agent todo list (TodoWrite)
      TaskList.tsx        User task list
      AsciiBanner.tsx     ASCII "BOOK" banner
      Spinner.tsx         Loading spinner
      Diff.tsx            Diff rendering
      ErrorBoundary.tsx   React error boundary for TUI
```

## Key conventions

- **No circular imports**: Entry points (`index.ts`, `sdk.ts`) are never imported by modules. TUI modules are leaves of the import graph.
- **Shared utilities live in dedicated files**: `frontmatter.ts`, `tools/aliases.ts`, `tools/primary-arg.ts`, `tools/glob-regex.ts`, `tui/status-indicators.ts`
- **Module-level mutable state is eliminated**: State flows through `ToolContext` or explicit parameters.
- **Tool names**: PascalCase (Read, Write, GitStatus, WebFetch). Legacy snake_case names handled via `tools/aliases.ts`.
- **`process.exit()` should use the `cli/exit.ts` abstraction** (future: allows test injection).

## Testing

- Framework: Vitest v3
- Run: `npm test` (single run), `npm run test:watch` (watch mode)
- Coverage: `npm run test:coverage`
- Tests are co-located with source (`*.test.ts` / `*.test.tsx`)
- Use `mkdtempSync` for temp directories (cleanup via `afterEach`)

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
```

## Configuration

Settings are loaded in priority order (last wins):
1. `~/.book/settings.json` (user-global)
2. `.book/settings.json` (project)
3. `.book/settings.local.json` (local, gitignored)
4. `--settings <path>` CLI flag

Legacy `.bookrc.json` is still supported but deprecated.
