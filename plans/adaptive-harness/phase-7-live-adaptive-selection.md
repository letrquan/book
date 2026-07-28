# Phase 7: Enable Scoped Adaptive Selection

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Not started
- **Depends on:** Phase 6 verified for the target slice
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---


**Objective:** Let verified policy decisions control a small, bounded set of live runs.

**Deliverables:**

- Enable adaptive selection only for verified model/task/project slices.
- Use deterministic canary assignment with a configurable percentage.
- Freeze the selected workflow version for each run.
- Freeze the complete selected capability manifest for each run so prompt, skill, tool, context,
  model-adapter, verifier, hook, and delegation behavior cannot drift underneath the workflow.
- Add a user-visible explanation and a one-command override to `minimal` or a fixed workflow.
- Monitor primary and guardrail metrics against the non-adaptive control group.
- Automatically disable a slice when rollback thresholds are crossed.
- Monitor compatibility drift and live control variance so environment noise is not mistaken for rollout benefit.

#### Phase 7 Work Breakdown

##### 7.1 Create the eligibility and rollout registry

Add a trusted registry entry for each live-eligible slice:

```ts
interface RolloutEligibility {
  id: string;
  modelRule: string;
  taskClass: string;
  projectRisk: string;
  policyVersion: string;
  workflowRegistryVersion: string;
  capabilityManifestDigest: string;
  canaryPercent: number;
  reportRef: string;
  expiresAt?: number;
  status: 'shadow' | 'canary' | 'active' | 'paused' | 'rolled-back';
}
```

The learner cannot edit this registry directly.

##### 7.2 Implement deterministic assignment

Assign eligible runs using a stable hash of non-sensitive identifiers such as project identity, task class, model key, and rollout ID.

Requirements:

- the same eligible context remains in the same arm during a rollout;
- assignment does not depend on outcome data;
- users can opt out or force `minimal`;
- project-local canaries do not silently become global rollouts;
- assignment is recorded before execution.

Define the randomization unit, a secret rotation/assignment salt, session/project spillover rules,
explicit opt-out, and sample-ratio-mismatch checks. Project-only assignment can cluster every task
from a project into one arm and hide contamination.

##### 7.3 Resolve the final workflow

Final precedence:

```text
trusted safety/kernel constraints
explicit current run override
explicit session/project fixed workflow
eligible canary/adaptive decision
default fixed workflow
minimal fallback
```

Produce a `ResolvedWorkflow` with all clamps and provenance before calling the agent loop.

Also resolve a `CapabilityManifest` from promoted, trusted component IDs. The rollout registry cannot
embed arbitrary prompt text, skill bodies, tool schemas, context retrieval code, model adapter text,
hook commands, verifier commands, or subagent definitions.

Freeze the decision at the root-run boundary. In the initial release, an interactive override applies
to the next run unless a separate thread-safe transition channel is implemented.

##### 7.4 Add user-facing inspection and override

Expose:

```text
/harness status
/harness explain
/harness workflow minimal
/harness workflow <fixed-id>
/harness pause
```

The UI should state:

- selected workflow and version;
- capability bundle version and changed components;
- why it was selected;
- whether the run is control/canary/active;
- what evidence scope was used;
- how to override or disable it.

Avoid showing a long internal profile dump.

##### 7.5 Monitor live outcomes against control

For each rollout, track:

- eligible and assigned counts;
- completion and unknown rates;
- primary outcome difference;
- guardrail metrics;
- user overrides and corrections;
- cost and latency;
- model/version changes;
- runtime, environment, tool-surface, context-capability, and sandbox changes;
- evaluator failures.
- prompt-layer, skill, tool-contract, context-policy, model-adapter, hook-policy, verifier, or
  delegation changes.

Do not combine results across incompatible workflow, policy, model, runtime, environment, tool-surface, context-capability, sandbox, or evaluator versions.

Declare numerical primary/guardrail margins, minimum concurrent control allocation, delayed-label and
censoring policy, and a sequential-monitoring method (confidence sequence or alpha spending) before
live peeking. A fixed-horizon confidence interval is not a rollback policy for continuously monitored
canaries.

##### 7.6 Implement automatic pause and rollback

Predeclare rollback triggers such as:

- primary success falls below control beyond tolerance;
- regression or permission incidents exceed zero/declared limit;
- cost exceeds ceiling;
- user correction/override rate rises materially;
- evaluator failure rate invalidates monitoring;
- model/provider, runtime, environment, tool-surface, context-capability, or sandbox changes without recalibration;
- any capability-manifest component changes without recalibration;
- live control variance exceeds the declared noise threshold.

Rollback should:

```text
mark rollout paused or rolled-back
stop new adaptive assignments
route future runs to fixed/minimal
preserve all evidence
record reason and responsible threshold
retain previous registry version
```

Registry updates must be authenticated, canonicalized, atomically published, and fail closed to the
last known fixed workflow when unavailable. Existing runs retain their recorded decision; future runs
must stop adaptive assignment immediately after a rollback signal.

##### 7.7 Handle compatibility and project change invalidation

- Exact model version changes invalidate or downgrade eligibility.
- Tool-schema changes invalidate model evidence that depended on the old schema.
- Prompt-layer, skill registry/body, tool-contract, context-policy, model-adapter, hook, verifier, or
  delegation changes invalidate capability evidence that depended on the old component.
- Runtime, sandbox, environment, or context-capability changes invalidate incompatible eligibility.
- Major project fingerprint changes may expire project-risk eligibility.
- Evaluator changes pause comparisons until results are normalized or rerun.

##### 7.8 Define promotion from canary to active

Promotion requires:

- minimum live sample rule;
- no guardrail breach;
- benefit versus concurrent control;
- no unresolved evaluator issue;
- anti-drift review;
- recorded approval authority.

Even after promotion, `minimal` remains available and automatic rollback remains armed.

High-risk promotion requires a separately recorded approval authority or gate version. A valid result
of this phase is `hold` or `reject`; "preserves metrics" is not sufficient when complexity is higher
without a declared Pareto benefit.

#### Phase 7 File Plan

```text
Add    src/harness/rollout-registry.ts
Add    src/harness/rollout-registry.test.ts
Add    src/harness/assignment.ts
Add    src/harness/assignment.test.ts
Add    src/harness/monitor.ts
Add    src/harness/monitor.test.ts
Modify src/harness/coordinator.ts
Modify src/commands/builtins.ts
Modify src/tui/app.tsx
Modify src/headless.ts
Modify src/settings.ts for kill switches and canary controls
```

#### Phase 7 Test Matrix

- Stable deterministic assignment and explicit opt-out.
- Override precedence for run, session, and project scopes.
- Canary workflow is frozen once execution begins.
- Rollback threshold pauses new assignments immediately.
- Existing runs retain their recorded workflow after rollback.
- Existing runs retain the exact resolved capability-manifest and integration/trust decisions; a
  rollback never silently replays them under a different bundle.
- Model change invalidates eligibility.
- Runtime/environment/tool/context compatibility drift invalidates eligibility.
- Excessive live control variance pauses the rollout instead of producing a directional claim.
- Project fingerprint/evaluator change follows declared invalidation rules.
- Control and canary metrics remain separated.
- UI explanation matches the actual resolved workflow and clamps.
- `off`, `observe`, and manual fixed modes remain operational escape hatches.

**Verification:**

- Canary and control assignment is stable and auditable.
- A user can inspect and override the selected workflow before or during supported transitions.
- Rollback does not require deleting evidence or restarting the project.
- Compatibility changes trigger recalibration rather than silently reusing a trusted decision.
- Metrics remain segmented by model, task, project risk, and workflow version.

**Commands:**

```powershell
npm run typecheck
npm run test:unit -- src/harness/coordinator.test.ts
npm run test:unit -- src/harness/policy.test.ts
npm run test:unit -- src/headless.test.ts
npm run test:unit -- src/tui/app.plan-approval.test.tsx
npm test
```

**Exit gate:** Live adaptive selection clears the predeclared benefit and non-inferiority margins versus concurrent control, justifies its complexity, and can automatically retreat to the best fixed workflow. Otherwise hold or roll back the slice.

**Rollback:** Set harness mode to `shadow`, `observe`, or `off`; mark the workflow and associated
capability-bundle version inactive in the registry; route future runs to the recorded last-known-good
fixed bundle. Preserve the exact manifest for in-flight runs and diagnostics.

**Intent check:** Is live adaptation earning its complexity on real tasks?
