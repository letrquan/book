# Book Agent Runtime Baseline

- Captured: 2026-07-23 10:18:25 +07:00
- Workspace: `I:\MyProject\02-AI-ML-Projects\book`
- Repository hash: `075ef1f9a5ef71e2f8b6`
- Branch / HEAD: `main` / `c603837616a49aa2009413297bef43be11a1ffef`
- Dirty or untracked paths: 27
- Privacy: prompts, transcripts, results, evidence bodies, and raw errors are excluded

## Current State

| Metric | Value |
| --- | --- |
| Active managed agents | 1 |
| Queued | 0 |
| Starting | 0 |
| Running | 1 |
| Waiting for input | 0 |
| Waiting for permission | 0 |
| Persisted agents | 15 |
| Completed | 8 |
| Failed | 5 |
| Interrupted | 1 |
| Recorded total tokens | 8914149 |
| Raw telemetry events | 30 |
| Duplicate terminal telemetry events | 3 |

No managed-agent state store exists for this workspace hash (`075ef1f9a5ef71e2f8b6`).
The aggregate tables are host-wide Book data from populated stores.

## Store Summary

| Repository hash | Agents | Active | Status | Tokens | Mean duration ms | Max duration ms | State bytes | Events |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `345a79909f1b069eec35` | 6 | 1 | completed=1, failed=4, running=1 | 1907557 | 79975 | 136576 | 10996427 | 11 |
| `6d77da052a773bf0347a` | 9 | 0 | completed=7, interrupted=1, failed=1 | 7006592 | 6279642 | 54129651 | 8022019 | 19 |

## Active Agents

| Repository | Agent ID | Profile | Status | Model | Activity | Tokens | Duration ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `345a79909f1b069eec35` | `554b6c17-4d2d-4d36-b029-1b67fdf7bdcc` | explorer | running | `9router/qc/glm-5.2` | thinking | 1472345 |  |

## Failure Classes

| Class | Count |
| --- | --- |
| http_413_request_too_large | 4 |
| other | 1 |
| stream_stall | 1 |

## Telemetry Events

| Event | Count |
| --- | --- |
| complete | 11 |
| explore_reminder | 2 |
| explorer_spawned | 11 |
| failed | 6 |

State records are authoritative for run counts. Raw telemetry can contain repeated terminal events.

## Debug Log

| Metric | Value |
| --- | --- |
| Bytes | 23879562 |
| Last write time | 2026-07-23T10:16:15.2875475+07:00 |
| Latest prompt tokens in tail | 21696 |
| Latest completion tokens in tail | 132 |
| Latest total tokens in tail | 21828 |
| Latest agent duration ms in tail | 8566 |
| Latest status token count in tail | 0 |

The append-only log can interleave live sessions and tests.

## Host Process Snapshot

Generic Node processes cannot be reliably attributed to Book without command-line access.

| Process | Count | CPU seconds | Working set bytes |
| --- | --- | --- | --- |
| codex | 2 | 45.48 | 295043072 |
| codex-code-mode-host | 2 | 0.38 | 34144256 |
| codex-command-runner-0.145.0 | 1 | 0.02 | 10203136 |
| node | 15 | 697.04 | 3206017024 |
| node_repl | 2 | 0.03 | 20099072 |

## Machine-Readable Data

Full privacy-filtered details are in `agent-runtime-baseline-2026-07-23T101825+0700.json`.
