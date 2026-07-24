# Performance and Resource Assessment

**Date:** 2026-07-23  
**Scope:** Agent runtime, rewind snapshots, session persistence, tools, TUI streaming, and
long-lived process resources.

## Executive Summary

The largest performance costs are local filesystem work rather than provider streaming. Rewind
snapshots currently read and hash the workspace before every user prompt, session startup fully
replays every historical session, and the built-in Grep tool performs sequential file scanning.
These paths should be addressed before lower-impact rendering or allocation work.

Measured on the current development machine and repository:

| Area | Observed result |
| --- | ---: |
| Rewind storage | 16,182 files, approximately 552 MB |
| Session storage | 2,287 sessions, 156.5 MB |
| `SessionStore.list()` | 1.824 seconds, approximately 302 MB heap growth |
| Built-in full-workspace Grep miss | 16.9 seconds |
| Equivalent `rg` search | 38.3 ms mean |
| `buildMessages()` | 129.4 ms mean |
| `git status --short` | 64.8 ms mean |
| Large transcript render | 146.7 ms mean |
| Multi-hunk diff render | 103.9 ms mean |

The measurements are diagnostic baselines rather than cross-platform performance guarantees.

## Priority Findings

### P0: Rewind snapshots scan and hash the whole workspace for every prompt

`AgentSession.prepareSend()` captures a snapshot before recording each user message. The async
snapshot implementation walks every included path, reads every included file, computes SHA-256,
checks the blob store, and writes a new manifest.

Relevant code:

- `src/session/agent-session.ts:468`
- `src/rewind/snapshot-store.ts:38`
- `src/rewind/snapshot-store.ts:524`
- `src/rewind/snapshot-store.ts:541`

Risks:

- Prompt latency scales with total workspace file count and logical bytes.
- Unchanged files are reread and rehashed on every prompt.
- `.book/` is not ignored, so Book can snapshot its own logs and local settings.
- Workspace-local settings may contain provider credentials and should not be copied into rewind
  blobs by default.
- Debug logs can dominate snapshot cost because logging has no rotation or maximum size.

Recommended changes:

1. Add `.book/` to the default rewind exclusions, with an explicit opt-in mechanism if needed.
2. Cache file identity by normalized path, size, modification time, and mode.
3. Reuse the previous blob hash when cached metadata is unchanged.
4. Store manifests as deltas or reuse unchanged manifest entries.
5. Consider lazy snapshot creation when Code/Both rewind is first requested, or expose a setting
   that disables code snapshots while preserving conversation rewind.
6. Bound and rotate `.book/debug.log`.

Acceptance targets:

- Warm snapshot capture of an unchanged medium repository completes in less than 100 ms.
- Unchanged files are not reread.
- `.book/settings.local.json`, `.book/debug.log`, and tool-output artifacts are excluded by default.
- Snapshot storage remains bounded by retention and reference reachability.

### P0: Session discovery fully replays every historical session

`SessionStore.list()` calls `load()` for every JSONL file. `load()` reconstructs transcripts,
context history, compact boundaries, and rewind state even when callers only need session metadata.
Replay also repeatedly spreads growing arrays, causing avoidable allocation and quadratic copying in
long sessions.

Relevant code:

- `src/session/store.ts:129`
- `src/session/store.ts:317`
- `src/session/store.ts:351`
- `src/session/store.ts:512`
- `src/cli/run.ts:28`
- `src/cli/run.ts:157`

Observed result for 2,287 sessions:

- 1.824 seconds to list sessions.
- Approximately 302 MB of additional heap use.
- 156.5 MB of session JSONL data parsed.

Startup compounds the cost by performing cleanup, listing sessions, collecting snapshot references,
and resolving resume state through separate passes.

Recommended changes:

1. Maintain a compact session metadata index containing id, workspace, name, timestamps, and message
   count.
2. Update the index atomically when appending metadata-affecting records.
3. Use mutable internal arrays during replay and freeze/copy only at the public boundary.
4. Stream or incrementally parse JSONL instead of splitting the entire file into strings.
5. Cache the active session's parsed records and indexes.
6. Resolve retention using indexed timestamps or file metadata without replaying transcripts.
7. Make `searchCurrent()` and `readCurrent()` share one parsed/indexed representation rather than
   loading and reading the same file separately.

Acceptance targets:

- Listing several thousand sessions completes in less than 300 ms.
- Listing metadata uses less than 50 MB of additional heap at the measured dataset size.
- Replaying one session is linear in record count.
- Startup performs at most one metadata scan and one selected-session replay.

### P0: Built-in Grep performs sequential full-file scanning

The Grep tool enumerates candidate paths with `fast-glob`, probes each file for binary content, reads
the complete file, splits it into lines, and scans files sequentially until the result limit is met.
No-match queries therefore pay the maximum possible cost.

Relevant code:

- `src/tools/file.ts:368`
- `src/tools/file.ts:388`
- `src/tools/file.ts:409`
- `src/tools/file.ts:414`
- `src/tools/file.ts:415`

Measured comparison:

- Built-in no-match query: 16.9 seconds.
- Equivalent `rg` query: 38.3 ms mean.
- Native search was approximately 440 times faster in this case.

Recommended changes:

1. Use `rg --json` as the primary Grep backend when available.
2. Parse results as a stream and stop the process when `head_limit` or the byte budget is reached.
3. Preserve the TypeScript scanner as a portable fallback.
4. Forward include globs, context lines, multiline behavior, hidden-file rules, and ignore patterns to
   `rg` where semantics match.
5. Add cancellation that terminates the spawned search process and its process tree.

Acceptance targets:

- A no-match search of the current repository completes in less than 200 ms with `rg` available.
- Memory use does not scale with the total content of all candidate files.
- Output limits stop both parsing and the underlying search process.

### P1: Configuration loading performs redundant persistent migrations

`loadConfig()` invokes legacy permission migration whenever settings are enabled. If the legacy file
remains present, migration rewrites `settings.local.json` even when every rule is already present.
Concurrent processes can independently read, update, and rename the same settings file.

Relevant code:

- `src/config.ts:93`
- `src/settings-loader.ts:167`
- `src/settings-loader.ts:186`
- `src/settings-repository.ts:187`

During diagnostics, three concurrent configuration loads each reported a migration. This exposed
both redundant writes and a possible lost-update race.

Recommended changes:

1. Compare the candidate document with the source and skip identical writes.
2. Record a migration version or marker after successful migration.
3. Make migration an explicit startup phase rather than a general config-read side effect.
4. Add cross-process locking or compare-and-swap protection for settings mutations.
5. Keep migration warnings limited to the first actual change.

### P1: Static prompt context is rebuilt on every agent turn

Every provider turn rediscoveries skills, commands, CLAUDE.md files, agent definitions, tool
summaries, and Git state. Context-overflow handling can rebuild the same prompt several times within
one turn.

Relevant code:

- `src/agent/context.ts:75`
- `src/agent/context.ts:217`
- `src/agent/context.ts:220`
- `src/agent/context.ts:237`
- `src/agent/loop.ts:305`
- `src/agent/loop.ts:353`
- `src/agent/loop.ts:379`

Measured baseline:

- `buildMessages()` averaged 129.4 ms.
- `git status --short` averaged 64.8 ms.
- The generated system prompt was approximately 19,155 characters in the measured configuration.

Recommended changes:

1. Cache static system-prompt zones for the lifetime of a logical session.
2. Invalidate discovered instructions using directory/file mtimes or explicit configuration events.
3. Cache normalized tool definitions and their token estimates.
4. Refresh Git branch/status once per user turn and after file-mutating or Git tools.
5. Reuse the same built messages and token estimates during preflight checks when history and tools
   have not changed.

Acceptance targets:

- Warm context construction completes in less than 20 ms before history serialization.
- Static instruction files are not reread during ordinary tool turns.
- Git processes are not spawned repeatedly for the same unchanged turn.

### P1: Streaming updates rebuild transcript-wide structures

The message accumulator flushes every 16-32 ms. Each text update copies the messages array and
concatenates the growing assistant content. `ChatPanel` then rebuilds the complete timeline whenever
the messages array changes. `AgentMessage` memoization helps completed assistant messages, but user
rows, timeline merging, boundary indexing, and React reconciliation still scale with transcript
length.

Relevant code:

- `src/tui/hooks/message-accumulator.ts:67`
- `src/tui/hooks/message-accumulator.ts:73`
- `src/tui/hooks/streaming-state.ts:56`
- `src/tui/hooks/streaming-state.ts:58`
- `src/tui/components/ChatPanel.tsx:115`
- `src/tui/components/ChatPanel.tsx:146`

Current UI benchmark results:

- Markdown sample: 28.9 ms mean.
- Large transcript: 146.7 ms mean.
- Multi-hunk diff: 103.9 ms mean.
- Input submission: 2.1 ms mean.
- The optimized paragraph wrapper measured 0.98x the legacy implementation in this run.

Recommended changes:

1. Separate completed transcript segments from the active streaming message.
2. Window or virtualize old transcript rows.
3. Maintain the merged timeline incrementally instead of rebuilding it on every text delta.
4. Use an adaptive flush interval based on render duration, terminal size, and transcript length.
5. Cache parsed Markdown blocks and update only the incomplete tail while streaming.
6. Add an incremental-update benchmark; the current benchmark measures fresh mounts only.

Acceptance targets:

- Streaming-update p95 remains below 33 ms with a 1,000-message transcript.
- Completed messages do not rerender during ordinary text deltas.
- Heap use stays stable during a long streamed response.

### P2: Long-lived buffers and stores need tighter bounds

#### Background shells

Completed background shells remain in the session map until runtime disposal. Each record may retain
up to 5 MB of output.

Relevant code:

- `src/tools/shell.ts:10`
- `src/tools/shell.ts:127`
- `src/tools/shell.ts:364`
- `src/session/runtime.ts:88`

Add a maximum retained-shell count, a terminal-record TTL, and an explicit consume/dismiss action.

#### Web responses

`WebFetch` calls `Response.text()` before truncating the result to 20,000 characters. A large or
unbounded response can therefore consume substantial memory.

Relevant code:

- `src/tools/web.ts:46`
- `src/tools/web.ts:68`
- `src/tools/web.ts:71`

Read the response stream incrementally with a byte limit, reject excessive declared content lengths,
and cancel the reader when the limit is reached. Apply equivalent result-count and response-size
limits to WebSearch.

#### Debug logging

Debug logging synchronously appends every line and has no rotation policy.

Relevant code:

- `src/debug-log.ts:43`
- `src/debug-log.ts:54`
- `src/debug-log.ts:63`

Use a bounded rotating log and optionally buffer writes outside render-sensitive paths.

#### Managed-agent persistence

`AgentStore` eagerly loads all record, plan, evidence, and snapshot JSON files into maps. Records can
contain full transcripts, and public list operations structured-clone all entries.

Relevant code:

- `src/agents/store.ts:69`
- `src/agents/store.ts:105`
- `src/agents/store.ts:183`
- `src/agents/manager.ts:322`

Maintain lightweight record summaries, load detailed transcripts on demand, and clean expired data
before materializing it into manager memory.

## Benchmark Gaps

The repository currently has a useful UI benchmark but no repeatable benchmarks for the dominant
runtime paths. Add a `bench:runtime` suite with these cases:

1. Rewind snapshot capture: cold, unchanged warm, one changed file, and oversized log file.
2. Session store: list 100/1,000/10,000 sessions and replay 100/1,000/10,000 records.
3. Session search/read: repeated queries on a long session with rewind and compact records.
4. Grep: early match, late match, no match, binary-heavy tree, and cancellation.
5. Context construction: cold and warm caches with instruction/config invalidation.
6. Streaming UI: append 1,000 deltas to transcripts containing 10/100/1,000 messages.
7. Resource retention: background shells, large WebFetch responses, debug-log growth, and agent-store
   initialization.

Record wall time, CPU time where available, peak heap, retained heap, bytes read, files opened, and
child-process count. CI gates should use generous absolute budgets plus same-machine regression
ratios to reduce platform noise.

## Recommended Delivery Order

1. **Safety and immediate wins:** exclude `.book/`, cap WebFetch, rotate debug logs, and use `rg`.
2. **Persistence architecture:** add the session metadata index and linear replay.
3. **Incremental snapshots:** cache file identity and reuse unchanged rewind entries.
4. **Turn-level caching:** cache prompt zones, tool schema estimates, and Git state.
5. **Interactive scalability:** incremental transcript projection and streaming benchmarks.
6. **Long-lived cleanup:** shell TTLs, lazy agent records, and storage observability.

These changes should be delivered as separate, benchmarked commits so improvements and regressions
remain attributable.
