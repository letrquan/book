# Phase 3A: Build the Agent-Capability Substrate

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Research:** [Agent Capability Research and Gap Analysis](agent-capability-research.md)
- **Status:** Not started
- **Depends on:** Phase 3 verified, workspace-trust and fixed-runtime security preconditions verified
- **Blocks:** Phase 3B routing and Phase 4 selector may not use capability evidence before this phase is verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop
> conditions, and anti-drift review apply to every task in this phase.

## Objective

Make the complete agent capability surface explicit, bounded, lazy where appropriate, attributable,
and independently testable before automatic workflow selection can use it.

This phase is allowed to observe and compare only integration surfaces that have passed the parent
plan's workspace-trust, permission-ceiling, sandbox/network, credential-origin, and lifecycle
preconditions. A descriptor for a blocked or unsupported surface is valid; silently exercising that
surface is not.

This phase introduces no automatic learning and no default behavior change. It establishes fixed
manual capability bundles that can be compared fairly. It does not decide which common tools should
be visible or when an explorer should be spawned; those behavior changes belong to
[Phase 3B](phase-3b-capability-routing.md), which consumes this phase's manifests and evidence.

## Deliverables

- Split the system prompt into stable kernel, session context, dynamic policy, and task-state layers.
- Add a versioned prompt-layer manifest with trust class, source references, budget, digest, and cache
  policy.
- Add a versioned capability manifest covering prompt, workflow, skills, tools, context, model,
  verification, delegation, hooks, and permissions.
- Make skill metadata visible and skill bodies lazy; support explicit implicit/user-only/disabled
  invocation policy.
- Activate skills through an attributed dynamic policy frame rather than an untyped generic tool
  result.
- Scope skill tool restrictions to an activation frame and restore the parent capability surface when
  the frame expires.
- Make skill source, workspace trust, body/resource digests, and version visible in diagnostics.
- Strengthen tool contracts with intent, distinction, side effects, output/error contracts, retry,
  cancellation, and permission metadata.
- Add tool-contract and deferred-discovery fingerprints and evaluation fixtures.
- Add bounded context-policy descriptors and contribution accounting without changing retrieval
  behavior by default.
- Add exact model/provider capability descriptors and a minimal adapter boundary; unknown fields must
  remain unknown rather than being guessed.
- Add entry-surface and external-integration descriptors for TUI, headless/CI, SDK, providers, MCP,
  and web tools, including negotiation, authentication, timeout, cancellation, backpressure,
  cleanup, and schema-change fingerprints.
- Add subagent preload, handoff, independence, and capability-manifest metadata without changing
  managed-agent routing by default. Phase 3B may later use these contracts for eager child
  allowlists and bounded explorer routing.
- Add prompt, skill, tool, context, model, and subagent inspection output for debugging and reports.

## Work Breakdown

### 3A.1 Define capability and authority contracts

Add type-only contracts to the harness boundary:

```ts
type PromptLayerKind = 'kernel' | 'session-context' | 'dynamic-policy' | 'task-state';

interface PromptLayerDescriptor {
  kind: PromptLayerKind;
  version: string;
  sourceRefs: string[];
  trust: 'kernel' | 'approved-policy' | 'attributed-data';
  tokenBudget: number;
  digest: string;
  cache: 'stable' | 'session' | 'turn';
}

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

interface CapabilityManifest {
  schemaVersion: 1;
  prompt: PromptLayerDescriptor[];
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

Rules:

- contracts contain no arbitrary prompt, executable code, secrets, or evaluator internals;
- requested and effective values are separate;
- every value is classified as kernel-enforced, bounded guidance, or unsupported/clamped;
- every source retains provenance and trust class;
- project-controlled sources are denied until the workspace trust reference is approved;
- canonical serialization is used for hashes;
- `off` mode does not collect capability metadata or alter provider-visible messages.

### 3A.2 Split prompt zones and cache policy

Refactor `src/agent/context.ts` so the host can render and fingerprint these zones independently:

```text
stable kernel
  identity, safety, permissions, communication, invariant operating rules

session context
  project instructions, workspace, Git, skills/commands/agents/tool indexes, memory

dynamic policy
  workflow, active skill frames, model adapter, context policy, managed-agent identity

task state
  todos, current evidence references, checkpoint/resume freshness
```

The provider adapter may flatten the zones, but the host retains their identities. Dynamic values
must not be placed in the stable cached prefix merely because they are text.

Required tests:

- changing a todo does not change the stable kernel digest;
- changing Git state does not change the kernel digest;
- activating a skill changes only the dynamic-policy digest and provider request as expected;
- changing an active tool schema changes the tool-surface and relevant context digest;
- flattening produces equivalent provider messages for OpenAI-compatible and Anthropic adapters;
- prompt budgets and truncation are deterministic and visible.

### 3A.3 Implement the skill lifecycle

Extend the current `Skill` contract with:

```ts
interface SkillDescriptor {
  id: string;
  version: string;
  description: string;
  whenToUse?: string;
  source: 'builtin' | 'user' | 'project' | 'plugin';
  invocation: 'implicit' | 'user-only' | 'disabled';
  allowedTools?: string[];
  bodyDigest: string;
  resourceDigest?: string;
}
```

Implement:

- source precedence and duplicate-ID resolution;
- strict frontmatter validation and unknown-field handling;
- bounded description and body/resource budgets;
- lazy body loading;
- explicit activation reason (`user`, `model`, `workflow`, or `subagent-preload`);
- activation version/digest and expiry (`turn`, `run`, or explicit completion);
- positive, negative, ambiguous, and conflicting trigger tests;
- explicit handling for missing or unreadable supporting files;
- inspection of active and previously activated skills without exposing sensitive bodies by default.

Skill bodies must be placed in a dedicated active-policy frame with an authority statement. They are
subordinate to the kernel, current user request, permissions, and trusted project policy. A skill
cannot change permissions, budgets, evaluator rules, security policy, or the tool schemas.

Make the skill tool available without an unnecessary discovery round-trip when at least one skill is
available, or add a dedicated skill-search/activation path and measure its cost. Do not silently
change the default tool-discovery mode until an evaluation fixture proves equivalence or benefit.

Replace cumulative `restrict()` behavior with an explicit scoped capability intersection. The parent
surface must be restored when the skill frame expires or the skill invocation fails.

### 3A.4 Strengthen tool contracts

The [Tool Reliability Plan](../tool-reliability-plan.md) is the canonical source for built-in tool
argument normalization, actionable structured errors, read-before-edit freshness, retry guidance,
and model-conditional edit-format recommendations. This phase must consume and fingerprint those
semantics; it must not introduce a second alias map, error taxonomy, retry circuit breaker, or edit
matching policy. External MCP schemas remain authoritative and are classified rather than rewritten.

Add or normalize metadata for every tool:

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

For overlapping tools, descriptions must state user intent, selection conditions, distinctions,
prerequisites, side effects, and failure recovery. At minimum review filesystem mutation, shell,
Git, tool discovery, skill invocation, planning, evidence, and agent tools.

Add contract fixtures for:

- valid and invalid arguments;
- ambiguous requests requiring tool distinction;
- unauthorized or protected targets;
- timeout, cancellation, retry, and partial-result behavior;
- malformed tool output;
- idempotent versus non-idempotent replay;
- tool result provenance and prompt-injection content;
- active/deferred tool selection and schema-budget failure;
- compatibility with the existing tool-reliability fixtures and semantics.

### 3A.5 Add context-policy descriptors

Do not change retrieval quality in this phase unless a fixed experimental policy is explicitly
selected. First add accounting:

```ts
interface ContextContribution {
  source: 'kernel' | 'project' | 'memory' | 'repository' | 'tool' | 'web' | 'user' | 'derived';
  reference: string;
  tokens: number;
  trust: 'trusted-policy' | 'attributed-data';
  freshness?: string;
}
```

Record which files, symbols, tool results, instructions, memory entries, and skill resources
contributed to a request. Keep raw content out of the ledger by default.

Define fixed, manually selectable context policies for later comparison:

- `relevant`: existing Book behavior;
- `structure-first`: bounded repository/symbol map before file reads;
- `task-pack`: task-scoped relevant files and evidence references;
- `deep`: explicitly requested broad context with a declared token budget.

Add fixtures for irrelevant-context pressure, repeated reads, stale instructions, oversized outputs,
compaction, checkpoint freshness, and resume preservation.

### 3A.6 Define model/provider capability adapters

Create a capability descriptor keyed by exact provider/model/config identity:

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

Adapter guidance must be short, capability-driven, and bounded. Unknown or aliased models receive
the minimal profile. Do not encode provider marketing names or hand-maintained quality labels.

Test provider-message flattening, message ordering, tool-result formatting, output limits, retry,
stream stalls, structured output, multimodal attachments, and prompt-cache assumptions per adapter.

Also test provider lifecycle boundaries: credential-origin binding, initialization failure, timeout,
abort, retry/reconnect, rate-limit/backpressure, partial stream, and final status mapping. A proxy or
alias that cannot prove exact model identity remains `unknown` and is not eligible for cross-provider
transfer.

### 3A.7 Describe external integration boundaries

Add an integration descriptor keyed by entry surface and protocol/configuration identity. At minimum
capture:

- `surface`: `tui | cli | headless | sdk | ci`;
- provider transport and resolved origin, or an explicit unverifiable marker;
- MCP server identity, transport, negotiated protocol/capabilities, authentication mode, and
  configuration source;
- web-tool redirect, DNS/private-address, response-byte, and content-sanitization policy;
- startup, request, stream, shutdown, and cleanup outcomes with bounded timings;
- effective environment, permission, sandbox, and network ceilings;
- inspection, approval, event, budget, and evidence parity across surfaces.

Project MCP, provider, hook, command, and skill-script entries must remain disabled in an untrusted
workspace. Headless and SDK runs must expose the same trust decision and capability manifest as TUI
runs, or declare the difference and reject comparison.

### 3A.8 Add subagent capability and handoff metadata

Without changing default delegation, record the substrate required by later routing experiments:

- parent and child capability-manifest digests;
- preloaded skills and context packs;
- exact tool and permission surface;
- task, evidence, snapshot, and freshness references;
- child input/output/token/time budgets;
- handoff schema and verifier status;
- independence relationship for validator/reviewer runs;
- duplicate-work or stale-snapshot warnings.

Add a typed handoff contract for explorer, patcher, validator, and custom agents. A handoff must
separate observations, hypotheses, changes, checks, blockers, and evidence references.

### 3A.9 Add deterministic controls and user inspection

Classify every capability as model guidance, host-enforced policy, deterministic hook, trusted
verifier, or user approval. Add inspection surfaces that show, without raw sensitive content:

- prompt-layer versions and token budgets;
- active workflow and skill frames;
- workspace trust and external integration state;
- active/deferred tools and why a tool was loaded;
- context contribution summary;
- model/provider capability identity;
- verification plan and evidence state;
- subagent handoff and isolation state;
- clamps, unknowns, and fallback reasons.

Formatting, protected paths, mandatory todo bookkeeping, redaction, and evaluator execution must not
depend solely on model instructions.

### 3A.10 Add fixed capability bundles

Create manually selectable bundles for evaluation only:

```text
minimal-capability
  current prompt behavior, current skills/tool surface, no new retrieval

progressive-capability
  split prompt zones, lazy skills, explicit activation, stronger tool contracts

context-capability
  progressive capability plus one fixed context policy

verify-capability
  progressive capability plus explicit verification planning and evidence display
```

Do not combine all improvements into the first treatment. Each bundle must declare its changed
components and remain within the fixed trusted kernel.

## File Plan

```text
Add    src/harness/capabilities.ts
Add    src/harness/capabilities.test.ts
Add    src/harness/prompt-layers.ts
Add    src/harness/prompt-layers.test.ts
Add    src/harness/skill-contracts.ts
Add    src/harness/skill-contracts.test.ts
Add    src/harness/tool-contracts.ts
Add    src/harness/tool-contracts.test.ts
Add    src/harness/context-policy.ts
Add    src/harness/context-policy.test.ts
Add    src/harness/model-capabilities.ts
Add    src/harness/model-capabilities.test.ts
Add    src/harness/integration-capabilities.ts
Add    src/harness/integration-capabilities.test.ts
Add    src/harness/handoff-contracts.ts
Add    src/harness/handoff-contracts.test.ts
Modify src/agent/context.ts
Modify src/skills.ts
Modify src/tools/skills-tool.ts
Modify src/tools/catalog.ts
Modify src/tools/registry.ts
Modify src/subagent.ts
Modify src/agents/manager.ts
Modify src/agents/profiles.ts
Modify src/types/providers.ts
Modify src/agent/context.test.ts
Modify src/skills.test.ts
Modify src/tools/skills-tool.test.ts
Modify src/agent/tool-discovery.test.ts
Modify provider contract tests
Modify MCP, web, headless, and SDK lifecycle tests
```

The exact file list may be reduced during implementation if an existing type or registry is the
correct ownership boundary. Do not add duplicate global registries merely to satisfy this sketch.

## Evaluation Matrix

Every treatment must lock model, provider, runtime, tool surface, project revision, settings,
skills, commands, memory, context budget, evaluator, and network policy.

Required cases:

| Class | Minimum cases |
| --- | --- |
| Skill activation | direct, indirect, negative, ambiguous, conflict, missing body |
| Tool routing | overlapping tools, deferred search, malformed args, retry/cancel |
| Prompt layers | digest stability, budget clipping, trust/provenance, injection |
| Context | relevant retrieval, irrelevant pressure, stale state, compaction/resume |
| Model adapter | exact identity, alias/unknown, provider flattening, tool-result ordering |
| Verification | targeted/full, missing verifier, failed verifier, visual check, unknown |
| Subagents | preload, isolation, independent review, stale snapshot, duplicate work |
| Hooks | block, modify, timeout, failure mode, precedence, audit |
| Integrations | untrusted startup, provider/MCP negotiation, auth, timeout, cancellation, cleanup, surface parity |
| UX | permission clarity, active capability display, cancellation, partial/unknown completion |

Primary metrics should include task outcome and correctness. Guardrails should include false
completion, regression, policy violations, prompt-injection resistance, cost, latency, context
tokens, tool errors, unnecessary skill activation, unnecessary questions, and user correction rate.

### Activation metrics

Measure skill precision, recall, false activation cost, activation latency, body tokens, completion
quality, and whether the skill caused unsupported tool or permission requests.

### Tool metrics

Measure correct-tool selection, malformed-call rate, deferred-search success, recovery after errors,
schema tokens, tool-call latency, and side-effect violations.

### Context metrics

Measure relevant-file recall, irrelevant-token ratio, repeated-read rate, decision/failure retention,
resume correctness, compaction loss, and cache-prefix churn.

### Bundle metrics

Compare total correctness, reliability, regression, alignment, cost, latency, and harness complexity.
When outcomes tie within the declared uncertainty band, keep the simpler bundle.

## Test Matrix and Exit Gate

- `off` provider messages, tool definitions, permissions, and session behavior are unchanged.
- Untrusted workspaces cannot start project hooks, providers, MCP servers, executable commands,
  skill scripts, or privileged subagents.
- Permission, sandbox, network, and credential-origin ceilings are monotonic and truthful on every
  entry surface.
- TUI, headless, SDK, and CI runs either expose equivalent lifecycle/evidence semantics or carry an
  explicit incompatible-surface marker.
- Every prompt layer has deterministic digest, budget, source, trust, and cache behavior.
- Skill activation is lazy, scoped, inspectable, and cannot change the trusted kernel.
- Active skill restrictions restore correctly after expiration or failure.
- Tool contracts have stable schemas, errors, effects, and retry/cancellation metadata.
- Deferred discovery failures are distinguishable from model selection failures.
- Context contributions retain provenance without persisting raw sensitive content by default.
- Unknown model/provider capabilities remain unknown and select the minimal adapter.
- Subagent handoffs are typed, bounded, and independent where declared.
- Deterministic controls are enforceable outside the prompt.
- Fixed capability bundles are reproducible and comparable.
- The phase can be disabled without migration or behavior drift.

```powershell
npm run typecheck
npm run test:unit -- src/harness/capabilities.test.ts
npm run test:unit -- src/harness/prompt-layers.test.ts
npm run test:unit -- src/harness/skill-contracts.test.ts
npm run test:unit -- src/harness/tool-contracts.test.ts
npm run test:unit -- src/harness/context-policy.test.ts
npm run test:unit -- src/harness/model-capabilities.test.ts
npm run test:unit -- src/agent/context.test.ts
npm run test:unit -- src/skills.test.ts
npm run test:unit -- src/agent/tool-discovery.test.ts
npm test
```

**Exit gate:** Book can produce a versioned capability manifest and compare fixed capability bundles
without starting untrusted integrations, changing the trusted kernel, silently changing
provider-visible behavior, or treating prompt text as enforcement.

Phase 3A is not complete until the Phase 3B input is sufficient to identify the effective root and
child tool surfaces, schema budgets, preload reasons, delegation policy, and handoff digests without
guessing from prompt text.

**Rollback:** Disable capability bundles and return to the accepted Phase 3/minimal behavior. Keep
contract and diagnostic records readable but ineligible for adaptive selection.

**Intent check:** Are we making the agent's capability surface measurable, or merely adding more
prompt text and metadata?
