# Book AI Agent — Design Spec

**Date:** 2026-06-25
**Status:** Draft
**Approach:** B — cmdc-inspired clone with full tool suite

## Overview

Book is an AI-powered coding agent CLI tool with a rich TUI. It mimics the capabilities of `command-code` (cmdc): an agent loop that accepts user prompts, calls an LLM with tool definitions, executes tools, and streams responses back. It includes a full tool suite (file, shell, git, design partner, browser automation) and a visually animated ANSI-art TUI.

## Technology Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (ESM) |
| Runtime | Node.js 18+ |
| CLI framework | Commander |
| TUI | Ink (React for CLI) |
| AI provider | OpenAI-compatible HTTP API |
| Build | tsup |
| Package manager | npm |

## Architecture

```
+-------------------------------------------------------------+
|                        TUI (Ink/React)                       |
|  +---------+ +----------+ +-----------+ +--------------+   |
|  | Chat    | | Tool     | | Design    | | Browser      |   |
|  | Panel   | | Output   | | Commands  | | Preview      |   |
|  +---------+ +----------+ +-----------+ +--------------+   |
+-------------------------------------------------------------+
|                     Agent Core                               |
|  +--------------+ +--------------+ +---------------------+  |
|  | Prompt Loop  | | Tool Registry| | Context Builder     |  |
|  | (streaming)  | | (pluggable)  | | (system + history)  |  |
|  +--------------+ +--------------+ +---------------------+  |
+-------------------------------------------------------------+
|                     Provider Layer                           |
|  +------------------------------------------------------+   |
|  |  OpenAI-compatible HTTP client (configurable base URL)|   |
|  +------------------------------------------------------+   |
+-------------------------------------------------------------+
|                     Tool System (Full Suite)                  |
|  +--------+ +--------+ +--------+ +--------+ +----------+  |
|  | File   | | Shell  | | Search | | Design | | Browser  |  |
|  | Tools  | | Tools  | | Tools  | | Tools  | | Tools    |  |
|  +--------+ +--------+ +--------+ +--------+ +----------+  |
+-------------------------------------------------------------+
```

## Agent Core & Prompt Loop

The agent loop is the heart of the system:

```
User types prompt in TUI
        |
        v
+----------------------+
|  Context Builder     |
|  - System prompt     |
|  - Tool definitions  |
|  - Conversation hist |
|  - Workspace context |
+----------+-----------+
           |
           v
+----------------------+
|  Provider (stream)   |
|  POST /chat/complete |
|  -> text chunk       |
|  -> tool_call chunk  |
+----------+-----------+
           |
           +-- text --> TUI (stream to chat panel)
           |
           +-- tool_call --> Tool Registry --> Execute tool
                                  |                  |
                                  |                  v
                                  |           Tool result
                                  |                  |
                                  +-- append to <----+
                                      conversation
                                      history
                                          |
                                          v
                                  Loop back to Context Builder
                                  (up to max_turns, default 25)
```

- **Streaming:** Text chunks stream to TUI in real-time. Tool calls accumulated until complete, then executed.
- **Max turns:** 25 agent turns per user message (configurable via `BOOK_MAX_TURNS`).
- **Context window:** Oldest messages dropped when approaching model's context limit. System prompt always preserved.
- **System prompt:** Loaded from template with variable substitution (workspace, OS, date, tools).

## Tool System

Pluggable tool registry. Each tool registers: name, description, JSON Schema parameters, execute handler.

| Category | Tools |
|---|---|
| **File** | `read_file`, `write_file`, `edit_file`, `glob`, `grep` |
| **Shell** | `bash` (with timeout, working dir, stdout/stderr capture) |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_branch` |
| **Design** | `/design audit`, `/design smell`, `/design review`, `/design deslop`, `/design recolor`, `/design typeset`, `/design tokenize`, `/design relayout`, `/design responsive`, `/design motion`, `/design interaction`, `/design refine`, `/design surface` |
| **Browser** | `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_evaluate` |

- Tools run sequentially in the agent loop (no parallel execution in v1).
- Each tool returns `{ success, output, error? }`.
- Tools share a `ToolContext` (workspace root, env vars).
- Design tools are available as LLM tool calls. The `/design` slash command in the TUI is a shortcut.
- Browser uses Chrome DevTools Protocol (CDP) with headless Chrome.

## TUI Layout

```
+===============================================================+
|  ++++++  ++++++  ++++++ ++  ++     v0.1.0              |
|  ++==++ ++==++ ++==++ ++ =++     [glm-5.2]            |
|  ++++++ ++   ++ ++   ++ ++++++                          |
|  ++==++ ++   ++ ++   ++ ++=+++                          |
|  ++++++ ++++++ ++++++ ++  ++                          |
|  +=====  +=====  +=====  +=  +=                          |
+===============================================================+
|                                                               |
|  ..........................................................  |
|  .  Add a login page to the React app                      .  |
|  ..........................................................  |
|                                                               |
|  +-- Agent -------------------------------------------------+  |
|  |                                                         |  |
|  |  spinner I'll start by exploring the project structure.  |  |
|  |                                                         |  |
|  |  +-- read_file -------------------------------------+   |  |
|  |  | src/App.tsx                                       |   |  |
|  |  | [OK] 45 lines                                     |   |  |
|  |  +---------------------------------------------------+   |  |
|  |                                                         |  |
|  |  +-- glob ------------------------------------------+   |  |
|  |  | src/components/**/*.tsx                           |   |  |
|  |  | [OK] 12 files                                     |   |  |
|  |  +---------------------------------------------------+   |  |
|  |                                                         |  |
|  |  spinner Now creating the Login component...             |  |
|  |                                                         |  |
|  +---------------------------------------------------------+  |
|                                                               |
|  +-- Prompt ----------------------------------------------+  |
|  | > _                                                    |  |
|  +--------------------------------------------------------+  |
+===============================================================+
|  /help  /design  /browser  /clear  /exit       tokens: 1.2k  |
+===============================================================+
```

### ANSI Art & Animation

| Element | Animation |
|---|---|
| Header | ASCII art "BOOK" logo with color cycling (cyan to magenta to cyan) |
| Agent thinking | Braille spinner at line start, 80ms rotation. Text streams with typewriter effect |
| Agent panel border | Pulsing border (dim/bright alternating) while agent is active |
| Tool execution | Dot spinner while running, then `[OK]` (green) or `[ERR]` (red) |
| Streaming text | Characters appear at 2-3ms intervals (typewriter effect) |
| Status bar | Token count blinks when approaching context limit |

### Color Palette

| Element | Color |
|---|---|
| Borders/separators | Cyan |
| Agent name/header | Magenta to Cyan gradient |
| `[OK]` | Green |
| `[ERR]` | Red |
| User messages | White bold |
| Agent text | White |
| Secondary text | Gray |

### Interaction

- Type prompt, press Enter to send
- Up/Down arrows navigate prompt history
- `/design` opens design partner sub-command palette
- `/browser` opens browser automation commands
- `/clear` resets conversation
- `/exit` or Ctrl+C quits

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BOOK_API_KEY` | (required) | API key for provider |
| `BOOK_BASE_URL` | `https://api.openai.com/v1` | Provider base URL |
| `BOOK_MODEL` | `gpt-4o` | Default model |
| `BOOK_MAX_TURNS` | `25` | Max agent turns per message |
| `BOOK_WORKSPACE` | cwd | Default workspace root |

### Config File (`.bookrc.json`)

```json
{
  "model": "glm-5.2",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "maxTurns": 25,
  "theme": "dark",
  "tools": {
    "browser": { "enabled": true, "headless": true },
    "design": { "enabled": true }
  },
  "animation": {
    "typewriterSpeed": 3,
    "spinnerStyle": "braille"
  }
}
```

Priority: env vars override config file. Config loaded from `.bookrc.json` in workspace root, falling back to home directory.

## Directory Structure

```
book/
  src/
    index.ts              # CLI entry point (Commander setup)
    server.ts             # TUI bootstrap, provider init
    agent/
      loop.ts             # Agent prompt loop
      context.ts          # Context builder (system prompt + history)
      types.ts            # Agent types (Message, ToolCall, etc.)
    tui/
      app.tsx             # Ink app root
      components/
        Header.tsx         # ASCII art header with color cycling
        ChatPanel.tsx      # Scrollable chat area
        InputBar.tsx       # Prompt input with history
        StatusBar.tsx      # Slash commands, token count
        AgentResponse.tsx  # Animated agent text + tool calls
        ToolResult.tsx     # Tool execution display
        Spinner.tsx        # ANSI spinner component
      hooks/
        useAgent.ts        # Agent loop state management
        useAnimation.ts    # Animation timers (spinners, typewriter)
    tools/
      registry.ts          # Tool registration & discovery
      types.ts             # Tool definition types
      file/
        read.ts            # read_file
        write.ts           # write_file
        edit.ts            # edit_file
        glob.ts            # glob
        grep.ts            # grep
      shell/
        bash.ts            # shell execution
      git/
        status.ts
        diff.ts
        log.ts
        commit.ts
      design/
        index.ts           # Design partner subsystem
        audit.ts
        review.ts
        recolor.ts
        typeset.ts
        tokenize.ts
      browser/
        index.ts           # Browser automation (CDP)
        navigate.ts
        click.ts
        type.ts
        screenshot.ts
        evaluate.ts
    provider/
      openai-compatible.ts # HTTP client for OpenAI-compatible APIs
      types.ts             # Provider interface types
    config.ts              # Config loading (.bookrc + env)
  package.json
  tsconfig.json
  .bookrc.json             # Default config template
```

## Error Handling

| Scenario | Behavior |
|---|---|
| API key missing | Error at startup: "BOOK_API_KEY not set" |
| API rate limit (429) | Exponential backoff (1s, 2s, 4s, 8s), show retry status |
| API timeout | 120s timeout, show "Request timed out", offer retry |
| API error | Display error, agent panel shows `[ERR]` |
| Tool execution fails | `[ERR]` with stderr, agent loop continues |
| Max turns exceeded | "Reached max turns (25). Refine prompt or increase BOOK_MAX_TURNS." |
| Context window full | Trim oldest messages, show warning |
| Shell command hangs | 120s timeout, kill process, return `[ERR] Command timed out` |
| File not found | `[ERR] File not found: path/to/file` |
| Browser not available | `[ERR] Chrome not found. Install Chrome or set CHROME_PATH` |
| Invalid config | Validate on load, show parse errors, fall back to defaults |
| Terminal resize | Ink handles re-render |
| Ctrl+C during work | Cancel API request, clear spinner, return to prompt |
| Unicode/encoding | UTF-8 for all file I/O, replacement chars for invalid bytes |

## Dependencies

### Production

| Package | Purpose |
|---|---|
| `commander` | CLI argument parsing |
| `ink` | React for terminal UI |
| `react` | Ink peer dependency |
| `chalk` | Terminal string styling |
| `zod` | Schema validation for config and tool params |
| `undici` | HTTP client for streaming API calls |
| `chrome-remote-interface` | CDP client for browser automation |
| `fast-glob` | File globbing |
| `ignore` | Gitignore-style file filtering |
| `minimatch` | Glob pattern matching |

### Dev

| Package | Purpose |
|---|---|
| `tsup` | TypeScript bundling |
| `typescript` | Type checking |
| `@types/react` | React type definitions |
| `@types/node` | Node.js type definitions |
| `vitest` | Testing |
