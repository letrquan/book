# M5 — Hooks

**Date:** 2026-06-26
**Status:** In Progress
**Depends on:** M1 ✅, M2 ✅, M3 ✅, M4 ✅

## Scope

Implement Claude Code's hooks system — user-defined shell commands that run at lifecycle
events within the agent loop. Hooks communicate over a JSON-over-stdio contract and can
block, modify, or observe agent behavior.

## Design decisions

### 1. Hook event set

| Event | Fires when | Effect |
|-------|-----------|--------|
| `SessionStart` | Session begins | Can add to system prompt |
| `SessionEnd` | Session ends | Cleanup, notification |
| `UserPromptSubmit` | User submits a prompt | Can modify/prevent the prompt |
| `PreToolUse` | Before tool execution | Can block or modify the tool call |
| `PostToolUse` | After tool returns | Can format/lint/log |
| `Stop` | Agent finishes a turn | Cleanup per-turn |
| `PreCompact` | Before context compaction | Snapshot before summarization |

Deferred: `Notification`, `SubagentStop`, `Setup`, `ConfigChange` (M6–M8 when
subagents and live reload are implemented).

### 2. Hook configuration in settings.json

Hooks are configured under the `hooks` key in `settings.json`, matching CC's schema:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(rm *)",
        "command": "echo 'BLOCKING rm' && exit 1",
        "env": { "WORKSPACE": "$BOOK_WORKSPACE" }
      }
    ],
    "PostToolUse": [
      {
        "command": "./tools/lint.sh"
      }
    ]
  }
}
```

Each hook entry:
- `matcher` (optional): `Tool(specifier)` pattern to filter which tool calls trigger this hook
- `command`: shell command to run (passed through system shell)
- `env` (optional): extra environment variables

### 3. Hook contract (JSON-over-stdio)

Input (stdin): JSON hook event
```json
{
  "hook": "PreToolUse",
  "tool_name": "Bash",
  "tool_args": {"command": "rm -rf /"},
  "workspace": "/path/to/project"
}
```

Output (stdout): JSON response. Exit code 0 = continue, exit code 2 = block.
```json
{"action": "continue"}
{"action": "block", "message": "rm is not allowed in this project"}
```

### 4. Hook ordering

Hooks run in the order declared in settings (merged across scopes). A `PreToolUse` block
by any hook prevents tool execution.

### 5. Timeout

Each hook has a 10-second timeout. If it doesn't respond within the timeout, it's skipped
(with a warning) — hooks must not block the agent.

## Phases & Tasks

### Phase 1 — Hook schema & settings integration (2 tasks)

- [ ] T5.1 Extend `BookSettings` with `hooks` key — Zod schema for hook arrays keyed by event
- [ ] T5.2 Write hook loading test — verify hooks merge across scopes (user→project→local)

### Phase 2 — Hook runner (2 tasks)

- [ ] T5.3 Implement `runHooks(event, context)` — spawn shell processes, collect JSON responses
      within timeout, honor block signals
- [ ] T5.4 Write unit tests — hook runs successfully, hook blocks, hook timeout, hook
      with env vars, matcher filtering

### Phase 3 — Integration into agent loop (3 tasks)

- [ ] T5.5 Wire `SessionStart` and `SessionEnd` hooks into `runAgentLoop` and `runHeadless`
- [ ] T5.6 Wire `UserPromptSubmit` — modify or prevent user prompts before the model sees them
- [ ] T5.7 Wire `PreToolUse` and `PostToolUse` — block/modify tool calls and post-process results

### Phase 4 — Wiring & cleanup (2 tasks)

- [ ] T5.8 Wire `Stop` and `PreCompact` hooks
- [ ] T5.9 End-to-end verification — create a hook that blocks `Bash(rm *)`, verify
      headless mode respects it

## Out of scope (deferred)

- `Notification` / `SubagentStop` → M7 Subagents
- `Setup` / `ConfigChange` → M8 Agent SDK / live reload
- HTTP hooks → M8 (needs HTTP infra)
- `allowedHttpHookUrls` / `httpHookAllowedEnvVars` → deferred
- `allowManagedHooksOnly` → deferred (managed settings in M8)
