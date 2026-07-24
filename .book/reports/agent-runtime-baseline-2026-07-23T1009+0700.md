# Book Agent Runtime Baseline

- Captured: 2026-07-23 10:09 Asia/Saigon (UTC+07:00)
- Workspace: `I:/MyProject/02-AI-ML-Projects/book`
- Branch / HEAD: `main` / `c603837616a49aa2009413297bef43be11a1ffef`
- Worktree: dirty, 19 changed or untracked paths at capture time
- Scope: managed-agent state in `~/.book/agents`, project debug-log signals, and a host process snapshot
- Privacy: prompts, transcripts, results, and evidence bodies are intentionally excluded

## Current State

| Metric | Value |
| --- | ---: |
| Active managed agents | 0 |
| Queued | 0 |
| Starting | 0 |
| Running | 0 |
| Waiting for input | 0 |
| Waiting for permission | 0 |
| Persisted agents across populated stores | 14 |
| Completed | 8 |
| Failed | 5 |
| Interrupted | 1 |
| Recorded total tokens | 7,441,804 |
| Raw telemetry events | 29 |

The Codex collaboration tree had only `/root` active at capture time; no child Codex agents were
running. This is separate from Book's persisted managed-agent runtime.

No managed-agent state store exists for the current workspace hash
`075ef1f9a5ef71e2f8b6`. The populated stores below belong to other repositories or
worktrees that used this Book installation. Therefore, the historical totals are host-wide Book
agent data, not current-workspace-only data.

## Store Summary

| Repository hash | Source repository | Agents | Status | Tokens | Mean duration | Max duration | State size | Events |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| `345a79909f1b069eec35` | `I:/Katsuma/katclub/katclub-service` | 5 | 1 completed, 4 failed | 435,212 | 79,975 ms | 136,576 ms | 9,410,925 B | 10 |
| `6d77da052a773bf0347a` | Codex worktree `feature-effort-command` | 9 | 7 completed, 1 failed, 1 interrupted | 7,006,592 | 6,279,642 ms | 54,129,651 ms | 8,022,019 B | 19 |

The second store's mean is distorted by one interrupted agent whose persisted lifetime was
54,129,651 ms (about 15.0 hours). For completed and failed agents, the median duration is
237,938 ms (about 4.0 minutes).

## Agent Records

These rows are the latest authoritative records from each `state.json`. Duration is
`finishedAt - startedAt`; `-` means no usage was persisted.

| Repository | Agent ID | Role | Status | Model | Isolation | Tokens | Duration ms |
| --- | --- | --- | --- | --- | --- | ---: | ---: |
| `345a...` | `3b352214-9b83-443c-bb1a-bf1f46845912` | explorer | completed | unknown | worktree | 15,399 | 36,193 |
| `345a...` | `c2e7b9af-32f2-4f78-bc4e-96b927b54707` | explorer | failed | `9router/qc/glm-5.2` | workspace-readonly | 102,913 | 136,576 |
| `345a...` | `33cf6324-d689-4154-981f-a2ced0c62fff` | explorer | failed | `9router/qc/glm-5.2` | workspace-readonly | 90,481 | 112,543 |
| `345a...` | `d9dfc3ba-19d9-4c35-ac68-57e9afc5c568` | explorer | failed | `9router/qc/glm-5.2` | workspace-readonly | 226,419 | 113,826 |
| `345a...` | `e29c6beb-329b-44d8-8dce-1af4fc9581b3` | explorer | failed | `9router/qc/glm-5.2` | workspace-readonly | - | 735 |
| `6d77...` | `57e039fd-cebc-4fd7-b100-5d6839a6fa49` | explorer | completed | `9router/cx/gpt-5.6-sol` | workspace-readonly | 1,457,537 | 309,719 |
| `6d77...` | `03924c83-5313-460d-8089-dd22ee7cd334` | patcher | completed | `9router/cx/gpt-5.6-sol` | worktree | 1,871,871 | 364,701 |
| `6d77...` | `97d2c5ae-8f37-4abf-823e-7378ae2be85f` | validator | completed | `9router/cx/gpt-5.6-sol` | worktree | 1,154,027 | 473,637 |
| `6d77...` | `13e961d3-6b24-440c-8cbb-5710fa3148c0` | explorer | completed | `9router/cx/gpt-5.6-sol` | workspace-readonly | 814,422 | 237,938 |
| `6d77...` | `c6cdc4a7-291e-4503-bee1-459418e9caa4` | explorer | completed | `9router/cx/gpt-5.6-sol` | workspace-readonly | 457,269 | 127,160 |
| `6d77...` | `849d18d0-a374-45fd-af5d-8f3d9ce0e5f5` | explorer | completed | `9router/cx/gpt-5.6-sol` | workspace-readonly | 729,126 | 258,707 |
| `6d77...` | `d82926e5-1933-437e-a5a0-61f75e9bc8f9` | explorer | interrupted | `9router/cx/gpt-5.6-sol` | workspace-readonly | 155,109 | 54,129,651 |
| `6d77...` | `f141d75c-eca9-44c4-9fb3-59e7aa7325c0` | explorer | completed | `9router/qc/glm-5.2` | workspace-readonly | 162,043 | 359,632 |
| `6d77...` | `9b58f46b-5f00-4895-9863-4831245e23a2` | explorer | failed | `9router/qc/glm-5.2` | workspace-readonly | 205,188 | 255,629 |

## Failure Signals

| Failure class | Count | Observed behavior |
| --- | ---: | --- |
| HTTP 413 request too large | 4 | Four nearly simultaneous `glm-5.2` explorers failed; three consumed 419,813 tokens in total before terminal failure, and one persisted no usage |
| Stream stalled | 1 | No provider data received for 20,000 ms after 205,188 recorded tokens |
| Process interruption | 1 | Agent retained `thinking` as its last activity and was later marked interrupted |

Model-level outcomes in the persisted sample:

| Model | Agents | Completed | Failed | Interrupted | Tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `9router/qc/glm-5.2` | 6 | 1 | 5 | 0 | 787,044 |
| `9router/cx/gpt-5.6-sol` | 7 | 6 | 0 | 1 | 6,639,361 |
| unknown | 1 | 1 | 0 | 0 | 15,399 |

This sample is too small and task-dependent for a model-quality conclusion. It is sufficient to
show a transport/context-size reliability issue for the captured `glm-5.2` runs.

## Telemetry Integrity

Raw `metrics.jsonl` event counts:

| Event | Count |
| --- | ---: |
| `complete` | 11 |
| `failed` | 6 |
| `explorer_spawned` | 10 |
| `explore_reminder` | 2 |

Telemetry contains repeated terminal events for at least two agent IDs. State counts above use
one latest record per agent and should be treated as authoritative. Raw event counts are useful
for diagnosing emission behavior but must not be used directly as completed/failed run counts.

## Project Debug Log

At capture time, `.book/debug.log` was 23,853,336 bytes. The most recent clearly completed live
turn visible in the sampled tail reported:

| Metric | Value |
| --- | ---: |
| Turn | 5 |
| Prompt tokens | 21,696 |
| Completion tokens | 132 |
| Total tokens | 21,828 |
| Agent duration | 8,566 ms |
| Tool calls/results in final turn | 0 / 0 |
| TUI usage percent | 8% |

The log is append-only and contains interleaved events from live sessions and TUI tests, so file
order alone is not a reliable per-session timeline.

## Host Process Snapshot

Captured at 2026-07-23 10:08:54 Asia/Saigon. Windows denied process command-line inspection, so
generic Node processes cannot be reliably attributed to Book. These numbers are environmental
context, not Book-only resource consumption.

| Process name | Count | CPU seconds since start | Working set |
| --- | ---: | ---: | ---: |
| `node` | 15 | 562.48 | 2,644,377,600 B |
| `codex` | 2 | 19.46 | 236,683,264 B |
| `codex-code-mode-host` | 1 | 0.17 | 16,728,064 B |
| `codex-command-runner-0.145.0` | 1 | 0.00 | 10,199,040 B |
| `node_repl` | 2 | 0.03 | 20,017,152 B |
| Total sampled | 21 | 582.14 | 2,928,005,120 B |

Largest generic Node working sets at capture time were PID 23312 (600,629,248 B), PID 27808
(506,691,584 B), PID 9500 (372,301,824 B), and PID 9612 (308,932,608 B).

## Optimization Baseline

The first optimization targets suggested by this baseline are:

1. Measure serialized request bytes and estimated context tokens before provider dispatch.
2. Enforce a provider/model request-size budget before spawning parallel explorers.
3. Attribute token usage even when a request ends in provider failure.
4. Deduplicate terminal telemetry by agent ID and completion sequence.
5. Separate active runtime duration from persisted wall-clock lifetime after interruption.
6. Rotate or bound `.book/debug.log`, and attach a session/process identifier to each log event.

Future captures should compare active count, success rate, HTTP 413 count, stall count, tokens per
successful agent, p50/p95 duration, duplicate terminal-event count, state-file size, and debug-log
growth against this baseline.
