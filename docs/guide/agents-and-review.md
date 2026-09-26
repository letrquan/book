# Managed agents and code review

Delegating work to background agents, and the `/review` pipeline built on them.

## Managed agents

Adaptive mode keeps targeted work inline and nudges the parent toward the read-only `explorer` profile after three successful root `Glob`/`Grep` queries. The reminder is advisory: the fourth lookup is still allowed. Broad exploration receives a purpose name such as `Trace authentication flow`; the reusable profile (`explorer`, `patcher`, or `validator`) remains separate. `--agents manual` keeps the same lifecycle tools but requires explicit user delegation; `--agents off` removes managed-agent tools and routing guidance.

Explorer and `reviewer` run in the parent workspace with a hard read-only capability boundary and do not require Git, snapshots, or worktrees. `reviewer` backs `/review`: it is restricted to `Read`, `Glob`, `Grep`, `GitStatus`, `GitLog`, and `GitBranch` — deliberately no diff tool, because the host supplies the review target. Because it is a trust boundary, a project agent definition named `reviewer` cannot replace its role, tools, isolation, or body; tune it through `agents.profiles.reviewer` instead. Such a definition is not silently discarded — `book doctor` reports which layer it came from and what to do about it. Patcher and validator runs retain synthetic Git snapshots and isolated worktrees under `~/.book/worktrees/<repo-hash>/<agent-id>`, with per-record state and transcripts under `~/.book/agents/<repo-hash>/records/`. `agents.maxConcurrent` controls active execution while `agents.maxSpawned` caps outstanding queued/running/waiting children; completed history does not consume the cap. Parent-facing lifecycle results contain compact summaries/evidence IDs, terminal handoffs preserve up to 50 KiB, and `AgentRead` retrieves larger results in bounded chunks. The TUI and SDK host can inspect detailed transcripts separately. A patcher commit cannot be applied until a distinct validator passes the exact candidate commit.

Child completion is delivered automatically to the correct parent session as a compact agent-update card and a persisted provider-facing notification; `AgentWait` is only an explicit synchronization barrier. Delivery is split into context-budgeted batches, retried with bounded backoff, and deduplicated by durable delivery ID before acknowledgement. Terminal rows freeze their duration and final preview, and lifecycle tool rows show semantic actions instead of serialized JSON prefixes.

Managed-agent state writes are atomic and coordinated per target. If Windows, an antivirus scanner, or another Book process temporarily holds a state file, running agents continue in memory while Book retries the newest pending state in the background. The TUI shows one non-modal storage warning and a short recovery notice. Operations that require durable setup before starting, including plans, snapshots, initial agent records, and evidence publication, fail cleanly with a retryable `agent_store_busy` error instead of leaving a partially started agent. Multiple Book processes may read the same repository store, but only the live owner may mutate an active agent.

Recoverable temp files and instance leases live beside managed-agent state under `~/.book/agents/<repo-hash>/`. Startup validates and promotes only the newest logical revision from an abandoned instance. Set `BOOK_DEBUG=1` to record safe `agent-store` lifecycle diagnostics such as degraded storage, retry recovery, stale-lock reclamation, and orphan-temp promotion; JSON payloads, prompts, transcripts, credentials, and environment values are not logged. See `docs/agent-store.md` for the storage and recovery policy.

Agent definition tool rules are strict capabilities. Missing or empty `tools` means no tools, while `*` explicitly inherits parent tools except recursive lifecycle, implicit user-question, and implicit MCP access. Argument rules such as `Bash(git status*)` are checked again at execution time. Built-in profiles use file/git tools and `Check`; arbitrary shell access requires an explicit custom-agent rule.

Running children and background shells appear in one flat job panel directly below the prompt, with `main` and each executable job listed at the same level. From an empty prompt, press Tab to cycle focus through `main` and the jobs. `/jobs` opens the panel for explicit management; `/tasks` remains an alias. Tab/Up/Down selects a row, Enter opens its transcript or output, `x` stops it, and Esc returns to the main prompt. Finished, failed, timed-out, and user-stopped jobs are removed from the active panel automatically; shell completion is preserved as a local notice and retained briefly for `BashOutput`/`DismissShell` compatibility.

`Bash` accepts `run_in_background: true` with an optional `title`, `max_runtime_ms`, `notify`, and `lifetime`. Session jobs are the default and end with Book. `lifetime: "persistent"` is explicit, receives a separate permission decision, and reattaches from repository-scoped state after Book restarts. `notify: "ui"` is the default, `"none"` suppresses completion delivery, and `"agent"` queues one bounded output tail for the parent model when it is idle. Persistent logs are bounded and are removed when the completed job is dismissed.

`/agents` opens the subagent profiles, where each profile's model is chosen (the same picker as `/config` → Subagent profiles), rather than a second runtime dashboard. Import third-party Claude-style definitions with `/agents import <path>` to preview normalized tools and warnings, then `/agents import --confirm <path>` to install under `.book/agents/`. The lower-level `/agent <id>`, `/agent send <id> <message>`, `/agent stop <id>`, and `/agent apply <id> [evidence-id]` commands remain available for direct scripting and recovery.

Profile model precedence is invocation override, `agents.profiles.<name>.model`, definition frontmatter, then the parent model. `inherit` falls through rather than becoming a literal provider model. Profile effort precedence is `agents.profiles.<name>.effort`, definition frontmatter, then the session's effort. When none of those chose a level (for the session: `--effort`, `BOOK_EFFORT`, `settings.effort` or `/effort`), the child model's catalog `default` applies instead of the session's defaulted `high`. The level is clamped down to the highest one the child model's catalog lists at or below it; a chosen level below every listed level is raised to the lowest listed one rather than dropped, while a defaulted one is dropped. On an OpenAI-compatible route a child sends it as `reasoning_effort` only when a level was chosen or its model's catalog lists that level (a catalog entry without a `levels` list vouches only for its `default`), so with nothing configured a child on a model with no catalog entry sends none, like the main agent. A level the catalog merely listed is not a choice: the child's own compaction treats it as defaulted. A chosen level is kept, as asked, for every later run of the agent and clamped against the catalog in force when that run starts; a defaulted one is resolved again when a queued, re-run or follow-up run starts. The agent record's `effort` is the child's level clamped to its model's catalog, from the spawn on. Stream-json and SDK hosts receive status, activity, question, permission, completion, and evidence events by default; high-volume child text deltas require `forwardSubagentText`.

> Snapshot privacy: non-ignored untracked files are written into the local Git object database so managed worktrees can reproduce the parent state. Ignore secrets and other sensitive local files before enabling agents. Dismissing or aging out an agent removes its managed worktree, branch, and orphaned snapshot ref. Agent telemetry stores metrics and hashes only, never prompts or file contents.

Book clears sessions and rotated debug-log backups after 30 days. Startup resolves and preserves the active session before cleanup, and the current debug log is never removed by age-based retention.

## Code review

`/review` is orchestrated by the host rather than run as an ordinary prompt. Book resolves the
change once — base commit, changed files, and a unified diff, including untracked files — and hands
that **immutable review target** to read-only `reviewer` agents. Reviewers never choose their own
scope, so a review cannot silently widen or drift onto unrelated changes.

```text
/review                       Review the working tree (tracked + untracked changes)
/review --base main           Review against the merge base with a ref
/review src/tools             Restrict the review to a file or directory
/review main...HEAD           Review a committed range
/review --deep                Four parallel lenses + an independent verification pass
/review --fix                 Deep review, then apply verified findings (implies --deep)
/review --help                Usage
```

**While it runs (TUI).** A review is minutes of work in background agents, so it reports before it
starts: the resolved target — file count, base commit, path scope — and which passes are coming are
printed before the first agent is spawned. Every reviewer, lens, verifier and patcher then appears
in the job panel below the prompt and in the status line with live activity, so you can watch a
pass or open one to read its transcript — Tab from an empty prompt selects a row, or `/jobs` opens
the panel for explicit management. Those agents belong to the session for display only; they never
deliver a completion notification, so watching a review costs no extra model turn. Press `Esc` to
cancel — the in-flight agents are stopped, and a cancelled review reports `inconclusive` with no
findings rather than presenting its own stopped passes as a result. `Ctrl+C` cancels the review too
without exiting; once it is cancelled, exiting takes the usual two presses (the first shows "Press
Ctrl+C again to exit"). A cancelled `--fix` pass reports what it had already
committed before stopping. Progress is a streaming-host feature: a print run has no silence to
break, so its stdout stays exactly the report (the same target is on `data.target`).

A plain `/review` runs one structured pass. `--deep` fans out four specialized reviewers
(correctness, security, simplification, efficiency), merges and deduplicates their findings, drops
anything below 70% confidence, and then runs a **falsification pass**: an independent verifier tries
to disprove each candidate against the real code. Rejected findings are dropped; findings the
verifier could not reach stay `inconclusive` rather than being reported as real.

Coverage is explicit. If a reviewer fails, times out, or does not return the required JSON, the
report says so and the verdict is capped at `inconclusive` — a review never reports "clean" from
incomplete coverage. Output that fails the JSON contract is preserved verbatim in the report instead
of being discarded.

`--fix` applies only verified findings, one at a time, through the patcher → validator pipeline: a
patcher produces a patch candidate as evidence, a separate validator must approve that exact
evidence id (agents cannot approve their own work), and only then is it applied.

Drop a **`REVIEW.md`** at the workspace root to calibrate reviews for your repository — severity
conventions, known-noisy areas, project-specific rules. It is read fresh on every run and injected
as calibration only: it cannot change the output contract, disable verification, or broaden the
tools a reviewer may use.

**Outside the TUI.** `book -p /review`, `book -p "/review --deep"`, `book -p "/review --base main"`,
path scopes and `<base>...<head>` all run headlessly through the identical pipeline — the host still
resolves the review target and hands the reviewers an immutable diff. The report is written to
stdout as text by default. `--fix` is interactive-only: a non-interactive host cannot approve a
patcher's tool calls, so `book -p "/review --fix"` exits 1 with an explanation instead of editing
and committing unattended. A review that could not run at all — a bad ref, `agents.mode = off`, an
unknown option — also exits 1. An inconclusive _verdict_ does not: the review ran, so gate on the
verdict field rather than on the exit code.

Under `--output-format json` and `stream-json` the review is emitted as one record, with `data`
holding a stable projection of the pipeline's own types:

```json
{
  "type": "command_result",
  "command": "review",
  "output": "the text report",
  "data": {
    "verdict": "blocking | recommend | clean | inconclusive",
    "target": {
      "kind": "working-tree | committed-range",
      "baseSha": "…",
      "headSha": "…",
      "path": "src/tools",
      "changedFiles": ["src/tools/shell.ts"]
    },
    "findings": [
      {
        "id": "…",
        "severity": "critical | major | minor | nit",
        "category": "correctness | security | simplification | efficiency | conventions | tests",
        "file": "src/tools/shell.ts",
        "line": 110,
        "summary": "…",
        "evidence": "…",
        "failure": "…",
        "suggestedFix": "…",
        "confidence": 85,
        "verification": "confirmed | rejected | inconclusive",
        "verificationReason": "…"
      }
    ],
    "coverage": {
      "reviewers": [{ "id": "correctness", "status": "completed", "findings": 2 }],
      "verifier": { "id": "verification", "status": "completed", "findings": 2 }
    }
  }
}
```

`findings` are `ReviewFinding` values verbatim and `coverage` is the pipeline's own
`ReviewCoverage`, so the report and the JSON can never describe different runs. The unified diff is
deliberately omitted — it is the caller's own input and can be megabytes. On the `stream-json` wire
the record is emitted as it completes; under `--output-format json` it arrives inside the single
result document as `result.commandResults[]`, which keeps that format one top-level JSON object.
`stream-json` consumers also see the review's managed-agent events (`agent_start`, `agent_update`,
`agent_result`) as they happen; text mode prints nothing until the review finishes, which for
`--deep` means two sequential phases under the fixed 10-minute per-pass timeout.

To score the pipeline against a golden set, pair expectations with reports captured from real runs
and run `npm run eval:review -- <fixtures.json>`; it prints precision, recall, F1, usefulness rate,
and signal-to-noise ratio. See `evals/review/fixtures.example.json` for the format.
