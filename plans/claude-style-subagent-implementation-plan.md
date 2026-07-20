# Plan: Claude-Style Subagent Backend and TUI

- **Date:** 2026-07-21
- **Status:** Draft
- **Scope:** Managed-agent contracts, model routing, automatic exploration, actionable tool errors, runtime events, persistence, SDK/headless output, and the Ink TUI
- **Goal:** Make Book delegate broad exploration automatically, keep child work out of the parent context, let users configure models by agent profile, and show live purpose-named subagents in a Claude Code-style interface.

---

## Outcome

After this plan is implemented, Book should be able to handle a request like:

```text
Find where authentication state is created, refreshed, and invalidated.
```

without requiring the user to request a subagent explicitly. The expected flow is:

```text
parent detects broad exploration
  -> AgentSpawn(explorer, "Trace authentication flow")
  -> explorer searches in an isolated context
  -> TUI shows its status, model, and current activity
  -> explorer returns compact referenced findings
  -> parent continues with only the useful summary in context
```

Users can configure defaults such as:

```text
explorer  -> fast/cheap model
patcher   -> inherited or implementation model
validator -> independent review model
```

Each run has a purpose-specific display name, while its reusable profile remains visible separately:

```text
Trace authentication flow
Explore | provider/fast-model | Searching src/auth
```

## Product Invariants

1. **Profile and run identity stay separate.** `explorer` is a reusable capability profile; `Trace authentication flow` is the purpose of one run.
2. **Parent context stays compact.** Parent-facing agent tools never serialize full child transcripts.
3. **Tool restrictions remain hard boundaries.** UI configuration cannot silently broaden an agent's capabilities.
4. **Exploration remains proportional.** Small targeted searches stay inline; broad research is delegated.
5. **Automatic routing is advisory first.** Runtime reminders steer the model but do not hard-block normal `Read`, `Glob`, or `Grep` calls.
6. **Resolved behavior is visible.** The UI shows the actual model, isolation mode, status, and current activity used by a run.
7. **Read-only exploration does not require Git.** Patch and validation agents retain existing snapshot and worktree safety.
8. **Permission denial includes recovery guidance.** A blocked tool result explains the reason, safe alternatives, and the exact next action.
9. **UI events do not enter model context.** Live text and tool activity are host-display data unless explicitly summarized into a parent-facing result.
10. **Headless and SDK behavior remains supported.** New event types are additive and have deterministic non-interactive behavior.

## Non-Goals

- Do not implement unrestricted recursive agent teams in this plan.
- Do not replace the adaptive-harness evaluation roadmap with a large classifier.
- Do not automatically trust or execute every agent from third-party collections.
- Do not let the profile setup UI edit permission rules or tool allowlists implicitly.
- Do not hardcode provider-specific marketing aliases as universal model tiers.
- Do not merge full background-session Agent View behavior with in-session subagents.

## Target Architecture

```text
Parent model
    |
    | AgentSpawn(profile, description, prompt, model?)
    v
AgentManager
    |
    +-- resolve profile, model, effort, isolation, and budget
    |
    +-- child agent loop
    |      |
    |      +-- transcript persistence (out of parent context)
    |      +-- activity deltas --------------------+
    |      +-- permission/question requests ------+--> TUI / SDK host
    |
    +-- compact completion projector
           |
           +------------------------------------------> Parent model
```

The backend owns authoritative agent state. The TUI subscribes to delta events and maintains display state without forcing the parent conversation to ingest those events.

## Implementation Tracking Ledger

| Phase | Purpose                                                  | Status      | Exit gate                                                     |
| ----- | -------------------------------------------------------- | ----------- | ------------------------------------------------------------- |
| 1     | Split profile identity from run identity                 | Not started | Persisted and runtime contracts are migration-safe            |
| 2     | Add profile model resolution and import normalization    | Not started | Each profile has a visible, testable effective model          |
| 3     | Keep parent-facing results compact                       | Not started | No agent lifecycle tool returns a transcript to the parent    |
| 4     | Add lightweight read-only Explore execution              | Not started | Explore works without Git and cannot mutate files             |
| 5     | Add automatic exploration steering and actionable errors | Not started | Broad exploration is proactively delegated or nudged          |
| 6     | Add granular runtime events and permission bridging      | Not started | Hosts can observe and interact with live agents safely        |
| 7     | Add the Claude-style TUI and profile setup               | Not started | Users can monitor, enter, message, stop, and configure agents |
| 8     | Add compatibility, documentation, and rollout hardening  | Not started | Full tests, docs, migration, and rollback controls pass       |

---

## Phase 1: Split Profiles From Runs

### Objective

Create stable contracts for reusable agent profiles and purpose-named runtime instances.

### Backend Contracts

Add or refine these concepts in `src/agents/types.ts`:

```ts
interface AgentProfile {
  name: string;
  role: AgentRole;
  description: string;
  allowedTools: string[];
  model?: string;
  maxTurns?: number;
  effort?: string;
  isolation: 'workspace-readonly' | 'worktree';
  color?: string;
}

interface AgentRecord {
  id: string;
  profile: string;
  displayName: string;
  profileDescription: string;
  purpose: string;

  requestedModel?: string;
  resolvedModel: string;
  provider?: string;
  effort?: string;
  isolation: 'workspace-readonly' | 'worktree';

  status: AgentStatus;
  currentActivity?: AgentActivitySummary;
  // Existing lifecycle, evidence, transcript, usage, and patch fields remain.
}
```

Keep the existing `name` and `description` fields readable during migration, but stop using them as ambiguous aliases in new code. New records should write the explicit fields.

### Spawn Contract

Extend `AgentSpawnRequest` and the model-facing `AgentSpawn` tool:

```ts
interface AgentSpawnRequest {
  agent: string;
  description?: string;
  prompt: string;
  model?: string;
  planId?: string;
  evidenceIds?: string[];
  parentSessionId?: string;
}
```

The model-facing schema should require `description` so the parent supplies a concise purpose name. SDK callers may omit it during one compatibility period; the manager derives a deterministic fallback from the prompt.

Naming rules:

- Prefer 3-6 words.
- Describe the goal, not the tool: `Trace authentication flow`, not `Run Grep`.
- Remove markdown, paths, and trailing punctuation from fallback names.
- Add a numeric suffix only when active runs would otherwise have the same display name.
- Preserve the display name across follow-ups, waiting, resume, completion, and restart.

### Persistence Migration

Bump the managed-agent store from version 1 to version 2 in `src/agents/store.ts`.

Migration defaults for older records:

```text
profile            <- old name
displayName        <- purpose derived from old prompt, otherwise old name
profileDescription <- old description
purpose            <- old prompt
resolvedModel      <- recorded model if available, otherwise "unknown"
isolation          <- "worktree"
```

Do not discard existing transcripts, evidence, patch candidates, or usage.

### Tests

- Old version 1 state loads as valid version 2 state.
- New records persist profile and display name independently.
- Fallback naming is deterministic.
- Duplicate active names receive stable suffixes.
- Resume and `AgentSend` do not rename a run.

### File Plan

```text
Modify src/agents/types.ts
Modify src/agents/store.ts
Modify src/agents/store.test.ts
Modify src/agents/manager.ts
Modify src/agents/manager.test.ts
Modify src/tools/agent-tools.ts
Modify src/tools/task-tool.ts
```

---

## Phase 2: Profile Model Resolution and Agent Imports

### Objective

Let users configure a default model for each agent profile without duplicating or rewriting full agent definition files.

### Settings Schema

Extend `agentSettingsSchema` in `src/settings.ts`:

```ts
profiles: z
  .record(
    z.object({
      model: z.string().min(1).optional(),
      effort: effortLevelSchema.optional(),
      maxTurns: z.number().int().min(1).optional(),
      color: z.string().optional(),
    }),
  )
  .default({}),
```

Example:

```json
{
  "agents": {
    "profiles": {
      "explorer": {
        "model": "gateway/fast-model"
      },
      "patcher": {
        "model": "inherit"
      },
      "validator": {
        "model": "gateway/review-model"
      }
    }
  }
}
```

Do not place tool allowlists in this settings section. Tool capabilities continue to come from the trusted profile definition.

### Central Resolver

Add `src/agents/profile-resolver.ts` with one authoritative resolution path used by:

- the system-prompt agent listing;
- `AgentManager.spawn()`;
- the TUI profile library;
- headless and SDK metadata;
- validation and diagnostics.

Model precedence:

```text
AgentSpawn.model
  -> agents.profiles.<name>.model
  -> agent definition model
  -> parent model
```

Rules:

- `inherit` means continue to the next source; it is never sent as a literal model ID.
- Store both `requestedModel` and `resolvedModel`.
- Store the resolved provider and effort when known.
- A per-invocation model remains attached to follow-ups and resumes.
- Profile settings changed during a session apply to newly spawned runs.
- Add `AgentManager.updateConfig()` or an equivalent config provider so the manager does not retain stale settings after TUI changes.

### Agent File Compatibility

Improve `src/frontmatter.ts` and `src/subagent-discovery.ts`:

- Accept YAML block arrays.
- Accept inline bracket arrays.
- Accept comma-separated Claude-style `tools` values.
- Normalize `model: inherit`.
- Scan subdirectories recursively.
- Report unknown tools instead of silently producing a zero-tool agent.
- Preserve the security distinction between missing tools and an explicit empty allowlist.
- Keep project definitions higher priority than user definitions.

### Third-Party Importer

Do not automatically execute agents found under `.claude/agents/`. Add an explicit importer that:

1. Reads one file or directory.
2. Parses Claude-style frontmatter.
3. Maps supported tools to Book canonical names.
4. Reports missing and unsupported tools.
5. Normalizes the model field.
6. Shows the resulting capabilities before installation.
7. Writes the normalized definition under `.book/agents/` or `~/.book/agents/` only after confirmation.

The importer should warn when a nominally read-only role includes `Write`, `Edit`, unrestricted `Bash`, or other mutation capabilities.

### Tests

- Invocation model overrides profile, definition, and parent.
- Profile model overrides definition and parent.
- `inherit` correctly falls through.
- A live profile setting change applies to the next spawn.
- VoltAgent-style comma-separated tools parse correctly.
- Recursive discovery honors nearest/project precedence.
- Unsupported tools produce a visible diagnostic.
- Imported reviewers with write tools produce a capability warning.

### File Plan

```text
Add    src/agents/profile-resolver.ts
Add    src/agents/profile-resolver.test.ts
Add    src/agents/importer.ts
Add    src/agents/importer.test.ts
Modify src/settings.ts
Modify src/settings.test.ts
Modify src/frontmatter.ts
Modify src/subagent-discovery.ts
Modify src/subagent.test.ts
Modify src/agents/profiles.ts
Modify src/agents/manager.ts
```

---

## Phase 3: Compact Parent-Facing Agent Results

### Objective

Make context isolation real by ensuring the parent receives summaries and evidence rather than the full managed record.

### Public Result Types

Add compact DTOs:

```ts
interface AgentSummary {
  agentId: string;
  displayName: string;
  profile: string;
  status: AgentStatus;
  resolvedModel: string;
  currentActivity?: AgentActivitySummary;
  createdAt: number;
  updatedAt: number;
}

interface AgentCompletion extends AgentSummary {
  summary?: string;
  evidenceIds: string[];
  usage?: Usage;
  error?: string;
  applicationStatus?: AgentApplicationStatus;
}
```

Add projection helpers in `src/agents/projections.ts`. Never rely on manually destructuring records independently in each tool.

### Tool Behavior

- `AgentList` returns `AgentSummary[]`.
- `AgentGet` returns `AgentSummary` or `AgentCompletion`, depending on state.
- `AgentWait` returns `AgentCompletion` when terminal and `AgentSummary` on timeout.
- `AgentSpawn` returns the queued `AgentSummary`.
- `AgentSend` and `AgentStop` return the updated `AgentSummary`.
- `Task` returns only the completion summary and evidence references.

The following fields must never appear in parent-facing tool output:

- `transcript`;
- raw `prompt`;
- pending message history;
- worktree filesystem paths unless required for a patch-application error;
- snapshot manifests;
- internal permission resolvers;
- full evidence bodies already represented by evidence IDs.

The TUI and local commands may access detailed records directly from the manager. That access is host-side and must not be routed through a model tool result.

### Transcript Persistence

Keep transcripts available for UI inspection and resume. Prefer moving transcripts into per-agent JSONL files while the state store retains summaries and references. If this is too large for the first pull request, retain the current persistence format but enforce compact projection at every model-facing boundary.

### Tests

- Every lifecycle tool result is checked for forbidden fields.
- `AgentWait` timeout returns a compact running summary.
- A completed explorer returns summary, evidence IDs, model, usage, and error only.
- TUI manager APIs can still retrieve the full transcript.
- SDK detailed access and model-facing tool output remain separate contracts.

### File Plan

```text
Add    src/agents/projections.ts
Add    src/agents/projections.test.ts
Modify src/agents/types.ts
Modify src/agents/manager.ts
Modify src/tools/agent-tools.ts
Modify src/tools/task-tool.ts
Modify src/sdk.ts
Modify src/headless.ts
```

---

## Phase 4: Lightweight Read-Only Explore

### Objective

Make exploration cheap, context-isolated, and usable outside Git repositories while preserving current patch safety.

### Isolation Modes

Resolve isolation by profile:

```text
explorer  -> workspace-readonly
patcher   -> worktree
validator -> worktree
custom    -> declared isolation, default worktree
```

For `workspace-readonly`:

- Run in the parent workspace.
- Do not create a synthetic Git snapshot.
- Do not create a worktree.
- Do not require Git initialization or commits.
- Restrict tools to read-only discovery and evidence publication.
- Do not provide `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, mutation-capable shell, or arbitrary named checks.
- Keep the child context, transcript, usage, and lifecycle separate from the parent.

Suggested built-in explorer capability set:

```text
Read
Glob
Grep
GitStatus
GitDiff
GitLog
GitBranch
EvidencePublish
EvidenceList
```

Filter unavailable Git tools in non-Git workspaces or let them return an actionable `not a Git repository` result without failing the entire agent.

### Manager Refactor

`AgentManager.spawn()` currently rejects non-Git workspaces before resolving the requested definition. Reverse that order:

1. Resolve the profile.
2. Resolve its isolation mode.
3. Require Git only for worktree isolation.
4. Create snapshots only for worktree plans.
5. Build an isolation-specific system prompt.

The existing implicit fallback plan is sufficient for a simple explorer. Stop telling the parent that every spawn requires `AgentPlan`. Preserve explicit planning for `parallel_research`, `explore_then_patch`, and `patch_validate` when the parent needs those topologies.

### Explorer Prompt

Replace the narrow built-in description with a proactive routing description:

```text
Fast read-only search agent for locating files, symbols, references, and
code paths while keeping raw exploration out of the parent context. Use
proactively when broad discovery is expected to require more than three
search queries. Specify quick, medium, or very thorough search breadth.
Do not use for implementation, code review, or design auditing.
```

The explorer system prompt should require:

- compact findings;
- exact file and line references when available;
- explicit confidence and unresolved questions;
- no edits;
- no duplicated prose or raw search dumps;
- evidence publication for important findings.

### Tests

- Explore succeeds in a non-Git temporary directory.
- No snapshot or worktree function is invoked for Explore.
- Read-only capability enforcement blocks all mutations.
- Patcher and validator still reject non-Git workspaces.
- Worktree patch validation behavior remains unchanged.
- Explore reports an unavailable Git lookup without failing unrelated file search.

### File Plan

```text
Modify src/agents/profiles.ts
Modify src/agents/manager.ts
Modify src/agents/manager.test.ts
Modify src/agents/capabilities.ts
Modify src/agents/capabilities.test.ts
Modify src/agent/context.ts
Modify src/agent/context.test.ts
```

---

## Phase 5: Automatic Exploration Steering and Actionable Errors

### Objective

Reproduce the useful layered behavior observed in Claude Code: static guidance, a runtime exploration nudge, and recovery-oriented tool errors.

### Static Routing Guidance

Replace the deprecated Task instruction in `src/agent/context.ts` with:

```text
Use AgentSpawn with the explorer profile for broad codebase exploration or
research expected to require more than three discovery queries.

Search directly when the target file or symbol is known and the work should
take three queries or fewer. Explorer work stays outside the parent context
and returns compact referenced findings. Do not repeat searches already
delegated to an explorer.
```

Manual mode continues to require explicit user delegation. Off mode removes the managed-agent tools and routing guidance.

### Runtime Discovery Budget

Add root-turn discovery tracking in the agent loop or a dedicated routing helper:

- Count successful root `Glob` and `Grep` calls.
- Do not count child-agent searches.
- Reset on each new user turn.
- After the third query, append one system reminder to the tool result if no explorer is active.
- Do not hard-block a fourth query.
- Suppress duplicate reminders during the same turn.
- Suppress the reminder when the remaining target is clearly a single exact lookup only if that can be established deterministically; otherwise keep the reminder advisory.

Reminder text:

```text
[System reminder: the parent has used three inline discovery queries this
turn. If broader exploration remains, spawn the explorer agent to keep raw
search output out of the parent context. Continue inline only for a final
targeted lookup. Do not duplicate searches delegated to the explorer.]
```

Record telemetry for:

- discovery queries before spawn;
- reminder emitted;
- explorer spawned after reminder;
- parent search calls while explorer is active;
- parent context tokens before and after completion.

This telemetry informs the adaptive-harness selector later but does not wait for the full selector implementation.

### Actionable Tool Errors

Add a centralized formatter such as `src/agent/actionable-errors.ts`:

```ts
interface ActionableToolError {
  code: string;
  action: string;
  reason: string;
  restrictionIntent?: string;
  alternatives?: string[];
  nextAction?: string;
  requiresUserApproval?: boolean;
}
```

Continue serializing a string into `ToolResult.error` for provider compatibility, but create it from the structured value.

Permission denial format:

```text
Permission to use Bash was denied by rule Bash(git push *).

Do not bypass the intent through another shell, test runner, or indirect
command. Continue with local verification if possible. If pushing is
essential, explain what must be pushed and ask the user to approve that
specific action.
```

Capability denial format:

```text
Write is unavailable to the explorer profile because this agent is read-only.
Report the required change to the parent with EvidencePublish. The parent can
delegate implementation to a patcher if the user authorized modifications.
```

### Permission Evaluation

Change `evaluatePermission()` to return detail:

```ts
interface PermissionVerdict {
  decision: 'allow' | 'ask' | 'deny';
  matchedRule?: string;
  source?: string;
}
```

Keep a compatibility wrapper if other callers still require the old union.

### Hook Alignment

For exit code 2:

- Treat the hook as blocking.
- Prefer trimmed `stderr` as the reason.
- Fall back to parsed stdout JSON, then stdout text, then a generic message.
- Return the reason to the model through the blocked tool result.
- Show the same concise reason in the detailed transcript.

### Tests

- Reminder appears after exactly three successful discovery queries.
- Reminder appears only once per turn.
- Counter resets for a new user message.
- Active Explore suppresses further reminders.
- Targeted tasks with one to three searches are unaffected.
- Permission denial identifies the matched rule.
- Capability denial names the correct parent recovery tool.
- Hook exit code 2 consumes stderr and blocks.
- Actionable errors are not retried by generic tool retry logic.

### File Plan

```text
Add    src/agent/exploration-routing.ts
Add    src/agent/exploration-routing.test.ts
Add    src/agent/actionable-errors.ts
Add    src/agent/actionable-errors.test.ts
Modify src/agent/context.ts
Modify src/agent/context.test.ts
Modify src/agent/loop.ts
Modify src/agent/loop.test.ts
Modify src/permissions.ts
Modify src/permissions.test.ts
Modify src/hooks.ts
Modify src/hooks.test.ts
Modify src/tools/registry.test.ts
```

---

## Phase 6: Granular Runtime Events and Permission Bridging

### Objective

Expose live child activity to hosts without cloning full records or adding child activity to the parent model history.

### Event Types

Extend `AgentRuntimeEvent`:

```ts
type AgentRuntimeEvent =
  | { type: 'agent_status'; agent: AgentSummary }
  | { type: 'agent_activity'; agentId: string; activity: AgentActivity }
  | { type: 'agent_text_delta'; agentId: string; text: string }
  | { type: 'agent_message'; agentId: string; message: Message }
  | { type: 'agent_permission'; agentId: string; request: AgentPermissionRequest }
  | { type: 'agent_question'; agentId: string; request: UserQuestionRequest }
  | { type: 'evidence_update'; evidence: EvidenceItem }
  | { type: 'agent_result'; completion: AgentCompletion }
  | { type: 'agent_apply' /* existing fields */ };
```

`AgentActivity` should contain display-safe information:

```ts
interface AgentActivity {
  id: string;
  kind: 'thinking' | 'tool' | 'waiting' | 'compacting';
  label: string;
  toolName?: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'completed' | 'failed';
}
```

Do not emit raw secrets or unrestricted tool arguments. Reuse shared redaction and presentation helpers.

### Manager Subscriptions

Replace the single mutable `eventSink` with subscription semantics:

```ts
const unsubscribe = manager.subscribe(listener);
```

Requirements:

- Multiple hosts can subscribe.
- A tool invocation cannot overwrite the TUI subscriber with a no-op callback.
- Subscribers receive a current-state snapshot when attaching if requested.
- Disposal removes listeners without stopping active agents.
- Events are cloned or frozen at the smallest useful payload, not as a full `AgentRecord` on every token.

### Child Loop Wiring

Wire currently ignored callbacks in `AgentManager.run()`:

- `onText`: emit coalesced text deltas for the detail view.
- `onToolCall`: set and emit current activity.
- `onToolResult`: complete or fail the activity.
- `onTurnStart`: emit thinking state.
- `onUsage`: emit compact usage updates.
- `onAssistantMessageComplete`: persist and emit a complete transcript message.
- `onCompact`: emit compacting state.

Persist complete messages and turn boundaries, not every text token. Coalesce display deltas at approximately the existing TUI accumulator cadence.

### Permission Bridge

Replace child `onPermissionRequired: async () => 'deny'` with a managed request:

1. Child requests permission for an otherwise available tool.
2. Manager stores a pending request and changes the agent status to `waiting_input` or a distinct `waiting_permission` status.
3. Manager emits `agent_permission` with the agent ID and display name.
4. Interactive host shows the standard permission UI with source attribution.
5. Host resolves only that request.
6. Agent resumes or receives an actionable denial.

Hard profile capabilities are evaluated before permission requests and cannot be approved through this bridge.

Headless behavior:

- If a host callback is available, expose the request through stream JSON.
- Otherwise deny deterministically with recovery guidance.
- Never leave an unresolved promise in print mode.

### SDK and Stream JSON

Add new events without immediately removing `agent_start`, `agent_update`, or the old full-record event shapes. Mark legacy events deprecated and remove them only in a separately versioned change.

Provide an SDK option for forwarding text deltas because they can be high volume:

```ts
forwardSubagentText?: boolean;
```

Status, activity, question, permission, completion, and evidence events remain available by default.

### Tests

- Multiple subscribers receive events.
- Unsubscribing one listener leaves others active.
- Text deltas are coalesced and ordered.
- Tool activity transitions running -> completed or failed.
- Full records are not cloned for text events.
- Complete messages persist for resume.
- Permission requests name the correct agent.
- Approval resumes only the requesting child call.
- Non-interactive denial cannot deadlock.
- Stream JSON and SDK parse all new event types.

### File Plan

```text
Add    src/agents/activity.ts
Add    src/agents/activity.test.ts
Modify src/agents/types.ts
Modify src/agents/manager.ts
Modify src/agents/manager.test.ts
Modify src/agent/loop.ts
Modify src/types.ts
Modify src/headless.ts
Modify src/headless.test.ts
Modify src/stream-json.ts
Modify src/sdk.ts
Modify src/sdk.test.ts
```

---

## Phase 7: Claude-Style Subagent TUI

### Objective

Give users a compact live overview, purpose-named rows, navigable child transcripts, and profile model setup without crowding the main conversation.

### TUI State Hook

Add `src/tui/hooks/useManagedAgents.ts`.

Responsibilities:

- Subscribe once to `AgentManager`.
- Maintain summaries keyed by agent ID.
- Maintain bounded live transcript buffers for active detail views.
- Track selected agent, focused surface, and Running/Profiles tab.
- Expose actions for send, stop, dismiss, permission resolution, question resolution, and profile updates.
- Restore persisted completed agents when the TUI starts.
- Avoid inserting UI-only child events into `messages` or provider context.

Replace `onAgentEvent: () => {}` in `useAgent` with the real subscription or pass the manager into the new hook at the application boundary.

### Compact Panel

Add:

```text
src/tui/components/SubagentPanel.tsx
src/tui/components/SubagentRow.tsx
```

Place the compact panel below `InputBar` and above `StatusLine` so it matches the Claude Code relationship between prompt, agents, and footer.

Example wide layout:

```text
  * Trace authentication flow
    Explore | gateway/fast-model | Searching src/auth | 18s
  o Validate session fix
    Validator | gateway/review-model | waiting for input
 Manual | main-model | ctx 28% | agents 2
```

Use theme tokens and the existing `subagentColors` palette. Do not hardcode raw colors inside components.

Row priority:

1. Display name.
2. Status/needs-input state.
3. Current activity.
4. Profile.
5. Resolved model.
6. Elapsed time.
7. Token usage.

Responsive rules:

- Hide token usage first.
- Hide elapsed time second.
- Shorten model third.
- Preserve display name, status, and activity for as long as possible.
- Tiny mode shows one selected/important row plus `+N agents`.
- Screen-reader mode renders flat descriptive sentences.
- Reduced-motion mode uses static status glyphs.

### Agent Center

Change `/agents` from a local text dump into a focused Agent Center with two tabs:

```text
Running | Profiles
```

Running tab interactions:

```text
Up/Down  select row
Enter    open transcript
x        stop running agent or dismiss completed agent
Esc      return to main conversation
Tab      switch to Profiles
```

Completed agents remain listed until dismissed or retention cleanup removes them. Failed and stopped agents remain available for diagnosis.

### Detail Transcript

Add `src/tui/components/SubagentDetail.tsx`.

When open:

- Replace the main `ChatPanel` content within the existing `TranscriptView`.
- Show breadcrumb `main > Trace authentication flow`.
- Render the child transcript with the existing message and tool components.
- Show purpose, profile, resolved model, usage, status, worktree mode, and evidence references.
- Route normal input to `AgentSend`.
- `Esc` returns to the main conversation without stopping the agent.
- `x` stops the running agent after a concise confirmation if the action could discard work.
- Built-in session commands continue to act on the main session and show a notice when invoked from a child detail view.

Do not attach background managed-agent tool rows to the currently streaming parent assistant message. The existing nested `Task` rendering remains only for the deprecated synchronous adapter until it is removed.

### Questions and Permissions

Reuse the existing permission and `AskUserQuestion` components with an agent source header:

```text
? Trace authentication flow (Explore)
  requests Bash: git log -- src/auth
```

Modal ownership must continue to suppress `InputBar` keyboard handling so Enter, Tab, and Escape cannot double-fire.

When several agents need input:

- show the oldest pending request first;
- show the queue count;
- return focus to the Agent Center after resolving if another agent still needs input.

### Profile Setup UI

Add:

```text
src/tui/components/AgentProfilePanel.tsx
src/tui/components/AgentModelPicker.tsx
```

Profiles tab example:

```text
Explorer    gateway/fast-model    read-only
Patcher     inherit               worktree
Validator   gateway/review-model  worktree
```

Selecting a profile opens a model picker:

- `inherit` is always the first option.
- Remaining choices come from the same resolved provider model catalog as `/model`.
- Show provider and model label.
- Save only `agents.profiles.<name>.model`.
- Update live configuration and the manager after a successful save.
- Show the new default; do not change already-running agents.

Refactor the current `ModelPicker` into reusable list and provider-management layers. Agent model selection should not expose provider deletion, BYOK creation, or main-session effort controls unless explicitly opened through the normal `/model` workflow.

### Status Line

Extend `StatusLine` with:

```text
agents <active>/<total>
```

Prioritize `needs input` over raw active count when space allows:

```text
agents 2 | 1 needs input
```

The status line is a shortcut indicator only; the full panel remains authoritative.

### TUI Tests

- Agent status events create and update rows.
- Purpose name, profile, resolved model, activity, and elapsed time render correctly.
- Tiny and narrow layouts do not wrap unpredictably.
- Screen-reader output contains all important state without decorative rails.
- Enter opens the selected transcript.
- Esc returns to main.
- Follow-up input calls `AgentSend` for the selected child.
- `x` stops active agents and dismisses completed agents.
- Needs-input requests are attributed to the correct agent.
- Multiple pending requests queue deterministically.
- Profiles tab persists a model override.
- Running agents keep their original model after the profile default changes.
- New agents use the updated model without restart.
- Completed agents remain until dismissal.
- Main conversation messages remain unchanged by UI-only child events.

### File Plan

```text
Add    src/tui/hooks/useManagedAgents.ts
Add    src/tui/hooks/useManagedAgents.test.tsx
Add    src/tui/components/SubagentPanel.tsx
Add    src/tui/components/SubagentPanel.test.tsx
Add    src/tui/components/SubagentRow.tsx
Add    src/tui/components/SubagentDetail.tsx
Add    src/tui/components/SubagentDetail.test.tsx
Add    src/tui/components/AgentProfilePanel.tsx
Add    src/tui/components/AgentProfilePanel.test.tsx
Add    src/tui/components/AgentModelPicker.tsx
Add    src/tui/components/AgentModelPicker.test.tsx
Modify src/tui/components/ModelPicker.tsx
Modify src/tui/app.tsx
Modify src/tui/hooks/useAgent.ts
Modify src/tui/components/StatusLine.tsx
Modify src/tui/components/StatusLine.test.tsx
Modify src/tui/components/WorkingIndicator.tsx
Modify src/tui/theme.ts
```

---

## Phase 8: Compatibility, Documentation, and Rollout

### Deprecated Task Migration

Keep `Task` for one compatibility release:

- Internally use `AgentSpawn` plus `AgentWait`.
- Derive a purpose-specific display name when its old schema omits one.
- Return a compact completion.
- Continue rendering its nested activity in the parent transcript.
- Update its description to point models toward the managed lifecycle tools.

After telemetry shows no meaningful use, remove `Task` in a separate breaking change.

### Commands and Diagnostics

Update commands:

```text
/agents                 open Agent Center
/agent <id>             open agent detail
/agent send <id> ...    send follow-up
/agent stop <id>        stop agent
/agent apply <id> ...   apply validated patch
/agents import <path>   import and normalize definitions
```

Add `book doctor` checks for:

- invalid agent models;
- `inherit` incorrectly stored as a literal by older configuration;
- unknown tools;
- duplicate profile names;
- mutation tools on profiles declared read-only;
- malformed or unimported Claude-style definitions;
- profile overrides for missing agents.

### Documentation

Update:

- `README.md` managed-agent section;
- `CHANGELOG.md`;
- `MILESTONES.md` if the work changes a tracked milestone;
- SDK event documentation;
- settings reference;
- agent definition examples;
- screenshots or terminal captures for the new TUI.

Document clearly:

- automatic Explore threshold and its advisory nature;
- profile model precedence;
- the difference between profile and run name;
- read-only workspace isolation versus worktree isolation;
- context isolation guarantees;
- permission behavior for background agents;
- safe third-party imports.

### Rollout Controls

Add temporary settings or feature flags if needed:

```text
agents.ui.enabled
agents.routing.inlineSearchBudget
agents.routing.exploreReminder
agents.forwardTextEvents
```

Defaults after verification:

```text
agents.ui.enabled = true
agents.routing.inlineSearchBudget = 3
agents.routing.exploreReminder = true
agents.forwardTextEvents = false for SDK, true for interactive TUI
```

Rollback must be possible without deleting persisted agents:

- disable the panel while retaining `/agent` commands;
- disable routing reminders while retaining manual spawning;
- fall back Explore to worktree execution if read-only isolation has a safety regression;
- ignore new profile overrides and inherit the parent model;
- continue reading version 2 state even if new UI features are disabled.

### End-to-End Verification Scenarios

#### Scenario A: Targeted lookup

```text
User: Where is SessionStore defined?
Expected: parent performs one or two direct searches; no explorer is spawned.
```

#### Scenario B: Broad exploration

```text
User: Trace session creation, persistence, compaction, resume, and rewind.
Expected: parent proactively spawns an explorer with a purpose name.
```

#### Scenario C: Model routing

```text
Explorer default: gateway/fast-model
Validator default: gateway/review-model
Expected: rows and completion metadata show the resolved models.
```

#### Scenario D: Permission request

```text
Background child reaches an allowed tool that still requires approval.
Expected: main TUI names the requesting child and resolves only that call.
```

#### Scenario E: Context isolation

```text
Explorer performs many searches and reads.
Expected: parent receives compact findings and evidence IDs, not the transcript.
```

#### Scenario F: Non-Git exploration

```text
Run Book in an uncommitted non-Git directory.
Expected: Explore works; patcher and validator explain that Git/worktree isolation is required.
```

#### Scenario G: Third-party import

```text
Import a VoltAgent definition with comma-separated tools and model: inherit.
Expected: tools normalize correctly, inherit remains inheritance, and risky capabilities are shown before installation.
```

## Full Verification Matrix

### Type and Static Checks

```powershell
npm run typecheck
npm run lint
npm run format:check
```

### Focused Tests

```powershell
npm test -- src/agents/profile-resolver.test.ts
npm test -- src/agents/importer.test.ts
npm test -- src/agents/projections.test.ts
npm test -- src/agents/manager.test.ts
npm test -- src/agent/exploration-routing.test.ts
npm test -- src/agent/actionable-errors.test.ts
npm test -- src/agent/loop.test.ts
npm test -- src/permissions.test.ts
npm test -- src/hooks.test.ts
npm test -- src/tui/hooks/useManagedAgents.test.tsx
npm test -- src/tui/components/SubagentPanel.test.tsx
npm test -- src/tui/components/SubagentDetail.test.tsx
npm test -- src/tui/components/AgentProfilePanel.test.tsx
```

### Full Suite

```powershell
npm test
npm run build
```

### Manual TUI Verification

- Desktop-width terminal.
- Narrow terminal.
- Tiny terminal.
- Reduced-motion setting.
- Screen-reader mode.
- Several concurrent agents.
- Completed and failed agents.
- Permission and question queues.
- Agent detail while the main conversation continues.
- Model change followed by a new spawn.
- Session restart with persisted agents.

## Acceptance Criteria

The plan is complete only when all of these are true:

1. Broad exploration normally delegates without the user explicitly requesting a subagent.
2. Targeted work with three or fewer discovery queries remains lightweight and inline.
3. Every run has a purpose-specific display name separate from its profile.
4. Users can configure a default model for each profile from the TUI.
5. The TUI shows the actual resolved model used by every run.
6. Live status and tool activity are visible without opening the full transcript.
7. Users can enter a child transcript, send follow-ups, return to main, and stop the child.
8. Completed agents remain inspectable until dismissed or cleaned up.
9. Parent-facing lifecycle tool results never contain full child transcripts.
10. Explore works without Git and cannot mutate files.
11. Patcher and validator retain existing worktree and evidence safeguards.
12. Background permission prompts identify the requesting agent.
13. Every restriction error gives the model a safe recovery path.
14. Claude/VoltAgent-style definitions can be imported without silent zero-tool or literal-`inherit` failures.
15. Print mode, stream JSON, SDK mode, reduced-motion mode, and screen-reader mode remain functional.

## Recommended Pull Request Order

1. **Contracts and migration:** profile/run identity, purpose names, store version 2.
2. **Profile resolution:** models, settings, parser compatibility, importer foundation.
3. **Context boundary:** compact projections for every agent lifecycle tool.
4. **Explore execution:** read-only non-Git path and updated prompts.
5. **Steering and errors:** three-query reminder, detailed permission and hook errors.
6. **Runtime events:** subscriptions, activity deltas, transcript checkpoints, permission bridge.
7. **TUI monitoring:** compact panel, status line, Agent Center, detail transcript.
8. **TUI setup and rollout:** profile model picker, import UI, docs, screenshots, compatibility cleanup.

Each pull request should be independently testable and should not depend on later UI work to enforce backend safety.

## Relationship to the Adaptive Harness Plan

This plan provides runtime primitives and a narrow, explainable Explore heuristic. It does not replace `plans/adaptive-harness-implementation-plan.md` or its deterministic selector phase.

The adaptive harness may later use the telemetry and profile-resolution contracts introduced here to decide among broader workflows. Until that evidence exists, this plan keeps the automatic policy intentionally small:

```text
known targeted lookup and <= 3 searches -> stay inline
broad read-only discovery or > 3 expected searches -> use Explore
mutation or validation -> retain explicit managed workflow safeguards
```

That rule must remain inspectable, configurable, and reversible.
