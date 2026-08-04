# Agent Capability Research and Gap Analysis

**Date:** 2026-07-28
**Scope:** Prompt architecture, tool contracts, skills, context engineering, memory, planning,
verification, subagents, hooks, model adaptation, user interaction, security, and evaluation.
**Decision:** Add an explicit agent-capability substrate between fixed workflow registration and
automatic selection. The adaptive harness must be able to measure and version the complete harness
that surrounds a model, not only a workflow ID.

**2026-08-04 update:** This remains a research and gap-analysis record. Fixed-runtime work has
since delivered the first-class skill registry, capability intersections, tool discovery,
model-conditional mutation guidance, stricter agent allowlists, and additional run attribution.
Those shipped primitives do not mark adaptive-harness Phase 3A or 3B verified; their phase gates and
evaluation evidence remain outstanding.

## Executive Finding

The base model is only one part of observed coding-agent quality. A production agent is the combined
behavior of:

```text
model and provider request semantics
+ trusted system/developer policy
+ project instructions and current user intent
+ tool names, descriptions, schemas, and result contracts
+ skill discovery, activation, and lifecycle
+ context selection, retrieval, compaction, and resume
+ planning, editing, verification, and recovery loops
+ subagent isolation, specialization, and handoff
+ permissions, hooks, sandboxing, and provenance
+ user-visible control and feedback
= observed agent outcome
```

The current adaptive-harness plan is strong on attribution, evaluation, rollout, and rollback. Its
main gap is that it treats the selectable workflow as the primary improvement surface without first
making the rest of the agent capability stack explicit and measurable. That can misattribute gains
or regressions caused by prompt changes, skill activation, tool-schema changes, context selection, or
provider behavior to the selected workflow.

The recommended response is not a larger universal system prompt. It is a smaller trusted kernel,
clear prompt layers, high-quality tool contracts, lazily loaded skills, bounded context policies,
and separate evaluation axes.

## Research Synthesis

### System prompts are product architecture

The AI World comparison supplied for this review groups modern system-prompt content into tool
definitions, tool-use instructions, personalization and memory, product information, safety,
wellbeing, copyright, conduct, and voice. The useful conclusion is not that Book should copy leaked
prompts or match their length. It is that tool and product behavior must be deliberately specified,
versioned, and tested as part of the agent runtime.

Long prompts have costs:

- they consume input tokens and reduce prompt-cache stability;
- universal instructions compete with the current task and project instructions;
- rarely relevant procedures become distraction;
- contradictory rules become difficult to diagnose;
- changing one dynamic value can invalidate an otherwise stable cached prefix.

Use progressive disclosure instead: keep stable invariants in the core prompt, list compact skill
triggers, and load detailed procedures only when they are relevant.

### Context is a primary reliability resource

Anthropic's Claude Code best-practices guidance treats context management as a central constraint:
verify work, explore before planning when needed, keep durable project instructions concise, move
conditional procedures into skills, use subagents to keep broad exploration out of the main context,
clear unrelated sessions, and preserve critical details through compaction.

Aider's repository map demonstrates a complementary pattern: provide a token-bounded structural map
of symbols and relationships, then rank the most relevant portions instead of loading the whole
repository. This suggests Book should evaluate context selection and retrieval quality independently
from workflow selection.

### Skills should have visible triggers and hidden bodies

OpenAI and Anthropic both document skills as reusable workflows whose descriptions determine when
the model considers them. Detailed procedures, references, assets, and scripts load only when the
skill is used. This is the right boundary for debugging procedures, code-review rubrics, UI visual
verification, migration checklists, or provider-specific integration knowledge.

Important skill properties are:

- one recognizable user goal;
- a precise positive trigger and useful negative boundaries;
- explicit inputs, steps, outputs, stop conditions, and verification;
- lazy loading of the body and supporting resources;
- a declared source, version, trust level, and capability scope;
- explicit control over implicit versus user-only invocation;
- representative activation and non-activation tests.

### Tool descriptions are routing policy

The model uses tool names, descriptions, schemas, and error messages to decide what action is
possible and appropriate. Tool contracts should describe user intent, trigger conditions,
distinctions from similar tools, prerequisites, side effects, retry safety, and useful recovery.

SWE-agent's Agent-Computer Interface work and the broader coding-agent literature show that changing
the interface presented to the model can materially change outcomes even when the base model is
unchanged. Book therefore needs tool-contract evaluation, not only tool implementation tests.

### Deterministic enforcement belongs outside prompts

Claude Code documents hooks as deterministic lifecycle controls for formatting, protected paths,
permission decisions, notifications, and context reinjection. Prompts and skills are advisory model
guidance; permissions, protected paths, verifier definitions, secret handling, and required lifecycle
actions remain kernel or hook responsibilities.

### Subagents are context and independence tools

Subagents are most useful when they provide one or more of:

- a fresh context for broad investigation;
- a specialized prompt or preloaded skill;
- a narrower tool and permission surface;
- independent verification without implementation-history bias;
- parallel work that is genuinely independent;
- a compact typed handoff rather than a transcript dump.

Delegation itself is not improvement. It adds tokens, latency, coordination failure, and attribution
complexity. Book must evaluate subagent use as a separate axis and keep the initial harness corpus
single-agent unless a test explicitly studies delegation.

### Strong agents close the loop with evidence

The common pattern across mature coding agents is:

```text
understand -> inspect -> act -> observe -> verify -> recover or finish
```

Tests, builds, linters, screenshots, artifact diffs, and independent review provide external signals.
The model's claim that work is complete is not evidence. Verification selection and evidence quality
must be recorded separately from final-answer style.

## Current Book Capability Audit

### Strengths already present

Book already has substantial agent infrastructure:

- layered `AGENTS.md` and `CLAUDE.md` discovery;
- a two-zone system prompt with compact skill, command, agent, and tool listings;
- model-dependent edit-format guidance;
- a deferred tool catalog with `ToolSearch`;
- project and user skills with optional tool restrictions;
- runtime permission evaluation and hooks;
- context compaction, checkpoints, file-observation freshness, and session persistence;
- managed explorer, patcher, and validator profiles;
- evidence records and validator gates for managed patches;
- provider abstraction for OpenAI-compatible and Anthropic APIs;
- tests for prompt construction, tool discovery, providers, sessions, and managed agents.

These capabilities make Book a viable substrate for adaptive improvement. They also create more
experimental variables that must be frozen and fingerprinted.

### Prompt architecture gaps

The current prompt builder combines several classes of information in `cachedPrefix`:

- stable identity and operating rules;
- project instructions;
- date, Git state, and workspace metadata;
- skills, commands, agents, and active tools;
- memory;
- arbitrary `systemPromptAppend` content;
- guardrails.

Some of these values change by turn, tool surface, mode, repository state, or active agent. Calling
the combined value a stable cached prefix hides cache invalidation and attribution. The current
`dynamicSuffix` contains only todos.

Required change:

```text
stable kernel
session capability/context manifest
dynamic execution policy
current task state
```

Each layer needs a source, trust class, version, budget, digest, and cache policy.

### Skill lifecycle gaps

Current skill invocation has several weaknesses:

1. The system prompt lists skills, but `InvokeSkill` may itself be deferred behind `ToolSearch`.
2. The full skill body is returned as ordinary tool output rather than activated as a dedicated,
   attributed workflow policy.
3. `allowedTools` calls `restrict()` by appending a rule set for the rest of the current agent loop;
   there is no scoped activation frame or restoration boundary.
4. Invocation counts are incremented on a freshly discovered in-memory skill object and do not form
   durable, outcome-linked evidence.
5. The schema lacks explicit activation control such as implicit, user-only, or disabled invocation.
6. There is no first-class references/assets/scripts lifecycle or bounded supporting-resource loader.
7. Project skills are repository-controlled instructions, but the trust and workspace-approval
   boundary is not represented in the skill contract.
8. Skill activation precision, false positives, false negatives, and completion quality are not
   evaluated.

Required change: make skill metadata always discoverable, keep bodies lazy, and activate an invoked
skill in an explicit dynamic policy frame subordinate to the trusted kernel and current user request.

### Tool-contract gaps

Book normalizes schemas and has catalog metadata, but improvement work needs a stronger contract:

- explicit intended user goal and selection conditions;
- distinctions among overlapping tools such as `ApplyPatch`, `Edit`, `Write`, and `Bash`;
- structured success and failure output schemas;
- stable error codes and model-readable remediation;
- side-effect, idempotence, retry, cancellation, and concurrency semantics;
- permission and trust classification;
- representative valid, invalid, ambiguous, and unauthorized examples;
- contract and selection evaluations across supported model/provider combinations.

Tool descriptions, schemas, aliases, and error semantics must be part of the tool-surface fingerprint.

### Tool-discovery gaps

Deferred discovery reduces schema cost, but it introduces a routing step and a one-turn activation
delay. Book should measure:

- whether the model recognizes that an active tool is missing;
- whether it searches with a useful query;
- whether the correct tool is ranked and loaded;
- whether activation fits the schema budget;
- whether the model uses the activated tool on the next turn;
- whether deferred mode improves total outcome after its extra call and latency.

The current default makes that cost common rather than exceptional. `toolDiscovery.mode = auto`
usually becomes deferred because `eagerToolCount` defaults to 10 even when the complete schema
estimate remains below the default 8,000-token budget. `Bash` is core while `WebSearch`, `WebFetch`,
and the managed-agent lifecycle are deferred. Sparse fuzzy-search metadata also produces poor intent
matches: transcript and generic web queries can rank agent/task tools, while broad research queries
can return no useful result. Mechanical search tests are therefore insufficient; Book needs a frozen
natural-language routing corpus and explicit next-turn-use evidence.

Skills should either have a direct core invocation surface when skills exist or a dedicated skill
search/activation path whose metadata is visible and whose cost is measured.

### Context-engineering gaps

Book discovers broad project context but lacks an explicit, evaluated context manifest and retrieval
policy. Candidate improvements include:

- a token-bounded repository/symbol map;
- ranked relevant-file and relevant-symbol selection;
- separation of observed files from inferred repository facts;
- task-scoped context packs rather than broad repeated reads;
- failure and decision preservation through compaction;
- typed checkpoint and resume contracts;
- retrieval of oversized historical tool results by reference;
- context contribution accounting by source and layer;
- a freshness policy for Git state, instructions, skills, tools, memory, and environment.

Context selection must preserve provenance. Repository files, tool output, web content, memory, and
derived summaries do not silently become trusted policy.

### Model and provider adaptation gaps

Book adapts edit guidance through `editFormat`, but model/provider behavior also varies through:

- exact model and provider identity;
- context and output limits;
- reasoning controls;
- prompt caching behavior;
- tool-call format and parallel tool support;
- strictness around message ordering and tool results;
- image and multimodal support;
- structured-output reliability;
- retry, timeout, and stream semantics.

Do not create large manually maintained prompts for every model. Define a small capability profile
derived from provider/model metadata, then select bounded adapters only where evaluation shows a
benefit. Unknown or aliased models fall back to the minimal profile.

### Planning and execution gaps

Current prompt guidance appropriately distinguishes small direct tasks from work that benefits from
planning. The harness must turn this into measurable behavior rather than universal planning:

- planning trigger precision;
- plan fidelity to user requirements;
- plan-to-diff consistency;
- plan overhead on small tasks;
- safe replanning after new evidence;
- mutation boundaries and partial-change recovery;
- stop conditions when required authority or information is missing.

Plan mode, todo tracking, workflow selection, and subagent plans are separate mechanisms and need
separate identities in evidence.

### Verification and recovery gaps

Book needs a normalized verification planner that can distinguish:

- targeted versus full checks;
- project-declared verifier authority versus arbitrary commands;
- behavior checks versus formatting/type checks;
- deterministic machine evidence versus advisory model review;
- failure caused by the change versus pre-existing or infrastructure failure;
- safe retry versus repeated unchanged failure;
- visual verification for TUI and frontend work;
- verification skipped because it is unavailable, unauthorized, too costly, or irrelevant.

The selected verification action and its result should be independently observable.

### Subagent gaps

Managed agents already provide role, tool, isolation, evidence, and final-response contracts. Missing
capabilities include:

- preloading a versioned skill or context pack into a child;
- structured handoff schemas per role rather than prose-only contracts;
- explicit context and output budgets;
- source freshness and snapshot compatibility in handoffs;
- duplicate-work avoidance between parent and children;
- independence rules for validators and reviewers;
- calibration of when delegation saves parent context enough to justify extra cost;
- zero-tool and unresolved-tool failures that fail closed with clear diagnostics;
- evaluation of single-agent versus delegated arms as different experimental conditions.

The current prompt can recommend `AgentSpawn` when its schema is not visible, and the adaptive
exploration threshold emits a reminder without starting or activating an explorer. Child profiles
can also name role-critical Git, check, or evidence capabilities that remain deferred. Routing work
must therefore align prompts with the effective surface, eagerly satisfy valid child allowlists, and
make adaptive read-only delegation actionable rather than advisory-only.

### Memory and personalization gaps

Memory is currently loaded as an index and correctly described as subordinate data. Further work
needs explicit contracts for:

- what is eligible to store;
- user approval, scope, confidence, decay, and deletion;
- fact versus preference versus inferred behavior;
- contradiction and supersession;
- provenance and project isolation;
- retrieval relevance and token budget;
- prevention of instruction promotion from memory;
- outcome evidence showing whether memory helped or distracted.

Global or cross-project personalization remains a Phase 9 concern.

### Hooks and deterministic controls gaps

Hooks already support lifecycle intervention, but the capability map should classify every desired
behavior as one of:

```text
model guidance
host-enforced runtime policy
deterministic hook
trusted verifier
user approval
unsupported
```

Formatting, protected paths, mandatory bookkeeping, redaction, and lifecycle notifications should
not depend on the model remembering instructions. Hook concurrency, precedence, timeout, failure
mode, provenance, and audit semantics need explicit fingerprints and tests.

### User-interaction gaps

Agent quality includes the control surface, not only autonomous task success. Evaluate:

- whether the agent asks only material questions;
- whether permissions explain the exact consequential action;
- whether the user can see active workflow, skills, tools, budgets, and verification state;
- whether plans and diffs are reviewable;
- whether cancellation and rewind preserve understandable state;
- whether errors include useful recovery paths;
- whether completion claims distinguish verified, partial, blocked, and unknown;
- whether correction loops indicate context pollution or a genuine requirement change.

### Security and trust gaps

The capability substrate must preserve a strict authority hierarchy:

```text
trusted kernel and permission policy
current explicit user intent
approved project instructions
approved active workflow/skill guidance
repository, memory, tool, web, and derived data
```

Project workflow and skill files remain repository-controlled. Schema validity does not make their
free-form instructions trusted. Workspace trust, source attribution, script execution, supporting
resource loading, symlink/path handling, and candidate promotion require explicit policy.

The repository's current [Security Assessment](../security-assessment.md) makes workspace trust a
hard prerequisite rather than a later guardrail. Until a workspace is explicitly trusted, the
harness must not activate or evaluate project-controlled hooks, provider endpoints, MCP servers,
executable command blocks, privileged subagents, skill scripts, or permission-allow rules. Trust
decisions must be stored outside the repository and resolved before any provider request or process
spawn.

The effective permission and sandbox posture must be a monotonic intersection. Project settings,
workflows, skills, hooks, MCP tools, and children may narrow the user-owned ceiling but cannot widen
it. Declared sandbox and network restrictions must match enforcement on the current platform; an
unsupported restriction is an explicit unavailable state, not an optimistic capability bit.

Security-sensitive capability descriptors therefore need to cover:

- workspace trust identity, decision source, and configuration surfaces enabled by that decision;
- requested and effective permission, sandbox, network, and credential-origin policies;
- hook, command, MCP, provider, skill-script, and subagent provenance;
- process environment filtering, startup timeout, output bounds, cancellation, and cleanup;
- provider-origin binding and secret-resolution restrictions;
- SSRF, redirect, response-size, terminal-control, log-redaction, and persistence controls;
- every clamp, denial, unsupported control, and approval as observable evidence.

These controls are fixed runtime responsibilities. A workflow or capability bundle may request a
stricter posture but cannot compensate for missing enforcement or select a more permissive one.

### External integrations and protocol gaps

The same logical capability can behave differently depending on how Book is entered and which
external protocol supplies it. TUI, headless, SDK, and CI paths currently have different lifecycle
and consent risks, especially around project MCP startup. Provider adapters, MCP servers, web tools,
plugins, and future app-server clients also introduce independently versioned schemas and failure
semantics.

The capability substrate must describe and test these boundaries instead of treating them as ambient
runtime detail:

- entry surface and lifecycle owner: TUI, CLI/headless, SDK, CI, or embedded host;
- initialization order for trust resolution, settings, hooks, MCP, provider creation, and first
  prompt construction;
- protocol, transport, server identity, negotiated version/capabilities, authentication mode, and
  configuration source;
- external tool names, descriptions, input/output schemas, annotations, server instructions, and
  change digest;
- connection, initialization, request, stream-stall, and shutdown timeouts;
- retry, reconnect, cancellation, backpressure, partial-result, and process-cleanup behavior;
- credential audience/origin, environment inheritance, network reachability, redirect policy, and
  response byte limits;
- parity of capability manifests, inspection, approvals, events, terminal status, budgets, and
  evidence across interactive and programmatic surfaces.

External schemas remain authoritative data, but authority to connect, execute, or disclose
credentials stays with the host. MCP and provider instructions never become trusted kernel policy.
Protocol or surface differences must appear in compatibility fingerprints so evidence is not reused
across behaviorally different runtimes.

## Target Capability Model

Introduce a versioned run-level manifest:

```ts
interface AgentCapabilityManifest {
  schemaVersion: 1;
  prompt: PromptManifest;
  workflow: WorkflowDecision;
  skills: SkillActivationManifest;
  tools: ToolSurfaceManifest;
  context: ContextPolicyManifest;
  model: ModelCapabilityManifest;
  verification: VerificationPolicyManifest;
  delegation: DelegationPolicyManifest;
  hooks: HookPolicyManifest;
  permissions: PermissionPolicyReference;
  trust: WorkspaceTrustReference;
  integrations: IntegrationCapabilityManifest;
}
```

The manifest is descriptive and hashable. It cannot contain secrets, arbitrary executable code, or
an unrestricted free-form system prompt. The trusted runtime resolves requested values to effective
values and records clamps.

### Prompt layers

```ts
type PromptLayerKind =
  | 'kernel'
  | 'session-context'
  | 'dynamic-policy'
  | 'task-state';

interface PromptLayerDescriptor {
  kind: PromptLayerKind;
  version: string;
  sourceRefs: string[];
  trust: 'kernel' | 'approved-policy' | 'attributed-data';
  tokenBudget: number;
  digest: string;
  cache: 'stable' | 'session' | 'turn';
}
```

The provider request may flatten layers where an API requires it, but the host must retain their
separate identity for caching, debugging, and evaluation.

### Skill activation

```ts
interface SkillDescriptor {
  id: string;
  version: string;
  description: string;
  source: 'builtin' | 'user' | 'project' | 'plugin';
  invocation: 'implicit' | 'user-only' | 'disabled';
  allowedTools?: string[];
  bodyDigest: string;
  resourceDigest?: string;
}

interface ActiveSkillFrame {
  skillId: string;
  version: string;
  reason: 'user' | 'model' | 'workflow' | 'subagent-preload';
  activatedAtTurn: number;
  expires: 'turn' | 'run' | 'explicit-completion';
  effectiveToolRules: string[];
}
```

Skill restrictions are resolved as an explicit scoped capability intersection. They are not appended
as irreversible hidden state.

### Tool contracts

```ts
interface ToolContractDescriptor {
  name: string;
  version: string;
  descriptionHash: string;
  inputSchemaHash: string;
  outputSchemaHash?: string;
  effects: string[];
  permissionClass: string;
  idempotence: 'yes' | 'no' | 'conditional' | 'unknown';
  retrySafety: 'safe' | 'unsafe' | 'conditional' | 'unknown';
  cancellation: 'supported' | 'unsupported' | 'unknown';
  errorContractVersion: string;
}
```

### Model capabilities

```ts
interface ModelCapabilityManifest {
  requestedModel: string;
  resolvedModel?: string;
  provider: string;
  exactIdentity: 'verified' | 'unverified';
  contextWindow?: number;
  maxOutputTokens?: number;
  editFormat: string;
  parallelTools: 'supported' | 'unsupported' | 'unknown';
  structuredOutput: 'supported' | 'unsupported' | 'unknown';
  promptCaching: 'supported' | 'unsupported' | 'unknown';
  reasoningControl: 'supported' | 'unsupported' | 'unknown';
  adapterVersion: string;
}
```

### Trust and integration capabilities

```ts
interface WorkspaceTrustReference {
  workspaceIdentity: string;
  status: 'untrusted' | 'trusted' | 'denied' | 'unknown';
  source: 'user' | 'admin' | 'ci-flag' | 'none';
  enabledSurfaces: string[];
  permissionCeilingDigest: string;
}

interface IntegrationCapabilityManifest {
  surface: 'tui' | 'cli' | 'headless' | 'sdk' | 'ci';
  providerOrigin?: string;
  mcpServerDigests?: string[];
  protocolDigests?: string[];
  webPolicyDigest?: string;
  lifecycleDigest: string;
  compatibility: 'compatible' | 'incompatible' | 'unknown';
}
```

Trust references are user/admin-owned authorization facts, not candidate-controlled guidance.
Integration manifests describe effective behavior and compatibility without storing credentials,
server instructions, raw schemas, or sensitive payloads.

## Improvement Workstreams

Treat these as separate measurable axes:

| Workstream | Primary question | Example metrics |
| --- | --- | --- |
| Prompt kernel | Does the stable policy improve reliability without distraction? | task success, policy violations, prompt tokens |
| Prompt layering | Does correct caching/provenance improve cost and consistency? | cache hits, prefix churn, attribution failures |
| Skills | Are relevant procedures activated and completed correctly? | activation precision/recall, outcome delta, false triggers |
| Tool contracts | Does the model select and recover from tools correctly? | selection accuracy, malformed calls, retries, recovery |
| Tool discovery | Is deferred loading worth its cost? | search success, activation delay, schema tokens, latency |
| Capability routing | Are common tools visible and deferred tools or agents activated from natural intent? | first-turn availability, next-turn use, unnecessary activation, child startup |
| Context retrieval | Is the right code available with less noise? | relevant-file recall, context tokens, repeated reads |
| Compaction/resume | Are decisions and failures preserved? | resume success, contradiction rate, recovery quality |
| Planning | Is planning used only when it helps? | plan overhead, plan fidelity, task success by complexity |
| Verification | Does the loop close on external evidence? | verifier coverage, false completion, regression rate |
| Recovery | Does the agent adapt after failure? | repeated-call rate, successful recovery, abandoned tasks |
| Model adapters | Does bounded provider/model guidance help? | per-model outcome delta, adapter cost, regressions |
| Subagents | Does delegation improve quality or context efficiency? | parent tokens, total cost, correctness, duplicate work |
| Memory | Does personalization help without contamination? | retrieval precision, correction rate, cross-project leaks |
| Hooks | Are deterministic rules enforced reliably? | hook coverage, failure rate, bypass attempts |
| User interaction | Is control clear and low-friction? | unnecessary questions, denial rate, correction loops |
| Security | Does provenance prevent instruction and capability escalation? | adversarial fixture pass rate, blocked escalation |
| External integrations | Are lifecycle, consent, and protocol behavior consistent across surfaces? | parity failures, startup leaks, timeout/cleanup failures |

Do not change several axes in one promotion experiment unless the interaction is predeclared and the
evaluation has enough power to attribute the result.

## Phase Integration

### Preconditions

Add prompt, skill, tool, hook, context, and model identities to the ambient run snapshot. Fix the
current skill restriction and trust ambiguities before treating skill-enabled runs as comparable.

### Phase 0

Add fixture classes for:

- skill activation positive, indirect, negative, ambiguous, and conflicting cases;
- overlapping tool selection and malformed-call recovery;
- deferred tool discovery and next-turn use;
- prompt-layer provenance and injection resistance;
- context retrieval, irrelevant-context pressure, and repository-map quality;
- compaction preservation of decisions, failures, modified files, and verifier commands;
- model/provider adapter compatibility;
- subagent preload, handoff, independence, and duplicate-work cases;
- hook enforcement versus advisory prompt guidance;
- untrusted-workspace blocking for hooks, providers, MCP, commands, skills, and subagents;
- permission-ceiling, sandbox-unavailable, credential-origin, SSRF, and bounded-response cases;
- TUI/headless/SDK lifecycle parity, including trust before process spawn or provider request;
- MCP/provider negotiation, schema change, timeout, cancellation, reconnect, and cleanup cases;
- verified, partial, blocked, and unknown completion communication.

### Phase 1

Define the capability-manifest contracts, authority classes, requested/effective resolution, and
fingerprints while keeping `off` provider-visible behavior identical.

Define workspace-trust and external-integration capability references at this boundary as well. They
must represent disabled, approved, denied, clamped, unsupported, and failed initialization states
without starting a process, reading a credential, or contacting a provider in `off` mode.

### Phase 2

Observe prompt-layer digests, skill activation, tool discovery, selected tools, malformed calls,
context contributions, compaction, verification, hook decisions, subagent handoffs, and model adapter
identity using bounded metadata rather than raw sensitive content.

### Phase 3

Keep workflows compact. A workflow may request only registered capability policies. It cannot embed
arbitrary prompt text, skill bodies, tool definitions, verifier commands, or model-specific code.

### Phase 3A

Implement the fixed agent-capability substrate described in
[Phase 3A](phase-3a-agent-capability-substrate.md). This must be manually selectable and measurable
before the automatic selector can depend on it. Reuse and fingerprint the canonical argument,
structured-error, read-before-edit, retry, and edit-guidance semantics already defined in the
[Tool Reliability Plan](../tool-reliability-plan.md); do not create a competing tool behavior layer.

### Phase 3B

Implement the routing behavior described in
[Phase 3B](phase-3b-capability-routing.md) after the Phase 3A manifests and budgets are verified.
This is the first phase allowed to change default `auto` exposure for common web and delegation
capabilities, preload tools from trusted original intent, require eager child allowlists, improve
deferred-search recovery, and make bounded read-only explorer delegation actionable. Keep Git,
MCP, notebook, session-history, and uncommon integrations deferred unless a fixed preload rule
matches. Compare routing bundles separately from workflow selection and keep `agents.mode = off`
behaviorally unchanged.

### Phase 4

The first selector continues selecting workflows only. Capability routing is frozen to the promoted
Phase 3B bundle; skill activation, tool-description variants, context policies, model adapters, and
delegation-policy changes remain separate experimental axes unless a later policy version explicitly
supports one after separate evaluation.

### Phase 5

Add outcomes for activation accuracy, tool-use quality, context efficiency, verification coverage,
recovery behavior, false completion, and user correction burden.

### Phase 6

Evaluate one capability axis at a time against the same base model and runtime. Use factorial or
interaction experiments only when predeclared and adequately powered. A workflow result is invalid
if its prompt, skill registry, tool contracts, context policy, or model adapter changed silently.

### Phase 7

Live eligibility keys include the complete capability manifest. Roll back the exact bundle, not only
the workflow ID.

### Phase 8

Initial bounded evolution remains workflow-only. Prompt modules, skill definitions, tool contracts,
context policies, or model adapters require separate candidate schemas, evaluator slices, query
budgets, promotion records, and rollback artifacts. Never allow a proposer to emit unrestricted
system prompts, tool schemas, executable scripts, or permission changes.

### Phase 9

Cross-model, cross-user, cross-project, and multi-agent transfer requires evidence that the relevant
capability manifests are compatible. Transfer aggregate outcome evidence, not raw prompts, skills,
memory, or repository content.

## Initial Skill Portfolio

Do not ship all skills at once. Create and evaluate a small initial set:

1. `root-cause-debugging`: reproduce, separate facts from hypotheses, fix, regression-test, verify.
2. `bounded-implementation`: inspect architecture, change the smallest complete scope, review diff.
3. `code-review`: findings-first review with severity, exact references, and no edits unless asked.
4. `test-failure-repair`: classify infrastructure versus product failure, reproduce, repair, rerun.
5. `architecture-change`: map contracts and consumers before broad or cross-module edits.
6. `visual-verification`: run and inspect TUI/frontend behavior on desktop and mobile where relevant.
7. `prompt-harness-evaluation`: compare locked capability bundles without changing evaluator rules.

Each skill needs activation and non-activation fixtures before implicit invocation is enabled.

## Decisions Required Before Implementation

1. Whether project skills require an approved/trusted workspace before implicit invocation.
2. Whether `InvokeSkill` becomes a core tool when skills exist or is replaced by `SkillSearch` plus a
   host-managed activation transition.
3. How active skills are represented across OpenAI-compatible and Anthropic provider requests.
4. Whether an active skill expires by turn, root run, or explicit completion.
5. How scoped skill tool restrictions are restored and displayed.
6. Which prompt layers providers may cache independently and how flattening preserves attribution.
7. Whether the first context improvement is a symbol/repository map, task retrieval, or both.
8. Which model capability fields can be verified through provider metadata and which remain unknown.
9. Whether SDK/headless consumers receive the same capability manifest and inspection surface.
10. Which capability axes are explicitly excluded from the initial adaptive selector.
11. Which project integration surfaces are disabled until workspace trust and how trust is supplied
    non-interactively without accepting repository-controlled authorization.
12. Which provider, MCP, and web lifecycle fields are stable enough for compatibility fingerprints
    and which must remain explicit unknowns.

## External Evidence

Sources reviewed for this gap analysis:

- AI World, [System prompts and what they tell us about the chat before the chat](https://aiworld.eu/story/system-prompts-and-what-they-tell-us-about-the-chat-before-the-chat).
- Anthropic, [Claude Code best practices](https://code.claude.com/docs/en/best-practices).
- Anthropic, [Extend Claude with skills](https://code.claude.com/docs/en/skills).
- Anthropic, [Create custom subagents](https://code.claude.com/docs/en/sub-agents).
- Anthropic, [Automate actions with hooks](https://code.claude.com/docs/en/hooks-guide).
- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
- OpenAI, [Codex manual](https://developers.openai.com/codex/codex-manual.md), especially
  customization, `AGENTS.md`, skills, tools, hooks, and prompting guidance.
- OpenAI, [Define tools](https://developers.openai.com/plugins/plan/tools).
- OpenAI, [Build skills](https://developers.openai.com/plugins/build/skills).
- Aider, [Repository map](https://aider.chat/docs/repomap.html).
- SWE-agent, [Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793).
- ToolLLM, [Facilitating Large Language Models to Master 16000+ Real-world APIs](https://arxiv.org/abs/2307.16789).
- Gorilla, [Large Language Model Connected with Massive APIs](https://arxiv.org/abs/2305.15334).
- ReAct, [Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629).
- Cline, [open-source coding agent](https://github.com/cline/cline), including first-class browser,
  MCP, and task surfaces alongside Plan/Act, rules/skills, checkpoints, and tool approval.
- OpenCode, [open-source coding agent](https://github.com/anomalyco/opencode), including direct web
  and task tool registration with explicit delegation guidance.
- Book, [Security Assessment and Remediation Plan](../security-assessment.md), for workspace trust,
  provider/MCP credentials, sandboxing, subagent permission inheritance, command expansion, and web
  access prerequisites.
- Book, [Tool Reliability Plan](../tool-reliability-plan.md), for existing canonical argument,
  structured-error, read-before-edit, retry, and model-conditional edit-guidance semantics.
- The security, observability, experimentation, privacy, and benchmark sources already listed in
  [research-grounding.md](research-grounding.md).

## Bottom Line

The adaptive harness should optimize a versioned agent capability bundle, but only after each
component is explicit, attributable, and independently testable. The immediate milestones are not
automatic workflow selection: Phase 3A must first provide a fixed, inspectable capability substrate,
then Phase 3B must prove that common tools, deferred discovery, child allowlists, and bounded
delegation route reliably from natural task intent.
