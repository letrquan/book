# Phase 4: Add a Deterministic, Explainable Selector

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Not started
- **Depends on:** Phase 3, Phase 3A, and Phase 3B verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---


**Objective:** Select among fixed workflows using current evidence without LLM-based policy generation.

Automatic decisions remain advisory in this phase. They may be explained, tested, or recorded, but they do not control live execution until Phase 7 eligibility and canary gates are satisfied.

The first selector chooses only among fixed workflows. Prompt kernels, prompt-layer renderers, skill
registries and activation policy, tool descriptions/schemas, context policies, model adapters,
verifiers, hooks, and delegation policy remain frozen capability axes. Advisory recommendations for
those axes may be recorded separately, but they cannot affect the live run or be conflated with the
workflow decision.

**Deliverables:**

- Add deterministic task features and risk classification.
- Derive model evidence from observed behavior, not model-size labels alone.
- Derive project facts from repository/configuration state with freshness hashes.
- Derive runtime, environment, tool-surface, and context-capability fingerprints for compatibility checks.
- Add scoped user signals with precedence: current task, session, project, then default.
- Fall back to `minimal` when evidence is missing, contradictory, stale, or low confidence.
- Add an explain/dry-run surface showing the selected workflow and evidence used.
- Define a small set of allowed mid-run transitions, such as `minimal -> safe-edit` after repeated tool failures.

#### Phase 4 Work Breakdown

##### 4.1 Define policy input features

Use explicit, bounded features instead of passing raw histories into the selector:

```ts
interface PolicyInput {
  task: {
    class: string;
    requestsMutation: boolean;
    requestsReview: boolean;
    expectedHorizon: 'short' | 'medium' | 'long';
    ambiguity: 'low' | 'medium' | 'high';
    risk: 'low' | 'medium' | 'high';
  };
  model: ModelEvidenceView;
  project: ProjectEvidenceView;
  user: UserSignalView;
  runtime: {
    permissionMode: string;
    gitDirty: boolean;
    availableTools: string[];
    runtimeFingerprint: string;
    environmentFingerprint: string;
    toolSurfaceFingerprint: string;
    contextCapabilitiesVersion: string;
    capabilityManifestDigest: string;
  };
}
```

Every feature needs provenance, freshness, and a default. Features without reliable derivation stay `unknown`; they should not be guessed by the policy.

Classify the original user text and trusted slash-command metadata before `@file` expansion or shell
substitution. Repository/tool-derived context enters as separately attributed untrusted features and
cannot be mistaken for current explicit intent.

##### 4.2 Implement deterministic task classification

Initial classification may combine:

- explicit command or mode (`/review`, plan mode, headless flags);
- user request indicators;
- requested output type;
- whether mutation is authorized;
- referenced files or project areas;
- project-declared risk rules.

Keep the classifier pure and testable. Do not call a model in the initial selector. When classification confidence is low, select `minimal` or request clarification through existing user-question mechanisms rather than silently choosing a heavy workflow.

##### 4.3 Derive model evidence views

Compute a short-lived view from recent compatible runs:

```ts
interface ModelEvidenceView {
  key: string;                 // provider + exact model id/version/config
  sampleCount: number;
  toolSuccessRate?: number;
  recoveryRate?: number;
  verifierPassRate?: number;
  longHorizonCompletionRate?: number;
  averageCostUsd?: number;
  confidence: number;
  updatedAt: number;
}
```

Rules:

- exact model/config keying before transfer;
- no manual "weak/strong" label in policy logic;
- insufficient samples produce low confidence;
- old evidence decays or becomes stale;
- tool, runtime, environment, context-capability, or evaluator changes invalidate incompatible samples.

Partition evidence by workflow, task class/risk/horizon, corpus/evaluator version, and existing
managed-agent mode. Historical success rates are selection-confounded unless they came from a
randomized/control exposure or a valid replay; observational rates may diagnose but cannot by
themselves justify a stronger policy.

##### 4.4 Derive project evidence views

Use deterministic facts:

- workspace identity;
- git state and revision;
- languages and package manifests;
- known test/typecheck/lint commands;
- protected paths or ownership rules;
- recent regression patterns;
- repository size and expected task horizon.

Hash the source inputs. When manifests or configuration change, recompute instead of trusting old facts.

##### 4.5 Derive compatibility fingerprints

Create stable redacted identities for:

- runtime and dependency versions relevant to agent execution;
- OS/architecture, sandbox/container limits, network policy, and resource profile;
- tool names, schema hashes, permission classes, cancellation/retry semantics, and implementation versions;
- context, compaction, checkpoint, and resume capabilities;
- evaluator and verifier versions.

Use these fingerprints primarily to accept or reject evidence compatibility. Do not let incidental machine properties become a hidden workflow preference. If compatibility cannot be established, lower confidence and fall back to `minimal`.

Use canonical structured inputs for component digests and retain component descriptors beside the
aggregate identity. Provider aliases or proxies that do not expose an exact resolved model remain
`unknown` rather than being treated as the requested model version.

##### 4.6 Implement scoped user-signal resolution

Resolve in this order:

```text
current explicit instruction
current task override
current session signal
project-scoped explicit preference
project-scoped inferred preference with sufficient confidence
system default
```

Store explicit and inferred signals separately. One contradictory observation lowers confidence; it does not rewrite an explicit preference. Safety-sensitive behavior is never inferred.

##### 4.7 Write the initial rule policy

Keep the first policy small enough to audit. Example rules:

```text
read-only or explanation task + low risk -> minimal
mutating task + high project risk -> safe-edit
required verifier + prior regression pattern -> verify-heavy
unknown model evidence -> minimal
unknown or changed compatibility identity -> minimal
clean strong evidence for minimal -> minimal
manual override -> selected fixed workflow
```

Each rule returns an explanation with the evidence IDs it used. Avoid rules whose only effect is adding prompts without a measured failure pattern.

Define confidence as a typed, calibrated policy quantity rather than a free-form number. Also define
the partial order used by any safety property: `minimal`, `safe-edit`, and `verify-heavy` differ in
structure/cost and are not a simple permission ladder.

##### 4.8 Add explain and dry-run output

Provide a structured explanation:

```ts
interface PolicyExplanation {
  selectedWorkflow: string;
  confidence: number;
  matchedRules: string[];
  evidenceRefs: string[];
  ignoredEvidence: Array<{ ref: string; reason: string }>;
  fallback?: string;
}
```

Expose it through a command or debug/report surface without leaking raw private evidence.

##### 4.9 Define the transition state machine

Allow only predeclared upward/downward transitions, for example:

```text
minimal -> safe-edit       repeated mutation/tool failure
safe-edit -> verify-heavy  verifier failure or high-risk expansion
safe-edit -> minimal       only on a new run, not mid-edit
```

Every transition requires:

- a specific observable trigger;
- a maximum number of transitions;
- a recorded reason;
- no permission escalation beyond the kernel;
- deterministic behavior for the same event sequence.

Transitions occur only at predeclared loop boundaries before the next provider request. Manual
interactive overrides apply to the next root run unless a thread-safe transition channel is
implemented. Disable transitions after ambiguous partial mutation unless the trigger and attribution
rule explicitly allow them.

#### Phase 4 File Plan

```text
Add    src/harness/policy.ts
Add    src/harness/policy.test.ts
Add    src/harness/fingerprints.ts
Add    src/harness/fingerprints.test.ts
Add    src/harness/user-signals.ts
Add    src/harness/user-signals.test.ts
Add    src/harness/task-features.ts
Add    src/harness/task-features.test.ts
Modify src/harness/coordinator.ts
Modify src/agent/loop.ts only for explicit transition triggers/events
```

#### Phase 4 Test Matrix

- Table-driven policy tests for every rule and fallback.
- Property test: missing evidence never selects a more permissive workflow than configured defaults.
- Property test: explicit current instruction outranks inferred signals.
- Stale model/project evidence is ignored with an explanation.
- Exact model version change lowers confidence or creates a new key.
- Runtime, tool-surface, environment, context-capability, or evaluator changes invalidate incompatible evidence.
- Policy remains deterministic regardless of event insertion order after normalization.
- Transition loops are impossible.
- Manual override prevents automatic transitions unless explicitly allowed.
- Explanation references only evidence actually used.
- Changing any frozen capability-manifest component invalidates workflow evidence instead of being
  absorbed into the selector's result.

**Verification:**

- The same input evidence produces the same decision.
- The selector does not special-case marketing labels such as "large" or "frontier."
- A strong model with a clean trajectory can remain on `minimal`.
- Repeated tool failures can increase structure without changing the trusted boundary.
- Current explicit instructions override historical signals.
- Conflicting or stale user signals reduce confidence rather than rewriting a durable profile.
- Compatibility fingerprints gate evidence reuse but do not become behavioral profiling features by themselves.

**Commands:**

```powershell
npm run typecheck
npm run test:unit -- src/harness/policy.test.ts
npm run test:unit -- src/harness/fingerprints.test.ts
npm run test:unit -- src/harness/user-signals.test.ts
npm run test:unit -- src/agent/loop.test.ts
npm test
```

**Exit gate:** Selection is understandable, reproducible, reversible, and can choose no extra scaffolding.

**Rollback:** Disable `shadow` mode and continue collecting observations with manual/fixed workflows.

**Intent check:** Does the selector adapt to evidence, or merely encode a new universal workflow in conditionals?
