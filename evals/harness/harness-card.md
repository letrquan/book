# HarnessCard v2

## Claim and disposition

- **Design class:** `calibration | confirmatory`
- **Claim authority:** `none | promotion-eligible`
- **Exact claim and enabled slice:** `<required>`
- **Machine-derived disposition and reasons:** `<required>`
- **Evidence date / expiry / revalidation triggers:** `<required>`
- **Immutable report / preregistration references:** `<required>`

Calibration cards must say `claim authority: none` and `disposition: calibration-only`.

## Identities

- **Evaluator release / build provenance / analysis / report-schema digests:** `<required>`
- **Worker registration / host attestation / broker digests:** `<required or explicitly unavailable>`
- **Verifier and rubric release digests:** `<required>`
- **Corpus content version/digest:** `<required>`
- **Split role/version/membership digest and query-ledger state:** `<required>`
- **Candidate workflow/policy digest:** `<required for confirmatory>`
- **Strongest eligible fixed baseline digest and held-in selection method:** `<required for confirmatory>`
- **Compatibility-cell digest and complete role-aware component manifest:** `<required>`

## Experimental design

- **Experimental, matched-block, and cluster units:** `<required>`
- **Independent held-out families / repetitions per family:** `<required>`
- **Planned/enrolled/completed/valid/invalid/retried blocks:** `<required>`
- **Retained block/outcome ledger and raw-count reconciliation:** `<required>`
- **Matched held-in A/A blocks and noise estimates:** `<required>`
- **Randomization/order schedule, fixed horizon, and retry budget:** `<required>`
- **Planned/achieved power, Holm family/alpha/query spending:** `<required>`
- **Every proposed sibling hypothesis and Holm rank/result:** `<required; none may be hidden>`
- **Primary point estimate, adjusted interval, and decision effect:** `<required>`

## Outcomes and guardrails

- **Raw terminal counts by arm:** success, task failure, budget exhaustion, runtime failure,
  timeout, missing artifact, execution/user cancellation, unknown, missing outcome, evaluator/setup/
  identity/integrity/cleanup failure
- **Intention-to-treat denominators and worst-case missingness sensitivity:** `<required>`
- **Protected success (`-0.05`) result:** `<required>`
- **Unknown / timeout / evaluator-or-missing (`+0.02` each) results:** `<required>`
- **Mean cost / total tokens / median and p95 latency (`+25%` each) results:** `<required>`
- **Human rubric (`-0.25`) result or typed not-applicable:** `<required>`
- **Zero-tolerance security/integrity violations:** `<required; must be zero for promotion>`
- **Rubric calibration/reliability/adjudication summary:** `<required when applicable>`

## Trust, limitations, and rollback

- **Fresh fixture/Book home/tool-discovery/process state and cleanup:** `<required>`
- **Order/cache/rate-limit/concurrency/retry diagnostics:** `<required>`
- **Filesystem/network/process/broker enforcement status:** `<required>`
- **Authenticated evaluator/worker/broker/final-snapshot attestation subjects:** `<required>`
- **Leakage/duplicate/family-isolation and sample-ratio checks:** `<required>`
- **Unsupported slices and portability limitations:** `<required>`
- **Owner / independent approval provenance:** `<required>`
- **Exact rollback artifact, target, and trigger:** `<required>`
- **Anti-drift answer:** Does evidence show better externally verified outcomes rather than more
  agent activity?

Evidence is valid only for the exact recorded compatibility cell. It does not transfer to another
model, provider, adapter, task class, risk class, evaluator, tool surface, isolation tier, corpus, or
split. External benchmark results remain separate and cannot replace the local sealed gate.
