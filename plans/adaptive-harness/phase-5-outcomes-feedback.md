# Phase 5: Add Evidence-Based Outcomes and Explicit Feedback

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Not started
- **Depends on:** Phase 4 verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---


**Objective:** Determine whether a selected workflow helped without relying on model confidence.

**Deliverables:**

- Add outcome extraction for tests, typecheck, lint, tool errors, expected artifacts, interruptions, and regressions.
- Preserve `unknown` rather than inventing success when evidence is incomplete.
- Add an explicit user feedback command/surface with task, session, and project scope choices. Global scope remains deferred until Phase 9.
- Record user correction and follow-up work as weak evidence, not automatic proof of failure.
- Store correctness, reliability, alignment, regression, cost, and latency separately.
- Add outcome provenance so every score points to its evidence.
- Add versioned human-rubric outcomes with blind review and agreement rules where automatic verification is insufficient.
- Retain workflow complexity as an outcome/trade-off dimension instead of treating extra scaffolding as free.

#### Phase 5 Work Breakdown

##### 5.1 Separate evidence collection from outcome derivation

Use two layers:

```text
raw run events -> normalized evidence facts -> outcome dimensions
```

Raw events remain append-only. Normalized facts can be recomputed when evaluator logic changes.

Example facts:

```text
declared verifier command exited 0
declared verifier command timed out
three tool calls failed with the same cause
expected file exists
unexpected protected file changed
user explicitly rated result negative
run ended without completion evidence
```

##### 5.2 Add verifier declarations

Do not infer that every successful shell command is a test. Add project/evaluation configuration for named verifiers:

```ts
interface VerifierDefinition {
  id: string;
  kind: 'test' | 'typecheck' | 'lint' | 'build' | 'artifact' | 'custom';
  command?: string;
  required: boolean;
  timeoutMs?: number;
  successExitCodes?: number[];
  scope?: string[];
}
```

The trusted kernel owns verifier definitions during evaluation. A workflow may request a declared verifier, but cannot rewrite its command or required status.

##### 5.3 Implement normalized outcome dimensions

Use explicit statuses:

```ts
type DimensionStatus = 'pass' | 'fail' | 'unknown' | 'not-applicable';

interface OutcomeDimension {
  status: DimensionStatus;
  value?: number;
  evidenceRefs: string[];
  evaluatorVersion: string;
  notes?: string;
}
```

Store dimensions for correctness, reliability, regression, user alignment, maintainability, cost, latency, long-horizon stability, and harness complexity.

##### 5.4 Define run-level completion rules

A run may be:

```text
verified-success
verified-failure
partial
interrupted
unknown
```

The rules should be task-class specific. For example, a code edit with required tests cannot be `verified-success` when tests were not run. A read-only explanation may use a different verifier or remain unknown.

##### 5.5 Add versioned human-rubric evaluation

Define a separate rubric contract for subjective outcomes:

```ts
interface HumanRubricDefinition {
  id: string;
  version: string;
  dimensions: Array<{
    id: string;
    anchors: string[];
    required: boolean;
  }>;
  blindComparison: boolean;
  minimumReviewers: number;
  agreementRule: string;
}
```

Record reviewer identity or role, rubric version, per-dimension ratings, disagreement, and evidence references. Model-based graders may provide advisory signals, but they cannot be the sole authority for promotion. Unmet reviewer-count or agreement rules produce `unknown`, not success.

##### 5.6 Add explicit feedback UX

Provide an inspectable feedback flow, for example:

```text
/feedback good
/feedback bad
/feedback correction "Changed too many files"
/feedback prefer project "Ask before dependency changes"
```

The UI should show:

- what signal will be stored;
- its scope and expiration behavior;
- whether it is explicit preference or result feedback;
- how to inspect or delete it.

Do not ask for feedback after every run. Make it available and consider low-friction prompts only for selected evaluation/canary cases.

##### 5.7 Interpret implicit signals conservatively

Potential weak signals include:

- immediate corrective follow-up;
- user reverting an agent change;
- repeated permission denial;
- repeated request for a different response style.

Rules:

- never treat one weak signal as a durable preference;
- never infer safety permissions;
- distinguish dissatisfaction with the result from a changed task requirement;
- keep provenance and confidence;
- expire weak signals faster than explicit preferences.

##### 5.8 Add evaluator versioning and recomputation

Every derived outcome records the evaluator version. When logic changes:

- preserve old results;
- recompute into a new version;
- avoid comparing runs scored by incompatible evaluator versions unless normalized;
- record migrations in reports.

##### 5.9 Add outcome inspection

Provide a report that answers:

```text
What outcome was assigned?
Which evidence caused it?
What evidence was missing?
Which evaluator version was used?
Would this run be eligible for learning or replay?
```

#### Phase 5 File Plan

```text
Add    src/harness/outcomes.ts
Add    src/harness/outcomes.test.ts
Add    src/harness/verifiers.ts
Add    src/harness/verifiers.test.ts
Add    src/harness/feedback.ts
Add    src/harness/feedback.test.ts
Add    src/harness/human-rubrics.ts
Add    src/harness/human-rubrics.test.ts
Modify src/settings.ts
Modify src/commands/builtins.ts
Modify src/tui/app.tsx
Modify src/headless.ts or stream-json input for explicit feedback events
```

#### Phase 5 Test Matrix

- Required verifier pass, fail, timeout, missing, and malformed output.
- A successful unrelated shell command is not mistaken for a test pass.
- Protected-file mutation creates regression evidence.
- Positive model text cannot override failing evidence.
- Explicit negative feedback remains distinct from a project preference.
- Task/session/project scope precedence and expiration.
- Blind human-rubric comparison, reviewer disagreement, insufficient reviewers, and rubric-version changes.
- A model judge cannot independently convert an unknown human-rubric outcome into success.
- Equivalent outcome quality with higher harness complexity remains visible for tie-breaking.
- Recomputed outcome under a new evaluator version preserves prior results.
- Unknown outcome remains ineligible for automatic promotion.

**Verification:**

- Failed tests cannot be converted into success by a positive model summary.
- Missing tests remain unknown unless another declared verifier exists.
- A one-off user preference does not become global automatically.
- Outcome recomputation from the same event ledger is deterministic.
- Evaluator failures are visible and block learning for the affected run.
- Subjective outcomes are attributable and become `unknown` when rubric reliability requirements are not met.

**Commands:**

```powershell
npm run typecheck
npm test -- src/harness/outcomes.test.ts
npm test -- src/harness/user-signals.test.ts
npm test -- src/tools/shell.test.ts
npm test -- src/headless.test.ts
npm test
```

**Exit gate:** Each comparable run has trustworthy, attributable dimensions or an explicit unknown status.

**Rollback:** Stop producing adaptive scores; retain raw evidence for later recomputation.

**Intent check:** Are outcomes grounded in what the user/project needed, or only what is easy to count?
