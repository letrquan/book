# Adaptive Harness Experiment Backlog

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Evidence input:** [External Evidence Review (2026-08-14)](external-evidence-2026-08.md)
- **Status:** Proposed — no experiment below is authorized by this file alone
- **Created:** 2026-08-14

> Every entry inherits the parent plan's invariants. An experiment is not a phase: it may not change
> a phase status, enable a harness mode, broaden Tier C, or produce promotion evidence. Unless an
> entry says otherwise, its output is `calibration` under the Phase 0 evidence classes, with
> `claimAuthority: none` and `disposition: calibration-only`.

## Why this file exists

The plan is strong on what must be proved before behavior changes and thin on what can be *learned
cheaply right now*. Phases 3A onward are blocked on security preconditions that are a substantial
project in themselves, so the useful question is which measurements and spikes can proceed in
parallel without consuming the sealed corpus or weakening a gate.

Each entry declares a kill criterion. An experiment that cannot be killed is a feature request.

## Priority summary

| ID | Experiment | Unblocks | Tier | Cost | Provider spend |
| --- | --- | --- | --- | --- | --- |
| E1 | SQLite durability backend spike | Phases 5-7 (hard stop today) | A/B | Medium | None |
| E2 | A/A noise-floor characterization | Phase 0 confirmatory sizing | A/B | Low code, real spend | **Yes** |
| E3 | `pass^k` recomputation on existing evaluator data | Phase 0 outcome vocabulary | A/B | Low | None |
| E4 | **Guidance-detectability pre-check** | Go/no-go for Phases 4-7 | A/B | Medium | **Yes** |
| E5 | Replay provider as a seam implementation | Phase 6 replay; deterministic arms | A/B | Medium | None |
| E6 | Impossible-case negative control | Phase 0 verifier-gaming guardrail | A/B | Medium | **Yes** (small) |
| E7 | Monotone deny-or-abstain guard prototype | Tier C ceiling invariant | Tier C precondition | High | None |
| E8 | Enforcement-completeness reporting | Per-platform Tier C unblock | Tier C precondition | Medium | None |
| E9 | Context-contribution accounting (read-only) | Phase 3A.5 | A/B | Medium | None |
| E10 | Prompt-zone digest split and cache-churn measurement | Phase 3A.2 | A/B | Medium | None |

E1, E4, and E7 are the three that change what the program can do. Everything else is supporting.

---

## E1 — SQLite durability backend spike

> **Result recorded 2026-08-14: complete, kill criterion not met.** The seam and both backends are
> implemented; a run written through the SQLite backend seals with
> `directorySync: 'verified'` and `evidenceEligibility: 'eligible'`. Byte-parity between backends is
> asserted by test, so the hash chain and sequence accounting are unchanged. The Node floor was
> raised to 22+ (Node 20 reached EOL on 2026-04-30). **Phase 2's permanent-ineligibility dead end is
> closed**; observe-mode evidence can now be promotion-eligible on a host that selects the durable
> backend. Remaining before Phase 2's amendment can be marked verified: real crash injection with
> process kills (the shipped test simulates writer loss in-process), **wiring the backend to a
> setting so it is reachable in production at all**, a decision on whether it becomes the default,
> and a re-measured observation overhead.
>
> An adversarial review of the first implementation found ten defects, all fixed and pinned by test.
> Three are worth carrying forward as design lessons rather than bug fixes: (1) the SQLite backend
> originally asserted all four durability guarantees unconditionally while `PRAGMA journal_mode =
> WAL` silently no-ops on network and FUSE filesystems — the exact fail-open the seam exists to
> prevent, now closed by reading the pragmas back; (2) the read path used a read-write open, which
> **created** a database file inside the append-only evidence tree when asked to read a run that had
> none; and (3) the promotion gate is still entirely writer-asserted — the reader can check that a
> seal does not contradict itself, but it cannot confirm a durability guarantee it did not witness,
> so a host that supplies a lying backend produces a validly signed `eligible` seal. The seal now
> records `backendId` so such seals are at least distinguishable. **Treat backend selection as a
> trusted-host decision, not a user-facing setting, until Phase 5 defines who may assert it.**

**Problem.** Phase 2 reports `directorySync: unavailable` because Node exposes no portable directory
fsync. Every seal is therefore `evidenceEligibility: ineligible`. This is not a temporary
limitation: as written, **no observe-mode evidence can ever become promotion-eligible**, which makes
Phases 5, 6, and 7 unreachable regardless of how well they are implemented.

**Hypothesis.** Placing the ledger behind a durability seam with a `node:sqlite` implementation
yields a truthful `durable` seal without weakening any integrity property, because SQLite's own
durability contract covers the directory-entry problem that Node's `fsync` cannot reach.

**Method.**

1. Extract the current append/seal path in `src/harness/run-store.ts` behind an explicit durability
   interface; keep the existing JSONL implementation as the default.
2. Add a `node:sqlite` implementation storing one row per event, preserving canonical JSON bytes,
   monotonic sequence, and the SHA-256 previous-record hash chain **unchanged** — the chain is
   verified over the same bytes regardless of backend.
3. Verify the seal's durability claim empirically rather than by assertion: crash the writer process
   between append and seal at randomized points and confirm the reader's state classification.
4. Report `evidenceEligibility` from the backend's actual guarantee. A backend that cannot prove
   durability must still report `ineligible`.

**Evidence class.** Infrastructure. No corpus consumed.

**Kill criterion.** Kill if the SQLite path cannot preserve byte-identical canonical records and
chain verification, or if crash injection shows any state the reader classifies as valid but is not.

**Node floor — checked 2026-08-14, resolved.** `node:sqlite` is present on Node 24
(`DatabaseSync`, `StatementSync`, `Session`, `constants`, `backup`) and absent on Node 20. The
project declares `engines: node >=20` and CI exercises Node 20 and 24. So this is **not** a drop-in
default, and the experiment carries a prerequisite decision:

- **Raise the floor to Node 22+.** Node 20 left LTS maintenance in April 2026, so the floor is
  already behind the supported line (verify against the current Node release schedule before
  acting). This makes the durable backend the default and gives every host eligible evidence.
- **Ship it conditionally.** JSONL stays the default; the durable backend is selected when the
  runtime provides it. Evidence eligibility then becomes host-dependent, which is truthful but means
  `evidenceEligibility` varies across machines running the same Book version — an extra
  compatibility component that Phase 0 comparisons must lock.

The first option is simpler and keeps eligibility uniform. Decide it before writing the backend, not
after.

**Note.** `verify-before-use`: the DeepSeek Harness durability contract this is modelled on was read
from documentation, not source.

---

## E2 — A/A noise-floor characterization

**Problem.** Phase 0 requires at least 20 matched held-in A/A blocks in the exact compatibility cell
before confirmatory sizing, and sets the decision effect as the larger of the practical effect
(`+0.15` absolute) and the upper A/A noise bound. That number does not exist yet, so no confirmatory
campaign can be sized.

**Hypothesis.** The A/A noise bound over a hosted provider is materially above zero and is dominated
by provider-side variation the runner does not control.

**Method.** Run the existing `calibration-public-v1` cases with identical arms, clock-interleaved,
same account, region, concurrency, and cache policy, at the repetition count Phase 0 already
requires. Record the paired discordance distribution and the upper noise bound. Separately record
wall-clock and concurrency at each trial so provider-load correlation can be inspected afterwards.

**Evidence class.** `calibration`. Produces a *design input*, not a result.

**Kill criterion.** None — this measurement must exist before Phase 6 regardless of outcome. It
"fails" only by being un-runnable, which would itself be a finding about the runner.

**Expected value.** High, and it is the cheapest way to discover early that the practical effect
floor of `+0.15` is below the noise floor, which would force a redesign of the corpus rather than of
the analysis.

---

## E3 — `pass^k` recomputation on existing evaluator data

**Problem.** The plan's primary estimand is a difference in mean verified-success probability. A
workflow that raises the mean while raising variance can win on that estimand and be worse to use.
τ-bench's `pass^k` — the probability that *all* k trials succeed — is the reliability view; at 90%
per-trial success, `pass^8` is 57%.

**Hypothesis.** Book's existing edit and compaction evaluator runs already contain enough repeated
trials to compute `pass^k`, and the ranking under `pass^k` differs from the ranking under mean
success for at least one comparison.

**Method.** Compute `pass^k` from stored evaluator outputs only. No new runs. Report both metrics
side by side for every existing comparison.

**Evidence class.** `calibration`, retrospective.

**Kill criterion.** Kill if existing runs do not carry enough per-case repetitions to estimate
`pass^k` at any useful k; in that case the finding is that repetition counts must rise before the
metric is adoptable, which is itself worth recording in Phase 0.

---

## E4 — Guidance-detectability pre-check (go/no-go for Phases 4-7)

**Problem — the most important open question in the plan.** Phase 3 shipped three workflows whose
only difference is bounded prompt guidance; its own packet states that no field is enforced outside
the prompt. Phases 4-7 build selection, canarying, and rollout machinery *on top of that difference*.
If the difference is undetectable above the A/A noise floor, that machinery is elaborate
infrastructure for choosing between indistinguishable options — and the correct response is to
redirect effort into Phase 3A's capability substrate, where the enforceable differences live.

Nothing in the plan currently asks this question before building the machinery.

**Hypothesis (falsifiable, stated in the null direction).** The verified-success difference between
`minimal`, `safe-edit`, and `verify-heavy` on the calibration corpus is within the A/A noise bound
measured in E2 — i.e. guidance intensity alone is not detectable at this corpus size.

**Method.** After E2 completes, run the three workflows as arms on `calibration-public-v1` under a
balanced schedule, with every Phase 0 compatibility component locked except the workflow policy
digest. Report the paired difference against the E2 noise bound, and report `pass^k` alongside mean
success per E3. If more than one model slice is affordable, run a 2×3 factorial and report the
harness-variance / model-variance ratio in the form arXiv:2605.23950 proposes — Book's own
version of the harness-effect measurement.

**Evidence class.** `calibration-only`, explicitly and permanently. This experiment **cannot**
promote anything: the corpus is the public calibration set, the sample sizes are smoke counts, and
the design class forbids it. Its output is a decision about *where to spend engineering effort*, not
about which workflow is better.

**Kill criterion / decision rule, declared before running.**

- If the observed difference is inside the E2 noise bound: record that guidance intensity is not
  detectable at this scale, and treat Phases 4-7 as blocked on either an enforceable workflow
  surface (Phase 3A/3B, plus amendment A13) or a substantially larger corpus. This is a *successful*
  outcome of the experiment.
- If the difference exceeds the noise bound: this is **not** evidence of benefit — the corpus is
  non-promotional and the sample is a smoke count. It licenses only the design of a confirmatory
  campaign, sized from these variance estimates.

**Anti-drift note.** The temptation this experiment creates is to read a favourable calibration
result as vindication. The Phase 0 contract structurally forbids that, and this entry restates it
because the pressure will be real.

---

## E5 — Replay provider as a first-class seam implementation

**Problem.** Phase 6 requires isolated replay; Phase 0 requires controlling model nondeterminism.
Book has `src/test/scripted-provider`, but it is a test double, not a provider implementation, so
neither requirement has a runtime answer.

**Hypothesis.** A replay provider registered through the same interface as the Anthropic and
OpenAI-compatible clients makes every non-provider change (scheduler, context assembly, tool
surface, prompt zones) exactly reproducible, converting a class of experiments from
provider-spend-bound to free.

**Method.** Record provider interactions from real runs into a canonical fixture format; add a
replay implementation behind the existing provider seam; require exact request-shape matching with
an explicit, loud failure when a replayed request diverges from the recording (divergence is the
signal, not a fallback condition). Fingerprint the recording's identity into the ambient snapshot.

**Evidence class.** Infrastructure. Replay-derived results are `observational` for anything the
model would have decided, and authoritative only for deterministic host behavior.

**Kill criterion.** Kill if request-shape matching cannot be made exact enough to detect a genuine
context change — a replay that silently tolerates divergence is worse than no replay, because it
would certify changed treatments as identical.

---

## E6 — Impossible-case negative control

**Problem.** The reward-hacking literature (ImpossibleBench, SpecBench, EvilGenie) shows coding
agents defeating graders by hard-coding cases, editing the harness, and special-casing visible
tests. `calibration-public-v1` contains no case that is impossible by construction, so a
verifier-gaming worker and an honest worker produce the same report shape.

**Hypothesis.** Adding cases whose declared outcome cannot be satisfied honestly will detect
grader-defeating behavior that the current corpus cannot distinguish from success.

**Method.** Add a small set of cases where the only path to a passing verifier is an illegitimate
one (mutually contradictory required outputs; an expected artifact that cannot coexist with a
forbidden changed path). Any reported success on an impossible case trips a **zero-tolerance
guardrail** that invalidates the whole campaign, in the same class as a security or integrity
violation.

**Evidence class.** `calibration` guardrail. Never a success metric.

**Kill criterion.** Kill if impossible cases cannot be constructed without also being trivially
detectable as traps by the worker, which would make them measure trap-detection rather than
grader-integrity.

**Dependency.** Phase 0's fixture schema must be checked for whether an impossible case is even
expressible under the current recursively strict contract; if not, the schema change is part of this
experiment.

---

## E7 — Monotone deny-or-abstain guard prototype

**Problem.** The plan asks in Phase 3, Phase 3A, and the Tier C gate whether a lower-trust scope can
broaden a ceiling set by a higher-trust scope, and requires ceilings to be "monotonic and truthful on
every entry surface." No mechanism is specified. `src/permissions.ts` composes allow and deny rules
where order and specificity determine the outcome, so monotonicity is currently a documented
intention rather than a checkable property.

**Hypothesis.** Recasting permission evaluation so that a contributing rule source may only **deny or
abstain** — never grant — makes composition order-independent by construction, and monotonicity
becomes provable by property test rather than by review.

**Method.** Prototype the composition in isolation before touching the live evaluator. Property-test
that (a) the result is invariant under permutation of sources, (b) adding any source can only narrow
the effective surface, and (c) no project-, workflow-, skill-, hook-, MCP-, or subagent-scoped source
can widen a user- or policy-scoped ceiling. Compare the prototype's decisions against the current
evaluator over the existing permission test corpus and enumerate every divergence.

**Evidence class.** Infrastructure and security. Not corpus evidence.

**Kill criterion.** Kill if the grant path cannot be confined to a single trusted origin without
breaking documented user-facing allow-rule behavior. In that case record the divergence set as the
concrete cost of the current design, which is still the input Tier C needs.

**Scope warning.** This touches the trusted kernel. It is a prototype and a divergence report, not a
migration; any migration is a separate reviewed change with its own gate.

---

## E8 — Enforcement-completeness reporting and a truthful Windows posture

**Problem.** Tier C is blocked globally, in part because Windows cannot provide real isolation. That
conflates "this platform cannot enforce" with "this capability is unavailable everywhere."

**Hypothesis.** Reporting enforcement as per-backend, per-axis data (`full` / `partial` / `none`
across filesystem, network, and process-tree axes) allows Tier C to open on platforms that can
enforce, while stating Book's Windows position as explicitly as Claude Code states its own — its
Bash sandbox supports macOS and Linux/WSL2 and **does not support native Windows**.

**Method.** Extend the sandbox capability report with per-axis enforcement completeness and the
backend identity that produced it. Make silent unconfined passthrough impossible: an unenforceable
axis must be reported, and the existing `sandbox.failIfUnavailable` policy must key off the reported
value. Document the resulting per-platform Tier C eligibility matrix.

**Evidence class.** Infrastructure and security posture.

**Kill criterion.** Kill if any axis cannot be determined truthfully at runtime; an axis Book cannot
measure must report `unknown` and be treated as `none` for eligibility, and if most axes land there
the reporting adds nothing.

---

## E9 — Context-contribution accounting, read-only

**Problem.** Phase 3A.5 requires context accounting before any retrieval change, and the context
axis is where the literature reports the largest available wins (context rot, just-in-time
retrieval, compaction, note-taking). Book cannot currently answer what fraction of an assembled
context was used.

**Hypothesis.** Recording per-source contribution (kernel, project, memory, repository, tool, web,
user, derived) with token counts, trust class, and reference — **without changing retrieval** — is
enough to compute irrelevant-token ratio, repeated-read rate, and compaction loss on real sessions.

**Method.** Add contribution accounting to the context builder as pure instrumentation. Persist only
bounded references and counts, never raw content, under the existing Phase 2 redaction contract.
Report the three derived metrics over existing observe-mode runs.

**Evidence class.** `observational`. Diagnostic only, no decision authority.

**Kill criterion.** Kill if accounting cannot be added without changing assembled context bytes; the
Phase 3A gate requires `off`-path and baseline provider messages to stay identical.

---

## E10 — Prompt-zone digest split and cache-churn measurement

**Problem.** Phase 3A.2 requires splitting the system prompt into kernel / session-context /
dynamic-policy / task-state zones with independent digests. The stated benefit is that dynamic
values stop invalidating the cached prefix, but the size of that benefit is unmeasured.

**Hypothesis.** A material fraction of current cache-prefix invalidation is caused by values that
belong in a dynamic zone (todos, Git state, workflow policy), and the four-zone split reduces
measured prefix churn without changing flattened provider messages.

**Method.** Compute per-zone digests from existing sessions before changing assembly. Measure how
often each zone changes per turn. Only then implement the split, and assert that flattened messages
remain byte-identical for the `minimal` baseline — Phase 3 already established that assertion, so it
extends rather than invents the gate.

**Evidence class.** `calibration` for cost/latency; `observational` for outcome effects.

**Kill criterion.** Kill if measured churn is already dominated by zones that must be dynamic
anyway, in which case the split remains justified for attribution but not for cost, and it should be
described that way in Phase 3A rather than as a performance improvement.

---

## Explicitly blocked

These are recorded so they are not proposed again without their gate.

| Idea | Blocked by | Note |
| --- | --- | --- |
| Model-written workflow scripts | Tier C | Executes model-authored code; incompatible with the current trust boundary |
| GEPA-style reflective evolution of workflow fields | Phase 8 gates | Requires sealed holdout, bounded query budget, and recomputed complexity accounting first |
| Candidate archive with Pareto retention | Phase 8 gates | Design it in Phase 8; do not prototype against the calibration corpus, which would burn it |
| Project-local `.book/harness/workflows/*.json` | Tier C / Phase 3 deferral | Untrusted repository data as a policy source |
| Multi-agent workflow arms | Phase 3A/3B | Managed agents remain a separate experimental axis; runs with managed children are already Tier-A-ineligible |
| Any external benchmark adapter execution | Tier C | Descriptor-only; SWE-bench Verified additionally contamination-suspect |

## Recording rule

An experiment that runs must record its result in this file with the date, the declared kill
criterion, and whether that criterion was met — **including experiments whose result was "no effect
detected."** A null result that is not written down will be re-run by someone else in three months.
