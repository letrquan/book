# Managed-Agent Storage Recovery

Book stores managed-agent plans, records, summaries, evidence, snapshots, and instance leases under
`~/.book/agents/<repo-hash>/`. Detailed records are authoritative; summaries are rebuildable
projections used for fast listing.

This policy describes managed agents only. Persistent background shell jobs use the separate jobs
store and runner in `src/jobs/` and `src/job-runner.ts`; in-memory planning tasks are not executable
jobs and are not persisted in this agent store.

## Write policy

- JSON is written to an exclusive temp file in the target directory, fsynced, closed, and renamed
  without deleting the previous valid target first.
- Per-target lock files serialize writers. Rename and lock contention (`EPERM`, `EBUSY`, or
  `EACCES`) is retried for up to 500 ms.
- Existing-agent updates are coalesced by target and retried after 500 ms, 1 s, 2 s, 5 s, and then
  every 10 s. Disk-full, quota, read-only, and permission failures use a low-frequency health probe.
- Running agents continue in memory during degraded persistence. New operations that require durable
  setup return `agent_store_busy` or `agent_store_unavailable` before execution starts.
- Shutdown flushes are best effort and never throw. A complete temp file may remain for startup
  recovery if the destination stays unavailable.

## Recovery and ownership

Each Book process refreshes an `instances/<instance-id>.json` lease every five seconds. Persisted
agent records include private owner metadata, which is removed from the public SDK and tool results.
A second live process may list or read an agent but receives `agent_owned_by_other_process` for
mutations. Active agents are interrupted only when their owner lease and process evidence are dead,
or when loading a legacy record without ownership metadata.

Startup scans both UUID temp names and the legacy `.<pid>.<timestamp>.tmp` format. It validates JSON,
target containment, embedded IDs, ownership, and logical revision before promotion. Corrupt inputs are
quarantined; older valid temps are removed. A terminal completion sequence cannot be overwritten by a
queued running revision.

## Diagnostics and retention

With `BOOK_DEBUG=1`, the `agent-store` namespace records retry scheduling, recovery, degraded state,
stale-lock reclamation, foreign ownership, and shutdown flush failures. Logs contain operation codes
and target types only, never persisted JSON, prompts, transcripts, credentials, tokens, or environment
values.

Expired sessions and rotated debug-log backups are cleared after 30 days. Cleanup preserves the
active session and the current debug log. Managed-agent history uses `agents.retentionDays` and only
ages out terminal records; live foreign agents are never removed as stale history.
