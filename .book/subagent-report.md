# Subagent Implementation Report

## Current State

The subagent system in Book is **fully implemented and production-ready**. It follows Claude Code's subagent model closely, with file-based discovery, tool restriction, model override, isolated context, nested tool observation, and TUI rendering. The system is well-tested with unit tests covering discovery, execution, tool restriction, trace propagation, and the message accumulator path.

### Architecture Overview

```
User prompt → Main agent loop → Task tool → runSubagent() → isolated agent loop
                                                                ↓
                                                          Subagent body (system prompt)
                                                          + restricted tools
                                                          + model override
                                                          + max turns
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `SubagentDef` | `src/subagent-discovery.ts` | Defines subagent metadata (name, tools, model, maxTurns, body) |
| `discoverAgents()` | `src/subagent-discovery.ts` | Scans `.book/agents/*.md` and `~/.book/agents/*.md` |
| `runSubagent()` | `src/subagent.ts` | Runs an isolated agent loop with restricted context |
| `taskTool` | `src/tools/task-tool.ts` | The `Task` tool the model invokes |
| `NestedToolObserver` | `src/types.ts` | Display-only observer for live subagent tool tracing |
| `NestedToolInvocation` | `src/types.ts` | Display-only trace record for nested tools |
| `MessageAccumulator` | `src/tui/hooks/message-accumulator.ts` | Batches streaming updates including nested tool events |
| `AgentMessage` / `NestedToolRows` | `src/tui/components/AgentMessage.tsx` | TUI rendering of subagent tool traces |
| `tool-traces.ts` | `src/tui/tool-traces.ts` | Indexing and auto-expand logic for nested traces |

### Flow Detail

1. **Discovery** (`subagent-discovery.ts`): Reads `*.md` files from `~/.book/agents/` and `.book/agents/`. Parses YAML frontmatter for `name`, `description`, `tools`, `model`, `maxTurns`. The body becomes the subagent's system prompt.

2. **Task Tool** (`task-tool.ts`): Validates agent name, looks up the definition, creates a fresh default registry, and calls `runSubagent()`.

3. **Execution** (`subagent.ts`):
   - Builds a restricted `ToolRegistry` from `def.allowedTools` (empty = all tools).
   - Overrides `AgentConfig` with subagent-specific `maxTurns`, `model`, and disables auto-compact.
   - Calls `runAgentLoop()` with `bypassPermissions` mode, empty history, and the combined body+prompt as the first user message.
   - Passes `nestedToolObserver` and `parentToolTraceId` for live TUI visibility.

4. **Agent Loop** (`agent/loop.ts`): The standard loop with `isSubagent: true` flag, which skips memory auto-capture and session lifecycle hooks.

5. **Nested Tool Observation** (`agent/loop.ts` → `types.ts` → TUI):
   - During streaming, each tool call in the subagent gets a stable trace ID: `{parentTraceId}/{turn}-{index}:{toolCallId}`.
   - The observer forwards these as `NestedToolInvocation` records to the `MessageAccumulator`.
   - The accumulator appends them to `message.nestedToolInvocations[]`.
   - `AgentMessage` renders them via recursive `NestedToolRows`.

6. **Tool Execution** (`tools/registry.ts`): The registry's `executeWithTimeout` creates a scoped `nestedToolObserver` that forwards nested calls through a proxy `ToolContext`, with proper cleanup on timeout/cancel.

### What's Working Well

- **Clean isolation**: Subagent starts with empty history, own system prompt, restricted tools.
- **Live TUI visibility**: Nested tool calls appear as indented children under the Task block, with spinners while running.
- **Proper trace IDs**: Stable across duplicate provider tool-call IDs via composite construction.
- **Graceful degradation**: Max turns reached is not fatal if output was produced; errors are surfaced cleanly.
- **Atomic timeout/cancel**: `executeWithTimeout` races execution, timeout, and parent abort, cleaning up pending nested calls.

---

## Improvement Plan

### Priority 1: Core Robustness

#### 1.1 Subagent-Level Timeout
**Gap**: `runSubagent` has no built-in timeout. If the subagent enters a long loop, the parent has no way to enforce a deadline.
**Plan**: Add an optional `timeoutMs` parameter to `SubagentDef` and `runSubagent()`. Create a `AbortController` with a timeout and merge it with the parent signal. Default: 5 minutes.

#### 1.2 Token/Cost Attribution
**Gap**: The `onUsage` callback in `runSubagent` is a no-op. Subagent token usage is invisible to `/cost` and `/usage`.
**Plan**: Collect usage per subagent, attach it to the `Task` tool result as structured metadata. Display in `/cost` breakdown.

#### 1.3 Error Classification
**Gap**: All errors are strings. No distinction between "tool not found", "max turns", "provider error", "timeout".
**Plan**: Add an `errorKind` field to the return type: `'tool-not-found' | 'max-turns' | 'provider-error' | 'timeout' | 'aborted' | 'unknown'`.

### Priority 2: Agent Definition Enhancements

#### 2.1 Environment Variable Injection
**Gap**: Subagent prompts are static. No way to pass dynamic context (like a specific file path or branch name).
**Plan**: Add an `env` field to `SubagentDef` frontmatter. Support `$VAR` substitution in the body at invocation time via the `prompt` string.

#### 2.2 Built-in Agent Registry
**Gap**: All agents must be defined as `.md` files. Common patterns (code review, security audit) require manual setup.
**Plan**: Add a `BUILTIN_AGENTS` array in `subagent-discovery.ts` (similar to `BUILTIN_COMMANDS`). These are always available without file creation.

#### 2.3 Inheritance / Composition
**Gap**: No way to define a base agent and specialize it. DRY violation across similar agents.
**Plan**: Support `extends: <base-name>` in frontmatter. The base agent's body, tools, and model are merged with the child (child wins on conflict).

### Priority 3: Observability & Debugging

#### 3.1 Subagent Activity Panel
**Gap**: Nested tool traces are shown inline under the Task block, but there's no summary view.
**Plan**: Add a collapsible "Subagent Activity" summary at the end of the Task block: total tools called, turns used, duration, error count.

#### 3.2 Debug Logging
**Gap**: `createDebugLogger('subagent')` is not used.
**Plan**: Add structured debug logs for subagent start/end, tool count, turn count, and duration.

### Priority 4: Advanced Features

#### 4.1 Parallel Subagent Execution
**Gap**: Subagents run sequentially. The model cannot launch multiple tasks simultaneously.
**Plan**: Support a `parallel: true` flag in the `Task` tool. When multiple Task calls appear in one assistant turn, launch them concurrently and merge results. Requires changes to the agent loop's tool execution phase.

#### 4.2 Subagent-to-Subagent Communication
**Gap**: Subagents cannot share context. Each is fully isolated.
**Plan**: Add a shared `SubagentContext` map on `AgentConfig` that subagents can read/write. Keys are strings; values are strings. Scoped to the session.

#### 4.3 Conditional Tool Allowlists
**Gap**: `allowedTools` is static per agent definition.
**Plan**: Support runtime tool filtering via a `toolFilter` callback in `SubagentDef` that receives the prompt and returns the final tool set. Enables prompt-dependent tool access.

### Priority 5: Testing & Documentation

#### 5.1 Integration Tests
**Gap**: Unit tests cover discovery and mock execution. No end-to-end test with a real provider.
**Plan**: Add integration test that launches a real subagent with a mock provider, verifying full trace propagation and tool execution.

#### 5.2 Documentation
**Gap**: No user-facing docs on how to create and use subagents.
**Plan**: Add a `docs/subagents.md` guide covering: file format, frontmatter fields, examples, built-in agents, debugging tips.

---

## Summary

The subagent system is architecturally sound and covers the core use case well. The highest-value improvements are **token attribution** (P1.2), **subagent timeout** (P1.1), and **built-in agents** (P2.2). The parallel execution feature (P4.1) would be a significant capability unlock but requires careful design around the agent loop's tool execution phase.
