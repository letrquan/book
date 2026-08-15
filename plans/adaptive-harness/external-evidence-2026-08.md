# External Evidence Review (2026-08-14)

**Scope:** Comparative review of production agent runtimes (DeepSeek Harness, Claude Code, Codex),
current agent-evaluation infrastructure, and the 2024-2026 methodology and workflow-evolution
literature, checked against every phase of this plan.
**Decision:** The plan's direction is confirmed and its bar is raised. Nine findings change specific
phase requirements; five proposed preconditions are added to
[research grounding](research-grounding.md); one finding invalidates a Phase 0 assumption about
external adapters. No phase status changes as a result of this review.
**Relationship to existing reviews:** This document extends
[Research Grounding](research-grounding.md) and
[Agent Capability Research](agent-capability-research.md). Where it conflicts with either, this
document is newer but not automatically authoritative: a conflict must be resolved in the affected
phase's verification packet, not silently.

## Method and confidence

Sources were read as published documentation, abstracts, and reported results. **No external source
code was read.** Findings that would change runtime behavior are marked `verify-before-use` and must
be confirmed against upstream source before any implementation depends on them. Two summaries
arrived with mislabelled headings from the retrieval layer; content attributed below was checked for
internal consistency with the surrounding document, but a single-source claim is still weaker
evidence than a repository test.

One primary source could not be retrieved directly (OpenAI's SWE-bench Verified retirement note
returned HTTP 403); its numbers are attributed to the secondary reports that quote it and are marked
accordingly.

## Finding 1 — The harness is the binding constraint, which raises this plan's bar

`Stop Comparing LLM Agents Without Disclosing the Harness` (arXiv:2605.23950) runs a controlled
factorial experiment over three frontier models and three harness configurations on a 100-task
subset and reports **harness variance of 18.48 pp² against model variance of 2.37 pp², a ratio of
7.80×**, with six ranking reversals across nine model-pair/harness-pair comparisons. Public
leaderboard data in the same paper shows one fixed model (Claude Opus 4.5) ranging 45.9%-55.4% on
SWE-bench Pro depending only on harness.

This is the strongest external confirmation the plan has received: workflow and capability surfaces
really are first-order determinants of outcomes, so a program that measures them is worth building.

It also raises the bar in a way the plan does not yet handle. If harness variance dominates model
variance by ~8×, then any *undeclared* difference between two arms is more likely to explain the
result than the treatment is. Phase 0's `locked-equal` compatibility component list is the right
mechanism, but it is currently enumerated by us; the paper proposes a named disclosure surface,
**ETCSOVG** — Execution, Tool, Context, Scheduling, Observability, Verification, Governance — and
two valid regimes: a *locked-harness protocol* (one harness, all arms) or a *factorial protocol*
that reports model variance per harness, harness variance per model, the aggregate ratio, and the
count of ranking reversals.

**Change required:** Phase 0's compatibility-component enumeration must be checked for ETCSOVG
coverage, and any confirmatory report comparing across models must declare which of the two regimes
it used. See [proposed contract-v3 amendments](#proposed-phase-amendments).

## Finding 2 — Perceived improvement is anti-correlated with measured improvement

METR's randomized controlled trial (16 experienced open-source developers, 246 real issues from
their own repositories, screen-recorded) found developers took **19% longer** with AI tools
available. They had forecast a 24% speedup, and *after experiencing the slowdown* still believed
they had been sped up by 20%.

This is the empirical basis for the plan's central refusal to accept self-report or satisfaction as
evidence, and it should be cited as such rather than argued from first principles. It also carries a
specific warning for Phase 5 and Phase 7: a user-facing feedback channel measuring perceived
improvement is measuring something that was, in the best controlled study available, wrong in sign.

**Change required:** Phase 5's human-feedback contract must state that perceived-benefit ratings are
`observational` with no decision authority, independent of reviewer calibration quality. The
existing rubric protocol already covers blinded artifact review; it does not currently forbid
promoting a satisfaction signal.

## Finding 3 — Temperature 0 is not determinism

Thinking Machines Lab's `Defeating Nondeterminism in LLM Inference` demonstrates that greedy
sampling is not reproducible in production serving: 1,000 completions at temperature 0 produced
**80 distinct outputs, first diverging at token 103**. The cause is not sampling but batch
invariance — matmul, RMSNorm, and attention kernels produce different numerics depending on the
*server's* batch size, which depends on concurrent load from other users. Their batch-invariant
kernel set restores bitwise-identical completions at roughly 2× unoptimized latency cost.

The plan already says "a deterministic fixture is not a deterministic LLM trial," but it treats the
residual as trial noise absorbed by repetitions. That is the correct mitigation and it is not
sufficient as a *description*: run-to-run divergence is partly a function of **provider-side load we
neither control nor observe**, which means it is not exchangeable across arms unless arms are
interleaved in clock time. Phase 0 already requires clock-interleaved arms — this finding is why
that requirement is load-bearing rather than hygienic, and it should be annotated as such.

**Change required:** Phase 0's reproducibility identity list must record that bitwise reproducibility
is unavailable through a hosted endpoint, and the A/A noise floor must be described as containing an
irreducible provider-side component. Any future claim of a "controlled run" over a hosted API is a
claim about interleaving and repetition, never about determinism.

## Finding 4 — External benchmark adapters are worth less than the plan assumes

Phase 0 lists SWE-bench Verified and Terminal-Bench 2.1 as descriptor-only, Tier C-blocked
portability adapters. Two developments weaken SWE-bench Verified specifically:

- OpenAI has published that it no longer evaluates on SWE-bench Verified, citing contamination and
  test flaws. Secondary reports of that note and of the SWE-bench+ analysis (arXiv:2410.06992) give
  **32.67% of successful patches involving solution leakage** (the fix present in the issue text or
  comments) and **59.4% of 138 audited o3 failures caused by test defects rather than model
  limitations**. *(Primary source not directly retrievable; figures attributed to secondary
  reporting — `verify-before-use`.)*
- SWE-bench Pro, built explicitly for contamination resistance using copyleft-licensed corpora,
  **still leaks the intended fix through ordinary `git log -p` / `git show`** in its public
  containers.

The second point is a direct fixture-design validation: Phase 0's loader already rejects `.git`,
VCS metadata, symlinks, and executable files in materialized fixtures. That rejection is not
excessive caution; it is the exact defect shipped by a benchmark built by a well-resourced team
specifically to resist contamination.

Terminal-Bench 2.0 remains a useful *runner* reference: 89 tasks across 16 categories, one fresh
Docker container per task via the **Harbor** harness, which provisions the container, injects the
agent, and collects traces, with 32-100 containers in parallel. That is the shape Phase 0's worker
and Tier C isolation should converge on.

**Change required:** Downgrade the SWE-bench Verified adapter descriptor from "portability check" to
"diagnosis-only, contamination-suspect," and record the contamination evidence beside it. Retain
Terminal-Bench and add Harbor as the reference container-per-trial runner architecture.

## Finding 5 — Verifier gaming is a first-class failure mode, not an edge case

A 2025-2026 literature has formed around agents defeating their own graders: `ImpossibleBench`
constructs tasks whose tests cannot be satisfied honestly, so any pass is an exploit; `SpecBench`
studies reward hacking in long-horizon system-level engineering; `EvilGenie` and `School of Reward
Hacks` taxonomize the strategies — **hard-coding test cases, modifying the test harness, and
special-case logic that satisfies visible tests without implementing the general behavior**. The
reported gap between validation and holdout pass rate grows with task complexity and is larger for
weaker models.

Phase 0's current defense is structural and mostly adequate: verifiers are immutable, pure,
post-run, read an immutable final snapshot, and run outside candidate-writable state, and there is
no command verifier in the schema. Two gaps remain:

1. There is no **negative control**. Nothing in `calibration-public-v1` is designed to be
   unsatisfiable, so a worker that games a verifier produces the same report shape as one that
   succeeds.
2. Phase 3's `verify-heavy` workflow instructs the model to "run declared project verifiers." Under
   Tier C that becomes a workflow whose *stated purpose* is to touch the grading surface. The
   guidance is currently inert, but the eventual enforced version must not let the arm being
   measured also execute the measurement.

**Change required:** Add impossible-by-construction cases to the calibration corpus as a
zero-tolerance guardrail (any reported success on an impossible case invalidates the campaign), and
record in Phase 3 that a workflow may never be the executor of its own verification.

## Finding 6 — The statistical contract has three specific gaps

Phase 0's design (paired, clustered, intention-to-treat, Holm-adjusted, fixed-horizon,
non-inferiority guardrails, worst-case missingness sensitivity) is stronger than any published agent
evaluation reviewed here. Three additions are still available:

| Gap | Source | Effect |
| --- | --- | --- |
| Reliability estimand | τ-bench (arXiv:2406.12045) | `pass^k` — the probability that **all** k trials succeed — decays as p^k, so a 90% per-trial agent is 57% reliable at k=8. Mean success rate hides exactly the instability a coding agent's user feels. |
| Variance reduction | CUPED (Deng, Xu, Kohavi, Walker 2013); Miller, arXiv:2411.00640 | Pre-period covariate adjustment and multiple answers per question reduce variance without more cases. Given Phase 0's floors (≥20 families × ≥5 repetitions), this is the difference between a feasible and an infeasible campaign. |
| Reporting rigor | Miller, arXiv:2411.00640 | Five recommendations — CLT-based standard errors, **clustered** standard errors for clustered questions, variance reduction by resampling, **paired** two-model analysis, and power analysis before collection. Phase 0 already does paired/clustered/power; the resampling recommendation is not represented. |

`pass^k` is the most valuable of the three because it changes what "better" means. The plan's
primary estimand is a difference in verified success probability; a candidate workflow that raises
mean success while raising variance can win on that estimand and be worse to use. Adding `pass^k` as
a **co-primary or guardrail** metric closes that hole, and the required repetitions are already
being collected.

**Change required:** Add `pass^k` to the Phase 0 outcome vocabulary as a declared guardrail; add
CUPED-style covariate adjustment as a permitted, preregistered variance-reduction method; state that
its use must be declared before outcomes are viewed like any other analysis choice.

## Finding 7 — Runtime primitives available from production agents

These are the transferable mechanisms. All are `verify-before-use`.

### 7.1 Durability without directory fsync (unblocks the current hard stop)

Phase 2 honestly reports `directorySync: unavailable` because Node exposes no portable directory
fsync, so **every seal is `evidenceEligibility: ineligible` and no observe evidence can ever become
promotion-eligible.** That is a permanent block on Phases 5-7, not a temporary one.

DeepSeek Harness ships two persistence backends behind one seam: JSONL as checksummed concatenated
Zstandard frames with crash-safe atomic writes, and **one row per event in SQLite via `node:sqlite`**
— with the contract "append resolves only after durability." A SQLite backend delegates the
durability problem to an implementation that already solved it, and `node:sqlite` is in the Node 22+
standard library.

Its crash-recovery rule is also finer than ours: rather than truncating, it **closes an orphaned
turn with a synthetic terminal event** (`turn/end { reason: 'interrupted' }`) and discards only
physically torn fragments. Phase 2 currently treats a truncated tail as a single condition.

### 7.2 Monotone guards make the permission ceiling testable

The plan asks in three places whether a lower-trust scope can broaden a ceiling set by a
higher-trust scope, and 3A's exit gate requires ceilings to be "monotonic and truthful on every
entry surface" — but no mechanism is proposed. `src/permissions.ts` uses allow/deny rules where
order and specificity decide the outcome.

DeepSeek Harness composes permission decisions from **guards that may only deny or abstain, never
allow**, evaluated after a separate approval gate, explicitly "without reordering." Monotonicity
becomes a property of the type, not of the rule set. Approval is separately fail-closed: a single
grant value (`allowed-once`), with missing, non-owning, throwing, or non-conforming answerers all
resolving to `unavailable`.

Claude Code reaches the same invariant differently, through scope precedence: managed policy
settings override user and project settings, `allowManagedHooksOnly` restricts hooks to
administrator-provided ones, `allowedHttpHookUrls` allowlists hook endpoints, and `disableAllHooks`
disables user and project hooks but explicitly not managed ones. Its `PreToolUse` hook contract
returns `deny | allow | escalate` with **exit code 2 overriding a JSON `allow`** — deny-biased
composition again.

### 7.3 Enforcement completeness as reported data, not a binary

Tier C is currently a global block, partly because Windows cannot offer real isolation. Two
production answers exist and they differ instructively:

- **DeepSeek Harness** reports per-backend enforcement completeness as data — `full` or `partial` —
  with Windows ACL and older Landlock ABIs labelled `partial`, and prohibits silent unconfined
  passthrough. It also scopes its sandbox vocabulary to **file effects only** ("network and process
  visibility are outside this vocabulary") and rules that containers, microVMs, and remote execution
  are *sibling capability implementations, not sandbox providers*.
- **Claude Code** declines the problem: the Bash sandbox runs on macOS (Seatbelt) and Linux/WSL2
  (bubblewrap plus an optional seccomp filter), and **native Windows is not supported** — the
  documented answer is to run inside WSL2. Falling back to unsandboxed execution is a separate
  explicit setting (`allowUnsandboxedCommands`).
- **Codex** separates the two axes cleanly: sandbox mode (`read-only`, `workspace-write`,
  `danger-full-access`) is what the agent *may* touch; approval policy (`untrusted`, `on-request`,
  `never`) is when it pauses. Network access is **off by default** under `workspace-write` and is a
  nested opt-in.

Together these say Tier C should not be one boolean. It should be a per-platform, per-axis reported
posture, with Book's own Windows position stated as honestly as Claude Code states it.

### 7.4 A replay provider belongs in the production provider seam

DeepSeek Harness's `ctx.llm` seam admits a replay implementation as a peer of its live providers,
and its test strategy commits session fixtures in a canonical packed-row JSONL layout. Book has
`src/test/scripted-provider`, but it is a test double, not a seam implementation — so Phase 6's
"isolated replay" and Phase 0's LLM-nondeterminism problem have no runtime answer today. Promoting
replay to a first-class provider is cheap, is exercised by the existing evaluation runner, and is a
precondition for honest replay-based counterfactual work.

### 7.5 Trace propagation into subprocesses

Claude Code propagates W3C `traceparent` into Bash and PowerShell subprocesses via the `TRACEPARENT`
environment variable, and into HTTP MCP requests. Book's Phase 2 telemetry mapping stops at the tool
boundary. This is a small, non-behavioral addition that would let tool-spawned work be correlated to
the run that caused it.

### 7.6 Telemetry defaults worth matching, and one worth refusing

Claude Code redacts all content by default and requires per-category opt-in
(`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`,
`OTEL_LOG_RAW_API_BODIES`), truncates content at 60 KB, and exposes explicit cardinality toggles.
This matches Phase 2's posture and confirms it as industry-normal rather than excessive.

DeepSeek Harness takes the opposite approach — its telemetry seam "ships NO rules of its own," so
unmounted deployments export unmodified records, and redaction affects only exported copies while
the canonical log keeps raw content. **Do not adopt this.** Phase 2 redacts before queueing and
hashing, so the ledger never contains raw content at all; that is strictly stronger. Its
`SessionTelemetrySharingStatus` disclosure enum (`full | feedback-only | disabled`) is worth
borrowing as a user-facing affordance, and its rule that operational records **omit sequence
identity so they can never be mistaken for ledger rows** is a clean structural answer to Phase 5's
requirement that agent-authored evidence stay separate from verifier truth.

### 7.7 Delegation: non-inheritance is the safe default

Phase 3 logged "delegated work does not inherit the workflow" as a known gap. Three independent
designs treat non-inheritance as correct:

- DeepSeek Harness: "inheritance is descriptive only" — children get a new flat scope, inherit no
  parent tools, services, or authority; start-time capability requests are validated and **fail
  loud**; delegation depth is durable metadata that bounds recursion.
- Claude Code subagents: own context window, own tool allowlist, own permissions.
- Claude Code agent teams (experimental, off by default): teammates load project context but **not**
  the lead's conversation history, and critically — a message from another agent is treated as
  **untrusted input**, a teammate cannot approve a permission prompt on the user's behalf, and a
  teammate denied an action cannot relay it to another teammate to bypass the check.

That last rule is a prompt-injection and confused-deputy defense Book will need before any
multi-agent axis is evaluated, and it belongs in the trusted-kernel exclusions now rather than in
Phase 9.

### 7.8 Enforceable workflow fields exist, and Book's schema has none of them

Phase 3's own packet records that no field reports enforcement. DeepSeek Harness's workflow engine
demonstrates the host-enforceable subset: `maxTotalAgents` and the subagent provider are **overrides
the script cannot observe or modify**; `parent` attribution is required on every start; metadata is
validated **before the script body executes**; `agentsStarted` counts accepted spawns; disposal
guarantees bounded settlement and child quiescence; and hook misuse throws fatally rather than
degrading to a null result.

Book need not adopt model-written workflow scripts — that is Phase 8 territory and would demolish
Tier C — but delegation depth and a child-spawn cap are host-enforceable today and would give the
Phase 3 schema its first non-guidance field.

## Finding 8 — Book's three workflows do not sit on the recognized axis

Anthropic's `Building effective agents` gives the field's common taxonomy, separating **workflows**
(LLMs and tools orchestrated through predefined code paths) from **agents** (the model directs its
own process), and enumerating five workflow patterns: prompt chaining, routing, parallelization
(sectioning and voting), orchestrator-workers, and evaluator-optimizer.

Book's `minimal` / `safe-edit` / `verify-heavy` are not points on that axis — they are three
intensities of prompt guidance within a single agent pattern. That was a deliberate Phase 3 choice
(comparison instruments, no new parallelism, nothing enforced) and it remains correct for Phase 3.
It matters for Phase 6: if the eventual comparison finds no difference between the three, that is
weak evidence about *workflows* in the field's sense, because all three arms are the same pattern.
The honest framing is that Phase 3 compares **guidance intensity**, and the pattern axis is
unexplored.

`Effective context engineering for AI agents` supplies the mechanisms that would populate a real
context-policy axis for 3A — context rot as an attention-budget problem, just-in-time retrieval over
lightweight identifiers, compaction, structured note-taking, and sub-agent context isolation — and
maps almost exactly onto 3A.5's proposed `relevant` / `structure-first` / `task-pack` / `deep`
policies. That correspondence is a reason to keep 3A.5 as specified.

## Finding 9 — Workflow evolution has a working literature, and a specific trap

Phase 8 is written as if bounded workflow evolution were speculative. It is now an active field with
reported results:

| System | Mechanism | Reported result |
| --- | --- | --- |
| Agent Workflow Memory (arXiv:2409.07429) | Induces reusable workflows from past trajectories, offline or on-the-fly, building complex workflows on simpler ones | +24.6% relative success (Mind2Web), +51.1% (WebArena) |
| AFlow (arXiv:2410.10762) | Workflows as code graphs; Monte Carlo tree search over modifications | +5.7% over the best manual designs; +19.5% over prior automatic methods |
| ADAS | Meta-agent invents agent designs in code space (prompts, tool use, control flow) | Open-ended design search |
| GEPA (arXiv:2507.19457, ICLR 2026 oral) | Reflects on trajectories in natural language; **maintains a Pareto frontier of candidates** rather than hill-climbing a single best | +6% average over GRPO (up to +20%) with **up to 35× fewer rollouts**; +10% over MIPROv2 |
| Darwin Gödel Machine (arXiv:2505.22954) | Agent modifies its own code; validated empirically; keeps an **archive** of agents for open-ended exploration | SWE-bench 20.0% → 50.0%; Polyglot 14.2% → 30.7%; run with sandboxing and human oversight |

Three transferable lessons:

1. **Pareto-frontier candidate retention beats greedy selection.** GEPA's central claim is that
   keeping per-instance winners avoids the local optima that kill greedy prompt updates. Phase 8
   currently describes a single candidate pipeline with a promote/reject decision; an archive is
   cheap and is what both GEPA and DGM identify as the load-bearing component.
2. **Rollout efficiency is the binding constraint, and reflection is far cheaper than RL.** GEPA's
   35× rollout reduction is directly relevant to a project whose candidate budget is limited by
   provider cost. This makes a bounded Phase 8 more feasible than the plan assumes.
3. **The trap is precisely the one the plan already guards.** Every one of these systems selects on
   a validation signal, and the coding-agent reward-hacking literature (Finding 5) shows the
   validation-to-holdout gap widening with task complexity. Phase 8's sealed final holdout, bounded
   query budget, recomputed (never proposer-supplied) complexity accounting, and "no promotion is a
   valid successful outcome" rule are exactly the controls this literature lacks. **Keep them.** The
   reported gains above are validation-selected numbers and should never be cited inside Book as
   expected effect sizes.

## Comparative posture table

| Dimension | Book (current) | DeepSeek Harness | Claude Code | Codex |
| --- | --- | --- | --- | --- |
| Evidence durability | JSONL + hash chain + seal; **always ineligible** (no dir fsync) | JSONL (zstd frames) or SQLite; append resolves after durability | Session transcripts + OTel export | Session/rollout files |
| Redaction default | Before queueing and hashing | Exporter-side only; seam ships no rules | All content redacted; per-category opt-in | Not documented in reviewed pages |
| Permission composition | Allow/deny rules, order-sensitive | Deny-or-abstain monotone guards | Scope precedence + managed policy; hook `deny/allow/escalate`, exit 2 overrides allow | Sandbox mode × approval policy, orthogonal |
| Sandbox honesty | `failIfUnavailable` policy | Per-backend `full`/`partial`, file effects only | macOS/Linux/WSL2 only; **no native Windows** | 3 modes; network off by default |
| Workspace trust | Per-MCP-server approval only | Trusted/user/untrusted strata | Workspace trust dialog + managed policy | Approval policy + workspace roots |
| Delegation inheritance | Observer only, no policy | Descriptive only, fail loud, depth-bounded | Own context/tools/permissions; inter-agent messages untrusted | Not documented in reviewed pages |
| Replay | Test double only | First-class provider seam | Not documented | Not documented |
| Evaluation contract | Calibration/confirmatory split, sealed corpus, Holm, guardrails | **None** (BENCHMARK.md is a stub) | Not published | Not published |

The last row is the one to keep in view: on measurement rigor this plan leads every runtime
reviewed. The gap is in runtime primitives, and that gap is closable by borrowing.

## Proposed phase amendments

Each is recorded in the affected phase file as a dated proposal, not applied to any verification
record.

| # | Change | Phase | Rationale | Cost |
| --- | --- | --- | --- | --- |
| A1 | SQLite evidence backend behind a durability seam | 2 | Unblocks `evidenceEligibility`; hard stop for 5-7 | Medium |
| A2 | Synthetic interrupted terminal on recovery; torn fragments discarded separately | 2 | Finer, preserves more evidence | Low |
| A3 | `TRACEPARENT` propagation to tool subprocesses | 2 | Correlates spawned work to its run | Low |
| A4 | `pass^k` as a declared guardrail metric | 0 | Mean success hides instability users feel | Low |
| A5 | Preregistered CUPED-style variance reduction | 0 | Makes the sample floors affordable | Low |
| A6 | ETCSOVG coverage check on locked-equal components; declare locked-harness vs factorial regime | 0 | Harness variance ≈ 8× model variance | Low |
| A7 | Impossible-by-construction calibration cases as a zero-tolerance guardrail | 0 | No negative control for verifier gaming today | Medium |
| A8 | Downgrade SWE-bench Verified adapter to diagnosis-only, contamination-suspect | 0 | Contamination and test-flaw evidence | Low |
| A9 | Record that bitwise reproducibility is unavailable over hosted endpoints | 0 | Batch-invariance nondeterminism | Low |
| A10 | Monotone deny-or-abstain guard composition | Tier C | Makes the ceiling invariant testable | High |
| A11 | Per-backend, per-axis enforcement-completeness reporting | Tier C | Enables per-platform unblock instead of a global block | Medium |
| A12 | Replay provider as a first-class provider implementation | 3A / 6 | Replay has no runtime answer today | Medium |
| A13 | Delegation depth + child-spawn cap as host-enforced workflow fields | 3 | First non-guidance field in the schema | Medium |
| A14 | Inter-agent messages are untrusted; a child cannot supply consent | Kernel exclusions | Confused-deputy defense before any multi-agent axis | Low |
| A15 | Candidate archive with Pareto retention; validation-selected gains never cited as expected effects | 8 | GEPA/DGM's load-bearing component | Medium |
| A16 | Perceived-benefit ratings are `observational` with no decision authority | 5 | METR perception gap | Low |
| A17 | A workflow may never execute its own verification | 3 / 5 | Verifier-gaming separation | Low |

## What this review deliberately rejects

- **Plugin-everything architecture (Cordis).** It would fight Book's architecture checks (no cycles,
  `tui/` is a leaf, no `src/types.ts` hub), and 3A already warns against adding duplicate global
  registries to satisfy a sketch.
- **Exporter-side-only redaction.** A regression against the frozen #51 contract.
- **Model-written workflow scripts.** Phase 8 territory; incompatible with Tier C today.
- **Adopting any reported effect size as an expectation.** Every number in Finding 9 is
  validation-selected on a benchmark Book does not run, under a harness Book does not use, with the
  contamination caveats of Finding 4.
- **Treating external benchmark scores as a substitute for the local sealed gate.** Reinforced, not
  weakened, by Finding 4.

## Sources

Production agent runtimes:

- DeepSeek Harness, [repository](https://github.com/deepseek-ai/deepseek-harness) and docs:
  architecture, capability-seams, tool-execution-pipeline, defensive-patterns, testing, and the
  session, persistence, sandbox, approval, permission-presets, session-telemetry, subagent, skills,
  workflow, and invariants subsystem documents.
- Anthropic, Claude Code documentation:
  [subagents](https://code.claude.com/docs/en/sub-agents),
  [hooks reference](https://code.claude.com/docs/en/hooks),
  [sandboxing](https://code.claude.com/docs/en/sandboxing),
  [OpenTelemetry monitoring](https://code.claude.com/docs/en/monitoring-usage),
  [agent teams](https://code.claude.com/docs/en/agent-teams).
- OpenAI, [Codex manual](https://learn.chatgpt.com/docs/codex-manual.md) and the Codex permissions /
  agent-approvals-security pages: sandbox modes, approval policies, `config.toml`, network default.

Evaluation infrastructure and benchmark integrity:

- [Stop Comparing LLM Agents Without Disclosing the Harness](https://arxiv.org/html/2605.23950v1) (arXiv:2605.23950).
- τ-bench, [A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045) — `pass^k`.
- Terminal-Bench 2.0 and the Harbor container harness.
- [SWE-bench+](https://arxiv.org/pdf/2410.06992) (arXiv:2410.06992) and SWE-bench Pro; OpenAI,
  [Why we no longer evaluate SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/) *(not directly retrievable; 403)*.
- OpenHands and SWE-bench evaluation harnesses: layered base/environment/instance images,
  per-instance container isolation.

Methodology:

- Miller, [Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640) (arXiv:2411.00640).
- Deng, Xu, Kohavi, Walker, CUPED: Improving the Sensitivity of Online Controlled Experiments by
  Utilizing Pre-Experiment Data (2013).
- METR, [Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/).
- Thinking Machines Lab, [Defeating Nondeterminism in LLM Inference](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/).

Design guidance:

- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).
- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

Workflow evolution and self-improvement:

- [Agent Workflow Memory](https://arxiv.org/abs/2409.07429) (arXiv:2409.07429).
- [AFlow: Automating Agentic Workflow Generation](https://arxiv.org/pdf/2410.10762) (arXiv:2410.10762).
- [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://arxiv.org/abs/2507.19457) (arXiv:2507.19457).
- [Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents](https://arxiv.org/abs/2505.22954) (arXiv:2505.22954).
- Reward-hacking benchmarks: ImpossibleBench, SpecBench (arXiv:2605.21384), EvilGenie, School of
  Reward Hacks.

Identified but not read (do not cite as evidence until read):

- Holistic Agent Leaderboard (arXiv:2510.11977) — retrieval exceeded the size limit.
- How to Correctly Report LLM-as-a-Judge Evaluations (arXiv:2511.21140).
