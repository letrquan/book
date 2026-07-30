# Phase 2: Build the Append-Only Run Evidence Ledger

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Not started
- **Depends on:** Phase 1 verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---

**Objective:** Observe real execution before selecting or evolving workflows.

**Deliverables:**

- Add stable run IDs and schema-versioned JSONL records.
- Wrap existing callbacks to capture turn, tool, usage, interruption, error, and completion events.
- Store references to session/tool records instead of duplicating large or sensitive payloads.
- Add bounded payload sizes, secret redaction, corruption recovery, and retention controls.
- Record model identity, project identity, active settings, and an explicit `baseline` workflow label.
- Record runtime, environment, tool-surface, context-capability, and evaluator compatibility references.
- Record prompt-layer, skill registry/activation, context-policy, model-adapter, hook-policy,
  verifier, and delegation capability references.
- Preserve source provenance for derived evidence without copying untrusted raw content.
- Map the local ledger to OpenTelemetry-compatible trace, span, event, and metric fields.
- Keep observation asynchronous where possible so logging does not block user-visible execution.

#### Phase 2 Work Breakdown

##### 2.1 Define the event envelope and event union

Every persisted event should share an envelope:

```ts
interface HarnessEventEnvelope<TType extends string, TData> {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  timestamp: number;
  sequence: number;
  type: TType;
  data: TData;
}
```

Initial event types:

```text
run_started
turn_started
model_usage
tool_started
tool_finished
permission_resolved
workflow_transition_requested
workflow_transition_applied
assistant_message_completed
run_interrupted
run_failed
run_completed
prompt_layer_rendered
skill_activation_requested
skill_activation_applied
skill_activation_expired
tool_discovery_requested
tool_discovery_applied
context_contribution_recorded
verification_requested
verification_completed
subagent_handoff_created
capability_clamped
```

Events should contain summaries and references. Do not persist raw prompts, complete tool output, full file contents, or secrets by default.

##### 2.2 Define run identity and sequencing

- Generate one run ID per root user request, not per model turn.
- Record parent/child relationships for subagent runs.
- Use monotonic per-run sequence numbers so concurrent callback arrival can be reconstructed.
- Treat session ID, run ID, tool-call ID, and nested trace ID as different identities.
- Treat trace/span IDs as observability correlation, not permission or policy authority.
- Finalization must be idempotent.

Root request preparation/finalization belongs at `src/session/agent-session.ts`, which is the shared
lifecycle bridge for headless and TUI execution. Headless/TUI adapters should not create duplicate
run boundaries. A process serving multiple requests must create one root ID inside the request loop.
Resume must record whether it continues the same run or creates a new linked run.

The runtime prerequisite decision is explicit: each user request receives a new root `runId`; a
session resume creates a new root run with `resumedFromRunId`; and a managed-agent continuation is
a child run with a new `runId`, the originating `rootRunId`, and its parent execution ID. Terminal
outcomes belong to the execution run, while the root ID joins linked child evidence.

##### 2.3 Implement the project-scoped store

Use an append-only store aligned with Book's existing project storage conventions. The initial proposal is:

```text
~/.book/projects/<workspace-slug>/harness/runs/<run-id>.jsonl
~/.book/projects/<workspace-slug>/harness/index.jsonl
```

Requirements:

- create directories lazily only in `observe` or higher modes;
- append complete JSON lines;
- tolerate a truncated final line;
- never rewrite completed raw events during normal operation;
- expose schema version and migration/read compatibility;
- use bounded summaries and stable references;
- retain compatibility fingerprints and provenance references needed to judge replay validity;
- apply retention without deleting promoted verification evidence unexpectedly.

Use the normalized workspace hash as the authoritative project key, optionally paired with a
readable slug. A slug alone can collide. Existing managed-agent `EvidenceItem` and telemetry records
are agent-authored operational data; retain their provenance as untrusted references and never treat
them as evaluator truth.

##### 2.4 Build callback adapters

Create `src/harness/observer.ts` to wrap `AgentLoopCallbacks`. It should forward the original callback first or in the documented order, then emit a bounded event without swallowing callback errors.

Integrate at the shared lifecycle boundary and host boundaries:

- `src/session/agent-session.ts` for root request ownership and terminal finalization;
- `src/session/agent-events.ts` for typed terminal reasons;
- `src/headless.ts` for headless, SDK, and CI runs;
- `src/tui/app.tsx` or the existing TUI agent hook for interactive runs;
- subagent invocation through explicit parent run metadata.

Avoid adding persistence calls throughout every branch in `src/agent/loop.ts` unless an event cannot be observed reliably from callbacks. Current callbacks do not expose actual tool start or automatic permission resolution, so add narrow runtime events for those facts rather than inferring them from `onToolCall`.

##### 2.5 Add redaction and payload policy

Classify fields as:

```text
safe scalar metadata
bounded derived summary
stable reference to session evidence
forbidden raw payload
```

Reuse `src/secret-detect.ts` where appropriate, but do not assume secret detection makes arbitrary prompt storage safe. Path names and command arguments may also require redaction or hashing.

Every bounded summary should retain a source class such as `user`, `system`, `repository`, `tool`, `web`, or `derived`. Untrusted source text may be summarized or referenced, but it cannot be persisted as trusted policy or silently promoted into a user preference.

##### 2.6 Map events to portable telemetry semantics

Define a stable mapping from run/turn/tool/permission/evaluator events to OpenTelemetry concepts:

- run and nested subagent execution map to traces or spans;
- tool/model/permission operations map to named spans with bounded attributes;
- tokens, cost, latency, retries, and evaluator status map to metrics/events;
- workflow, policy, model, environment, and tool-surface versions remain explicit attributes;
- prompt-layer, skill, context, model-adapter, verifier, hook, and delegation versions remain
  explicit attributes;
- export is optional, but the local schema must not require a proprietary backend.

Do not emit raw prompts, complete tool output, secrets, or sensitive file contents merely to satisfy telemetry conventions.

Use valid W3C/OTel trace and span IDs for telemetry and keep Book/UI trace strings separate. Pin the
semantic-conventions version and enforce bounded attribute counts/value sizes; current GenAI content
attributes are sensitive opt-in data, not a reason to copy prompts into the ledger.

##### 2.7 Handle lifecycle edge cases

Cover:

- process interruption before `run_started` is flushed;
- process interruption without `run_completed`;
- callback exception;
- provider retry and stream stall;
- tool timeout and cancellation;
- session resume;
- subagent cancellation;
- duplicate finalization;
- disk write failure.

Evidence failure should be visible but should not corrupt the user task. In `observe` mode, a storage failure should normally degrade observation, not fail the agent execution.

Every terminal run must report observer completeness, dropped-event count, flush status, and storage
errors so a degraded ledger cannot silently become learning-eligible.

##### 2.8 Add inspection and cleanup surfaces

Initially provide programmatic helpers or a simple CLI report for:

- list recent harness runs;
- inspect one run summary;
- show storage location and size;
- delete project-scoped evidence explicitly;
- run retention cleanup.

The store design must state its writer model, file-locking/sequence strategy, fsync or durability
level, crash-safe cleanup, index rebuild behavior, and pinned verification references. JSONL is fine
for a single-writer append log only if these guarantees are explicit and tested.

#### Phase 2 File Plan

```text
Add    src/harness/observer.ts
Add    src/harness/observer.test.ts
Add    src/harness/run-store.ts
Add    src/harness/run-store.test.ts
Add    src/harness/redaction.ts
Add    src/harness/redaction.test.ts
Add    src/harness/telemetry.ts
Add    src/harness/telemetry.test.ts
Modify src/headless.ts
Modify src/headless.test.ts
Modify src/tui/app.tsx or src/tui/hooks/useAgent.ts
Modify src/subagent.ts
Modify src/session/agent-session.ts
Modify src/session/agent-events.ts
```

#### Phase 2 Test Matrix

- Ordered root-run events.
- Nested subagent parent/run relationships.
- Tool success, failure, retry, timeout, and cancellation.
- Provider retry, stream failure, and abort.
- Duplicate finalization is harmless.
- Disk-full/write-error simulation does not corrupt the active session.
- Corrupt/truncated tail recovery.
- Retention preserves records referenced by a verification packet.
- Secret-like prompts, commands, and tool outputs do not appear raw in the ledger.
- Provenance is retained for bounded summaries and cannot be mistaken for trusted policy.
- OpenTelemetry mapping preserves trace/span relationships and bounded attributes.
- Runtime, environment, tool-surface, and context-capability changes are visible in run records.
- Capability-manifest changes are visible in run records, including which layer or component changed.
- `observe` adds no prompt text, tool definitions, or permission changes.

**Verification:**

- `off` and `observe` produce equivalent user-visible and provider-visible behavior.
- Interrupted, aborted, failed, and successful runs all produce valid terminal records.
- A truncated final JSONL line does not make previous records unreadable.
- Secrets and full file contents are not copied into the evidence ledger.
- Observation overhead is measured and kept within the Phase 0 limit.
- The ledger supports portable trace correlation without making a telemetry exporter a runtime dependency.

**Commands:**

```powershell
npm run typecheck
npm run test:unit -- src/harness/run-store.test.ts
npm run test:unit -- src/harness/observer.test.ts
npm run test:unit -- src/headless.test.ts
npm run test:unit -- src/session/store.test.ts
npm test
```

**Exit gate:** Book can explain what happened during a run without changing how the run behaves.

**Rollback:** Disable observation and leave existing JSONL records readable but unused.

**Intent check:** Is the ledger collecting evidence needed for decisions, or merely producing more logs?
