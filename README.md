# Book

AI coding agent CLI with rich terminal UI. An open-source, provider-agnostic alternative to Claude Code.

## Features

- **Interactive TUI** (Ink/React) plus **print mode** (`-p`) with `text` / `json` / `stream-json` output for CI.
- **Providers**: Anthropic Messages API (prompt caching, extended thinking, `--effort`) and any OpenAI-compatible endpoint, auto-detected from `baseUrl`.
- **Project context**: walks the tree to load `CLAUDE.md` (user-global → project → local → `.claude/rules/*.md`), injects git status, platform info, and the discovered skills, slash commands, and subagents into the system prompt.
- **Auto-memory**: file-based store under `~/.book/projects/<project>/memory/` with a `MEMORY.md` index (first 200 lines auto-loaded). Four memory types (`user` / `feedback` / `project` / `reference`), YAML frontmatter, auto-capture on user corrections/confirmations, and an **approval flow** (`/memory inbox` → `/memory approve|discard`). Secret/unfit text is rejected before writing.
- **Slash commands**: built-ins including `/init`, `/model`, `/config`, `/permissions`, `/cost`, `/usage`, `/context`, `/memory`, `/diff`, `/export`, `/skills`, `/review`, `/security-review`, `/release-notes`, `/feedback`, plus custom commands from `.book/commands/*.md`.
- **Permissions**: allow/ask/deny rule matching with six permission modes (default, acceptEdits, plan, bypassPermissions, and more) — see `/permissions`.
- **Sandbox & hooks**: optional bubblewrap sandbox for Bash; lifecycle hooks (JSON-over-stdio contract) for `PreToolUse` / `PostToolUse` / etc.
- **Skills & subagents**: discover skills from `.book/skills/` and subagents from `.book/agents/`; delegate via the `Task` tool.
- **MCP**: stdio-transport MCP client for tool servers.

See [`MILESTONES.md`](./MILESTONES.md) for the full progress roadmap (Phase 1 Claude-Code-parity work, Phase 2 harness extension points, Phase 3 polish).

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
book --resume
book --continue  # most recent session in current directory
```

## Configuration

Settings are loaded from:

1. `~/.book/settings.json` (user-global)
2. `.book/settings.json` (project)
3. `.book/settings.local.json` (local, should be gitignored)

### Example `.book/settings.json`

```json
{
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
  }
}
```

## Slash Commands

Create custom slash commands by adding Markdown files to `.book/commands/`:

```markdown
---
description: Check for spelling errors
---

Run a spell check on the codebase and fix any issues found.
```

## SDK Usage

```typescript
import { query } from 'book';

for await (const event of query("Explain this code", {
  workspace: process.cwd(),
  apiKey: process.env.BOOK_API_KEY,
})) {
  if (event.type === 'text') console.log(event.text);
}
```

## Development

```bash
npm run typecheck    # TypeScript check
npm test             # Run tests
npm run build        # Build for distribution
```

## License

MIT
