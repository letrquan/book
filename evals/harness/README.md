# Adaptive Harness Evaluation Contract

This directory contains Phase 0 evaluator data. It is not a live harness mode and carries no
promotion authority by itself. The current 11 cases are `calibration-public-v1`; their three
attempts per arm and five repeated controls are smoke/calibration counts only.

## Authority

Phase 0 is data-only. Cases may declare prompts, evaluator-owned fixture data, expected artifacts,
and pure post-run predicates. They cannot declare setup/reset/cleanup commands, command verifiers,
project tests, scripts, network access, raw credentials, arbitrary skills, or subagents.

The generic process helper is explicitly `designClass: calibration` with `claimAuthority: none`.
Provider-grade evidence remains unavailable until an exact packaged worker, dependency/module
identity, provider broker, and host-attested filesystem/network/process boundary exist. Project or
adversarial execution remains Tier C-blocked.

A shaped attestation object is not authority. The registered-worker assessor requires a host-owned
authentication verifier, checks the attestation statement digest, and rejects symlinked or
non-canonical executable, entry, loader, lock, or evaluator-package artifacts. Without that trusted
host integration, the result remains calibration-only.

## Public calibration corpus

`manifest.json` pins:

- corpus and split content identities;
- evaluator source identity and its unpackaged calibration status;
- all case files, arms, exact model slices, calibration statistics, blocked authorities, and
  component-level compatibility fields;
- the two content-addressed human rubric artifacts; and
- hard confirmatory floors that cannot be satisfied by this public corpus.

Every case pins its case/project/generator/relationship family, normalized regular-file manifest,
fixture tree digest, calibration-only repeated-trial rule, compatibility profiles, budgets,
file-only tools, per-outcome class/authority, verifier release, and known unknowns.

| Slice | Calibration cases | Evidence disposition |
| --- | --- | --- |
| Read-only | `read-only-inventory`, `untrusted-input-boundary` | Pure file predicates; calibration only |
| Simple edit | `simple-edit-heading` | Pure file predicate; calibration only |
| Bug fix/tool recovery | `bug-fix-sum`, `tool-contract-recovery` | Pure file predicates; calibration only |
| Multi-file | `multi-file-rename` | Exact files plus changed-path guardrail; calibration only |
| Review | `review-auth-boundary` | Machine artifact guardrail plus calibrated-rubric contract; rubric remains calibration only |
| Research | `research-source-synthesis` | Machine artifact guardrail plus calibrated-rubric contract; rubric remains calibration only |
| Long horizon | `long-horizon-resume` | Static checkpoint preservation; calibration only |
| Trust boundaries | `workspace-trust-boundary`, `external-integration-boundary` | Observational and Tier C-blocked |

The loader rejects stale versions, duplicate IDs, unknown fields/model slices, unpinned rubrics,
absolute/traversing/nonportable paths, case or Unicode collisions, `.git`, symlinks/junctions,
hard links, special or executable files, and file/count/byte overflow. It validates source and
destination tree identities and rechecks the source after copy.

## Human rubrics

The JSON files under `rubrics/` are authoritative. Markdown files are readable summaries. A
decision-bearing result requires an immutable privacy-reviewed packet, two authenticated calibrated
blind independent human primary reviewers, retained per-dimension ratings/evidence, current
production reliability, and bounded blind third-review adjudication when needed.

The packet digest covers the exact allowed artifact/reference view. Reviewer qualification and
assignment-batch versions are pinned; calibration sets are locked, family/holdout-disjoint,
anchor-stratified, near-threshold and hard-failure complete; production assignments attest balance,
pre-adjudication reliability, blind duplicates, and retained reviewer effects. Ratings outside the
packet, duplicate dimensions, stale timestamps, unlinked adjudication, and unnecessary third reviews
are typed `unknown`.

Frozen reliability thresholds are:

- at least 30 calibration artifacts;
- ordinal Krippendorff alpha at least `0.80`, with a 95% lower bound at least `0.67`;
- at least 90% anchor pass/fail agreement;
- 100% seeded hard-failure detection; and
- at least 10% blind duplicate assignments.

Missing, stale, mixed, unblinded, dependent, drifted, unresolved, or model-only evidence is
`unknown`. Human success cannot override machine, identity, safety, integrity, permission,
credential, or protected-path failure. `boundary-evidence-v1` is observational regardless of
reviewer count.

## Confirmatory contract

`confirmatory-corpus-contract.json` reserves `phase0-confirmatory-v1` without fabricating membership
or promotion readiness. It defines disjoint `design-held-in` and `promotion-sealed` roles. A real
campaign requires family-level isolation, at least 20 independent held-out families, at least five
complete matched repetitions per family, at least 20 matched held-in A/A blocks before sizing, and
at least 80% power at the Holm-adjusted alpha. Power analysis may require more.

Every instantiated case must contain at least two regular files, a positive final-state content
predicate, and an expected/forbidden changed-path guardrail. The template deliberately contains no
member families, content digest, split digest, or query ledger until a real corpus is independently
constructed and sealed.

The first eligible claim is only:

```text
exact provider/origin/adapter/model
× taskClass=multi-file
× projectRisk=medium
× machine-verifiable
× evaluator-owned data-only fixture
× trusted built-in single agent
× worker network off/provider broker only
```

The candidate must be compared with the strongest eligible fixed baseline selected on held-in or
nested-validation evidence. `A/base` is not substituted for a stronger baseline.

Each compatibility component has one preregistered role: `locked-equal`, `treatment`, `stratifier`,
or `diagnostic`. An undeclared difference or treatment drift invalidates the whole paired block.

## Reports

`report-schema.json` v2 has separate calibration and confirmatory branches. Calibration requires
`claimAuthority: none` and `disposition: calibration-only`; it cannot express `promote`.

Confirmatory reports include preregistration, exact slice and identities, sealed/query-ledger state,
block/family/repetition counts, all raw terminal categories by arm, paired clustered inference,
planned/achieved power, Holm multiplicity, A/A evidence, role-aware compatibility, attestations,
leakage checks, limitations, expiry, rollback, and every guardrail.

The typed writer reconciles raw counts to assigned trials, arm denominators to valid blocks,
completed/valid/invalid counts to the retained block and retry ledger, and planned families to the
fixed horizon. It requires one baseline and one candidate, all preregistered Holm-family results,
per-guardrail adjusted alpha and power, paired discordance and equal-case clustering, A/A noise and
order checks, cache/rate-limit/concurrency diagnostics, authenticated artifact/snapshot subjects,
independent approval, evidence timing, and revalidation triggers. The only treatment component is
the digest-bound preregistered workflow/policy change; all required control identities are
locked-equal components.

The default machine-success practical effect is `+0.15` absolute. Frozen guardrail margins are:

- protected success `-0.05` absolute;
- unknown, timeout, and evaluator/missing rates `+0.02` absolute each;
- mean cost, total tokens, median latency, and p95 latency `+25%` relative each;
- five-point human rubric `-0.25` points; and
- zero security, permission, credential, protected-path, trust, or integrity violations.

`assessPhase0ConfirmatoryPromotion` derives `promote`, `reject`, or `insufficient-evidence`. A report
whose declared disposition/reasons differ is invalid. Unknown and post-assignment missing/evaluator
outcomes remain zero successes in the intention-to-treat denominator and stay visible in their raw
categories.

## External adapters

The SWE-bench Verified and Terminal-Bench 2.1 descriptors under `adapters/` reserve separate
portability namespaces. They do not execute upstream code, remain Tier C-blocked, are not pooled
with the local corpus, and cannot substitute for local confirmatory evidence.

## Generated outputs

Generated reports belong under `reports/` and remain ignored unless a deliberately curated,
privacy-reviewed report is moved elsewhere. Use `harness-card.md` as the durable summary template
for one immutable report. Evidence does not transfer to another model, provider, adapter, task/risk
class, evaluator, tool surface, isolation tier, corpus, or split.
