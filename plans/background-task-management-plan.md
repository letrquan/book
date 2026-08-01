# Plan: User-Managed Background Jobs

- **Date:** 2026-08-01
- **Status:** Proposed for review
- **Scope:** Background shell lifecycle, managed-agent presentation, TUI job management,
  completion delivery, persistence, restart recovery, SDK events, and task linkage
- **Goal:** Let users inspect and control every background execution from the TUI, while adding
  safe opt-in durable jobs that can survive a Book restart without weakening permissions,
  sandboxing, or process cleanup.

---

## Review Decisions

The implementation should not begin until these product choices are accepted or changed:

1. **Durability is opt-in.** Existing background shells remain session-scoped. A caller must set
   `lifetime: "persistent"` to allow a job to continue after the current Book process exits.
2. **Model wake-up is opt-in.** Every completion appears in the TUI, but a shell completion starts
   a parent model turn only when the job was created with `notify: "agent"`. The default is
   `notify: "ui"`.
3. **Use job terminology for execution.** Add `/jobs` as the canonical management command and keep
   `/tasks` as a compatibility alias. Tool-managed planning tasks remain separate data and are not
   treated as processes.
4. **Persist bounded logs only for persistent jobs.** Session jobs retain their current in-memory
   output. Persistent jobs write rotated user-local logs so output can be inspected after restart.
5. **Do not implement pause/resume.** Portable stop, rerun, dismiss, follow output, and notification
   controls are in scope. OS-level process suspension is not.

Recommended decisions are reflected throughout the plan.

## Desired User Experience

The existing background-task panel becomes a unified job manager:

```text
Background jobs
  > main                         running      02:14
    agent  Trace auth flow       running      01:03
    shell  npm run dev           running      00:42  persistent
    shell  npm test              failed       00:18  exit 1

  Tab/Up/Down select | Enter inspect | x stop | d dismiss | f follow | n notify
```

Opening a shell shows its command, working directory, PID, lifetime, sandbox state, timeout, exit
metadata, elapsed time, and a bounded live output tail. Opening an agent preserves the existing
transcript view. The user can move between `main`, agents, and shells without leaving the prompt.

Expected flows:

- A user starts `npm run dev` in the background, opens `/jobs`, follows its output, and stops it.
- A test command completes while the parent is working; the row freezes its duration and shows an
  unread completion marker.
- A shell created with `notify: "agent"` completes and delivers one bounded result to the correct
  parent session, causing the parent to continue only after the current interaction is idle.
- A persistent job survives a clean exit or crash. After Book restarts, `/jobs` reattaches to the
  runner, restores status and output offsets, and permits safe termination.
- If the process no longer exists or its identity cannot be proven, Book marks the record `lost`
  instead of sending a signal to a reused PID.

## Current Baseline

Current behavior is split across unrelated mechanisms:

| Surface | Current behavior | Gap |
| --- | --- | --- |
| `Bash(run_in_background)` | Returns a shell ID and stores process/output in `SessionRuntime` | No TUI list/detail view, no automatic completion delivery, no restart recovery |
| `BashOutput` / `KillShell` | Polls output or terminates one process tree | Model must remember to poll; user needs tool or slash-command access |
| Managed agents | Persisted manager, live TUI panel, automatic completion delivery | Panel cannot display or control shell jobs |
| `/tasks` panel | Displays `main` and managed children | Name collides with planning-task tools and omits shells |
| `TaskCreate` / `TaskUpdate` | Tracks planning state and dependencies | Not linked to executable jobs; `TaskStop` only changes status |
| Session disposal | Aborts agents, kills shells, clears shell records | Correct for session jobs, incompatible with durable execution |

Important existing constraints:

- background shell output is bounded in memory;
- managed-agent persistence is atomic and repository-scoped;
- managed children are interrupted rather than left running on process exit;
- lifecycle tools are root-only and child recursion is prohibited;
- TUI completion delivery is deduplicated and delayed while another interaction is active;
- shell termination must work on Windows and Unix process trees.

## Non-Goals

This plan does not authorize:

- turning planning tasks into a general distributed scheduler;
- running jobs on remote machines;
- resuming an arbitrary process that Book did not start;
- persisting provider credentials or a complete inherited environment;
- silently making all background commands survive application exit;
- unlimited log retention;
- automatically rerunning failed commands;
- changing managed-agent isolation or patch-validation rules;
- exposing child-agent lifecycle tools recursively.

## Product Invariants

1. **One lifecycle owner.** Shell state transitions and process control belong to a job manager, not
   TUI components or tool implementations.
2. **Stable identity before signaling.** A persisted PID is never enough to prove ownership. Book
   must verify a runner token and process start identity before stop or reattach.
3. **Permissions are not reusable authority.** Rerunning a command performs normal permission and
   sandbox checks again.
4. **Session cleanup stays safe.** Session-scoped jobs are stopped on clear, resume, unmount, and
   process exit as they are today.
5. **Durability is explicit.** Persistent lifetime is visible in the tool call, TUI row, stored
   record, and completion event.
6. **Output is bounded.** Memory buffers, persisted logs, completion payloads, and SDK events all
   have independent limits.
7. **No secret expansion in records.** Persist the submitted command and a redacted display form,
   never the fully expanded environment or sandbox wrapper command.
8. **Completion is exactly once per consumer.** TUI unread state, parent delivery, and SDK events use
   durable sequence IDs and independent acknowledgements.
9. **Hosts share contracts.** TUI, headless mode, stream JSON, and SDK consume the same job events.
10. **Every phase is releasable.** The durable runner lands only after the in-process manager and UI
    contracts are proven.

## Target Architecture

```text
                   +-------------------------------+
                   | TUI / CLI / SDK / stream JSON |
                   +---------------+---------------+
                                   |
                                   v
                   +-------------------------------+
                   | BackgroundJobService          |
                   | list/get/stop/dismiss/rerun   |
                   | subscribe/readOutput          |
                   +-----------+-------------------+
                               |
              +----------------+----------------+
              |                                 |
              v                                 v
   +----------------------+          +-------------------------+
   | ShellJobManager      |          | AgentManager adapter    |
   | session + persistent |          | existing lifecycle      |
   +----------+-----------+          +-------------------------+
              |
       +------+------------------+
       |                         |
       v                         v
 Session child process    Detached job runner
 in SessionRuntime        + atomic record + logs
```

The unified service is a presentation and control boundary, not a shared execution engine. Managed
agents keep their existing manager. Shells move out of `src/tools/shell.ts` into a dedicated manager.

## Domain Model

Introduce a provider-neutral summary for TUI and host surfaces:

```ts
type BackgroundJobKind = 'agent' | 'shell';
type BackgroundJobStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'waiting_permission'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'timed_out'
  | 'interrupted'
  | 'lost';

interface BackgroundJobSummary {
  id: string;
  kind: BackgroundJobKind;
  title: string;
  status: BackgroundJobStatus;
  parentSessionId?: string;
  startedAt: number;
  finishedAt?: number;
  lifetime: 'session' | 'persistent';
  unreadCompletion: boolean;
  detail: AgentJobDetail | ShellJobDetail;
}
```

Shell records additionally need:

- stable UUID separate from PID;
- submitted command and redacted display command;
- workspace and effective working directory;
- runner PID, child PID, process-start identity, and random ownership token hash;
- session ID and root run ID attribution;
- lifetime and notification policy;
- sandbox and permission decision metadata without credentials;
- timeout/deadline;
- output log paths, byte offsets, rotation counters, and truncation counts;
- monotonically increasing revision and completion sequence;
- exit code, signal, stop reason, and terminal timestamp.

Planning `AgentTask` may later contain an optional execution reference:

```ts
execution?: { kind: 'agent' | 'shell'; id: string };
```

This is linkage only. Job state remains authoritative for execution.

## Lifecycle Semantics

### Session jobs

- Preserve current default behavior.
- Start as direct children of the Book session.
- Stop on explicit user action, timeout, session disposal, or Book exit.
- Keep output in memory with the existing bound and retention policy.
- Do not appear after restart.

### Persistent jobs

- Start through a small Book-owned runner process rather than as a direct detached shell.
- Runner redirects stdout/stderr to rotated files and atomically updates a status record.
- Runner receives only the required working directory, filtered environment, command, deadline, and
  ownership token through a protected startup channel.
- Book may exit without terminating the runner or command.
- A new Book process reattaches only after verifying the token, runner identity, repository hash,
  and recorded process start time.
- The runner owns process-tree termination and writes the final state even if the TUI is absent.
- If verification fails, the record becomes `lost`; Book never guesses that the PID is safe.

### Completion policies

`notify` has three explicit values:

- `none`: state changes only; useful for long-lived servers;
- `ui`: default; show unread completion in the TUI and emit host events;
- `agent`: also enqueue a bounded provider-facing notification for the originating parent session.

Agent notification payloads include status, elapsed time, exit metadata, truncation metadata, and a
small output tail. Full logs remain available through explicit inspection and are never injected
automatically.

## TUI Design

### Unified panel

Replace the agent-only data contract behind `SubagentPanel` with a job summary list. Either rename
the component to `BackgroundJobPanel` or add an adapter first and rename after tests pass.

Ordering:

1. `main` row;
2. waiting jobs that need user input or permission;
3. running/starting/stopping jobs, newest first;
4. unread terminal jobs, newest first;
5. acknowledged terminal jobs, newest first.

Controls:

| Key | Behavior |
| --- | --- |
| `Tab`, `Up`, `Down` | Select main, agent, or shell |
| `Enter` | Open transcript or shell detail |
| `x` | Stop selected active job after using the existing confirmation/permission pattern |
| `d` | Dismiss a terminal record; never kills a process |
| `f` | Toggle follow mode for shell output |
| `n` | Cycle shell completion policy where the caller has authority |
| `r` | Rerun a terminal shell through a fresh permission check |
| `Esc` | Return to the main prompt |

The panel must remain usable below 42 columns and with screen-reader/reduced-motion modes.

### Shell detail

Add `BackgroundShellDetail` with:

- title, state, lifetime, elapsed/frozen duration, PID, and exit metadata;
- submitted command and working directory;
- sandbox status and timeout/deadline;
- live incremental output with truncation and rotation notices;
- unread/acknowledged completion state;
- key hints appropriate to active versus terminal state.

Output rendering must not parse terminal escape sequences as trusted UI control. Reuse the existing
sanitization and bounded transcript patterns.

### Commands

- Add `/jobs` to open the unified panel.
- Keep `/tasks` as an alias for at least one release and document the terminology change.
- Extend `/job <id>`, `/job stop <id>`, `/job dismiss <id>`, `/job output <id>`, and
  `/job rerun <id>` for scripting and recovery.
- Keep `/agent` commands unchanged.
- Keep `BashOutput`, `KillShell`, and `DismissShell` as model-facing compatibility tools backed by
  the new shell manager.

## Tool Contract Changes

Extend `Bash` background arguments without exposing the generic host `timeout` control:

```ts
{
  command: string;
  workdir?: string;
  run_in_background?: boolean;
  lifetime?: 'session' | 'persistent';
  notify?: 'none' | 'ui' | 'agent';
  max_runtime_ms?: number;
  title?: string;
}
```

Rules:

- `lifetime`, `notify`, `max_runtime_ms`, and `title` apply only when `run_in_background` is true;
- persistent lifetime requires an explicit permission decision even if the command itself is
  otherwise allowed, because it changes cleanup semantics;
- `max_runtime_ms` maps to the runner deadline and remains distinct from the short tool-call timeout;
- foreground behavior and the hidden tool execution `timeout` remain backward compatible;
- result data includes the stable job ID, not only a display string.

Add model tools only if ToolSearch and active-tool budgets remain acceptable:

- `JobList`: list bounded summaries for shell and agent jobs;
- `JobGet`: inspect one summary;
- `JobOutput`: read bounded new shell output by offset;
- `JobStop`: stop one active job;
- `JobDismiss`: remove one terminal record.

The existing specialized agent tools remain authoritative for agent follow-up, evidence, and apply.

## Persistence and Storage

Use a user-local repository-scoped path, parallel to managed agents:

```text
~/.book/jobs/<repo-hash>/
  records/<job-id>.json
  logs/<job-id>.stdout.log
  logs/<job-id>.stderr.log
  leases/<job-id>.json
```

Requirements:

- atomic record replacement with per-record revision numbers;
- restrictive file permissions where supported;
- no inherited environment dump;
- bounded logs, for example two 5 MiB segments per stream;
- configurable retention with a conservative default such as seven days;
- cleanup only for terminal records not currently leased by a live runner;
- startup recovery that classifies records as running, terminal, or lost without blocking TUI start;
- safe handling of antivirus/file-lock contention using the existing atomic writer patterns;
- diagnostic logging that records IDs and transitions, never command text, output, or environment.

## Implementation Phases

### Phase 0: Freeze contracts and terminology

Purpose: prevent UI work from baking in the current shell-tool storage shape.

- Add background-job types and lifecycle transition tests.
- Document the distinction between planning tasks, managed agents, and executable jobs.
- Add characterization tests for current shell timeout, cancellation, output bounds, retention, and
  session disposal behavior.
- Add characterization tests for managed-agent panel ordering, completion acknowledgement, and
  stop/dismiss behavior.
- Decide the five review items at the top of this plan.

Exit gate:

- existing behavior is unchanged;
- every current cleanup guarantee has a deterministic test;
- the unified summary type can represent every current agent and shell status without lossy casts.

### Phase 1: Extract an evented shell job manager

Purpose: make shell lifecycle usable outside the `Bash` tool.

- Move process spawning, output buffering, status transitions, timeout handling, termination, and
  retention from `src/tools/shell.ts` into `src/jobs/shell-manager.ts`.
- Store the manager on `SessionRuntime` and make `Bash`, `BashOutput`, `KillShell`, and
  `DismissShell` thin adapters.
- Emit typed start, output-available, status, and completion events.
- Add list/get/read/stop/dismiss methods with stable IDs and structured results.
- Preserve direct-process session behavior exactly in this phase.

Exit gate:

- all existing shell tests pass through the manager;
- no process lifecycle logic remains in TUI or tool adapters;
- duplicate close/error/timeout events produce one terminal transition.

### Phase 2: Ship current-session TUI management

Purpose: let users manage the background work Book already supports.

- Add a `useBackgroundJobs` hook that combines shell-manager events with managed-agent projections.
- Generalize the background panel and add shell detail/output views.
- Add `/jobs` plus the `/tasks` alias.
- Implement inspect, follow, stop, dismiss, and unread acknowledgement.
- Add non-modal completion notices for all shell jobs.
- Keep agent transcript navigation and permission/question surfaces unchanged.

Exit gate:

- a user can list, inspect, follow, stop, and dismiss a background shell without asking the model;
- agents and shells sort correctly in one panel;
- narrow terminal, screen-reader, and reduced-motion tests pass;
- session transitions still stop all session jobs.

### Phase 3: Add bounded completion delivery and host parity

Purpose: remove shell polling when the caller explicitly requests notification.

- Implement `notify` policies and durable-in-session completion sequence IDs.
- Deliver `notify: "agent"` results through the existing idle-aware parent notification queue.
- Add `background_job_start`, `background_job_update`, `background_job_output`, and
  `background_job_result` to SDK and stream JSON.
- Bound automatic output tails and deduplicate delivery independently from TUI acknowledgement.
- Ensure a completion never interrupts an active permission, question, compaction, rewind, or send.

Exit gate:

- UI-only jobs never trigger model turns;
- agent-notify jobs trigger at most one parent turn with bounded output;
- TUI, SDK, headless, and stream JSON observe consistent terminal metadata;
- a completion arriving during another interaction is delivered after the host becomes idle.

### Phase 4: Add the durable job runner

Purpose: support explicit jobs that survive Book restart.

- Implement a small Node runner with a versioned startup and status protocol.
- Add atomic job records, leases, ownership tokens, output files, and rotation.
- Add persistent lifetime permission handling.
- Teach the shell manager to start, reattach, inspect, and stop runner-owned jobs.
- Add startup reconciliation and the `lost` state.
- Keep session lifetime as the default and direct-child fast path.

Exit gate:

- a persistent fixture continues across a controlled Book shutdown and is manageable after restart;
- session jobs still terminate on shutdown;
- stale or reused PIDs are never signaled;
- runner or Book crashes leave a recoverable atomic state;
- output and disk usage stay within configured bounds.

### Phase 5: Link planning tasks and finish recovery UX

Purpose: make task tracking useful without conflating it with execution.

- Add optional `execution` linkage to `AgentTask`.
- Allow `TaskCreate`/`TaskUpdate` to associate an existing job after validating ownership.
- Update `TaskStop` to stop the linked job first and change planning status only after a successful
  or already-terminal stop result.
- Show the linked planning-task subject in job detail and job status in task detail.
- Add rerun through normal tool preparation, permission, and sandbox paths.
- Add retention settings, cleanup commands, doctor diagnostics, and migration handling.

Exit gate:

- stopping a linked task cannot report success while its job is still running;
- unlinked planning tasks retain current behavior;
- rerun never bypasses permissions;
- stale records have clear remediation from TUI and `book doctor`.

## Primary Code Areas

Expected additions:

- `src/jobs/types.ts`
- `src/jobs/shell-manager.ts`
- `src/jobs/service.ts`
- `src/jobs/store.ts`
- `src/jobs/runner.ts`
- `src/jobs/projections.ts`
- `src/tui/hooks/useBackgroundJobs.ts`
- `src/tui/components/BackgroundJobPanel.tsx`
- `src/tui/components/BackgroundShellDetail.tsx`

Expected modifications:

- `src/tools/shell.ts`
- `src/tools/tasks.ts`
- `src/session/runtime.ts`
- `src/session/agent-session.ts`
- `src/tools/agent-tools.ts`
- `src/tui/app.tsx`
- `src/tui/hooks/useManagedAgents.ts`
- `src/tui/hooks/useAgentCompletionDelivery.ts`
- `src/commands/builtins.ts`
- `src/sdk.ts`
- `src/stream-json.ts`
- `src/settings.ts`
- `README.md`

The implementation should avoid adding more lifecycle branching directly to `src/tui/app.tsx`.

## Test Strategy

### Unit and contract tests

- valid and invalid status transitions;
- exactly-once terminal transition and completion sequence;
- bounded output reads, offsets, truncation, and log rotation;
- timeout versus explicit kill versus session disposal semantics;
- stable identity and rejected PID reuse;
- persistence recovery from partial, stale, locked, and corrupt records;
- notification policy and deduplication;
- permission re-evaluation on persistent start and rerun;
- planning-task execution linkage.

### TUI tests

- mixed agent/shell ordering and selection;
- main, agent, and shell navigation;
- stop versus dismiss key safety;
- live follow and frozen terminal output;
- unread completion acknowledgement;
- narrow layouts, long commands, large output, Unicode output, and screen-reader labels;
- completion arrival while the prompt, permission dialog, or child detail is active.

### Process integration tests

- foreground and session-background process-tree termination on Windows and Unix;
- persistent runner survival across parent exit;
- restart reattachment and output continuation;
- runner crash, child crash, Book crash, and simultaneous stop races;
- timeout while Book is not running;
- stale runner lease and PID reuse simulation;
- cleanup that never removes a live job.

Real process tests should be isolated from the default unit tier where platform behavior is flaky,
but they must run in CI on supported Windows and Linux versions before persistent jobs are released.

## Rollout and Compatibility

1. Land Phases 0-1 with no visible behavior change.
2. Release current-session TUI management behind `jobs.ui.enabled`, defaulting on after one release
   if TUI tests and telemetry are stable.
3. Add notification policies with `ui` as the background-shell default.
4. Release persistent lifetime as experimental and explicit; do not migrate existing shells.
5. Remove the feature flag only after crash/restart and cross-platform process tests are reliable.
6. Keep `/tasks`, `BashOutput`, `KillShell`, and `DismissShell` compatibility surfaces through the
   rollout. Any later deprecation requires release notes and migration guidance.

Telemetry, when enabled, should capture only lifecycle counts, durations, terminal states,
reattachment outcomes, and failure codes. It must not capture command text or output.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| PID reuse kills an unrelated process | Verify runner token and process-start identity; otherwise mark `lost` |
| Persistent jobs surprise users | Explicit lifetime, distinct permission, visible TUI badge, session default unchanged |
| Logs leak secrets | User-local restrictive files, bounded retention, no telemetry payloads, no automatic full-log injection |
| Completion causes model loops | Default UI-only notification, exactly-once sequence IDs, bounded parent delivery |
| TUI becomes a second lifecycle owner | All actions call the shared service; components render state only |
| Windows process trees behave differently | Runner owns termination; dedicated Windows integration tier |
| Agent and shell statuses drift | One projection contract with exhaustive status mapping tests |
| Store contention blocks startup | Reuse atomic/deferred persistence patterns and reconcile asynchronously |
| `/tasks` remains ambiguous | Introduce `/jobs`, retain documented alias, keep planning tasks visibly separate |
| Durable runner expands attack surface | Versioned minimal protocol, filtered environment, no arbitrary attach, capability token |

## Definition of Done

The project is complete when:

- `/jobs` shows `main`, managed agents, and shell jobs in one responsive panel;
- users can inspect output and stop or dismiss jobs without model involvement;
- shell completion is visible automatically and optional parent delivery is exactly once;
- session-scoped jobs preserve current cleanup behavior;
- explicit persistent jobs survive restart and can be safely reattached or classified as lost;
- no stale record can cause Book to signal an unverified PID;
- SDK and stream JSON expose the same lifecycle states as the TUI;
- `TaskStop` controls a linked execution without changing unlinked task behavior;
- bounded storage, cleanup, permission, crash, and cross-platform tests pass;
- README and release notes clearly explain lifetime, notification, output retention, and recovery.
