# Book

AI coding agent CLI with rich terminal UI. An open-source, provider-agnostic alternative to Claude Code.

## Features

- **Interactive TUI** (Ink/React) plus **print mode** (`-p`) with `text` / `json` / `stream-json` output for CI.
- **Providers**: Anthropic Messages API (prompt caching, adaptive thinking, `--effort`) and any OpenAI-compatible endpoint, auto-detected from `baseUrl` / `--provider`.
- **Project context**: walks the tree to load `CLAUDE.md` (user-global → project → local → `.claude/rules/*.md`), injects git status, platform info, and discovered skills, slash commands, and subagents into a two-zone system prompt (cacheable static prefix + dynamic per-turn suffix).
- **Auto-memory**: file-based store under `~/.book/projects/<project>/memory/` with a `MEMORY.md` index (first 200 lines auto-loaded). Four memory types (`user` / `feedback` / `project` / `reference`), YAML frontmatter, auto-capture on user corrections/confirmations, and an **approval flow** (`/memory inbox` → `/memory approve|discard`). Secret/unfit text is rejected before writing.
- **Sessions**: append-only JSONL persistence with `--resume`, `--continue`, `--session-id`, `--name`, `--fork-session`; in-TUI `/clear` / `/new` / `/reset`, `/resume`, and reference-aware `/compact`. Compaction reduces provider context without deleting the scrollable transcript: recent turns stay exact, older evidence remains addressable by stable session references, and remembered file facts are freshness-checked before reuse.
- **Tools**: file (`Read` / `Write` / `Edit` / `MultiEdit` / `Glob` / `Grep` / `NotebookEdit`), shell (`Bash` + `run_in_background`, `BashOutput`, `KillShell`), git, web (`WebFetch` / `WebSearch`), tasks (`TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `TaskStop`), structured clarification (`AskUserQuestion`), plan mode (`EnterPlanMode` / `ExitPlanMode`), skills (`InvokeSkill`), and subagent `Task` delegation.
- **Slash commands**: built-ins including `/init`, `/model`, `/effort`, `/config`, `/permissions`, `/cost`, `/usage`, `/context`, `/memory`, `/diff`, `/export`, `/skills`, `/review`, `/security-review`, `/release-notes`, `/feedback`, `/compact`, `/clear`, `/resume`, plus custom commands from `.book/commands/*.md`.
- **Permissions**: allow/ask/deny rule matching with six modes — `default`, `acceptEdits` (`accept-edits`), `plan`, `auto`, `dontAsk`, `bypassPermissions` — see `/permissions` or `--permission-mode`.
- **Sandbox & hooks**: optional bubblewrap sandbox for Bash; lifecycle hooks (JSON-over-stdio) for `PreToolUse` / `PostToolUse` / session events.
- **Skills & subagents**: discover skills from `.book/skills/` and subagents from `.book/agents/`; delegate via the `Task` tool.
- **MCP**: stdio-transport MCP client for tool servers.
- **CLI helpers**: `book doctor` (diagnose env/config) and `book config` (get/set/list settings).

See [`MILESTONES.md`](./MILESTONES.md) for the full progress roadmap (Phase 1 Claude-Code-parity work, Phase 2 harness extension points, Phase 3 polish). See [`CHANGELOG.md`](./CHANGELOG.md) for release notes.

## Installation

Requires **Node.js 20+**.

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
```

### Common flags

| Flag | Purpose |
| --- | --- |
| `-w, --workspace <path>` | Workspace root (default: cwd) |
| `-m, --model <model>` | Model override |
| `-p, --print [prompt]` | Non-interactive / CI mode |
| `--output-format <fmt>` | `text` \| `json` \| `stream-json` |
| `--permission-mode <mode>` | `default` \| `acceptEdits` \| `plan` \| `auto` \| `dontAsk` \| `bypassPermissions` |
| `--effort <level>` | Thinking effort: `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `--provider <type>` | `anthropic` \| `openai` \| `auto` |
| `--max-turns <n>` | Cap agent turns (print mode) |
| `--max-budget-usd <amount>` | Cap spend (print mode) |
| `--json-schema <schema>` | Structured JSON output (print mode) |
| `-r, --resume <id\|name>` | Resume a named/id session |
| `-c, --continue` | Resume most recent session here |
| `--session-id <uuid>` | Pin a session id |
| `-n, --name <name>` | Display name for the session |
| `--fork-session` | On resume, fork to a new session id |
| `--no-session-persistence` | Do not write the session to disk |
| `--settings <path>` / `--no-settings` | Ad-hoc settings file, or skip all layers |
| `--scrollback` | Terminal-native scrollback instead of full-screen TUI |

## Configuration

Settings are loaded in priority order (later wins):

1. `~/.book/settings.json` (user-global)
2. `.book/settings.json` (project)
3. `.book/settings.local.json` (local, should be gitignored)
4. `--settings <path>` CLI flag

Legacy `.bookrc.json` is still supported but deprecated. Use `--no-settings` to skip all `settings.json` layers (defaults + legacy only).

### Example `.book/settings.json`

```json
{
  "model": "claude-opus-4-6",
  "effort": "high",
  "permissions": {
    "allow": ["Read(*)", "Glob(*)", "Grep(*)"],
    "deny": ["Bash(rm *)", "Write(.env)"]
  },
  "sandbox": {
    "enabled": false
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash(*)", "command": "my-validator" }
    ]
  },
  "memory": {
    "enabled": true,
    "autoSave": true,
    "requireApproval": true
  }
}
```

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

| Variable | Purpose |
| --- | --- |
| `BOOK_API_KEY` | Default API key (or `{env:VAR}` in provider settings) |
| `BOOK_BASE_URL` | Default OpenAI-compatible base URL |
| `BOOK_MODEL` | Default model |
| `BOOK_PROVIDER` | `anthropic` \| `openai` \| `auto` |
| `BOOK_EFFORT` | Thinking effort level |
| `BOOK_WORKSPACE` | Default workspace |
| `BOOK_MAX_TOKENS` / `BOOK_MAX_TURNS` | Generation / turn limits |
| `BOOK_RETRY_*` / `BOOK_REQUEST_TIMEOUT_MS` / `BOOK_STREAM_STALL_TIMEOUT_MS` / `BOOK_TOOL_RETRIES` | Retry and timeout tuning |
| `BOOK_DEBUG` / `BOOK_DEBUG_UI` / `BOOK_DEBUG_RENDER` / `BOOK_DEBUG_FLOW` | Debug logging flags |

## Slash Commands

Create custom slash commands by adding Markdown files to `.book/commands/`:

```markdown
---
description: Check for spelling errors
---

Run a spell check on the codebase and fix any issues found.
```

Built-ins include session controls (`/clear`, `/resume`, `/compact`), config (`/model`, `/effort [low|medium|high|xhigh|max]`, `/config`, `/permissions`, `/theme`), inspection (`/status`, `/cost`, `/usage`, `/context`, `/diff`, `/skills`, `/memory`), and agent prompts (`/init`, `/review`, `/security-review`). `/effort` opens a picker when called without an argument and saves successful selections to `.book/settings.local.json`.

## SDK Usage

```typescript
import { query } from 'book';

for await (const event of query('Explain this code', {
  workspace: process.cwd(),
  onUserQuestionRequired: async (request) => ({
    action: 'answer',
    answers: Object.fromEntries(request.questions.map((question) => [
      question.question,
      question.multiSelect ? [question.options[0].label] : question.options[0].label,
    ])),
  }),
})) {
  if (event.type === 'text') process.stdout.write(event.content);
  if (event.type === 'tool_use') console.log('tool:', event.toolCall.name);
  if (event.type === 'result') console.log('usage:', event.usage);
}
```

`AskUserQuestion` supports 1-4 questions, described single/multi-select choices, and free-text answers in the TUI. Root agents and nested `Task` subagents use the same callback. Print mode emits `user_question` / `user_question_result` stream events and declines deterministically when no callback is supplied; stdin response round-trips are not supported in v1.

Auth and model selection come from settings / env (`BOOK_API_KEY`, `BOOK_MODEL`, provider blocks), not from `query()` options. See `src/sdk.ts` for the full `QueryEvent` / `QueryOptions` surface.

## Development

```bash
npm run typecheck    # TypeScript check
npm test             # Run tests (vitest run)
npm run test:watch   # Watch mode
npm run test:coverage
npm run build        # tsup → dist/
npm run dev          # Run via tsx
npm run lint         # ESLint
npm run format       # Prettier
npm run format:check
npm run bench:ui     # TUI micro-benchmarks
```

## License

MIT
