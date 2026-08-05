# Plan: Adaptive Harness With Verified Self-Improvement

- **Date:** 2026-07-20
- **Status:** Tier A/B verified for trusted built-in evaluation; Tier C blocked; Phase 0 ready but
  inactive; phases 1-8 inactive; phase 9 is a future gate
- **Scope:** Agent-runtime integration, prompt and capability layers, context and tool-surface contracts, skills, workflow selection, run evidence, evaluation, and safe workflow evolution
- **Goal:** Improve Book's task outcomes over time by selecting and evolving workflows for the current model, project, user context, and task without degrading models that perform best with minimal scaffolding.

**Research review:** [Adaptive Harness Research Grounding](adaptive-harness/research-grounding.md)
is a required input to Phase 0. Its preconditions and unresolved questions must be closed in
the relevant verification packet rather than treated as optional follow-up work.

**Capability review:** [Agent Capability Research and Gap Analysis](adaptive-harness/agent-capability-research.md),
[Phase 3A](adaptive-harness/phase-3a-agent-capability-substrate.md), and
[Phase 3B](adaptive-harness/phase-3b-capability-routing.md) define the prompt, skill, tool,
context, model, verification, delegation, hook, external-integration, trust, and user-interaction
surface that must be explicit before automatic selection can use capability evidence.

---

## Roadmap at a Glance

| Phase | Purpose                                 | Behavior level                | Required proof before advancing                                                                            |
| ----- | --------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 0     | Freeze evaluation contract and fixtures | Documentation/evaluation only | Metrics can distinguish improvement from activity                                                          |
| 1     | Add contracts and disabled boundary     | Off/inert                     | Existing runtime remains behaviorally identical                                                            |
| 2     | Add append-only evidence                | Observe only                  | Runs are explainable with acceptable overhead                                                              |
| 3     | Add validated fixed workflows           | Manual/fixed                  | Workflows are reproducible and kernel-bounded                                                              |
| 3A    | Add agent-capability substrate          | Manual/fixed                  | Prompt, skill, tool, context, model, integration, trust, and handoff surfaces are versioned and comparable |
| 3B    | Make capability routing reliable        | Manual/fixed                  | Common web/delegation tools route correctly, child allowlists are usable, and explorer routing is bounded  |
| 4     | Add deterministic selector              | Explain/dry-run               | Decisions are scoped, deterministic, and reversible                                                        |
| 5     | Add outcomes and feedback               | Fixed/manual comparison       | Outcomes are externally grounded or explicitly unknown                                                     |
| 6     | Evaluate adaptation                     | Shadow/offline                | Adaptive choice beats serious baselines on held-out slices                                                 |
| 7     | Enable adaptive canaries                | Scoped live selection         | Concurrent live evidence confirms benefit and no guardrail breach                                          |
| 8     | Evolve bounded workflows                | Candidate pipeline            | Candidate promotion is reproducible, immutable, and reversible                                             |
| 9     | Consider broader transfer               | Future research gate          | Project-scoped adaptation is already proven and stable                                                     |

Recommended reading order:

1. Original Intent and Non-Negotiable Product Invariants.
2. Definition of Improvement and Stop Conditions.
3. Architecture Boundaries.
4. The current implementation phase only.
5. Implementation Tracking Ledger and the phase verification packet.

Do not treat later-phase detail as authorization to implement it early. The exit gates define the allowed sequence.

## Pre-Phase-0 Runtime Preconditions

The repository audit found runtime issues that would invalidate attribution if evaluation started
immediately. Resolve or explicitly block on these before collecting promotion evidence. The gates
are tiered: **Tier A** blocks any attributable corpus data, **Tier B** blocks Phase 0 verification
execution, and **Tier C** blocks adversarial or project-controlled fixtures. This keeps safe,
built-in evaluation work possible without pretending that a copied fixture directory is a sandbox.

### Tier A: attribution and accounting

- preserve failed, aborted, cancelled, timed-out, interrupted, and completed terminal states through
  `AgentSession` without later reducer events overwriting them;
- define one harness run per root user request, including resume and child-run linkage;
- enforce cumulative root-and-child usage, cost, and budget accounting with a versioned pricing source;
- capture the effective provider/model identity or record it as unverifiable;
- freeze or version ambient prompt/config/tool inputs and isolate Book home state for every arm;
- record and normally force `agents.mode = off` in the initial single-agent corpus. The inert
  `harness.mode` setting is introduced by Phase 1 after Phase 0; Phase 0 must not depend on a
  setting that does not yet exist;
- freeze or version prompt layers, skill registry and activation policy, tool contracts, context
  policy, model capability adapter, hook policy, and subagent/delegation settings;

### Tier B: evaluator and architecture boundary

- add a disposable evaluation runner with a fresh session/tool-discovery state, sanitized
  environment, and an external process/container boundary;
- extend architecture checks to enforce the harness/runtime/evaluator/proposer dependency rules.

### Tier C: trusted execution boundary

- establish a workspace-trust boundary before project hooks, provider endpoints, MCP servers,
  executable slash-command expansions, privileged skills, or subagent definitions can execute;
- enforce a permission ceiling across user, project, workflow, skill, hook, MCP, and subagent scopes;
  lower-trust configuration may narrow capabilities but cannot broaden them;
- route project-controlled command execution through the normal tool, permission, sandbox, hook,
  cancellation, and audit path instead of hidden host-side execution;
- bind provider credentials to approved origins, validate provider endpoints, bound MCP startup, and
  prevent untrusted project configuration from receiving credentials or first-request context;
- make sandbox availability and network restrictions truthful and fail closed for evaluation;
  harden web/MCP access against private-address requests and unbounded response reads;
- use a disposable process/container boundary for adversarial fixtures, especially on Windows;

These are runtime correctness prerequisites, not permission to introduce selection or learning early.

### Precondition disposition (2026-08-05)

- **Tier A is verified for controlled, trusted built-in single-agent evaluation.** Run eligibility
  fails closed unless there is one completed root run, no child execution, complete ambient and
  accounting evidence, isolated captured Book-home state, recorded usage, known pricing, and
  verified provider/model identity. Provider retries, cancellation, missing usage, unknown pricing,
  or unverifiable response identity make the trial ineligible. Paired comparison eligibility also
  rejects mismatched ambient fingerprints, pricing versions, budgets, or resolved model identities.
- **Tier B is verified for the current built-in evaluator entry points.** Edit, compaction, and
  offline skill-observation evaluation run in disposable external processes with runner-owned date,
  seed, runtime revision, materialized-fixture revision, sanitized environment, bounded output, and
  bounded process-tree teardown. Reports retain those controls for review.
- **Tier C remains blocked.** The runner is not a Windows security sandbox. Project-controlled
  setup, reset, cleanup, verifier code, hooks, provider endpoints, MCP servers, executable commands,
  skills, subagents, network access, or credential flows are ineligible until the Tier C trust,
  permission-ceiling, origin, sandbox, and container controls are verified.
- **Phase 0 is eligible to begin only in the trusted built-in/non-adversarial scope.** This does not
  activate Phase 0 in this change; the Phase 0 status remains `Not started` until a dedicated change
  updates its phase file and ledger together.

## Original Intent

Book should not search for one universal workflow. It should learn when a workflow helps a specific combination of:

- model and model version;
- project state and constraints;
- current user intent and project-scoped preferences;
- task type, risk, and execution horizon.

The harness is successful only when it produces better real outcomes than the best simpler alternative. More prompts, profiles, agents, rules, or workflow steps are not improvements by themselves.

The intended behavior is:

```text
current task + current user intent + project evidence + model evidence
                              |
                              v
                    choose the lightest workflow
                              |
                              v
                   execute through the trusted runtime
                              |
                              v
                  measure externally visible outcomes
                              |
                              v
            retain, revise, reject, or roll back the workflow
```

The harness must be able to conclude that the base/minimal workflow is already best. Abstaining from adaptation is a valid and important result.

## Non-Negotiable Product Invariants

Every phase and pull request must preserve these invariants:

1. **Outcome over complexity.** A change is not an improvement unless measured outcomes improve against a baseline.
2. **Conditional, not universal.** Workflow decisions are scoped to model, project, task, and current user intent.
3. **Current intent wins.** Explicit instructions for the current task override historical user evidence.
4. **Minimal by default.** Unknown models, missing evidence, or low-confidence decisions fall back to the minimal workflow.
5. **Strong models may receive less harness.** The system must be able to remove scaffolding, not only add it.
6. **External evidence decides success.** Tests, verifiers, user feedback, regressions, cost, and latency outrank model self-assessment.
7. **Learning is reversible.** Workflow selection, learned evidence, candidates, and promotions are versioned and can be disabled or rolled back.
8. **The trusted kernel does not self-modify.** Permissions, sandboxing, secrets, budgets, audit history, evaluator rules, and promotion gates stay outside the editable surface.
9. **No silent durable profiling.** Inferred user behavior remains scoped, confidence-weighted, inspectable, and expiring unless explicitly confirmed.
10. **No forced adaptation.** If adaptive selection does not beat the best fixed workflow on held-out tasks, it does not ship for that slice.
11. **Fixed runtime primitives stay fixed.** Retry correctness, cancellation, resumability, tool semantics, tracing integrity, sandboxing, and prompt-injection defenses are runtime responsibilities; adaptive workflows may select among them but may not repair or weaken them.
12. **Simpler wins ties.** When workflows have equivalent verified outcomes, prefer the one with lower context, tool, latency, transition, and maintenance cost.
13. **Untrusted inputs stay attributable.** Repository, tool, web, user, and derived evidence retain provenance and cannot silently become trusted policy.

## Anti-Drift Review

Before marking any phase verified, answer all of these questions in its verification record:

- Does this phase directly improve measurement, selection, verification, or a demonstrated outcome?
- Can Book still use the minimal workflow without hidden adaptive behavior?
- Does explicit current user intent override learned behavior?
- Is the decision scoped instead of applied universally?
- Can the change be inspected, disabled, and rolled back?
- Is success evaluated by evidence outside the proposing model?
- Are permissions, evaluator integrity, budgets, and history protected from the adaptive layer?
- Does the design avoid adding a manually maintained profile for each model?
- Were environment noise, tool-surface drift, and evaluator version changes controlled?
- Are context/resume behavior and untrusted-input handling tested rather than inferred?
- If outcomes are tied, does the simpler workflow win?

If any answer is "no," the phase is not complete even if its tests pass.

---

## Definition of Improvement

The harness does not promise that every model improves on every metric. It should maximize expected utility for the current context and avoid regressions where adaptation adds no value.

### Comparison Arms

Every evaluation must distinguish at least:

```text
A. Base runtime with no harness behavior
B. Best fixed workflow known for the task class
C. Adaptive workflow selected by the harness
```

Generated or evolved workflows must also be compared with the currently promoted adaptive policy, not only with an intentionally weak baseline.

Every arm must also lock the existing managed-agent routing mode. `HarnessMode` and the existing
`agents.mode` are separate experimental axes. Initial harness evidence should normally keep managed
agents off; any later combined workflow-and-delegation experiment requires its own evaluation contract.

### Outcome Dimensions

Do not collapse all results into one score until the individual dimensions are retained and inspectable:

| Dimension              | Example signals                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Correctness            | tests, typecheck, verifier result, expected artifact                                  |
| Reliability            | first-pass completion, retry count, repeated tool failures                            |
| Regression risk        | unrelated edits, failing existing tests, policy violations                            |
| User alignment         | explicit rating, correction, rejection, requested rework                              |
| Maintainability        | diff scope, architecture checks, reviewer assessment                                  |
| Efficiency             | tokens, cost, elapsed time, tool calls, model calls                                   |
| Long-horizon stability | resume success, preserved decisions, context recovery                                 |
| Harness complexity     | prompt/context tokens, workflow fields, transitions, extra calls, maintenance surface |

The utility function and promotion thresholds must be declared before evaluating a candidate. They must not be changed after seeing the result to make a candidate appear successful.

### Required Evaluation Slices

Results must be reported separately for:

- weaker/local and frontier models;
- short and long-horizon tasks;
- read-only, editing, debugging, research, and review tasks;
- low-risk and high-risk project changes;
- known and newly introduced model versions.

An aggregate improvement cannot hide a serious regression for a specific model or task class.

### Stop Conditions

Pause adaptation for a slice when:

- outcome labels are mostly unknown or unreliable;
- the adaptive policy does not beat the best fixed workflow;
- gains exist only on training/replay tasks and disappear on held-out tasks;
- cost or latency grows beyond the declared trade-off;
- improvements depend on changing the evaluator, model, budget, or permission boundary;
- user corrections increase despite better automatic scores;
- model churn prevents reliable calibration.
- environment or infrastructure noise is large enough to obscure the measured effect;
- tool schemas, runtime primitives, or security posture changed without recalibration.

The fallback is a fixed or minimal workflow, not continued automatic experimentation.

---

## Architecture Boundaries

```text
+---------------------------------------------------------------+
| Trusted kernel                                                |
| Permissions, sandbox, secrets, immutable budgets, audit, gates |
+---------------------------------------------------------------+
                              ^ cannot be overridden
+---------------------------------------------------------------+
| Agent runtime / data plane                                    |
| Provider calls, context, tools, compaction, retries, resumes,  |
| cancellation, and session execution                           |
+---------------------------------------------------------------+
                              ^ receives a frozen run decision
+---------------------------------------------------------------+
| Harness runtime / control plane                               |
| Context derivation, workflow selection, observation, registry  |
+---------------------------------------------------------------+
                              ^ promotes validated candidates
+---------------------------------------------------------------+
| Offline evaluation and learning                               |
| Failure analysis, replay, comparison, candidate generation     |
+---------------------------------------------------------------+
```

### Dependency Rules

- `src/agent/loop.ts` may consume shared harness contracts and emit events, but it must not import the learner or promotion logic.
- The harness may request a workflow and permission posture, but `src/permissions.ts` and sandbox enforcement determine the effective boundary.
- Evaluation consumes completed run evidence. It does not mutate live runs.
- Candidate workflows cannot write to the promoted registry directly.
- A workflow decision is frozen for a run except for a small, predeclared set of runtime transitions.
- TUI modules remain leaves of the import graph, following existing project conventions.

### Initial Module Layout

Keep the implementation in this repository and process until the contracts stabilize:

```text
src/harness/
  contracts.ts          Shared types only
  coordinator.ts        Prepare, observe, and finalize a run
  observer.ts           Convert runtime callbacks to structured events
  run-store.ts          Append-only evidence persistence
  fingerprints.ts       Model and project identity/evidence
  workflows.ts          Validated fixed workflow definitions
  policy.ts             Deterministic workflow selection
  outcomes.ts           Evidence-based outcome extraction
  user-signals.ts       Scoped explicit and inferred signals
  evaluation/
    replay.ts           Offline historical/fixture replay
    scoring.ts          Multi-dimensional comparison
    candidate.ts        Bounded candidate representation
    promotion.ts        Canary, promotion, and rollback rules
```

Likely integration points:

- `src/types/*`: shared runtime-facing domain types only when they are genuinely cross-cutting;
- `src/settings.ts`: feature flags and explicit harness controls;
- `src/agent/context.ts`: render the selected workflow into the dynamic prompt zone;
- `src/agent/loop.ts`: emit structured runtime observations without owning learning;
- `src/session/agent-session.ts`: own root-request prepare/finalize and the shared lifecycle bridge;
- `src/session/agent-events.ts`: preserve typed terminal reasons and harness-visible lifecycle events;
- `src/headless.ts`: create/finalize runs for headless and CI execution;
- `src/tui/app.tsx`: create/finalize interactive runs and expose user controls;
- `src/session/store.ts`: retain transcript references, not duplicate full traces;
- `src/memory-store.ts`: continue storing approved knowledge, not workflow performance data.

### Fixed Runtime and Adaptive Surface

The adaptive layer may choose only among tested runtime capabilities:

| Fixed runtime responsibility                                       | Adaptive workflow surface                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Permission, sandbox, secret, and prompt-injection enforcement      | Requested approval posture, subject to kernel clamps                       |
| Tool schemas, error semantics, cancellation, and retry correctness | Retry posture within kernel ceilings                                       |
| Checkpoint, compaction, and resume mechanics                       | Context depth, failure/decision retention, and supported compaction policy |
| Verifier definitions and evaluator integrity                       | Which declared verifiers to request                                        |
| Trace/evidence integrity and retention policy                      | Evidence level and explanation detail                                      |
| Absolute budgets and model/provider identity                       | Planning, edit scope, and verification posture                             |

Workflow definitions cannot add runtime primitives, arbitrary tools, free-form prompts, or security policy.

Before Phase 3, publish a capability matrix classifying every workflow field as:

```text
kernel-enforced request
prompt-only guidance
unsupported and explicitly clamped
```

Do not ship an initial workflow field whose runtime effect is only assumed. Parallelism remains outside
the first harness workflow surface unless an independently evaluated existing managed-agent capability
is deliberately brought into scope.

### HarnessCard and Compatibility Identity

Every evaluation report and promoted workflow should have a compact HarnessCard describing:

- model/provider and exact configuration;
- runtime, environment, sandbox, and tool-surface fingerprints;
- context, workflow, verifier, and permission boundaries;
- primary and guardrail metrics;
- known limitations, unknown outcomes, and rollback target.

Compatibility identity must include the environment and tool surface, not only the model name. Changes invalidate or downgrade evidence until recalibrated.

### Storage Separation

Do not use the debug log or approved memory as the learning database.

```text
sessions/                Conversation and tool history
harness/runs/            Structured run events and outcome summaries
harness/workflows/       Validated workflow definitions
harness/candidates/      Untrusted proposed workflow versions
harness/registry/        Active and previous promoted versions
memory/                  Approved user/project knowledge
```

For the initial release, keep adaptive evidence project-scoped. Cross-project or global user learning is deferred until privacy, inspection, deletion, and conflict behavior are proven.

---

## Phased Implementation

No phase may begin its adaptive behavior until the previous phase's exit gate is recorded as verified.

### Phase Execution Rules

Each phase is a gate, not a loose milestone. Implement it as small reviewable sub-phases using the numbering in this document (`0.1`, `0.2`, and so on).

For every sub-phase:

1. Update the tracking ledger to `In progress` before behavior changes begin.
2. Add or update tests before enabling the new behavior by default.
3. Keep the feature disabled, observe-only, shadowed, or canaried as required by the phase.
4. Record the exact files, schemas, settings, and migration behavior introduced.
5. Run the targeted test matrix and the anti-drift review.
6. Attach evidence to the ledger before marking the sub-phase complete.
7. Do not begin the next phase if the current exit gate is only partially met.

Each phase should produce a verification packet containing:

```text
phase and sub-phase
code/config version
behavior before and after
test commands and results
evaluation corpus version
model/provider/version
environment/runtime/tool-surface fingerprints
noise-floor or control-variance result
workflow/policy version
primary and guardrail metrics
known unknowns
HarnessCard reference
anti-drift answers
promotion, hold, reject, or rollback decision
```

Changes that mix two gated phases must explain why they cannot be separated. Convenience alone is not sufficient.

### Detailed Phase Files

Detailed implementation work lives in one file per phase. The parent document remains the source of truth for original intent, shared invariants, architecture boundaries, stop conditions, rollout ordering, and the central status ledger.

| Phase | Status      | Detailed plan                                                                          | Advancement gate                                             |
| ----- | ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 0     | Not started | [Evaluation contract and fixtures](adaptive-harness/phase-0-evaluation-contract.md)    | Improvement can be falsified with stable metrics             |
| 1     | Not started | [Contracts and disabled boundary](adaptive-harness/phase-1-contracts-boundary.md)      | Harness is inert and runtime-equivalent when off             |
| 2     | Not started | [Run evidence ledger](adaptive-harness/phase-2-run-evidence-ledger.md)                 | Runs are explainable without behavior changes                |
| 3     | Not started | [Validated workflow registry](adaptive-harness/phase-3-workflow-registry.md)           | Fixed workflows are safe and reproducible                    |
| 3A    | Not started | [Agent-capability substrate](adaptive-harness/phase-3a-agent-capability-substrate.md)  | Capability bundles are versioned, bounded, and comparable    |
| 3B    | Not started | [Capability routing reliability](adaptive-harness/phase-3b-capability-routing.md)      | Routing bundle passes tool, child, and delegation guardrails |
| 4     | Not started | [Deterministic selector](adaptive-harness/phase-4-deterministic-selector.md)           | Decisions are advisory, scoped, and explainable              |
| 5     | Not started | [Outcomes and feedback](adaptive-harness/phase-5-outcomes-feedback.md)                 | Outcomes are externally grounded or unknown                  |
| 6     | Not started | [Shadow and held-out evaluation](adaptive-harness/phase-6-shadow-evaluation.md)        | Adaptation beats serious baselines on eligible slices        |
| 7     | Not started | [Scoped live adaptive selection](adaptive-harness/phase-7-live-adaptive-selection.md)  | Canary evidence confirms benefit and rollback works          |
| 8     | Not started | [Bounded workflow evolution](adaptive-harness/phase-8-bounded-workflow-evolution.md)   | Candidates pass immutable held-out promotion gates           |
| 9     | Future gate | [Long-term and cross-context transfer](adaptive-harness/phase-9-long-term-transfer.md) | Project-scoped adaptation is already proven                  |

### Phase File Maintenance Rules

- Implement and review only the current eligible phase.
- Update the phase-file status and the parent tracking ledger in the same change.
- Keep phase-specific schemas, file plans, tests, and verification evidence in that phase file.
- Keep cross-phase intent, architecture, trust boundaries, global acceptance criteria, and non-goals in this parent plan.
- If a phase changes a shared invariant or architecture boundary, update the parent plan first and re-review all later phase assumptions.
- Do not copy completed phase details back into the parent plan.

---

## Implementation Tracking Ledger

Update this table in the same pull request that changes a phase status. Do not mark a phase verified without linked test/evaluation evidence.

| Phase                                                                                             | Status      | Owner | PR/commit | Verification evidence                                                                                                                                                                             | Decision/notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ----------- | ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Preconditions Tier A/B](adaptive-harness/research-grounding.md#2026-08-05-readiness-disposition) | Verified    | Codex | -         | `npm run check`, `npm run build`, `git diff --check`; provider/loop/compact/session/accounting/ambient/headless/runner/eligibility tests; edit/compact/skill evaluator tests; architecture checks | Verified only for evaluator-controlled, trusted built-in, single-agent evaluation. Terminal outcomes, root/child/resume attribution, compaction and retry accounting, versioned pricing, verified model identity, complete ambient schema v2, isolated captured Book home, dirty/untracked runtime identity, materialized-fixture identity, runner-owned date/seed, bounded process isolation, and fail-closed eligibility are covered. Phase 0 is ready to begin in this limited scope but remains `Not started` in this change. |
| [Preconditions Tier C](adaptive-harness-implementation-plan.md#tier-c-trusted-execution-boundary) | Blocked     | -     | -         | -                                                                                                                                                                                                 | Project-controlled or adversarial setup/reset/cleanup/verifiers, hooks, providers, MCP, commands, skills, subagents, network, and credential-bearing integrations remain ineligible until workspace trust, permission ceilings, origin binding, truthful sandbox/network enforcement, and container-grade isolation are verified.                                                                                                                                                                                                 |
| [0. Evaluation contract](adaptive-harness/phase-0-evaluation-contract.md)                         | Not started | -     | -         | -                                                                                                                                                                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [1. Contracts and disabled boundary](adaptive-harness/phase-1-contracts-boundary.md)              | Not started | -     | -         | -                                                                                                                                                                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [2. Observation ledger](adaptive-harness/phase-2-run-evidence-ledger.md)                          | Not started | -     | -         | -                                                                                                                                                                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [3. Fixed workflow registry](adaptive-harness/phase-3-workflow-registry.md)                       | Not started | -     | -         | -                                                                                                                                                                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [3A. Agent-capability substrate](adaptive-harness/phase-3a-agent-capability-substrate.md)         | Not started | -     | -         | -                                                                                                                                                                                                 | Prompt, skill, tool, context, model, and handoff contracts                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [3B. Capability routing reliability](adaptive-harness/phase-3b-capability-routing.md)             | Not started | -     | -         | -                                                                                                                                                                                                 | Hybrid exposure, intent preload, eager child surfaces, deterministic discovery, and bounded explorer delegation                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [4. Deterministic selector](adaptive-harness/phase-4-deterministic-selector.md)                   | Not started | -     | -         | -                                                                                                                                                                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [5. Outcomes and feedback](adaptive-harness/phase-5-outcomes-feedback.md)                         | Not started | -     | -         | -                                                                                                                                                                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [6. Shadow adaptation](adaptive-harness/phase-6-shadow-evaluation.md)                             | Not started | -     | -         | -                                                                                                                                                                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [7. Scoped live selection](adaptive-harness/phase-7-live-adaptive-selection.md)                   | Not started | -     | -         | -                                                                                                                                                                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [8. Bounded evolution](adaptive-harness/phase-8-bounded-workflow-evolution.md)                    | Not started | -     | -         | -                                                                                                                                                                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [9. Cross-context transfer](adaptive-harness/phase-9-long-term-transfer.md)                       | Future gate | -     | -         | -                                                                                                                                                                                                 | Not part of initial delivery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Allowed statuses:

```text
Not started -> In progress -> Verified
                         \-> Rejected
                         \-> Blocked
Verified -> Rolled back
```

Each verification record must include:

- exact code/config version;
- model/provider/version;
- workflow and policy version;
- task/evaluation corpus version;
- commands executed and results;
- comparison-arm metrics;
- known gaps and unknown outcomes;
- completed anti-drift review;
- promote, hold, reject, or roll-back decision.

---

## Rollout Batches

Implement in four reviewable batches:

1. **Evidence foundation:** Phases 0-2. No task behavior changes.
2. **Controlled capability comparison:** Phases 3-5. Fixed/manual workflows, capability bundles,
   and trustworthy outcomes.
3. **Verified adaptation:** Phases 6-7. Shadow evaluation before scoped live selection.
4. **Self-improvement:** Phase 8. Bounded candidates, immutable gates, and rollback.

Do not combine evidence collection, adaptive selection, and self-evolution into one release. If the system cannot prove value at an earlier batch, stop there.

## Global Verification Commands

Run the phase-specific tests first, then the full project checks before marking a phase verified:

```powershell
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

For TUI-visible behavior, also run the relevant render/integration tests and manually verify:

- harness off;
- observe-only mode;
- explicit minimal workflow;
- explicit fixed workflow;
- adaptive explanation and override;
- interrupted and resumed run;
- model switch;
- permission denial;
- evaluator failure;
- rollback to previous workflow.

## Overall Acceptance Criteria

- Harness mode `off` preserves the existing Book runtime behavior.
- The system can select `minimal` for models/tasks that do not benefit from scaffolding.
- Current explicit user instructions always override learned preferences.
- Model evidence is derived and disposable, not a manually maintained per-model profile.
- Prompt layers, skills, tool contracts, context policies, model adapters, verification, hooks, and
  delegation have explicit versioned identities in comparison records.
- Skill bodies are lazy and scoped; project-controlled skills cannot change permissions, budgets,
  evaluators, tool schemas, or prompt-injection defenses.
- Tool descriptions and schemas are evaluated as part of the tool surface, not treated as immutable
  implementation detail.
- The promoted Phase 3B routing bundle exposes common web and permitted delegation capabilities,
  eagerly satisfies valid child allowlists, and records an inspectable reason for every capability
  visibility or activation decision.
- Prompts and managed-agent profiles never promise a tool outside the effective surface, and
  deferred discovery failures distinguish no-match, authorization, availability, and budget causes.
- Existing fixed tool-reliability semantics are fingerprinted and reused rather than duplicated by
  the adaptive harness.
- TUI, headless/CI, and SDK entry surfaces share trust, lifecycle, permission, budget, status, and
  evidence contracts or carry an explicit incompatibility marker.
- Untrusted workspaces cannot start or authorize project-controlled hooks, providers, MCP servers,
  executable commands, skill scripts, or privileged subagents through a capability bundle.
- Capability bundles can be rolled back independently of the trusted kernel and evaluator.
- Project and user evidence is scoped, inspectable, confidence-weighted, and expiring where appropriate.
- Every adaptive decision records its evidence, reason, policy version, and workflow version.
- Outcome evaluation retains correctness, reliability, alignment, regression, cost, and latency separately.
- Adaptive selection is enabled only on held-out slices where it beats the best fixed workflow without unacceptable guardrail regressions.
- Strong-model results are reported independently and may remain on the minimal workflow.
- New model versions begin untrusted and are recalibrated.
- Context exhaustion, compaction, interruption, and resume behavior are measured explicitly.
- Tool-surface and environment changes invalidate incompatible evidence rather than being hidden in aggregate results.
- Prompt-injection and untrusted-input fixtures pass before adaptive execution is enabled.
- Human-rubric outcomes are versioned, attributable, and not solely model-judged.
- Candidate workflows cannot edit the trusted kernel, evaluator, budgets, history, or live registry.
- Promotion, canarying, disabling, and rollback are deterministic and auditable.
- Tied outcomes select the simpler workflow using a declared complexity measure.
- If improvement is not demonstrated, Book remains a fixed/minimal agent rather than accumulating unsupported complexity.

## Risks and Mitigations

| Risk                                                              | Mitigation                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Harness helps weak models but harms strong models                 | Slice metrics by model/task and allow minimal/no-adaptation policies                             |
| Model churn makes evidence stale                                  | Key evidence by exact model version, use weak priors, and recalibrate                            |
| User behavior changes by context                                  | Scope signals, prioritize current intent, use confidence decay and modes                         |
| Profiles become maintenance burden                                | Store observations and derive temporary evidence views                                           |
| Prompt, skill, or tool changes are misattributed to workflows     | Fingerprint the full capability manifest and evaluate axes separately                            |
| Long prompts distract or invalidate caches                        | Split stable, session, dynamic, and task prompt layers with budgets                              |
| Skills activate too often or too late                             | Test trigger precision/recall, direct activation, and deferred activation cost                   |
| Tool descriptions route models incorrectly                        | Add contract fixtures and selection metrics for overlapping tools                                |
| Common tools remain hidden or child tools remain unusable         | Promote only a routing bundle that passes first-turn, child-budget, and next-turn-use gates      |
| Automatic explorer delegation adds cost or duplicate work         | Cap it to one read-only child, measure parent-context savings, and retain deterministic rollback |
| Context retrieval adds noise                                      | Compare bounded retrieval policies and report relevant-token ratio                               |
| Easy metrics replace real quality                                 | Preserve multiple dimensions and block learning on unknown outcomes                              |
| Candidate overfits replay tasks                                   | Separate held-in and held-out sets; canary on fresh tasks                                        |
| Reward hacking                                                    | Keep evaluator, permissions, budgets, and history immutable                                      |
| Runtime becomes entangled with learning                           | Enforce one-way dependencies and keep learning offline                                           |
| Data collection leaks private content                             | Store bounded references, redact secrets, and require replay eligibility                         |
| Complexity grows without benefit                                  | Phase gates, serious baselines, stop conditions, and minimal fallback                            |
| Infrastructure noise looks like improvement                       | Fingerprint execution environments, estimate a noise floor, and use paired control runs          |
| Context loss or resume drift is misattributed to workflow quality | Evaluate compaction, handoff, checkpoint, and resume behavior as explicit cases                  |
| Prompt injection or poisoned tool/project content reaches policy  | Preserve provenance, isolate untrusted inputs, and run security fixtures before promotion        |
| Tool schema or runtime changes stale evidence                     | Fingerprint the tool surface and fixed runtime capabilities; invalidate incompatible samples     |
| Subjective quality is ignored or over-trusted                     | Use versioned blind human rubrics with agreement thresholds and explicit unknowns                |
| Observability becomes a proprietary dead end                      | Keep the append-only ledger locally but map traces and metrics to OpenTelemetry semantics        |

## Non-Goals for the Initial Delivery

- No universal best workflow.
- No manually curated profile for every model.
- No permanent global inference from a single user interaction.
- No arbitrary editing of Book's runtime source by the agent.
- No evaluator, permission, budget, or model changes by candidate workflows.
- No automatic cross-project learning by default.
- No multi-agent orchestration solely for the appearance of sophistication.
- Existing Task/managed-agent features are not harness learning evidence by default; combined
  multi-agent adaptation remains separately gated.
- No claim of recursive self-improvement without held-out outcome evidence.
- No requirement that every model improve; the system must identify where adaptation is neutral or harmful.
- No use of adaptive workflows to compensate for missing runtime correctness or security controls.
- No external benchmark replaces the deterministic local corpus; benchmark adapters are portability checks only.
- No new harness-controlled multi-agent coordination in the initial delivery; existing Task/managed-agent capabilities are locked as a separate experimental axis and future adaptive coordination remains separately gated.

## Final Product Test

At any point in implementation, the project should be able to answer:

> For this model, project, user context, and task class, did the selected workflow produce a better verified outcome than the best simpler workflow, at an acceptable cost, and can we safely reverse the decision?

If Book cannot answer that question with evidence, the adaptive harness is not yet improving the agent.
