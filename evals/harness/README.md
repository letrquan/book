# Adaptive Harness Evaluation Contract

This directory freezes the Phase 0 evaluation contract. It is offline evaluator data and support
code, not a live harness mode. The corpus is limited to evaluator-owned, trusted built-in,
single-agent, non-adversarial work. Tier C surfaces remain blocked.

## Frozen Decisions

| Question | Phase 0 decision |
| --- | --- |
| Experimental unit | One root request in one fresh fixture materialization. |
| Clustering | Attempts are clustered by case, project, and session; attempts are never treated as independent user tasks. |
| Assignment | Paired arms use randomized order, the same runner-owned date, and the same stable seed. |
| Repeated trials | At least three attempts per arm and five repeated base controls before a comparative claim. |
| Estimand | Per-case and per-task-class difference in externally graded success; cost and latency are guardrails, not a scalar reward. |
| Minimum effect | The case-declared effect must exceed the measured noise floor. Default machine-verifiable floor is 0.15 absolute success rate. |
| Inference | Two-sided alpha 0.05, target power 0.80, Holm correction across the predeclared primary family, and non-inferiority tests for guardrails. |
| Missingness | Unknown, timeout, evaluator failure, and setup failure remain in the denominator and are reported by arm. Differential missingness blocks promotion. |
| Human evidence | Two independent blinded reviewers are required. A score spread above one point is disagreement and remains unknown pending adjudication. |
| Model identity | Requested and provider-response model identities must both be present. Alias-only or requested-only identity is ineligible. |
| Trusted execution | Phase 0 uses file/diff predicates and evaluator-owned materialization. Project commands, hooks, integrations, and adversarial processes remain blocked. |
| External isolation | Fresh directories isolate state but are not a security sandbox. Tier C requires a separately verified container-grade runner. |

The primary hierarchy is machine-verifiable correctness, safety guardrails, unknown rate, cost, then
latency. Equivalent results choose the simpler workflow. No aggregate can override a failed
security guardrail or a task-class regression outside its declared non-inferiority margin.

## Corpus

`manifest.json` pins the corpus, evaluator, arms, model slices, statistics, trust boundary, and
comparison identity fields. Every case is a recursively strict versioned document under `cases/`.
Fixtures under `fixtures/` contain no private user data and are reset only by fresh
rematerialization.

| Slice | Cases | Evidence |
| --- | --- | --- |
| Read-only | `read-only-inventory`, `untrusted-input-boundary` | Exact final files |
| Simple edit | `simple-edit-heading` | Exact final file |
| Bug fix | `bug-fix-sum`, `tool-contract-recovery` | Exact final files |
| Multi-file | `multi-file-rename` | Exact files plus required deletion |
| Review | `review-auth-boundary` | Blind human rubric plus artifact presence |
| Research | `research-source-synthesis` | Blind human rubric plus artifact presence |
| Long horizon | `long-horizon-resume` | Exact preserved checkpoint decision |
| Tier C boundaries | `workspace-trust-boundary`, `external-integration-boundary` | Observational and blocked |

The targeted coverage tags include context exhaustion, compaction, checkpoint/resume, preserved
failures, malformed or partial tool results, retries, oversized output, instruction-like repository
text, credential exposure attempts, poisoned evidence, workspace trust, lifecycle parity, origin
binding, and external cleanup. Live timeout, cancellation, backpressure, reconnect, network, and
credential trials remain unavailable until the corresponding runtime and Tier C boundaries exist.

Capability-routing fixtures must preserve these exact intent probes when that slice becomes
runnable:

```text
youtube transcript
web tool
research this deeply
parallel research
spawn explorer
inspect git history
```

The matching negative slice is local-only and must not call web or delegation tools or preload Git,
session-history, notebook, skill, or integration capabilities. Routing experiments use
`current-routing`, `hybrid-routing`, `child-eager-routing`, and `adaptive-explorer-routing`; they are
not workflow arms and cannot be reported as workflow improvements.

## Arms and Identity

- `A/base` is current Book behavior with future harness mode off and `settings.agents.mode` off.
- `B/fixed` is a manually selected fixed workflow after Phase 3.
- `C/adaptive-shadow` records a selector decision without applying it after Phase 6.
- `D/candidate` is unavailable until Phase 8.

A comparison is invalid unless corpus, evaluator, fixture revision and digest, provider, requested
and resolved model, model config, runtime, environment, tool surface, policy, budget, pricing,
evaluation date, and random seed all match. Capability experiments additionally freeze prompt
layers, skill registry and activation, context policy, model adapter, hook/verifier policy, root
exposure, intent preload, child allowlist, discovery ranking, and delegation policy as separate
component fingerprints.

Fingerprints use canonical JSON with sorted object keys and SHA-256. Reports retain component fields
beside aggregate digests. Paths, environment values, credentials, prompts, repository contents, and
tool output are excluded unless a fixture explicitly defines a safe bounded value.

## Outcomes and Reports

Machine predicates grade final state; the tested model never grades itself. Required verifier
failure is `failure`, missing required evidence is `unknown`, and optional verifier failure is
`partial`. Provider evidence must also pass the shared fail-closed run eligibility gate. A
deterministic verifier cannot override incomplete accounting, unknown pricing, unverifiable model
identity, partial ambient evidence, a non-completed terminal state, or a run-boundary mismatch.

User acceptance and correction are external labels, not automatic success:

- `accepted`: explicit acceptance tied to the exact trial and artifact digest;
- `corrected`: a user modification tied to changed paths, without assuming the original was wholly wrong;
- `rejected`: explicit rejection tied to the exact trial;
- `unknown`: no attributable response, ambiguous response, expired label, or missing identity.

Reports conform to `report-schema.json`, show raw attempts and per-slice counts before aggregates,
retain verifier and eligibility reasons, and link the applicable HarnessCard. Generated reports go
under `reports/` and are ignored unless a deliberately curated redacted report is moved elsewhere.

## Noise and Promotion Rules

Run at least five repeated `A/base` controls in randomized positions before reading candidate
results. Record setup failure rate, unknown rate, success variance, mean latency, and latency sample
standard deviation. The detectable success-rate delta is the larger of 0.10 or twice the observed
binomial standard error. An effect at or below that floor is insufficient evidence.

Promotion requires all of the following:

1. The predeclared primary family passes after Holm correction.
2. Every safety guardrail has zero violations.
3. Correctness, unknown rate, cost, and latency satisfy their case non-inferiority margins.
4. Missingness does not differ materially by arm.
5. The local held-out corpus passes; an external adapter cannot substitute for it.
6. The HarnessCard records the exact comparison identity, limitations, decision, and rollback.

Timeout, cancellation, spawn failure, evaluator failure, incomplete evidence, and human-review
disagreement are distinct raw outcomes. They are never silently removed or converted to failure or
success.

## Trust Boundary

The fixture loader rejects absolute paths, `..` escapes, symlinks, special files, stale versions,
duplicate case IDs, unknown model slices, and unknown schema fields. Materialization verifies the
declared tree digest before and after copying.

The following remain blocked until Tier C is independently verified: project-controlled setup,
reset, cleanup, or verifier commands; hooks; MCP servers; provider endpoints; executable command
expansions; privileged project skills; project subagent definitions; network access; credentials;
and adversarial repositories. Merely adding an observational case does not activate a surface.

## Human Rubrics and Limitations

Rubrics are versioned under `rubrics/`. Reviewers must be independent of the tested arm and blind to
arm identity when practical. Model judges may assist with evidence organization but cannot be the
sole promotion authority.

Architecture taste, maintainability, broad research quality, user satisfaction, realistic live
interruption, provider cache effects, network quality, credential safety, and multi-agent behavior
are not fully automatable in this corpus. They remain rubric-based, observational, or blocked.
Personal session transcripts and private historical runs are excluded.

## Portability Adapters

Descriptors under `adapters/` reserve separate result namespaces for one coding benchmark and one
long-horizon terminal benchmark. An adapter must preserve the external evaluator, lock the same
comparison fields, disclose benchmark-specific isolation, and remain separate from local promotion
statistics.
