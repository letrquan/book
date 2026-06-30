# M7 — Subagents & MCP

**Date:** 2026-06-26
**Status:** In Progress
**Depends on:** M1 ✅, M2 ✅, M3 ✅, M4 ✅, M5 ✅, M6 ✅

## Scope

Implement Claude Code's subagent system (the Task tool that spawns isolated-context
agents for bounded subtasks) and the Model Context Protocol client (connecting to
external MCP servers over stdio transport for new tools and data sources).

## Design decisions

### 1. Subagent architecture

A subagent is a lightweight agent run with:
- **Isolated context** — starts fresh, returns only the final result to the lead agent
- **Scoped tool allowlist** — can only use tools declared in its frontmatter
- **Own turn budget** — independent maxTurns
- **Optional model override** — cheaper/faster models for retrieval tasks

Subagents are defined as Markdown files in `.book/agents/` and `~/.book/agents/`:
- File name = agent name
- YAML frontmatter: `name`, `description`, `tools`, `model`, `maxTurns`

The lead agent spawns a subagent via the **Task** tool (matching CC's name).

Subagents can also be defined inline via the `--agents` CLI flag (JSON).

### 2. MCP client architecture

MCP (Model Context Protocol) is an open standard for connecting AI tools to external
data sources. The client connects to MCP servers over:
- **stdio transport** (spawn a process, communicate over stdin/stdout)
- **Deferred transports**: SSE, HTTP (later milestones)

MCP server tools appear under `mcp__<server>__<tool>` namespace and are governed by
the same permission system as built-in tools.

Server configuration in `.mcp.json` at project root and user `~/.book/mcp.json`:
```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  }
}
```

### 3. Context isolation

Subagents run with their own empty conversation history. The lead agent's context is
not polluted — only the subagent's final result (or error) is returned to the lead.
This mirrors how Codex/CC agents handle bounded investigations.

## Phases & Tasks

### Phase 1 — Subagent definition & loading (2 tasks)

- [ ] T7.1 Define subagent types and loader — scan `.book/agents/<name>.md` and
      `~/.book/agents/<name>.md` for YAML frontmatter (`name`, `description`, `tools`,
      `model`, `maxTurns`). Return resolved `SubagentDef` list. Write tests.
- [ ] T7.2 Implement agent loader tests — file discovery, frontmatter parsing, missing
      fields, scope merging

### Phase 2 — Subagent runner (2 tasks)

- [ ] T7.3 Implement `runSubagent(def, prompt, config)` — spawns a new agent loop with
      isolated context, restricted tool set, and independent turn budget. Returns
      the final assistant message content (or error).
- [ ] T7.4 Write subagent runner tests — tool allowlisting, isolated context, maxTurns
      enforcement, error propagation

### Phase 3 — Task tool (1 task)

- [ ] T7.5 Implement `Task` tool — takes agent name + prompt, loads subagent def,
      runs it via `runSubagent`, returns result as tool output. Register in registry.

### Phase 4 — MCP client (2 tasks)

- [ ] T7.6 Implement MCP stdio client — connect to MCP servers defined in `.mcp.json`,
      negotiate protocol (initialize→tools/list), expose tools under `mcp__<server>__<tool>`
      namespace.
- [ ] T7.7 Register MCP tools in the tool registry — merged with built-in tools, governed
      by same permission rules

### Phase 5 — E2E verification (1 task)

- [ ] T7.8 End-to-end verification — create a subagent markdown file, run headless with
      a prompt that triggers Task tool, verify subagent result appears in lead output.
      Also test MCP connectivity against a real MCP server.

## Out of scope (deferred)

- Subagent parallelism (concurrent subagent spawning) → M9
- Agent teams / lead-agent-coordinates → M9
- SSE/HTTP MCP transports → M8
- `claude mcp login` / OAuth → M8
- `--bg` / background subagents → M9
- Dynamic inline subagents via `--agents` flag → M8
