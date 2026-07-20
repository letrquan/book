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

Do not combine results across incompatible workflow, policy, model, runtime, environment, tool-surface, context-capability, sandbox, or evaluator versions.

##### 7.6 Implement automatic pause and rollback

Predeclare rollback triggers such as:

- primary success falls below control beyond tolerance;
- regression or permission incidents exceed zero/declared limit;
- cost exceeds ceiling;
- user correction/override rate rises materially;
- evaluator failure rate invalidates monitoring;
- model/provider, runtime, environment, tool-surface, context-capability, or sandbox changes without recalibration;
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

##### 7.7 Handle compatibility and project change invalidation

- Exact model version changes invalidate or downgrade eligibility.
- Tool-schema changes invalidate model evidence that depended on the old schema.
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
npm test -- src/harness/coordinator.test.ts
npm test -- src/harness/policy.test.ts
npm test -- src/headless.test.ts
npm test -- src/tui/app.plan-approval.test.tsx
npm test
```

**Exit gate:** Live adaptive selection improves or preserves the declared metrics and can automatically retreat to the best fixed workflow.

**Rollback:** Set harness mode to `shadow`, `observe`, or `off`; mark the workflow version inactive in the registry.

**Intent check:** Is live adaptation earning its complexity on real tasks?
