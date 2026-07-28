# Phase 8: Add Bounded Workflow Evolution

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Not started
- **Depends on:** Phase 7 verified and rollback exercised
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---


**Objective:** Propose new workflow configurations without allowing arbitrary runtime self-modification.

The initial Phase 8 lane evolves workflow fields only. Prompt modules, skill definitions, tool
contracts, context policies, model adapters, hook policies, verifier definitions, and delegation
policies are different candidate classes and remain disabled until each has its own schema,
evaluation slices, query budget, promotion authority, and rollback artifact.

**Deliverables:**

- Generate candidate changes only inside the validated workflow schema.
- Ground every proposal in named failure evidence and a predicted effect.
- Preserve passing behaviors and previously rejected candidates in proposal context.
- Store candidates separately from promoted workflows.
- Evaluate each candidate on held-in and held-out tasks.
- Require no regression on immutable safety/evaluator tests.
- Add promotion records with evidence, policy version, reviewer, and rollback target.
- Require a declared complexity delta and a simpler-workflow tie/Pareto gate.

#### Phase 8 Work Breakdown

##### 8.1 Define the candidate lifecycle

Use explicit states:

```text
proposed
validated
held-in-tested
held-out-tested
approved-for-canary
promoted
rejected
rolled-back
```

State transitions are append-only audit events. A rejected candidate cannot be edited in place and retried under the same identity; create a new version with references to the prior failure.

##### 8.2 Define the bounded candidate schema

Candidates are workflow diffs, not arbitrary code:

```ts
interface WorkflowCandidate {
  schemaVersion: 1;
  candidateId: string;
  parentWorkflow: { id: string; version: number };
  proposedWorkflow: WorkflowDefinition;
  changedFields: string[];
  evidenceRefs: string[];
  targetFailurePatterns: string[];
  predictedBenefits: string[];
  regressionRisks: string[];
  complexityDelta: {
    renderedContextTokens: number;
    activeFields: number;
    extraTransitions: number;
    extraModelOrToolCalls: number;
    estimatedLatencyMs?: number;
  };
  proposer: {
    modelKey: string;
    promptVersion: string;
  };
}
```

Reject candidates that change too many independent dimensions at once. Prefer narrow, attributable changes.

Recompute `changedFields`, effective clamps, complexity, and the canonical candidate hash in trusted
code. Never accept proposer-supplied accounting as authoritative.

##### 8.3 Build failure-pattern inputs

Generate proposal inputs from normalized, verifier-grounded evidence:

- repeated failure signatures;
- task/model slices affected;
- successful behaviors that must be preserved;
- prior candidate attempts and outcomes;
- editable workflow fields;
- immutable restrictions;
- cost and regression constraints;
- complexity budget and behaviors that must remain unchanged.

Raw private transcripts should not be included unless explicitly eligible and redacted.

##### 8.4 Isolate the proposer

The proposer may be an LLM, but its output is untrusted data. It receives:

- read-only evidence summaries;
- current promoted workflow;
- candidate schema;
- bounded editable fields;
- failure and success evidence;
- previously rejected candidate summaries.

It does not receive write access to:

- active registry;
- evaluator definitions;
- held-out membership;
- permissions or sandbox settings;
- model/provider selection;
- budgets;
- historical event records.

Failure and success inputs are typed, bounded, provenance-carrying facts. Do not pass raw private
transcripts or free-text held-out summaries to the proposer; rejected-candidate feedback is a reusable
holdout query channel and needs a sealed final-test/query budget.

##### 8.5 Validate candidates statically

Before any model/task execution:

- validate schema and field allowlist;
- reject unknown fields and arbitrary prompt/code blobs;
- enforce change-count and value bounds;
- calculate complexity delta and reject candidates that exceed the declared complexity budget;
- resolve kernel clamps;
- calculate candidate hash;
- verify parent workflow exists and is still current;
- run safety/reward-hacking fixture checks.

##### 8.6 Evaluate in stages

Use the sequence:

```text
static validation
small held-in smoke set
full held-in comparison
held-out comparison
manual/automated promotion review
Phase 7 canary
```

Declare candidate-cycle limits, multiple-testing/alpha-spending policy, and a fresh or sealed final
holdout. Stop candidate generation when the query budget or evidence budget is exhausted; do not
continue until a favorable candidate appears.

Stop at the first failed gate. Do not spend the full evaluation budget on structurally invalid or clearly regressing candidates.

##### 8.7 Apply the simplicity and Pareto gate

Before promotion, compare the candidate against its parent and the best fixed workflow:

- a candidate must improve a predeclared primary outcome enough to justify any complexity increase;
- a candidate that adds complexity without measurable benefit is rejected;
- equivalent outcomes within the Phase 0 uncertainty/noise band select the simpler workflow;
- no candidate may trade away an immutable safety, evaluator, budget, or runtime-correctness guarantee;
- complexity measurements and the tie decision are recorded in the promotion report and HarnessCard.

##### 8.8 Add immutable promotion records

A promotion record must contain:

```text
candidate and parent hashes
evaluation matrix/report refs
held-in and held-out results
guardrail results
effective kernel clamps
approval identity or automated gate version
canary configuration
rollback target
complexity delta and simpler-workflow decision
timestamp and expiry/recalibration rule
```

Promotion copies or references the validated candidate into the active registry. The candidate store itself is never treated as executable configuration.

Promotion requires canonical signed records, an atomic registry update, a parent-version/TOCTOU check,
and an independently retained last-known-good rollback artifact. High-risk candidates require an
explicit approval authority. A reproducible `rejected` or `no promotion` result is valid completion.

##### 8.9 Build reward-hacking and evaluator-integrity fixtures

Include candidates that attempt to:

- skip required tests;
- redefine success as model confidence;
- increase token/turn/cost budgets;
- change model/provider;
- hide or truncate failures;
- ignore protected-file changes;
- alter held-out membership;
- weaken permissions or sandboxing;
- optimize only a narrow training task;
- treat unknown as success;
- hide added context, transitions, calls, or latency from complexity accounting.
- embed unrestricted system prompts, skill bodies, tool schemas, executable scripts, hook commands,
  verifier commands, model/provider changes, or subagent definitions inside a workflow candidate;
- relabel a capability-manifest change as a workflow-only change;

The pipeline must reject them before promotion.

##### 8.10 Define candidate-generation budgets

Limit:

- candidates per cycle;
- proposer calls;
- evaluation cost;
- simultaneous experiments;
- retries after rejection;
- maximum workflow complexity;
- maximum complexity delta relative to the parent workflow.

Candidate generation pauses when outcome evidence is weak, the active rollout is unstable, or the budget is exhausted.

##### 8.11 Define future capability-candidate lanes

Document but do not enable separate candidate schemas for:

```text
bounded prompt-module candidate
skill metadata/body candidate
tool description/error-contract candidate
context-policy candidate
model-adapter candidate
external-integration lifecycle candidate (no trust, permission, credential, or sandbox widening)
verification-policy candidate
delegation-policy candidate
```

Every lane needs its own immutable fields, prohibited fields, activation/evaluation corpus,
complexity measure, sealed holdout/query budget, signature, rollout registry, and last-known-good
artifact. A proposer can never emit arbitrary executable scripts, permissions, evaluator changes,
provider credentials, workspace-trust decisions, sandbox/network ceilings, or raw unrestricted system
prompts. Integration candidates may describe only already-approved protocol/lifecycle behavior and
must pass the same security and surface-parity gates as the fixed substrate.

Do not combine candidate lanes until each component has independently cleared Phase 6 and Phase 7
gates and a predeclared interaction experiment justifies the combination.

#### Phase 8 File Plan

```text
Add    src/harness/evaluation/candidate.ts
Add    src/harness/evaluation/candidate.test.ts
Add    src/harness/evaluation/proposer.ts
Add    src/harness/evaluation/proposer.test.ts
Add    src/harness/evaluation/promotion.ts
Add    src/harness/evaluation/promotion.test.ts
Add    src/harness/evaluation/reward-hacking.test.ts
Add    src/harness/candidate-store.ts
Add    src/harness/candidate-store.test.ts
Modify src/harness/registry.ts
Modify src/harness/rollout-registry.ts
```

#### Phase 8 Test Matrix

- Valid narrow candidate and invalid broad candidate.
- Candidate attempts every immutable-field violation.
- Parent workflow changes during evaluation invalidate stale promotion.
- Held-in gain with held-out regression is rejected.
- Candidate with equal outcomes and higher complexity is rejected.
- Complexity accounting cannot be hidden by naming or path tricks.
- Unknown/evaluator-failed results block promotion.
- Rejected candidate cannot become active through path or naming tricks.
- Promotion record is complete and immutable.
- Canary rollback restores the exact parent workflow.
- Candidate budget exhaustion pauses generation cleanly.
- Proposer failure cannot affect the active registry.

**Verification:**

- Candidate generation cannot edit runtime source, permissions, evaluator code, budgets, model choice, or historical evidence.
- Rejected candidates never affect live selection.
- Promotion is based on predeclared metrics and held-out evidence.
- Promotion requires a measured benefit that clears the noise floor or an explicit simpler-workflow decision.
- Reward-hacking fixtures catch attempts to skip tests, alter the judge, expand budget, or narrow the task improperly.
- The previous promoted workflow remains immediately restorable.

**Commands:**

```powershell
npm run typecheck
npm run test:unit -- src/harness/evaluation/candidate.test.ts
npm run test:unit -- src/harness/evaluation/promotion.test.ts
npm run test:unit -- src/permissions.test.ts
npm run test:unit -- src/sandbox.test.ts
npm test
npm run lint
npm run format:check
```

**Exit gate:** The pipeline reproducibly promotes only candidates that clear immutable gates and reproducibly rejects the rest. No promotion is a valid phase result when no candidate earns a benefit.

**Rollback:** Disable candidate generation and restore the prior registry version; no runtime code rollback should be necessary.

**Intent check:** Is the system improving workflow behavior, or attempting unrestricted self-editing?
