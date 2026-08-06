# Phase 1 Capability and Authority Matrix

- **Applies to:** [Phase 1: Contracts and Disabled Boundary](phase-1-contracts-boundary.md)
- **Runtime availability:** `harness.mode = off` only
- **Public surface decision:** settings/CLI configuration only; no dedicated SDK or headless harness
  option is exposed until an enabled mode exists

This matrix records which existing Book component owns each proposed harness control. It does not
enable observation, selection, or learning. Requested and effective values must remain separate;
lower-authority configuration may narrow a capability but cannot broaden the trusted kernel.

## Workflow-Selectable Surface

| Proposed field                   | Classification         | Current enforcement point                        | Phase 1 disposition                                                       |
| -------------------------------- | ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| Workflow identity/version        | host-enforced          | future harness coordinator                       | Descriptive contract only                                                 |
| Prompt-layer IDs                 | bounded model guidance | `src/agent/context.ts` host rendering            | Registered IDs only; no free-form workflow prompt                         |
| Skill policy ID                  | host-enforced          | `src/skills.ts`, `src/skill-registry.ts`         | Reference only; existing skill consent remains authoritative              |
| Tool-exposure policy ID          | host-enforced          | `src/tools/registry.ts`, tool discovery          | Reference only; workflows cannot define tools                             |
| Context policy ID                | host-enforced          | agent context and compaction modules             | Reference only; no selectable input ceiling yet                           |
| Model capability adapter ID      | host-enforced          | provider/model resolution                        | Reference only; cannot select credentials or origins                      |
| Verification policy ID           | trusted-verifier       | evaluator-owned verifier registry                | Reference only; command verifiers remain blocked without a trusted runner |
| Hook policy ID                   | deterministic-hook     | `src/hooks.ts` plus permission/sandbox checks    | Reference only; project hooks remain Tier C blocked                       |
| Delegation policy ID             | host-enforced          | managed-agent manager and fixed child registries | Reference only; initial harness evaluation keeps agents off               |
| Retry policy                     | unsupported-clamped    | provider/runtime retry implementation            | Not workflow-selectable                                                   |
| Cancellation semantics           | kernel-enforced        | agent/session/provider runtime                   | Not workflow-selectable                                                   |
| Checkpoint/resume behavior       | kernel-enforced        | session and rewind runtime                       | Not workflow-selectable                                                   |
| Tool schemas and errors          | kernel-enforced        | canonical tool registry                          | Fingerprinted later; never workflow-defined                               |
| Permission or sandbox ceiling    | kernel-enforced        | permission and sandbox modules                   | A workflow may never broaden it                                           |
| Secrets and provider credentials | kernel-enforced        | config and provider resolution                   | Never present in harness contracts                                        |
| Absolute token/cost/time budgets | kernel-enforced        | runtime accounting and host limits               | A workflow may request less only in a later phase                         |
| Edit-scope limit                 | unsupported-clamped    | no complete enforcement point                    | Do not expose as an enforceable workflow field                            |
| Handoff policy                   | unsupported-clamped    | no general root handoff contract                 | Do not expose until a host-enforced contract exists                       |
| Workflow-specific parallelism    | unsupported-clamped    | fixed runtime/tool scheduler behavior            | Excluded from the initial workflow surface                                |

## Agent Capability Manifest

| Capability family                    | Authority class        | Canonical owner                      | Required compatibility evidence                                               |
| ------------------------------------ | ---------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Base system prompt and prompt layers | bounded-model-guidance | agent context builder                | layer IDs, versions, digests, provider flattening mode                        |
| Skill discovery and activation       | host-enforced          | skill discovery/registry             | package identity, activation policy, allowed-tools restriction, consent state |
| Tool contracts                       | kernel-enforced        | tool registry                        | canonical name, schema hash, permission class, cancellation and retry safety  |
| Deferred tool discovery              | host-enforced          | tool catalog/search                  | discovery policy and schema-budget version                                    |
| Context retrieval and compaction     | host-enforced          | context, session, compaction runtime | policy version, checkpoint version, contribution digests                      |
| Model/provider capability adapter    | host-enforced          | config/provider modules              | requested and resolved model identity, adapter version, unverifiable state    |
| Verification                         | trusted-verifier       | evaluator/verifier boundary          | verifier ID/version, evidence references, unavailable or blocked state        |
| Hooks                                | deterministic-hook     | hook runtime                         | hook policy digest, trust decision, permission/sandbox result                 |
| Managed delegation                   | host-enforced          | agent manager                        | role/profile, child tool allowlist, parent/root linkage, handoff evidence     |
| Legacy subagents                     | kernel-enforced        | fixed subagent runtime               | fixed permission posture and restricted registry fingerprint                  |
| Permissions and sandbox              | kernel-enforced        | trusted kernel                       | requested/effective mode, ceiling, sandbox availability                       |
| Workspace trust                      | kernel-enforced        | future user-owned trust decision     | trusted/untrusted/unknown state and decision fingerprint                      |
| Provider integration                 | kernel-enforced        | config/provider boundary             | approved origin, credential posture, initialization state                     |
| MCP integration                      | kernel-enforced        | MCP host boundary                    | trust, command/origin, schema, timeout, and initialization state              |
| Web integration                      | kernel-enforced        | web policy and tool runtime          | network posture, private-address policy, bounded-response policy              |
| TUI/headless/CI/SDK lifecycle        | host-enforced          | each host entry point                | host surface ID and lifecycle parity evidence                                 |

## Requested Versus Effective Resolution

Every security- or capability-relevant request uses the following states from
`src/harness/contracts.ts`:

```text
disabled | available | approved | denied | clamped | unsupported | initialization-failed
```

The requested reference records intent. The effective reference records what the host and trusted
kernel actually permit. An absent effective reference is not approval; it means the capability is
disabled, denied, unsupported, or unavailable with a reason code.

## Trusted Kernel Exclusions

Workflow contracts cannot contain or replace permission rules, sandbox configuration, secrets,
absolute budgets, evaluator definitions, held-out membership, audit retention, promotion authority,
model/provider comparison identity, tool implementations, provenance rules, retry/cancellation
correctness, checkpoint/compaction behavior, or trace-integrity rules.

## Phase 1 Off-Path Rule

When `harness.mode` is `off`, no harness run context, run ID, coordinator state, observer queue,
fingerprint collection, storage directory, integration startup, credential resolution, or provider
request is created on behalf of the harness. Valid future modes fail the availability gate before
runtime setup. Existing `AgentRunContext` attribution remains independent and unchanged.
