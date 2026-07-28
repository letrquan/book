# Phase 0: Freeze the Evaluation Contract

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Not started
- **Depends on:** Parent-plan Pre-Phase-0 Runtime Preconditions verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---


**Objective:** Define what improvement means before adding adaptive behavior.

**Deliverables:**

- Define representative task classes: read-only, simple edit, bug fix, multi-file change, review, research, and long-horizon work.
- Define comparison arms A/B/C and the required model slices.
- Define primary metrics, guardrail metrics, and acceptable trade-offs.
- Define how user acceptance, correction, and unknown outcomes are recorded.
- Create a small deterministic fixture corpus that can run without private user data.
- Define environment, runtime, and tool-surface compatibility fingerprints plus a measured infrastructure noise floor.
- Include context exhaustion/resume, tool-contract, and untrusted-input security fixtures.
- Include workspace-trust and external-integration fixtures before any project-controlled process or
  credential can be used in an evaluation arm.
- Define versioned human rubrics for outcomes that cannot be verified automatically.
- Define optional external benchmark adapters as portability checks, not promotion substitutes.
- Record benchmark limitations and tasks that cannot yet be evaluated reliably.

#### Phase 0 Work Breakdown

##### 0.1 Define the evaluation case schema

Create a versioned manifest format for every evaluation case. A case should declare:

```ts
interface HarnessEvaluationCase {
  schemaVersion: 1;
  corpusVersion: string;
  evaluatorVersion: string;
  id: string;
  taskClass: 'read-only' | 'simple-edit' | 'bug-fix' | 'multi-file' | 'review' | 'research' | 'long-horizon';
  prompt: string;
  fixture: {
    source: string;
    revision: string;
    treeDigest: string;
    setup?: TrustedCommand;
    reset?: TrustedCommand;
    cleanup?: TrustedCommand;
  };
  model: {
    provider: string;
    requestedModel: string;
    resolvedModel?: string;
    configDigest: string;
  };
  compatibility: {
    runtimeFingerprint: string;
    environmentFingerprint: string;
    toolSurfaceFingerprint: string;
  };
  risk: 'low' | 'medium' | 'high';
  allowedTools: string[];
  expectedArtifacts?: string[];
  verifiers: Array<{
    id: string;
    command?: TrustedCommand;
    kind: 'command' | 'file' | 'diff' | 'human-rubric';
    required: boolean;
    timeoutMs?: number;
    expectedExitCodes?: number[];
    expectedDigest?: string;
  }>;
  budgets: {
    maxTurns?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
  };
  tags: string[];
}

interface TrustedCommand {
  argv: string[];
  cwd: string;
  envAllowlist: string[];
  network: 'off' | 'restricted' | 'required';
}
```

The schema is a contract, not necessarily the final runtime type. Phase 0 may represent it as JSON/Markdown fixtures before Phase 1 adds shared TypeScript contracts.

##### 0.2 Build the initial fixture matrix

Create at least one deterministic fixture for each machine-verifiable task class and at least one
explicitly observational or human-rubric case for subjective classes. Prefer tiny fixture repositories
or frozen repository revisions over mocks that bypass real file and tool behavior.

Each fixture should define:

- initial repository state;
- exact prompt;
- permitted files and tools;
- expected final state or verifier commands;
- timeout and cost ceiling;
- known ambiguous outcomes;
- reset procedure.

The initial corpus must also contain targeted cases for:

- context exhaustion, compaction, preserved decisions/failures, interruption, and resume;
- malformed tool arguments, ambiguous tool errors, timeout, cancellation, retry, oversized output, and partial success;
- prompt injection or instruction-like text from repository files, tool results, and retrieved content;
- attempted credential exposure, indirect permission escalation, poisoned memory/evidence, and unverified tool endpoints.
- skill activation: direct, indirect, negative, ambiguous, conflicting, unavailable-body, and
  project-skill trust cases;
- tool-contract routing: overlapping tools, deferred discovery, malformed arguments, structured
  errors, retry/cancellation, and partial-result recovery;
- prompt-layer behavior: stable-prefix digest changes, dynamic-policy activation, source/trust
  provenance, budget clipping, and instruction-like untrusted content;
- context engineering: relevant-file retrieval, repository/symbol-map quality, irrelevant-context
  pressure, repeated reads, compaction, checkpoint freshness, and resume preservation;
- model/provider capability: exact identity, aliases/unknown identity, provider message flattening,
  tool-result ordering, output limits, structured output, and prompt-cache assumptions;
- subagent capability: skill preload, restricted tools, independent review, stale snapshots, typed
  handoffs, and duplicate-work detection;
- deterministic controls: hook block/modify/timeout behavior, verifier authority, permission
  decisions, and behaviors that must not depend on prompt compliance.
- workspace trust: untrusted project hooks, providers, MCP servers, commands, skills, and subagents
  are blocked before spawn/request; explicit trust enables only the reviewed surfaces;
- external lifecycle: TUI/headless/SDK/CI initialization order, provider/MCP negotiation, auth,
  timeout, cancellation, reconnect, backpressure, partial results, cleanup, and status parity;
- web and credential boundaries: origin binding, redirect/private-address blocking, response limits,
  environment filtering, redaction, and terminal-output sanitization.

Do not use personal session transcripts in the initial corpus.

Machine-verifiable, human-rubric, and observational cases must be labeled separately. A
deterministic fixture does not make model execution deterministic; every model-backed case must
declare a repeated-trial rule even when temperature is zero or a provider seed is available.

##### 0.3 Define baseline execution arms

Document how each case is run under:

- `A/base`: current Book behavior with harness mode `off`;
- `B/fixed`: each manually selected fixed workflow;
- `C/adaptive`: selector output, initially shadow-only;
- `D/candidate`: evolved workflow, introduced only in Phase 8.

All arms must use the same model version, provider settings, tool-surface fingerprint, runtime/environment profile, repository revision, budgets, and evaluator version.

For capability experiments, also lock the prompt-layer, skill registry and activation policy, context
policy, model-adapter, hook policy, verifier, and delegation fingerprints. A workflow result is not
attributable when any of those changed silently.

The initial corpus must also lock `settings.agents.mode`, normally to `off`, so the harness workflow
is not confounded with Book's existing adaptive delegation. Capture a golden provider-message and
session-behavior baseline for `A/base`; do not assume a later `minimal` workflow is equivalent.

##### 0.4 Freeze metrics and decision rules

For every task class, declare:

- primary success metric;
- guardrail metrics that cannot regress;
- maximum acceptable cost/latency increase;
- minimum sample count or uncertainty rule;
- paired-run or repeated-control rule and the minimum detectable effect above infrastructure noise;
- tie-breaking rule;
- treatment of timeouts, evaluator failures, and unknown outcomes.
- experimental/randomization unit and cluster dependencies;
- estimand, minimum detectable effect, alpha/power or minimum-sample rule;
- non-inferiority margins for guardrails and multiplicity handling across slices/metrics;
- missingness policy, including when unknown/evaluator failure differs by arm;
- trial-order, cache, rate-limit, clock, seed, and network controls.

Do not require one universal scalar score. A candidate may be rejected because it improves correctness while violating a guardrail. When results are equivalent within the declared uncertainty/noise band, the simpler workflow wins.

##### 0.5 Define the evaluation report format

Reports must show raw counts and per-slice results before aggregates:

```text
case id
model/provider/version
runtime/environment/tool-surface fingerprints
workflow/policy version
success/failure/unknown
verifier evidence
turns/tokens/cost/latency
tool failures/retries
changed files/diff size
user or reviewer result, when applicable
control variance/noise-floor result
harness complexity delta
prompt tokens by layer and cache-prefix churn
skill activation decision, body/resource tokens, activation latency, and false-trigger label
tool-selection/search result, schema tokens, malformed-call and recovery outcome
context contribution summary, relevant-file recall, repeated-read count, and compaction loss
exact capability manifest and changed component IDs
```

##### 0.6 Record evaluator limitations

Create a section for tasks that cannot yet support automatic learning. Research quality, architecture taste, maintainability, and user satisfaction may require human rubrics.

Human rubrics must be versioned and define:

- observable criteria and rating anchors;
- blind comparison when practical;
- reviewer identity or role and independence requirements;
- minimum reviewer count or agreement rule;
- treatment of disagreement and missing reviews;
- whether a model judge is advisory, with a rule that it cannot be the sole promotion authority.

Cases remain observational until the rubric is reliable enough to produce attributable outcomes.

##### 0.7 Define compatibility fingerprints and infrastructure noise

Define stable, redacted fingerprints for:

- OS, architecture, runtime and package-manager versions;
- CPU/memory limits, sandbox/container configuration, and network policy;
- dependency/cache state relevant to evaluation;
- tool names, schemas, permission requirements, error semantics, and implementation versions;
- context/compaction/checkpoint capabilities;
- random seed and evaluator execution settings when applicable.

Run repeated base/control cases to estimate setup failures, latency variance, and success-rate variance before setting promotion thresholds. If the observed noise can explain the measured effect, report insufficient evidence.

Keep component-level compatibility fields beside any aggregate digest. One opaque fingerprint is
insufficient for diagnosing whether a model, tool schema, evaluator, runtime, or incidental machine
property caused invalidation. Canonicalize structured inputs before hashing.

##### 0.8 Define external benchmark adapters and HarnessCard output

Allow optional adapters for a small coding benchmark and a long-horizon terminal benchmark. Adapters must lock the same compatibility fields as local fixtures, preserve the benchmark's evaluator, and keep results separate from the primary Book corpus.

Define a compact HarnessCard template covering runtime, environment, tool surface, context policy, constraints, evaluation corpus, results, limitations, and rollback. External benchmark success cannot override a failing local held-out gate.

#### Planned Phase 0 Artifacts

```text
evals/harness/README.md
evals/harness/manifest.json
evals/harness/cases/
evals/harness/fixtures/
evals/harness/rubrics/
evals/harness/adapters/
evals/harness/harness-card.md
evals/harness/reports/        # generated and gitignored unless curated
```

If the project chooses a different location, record the decision before Phase 1 and use it consistently.

#### Phase 0 Research Closure Gate

Before implementation, answer the Phase 0 questions in
[research-grounding.md](research-grounding.md): trusted command execution, experimental unit,
repeated-trial design, missingness, multiplicity, human-rubric reliability, exact identity, and
external-runner isolation. Adversarial setup/verifier fixtures cannot run in Book's unsandboxed
Windows shell path.

#### Phase 0 Test Matrix

- Valid and invalid evaluation manifests.
- Fixture reset produces the same file hashes.
- Required verifier passes only for the expected result.
- Required verifier fails for a deliberately broken result.
- Optional verifier failure does not silently become primary success.
- Timeout and unknown outcomes are represented distinctly.
- Context exhaustion/resume and prompt-injection fixtures fail when the expected runtime boundary is removed.
- Tool-contract fixtures distinguish workflow failure from malformed or changed tool behavior.
- Human-rubric disagreement remains visible and cannot be collapsed into success.
- A report cannot compare arms with different model, budget, fixture revision, environment, tool surface, runtime, or evaluator versions without marking the comparison invalid.
- Repeated base runs produce a recorded noise floor and minimum detectable effect.
- External benchmark adapters cannot replace or weaken local held-out promotion criteria.
- Manifest schemas reject unknown fields recursively instead of stripping them.
- Fixture materialization matches the declared tree digest and rejects symlink/path escapes.
- Root and child tokens/costs are cumulative; unknown pricing remains unknown rather than zero.

**Verification:**

- The same task fixture can be run repeatedly with a stable expected result.
- Metrics are computed without asking the tested model to judge itself.
- A failed or unknown verifier cannot be recorded as success.
- Thresholds are written before collecting candidate results.
- Infrastructure variance is measured before small effect claims are accepted.
- Security, context/resume, and tool-contract cases can falsify unsafe or incompatible harness behavior.

**Exit gate:** A reviewable evaluation contract exists and can falsify the claim that the harness improves results.

**Rollback:** Documentation-only; revise the contract before implementation if it cannot distinguish real improvement from additional activity.

**Intent check:** Are we measuring better outcomes rather than more agent behavior?
