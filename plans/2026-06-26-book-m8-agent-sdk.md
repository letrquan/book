# M8 — Agent SDK

**Date:** 2026-06-26
**Status:** In Progress
**Depends on:** M1 ✅, M2 ✅, M3 ✅, M4 ✅, M5 ✅, M6 ✅, M7 ✅

## Scope

Make book a consumable **library** (not just a CLI binary) and add operational tooling.
Three epics: SDK `query()` async iterable API, `book doctor`/`book config` subcommands,
and stream-json enrichments for CI.

## Design decisions

### 1. SDK exports

Package.json gets an `exports` map so consumers can:
```ts
import { query, createSession, loadConfig } from 'book';
```

`query()` returns an async iterable of `QueryEvent` (text, tool_call, tool_result,
message, result). Reuses `runHeadless()` internally. Options mirror CLI flags.

### 2. book doctor

Prints a diagnostic report: active settings layers, hooks status, MCP server status,
version, environment, any invalid config entries. Pure inspection — never modifies.

### 3. book config

`book config get <key>` prints the resolved value of a single settings key.
`book config set <key> <value>` writes to `.book/settings.local.json`.
`book config list` prints all resolved settings. Matches CC's `/config key=value`.

### 4. Stream-json enrichments

`--include-hook-events` emits hook lifecycle events as stream-json lines.
`--include-partial-messages` emits partial assistant text (already done via stream-json).
`--prompt-suggestions` lets the model suggest follow-up prompts.

## Phases & Tasks

### Phase 1 — SDK exports (2 tasks)

- [ ] T8.1 Add package.json `exports` map for `book` SDK
- [ ] T8.2 Implement `query()` async iterable + `createSession()` in `src/sdk.ts`

### Phase 2 — book doctor + config (2 tasks)

- [ ] T8.3 Implement `book doctor` CLI subcommand
- [ ] T8.4 Implement `book config get/set/list` CLI subcommand

### Phase 3 — E2E & cleanup (1 task)

- [ ] T8.5 End-to-end verification — SDK import test, doctor output, config read/write
