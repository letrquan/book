# Book

AI coding agent CLI with rich terminal UI. An open-source, provider-agnostic alternative to Claude Code.

## Installation

```bash
git clone <repo>
cd book
npm install
npm run build
npm link  # makes `book` available globally
```

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
