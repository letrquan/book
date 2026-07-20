# Phase 6: Run Shadow Adaptation Against Held-Out Tasks

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Not started
- **Depends on:** Phase 5 verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---


**Objective:** Test whether adaptive selection improves outcomes before it controls live execution.

**Deliverables:**

- Add offline replay for deterministic fixtures and eligible historical runs.
- Split evaluation into held-in diagnosis tasks and held-out promotion tasks.
- Run the selector in shadow mode while the live run continues with its existing workflow.
- Compare base, best fixed, and adaptive decisions by model/task slice.
- Add confidence intervals or minimum-sample rules appropriate to the corpus size.
- Estimate infrastructure noise with repeated/paired controls and reject effects that do not clear the declared noise floor.
- Run optional external benchmark adapters as portability checks while keeping local held-out gates authoritative.
- Produce a versioned HarnessCard for every evaluated policy/workflow combination.
- Produce a report that includes negative, neutral, and positive results.

#### Phase 6 Work Breakdown

##### 6.1 Define replay eligibility

Not every historical run is replayable. A run is eligible only when Book can reconstruct:

- repository/fixture revision;
- model/provider/version and relevant settings;
- runtime, environment, sandbox, context-capability, and tool-surface fingerprints;
- tool definitions and permissions;
- workflow and policy version;
- evaluator version;
- budget limits;
- required external dependencies or data.

Initial replay should use deterministic fixture repositories from Phase 0. Historical user runs may be used for diagnosis without replay when their environment cannot be reconstructed.

##### 6.2 Build isolated fixture execution

Run each evaluation arm in a fresh isolated copy of the fixture. The runner should:

```text
materialize fixture revision
apply identical setup
record initial hashes
record runtime/environment/sandbox/context/tool-surface fingerprints
run one arm within declared budgets
run immutable verifiers
capture final diff and artifacts
destroy or archive the isolated workspace according to policy
```

Do not reuse a mutated workspace across comparison arms.

##### 6.3 Freeze the evaluation matrix

Create a matrix manifest:

```ts
interface EvaluationMatrixEntry {
  caseId: string;
  arm: 'base' | 'fixed' | 'adaptive-shadow' | 'candidate';
  modelKey: string;
  workflowId?: string;
  repetitions: number;
  seed?: string;
  budgetProfile: string;
  runtimeFingerprint: string;
  environmentFingerprint: string;
  sandboxFingerprint: string;
  toolSurfaceFingerprint: string;
  contextCapabilitiesVersion: string;
  evaluatorVersion: string;
}
```

The runner must reject invalid comparisons where critical fields differ.

##### 6.4 Implement held-in and held-out separation

- Held-in cases may be inspected for failure analysis and policy development.
- Held-out cases expose only execution results to promotion logic.
- Store held-out membership outside candidate-editable files.
- Version every split.
- Rotate or add fresh held-out cases when repeated use risks contamination.

##### 6.5 Add shadow selection to live runs

In shadow mode:

- the current fixed/manual workflow controls execution;
- the selector records what it would have chosen;
- no prompt, tool, permission, or runtime behavior changes;
- the report compares the shadow recommendation with the observed outcome when attribution is valid.

Shadow data alone cannot establish counterfactual improvement. It is useful for coverage and decision sanity; fixture replay is required to compare outcomes under different workflows.

##### 6.6 Implement scoring and uncertainty

Report:

- raw successes/failures/unknowns;
- per-dimension means or rates;
- cost and latency distributions;
- sample counts;
- confidence intervals or bootstrap intervals where appropriate;
- paired-control variance and the predeclared infrastructure noise floor;
- effect size against both base and best fixed workflow.

Avoid complex statistics with tiny samples. When evidence is insufficient or the measured effect falls inside the noise band, report "insufficient evidence" instead of a directional claim. When outcomes are equivalent within the declared uncertainty, prefer the simpler workflow.

##### 6.7 Add external benchmark adapters

Support optional adapters for a small coding benchmark and a long-horizon terminal benchmark. Each adapter must:

- lock the benchmark revision, evaluator, environment, tool surface, model settings, and budgets;
- preserve benchmark-native scoring and report invalid runs separately;
- keep benchmark tasks out of candidate prompts and local held-out tuning;
- report results as portability evidence, not as a replacement for Book's local held-out corpus.

##### 6.8 Create human-readable and machine-readable reports

Generate:

```text
report.json       complete structured results
report.md         concise review document
failures/         references to diagnostic evidence
manifest.lock     exact cases, models, workflows, evaluators, budgets
harness-card.md   compatibility identity, constraints, results, limits, rollback
```

Reports must prominently list:

- invalid comparisons;
- evaluator failures;
- held-out results;
- strong-model regressions;
- slices where minimal won;
- cost/latency trade-offs;
- harness complexity and the simpler-workflow tie decision;
- infrastructure noise and compatibility mismatches;
- human-rubric disagreement and external benchmark results, when applicable;
- recommendation: enable, hold, reject, or gather more data.

##### 6.9 Define the Phase 6 promotion decision

The phase does not promote a workflow. It decides which slices are eligible for Phase 7 live canaries.

A slice eligibility record should include:

```text
model key or compatible evidence rule
task class
project-risk class
selected policy/workflow version
evaluation report reference
primary benefit
guardrail status
expiry/recalibration rule
```

#### Phase 6 File Plan

```text
Add    src/harness/evaluation/replay.ts
Add    src/harness/evaluation/replay.test.ts
Add    src/harness/evaluation/scoring.ts
Add    src/harness/evaluation/scoring.test.ts
Add    src/harness/evaluation/report.ts
Add    src/harness/evaluation/report.test.ts
Add    src/harness/evaluation/matrix.ts
Add    src/harness/evaluation/matrix.test.ts
Add    src/harness/evaluation/adapters.ts
Add    src/harness/evaluation/adapters.test.ts
Add    src/harness/evaluation/harness-card.ts
Add    src/harness/evaluation/harness-card.test.ts
Add    scripts/harness-eval.ts or an equivalent CLI subcommand
Modify src/harness/coordinator.ts for shadow decisions only
```

#### Phase 6 Test Matrix

- Fresh isolated workspace per arm.
- Fixture reset/hash verification.
- Comparison rejection when model, budget, runtime, environment, context capability, tool surface, or evaluator differs.
- Repeated/paired controls estimate a noise floor and block unsupported small-effect claims.
- Held-out membership cannot be read by candidate generation.
- Shadow mode produces no provider-message or runtime differences.
- Unknown and evaluator-failed runs are excluded from unsupported claims.
- Report includes minimal-winning and strong-model-regression slices.
- External benchmark adapters remain separate from local promotion gates.
- HarnessCard content matches the locked matrix and rollback target.
- Cancellation cleans up or clearly marks incomplete evaluation workspaces.
- Re-running the same locked matrix produces structurally comparable reports.

**Verification:**

- Held-out tasks are not available to candidate generation or threshold tuning.
- Replay uses the same model, runtime, environment, context capabilities, tool surface, budget, and evaluator for compared arms.
- Strong-model regressions are reported separately and cannot be hidden by weaker-model gains.
- The selector is allowed to lose and remain disabled for a slice.
- Replayed private sessions require explicit eligibility and do not leak content into reports.
- Effects smaller than measured control variance are reported as insufficient evidence, and ties select the simpler workflow.

**Commands:**

```powershell
npm run typecheck
npm test -- src/harness/evaluation/replay.test.ts
npm test -- src/harness/evaluation/scoring.test.ts
npm test
npm run lint
npm run format:check
```

**Exit gate:** Adaptive selection demonstrates a predeclared benefit over the best fixed workflow on at least one held-out slice and no unacceptable regression on enabled slices.

**Rollback:** Keep the selector in shadow mode and ship no adaptive execution.

**Intent check:** Did adaptation beat a serious baseline, or only an intentionally weak workflow?
