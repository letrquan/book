# Phase 9: Long-Term Learning and Cross-Context Transfer (Future Gate)

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Future gate
- **Depends on:** Phases 0-8 proven in real usage
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---


**Objective:** Consider broader transfer only after project-scoped adaptation is proven.

This phase is intentionally not committed for the first implementation cycle.

Potential work:

- weak-prior transfer between related model versions;
- opt-in global user preferences with inspection/deletion controls;
- change-point detection for user modes;
- confidence decay and evidence expiration;
- background evaluation workers;
- cross-project workflow priors using privacy-preserving aggregates;
- multi-agent coordination only after single-agent adaptation is proven;
- code-level harness evolution only after bounded configuration search is demonstrably insufficient.

#### Phase 9 Research Tracks

Treat each item below as a separate future proposal with its own Phase 0-style evaluation contract.

Every proposal must quantify its entry evidence: minimum compatible runs, observation duration,
detectable effect, maximum acceptable harm, schema/evaluator stability, and rollback exercise. "Enough
real usage" is not an executable gate.

##### 9.1 Cross-model priors

- Transfer only aggregate workflow evidence, never trust state.
- Key similarity by provider protocol, tool schema, context behavior, and observed capability rather than name similarity alone.
- Start every new exact model key at low confidence.
- Compare cold-start minimal, transferred prior, and recalibrated policy.
- Automatically discard priors that slow calibration or cause regressions.

##### 9.2 Global user preferences

- Opt-in only.
- Store explicit and inferred signals separately.
- Provide list, inspect, edit, export, delete, and reset controls.
- Support project overrides and current-task precedence.
- Never globalize permissions or safety-sensitive behavior through inference.
- Test contradictory project modes and one-off behavior changes.

Global inference requires explicit consent, encryption/access controls, TTL, export/delete propagation
through indexes and backups, and a rule that deletion also removes derived training/aggregate inputs
where technically promised.

##### 9.3 User-mode change detection

- Model user behavior as multiple contextual modes, not one identity profile.
- Detect change points from repeated evidence, not one event.
- Lower confidence before creating a new mode.
- Make the active mode inspectable and overridable.
- Evaluate whether mode detection reduces correction without increasing unwanted assumptions.

Specify the change-point model, hazard/prior, false-alarm target, cooldown/hysteresis, and safety
features excluded from inference.

##### 9.4 Background evaluation workers

- Extract only after in-process contracts and schemas are stable.
- Use signed/validated work requests and immutable evaluation manifests.
- Separate worker credentials and permissions from live-agent credentials.
- Make jobs resumable, cancellable, budgeted, and auditable.
- Keep promotion authority outside the worker.

##### 9.5 Cross-project priors

- Use privacy-preserving aggregates rather than raw project evidence.
- Require compatible task/project features.
- Prevent one project's conventions from becoming another project's instructions.
- Provide project-level opt-out and deletion.
- Demonstrate benefit over project-local cold start.

"Privacy-preserving aggregates" requires a threat model and formal mechanism: for example differential
privacy parameters/composition, minimum cohort size, membership-inference testing, consent, and
deletion semantics. Aggregation alone is not a privacy guarantee.

##### 9.6 Multi-agent coordination

This track remains out of the initial delivery. Entry requires evidence that a single-agent workflow cannot meet the target outcome efficiently and that coordination has a falsifiable benefit claim.

Book already contains user-controlled Task and managed-agent capabilities. This research track means
harness-coordinated adaptive multi-agent policy and transfer, not the mere existence of child agents.

If explored:

- define ownership for shared state, decisions, files, worktrees, and final verification;
- prevent concurrent agents from silently overwriting or duplicating work;
- account for parent/child token, cost, tool, permission, and latency budgets end to end;
- keep permission and promotion authority in the trusted coordinator rather than delegating it to peers;
- measure coordination failures, duplicated work, contention, handoff loss, and aggregate outcome attribution;
- compare against the best single-agent workflow and prefer it when outcomes are equivalent;
- require deterministic cancellation, rollback, and cleanup of partial child work.

##### 9.7 Code-level harness evolution

This remains the final and highest-risk option. Entry requires evidence that bounded workflow/configuration evolution has reached a measurable ceiling.

If explored:

- use an isolated harness plugin/API surface, not direct edits to the trusted runtime;
- require static analysis, unit tests, integration tests, held-out evaluation, and manual approval;
- prevent access to evaluator, permissions, registry, budgets, and history;
- deploy only through the same canary and rollback system;
- maintain a last-known-good binary/configuration independent of the evolved code.

Require a versioned plugin/API boundary, signed and reproducible build provenance, ABI compatibility,
isolated deployment, independent promotion authority, and an out-of-band kill switch before code-level
evolution can enter a canary.

#### Phase 9 Entry Checklist

- Project-scoped adaptation shows durable benefit.
- Evaluation schemas and outcome definitions are stable.
- Privacy, inspection, deletion, and reset controls exist.
- Rollback has been exercised successfully in practice.
- Strong-model minimal fallback remains healthy.
- Single-agent adaptation remains the default and any multi-agent proposal has a serious single-agent baseline.
- The new research track has a serious baseline and falsifiable benefit claim.

**Entry gate:** Phases 0-8 have operated safely over enough real usage to establish stable schemas, reliable evaluators, and a measurable benefit.

**Intent check:** Are we transferring durable evidence, or spreading local overfitting?
