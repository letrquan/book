# Phase 3B: Make Capability Routing Reliable

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Research:** [Agent Capability Research and Gap Analysis](agent-capability-research.md)
- **Status:** Not started
- **Depends on:** Phase 3A verified, workspace-trust and fixed-runtime security preconditions verified
- **Blocks:** Phase 4 selector may not use capability-routing evidence before this phase is verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

The runtime already has hybrid tool discovery and advisory explorer routing, but this phase remains
"Not started": the routing bundle has not been isolated, evaluated against the defined matrix, or
verified behind the Phase 3A capability manifest and trust gates.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop
> conditions, and anti-drift review apply to every task in this phase.

## Objective

Make Book reliably expose and use the tools and managed agents that match the current task without
placing every uncommon integration in the provider request. Phase 3A makes capability surfaces
measurable; this phase changes one routing axis at a time and establishes a safe production default.

The target is not more tool calls or more delegation. The target is correct first-turn capability
availability, correct selection, successful next-turn use after discovery, and bounded delegation
that improves outcomes or parent-context efficiency.

## Fixed Decisions

### Root tool exposure uses a hybrid surface

- Keep the existing filesystem, mutation, task, runtime, question, todo, and `ToolSearch` core
  behavior subject to mode and permission checks.
- Keep `WebSearch` and `WebFetch` visible at the root when network policy permits them.
- Keep the root managed-agent lifecycle visible when `agents.mode` is not `off` and delegation is
  permitted: `AgentPlan`, `AgentSpawn`, `AgentList`, `AgentGet`, `AgentRead`, `AgentSend`,
  `AgentWait`, `AgentStop`, and `AgentApply`.
- Keep Git, notebook, session-history, MCP, skills, and uncommon integration tools deferred unless a
  fixed intent rule preloads them.
- Apply role, trust, permission, mode, runtime-availability, sandbox, and network filters before a
  tool can be core, preloaded, or discoverable.

The eager tool-count threshold must not force an otherwise budget-fitting core surface into deferred
behavior. In `auto` mode, the schema-token budget is the primary limit; the count threshold is only
a diagnostic and compatibility setting. If the required core surface does not fit, Book reports the
budget failure explicitly instead of silently hiding a required tool.

### Intent preload is deterministic and versioned

Add a small host-owned intent-to-capability map evaluated from the original user request and trusted
command metadata. Repository text, web content, memory, and tool output cannot trigger preload.

Initial preload rules for tools outside the hybrid core:

| Intent evidence                                                | Preloaded capability                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| commit, branch, history, working-tree, or diff request         | matching read-only Git tools; mutation Git tools only for explicit mutation intent |
| prior conversation, transcript, or session-history request     | session-history search/read tools                                                  |
| named skill or reusable workflow request                       | `InvokeSkill` when an eligible skill exists                                        |
| notebook or cell request                                       | matching notebook tools                                                            |
| explicitly named trusted MCP server, namespace, or integration | matching integration tools when the bounded schema fits                            |

Each preload decision records the policy version, matched rule, loaded tools, schema tokens, and any
trust, permission, mode, or budget rejection. Intent preload only changes schema visibility; it does
not grant permission, execute a tool, or override user-owned settings.

### Child allowlists are eager contracts

- Every explicitly allowed child tool is visible on the child's first provider request when the
  complete allowlist fits the child schema budget.
- The child capability manifest and prompt list only the tools that passed role, trust, permission,
  isolation, and runtime checks.
- If the complete allowed surface does not fit, reject child startup with a structured
  `child_tool_budget_exceeded` result containing requested tools, required tokens, available tokens,
  and the profile or setting that must be narrowed. Do not silently defer role-critical tools.
- A zero-tool or unresolved-tool child fails closed before provider execution.
- Explorer, patcher, validator, and custom profiles receive separate versioned surface digests.

### Deferred discovery has deterministic retrieval and recovery

- Match canonical names and aliases exactly before fuzzy ranking.
- Normalize case, punctuation, singular/plural forms, and common intent phrases.
- Rank name, aliases, curated intent phrases, category, namespace, and description in that order.
- Maintain one canonical metadata source; do not create a second alias or category registry.
- When no result clears the declared threshold, return available categories, nearest canonical names,
  and a suggested narrower query rather than an empty unexplained result.
- Distinguish no match, unauthorized tool, unavailable runtime, schema-budget rejection, and already
  active tool in the result contract.
- Record query, ranked candidates, selected activation, activation reason, latency, and whether the
  activated tool was called on the following eligible turn.

Natural-language routing fixtures must include at least `youtube transcript`, `web tool`, `research
this deeply`, `parallel research`, `spawn explorer`, `inspect git history`, and negative requests
that must not call web or agents and must not preload Git, session-history, notebook, skill, or
integration tools.

### Prompts derive from the effective capability surface

- Render separate compact sections for `available now`, `preloaded for this task`, and
  `discoverable with ToolSearch`.
- Generate managed-agent instructions from effective agent and tool manifests rather than static
  text that may name hidden capabilities.
- Validate built-in and project profiles so prompt bodies cannot promise tools outside the effective
  allowlist.
- When a named tool or agent is blocked, tell the model why and what safe recovery is available.
- Keep routing instructions concise and versioned; do not compensate for hidden schemas with a large
  universal prompt.

### Adaptive delegation becomes actionable and bounded

`agents.mode` retains its existing user-facing modes:

- `off`: no managed-agent surface and no automatic delegation;
- `manual`: visible lifecycle tools, but no host-triggered child;
- `adaptive`: the model may delegate immediately, and the host may automatically start one
  read-only explorer after the configured inline-search budget is exhausted.

The initial automatic policy applies only to the built-in explorer. It triggers at the loop boundary
before the next provider request, once per root task, after at least the configured number of
successful `Glob`/`Grep` calls and before a terminal response. It is suppressed after a mutation tool
has started, after an explorer handoff already covers the question, or when budget, depth,
concurrency, trust, permission, or cancellation checks fail. Patcher and validator remain
model-selected or explicitly requested until a separate evaluation proves automatic routing
beneficial.

The parent receives a typed explorer handoff and continues from that evidence; it must not repeat the
same broad search without recording a stale, incomplete, or contradictory handoff reason.

Replace `agents.routing.exploreReminder` with
`agents.routing.explorationAction: 'off' | 'remind' | 'spawn'`. The new default is `spawn` when
`agents.mode = adaptive`, `remind` when `agents.mode = manual`, and `off` when `agents.mode = off`.
For one compatibility release, explicitly configured legacy `false` maps to `off` and legacy `true`
maps to `remind`; diagnostics identify the deprecated field and the resolved action.

## Contract Additions

```ts
type ToolLoadReason = 'core' | 'runtime' | 'intent-preload' | 'tool-search' | 'child-allowlist';

interface ToolRoutingDecision {
  policyVersion: string;
  tool: string;
  reason: ToolLoadReason;
  matchedRule?: string;
  schemaTokens: number;
  outcome: 'active' | 'blocked' | 'unavailable' | 'over-budget';
  detailCode?: string;
}

interface ChildToolBudgetExceeded {
  code: 'child_tool_budget_exceeded';
  requestedTools: string[];
  requiredTokens: number;
  availableTokens: number;
  profile: string;
}
```

These records are diagnostic and evidence contracts. They contain no raw prompt, tool output,
credentials, or repository content. Canonical serialization and policy versions are included in the
Phase 3A capability manifest and comparison fingerprints.

## Work Breakdown

### 3B.1 Freeze routing contracts and baselines

- Add versioned descriptors for root exposure, intent preload, child eager loading, discovery ranking,
  prompt rendering, and adaptive delegation.
- Capture the current 16-active/23-deferred surface and current natural-language search results as a
  regression baseline.
- Estimate schema tokens from normalized provider-visible definitions and record both count and token
  thresholds.

### 3B.2 Implement hybrid root exposure and intent preload

- Update catalog exposure policy and `auto` budget resolution.
- Add the trusted original-intent preload map and decision evidence.
- Keep explicit `eager` and `deferred` settings behavior compatible; the new hybrid policy is the
  default `auto` behavior.

### 3B.3 Enforce eager child surfaces

- Resolve and validate the complete child allowlist before provider execution.
- Produce deterministic budget and unresolved-tool failures.
- Ensure child prompt, provider schemas, permission surface, and capability digest agree.

### 3B.4 Improve search, activation, and prompt alignment

- Strengthen canonical metadata and deterministic ranking/fallback behavior.
- Track activation and next-turn use as separate events.
- Build all tool and agent prompt sections from the effective surface.

### 3B.5 Make adaptive explorer routing actionable

- Convert the existing reminder-only exploration threshold into the bounded policy above.
- Preserve cancellation, depth, concurrency, isolation, snapshot, and permission ceilings.
- Record trigger, suppression, spawn, handoff, duplicate-work, and recovery outcomes.

### 3B.6 Evaluate, select, and roll out one fixed routing bundle

Compare these fixed arms before changing the default:

```text
current-routing
  current core/deferred surface, fuzzy ToolSearch, reminder-only exploration routing

hybrid-routing
  hybrid root core and deterministic intent preload

child-eager-routing
  hybrid routing plus eager child allowlists

adaptive-explorer-routing
  child-eager routing plus bounded automatic explorer delegation
```

Promote only the simplest arm that passes the exit gate. Keep every component separately versioned
so later workflow selection cannot receive credit for a routing-policy change.

## File Plan

```text
Modify src/settings.ts
Modify src/tools/catalog.ts
Modify src/types/tools.ts
Modify src/agent/context.ts
Modify src/agent/exploration-routing.ts
Modify src/agents/manager.ts
Modify src/agents/profiles.ts
Modify src/tools/catalog.test.ts
Modify src/agent/tool-discovery.test.ts
Modify src/agent/context.test.ts
Modify src/agent/exploration-routing.test.ts
Modify src/agents/manager.test.ts
Modify src/agents/profiles.test.ts
```

Use the existing catalog and capability-rule ownership boundaries. Do not add a second tool registry,
alias map, permission evaluator, or subagent launcher.

## Evaluation Matrix

| Class               | Required cases                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| Web routing         | current information, public research, direct URL, transcript, citations, negative local-only task         |
| Discovery           | exact name, alias, intent phrase, category filter, no match, unauthorized, unavailable, over budget       |
| Git/session preload | read-only intent, mutation intent, ambiguous intent, negative task                                        |
| Child surface       | complete allowlist, over budget, unknown tool, role mismatch, permission clamp, zero tools                |
| Prompt alignment    | active/preloaded/deferred sections, blocked reason, no promised hidden tool                               |
| Delegation          | threshold trigger, sufficient local answer, duplicate work, budget/depth cap, cancellation, typed handoff |
| Compatibility       | `auto`, explicit `eager`, explicit `deferred`, `agents.mode` off/manual/adaptive                          |
| Security            | untrusted workspace, denied network, permission ceiling, prompt-injection preload attempt                 |

Primary metrics:

- correct first-turn capability availability and correct first eligible tool call;
- ToolSearch top-1/top-3 recall, activation success, activation latency, and next-turn use;
- unnecessary ToolSearch, web, Git, and agent calls;
- child startup success, handoff completeness, parent-context savings, duplicate work, total cost, and
  latency;
- task correctness, false completion, user correction rate, and policy violations.

## Test and Exit Gate

- Routing fixtures run across every supported provider/model family with the same policy version.
- Hybrid routing improves correct first-turn capability use on the target corpus by at least 15
  percentage points over the current baseline.
- Deferred discovery top-3 recall is at least 90% on the frozen routing corpus, and at least 90% of
  successful activations are used on the next eligible turn.
- Beyond the fixed hybrid-core schema cost, unrelated fixtures add no more than 5% schema overhead
  through false-positive intent preload.
- Automatic explorer delegation does not reduce task correctness or increase median total cost by
  more than 15% on eligible broad-search tasks; it must reduce parent-context tokens or improve
  correctness on the promoted slice.
- Permission, trust, sandbox, network, and role violations remain zero.
- `agents.mode = off`, explicit `toolDiscovery.mode = eager`, and explicit
  `toolDiscovery.mode = deferred` retain their documented semantics.
- Every hidden, rejected, preloaded, discovered, or spawned capability has an inspectable reason.

```powershell
npm run typecheck
npm run test:unit -- src/tools/catalog.test.ts
npm run test:unit -- src/agent/tool-discovery.test.ts
npm run test:unit -- src/agent/context.test.ts
npm run test:unit -- src/agent/exploration-routing.test.ts
npm run test:unit -- src/agents/manager.test.ts
npm run test:unit -- src/agents/profiles.test.ts
npm test
```

**Exit gate:** Book has a promoted, versioned routing bundle that reliably exposes common web and
delegation capabilities, eagerly satisfies valid child allowlists, retrieves deferred tools from
natural-language intent, and performs bounded explorer delegation without violating guardrails.

**Rollback:** Select `current-routing`, restore the previous `auto` exposure behavior, and disable
host-triggered explorer delegation. Keep routing evidence readable but ineligible for selection.

**Intent check:** Are tools and agents being used because they improve the task, or merely because
the new surface made them easier to call?
