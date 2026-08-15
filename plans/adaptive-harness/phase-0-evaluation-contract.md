# Phase 0: Freeze the Evaluation Contract

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Verified (2026-08-11 contract-v2)
- **Depends on:** Tier A/B for evaluator-controlled trusted built-in work; Tier C before any
  project-controlled, executable, networked, credentialed, or adversarial evaluation
- **Tracking rule:** Update this status and the parent ledger in the same change.
- **Frozen decisions:** [#46](https://github.com/letrquan/book/issues/46),
  [#47](https://github.com/letrquan/book/issues/47),
  [#48](https://github.com/letrquan/book/issues/48), and
  [#49](https://github.com/letrquan/book/issues/49)

## Objective

Define an evaluation contract that can falsify an improvement claim without granting the candidate,
project, fixture, or model authority over its evidence. Phase 0 creates contract and calibration
infrastructure. It does not activate a harness mode, produce promotion evidence, or weaken Tier C.

`AVAILABLE_HARNESS_MODES` remains `['off']`.

## Frozen Scope

Phase 0 accepts only evaluator-owned data fixtures, a registered trusted built-in single-agent
worker, a non-executable file-tool surface, network off with provider access through a host broker,
and immutable pure post-run verifiers. The current repository does not have the packaged signed
worker, broker, or host enforcement attestation needed for provider-grade authority. Generic child
process runs therefore remain explicitly calibration-only.

The following stay blocked until Tier C is separately implemented and verified:

- project setup, reset, cleanup, test, hook, command, script, compiler, package-manager, notebook,
  native binary, or command verifier;
- project/provider/MCP endpoints, general network access, raw credentials, arbitrary skills,
  project subagents, or model-controlled command expansion;
- mutable repositories, live clones/downloads, symlinks, junctions, reparse/mount points, hard
  links, VCS metadata, special files, or executable fixture files; and
- SWE-bench, Terminal-Bench, or another external adapter that executes its upstream harness.

A fresh directory and child process are reproducibility controls, not a security sandbox.

## Evidence Classes

| Class | Purpose | Allowed disposition |
| --- | --- | --- |
| `calibration` | Exercise schemas, fixture materialization, verifier plumbing, reports, and obvious instability. Three attempts per arm and five repeated controls are smoke counts. | `calibration-only`; never enable, promote, directional benefit, non-inferiority, or “no regression” |
| `confirmatory` | Test one preregistered exact claim on sealed, family-isolated evidence with adequate power and every trust/guardrail gate. | Derived `promote`, `reject`, or `insufficient-evidence` |

Thresholds, sample sizes, exclusions, the candidate, or the baseline cannot be relaxed after target
outcomes are viewed. If the evidence or cost budget cannot meet the preregistered design, the answer
is `insufficient-evidence`.

## Evaluator Trust Boundary

Four authorities remain separate:

1. The immutable evaluator release owns schemas, corpus membership, registered workers, pure
   verifiers, analysis, and build/dependency provenance.
2. The runner host owns fresh roots, materialization, process lifecycle, budgets, broker access,
   snapshots, reports, teardown, and quarantine.
3. The worker may mutate only its allocated workspace through the registered non-executable tool
   surface. It cannot mutate evaluator, corpus, holdout, verifier, policy, or trust records.
4. A verifier runs only after the complete worker tree stops, reads an immutable final snapshot,
   and writes a bounded typed result outside candidate state.

### Registered worker and broker

`src/harness/evaluation/worker.ts` defines the fail-closed registration and host-attestation
contract. Authority requires all of the following:

- an absolute executable, entry module, dependency lock, evaluator release, and transitive identity
  bound to exact digests outside candidate-writable roots;
- a fixed bounded argv array with no shell, PATH lookup, interpolation, response file, or NUL entry;
- an empty environment plus reviewed non-secret and runner-owned keys;
- a fixed file-only tool surface, closed stdin, bounded output and resources, and descendants
  forbidden;
- filesystem, network, and process-tree enforcement verified by an authenticated host attestation;
  and
- worker network off, with any exact provider/origin/adapter/model traffic confined to a pinned
  host broker and credential audience.

Missing enforcement yields `calibration-only`; malformed/digest-mismatched or failed enforcement is
blocked. The generic `runEvaluationProcess` result carries `designClass: calibration` and
`claimAuthority: none` by construction.

## Data-Only Fixture Contract

`calibration-public-v1` contains the existing 11 prompts and tiny fixtures as calibration assets.
Every case is recursively strict and pins:

- calibration/split identity and no claim authority;
- case, project, generator, and relationship family IDs;
- exact fixture revision, normalized regular-file manifest, byte lengths, file digests, and tree
  digest;
- three paired smoke attempts grouped under one root/case/project/session cluster;
- the exact model slice, compatibility profiles, budgets, allowed file tools, and expected artifacts;
- per-outcome class and authority plus verifier or rubric release identity; and
- limitations and known unknowns.

The loader rejects stale versions, duplicate IDs, unknown fields/model slices, absolute/traversing or
non-NFC paths, case/normalization collisions, reserved names, alternate data streams, `.git`,
symlinks/junctions/reparse points, hard links, special or executable files, and file/count/byte
limits. It validates the source before copying, copies into an empty destination, validates the
destination, and revalidates the source after copying. Reset always destroys and rematerializes a
fresh root.

Only regular-file existence/absence, exact text/digest, schema, and expected/forbidden changed-path
predicates are machine authority. There is no command verifier in the Phase 0 schema. A
confirmatory verifier call also requires a matching read-only final-snapshot digest plus proof that
the worker and descendants stopped.

## Outcome Classes and Human Review

Every declared outcome, not the entire task, is classified independently:

- `machine-verifiable` may establish success or a guardrail only after identity and eligibility
  pass;
- `human-rubric` may affect only a separately preregistered review/research slice after the complete
  protocol below; and
- `observational` remains diagnostic and has no decision authority. A visible security/integrity
  violation still trips the applicable zero-tolerance gate.

The authoritative rubric artifacts are JSON, immutable, versioned, content-addressed, and pinned to
an evaluator release. `review-quality-v1` and `research-quality-v1` remain calibration-only until a
real reviewer pool and confirmatory slice exist. `boundary-evidence-v1` remains observational and
Tier C-blocked.

A decision-bearing human result requires:

- a canonical privacy-reviewed evidence packet that excludes arm, workflow, model/provider,
  transcript/self-report, cost, latency, tool trace, and other ratings;
- two authenticated, calibrated, blind, conflict-free, independent human primary reviewers with
  distinct pseudonymous IDs and per-dimension evidence references;
- calibration on at least 30 separate artifacts, ordinal Krippendorff alpha at least `0.80` with a
  95% lower bound at least `0.67`, at least 90% anchor agreement, 100% seeded hard-failure detection,
  and at least 10% blind duplicates;
- production-batch reliability and drift checks at the same thresholds; and
- when primaries disagree, one equally calibrated blind third reviewer, median dimension scoring
  only where two reviewers are within one point, majority binary criteria, no overwritten raw
  ratings, and no post-hoc consensus meeting.

Missing, stale, mixed, unblinded, dependent, unauthenticated, drifted, unresolved, or model-only
review evidence yields a typed `unknown`. A human pass cannot override a machine, identity,
security, integrity, credential, permission, or protected-path failure.

## Experimental Design

One experimental unit is one root request under one arm in a fresh fixture, Book home, session/tool
state, and process state. Child/resume lineage stays inside that unit. The offline matched block is:

```text
case × fixture revision × exact model × target slice × compatibility cell × repetition seed
```

Every arm receives a separate fresh environment. Two-arm order is balanced `AB`/`BA`; larger designs
use a balanced Latin/Williams schedule. Arms are interleaved over clock time with the same account,
region, concurrency, cache/rate-limit policy, date, seed, budgets, evaluator, and compatibility
fields. Once any arm starts, every scheduled arm is enrolled. Only a whole block may be retried under
a preregistered retry budget, and original outcomes remain visible.

The primary estimand is the equal-case-weighted, clustered, paired intention-to-treat difference in
externally verified success probability against the strongest eligible fixed baseline selected on
held-in or nested-validation evidence. `A/base` is only a compatibility reference when a stronger
fixed baseline exists. Repetitions reduce run noise but do not create independent task diversity.

Before confirmatory sizing, collect at least 20 matched held-in A/A blocks in the exact compatibility
cell. The decision effect is the larger of the preregistered practical effect and the upper A/A noise
bound. The default machine-success practical effect is `+0.15` absolute.

Each proposed confirmatory slice requires at least 20 independent held-out case families, at least
five complete matched repetitions per family, and at least 80% power at the Holm-adjusted alpha.
These are floors; conservative power analysis may require more.

Promotion requires both an adjusted benefit interval excluding zero and a point estimate meeting the
decision effect. Confirmatory inference is fixed-horizon with Holm family-wise error control at
`0.05`. Every proposed sibling slice stays visible.

### Guardrails

| Guardrail | Frozen maximum regression |
| --- | ---: |
| Protected/non-target success | `-0.05` absolute |
| Unknown rate | `+0.02` absolute |
| Timeout rate | `+0.02` absolute |
| Evaluator-failed/post-assignment missing rate | `+0.02` absolute |
| Mean cost and total tokens | `+25%` relative |
| Median and p95 latency | `+25%` relative |
| Five-point human rubric | `-0.25` points |
| Security, permission, credential, protected-path, trust, or integrity violation | zero events |

Guardrails use simultaneous one-sided non-inferiority inference with adequate power. A passed primary
endpoint cannot compensate for a failed or unknown guardrail.

### Raw outcomes and missingness

Raw terminal categories are retained before mapping. Post-assignment task failure, budget exhaustion,
runtime failure, timeout, missing artifact, execution cancellation, unknown, missing outcome, or
evaluator failure contributes zero in the intention-to-treat success estimand and remains separately
counted. A pre-randomization setup failure with no started arm is not enrolled but remains in the
infrastructure report. Identity/integrity failure invalidates the whole comparison block. A live
user cancellation remains assigned and visible.

No missing-at-random assumption is allowed. Promotion also requires worst-case sensitivity with
candidate missing outcomes as failures and baseline missing outcomes as successes.

## Corpus Roles and Compatibility

`evals/harness/confirmatory-corpus-contract.json` reserves `phase0-confirmatory-v1` but deliberately
contains no fabricated families or sealed membership. It defines:

1. `design-held-in` for A/A characterization, power inputs, baseline selection, verifier/rubric
   calibration, and dry runs, with no promotion authority; and
2. `promotion-sealed` for one use after candidate, baseline, hypotheses, schedule, analysis, and
   query ledger lock.

Family assignment is by relationship group. Project/fixture ancestry, shared bugs/solutions,
templates, generators, prompt transformations, and near duplicates cannot cross public, held-in, or
sealed roles. Leakage or ambiguous ancestry invalidates the split version.

Every comparison component is preregistered as exactly one of `locked-equal`, `treatment`,
`stratifier`, or `diagnostic`. Component values, source, version, and digest remain beside the
overall compatibility-cell digest. Any undeclared difference or treatment drift invalidates the
whole paired block.

## Reports and Dispositions

`report-schema.json` v2 is a two-branch Draft 2020-12 schema:

- the calibration branch requires `claimAuthority: none` and
  `disposition: calibration-only`; it has no promotion value; and
- the confirmatory branch requires the preregistration, sealed identities, raw outcomes by arm,
  clustered campaign counts, power/multiplicity inference, all guardrails, role-aware compatibility,
  trust attestations, leakage/query checks, expiry, limitations, and rollback target.

The confirmatory writer additionally reconciles raw counts, arm roles and denominators, fixed-horizon
block arithmetic, invalid/retry records, and family repetitions. It binds the A/A noise estimate to
the decision effect; records paired discordance, every Holm-family result and query/alpha spend;
requires power and adjusted bounds for each applicable guardrail; and pins execution diagnostics,
attestation subjects, independent approval, evidence dates, expiry, and revalidation triggers. The
only treatment component is the preregistered workflow/policy digest; the complete frozen control
surface is enumerated as locked-equal compatibility components.

`assessPhase0ConfirmatoryPromotion` derives the disposition. A report cannot self-assert promotion.
The Zod contract rejects a disposition or reason list that differs from the derived fail-closed
assessment. Calibration and the current historical corpus can never masquerade as confirmatory
evidence.

A HarnessCard is a durable summary for one immutable report. Evidence never transfers silently to a
different model, provider, adapter, task/risk class, evaluator, tool surface, isolation tier, corpus,
or split.

SWE-bench Verified and Terminal-Bench 2.1 remain descriptor-only, Tier C-blocked portability
adapters. Their future scores stay in separate namespaces and cannot be pooled with or substituted
for the local confirmatory gate.

## Artifacts

```text
src/harness/evaluation/identity.ts        RFC 8785 identities
src/harness/evaluation/contract.ts        case, fixture, verifier, and comparison contract
src/harness/evaluation/review.ts          calibrated human-review protocol
src/harness/evaluation/report.ts          outcomes, designs, reports, and derived dispositions
src/harness/evaluation/worker.ts          registered worker/host-attestation boundary
src/harness/evaluation/runner.ts          explicitly calibration-only process helper
evals/harness/manifest.json               calibration-public-v1 manifest
evals/harness/cases/                      11 calibration cases
evals/harness/fixtures/                   evaluator-owned data-only fixtures
evals/harness/rubrics/                    human rubric documents and JSON artifacts
evals/harness/report-schema.json          report schema v2
evals/harness/confirmatory-corpus-contract.json
evals/harness/adapters/                   descriptor-only external adapters
evals/harness/harness-card.md             durable summary template
```

## Test Matrix

- Strict manifests reject unknown fields, stale identities, duplicate IDs, unpinned rubrics, and
  command verifiers.
- Corpus and split digests bind ordered content/family membership.
- Fixture manifests, rematerialized tree hashes, unsafe paths, symlinks, hard links, special files,
  executable files, collisions, and source-copy races fail closed.
- File and diff verifiers pass/fail/unknown distinctly; optional failure remains visible.
- Confirmatory verification fails without an immutable post-worker snapshot attestation.
- Calibration noise uses five smoke controls and never gains promotion authority; confirmatory
  sizing requires at least 20 matched A/A blocks.
- Comparison identity invalidates every changed locked component while allowing only the declared
  treatment digest to differ.
- Raw unknown/missing/evaluator outcomes remain in intention-to-treat accounting.
- Raw counts equal assigned trials; denominators equal valid blocks; completed blocks reconcile to
  valid/invalid records; retries bind retained originals and cannot exceed the locked budget.
- Calibration reports cannot express promotion; confirmatory reports enforce family/repetition,
  power, Holm, practical-effect, guardrail, trust, leakage, missingness, and zero-tolerance gates.
- Confirmatory reports expose every sibling hypothesis, A/A noise/order evidence, per-guardrail
  power, paired discordance, equal-case clustered analysis, and order/cache/rate-limit/concurrency
  diagnostics.
- Human review covers calibration, drift, two blind reviewers, third-review adjudication, raw
  ratings, hard failures, duplicate identity, packet/rubric identity, and typed unknowns.
- Registered workers require exact artifacts and host attestations; absent enforcement remains
  calibration-only. A manifest-shaped attestation alone is insufficient; a host-owned verifier must
  authenticate its digest/signature envelope and canonical protected artifacts.
- External adapters stay descriptor-only, separate, and Tier C-blocked.

## Verification Record (2026-08-11)

- **Decision:** Phase 0 contract-v2 and its calibration assets are verified. This verifies the
  measurement contract; it is not evidence for a harness, workflow, model, or provider promotion.
- **Pinned identities:** corpus
  `sha256:d990f875a247363dc7fae325f2d9f6a11156c8db24b8e948064b5bb07958770f`, split
  `sha256:8ab5d4572b0cfc0b519423d2a9cc53ad6273faa1b318ec6c4742b3a7f615fed3`, pure
  verifier release
  `sha256:a8735dca1237275076f604f23b5a300c025781d29a6eec0b4197c7ef0f5b002d`, review rubric
  `sha256:1d567e7154c6047fdef5bba486544d731f06962ab7a8f6d0ffc1e0e8040341ea`, and research
  rubric `sha256:a445e10a5e673b2c6efe282486911b76d8e8e9e2a003c5f5b1c0277d5d8bb9ee`.
- **Aggregate gate:** `npm run check` passed formatting, full lint, strict type checking, and
  architecture checks; the unit tier passed 185 files with 1,858 tests passed and 5 skipped; the
  contract tier passed 4 files with 31 tests passed.
- **Focused and artifact gates:** the focused evaluator suite passed 6 files and all 50 tests;
  targeted evaluator lint, `npm run build`, Draft 2020-12 report-schema validation, and
  `git diff --check` passed.
- **Final audit hardening:** raw arm and block accounting, fixed-horizon completion, A/A noise,
  sibling-hypothesis visibility, per-guardrail power, execution diagnostics, compatibility roles,
  attestation authentication, rubric packet/qualification/adjudication identity, and fixture entry
  bounds fail closed under focused regressions.
- **Integration diagnostic:** 6 of 7 integration files completed with 70 tests passed and 7 skipped.
  `src/tui/tui-integration.test.ts` had 13 host-sensitive startup-animation timeouts while waiting
  for `Ask me anything.` This known TUI limitation does not exercise the offline Phase 0 contract
  and is not claimed as passing or promotion evidence.
- **Authority and scope:** no provider trial, confirmatory corpus membership, sealed campaign,
  promotion claim, worker/broker host attestation, or Tier C execution is represented by this
  source change. Tier C remains blocked and `AVAILABLE_HARNESS_MODES` remains `['off']`.

## Exit and Rollback Gates

**Exit gate:** The v2 contract and calibration assets pass formatting, lint, strict type checking,
architecture checks, focused evaluation tests, unit and contract tiers, build/schema validation, and
`git diff --check`. Calibration is structurally non-promotional, every missing authority fails
closed, and the exact confirmatory claim can be falsified without broadening its slice.

**Rollback gate:** Revert contract-v2 as one logical change if it permits calibration promotion,
accepts executable/project authority, loses raw missing outcomes, relaxes a frozen threshold, or
cannot reproduce the pinned corpus/fixture/rubric identities. Runtime remains `off`; no data
migration or live rollback is needed.

**Intent check:** Are we measuring better externally verified outcomes rather than more agent
activity?

## Proposed contract-v3 amendments (2026-08-14)

These are **proposals**, not applied changes. The contract-v2 verification record above stands
unmodified; each amendment below requires its own change and verification packet before it is
binding. Evidence: [External Evidence Review](external-evidence-2026-08.md).

### A4 — `pass^k` as a declared guardrail

The primary estimand is a difference in mean verified-success probability. A candidate that raises
the mean while raising variance can win on that estimand and be worse to use, because a coding agent
is experienced as a sequence of attempts rather than as an average. Adopt `pass^k` — the probability
that all k trials of a case succeed — as a declared guardrail alongside the primary endpoint. At 90%
per-trial success, `pass^8` is 57%, so the two metrics can disagree sharply.

The repetitions required to estimate it are already mandated (at least five complete matched
repetitions per family), so this adds analysis, not sampling. The guardrail maximum regression must
be preregistered like every other row in the guardrail table.

### A5 — Preregistered variance reduction

Permit pre-experiment covariate adjustment (CUPED-style) and multiple-answer resampling as
variance-reduction methods, on the condition that the method, covariate, and estimator are
preregistered before any target outcome is viewed. Given the sizing floors (at least 20 independent
held-out case families and at least five matched repetitions per family at 80% power), variance
reduction is likely the difference between an affordable confirmatory campaign and an unaffordable
one. An unregistered variance-reduction choice made after seeing outcomes is a threshold relaxation
and is already forbidden.

### A6 — Harness-disclosure coverage and comparison regime

Harness variance has been measured at roughly 8× model variance on long-horizon coding tasks. Two
consequences:

1. Audit the `locked-equal` compatibility-component enumeration for coverage of the seven harness
   layers now used as a disclosure standard in the literature — execution (runtime substrate,
   sandboxing, timeouts, step budgets), tool (list, schemas, error formats, retry), context (window
   cap, compression, retrieval, memory), scheduling (loop, stopping rules, escalation), observability
   (logged artifacts, traces, checkpoint retention), verification (validation, self-checking,
   anomaly detection), and governance (permissions, allowlists, side-effect boundaries). Any layer
   with no corresponding declared component is an undeclared difference waiting to happen.
2. A confirmatory report that compares across models must declare its regime: **locked-harness**
   (one harness applied to all arms) or **factorial** (model and harness both varied). A factorial
   report must additionally publish model variance per harness, harness variance per model, the
   aggregate ratio, and the count of ranking reversals.

### A7 — Impossible-by-construction negative control

`calibration-public-v1` has no case whose declared outcome cannot be satisfied honestly, so a worker
that defeats a verifier and a worker that succeeds produce the same report shape. Add impossible
cases whose only passing path is illegitimate. A reported success on an impossible case trips a
**zero-tolerance** guardrail in the same class as a security, permission, credential, protected-path,
trust, or integrity violation: it invalidates the campaign rather than lowering a score.

This must be checked against the recursively strict fixture schema; if an impossible case is not
currently expressible, the schema change is part of the amendment. See
[experiment E6](experiments.md#e6--impossible-case-negative-control).

### A8 — SWE-bench Verified descriptor downgrade

The external adapter section currently frames SWE-bench Verified and Terminal-Bench 2.1 as
descriptor-only portability checks. Retain Terminal-Bench on those terms. Downgrade SWE-bench
Verified to **diagnosis-only, contamination-suspect**, and record beside it that solution leakage and
test defects have been reported at material rates and that at least one major lab has publicly
stopped using it as a frontier measure. Also record that a successor benchmark built explicitly for
contamination resistance still leaked intended fixes through ordinary VCS history in its containers
— which is direct external validation of this phase's rejection of `.git`, VCS metadata, symlinks,
hard links, and executable files in materialized fixtures.

Harbor's container-per-trial architecture (fresh container provisioned per task, agent injected,
traces collected) remains the reference shape for the Tier C runner.

### A9 — Reproducibility identity: no bitwise claim over a hosted endpoint

Add to the reproducibility identity list an explicit statement that bitwise reproducibility is
unavailable through a hosted provider. Greedy decoding is not deterministic in production serving:
kernel numerics vary with the server's batch size, which varies with unrelated concurrent load, so
identical requests can diverge mid-generation. The existing controls — clock-interleaved arms,
matched blocks, repetition seeds — are the correct mitigation and must be described as *managing an
irreducible provider-side variance component*, never as achieving determinism. The A/A noise bound
required before confirmatory sizing is partly a measurement of this component.

### Amendment status

| ID | Amendment | Blocking? | Depends on |
| --- | --- | --- | --- |
| A4 | `pass^k` guardrail | No — additive analysis | [E3](experiments.md#e3--passk-recomputation-on-existing-evaluator-data) |
| A5 | Preregistered variance reduction | No | — |
| A6 | Harness-disclosure coverage and regime | No | — |
| A7 | Impossible-case negative control | Yes for any Tier C confirmatory work | Fixture schema check |
| A8 | Adapter downgrade | No | — |
| A9 | Reproducibility statement | No | [E2](experiments.md#e2--aa-noise-floor-characterization) |
