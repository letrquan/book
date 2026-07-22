# Phase 3: Add a Small Validated Workflow Registry

- **Parent plan:** [Adaptive Harness Implementation Plan](../adaptive-harness-implementation-plan.md)
- **Status:** Not started
- **Depends on:** Phase 2 verified
- **Tracking rule:** Update this status and the parent plan ledger in the same change.

> The parent plan's original intent, non-negotiable invariants, architecture boundaries, stop conditions, and anti-drift review apply to every task in this phase.

---


**Objective:** Make workflow variation explicit, bounded, inspectable, and manually selectable.

**Deliverables:**

- Define a small workflow schema with knobs such as planning, bounded context/resume strategy, verification, edit scope, and autonomy.
- Add no more than three initial workflows: `minimal`, `safe-edit`, and `verify-heavy`.
- Validate workflow files with Zod and reject unknown or unsafe fields.
- Add an explicit CLI/settings override for manual workflow selection.
- Render the active workflow in the dynamic system-prompt zone.
- Enforce supported controls outside the prompt where possible.
- Record the exact workflow ID/version/reason with every run.

#### Phase 3 Work Breakdown

##### 3.1 Define the workflow schema

Keep workflow definitions compact and declarative:

```ts
interface WorkflowDefinition {
  schemaVersion: 1;
  id: string;
  version: number;
  description: string;
  planning: 'direct' | 'light' | 'structured';
  context: {
    strategy: 'minimal' | 'relevant' | 'deep';
    maxInputTokens?: number;
    compactionPolicy: 'existing' | 'checkpoint' | 'handoff';
    preserveFailures: boolean;
    preserveDecisions: boolean;
    includeProjectMemory: boolean;
    includeRecentFailures: boolean;
  };
  verification: {
    level: 'none' | 'targeted' | 'full';
    requireEvidenceBeforeSuccess: boolean;
  };
  execution: {
    editScope: 'small' | 'normal' | 'broad';
    retryPosture: 'default' | 'cautious';
  };
  requestedApprovalPosture: 'default' | 'ask-more';
}
```

`requestedApprovalPosture` is advisory and monotone toward more confirmation. The initial workflow
surface does not contain `ask-less`; it cannot select `auto`, `dontAsk`, `bypassPermissions`, override
deny rules, or exceed the user's configured mode.

Context token limits are requests clamped by the trusted runtime. Compaction, checkpoint, and handoff values are valid only when the fixed runtime advertises the corresponding tested capability.

Do not add model names, user identities, project paths, task prompts, arbitrary code, free-form system prompts, tool definitions, retry implementations, or security rules to workflow definitions.

Use recursively strict validation and canonical JSON serialization before hashing. Project-local
workflow files are untrusted repository data even after schema validation: never render their
free-form description as instructions, reject symlink/path escapes, and fail closed when an explicit
workflow is malformed.

##### 3.2 Define the three initial workflows

`minimal`:

- preserve current Book behavior as closely as possible;
- direct planning unless the user requests a plan;
- relevant context only from existing mechanisms, with no new compaction or handoff behavior;
- no additional verification instruction beyond current guardrails;
- no automatic parallelism.

`safe-edit`:

- light or structured planning for mutating tasks;
- smaller edit scope;
- targeted verification after meaningful changes;
- more cautious handling of dependency, migration, and broad file changes.

`verify-heavy`:

- require explicit evidence before claiming completion;
- run declared project verifiers when authorized;
- inspect final diff and regression signals;
- accept higher cost only within the fixed kernel budget.

These workflows are comparison instruments first. Avoid optimizing them during Phase 3.

Only fields classified as kernel-enforced or explicitly bounded guidance by the Phase 1 capability
matrix may vary. Unsupported fields are rejected or visibly clamped. Initial workflows do not select
multi-agent parallelism; the existing managed-agent system is a separate experimental axis.

##### 3.3 Implement registry loading and precedence

Start with built-in workflow definitions in source. If project-defined workflows are supported in Phase 3, use an explicit validated directory such as:

```text
.book/harness/workflows/*.json
```

Recommended precedence:

```text
explicit CLI/session override
project-local validated workflow with exact ID/version
built-in promoted workflow
minimal fallback
```

Do not load candidates from the active workflow path.

##### 3.4 Separate requested and effective decisions

Create a resolved representation:

```ts
interface ResolvedWorkflow {
  requested: WorkflowDefinition;
  effective: WorkflowEffectiveSettings;
  clamps: Array<{
    field: string;
    requested: unknown;
    effective: unknown;
    reason: string;
  }>;
}
```

This makes kernel restrictions visible instead of silently ignoring workflow requests.

##### 3.5 Render a bounded execution-policy section

Add the active workflow to `src/agent/context.ts` through a dedicated dynamic policy zone so switching workflows does not invalidate the session-stable prompt prefix unnecessarily. Do not reuse generic `systemPromptAppend`, which currently belongs to the cached prefix and can contain unrelated agent text.

The rendered section should:

- state the workflow ID/version;
- express only supported behavioral guidance;
- distinguish guidance from enforced rules;
- avoid repeating existing system instructions;
- stay under a fixed character/token budget;
- omit itself for `minimal` if equivalence requires no new prompt text.

##### 3.6 Add explicit selection controls

Support at least one non-TUI control first, such as settings or a CLI flag. Later add an interactive command:

```text
/harness status
/harness workflow minimal
/harness workflow safe-edit
/harness reset
```

Manual selection should be scoped to the current run/session unless the user explicitly persists it to project settings.

Define whether a session override survives process resume. If persistence is required, add a
versioned session record; otherwise call it process/run-scoped. Include CLI parser/help/contract tests
and public SDK fields if SDK selection is in scope.

##### 3.7 Record workflow provenance

Every run should record:

- requested and effective workflow;
- source and selection reason;
- registry version/hash;
- any kernel clamps;
- manual override scope;
- prompt-policy rendering version.
- effective context budget/capability version and any context-policy clamps;
- declared workflow complexity measures such as rendered tokens, active fields, transitions, and requested extra calls.

#### Phase 3 File Plan

```text
Add    src/harness/workflows.ts
Add    src/harness/workflows.test.ts
Add    src/harness/registry.ts
Add    src/harness/registry.test.ts
Modify src/harness/contracts.ts
Modify src/agent/context.ts
Modify src/agent/context.test.ts
Modify src/settings.ts
Modify src/cli/run.ts or src/index.ts
Modify src/cli/options.ts or the actual CLI parser/help module
Modify src/commands/builtins.ts and src/tui/app.tsx only if /harness ships in this phase
```

#### Phase 3 Test Matrix

- Unknown fields and arbitrary prompt/code fields are rejected.
- Duplicate IDs or non-monotonic versions are rejected.
- Missing registry falls back to built-in `minimal`.
- Manual run/session/project precedence is deterministic.
- Kernel clamps are recorded and explained.
- `minimal` provider messages match the accepted baseline.
- Workflow prompt section stays within its budget.
- Workflow definitions cannot enable unavailable tools or bypass permissions.
- Unsupported context, compaction, checkpoint, or handoff capabilities are rejected or clamped explicitly.
- Workflow definitions cannot change tool schemas, retry/cancellation correctness, provenance, or prompt-injection defenses.
- Candidate files placed beside the candidate store never become active.
- Recursive unknown fields, symlink escapes, and candidate-path workflows are rejected.
- Every selected field has a recorded requested/effective capability mapping; prompt-only guidance is not reported as enforcement.

**Verification:**

- Invalid workflows cannot start a run.
- `minimal` stays close to the pre-harness baseline and adds no unnecessary planning language.
- Manual overrides always beat automatic/default selection.
- Workflow selection cannot weaken permissions, sandboxing, budgets, or evaluator rules.
- Each workflow produces reproducible configuration for the same input.
- Fixed runtime responsibilities remain outside the workflow schema, and workflow complexity is inspectable.

**Commands:**

```powershell
npm run typecheck
npm run test:unit -- src/harness/workflows.test.ts
npm run test:unit -- src/agent/context.test.ts
npm run test:unit -- src/config.test.ts
npm run test:unit -- src/permissions.test.ts
npm test
```

**Exit gate:** Fixed workflows can be compared fairly without any automatic learning.

**Rollback:** Force `minimal` globally and retain other workflow definitions as inactive test fixtures.

**Intent check:** Are workflows compact execution policies, or are they becoming large model-specific profiles?
