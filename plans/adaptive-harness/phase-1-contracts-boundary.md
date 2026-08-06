# Phase 1: Add Contracts and a Disabled Harness Boundary

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Verified (2026-08-06)
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
  observe(runId: string, event: HarnessEvent): HarnessObserverEnqueueResult;
  finalizeRun(
    runId: string,
    result: FinalizeRunInput,
  ): Promise<HarnessObserverFlushResult>;
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

The Phase 1 matrix is published in
[Phase 1 Capability and Authority Matrix](phase-1-capability-matrix.md). The first release is
settings/CLI-only; dedicated SDK and headless harness options remain deferred until an enabled mode
exists.

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

#### Verification Record (2026-08-06)

- Code boundary: Phase 1 change based on `c953b04`; `src/harness/contracts.ts` contains shared
  descriptive types, while `src/harness/coordinator.ts` exposes only the disabled facade.
- Availability: `off` is the only enabled mode. `observe`, `shadow`, `active`, and `learn` pass enum
  parsing but fail the availability gate during settings resolution and before migrations, settings
  locks, storage creation, legacy-config inspection, or runtime setup.
- Off-path behavior: omitted harness settings and explicit `off` produce identical provider
  messages and tool definitions. The disabled coordinator returns no run context or run ID and
  creates no files or directories.
- Context ownership: `HarnessRunContext` is readonly, host-frozen, optional, and request-scoped. It
  is separate from the always-on `AgentRunContext`, is not stored on `AgentConfig`, and does not
  survive into a later request when omitted.
- Capability boundary: the versioned manifest, workspace-trust, external-integration,
  compatibility, observer lifecycle, requested/effective, workflow-reference, and trusted-kernel
  contracts are defined without importing provider, TUI, tool, evaluator, or learner
  implementations.
- Contract hardening: managed-agent runtime imports obey the same contracts-only boundary as the
  root agent; observer enqueue/flush outcomes are returned to callers; synchronous overflow policy
  cannot claim to block producers; and event strings require bounded, non-secret ingress values.
- Public surface: settings/CLI configuration only for Phase 1. No dedicated SDK/headless harness
  option is exposed while every non-off mode is unavailable.
- Verification: format, lint, type, and architecture gates passed; 177 of 178 unit files passed in
  the final loaded-run sweep (1,800 passing tests, 5 skipped), and its single unrelated startup-fire
  timing assertion passed immediately in isolation. All 4 contract files passed (31 tests), focused
  Phase 1 unit tests passed (58 tests), the CLI settings integration passed (4 tests), and
  `npm run build` passed. The earlier clean integration baseline remains 82 passing and 7 skipped;
  repeated final broad integration attempts were not reusable evidence because Windows PTY and
  background-shell cleanup became contaminated by orphaned test processes.
- Trust scope: Tier C remains blocked. Phase 1 starts no project hook, provider integration, MCP
  process, web request, skill execution, or subagent on behalf of the harness.

#### Anti-Drift Review

- Measurement/selection value: the phase establishes inspectable boundaries required for later
  evidence and selection; it claims no outcome improvement.
- Minimal path: the default and only available mode is `off`, with no hidden adaptive behavior.
- Current intent and scope: no historical signal or selector exists, so current user intent and
  existing runtime behavior remain authoritative.
- Reversibility: removing the optional context, settings entry, contracts, and coordinator requires
  no stored-data migration.
- External evidence: verification uses provider-request capture, filesystem checks, architecture
  checks, and repository tests rather than model self-assessment.
- Kernel integrity: permissions, sandboxing, secrets, budgets, tool contracts, evaluator rules,
  runtime correctness, and promotion authority are excluded from workflow control.
- Compatibility and trust: no fingerprint or integration is collected in `off`; all future states
  remain descriptive and requested/effective values are distinct.
- Simplicity: no model-specific profile, learner, workflow registry, evidence ledger, or adaptive
  policy was introduced.

**Exit gate:** The harness can be compiled in but is inert and removable.

**Rollback:** Remove the optional integration and settings entry; no stored data migration should be required.

**Intent check:** Did we establish separation without smuggling behavior changes into the runtime?
