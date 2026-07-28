# Phase 1: Add Contracts and a Disabled Harness Boundary

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Not started
- **Depends on:** Phase 0 verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---


**Objective:** Create clean module boundaries without changing runtime behavior.

**Deliverables:**

- Add `src/harness/contracts.ts` with run, workflow, event, and outcome types.
- Add a settings mode such as `off | observe | shadow | active | learn`, defaulting to `off`.
- Add an optional frozen harness run context to the agent-loop invocation.
- Define the coordinator interface without implementing learning.
- Document the immutable kernel fields that workflows cannot control.
- Define compatibility identities for the fixed runtime, environment, and tool surface without collecting them in `off` mode.
- Define the versioned agent capability manifest for prompt layers, skills, tool contracts, context
  policy, model/provider capabilities, verification, hooks, delegation, and permissions.
- Define workspace-trust and external-integration references for TUI, headless/CI, SDK, provider,
  MCP, and web surfaces, including requested/effective security posture and unavailable states.
- Separate fixed runtime primitives from the bounded workflow-selectable surface.

#### Phase 1 Work Breakdown

##### 1.1 Add the harness mode setting

Extend `src/settings.ts` and settings resolution with a nested harness setting (do not reuse the
existing managed-agent `settings.agents.mode` key) with:

```ts
type HarnessMode = 'off' | 'observe' | 'shadow' | 'active' | 'learn';
```

Rules:

- default is `off`;
- `observe` may persist evidence but cannot alter prompts, tools, permissions, or provider requests;
- `shadow` computes and records a decision but cannot control the live run;
- `active` may choose only an eligible promoted workflow from the trusted rollout registry;
- `learn` may generate candidates but cannot promote them without Phase 8 gates;
- invalid values fail configuration validation rather than silently falling back.

Only `off` is available in Phase 1. Later phases enable the other modes one at a time through an
explicit availability gate; requesting a valid-but-unavailable mode must fail before provider calls,
storage creation, or environment inspection rather than silently changing behavior.

Update redaction and configuration display so the mode is inspectable and contains no sensitive evidence.

##### 1.2 Define shared contracts without runtime imports

Create `src/harness/contracts.ts` as a type-focused module. Initial contracts should include:

```ts
interface HarnessRunContext {
  runId: string;
  mode: HarnessMode;
  workflow?: WorkflowDecision;
  policyVersion?: string;
  runtimeFingerprint?: string;
  environmentFingerprint?: string;
  toolSurfaceFingerprint?: string;
  capabilityManifestDigest?: string;
  workspaceTrustFingerprint?: string;
  integrationFingerprint?: string;
}

interface WorkflowDecision {
  id: string;
  version: number;
  reasonCode: string;
  explanation?: string; // bounded, redacted display text only
  source: 'baseline' | 'manual' | 'fixed' | 'adaptive' | 'candidate';
}

interface HarnessCoordinator {
  prepareRun(input: PrepareRunInput): Promise<PreparedRun>;
  observe(runId: string, event: HarnessEvent): void;
  finalizeRun(runId: string, result: FinalizeRunInput): Promise<void>;
}
```

Avoid importing provider, TUI, or tool implementations into the contracts module.

Trust and integration contracts are descriptive only. They cannot authorize a project hook, provider
origin, MCP process, command block, skill script, or subagent. The host must resolve these requests
against the user-owned workspace-trust decision and the fixed permission/sandbox/network ceilings.

In `off` mode the harness context/coordinator is absent and no run ID is generated. The required
run context applies only after observation is enabled; this preserves the stated no-op behavior.

##### 1.3 Thread an optional frozen context through execution

Add an optional harness field to the existing agent-loop options rather than module-level mutable state. The field must be prepared once by the host and treated as read-only by the loop.

Pass only the minimum data required by:

- context rendering;
- event attribution;
- allowed runtime transitions;
- user-facing explanation.

Do not place the evidence store, learner, or mutable policy object on `AgentConfig`.

##### 1.4 Add a no-op coordinator

Create a no-op facade that returns a typed disabled result with no run context or run ID and drops all
events. It may simplify host call sites, but it must not invoke enabled-mode preparation or fabricate
a baseline run.

The no-op path must not:

- generate random IDs that leak into prompts or persisted sessions;
- read project files;
- write harness storage;
- alter callback timing;
- change error behavior.

For enabled modes, define an asynchronous observer lifecycle (`enqueue`, `flush`, `close`) with
bounded queues, dropped-event counters, backpressure policy, and shutdown semantics. Split the
immutable initial decision from any later typed transition state.

##### 1.5 Define the trusted kernel contract

Document fields and actions that workflow configuration cannot control:

- permission rules and effective permission mode ceilings;
- sandbox configuration;
- secrets and provider credentials;
- absolute token/cost/time limits;
- evaluator definitions and held-out set membership;
- audit retention;
- candidate promotion authority;
- model/provider identity during comparisons.
- tool names, schemas, permission requirements, error semantics, and implementation identity;
- prompt-injection defenses and trust/provenance rules;
- checkpoint, compaction, resume, cancellation, and retry correctness;
- trace identity and evidence-integrity rules.

Current legacy subagents run with a fixed `bypassPermissions` loop mode and a restricted capability
registry. Treat that as an existing runtime security decision to audit, fingerprint, and test; no
workflow may select or broaden it, and initial single-agent harness evaluation keeps managed agents off.

Represent requested versus effective values separately when later workflows request a posture that the kernel clamps.

##### 1.6 Establish import and ownership boundaries

Add a lightweight dependency test or review rule:

```text
agent runtime -> harness contracts only
harness coordinator -> runtime contracts and stores
evaluation -> completed run records
TUI -> coordinator facade, never evaluator internals
```

##### 1.7 Define fixed-runtime and compatibility contracts

Add type-only contracts for:

```ts
interface RuntimeCompatibilityIdentity {
  runtimeFingerprint: string;
  environmentFingerprint: string;
  toolSurfaceFingerprint: string;
  contextCapabilitiesVersion: string;
}

interface ToolSurfaceDescriptor {
  id: string;
  schemaHash: string;
  implementationVersion?: string;
  permissionClass: string;
  supportsCancellation: boolean;
  retrySafety: 'safe' | 'unsafe' | 'unknown';
}
```

These contracts identify compatibility; they do not authorize the harness to redefine tools or runtime behavior. Fingerprint collection begins only in later observe/evaluation phases and must remain absent from the Phase 1 `off` path.

The `off` path must also avoid resolving project-controlled provider credentials, starting MCP or
hook processes, loading executable skill resources, or contacting external endpoints merely to build
an integration fingerprint.

##### 1.8 Publish the workflow capability matrix

Before Phase 3, map every proposed workflow field to a concrete enforcement point and classify it
as `kernel-enforced request`, `prompt-only guidance`, or `unsupported/clamped`. Initial Book does not
yet provide enforceable controls for several proposed fields, including input-context ceilings,
handoff, edit-scope limits, trusted verifier execution, or workflow-specific retry logic.

Also decide whether the first harness release is available through the public SDK/headless options.
If it is, include `src/sdk.ts` and `src/types/public-sdk.ts`; otherwise record CLI/settings-only scope.

Before Phase 3A, publish the companion capability matrix. For every prompt, skill, tool, context,
model, verifier, hook, and delegation field, classify it as:

```text
kernel-enforced
host-enforced
deterministic-hook
trusted-verifier
bounded model guidance
unsupported/clamped
```

The capability matrix must explicitly cover skill activation authority, scoped skill restrictions,
tool-contract versioning, context retrieval policy, provider prompt flattening, model identity, and
subagent preload/handoff behavior. Prompt text alone must never be reported as enforcement.

#### Phase 1 File Plan

```text
Add    src/harness/contracts.ts
Add    src/harness/coordinator.ts       # no-op/baseline only
Add    src/harness/contracts.test.ts
Modify src/settings.ts
Modify src/settings-loader.test.ts
Modify src/settings-redaction.test.ts
Modify src/agent/loop.ts                # optional context only
Modify src/agent/loop.test.ts
Modify src/types/*                       # only if truly shared; `src/types.ts` is forbidden
Modify src/session/agent-session.ts     # shared root-request lifecycle boundary
Modify src/session/agent-events.ts      # lossless terminal reason/event semantics
Modify src/settings-repository.ts       # settings key enumeration/precedence
```

#### Phase 1 Test Matrix

- Harness omitted versus explicit `off` produces identical provider messages.
- Harness `off` creates no directories or records.
- Invalid mode is rejected at every settings layer.
- Project/local/user settings precedence remains unchanged.
- Optional run context does not survive into later runs accidentally.
- Subagents inherit only explicitly approved run metadata, not mutable coordinator state.
- Aborted and failed runs behave exactly as before in `off` mode.
- Workflow-facing types cannot redefine tool schemas, retries, cancellation, checkpoint/resume mechanics, provenance rules, or security enforcement.
- Compatibility fields are optional and do not trigger environment inspection in `off` mode.
- Future modes are rejected by capability availability, not only enum parsing.
- Workflow-facing contracts classify each field as kernel-enforced, guidance-only, or unsupported/clamped.
- Runtime failure and cancellation semantics remain lossless through session finalization.

**Verification:**

- With harness mode `off`, system prompts, tool definitions, permission decisions, session records, and provider requests remain behaviorally identical.
- Existing unit tests pass without fixture rewrites unrelated to the new optional types.
- Import-graph checks show no learner/promotion dependency from the agent runtime.
- The type boundary makes fixed runtime responsibilities distinguishable from adaptive requests.

**Commands:**

```powershell
npm run typecheck
npm run test:unit -- src/agent/loop.test.ts
npm run test:unit -- src/agent/context.test.ts
npm run test:unit -- src/settings-loader.test.ts
npm test
```

**Exit gate:** The harness can be compiled in but is inert and removable.

**Rollback:** Remove the optional integration and settings entry; no stored data migration should be required.

**Intent check:** Did we establish separation without smuggling behavior changes into the runtime?
