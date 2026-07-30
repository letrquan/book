# Adaptive Harness Research Grounding

**Date:** 2026-07-28
**Scope:** Review of the adaptive-harness phases against the current Book runtime and
primary external sources.  
**Decision:** The roadmap is directionally sound, but it is not implementation-ready
until the blockers and questions below are resolved. This document is a required input
to the Phase 0 verification packet.

The companion [Agent Capability Research and Gap Analysis](agent-capability-research.md) covers
the previously under-specified prompt, skill, tool-contract, context, model-adapter, verification,
delegation, hook, and user-interaction surfaces. Its fixed implementation gate is
[Phase 3A](phase-3a-agent-capability-substrate.md).

## Executive Finding

The proposal has the right safety shape: observe first, compare fixed workflows, use
held-out evaluation, canary narrowly, and keep candidate changes inside a validated
schema. The missing foundation is not another workflow. It is trustworthy attribution.

Today the repository has several confounders that can make a harness look successful
without improving the requested task:

- Managed agent routing is already enabled by default through `settings.agents.mode`,
  while the plan treats multi-agent coordination as future work.
- `maxBudgetUsd` is exposed at the headless boundary but is not enforced end to end;
  root usage is not accumulated consistently and legacy child usage is discarded.
- Provider terminal failures must never be returned as ordinary completed history. A
  regression exposed after the adaptive-harness accounting change (`fab5211`) showed that
  an OpenAI-compatible stream can close after partial output without `[DONE]` or a
  `finish_reason`; the provider must classify that EOF as `transport_interrupted` and the
  agent loop must emit one interrupted terminal outcome instead of calling `onDone`.
- The shared lifecycle boundary is `AgentSession`, not only `headless.ts`, the TUI, or
  `runAgentLoop`.
- The exact effective model, tool surface, ambient prompt inputs, and Book home state
  are not frozen before a run.
- Windows Book execution is not a security sandbox; a fresh fixture directory is not
  sufficient isolation for adversarial setup, verifier, or candidate commands.

Until these are addressed, Phase 6 results are not attributable to workflow selection.

## Verified Stream-Termination Regression

The provider stream contract treats terminal framing as evidence, not an assumption:

- `[DONE]` is a valid completion marker.
- EOF after a `finish_reason` is accepted for gateways that omit `[DONE]`.
- EOF without either marker is an interrupted transport, even when partial text was
  received.

This distinction is required by the harness because a truncated answer must not be recorded
as a completed run. The regression is asserted at both boundaries:
`src/provider/openai-compatible.test.ts` verifies the event sequence and
`src/agent/loop.test.ts` verifies `status: interrupted`,
`reason: transport_interrupted`, `partialOutput: true`, and the absence of `onDone`.

## Research Update: What Existing Systems Change

The roadmap was rechecked against OpenTelemetry GenAI agent conventions, LiteLLM's
budget/cost accounting, Inspect AI's task/sample/scorer/sandbox model, MCP security guidance,
and VS Code Workspace Trust. Four decisions follow from that comparison:

1. **Separate attribution from observability.** OpenTelemetry distinguishes requested model,
   response model, provider, operation/span identity, usage dimensions, and error status. Book's
   local run contract must keep those fields separate; an OTel export mapping is a view, not the
   source of truth. Provider/model identity is `verified` only when the response identifies what
   actually served the request; a proxy's configured provider is not proof of the upstream model.
2. **Separate direct, inclusive, and estimated accounting.** A run needs its own model-call usage,
   root-inclusive usage (including children and compaction), pricing version, and budget state.
   Cost estimates must support cache/reasoning dimensions and an explicit unknown state. A single
   `usage` number or a display-only USD estimate cannot be a promotion guardrail. Hard budgets must
   be enforced at the next-call boundary; if pricing or identity is unknown, evaluation mode must
   fail closed while ordinary interactive mode may continue with `unknown` accounting.
   The current implementation uses a versioned local table and therefore remains an estimate until
   a provider/account billing source or explicitly supplied pricing configuration is available; it
   must not be presented as an invoice or a projected-cost guarantee.
3. **Make trial the evaluation unit below a case.** Anthropic's agent-eval model separates task,
   trial, grader, transcript, and final environment outcome; Inspect AI gives each sample a fresh
   sandbox and records limits and scores independently. Phase 0 therefore needs stable trial/attempt
   identity, per-trial isolation, final-state grading, and explicit unknown/error outcomes rather
   than treating one case execution as deterministic.
4. **Tier the security gates.** VS Code's restricted mode and Inspect's per-sample containers show
   that trust and isolation are runtime boundaries, not fixture metadata. MCP guidance additionally
   requires consent-bound authorization to avoid confused-deputy credential flows. Safe built-in
   fixtures may proceed after attribution and evaluator-runner gates; project-controlled hooks,
   MCP, provider endpoints, executable commands, skills, and subagents remain blocked until the
   workspace-trust, credential-origin, network, and sandbox gates are verified.

These decisions narrow the next implementation slice and prevent the plan from either treating
estimated cost as truth or blocking all non-adversarial Phase 0 work on controls that only matter
once project-controlled processes are admitted.

## Required Pre-Phase-0 Preconditions

These are small runtime correctness changes, not adaptive behavior. They should be
tracked as a prerequisite batch before collecting promotion evidence:

1. Make terminal run status lossless. A provider error, cancellation, timeout, and
   interruption must remain distinct from verified completion through `AgentSession` and
   its event reducer. The OpenAI-compatible EOF case above is now covered; remaining
   provider/session paths must preserve the same distinction.
2. Enforce one root run boundary per user request. A single headless process may serve
   several requests, so prepare/finalize must occur inside the request loop. Resume must
   define whether it continues a run or starts a new run linked to the prior one.
3. Add cumulative root-and-child usage accounting and a versioned pricing table. A
   budget that cannot stop execution or become `unknown` is not a valid evaluation
   guardrail.
4. Separate `harness.mode` from the existing `agents.mode`. Initial fixtures must
   record and normally force `agents.mode = off`; otherwise delegation, parallelism, and
   workflow effects are mixed.
5. Capture effective provider/model identity and response metadata. If an alias or proxy
   prevents exact identity, record `unknown` and reject transfer rather than guessing.
6. Freeze or explicitly version the ambient run snapshot: model override, tools and
   schemas, settings, skills, commands, memory, MCP, environment, clock, date, random
   seed, and network policy. Rebuilding context after repository edits otherwise changes
   the treatment during a run.
7. Add an evaluation runner with a disposable Book home, sanitized environment, fresh
   session/tool-discovery state, and an external process/container boundary. On Windows,
   directory copying alone is not a security control.
8. Add architecture checks for the one-way dependency rules in the parent plan. The
   existing architecture script does not yet prevent evaluator/proposer imports from
   entering the runtime.
9. Decide the trust and lifecycle boundary for project skills and workflow files before any skill
   body, supporting script, or dynamic policy can influence a comparison arm.
10. Define the complete capability manifest and include prompt-layer, skill, tool-contract, context,
    model-adapter, hook, verifier, and delegation identities in the ambient run snapshot.
11. Establish workspace trust and permission-ceiling controls before evaluating project-controlled
    hooks, providers, MCP servers, executable commands, skills, or subagents. A fresh fixture folder
    is not a substitute for a trust boundary.
12. Make sandbox, network, credential-origin, web-fetch, MCP-startup, and command-expansion policies
    truthful and fail-closed before adversarial harness fixtures are eligible.

## Research Questions That Must Have Answers

### Phase 0: What exactly is comparable?

- What is the experimental unit: fixture revision, root request, session, or user task?
  Choose one primary unit and state clustering for repeated requests from the same
  project/session.
- What is the estimand and minimum detectable effect for each task slice? Declare alpha,
  power or a minimum-sample rule, non-inferiority margins, paired/randomized assignment,
  and the multiplicity policy before results are viewed.
- How are `unknown`, evaluator failure, timeout, and missing-at-random assumptions handled?
  Excluding unknowns can bias promotion when one arm fails to produce evaluable results.
- Which fixture commands are trusted? `setupCommand` and verifier commands need an
  allowlisted argv/cwd/env/network policy, path/symlink checks, immutable evaluator code,
  and a digest of the materialized tree.
- What makes a case reproducible: corpus version, fixture digest, reset/cleanup digest,
  model/provider/config identity, pricing version, tool/runtime fingerprints, clock,
  network policy, seed, and evaluator version?
- Which cases are machine-verifiable, which require a human rubric, and which remain
  observational? Research quality, architecture taste, maintainability, and satisfaction
  cannot be represented honestly as automatic success in the first corpus.

### Phase 1: What is inert and what is a capability?

- How does a valid future mode fail when that mode is not yet enabled? Enum validation
  alone is insufficient; add an explicit availability gate before any storage or provider
  work.
- Is `HarnessRunContext` absent in `off`, or is there a non-persisted deterministic
  no-run value? The current required `runId` conflicts with the stated no-ID off path. The
  precondition runtime identity is therefore kept separate as `AgentRunContext`; it is created
  for attribution, while the Phase 1 harness context remains absent in `off`.
- What is the queue/flush/close contract for asynchronous observation, including dropped
  events, backpressure, shutdown, and evidence-write failure?
- Which workflow controls are actually enforced by the kernel, prompt guidance only, or
  unsupported and clamped? This capability matrix must exist before Phase 3.
- Is SDK control in scope? If yes, add `QueryOptions` and `HeadlessOptions` contracts;
  otherwise declare the first release CLI/settings-only.

### Phase 2: Can the ledger be trusted?

- How are concurrent writers serialized, sequences assigned, tails recovered, records
  fsynced, and indexes rebuilt? JSONL is acceptable only with an explicit durability and
  single-writer/multi-writer policy.
- What is the relationship among session ID, root run ID, user-message ID, tool-call ID,
  UI trace IDs, and W3C/OTel trace/span IDs? They must not be interchangeable.
- How are automatic permission resolutions, tool start, retries, stalls, cancellation,
  and terminal reasons observed when current callbacks do not expose them all?
- What is the redaction policy for commands, paths, prompts, tool output, memory, and
  repository content? Secret detection alone is not a safe raw-payload policy.
- Which OTel semantic-conventions version is mapped? The current GenAI agent conventions
  are still development-status and treat system instructions/messages as sensitive opt-in
  content; the local ledger must remain bounded and privacy-safe regardless of exporter.

### Phase 3: Are workflows real controls or prose?

- For every schema field, identify the host API that enforces it. Current Book has no
  selectable input-context ceiling, handoff policy, edit-scope limiter, trusted verifier
  registry, or workflow-specific retry implementation.
- Remove `parallelism` from the initial workflow surface, or explicitly scope it to an
  already-tested existing runtime capability. It must not smuggle the deferred
  multi-agent program into the first harness.
- Use recursive strict schemas and canonical JSON hashing. Zod's default object behavior
  strips unknown fields, which is the opposite of the required fail-closed behavior.
- Project workflow files are repository data, not trusted instructions. Do not render
  free-form descriptions as policy text or load candidates from an executable path.
- Add a separate bounded dynamic policy zone. The current context builder places generic
  appended text in the cached prefix, so the documented dynamic-suffix behavior is not
  currently true.
- Can the workflow request a registered capability bundle without embedding arbitrary prompt text,
  skill bodies, tool schemas, context retrieval code, verifier commands, or model-specific code?
- Is the skill body lazy, attributed, bounded, scoped to an activation frame, and prevented from
  changing kernel permissions or evaluator rules?
- Are `InvokeSkill` and `ToolSearch` discoverable at a measured cost, and can skill/tool restrictions
  be restored after an activation expires?
- Are tool descriptions, schemas, output/error contracts, retry semantics, and side effects included
  in the tool-surface fingerprint and tested as routing behavior?
- Are provider-specific prompt flattening, message ordering, tool-result conventions, and exact model
  capability metadata captured before comparing model/provider arms?
- Is context selection separately described and measured rather than hidden inside workflow prose?
- Does an untrusted workspace fail closed for project hooks, provider endpoints, MCP startup,
  executable command expansion, privileged skills, and subagent definitions?
- Can any project/workflow/skill/hook/MCP/subagent scope broaden a permission or sandbox ceiling set
  by a higher-trust scope?

### Phase 4: Is selection causally informed?

- Historical outcomes are selection-confounded. What randomized/control exposure or
  replay design makes workflow evidence counterfactual enough to use?
- What is the partial order, if any, among `minimal`, `safe-edit`, and `verify-heavy`?
  They are not a simple permission ladder. Missing evidence should mean abstention, not
  a vague notion of "less permissive."
- Does classification use original user text and trusted command metadata, separate from
  expanded `@file` and shell-derived content? Derived repository/tool text is untrusted.
- How are confidence, freshness, decay, exact model keys, task slices, evaluator versions,
  and compatibility invalidation computed and calibrated?
- Which transition points are safe? A TUI command cannot reliably mutate an active send;
  default to next-run overrides and only permit loop-boundary transitions with typed
  triggers and caps.

### Phase 5: Are outcomes externally grounded?

- What immutable verifier manifest is used, including cwd, env, network, timeout, expected
  exit codes, artifact hashes, protected paths, and evaluator provenance? Existing
  `agents.checks` is configurable runtime behavior, not a promotion authority.
- What typed aggregation turns dimensions into `verified-success`, `partial`, or
  `unknown` for each task class? Keep missingness visible and do not silently discard it.
- How are feedback events authenticated, idempotent, scoped, expired, inspected, and
  deleted? Existing `/feedback` already writes bug-report snapshots, so outcome feedback
  needs a distinct command/schema or an explicit backward-compatible dispatch.
- Which ordinal/categorical agreement statistic, reviewer sampling, calibration, blinding,
  adjudication, and privacy rules make a human rubric reliable enough to learn from?
- How are agent-authored evidence records kept separate from verifier truth?

### Phase 6: Does shadow/offline evaluation beat a serious baseline?

- What nested split prevents choosing the "best fixed" workflow after seeing held-out
  results? "At least one winning slice" is cherry-pick prone without a predeclared slice
  hierarchy and multiplicity correction.
- How are trial order, concurrency, rate limits, provider caches, clock, seed, and model
  nondeterminism controlled? A deterministic fixture is not a deterministic LLM trial.
- How is the reusable final holdout sealed from candidate generation and repeated queries?
  The proposer must not receive free-text summaries of held-out failures.
- What external runner prevents secrets, network escape, process leakage, and mutable
  evaluator access? Fresh folders and Git worktrees are useful isolation, not a sandbox.
- What happens to private historical runs lacking consent, deletion semantics, or complete
  replay identity? They should be diagnosis-only by default.

### Phase 7: Can live rollout be stopped safely?

- What is the randomization unit and salted assignment key? Project-only hashing can
  cluster all tasks from one project into one arm and cannot detect spillover. Include
  explicit opt-out, session contamination rules, and sample-ratio-mismatch checks.
- What are the numerical primary/guardrail margins, minimum control allocation, delayed
  label policy, and sequential-monitoring method? Continuous peeking needs confidence
  sequences or alpha spending; fixed-horizon intervals are not enough.
- At what point is a workflow frozen, and when does a user override apply? In the first
  release, treat interactive overrides as next-run unless a typed transition point exists.
- How are registry entries signed, atomically published, expired, and handled when the
  registry is unavailable? Existing runs must retain their decision and rollback target.
- Is automatic promotion actually required? A human or separately versioned gate should
  approve high-risk slices; "preserves metrics" must include the complexity Pareto rule.

### Phase 8: Can evolution avoid holdout overfit?

- Who recomputes `changedFields`, complexity, clamps, and candidate hash? Never trust a
  proposer-supplied accounting field.
- What candidate/query budget, alpha-spending or multiple-testing policy, and sealed final
  test prevent repeated candidate cycles from learning the holdout?
- Are proposer inputs typed facts with provenance and injection-safe summaries rather than
  free-text failure transcripts?
- What is the approval authority, signature, atomic registry update, TOCTOU check, and
  last-known-good rollback artifact?
- Is "no promotion" a valid successful outcome for the phase? It must be; a reproducible
  rejection is evidence, not failure of the system.

### Phase 9: What would justify transfer?

- Quantify "enough real usage" with runs, duration, effect size, maximum harm, and schema
  stability thresholds.
- Define a privacy threat model for cross-project aggregates: consent, epsilon/delta or
  another formal guarantee, minimum cohorts, composition, membership inference, and
  deletion propagation.
- Define change-point false-alarm rates, cooldown/hysteresis, and safety exclusions.
- Separate existing user-controlled Task subagents from future harness-coordinated
  multi-agent adaptation; the former already exists in this repository.
- Code-level evolution requires an isolated plugin/API boundary, signed build provenance,
  reproducible tests, independent promotion authority, and a kill switch.

## External Evidence Used

The following primary or standards sources were checked on 2026-07-22; the capability-specific
sources below were rechecked on 2026-07-28:

- AI World, [System prompts and what they tell us about the chat before the chat](https://aiworld.eu/story/system-prompts-and-what-they-tell-us-about-the-chat-before-the-chat): category framing for tool definitions, tool-use guidance, memory, safety, conduct, and voice.
- Anthropic, [Claude Code best practices](https://code.claude.com/docs/en/best-practices): context management, verification, planning, concise project instructions, subagents, and recovery.
- Anthropic, [Extend Claude with skills](https://code.claude.com/docs/en/skills): lazy skill bodies, activation descriptions, invocation control, supporting resources, and skill evaluation.
- Anthropic, [Create custom subagents](https://code.claude.com/docs/en/sub-agents): isolated contexts, tool restrictions, model selection, skill preloading, and handoff boundaries.
- Anthropic, [Automate actions with hooks](https://code.claude.com/docs/en/hooks-guide): deterministic lifecycle enforcement and context reinjection outside model guidance.
- OpenAI, [Codex manual](https://developers.openai.com/codex/codex-manual.md): `AGENTS.md`, skills, tools, hooks, context, customization, and progressive disclosure guidance.
- OpenAI, [Define tools](https://developers.openai.com/plugins/plan/tools) and [Build skills](https://developers.openai.com/plugins/build/skills): user-intent tool contracts and focused, triggerable workflows.
- Aider, [Repository map](https://aider.chat/docs/repomap.html): token-bounded structural context and relevance ranking.
- SWE-agent, [Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793): model-facing tool/interface design as a determinant of software-engineering outcomes.
- Cline, [open-source coding agent](https://github.com/cline/cline): Plan/Act separation, rules and skills, checkpoints, approval, compiler/linter feedback, and multi-agent coordination.
- Book, [Security Assessment and Remediation Plan](../security-assessment.md): current trust-boundary
  risks for project hooks, provider endpoints, MCP startup, sandbox construction, subagents, command
  expansion, web access, and permission ceilings.
- Book, [Tool Reliability Plan](../tool-reliability-plan.md): existing model-agnostic tool contracts,
  actionable errors, read-before-edit freshness, retry circuit breakers, and edit guidance that
  should be fingerprinted rather than reimplemented by the harness.

- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): defines task, trial, grader, transcript, outcome, and harness; emphasizes multiple trials because agent outputs vary and grades the final environment state rather than the model's claim.
- OpenTelemetry, [GenAI agent semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md): provides agent/workflow/tool span semantics, exact requested model/provider fields, bounded trace attributes, and explicit warnings that message/system-instruction content is sensitive opt-in data.
- OpenTelemetry, [Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/) and [common limits](https://opentelemetry.io/docs/specs/otel/common/): require valid immutable trace/span identity and bounded attribute collections.
- LiteLLM, [model pricing map](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) and [budget manager](https://github.com/BerriAI/litellm/blob/main/litellm/budget_manager.py): keep versioned per-model dimensions, project current spend, and refuse to guess unknown pricing.
- Inspect AI, [tasks](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/docs/tasks.qmd), [evaluation logs](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/docs/eval-logs.qmd), and [sandboxing](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/docs/sandboxing.qmd): separate task/sample/solver/scorer, preserve per-sample logs and limits, and provision a fresh sandbox per sample.
- Model Context Protocol, [security best practices](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx): prevent confused-deputy authorization and bind consent/credentials to the requesting client and server.
- Visual Studio Code, [Workspace Trust](https://github.com/microsoft/vscode-docs/blob/main/docs/editing/workspaces/workspace-trust.md): restricted mode blocks automatic project code execution, but trust is not a substitute for extension/process isolation.
- OWASP, [LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html): covers indirect injection, RAG/context poisoning, tool manipulation, output screening, least privilege, and monitoring.
- W3C, [Trace Context](https://www.w3.org/TR/trace-context/): defines interoperable trace/span propagation; UI IDs must remain separate from these identifiers.
- IETF, [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785): canonical JSON gives deterministic, hashable representations for workflow, tool-surface, fixture, and promotion artifacts.
- Dwork et al., [The Reusable Holdout](https://doi.org/10.1126/science.aaa9375): repeated adaptive queries to a holdout leak information; seal the final test and cap query access.
- Kohavi et al., [Online Controlled Experiments at Large Scale](https://doi.org/10.1145/3292500.3330937): predeclare the overall evaluation criterion and guardrails, randomization unit, ramping, triggered analysis, and sample-ratio checks.
- Johari et al., [Always Valid Inference](https://doi.org/10.1287/opre.2021.2135): continuous monitoring requires confidence sequences or equivalent always-valid inference.
- Benjamini and Hochberg, [Controlling the False Discovery Rate](https://doi.org/10.1111/j.2517-6161.1995.tb02031.x): multiple slices, metrics, and candidates require a declared multiplicity policy.
- Schuirmann, [TOST equivalence testing](https://doi.org/10.1007/BF01068419): "no regression" requires a non-inferiority/equivalence margin and power, not a non-significant test alone.
- Dudik et al., [Doubly Robust Policy Evaluation](https://arxiv.org/abs/1103.4601): shadow policy outcomes alone do not identify counterfactual value; use replay or valid propensity-aware methods.
- NIST, [Engineering Statistics Handbook](https://www.itl.nist.gov/div898/handbook/prc/section3/prc31.htm): choose the hypothesis, design, and effect direction before looking at results.
- NIST, [AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework): treat governance, measurement, and management of risk as part of release decisions.
- NIST, [Secure Software Development Framework SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final): code-level evolution needs provenance, review, reproducible build/test, and release controls.
- SLSA, [Provenance v1.0](https://slsa.dev/spec/v1.0/provenance): promotion artifacts should attest subject digest, builder, invocation, and resolved dependencies.
- SWE-bench, [benchmark repository](https://github.com/SWE-bench/SWE-bench), and Terminal-Bench, [benchmark repository](https://github.com/laude-institute/terminal-bench): external adapters require exact dataset/evaluator revisions and sandboxed execution; they are portability checks, not substitutes for local held-out gates.
- Google SRE, [Canarying Releases](https://sre.google/workbook/canarying-releases/): staged rollout needs independent metrics, holdback, abort thresholds, and a rollback runbook.
- Dwork et al., [Differential Privacy](https://doi.org/10.1007/11787006_1): aggregate statistics are not automatically private; cross-project transfer needs a formal privacy budget and deletion model.

## Recommended Revised Order

1. **Runtime correctness preconditions:** terminal outcomes, run boundaries, cumulative
   usage/budget enforcement, exact identity, and architecture rules.
2. **Workspace trust and security preconditions:** project-config trust, permission ceilings,
   provider/MCP credential boundaries, command expansion, sandbox/network truthfulness, and
   subagent authorization.
3. **Phase 0:** machine-readable cases, trusted evaluator boundary, repeated-trial and
   statistical protocol, sealed corpus split, security/context/tool fixtures.
4. **Phase 1:** inert `harness.mode` boundary and capability matrix.
5. **Phase 2:** observation ledger with explicit durability, provenance, redaction, and
   OTel/W3C mapping.
6. **Phase 3:** only enforceable fixed workflows, no new parallelism, strict schemas and
   canonical registry hashes.
7. **Phase 3A:** fixed prompt layers, lazy scoped skills, fingerprinted existing tool-reliability
   semantics, context policies, model capability adapters, external-integration lifecycle contracts,
   cross-surface parity, and typed subagent handoffs.
8. **Phase 4:** deterministic shadow selector using original-intent features and an
   abstaining confidence policy.
9. **Phase 5:** immutable verifiers, typed outcomes, missingness policy, and explicit
   feedback/rubric contracts.
10. **Phase 6:** isolated replay, nested held-in/held-out evaluation, multiplicity and
    sequentially valid reporting.
11. **Phase 7:** salted canary assignment, numerical rollback rules, signed registry, and
    a human-approved rollout gate.
12. **Phase 8:** sealed final holdout, bounded candidate/query budgets, recomputed complexity,
    signed atomic promotion, and "no promotion" as a valid result.
13. **Phase 9:** separate proposal per transfer track with a new Phase-0-style contract.

## Bottom Line

Proceed with the adaptive harness only as an evidence-and-attribution project first.
The first credible milestone is not "adaptive selection is enabled." It is: Book can
replay a root request in an isolated environment, account for all work and cost, classify
terminal outcomes correctly, and explain why two arms were comparable. If that milestone
cannot be met, the correct result is to keep the harness off and improve the runtime.
