# Phase 3: Add a Small Validated Workflow Registry

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Verified 2026-08-14 (built-in registry only; project-local workflow files deferred)
- **Depends on:** Phase 2 verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---


**Objective:** Make workflow variation explicit, bounded, inspectable, and manually selectable.

**Deliverables:**

- Define a small workflow schema with knobs such as planning, bounded context/resume strategy, verification, edit scope, and autonomy.
- Add no more than three initial workflows: `minimal`, `safe-edit`, and `verify-heavy`.
- Validate workflow files with Zod and reject unknown or unsafe fields.
- Add an explicit CLI/settings override for manual workflow selection.
- Render the active workflow in the dynamic system-prompt zone.
- Enforce supported controls outside the prompt where possible.
- Record the exact workflow ID/version/reason with every run.
- Allow workflows to request only registered capability-policy IDs; prompt layers, skills, tools,
  context policies, model adapters, verifiers, hooks, and delegation remain separately versioned.

#### Phase 3 Work Breakdown

##### 3.1 Define the workflow schema

Keep workflow definitions compact and declarative:

```ts
interface WorkflowDefinition {
  schemaVersion: 1;
  id: string;
  version: number;
  description: string;
  planning: 'direct' | 'light' | 'structured';
  context: {
    strategy: 'minimal' | 'relevant' | 'deep';
    maxInputTokens?: number;
    compactionPolicy: 'existing' | 'checkpoint' | 'handoff';
    preserveFailures: boolean;
    preserveDecisions: boolean;
    includeProjectMemory: boolean;
    includeRecentFailures: boolean;
  };
  verification: {
    level: 'none' | 'targeted' | 'full';
    requireEvidenceBeforeSuccess: boolean;
  };
  execution: {
    editScope: 'small' | 'normal' | 'broad';
    retryPosture: 'default' | 'cautious';
  };
  requestedApprovalPosture: 'default' | 'ask-more';
}
```

`requestedApprovalPosture` is advisory and monotone toward more confirmation. The initial workflow
surface does not contain `ask-less`; it cannot select `auto`, `dontAsk`, `bypassPermissions`, override
deny rules, or exceed the user's configured mode.

Context token limits are requests clamped by the trusted runtime. Compaction, checkpoint, and handoff values are valid only when the fixed runtime advertises the corresponding tested capability.

Do not add model names, user identities, project paths, task prompts, arbitrary code, free-form system prompts, tool definitions, retry implementations, or security rules to workflow definitions.

Do not add embedded skill bodies, tool descriptions or schemas, context retrieval code, model
adapter text, hook commands, verifier commands, or subagent definitions. Those belong to the fixed
capability substrate in Phase 3A and are referenced only by validated IDs after that phase exists.

Use recursively strict validation and canonical JSON serialization before hashing. Project-local
workflow files are untrusted repository data even after schema validation: never render their
free-form description as instructions, reject symlink/path escapes, and fail closed when an explicit
workflow is malformed.

##### 3.2 Define the three initial workflows

`minimal`:

- preserve current Book behavior as closely as possible;
- direct planning unless the user requests a plan;
- relevant context only from existing mechanisms, with no new compaction or handoff behavior;
- no additional verification instruction beyond current guardrails;
- no automatic parallelism.

`safe-edit`:

- light or structured planning for mutating tasks;
- smaller edit scope;
- targeted verification after meaningful changes;
- more cautious handling of dependency, migration, and broad file changes.

`verify-heavy`:

- require explicit evidence before claiming completion;
- run declared project verifiers when authorized;
- inspect final diff and regression signals;
- accept higher cost only within the fixed kernel budget.

These workflows are comparison instruments first. Avoid optimizing them during Phase 3.

Only fields classified as kernel-enforced or explicitly bounded guidance by the Phase 1 capability
matrix may vary. Unsupported fields are rejected or visibly clamped. Initial workflows do not select
multi-agent parallelism; the existing managed-agent system is a separate experimental axis.

##### 3.3 Implement registry loading and precedence

Start with built-in workflow definitions in source. If project-defined workflows are supported in Phase 3, use an explicit validated directory such as:

```text
.book/harness/workflows/*.json
```

Recommended precedence:

```text
explicit CLI/session override
project-local validated workflow with exact ID/version
built-in promoted workflow
minimal fallback
```

Do not load candidates from the active workflow path.

##### 3.4 Separate requested and effective decisions

Create a resolved representation:

```ts
interface ResolvedWorkflow {
  requested: WorkflowDefinition;
  effective: WorkflowEffectiveSettings;
  clamps: Array<{
    field: string;
    requested: unknown;
    effective: unknown;
    reason: string;
  }>;
}
```

This makes kernel restrictions visible instead of silently ignoring workflow requests.

##### 3.5 Render a bounded execution-policy section

Add the active workflow to `src/agent/context.ts` through a dedicated dynamic policy zone so switching workflows does not invalidate the session-stable prompt prefix unnecessarily. Do not reuse generic `systemPromptAppend`, which currently belongs to the cached prefix and can contain unrelated agent text.

The rendered section should:

- state the workflow ID/version;
- express only supported behavioral guidance;
- distinguish guidance from enforced rules;
- avoid repeating existing system instructions;
- stay under a fixed character/token budget;
- omit itself for `minimal` if equivalence requires no new prompt text.

##### 3.6 Add explicit selection controls

Support at least one non-TUI control first, such as settings or a CLI flag. Later add an interactive command:

```text
/harness status
/harness workflow minimal
/harness workflow safe-edit
/harness reset
```

Manual selection should be scoped to the current run/session unless the user explicitly persists it to project settings.

Define whether a session override survives process resume. If persistence is required, add a
versioned session record; otherwise call it process/run-scoped. Include CLI parser/help/contract tests
and public SDK fields if SDK selection is in scope.

##### 3.7 Record workflow provenance

Every run should record:

- requested and effective workflow;
- source and selection reason;
- registry version/hash;
- any kernel clamps;
- manual override scope;
- prompt-policy rendering version.
- effective context budget/capability version and any context-policy clamps;
- declared workflow complexity measures such as rendered tokens, active fields, transitions, and requested extra calls.

#### Phase 3 File Plan

```text
Add    src/harness/workflows.ts
Add    src/harness/workflows.test.ts
Add    src/harness/registry.ts
Add    src/harness/registry.test.ts
Modify src/harness/contracts.ts
Modify src/agent/context.ts
Modify src/agent/context.test.ts
Modify src/settings.ts
Modify src/cli/run.ts or src/index.ts
Modify src/cli/options.ts or the actual CLI parser/help module
Modify src/commands/builtins.ts and src/tui/app.tsx only if /harness ships in this phase
```

#### Phase 3 Test Matrix

- Unknown fields and arbitrary prompt/code fields are rejected.
- Duplicate IDs or non-monotonic versions are rejected.
- Missing registry falls back to built-in `minimal`.
- Manual run/session/project precedence is deterministic.
- Kernel clamps are recorded and explained.
- `minimal` provider messages match the accepted baseline.
- Workflow prompt section stays within its budget.
- Workflow definitions cannot enable unavailable tools or bypass permissions.
- Unsupported context, compaction, checkpoint, or handoff capabilities are rejected or clamped explicitly.
- Workflow definitions cannot change tool schemas, retry/cancellation correctness, provenance, or prompt-injection defenses.
- Candidate files placed beside the candidate store never become active.
- Recursive unknown fields, symlink escapes, and candidate-path workflows are rejected.
- Every selected field has a recorded requested/effective capability mapping; prompt-only guidance is not reported as enforcement.

**Verification:**

- Invalid workflows cannot start a run.
- `minimal` stays close to the pre-harness baseline and adds no unnecessary planning language.
- Manual overrides always beat automatic/default selection.
- Workflow selection cannot weaken permissions, sandboxing, budgets, or evaluator rules.
- Each workflow produces reproducible configuration for the same input.
- Fixed runtime responsibilities remain outside the workflow schema, and workflow complexity is inspectable.

**Commands:**

```powershell
npm run typecheck
npm run test:unit -- src/harness/workflows.test.ts
npm run test:unit -- src/agent/context.test.ts
npm run test:unit -- src/config.test.ts
npm run test:unit -- src/permissions.test.ts
npm test
```

**Exit gate:** Fixed workflows can be compared fairly without any automatic learning.

Phase 4 remains blocked until [Phase 3A](phase-3a-agent-capability-substrate.md) verifies that the
prompt, skill, tool, context, model, verification, hook, and delegation surfaces are independently
versioned and cannot drift underneath a workflow comparison.

**Rollback:** Force `minimal` globally and retain other workflow definitions as inactive test fixtures.

**Intent check:** Are workflows compact execution policies, or are they becoming large model-specific profiles?

---

## Verification packet (2026-08-14)

### Scope decisions taken during implementation

These narrow the packet sketch above; each is deliberate, not an omission.

- **No new harness mode.** `AVAILABLE_HARNESS_MODES` stays `['off', 'observe']`. "Manual/fixed"
  behavior is carried by `WorkflowDecisionSource: 'manual'`, not by a mode.
- **Selection is effective only under an enabled mode.** `off` is an absent harness path, so a
  selected workflow would change behavior with no ledger to record it. Selection therefore fails
  closed at `book config set`, at `loadConfig`, at the CLI flag, and at `AgentSession.run()`.
  It is never silently ignored.
- **Built-in registry only.** `.book/harness/workflows/*.json` is deferred (it was conditional in
  3.3). Workflow IDs are opaque registry keys matched by `/^[a-z][a-z0-9-]{1,31}$/`, so a selection
  string cannot address a path, a traversal segment, or the candidate store. Built-ins pass through
  the same recursively strict Zod validation, canonical hashing, and budget check that project files
  would, so the untrusted-input rows are satisfied by rejection rather than by a file loader.
- **No field reports enforcement.** Per the Phase 1 capability matrix, nothing in the initial
  workflow surface has a workflow-selectable enforcement point. Every disposition is `guidance`
  (bounded prompt text), `clamped` (request dropped), or `host-owned` (fixed runtime behavior).
  `execution.editScope` is exposed as guidance only, as the matrix requires.
- **Session override is process/run-scoped.** `--harness-workflow` sets
  `AgentConfig.harnessWorkflowOverride`; it is never persisted and does not survive resume. No
  versioned session record was added.
- **`/harness` and SDK fields deferred.** 3.6 asks for a non-TUI control first, and Phase 1 recorded
  no dedicated SDK/headless harness option until an enabled mode exists.
- **Default stamp unchanged.** A run with no selection keeps Phase 2's
  `{ id: 'baseline', source: 'baseline' }`, so existing evidence semantics are untouched.

### Files

```text
Add    src/harness/workflows.ts, workflows.test.ts
Add    src/harness/registry.ts, registry.test.ts
Add    src/harness/canonical-json.ts        (extracted from run-store.ts per the shared-utility rule)
Modify src/harness/contracts.ts             (WorkflowProvenance, WorkflowClampRecord, context policy fields)
Modify src/harness/coordinator.ts           (stamp decision/policy, emit capability_clamped, registry facade re-export)
Modify src/harness/run-store.ts             (workflow provenance metadata; workflowId no longer hardcoded)
Modify src/harness/redaction.ts             (allowlist clampedField/clampReason)
Modify src/agent/context.ts, context.test.ts (workflowPolicy override in the dynamic zone)
Modify src/agent/loop.ts                    (thread harnessContext.workflowPolicySection)
Modify src/session/agent-session.ts, agent-session.test.ts (select + provenance + fail closed)
Modify src/settings.ts, settings-repository.ts, settings-cli.test.ts
Modify src/config.ts, config.test.ts
Modify src/types/runtime.ts                 (harnessWorkflowOverride)
Modify src/index.ts, src/cli/run.ts         (--harness-workflow)
Modify README.md, CHANGELOG.md
```

The file plan did not list `run-store.ts` or `redaction.ts`. Both were required: `metadataProjection`
hardcoded `workflowId: 'baseline'`, and the attribute allowlist had no key for clamp facts. The
allowlist widening uses purpose-named keys (`clampedField`, `clampReason`) drawn from fixed enums
rather than generic `field`/`reason`, so it cannot become a raw key/value channel.

### Commands and results

| Command                                                          | Result                                        |
| ---------------------------------------------------------------- | --------------------------------------------- |
| `npm run check` (format, lint, types, architecture, unit, contract) | Pass — unit 207 files, 2,065 passed, 5 skipped; contract 6 files, 37 passed |
| `npm run test:integration`                                       | Pass — 7 files, 83 passed, 9 skipped          |
| `npm run build`                                                  | Pass                                          |
| `npx vitest run --config vitest.unit.config.ts src/harness`       | Pass — 14 files, 134 passed                   |
| `npx vitest run --config vitest.integration.config.ts src/settings-cli.test.ts` | Pass — 6 passed         |

The TUI startup timeouts recorded as host-sensitive in the Phase 2 ledger entry did not reproduce in
this run; the integration tier was fully green.

### Test matrix coverage

| Requirement                                              | Where                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| Unknown/prompt/code fields rejected                      | `workflows.test.ts` — top-level and per-sub-object strictness |
| Duplicate IDs / non-monotonic versions rejected          | `registry.test.ts`                                            |
| Minimal fallback always available                        | `registry.test.ts` — registry without `minimal` is rejected; `forceMinimal` rollback |
| Manual run/settings precedence deterministic             | `registry.test.ts`                                            |
| Kernel clamps recorded and explained                     | `workflows.test.ts`; `coordinator.test.ts` (`capability_clamped` evidence) |
| `minimal` matches the accepted baseline                  | `context.test.ts` — byte-identical provider messages          |
| Prompt section within budget                             | `workflows.test.ts` (worst-case definition); enforced at registry construction |
| Cannot enable tools or bypass permissions                | `workflows.test.ts` — schema rejection plus effective-surface assertions |
| Unsupported context/compaction/checkpoint/handoff clamped | `workflows.test.ts`                                          |
| Cannot change tool schemas, retry, provenance, defenses  | `workflows.test.ts` — retry clamp, trusted-kernel exclusions  |
| Candidate-path workflows never active                    | `registry.test.ts`, `config.test.ts`                          |
| Requested/effective mapping; guidance ≠ enforcement      | `workflows.test.ts` — every field has a disposition, none reports `enforced` |

Additional coverage beyond the matrix: description text is never interpolated into the prompt;
selection fails closed under `off`, on an unknown ID, and on a path-like ID at both `book config set`
and startup; the policy section renders in the dynamic zone only and leaves the cached prefix
byte-identical.

### Code-review remediation

A review pass after the first green gate found seven defects, all fixed and pinned by test:

| Defect                                                                                                        | Fix                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Selection ran after run accounting and the ambient snapshot, so a rejected workflow threw with no terminal event | Moved beside `assertHarnessModeAvailable`, before any run setup; tests assert no event is emitted |
| `book config set harness.workflow` validated one settings layer, where `harness.mode` defaults to `off` — so the documented flow failed whenever the mode lived in another scope | The repository now checks only the layer-local fact (workflow is known); the mode pairing is checked by `loadConfig` against merged layers |
| `assertSelectableWorkflow`'s default parameter built the registry eagerly on every `loadConfig`, so a malformed built-in would have broken every command even with the harness `off` | Registry lookup moved below the no-selection early-out; a test passes a throwing registry to prove it is never consulted |
| An empty `--harness-workflow ""` shadowed a persisted selection and silently ran baseline                     | Precedence uses trimmed truthiness; the CLI rejects an empty flag value                          |
| `forceMinimal` bypassed the enabled-mode gate                                                                 | The rollback lever asserts the same gate as any other selection                                  |
| A path-like ID surfaced a raw `ZodError`, and ID shape was reported ahead of a disabled harness                | New typed `HarnessWorkflowInvalidIdError`; mode is checked first                                 |
| `planMode` was missing from the two message-rebuild paths, so preflight compaction or clipping dropped plan-mode instructions mid-session | Restored in both bags; the overrides literal is now a single `SystemPromptOverrides` interface so the set cannot drift again |

Pre-existing defect fixed in passing: the `planMode` omission predates this phase but lives in lines
this change touched. Also consolidated on review: `WORKFLOW_ID_PATTERN` and `WorkflowOverrideScope`
are now declared once in `contracts.ts` instead of duplicated in `settings.ts`/`registry.ts`, the two
divergent `baseline` decisions collapsed into a single exported `BASELINE_WORKFLOW_DECISION`, and the
module-level `let sharedRegistry` was removed to honor the no-module-state convention.

### Known gaps and unknowns

- Project-local workflow files, `/harness` commands, and SDK selection fields are not implemented.
- No field is enforced outside the prompt, so `safe-edit` and `verify-heavy` differ from `minimal`
  only in bounded guidance. Whether that guidance changes outcomes is a Phase 5/6 question; Phase 3
  only establishes that the comparison is reproducible and honestly labelled.
- Evidence remains promotion-ineligible: directory sync is still reported `unavailable`, so every
  seal keeps `evidenceEligibility: ineligible`, exactly as in Phase 2.
- Tier C remains blocked. `verify-heavy`'s "run project verifiers" line is model guidance operating
  within existing permissions; no trusted verifier runner was added.
- **Delegated work does not inherit the workflow.** `subagent.ts` and `agents/manager.ts` thread
  `harnessObserver` but not `harnessContext`, so a Task subagent or managed child runs without the
  root's execution policy. This is consistent with the plan's rule that managed agents are a
  separate experimental axis and initial workflows do not select parallelism, but it means a
  `verify-heavy` root can delegate implementation to a child that never sees the verification
  guidance, and the run's `requestedExtraCalls` does not describe the delegated work. Propagation
  belongs to Phase 3A, which versions the delegation surface.
- **A degraded evidence stream silently reverts the run to baseline guidance.** If `prepareRun`
  times out or throws, there is no harness context, so the policy never reaches the prompt. That
  direction is intended — a workflow with no ledger must not change behavior — but the user is only
  told through the `onHarnessFinalized` degraded notice, now carrying an explicit
  `workflow_policy_not_applied` reason. There is no ledger record of the reversion, because there is
  no ledger.

### Anti-drift review

**Intent check — are workflows compact execution policies, or are they becoming large
model-specific profiles?** They remain compact execution policies. The schema is 13 enum/boolean
fields with no free-form content; the rendered section is capped at 1,024 characters and enforced at
registry construction; there are three definitions, none containing a model name, provider, path,
prompt, command, tool, or permission rule, and none branching on model identity. Nothing in the
surface claims enforcement it does not have.

**Did this phase introduce selection or learning?** No. Every selection is manual and explicit, and
`WorkflowDecisionSource` values `adaptive` and `candidate` remain unused.

**Did this phase weaken any trusted-kernel control?** No. The only widening is two purpose-named
redaction allowlist keys carrying values drawn from fixed enums. Permissions, sandbox, budgets,
retry, compaction, checkpoint/resume, tool contracts, and provenance rules are unchanged, and the
`unsupported-clamped` fields are provably clamped by test.

### Decision

Promote. Fixed workflows can now be selected, rendered, clamped, and recorded reproducibly without
any automatic selection or learning. Phase 4 remains blocked until Phase 3A verifies that the
prompt, skill, tool, context, model, verification, hook, and delegation surfaces are independently
versioned.

---

## Proposed amendments (2026-08-14)

Proposals only; the verification packet above stands unmodified. Evidence:
[External Evidence Review](external-evidence-2026-08.md).

### A13 — Give the schema at least one host-enforced field

The packet above records honestly that no field reports enforcement: every disposition is guidance,
clamped, or host-owned. Comparable runtimes demonstrate that a small enforceable subset does exist
without admitting arbitrary workflow authority — specifically **delegation depth** and a
**child-spawn cap**, carried as host-owned overrides that the workflow can request but cannot
observe or modify, with a required parent attribution on every child start and an accepted-spawn
count recorded as provenance.

Both are enforceable in Book today at the managed-agent and subagent boundaries, both narrow rather
than broaden authority, and both fit the existing requested/effective clamp representation. Adding
them would mean `execution` is no longer entirely advisory and the recorded `requestedExtraCalls`
would describe delegated work rather than omitting it.

This does not change the deferral of parallelism selection: a cap is a ceiling, never a request for
more concurrency.

### A17 — A workflow may never execute its own verification

`verify-heavy`'s "run declared project verifiers" line is currently inert model guidance operating
within existing permissions. When Tier C eventually admits verifier execution, that line becomes a
workflow whose stated purpose is to touch the grading surface. Record now, as a trusted-kernel
exclusion, that the arm being measured may never be the executor of its own measurement: verifier
execution stays with the evaluator boundary, after the worker tree has stopped, over an immutable
snapshot. The documented reward-hacking strategies — harness modification, hard-coded cases,
visible-test special-casing — are exactly what that separation prevents.

### Reframing, not a defect: what Phase 3 actually compares

The field's common taxonomy separates *workflows* (LLM and tools orchestrated through predefined
code paths) from *agents* (the model directs its own process), and enumerates prompt chaining,
routing, parallelization, orchestrator-workers, and evaluator-optimizer as the workflow patterns.

`minimal`, `safe-edit`, and `verify-heavy` are not points on that axis. They are three intensities of
prompt guidance within a single agent pattern. That was the deliberate Phase 3 choice and it remains
correct for this phase — but it changes how a null result must be read downstream. If Phase 6 finds
no difference among the three, that is evidence about **guidance intensity**, not about workflow
patterns, because all three arms share one pattern. State it that way rather than concluding that
workflow variation does not matter.

The corresponding open question — whether guidance intensity is detectable above the A/A noise floor
at all — is the go/no-go for Phases 4-7 and is specified as
[experiment E4](experiments.md#e4--guidance-detectability-pre-check-gono-go-for-phases-4-7). It
should be answered before that machinery is built, not after.

### Delegation gap: resolved by design, not by propagation

The "Known gaps" entry above records that `subagent.ts` and `agents/manager.ts` thread
`harnessObserver` but not `harnessContext`, so delegated work does not inherit the root's execution
policy, and lists propagation as Phase 3A work.

Three independently designed runtimes treat **non-inheritance as the correct default**: children get
a fresh scope and inherit no parent tools, services, or authority; capability requests are validated
at start and fail loudly rather than degrading silently; delegation depth is durable metadata that
bounds recursion. On that reading, the gap is not "propagation is missing" but "explicit typed
capability requests at the delegation boundary are missing," which is cheaper and safer than
threading root policy into children.

Phase 3A should adopt the explicit-request framing rather than implicit propagation, and record the
child's effective policy as its own provenance rather than as an inherited copy of the root's.
