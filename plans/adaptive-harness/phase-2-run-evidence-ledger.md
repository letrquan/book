# Phase 2: Build the Append-Only Run Evidence Ledger

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Verified 2026-08-13 (observe mode only; contract reconciled 2026-08-12)
- **Depends on:** Phase 1 verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

## Frozen contract reconciliation (#50 / #51)

The original packet sketches are superseded where they differ from the closed decisions
[Freeze first-release surfaces and off-mode semantics](https://github.com/letrquan/book/issues/50)
and [Define the evidence ledger durability, identity, and privacy contract](https://github.com/letrquan/book/issues/51).
Phase 2 therefore has the following binding rules:

- `off` is an absent harness path: it creates no ID, clock/sequence state, storage path,
  observer, timer, or filesystem effect. `observe` is the only mode enabled by this phase;
  `shadow`, `active`, and `learn` remain unavailable and fail before run setup.
- Each root user request gets a fresh root run ID. A resume gets a new root linked by
  `resumedFromRunId`; a managed continuation gets a fresh child `runId` linked by
  `rootRunId` and `parentRunId`. `sessionId`, operation IDs, and W3C trace/span IDs remain
  distinct identities.
- One host-owned writer actor serializes a root stream. Records use canonical JSON bytes,
  a monotonic root sequence, a SHA-256 previous-record hash chain, and an explicit seal.
  `accepted` means queued, not durable; only a verified flush/seal can claim durability.
  A corrupt or truncated tail is never skipped or repaired in place, and an unsealed or
  incomplete stream is not promotion-eligible.
- Persistence is an event-type allowlist of safe scalars, bounded derived facts, and protected
  references. Prompts, completions/reasoning, commands/tool arguments and output, file contents,
  credentials, URLs/query strings, arbitrary exception text, and secrets are forbidden. Ambiguous
  values are omitted. Redaction happens before queueing, hashing, diagnostics, indexing, or export.
- Queue pressure uses bounded non-blocking drop-newest semantics and records attempted,
  accepted, exported, dropped, and failure counters. Any required loss, storage error, flush
  timeout, or integrity failure marks evidence incomplete/unknown; observation may degrade the
  user run but can never create promotion-eligible evidence.
- The local ledger is authoritative and exporter-independent. OpenTelemetry mapping is pinned to
  W3C Trace Context and Semantic Conventions v1.44.0 with bounded low-cardinality attributes;
  sensitive GenAI content attributes stay disabled.

The implementation below intentionally uses the exact identities, durability vocabulary, and
fail-closed completeness semantics above instead of the earlier illustrative `slug`, mutable
append, permissive payload, or successful-disabled-observer sketches.

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

---

## Phase 2 Verification Packet (2026-08-13)

**Code version:** working tree on `main` after commit 498e7f9 (Phase 2 implementation change set).
**Model/provider:** not applicable — observe mode is behavior-neutral; tests use the scripted
provider and stub loops. **Corpus:** none consumed; observe evidence is calibration-ineligible by
construction until a Tier-A-eligible trial pipeline consumes it.

### What was built

- `src/harness/run-store.ts` — single-writer append-only per-root JSONL ledger: canonical JSON
  records, monotonic sequence, SHA-256 previous-record hash chain, group-synced durability
  (`accepted` ≠ durable; explicit fsync policy with directory-sync honestly reported
  `unavailable`, so `evidenceComplete` fails closed to `ineligible` on every seal), signed
  ed25519 seal with counters, bounded drop-newest queue, truncated-tail/corrupt/unsealed reader
  states, rebuildable index, retention cleanup honoring pins, and pin creation restricted to
  complete sealed runs.
- `src/harness/redaction.ts` — `allowlist-v1`: bounded safe-scalar attributes with forbidden-key
  and secret filters, bounded summaries/evidence refs, omitted-field accounting, protected
  digests, W3C trace/span validation, and scalar identity projection. Redaction runs before
  queueing and hashing; the `run_started` header persists the identity projection and a
  metadata projection, never raw metadata objects.
- `src/harness/observer.ts` — `wrapAgentLoopCallbacks` forwards every original callback first,
  contains observer failures, emits bounded turn/usage/tool/permission/retry/stall/assistant
  events, and records managed-agent starts as explicit `subagent_handoff_created` child linkage.
  Terminal evidence is emitted only by the shared session lifecycle to avoid double terminals.
- `src/harness/telemetry.ts` — exporter-independent OTel mapping pinned to SemConv v1.44.0 with
  bounded, content-free attributes.
- `src/harness/coordinator.ts` — `observe` coordinator: one writer per root stream, child runs
  join the open root stream (deterministic `harness_root_stream_unavailable` failure when it is
  sealed or absent), child observers flush but can never seal the root, duplicate finalization is
  inert, `off` remains the frozen inert coordinator (`rejected` enqueue, disabled flush result,
  no filesystem effect).
- `src/session/agent-session.ts` — root prepare/finalize at the shared lifecycle bridge:
  prepares the observer when `harness.mode` is `observe` (host coordinators injectable), passes
  ambient runtime/environment/tool-surface/settings fingerprints into the run header, maps
  terminal outcomes (`timed_out` → `timed-out`), reports preparation/finalize degradation via
  `onHarnessFinalized`, and never lets evidence failure alter the run result.
- `src/headless.ts` — one coordinator per process invocation; per-turn runs flush
  (`harnessFinalize: false`) and every root stream is sealed exactly once in the `finally`
  sweep with its latest linked-turn outcome, including on thrown errors. Managed continuation
  turns join the originating root stream as child runs.
- `src/tui/hooks/useAgent.ts` + `AgentSession.send` — agent-notification continuation turns now
  carry `rootRunId`/`parentRunId` linkage per decision #50.
- `src/subagent.ts` — the direct subagent runner accepts optional harness options and records the
  handoff plus child-attributed events into the parent's stream.
- `src/session/agent-events.ts` needed no change: typed terminal reasons already flow through
  `types/terminal.ts` and the `onTerminal` callback consumed at the session boundary.
- Docs: `README.md` gains a "Run evidence ledger (experimental)" section describing the storage
  path, the seal/counter reporting, and the redaction guarantees, since `observe` is a user-facing
  on-disk surface like tool-use telemetry. `CHANGELOG.md`, `MILESTONES.md`, and
  `docs/current-state.md` record the same observe-only scope.

### Commands and results

Re-run in full on 2026-08-13 after the adversarial-review fixes landed (the earlier gate run
predated them, so it is superseded by this one):

```text
npm run check            PASS — format, lint (0 warnings), typecheck, architecture,
                                unit (199 files; 1,941 passed, 5 skipped),
                                contract (4 files; 31 passed)
npm run build            PASS — ESM bundle + DTS
npm run test:integration 6/7 files passed (81 passed, 7 skipped); 2 host-sensitive,
                                load-dependent failures in src/tui/tui-integration.test.ts
                                (shown non-causal below)
git diff --check         clean
```

The integration failures are host-sensitive TUI startup timeouts, not a Phase 2 regression, and
this was established empirically rather than by inspection. The committed startup-fire welcome
animation (`src/tui/components/StartupFire.tsx`, tracked in `HEAD` and untouched by this change
set) still occupies the PTY when the 10 s `Ask me anything` wait expires. Repeated runs of
`src/tui/tui-integration.test.ts` are load-dependent, not deterministic:

```text
with this change set (src/tui/hooks/useAgent.ts modified):  2, 2, 4, 18 failed of 22
with src/tui/hooks/useAgent.ts reverted to HEAD:            0, 12, 16 failed of 22
```

The same file fails 12 and 16 of 22 at `HEAD` with none of the Phase 2 TUI change applied, so the
failures are a property of the host and the startup animation, not of this change set. The
`useAgent.ts` diff is additive and executes only on `agent-notification` sends, which the startup
tests never reach; `harness.mode` is `off` in those runs, so no harness code executes at all. This
matches the known host-sensitive TUI startup timeouts already recorded against Phase 0. Treat these
tests as non-authoritative on this host; they are not Phase 2 evidence in either direction.

Focused suites (2026-08-13): `src/harness/run-store.test.ts` (16),
`src/harness/contracts.test.ts` (8), `src/harness/redaction.test.ts` (5),
`src/harness/coordinator.test.ts` (4), `src/harness/observer.test.ts` (4),
`src/harness/telemetry.test.ts` (2) — 39 harness tests total; plus
`src/session/agent-session.test.ts` harness describe (7) and `src/headless.test.ts` harness
describe (2).

### Test-matrix disposition

Ordered root events, hash-chain continuity, seal verification, duplicate/conflicting
finalization, disk-write failure latching, truncated-tail recovery, mid-stream and seal
tampering, retention pinning, secret/prompt/tool-content exclusion, provenance-preserving
omission accounting, OTel trace/span mapping, compatibility-fingerprint visibility in the run
header, subagent parent/child linkage, provider retry/stall capture, tool failure metrics, abort
and failure terminal sealing, off/observe provider-visible equivalence (session and headless),
and off-mode filesystem inertness are all covered by the suites above.

### Observation overhead (measured 2026-08-13, Windows 11, Node 20)

```text
enqueue (hot path):            ~8.6 µs/event
wrapped callback dispatch:     ~13.5 µs per tool-call+result pair (raw: ~0.05 µs)
drain+fsync of 5,000 events:   ~46 ms (asynchronous, off the callback path)
```

A typical run emits tens to low hundreds of events; total synchronous overhead stays well under
10 ms per run — negligible against provider latency and far inside the Phase 0 noise floor.

These numbers were measured before the final adversarial fix that moved observer attribute
construction into a thunk evaluated inside the containment guard (`emit(type, () => ({ … }))`).
That fix adds one closure allocation per event and does not change the order of magnitude, but the
figures above are not a measurement of the exact shipped code path. Re-measure before treating
observation overhead as a calibrated Phase 0 input.

### Known limitations and unknowns

- Directory fsync is not portably available in Node; the seal reports `directorySync:
  unavailable` and every seal therefore stays `evidenceEligibility: ineligible`. This is
  deliberate fail-closed behavior: observe-mode evidence cannot become promotion-eligible until
  a host with verified directory durability exists.
- In interactive (TUI) sessions the root stream seals when the root turn finishes; a managed
  continuation that arrives after the seal cannot join the stream and its observation degrades
  visibly (`harness_root_stream_unavailable`) instead of corrupting or forking root evidence.
  Headless defers the seal until linked turns finish and does not have this limitation. Runs
  with managed children are Tier-A-ineligible regardless.
- Managed-agent child execution inside `agents/manager.ts` is observed from the parent side
  (explicit handoff linkage); child-internal events are not independently persisted. That
  matches the parent plan's rule keeping managed agents a separate experimental axis.
- The root seal records the latest linked-turn outcome as the root request's final state; the
  per-execution outcomes remain in each turn's terminal events.
- Inspection surfaces are programmatic (`listRuns`, `inspectRun`, `storageInfo`, `deleteRun`,
  `cleanupRetention`, `createPin`); a CLI report can be added when a consumer exists.

### Anti-drift review

- Improves measurement only; no selection, no behavior change — `off` and `observe` produce
  identical provider-visible and user-visible behavior (tested at session and headless levels).
- Minimal workflow remains the only workflow; the ledger labels every run `baseline`.
- Explicit current intent is untouched; no learned behavior exists.
- Decisions are absent; observation is scoped per root run and per project.
- Inspection: ledger is readable JSONL plus programmatic inspectors; disabling is a settings
  flip back to `off`; rollback leaves records readable but unused.
- Success evaluated by external artifacts (files, seals, tests), not model self-assessment.
- Permissions, evaluator, budgets, history: untouched by the observer; storage failures cannot
  reach runtime behavior.
- No per-model profile added. Environment/tool-surface drift is fingerprinted in every header.
- Context/resume: resume linkage recorded via `resumedFromRunId`; interruption paths tested.
- Untrusted input: events are typed facts from runtime callbacks; free text is bounded,
  secret-filtered, or omitted with provenance (`omittedFields`, `sourceClass`).
- Ties: not applicable — no comparison occurs in this phase.

### Adversarial verification

A five-dimension adversarial review (ledger integrity, redaction, off-inertness/observe
equivalence, identity/lifecycle, failure modes) with independent refutation of each finding ran
against the frozen #50/#51 contract text. Confirmed findings were fixed before this packet was
recorded (notably: the run header previously embedded the raw `RunLedgerStartInput` metadata
object; it now persists only scalar identity and metadata projections).

**Decision:** Phase 2 marked **Verified** — observe mode only. `shadow`/`active`/`learn` remain
unavailable, Tier C remains blocked, and no adaptive behavior is introduced.
