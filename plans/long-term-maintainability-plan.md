# Plan: Long-Term Maintainability Hardening

- **Date:** 2026-07-21
- **Status:** Proposed
- **Scope:** Settings safety, SDK and MCP contracts, test trust, command dispatch, agent-session orchestration, dependency boundaries, provider infrastructure, performance, and release hygiene
- **Goal:** Keep Book easy to change over multiple years by making critical behavior explicit, testable, replaceable, and owned by small modules instead of a few high-churn coordinators.

---

## Outcome

Book should remain fast to extend as commands, providers, session features, tools, and TUI behavior grow. A contributor should be able to change one product surface without understanding or modifying every host.

The target development experience is:

- invalid settings cannot be saved or silently erased;
- the SDK streams typed events and honors its documented session contract;
- an unresponsive MCP server cannot hang startup or shutdown;
- adding a slash command does not require editing a long conditional in `App`;
- TUI, headless, and SDK hosts share one application-level session controller;
- provider implementations are injected behind a contract rather than imported by the agent loop;
- mutable session state is separate from immutable configuration;
- dependency boundaries and cycle rules are enforced in CI;
- Windows, Linux, and supported Node versions produce trustworthy test results;
- release metadata comes from one source of truth.

This plan deliberately avoids a large rewrite. Each phase must leave the repository releasable and may be delivered as several small pull requests.

## Current Baseline

Audit measurements from 2026-07-21:

| Signal | Current state |
| --- | --- |
| Production TypeScript | About 27,700 lines across 133 files |
| Tests | 989 passed, 4 skipped across 92 files |
| Coverage | 70.47% statements, 65.12% branches, 72.41% lines |
| Core hotspot coverage | `tui/app.tsx` 45.16% lines; `tui/hooks/useAgent.ts` 8.29% lines |
| Uncovered public/runtime surfaces | `sdk.ts` 0%; `mcp.ts` 0%; `stream-json.ts` 0% |
| Largest production files | `tui/app.tsx` 1,561 lines; `tui/hooks/useAgent.ts` 1,412; `agent/compact.ts` 1,378 |
| Highest churn | `tui/app.tsx`, `agent/compact.ts`, `tui/hooks/useAgent.ts`, `types.ts`, `agent/loop.ts` |
| Lint | Passes with 41 warnings |
| CI | Ubuntu only, Node 20 and 22 |
| Local Windows test behavior | Tests pass while `node-pty` helper processes emit repeated `AttachConsole failed` errors |
| Runtime dependency graph | Cycle through registry, Task tool, and subagent modules |
| Package audit | No production findings; one low-severity development dependency finding |

The test count is a strength, but aggregate coverage hides weak protection around the modules with the most coordination responsibility.

## Non-Goals

This plan does not authorize:

- a repository-wide folder rename before contracts exist;
- replacing Ink, Vitest, Commander, Zod, or the provider HTTP APIs;
- changing permission semantics, sandbox policy, or memory behavior without separate product approval;
- breaking the public CLI or SDK merely to simplify internals;
- optimizing file size or line count without reducing responsibility and coupling;
- implementing the adaptive harness before the fixed runtime contracts in this plan are stable.

## Engineering Invariants

Every phase must preserve these rules:

1. **Behavior before structure.** Add characterization or contract tests before moving critical behavior.
2. **One owner per contract.** Settings mutation, command registration, session orchestration, provider streaming, and MCP transport each have one authoritative module.
3. **Hosts stay thin.** CLI, TUI, headless, and SDK translate input/output; they do not independently implement agent lifecycle rules.
4. **Configuration is data, runtime is state.** Immutable resolved settings and mutable session resources use different types and lifetimes.
5. **Boundaries are executable.** Import cycles and layer violations fail CI rather than relying on documentation.
6. **Errors are observable.** Corrupt settings, dead child processes, invalid wire data, and skipped integration coverage are surfaced explicitly.
7. **Cross-platform behavior is a release requirement.** Platform-specific tests may be separated, but they may not be silently ignored.
8. **No big-bang migration.** New contracts may temporarily adapt old code; each compatibility layer must have a removal phase.
9. **Public claims require contract tests.** README features must have deterministic tests or be marked experimental.
10. **Simpler wins.** Prefer small functions and explicit dependencies over new frameworks or generic abstraction layers.

---

## Target Architecture

```text
+---------------------------------------------------------------+
| Interfaces                                                    |
| CLI commands | TUI components/hooks | SDK async iterator      |
+---------------------------------------------------------------+
                              |
                              v
+---------------------------------------------------------------+
| Application                                                   |
| AgentSession | command dispatcher | settings service          |
+---------------------------------------------------------------+
                              |
                              v
+---------------------------------------------------------------+
| Core contracts                                                |
| messages | tools | sessions | permissions | provider events   |
+---------------------------------------------------------------+
                              |
                              v
+---------------------------------------------------------------+
| Adapters                                                      |
| Anthropic | OpenAI | MCP | filesystem | git | session store    |
+---------------------------------------------------------------+
```

Dependency direction must point downward. Adapters may implement core ports, but core and application modules must not import UI modules or concrete provider implementations.

### Intended Module Seams

The exact names may change during implementation, but responsibilities should converge toward:

```text
src/application/
  agent-session.ts       Shared lifecycle used by TUI, headless, and SDK
  agent-events.ts        Typed event stream and queue contract
  command-dispatcher.ts  Exact command parsing and handler execution
  settings-service.ts    Validated read/update operations

src/core/
  agent-types.ts
  message-types.ts
  provider.ts
  session-runtime.ts
  tool-types.ts

src/adapters/
  providers/
    anthropic.ts
    openai-compatible.ts
    http-transport.ts
  mcp/
    config.ts
    connection.ts
  filesystem/
    settings-repository.ts

src/interfaces/
  cli/                    Existing CLI modules may migrate last
  sdk/                    SDK-specific event mapping and options
  tui/                    Existing TUI remains a leaf
```

Do not create this entire tree up front. Add a directory only when the first stable responsibility is extracted into it.

---

## Roadmap at a Glance

| Phase | Purpose | Required proof before advancing |
| --- | --- | --- |
| 0 | Freeze contracts and add architectural checks | Known failures reproduce deterministically; boundary checks run in CI |
| 1 | Make settings mutation safe | No command can save an invalid document or overwrite a corrupt file |
| 2 | Repair SDK, stream-json, and MCP contracts | Events stream live, sessions work, and dead MCP servers fail within a bound |
| 3 | Make CI and tests trustworthy | Unit tests are fast, integration tests are isolated, Windows is green, lint has zero warnings |
| 4 | Replace manual slash-command dispatch | Metadata and execution use one exact-match registry |
| 5 | Extract the shared AgentSession application service | TUI, headless, and SDK use the same lifecycle implementation |
| 6 | Enforce runtime state and dependency boundaries | No cycles; TUI is a leaf; runtime state is not stored in `AgentConfig` |
| 7 | Introduce provider ports and shared transport | Adding a provider does not modify the agent loop; retry logic has one owner |
| 8 | Remove blocking UI work and harden releases | Polling is non-blocking; package, CLI, MCP, tags, and changelog agree on version |

Phases 1 and 2 are correctness work and should precede large structural changes. Phases 4 through 7 are incremental architecture work.

---

## Phase 0: Contract Freeze and Guardrails

### Purpose

Capture current public behavior and make architectural drift visible before moving code.

### Work

- [ ] Add `test:unit`, `test:integration`, and `test:contract` script categories without changing the existing `npm test` aggregate behavior.
- [ ] Add failing-first regression tests for:
  - SDK text events being buffered until completion;
  - SDK session persistence/resume not being wired;
  - stream-json input split across arbitrary chunks;
  - stream-json input containing multiple lines in one chunk;
  - MCP initialization that never responds;
  - MCP process exit while requests are pending;
  - invalid settings values being written successfully;
  - malformed local settings being overwritten;
  - built-in command prefix collisions such as `/modeling` and `/helpful`.
- [ ] Add a dependency graph check that detects runtime cycles.
- [ ] Add boundary rules:
  - modules outside `tui/` cannot import from `tui/`;
  - entry points cannot be imported by implementation modules;
  - `agent/` cannot import concrete provider adapters after Phase 7;
  - adapters cannot import interface-layer modules.
- [ ] Record the current dependency exceptions explicitly so the initial check can land before all violations are fixed.
- [ ] Add a tracked maintainability verification command, for example `npm run check`, that runs typecheck, lint, formatting, unit tests, and architecture checks.

### Acceptance Criteria

- Every known correctness problem above has a deterministic test that fails for the expected reason or is marked with a narrow temporary expectation.
- The runtime registry/Task/subagent cycle is reported by an automated check.
- `headless.ts -> tui/input-expansion.ts` is reported as a boundary exception.
- No production behavior changes in this phase.

### Suggested Pull Requests

1. Test script split and regression fixtures.
2. Import graph and boundary checks.
3. Consolidated `npm run check` command.

---

## Phase 1: Safe Settings Repository

### Problem

The CLI and TUI have separate write paths. Both can save values that fail on the next load, and both may replace malformed JSON with an empty object before writing. The TUI help list and CLI allowlist have already drifted. Generic array concatenation also applies automatically to every present and future array field.

### Work

- [ ] Introduce one `SettingsRepository` or equivalent module with operations such as:

```ts
interface SettingsRepository {
  readResolved(context: SettingsContext): ResolvedSettings;
  readLocal(workspace: string): LocalSettingsDocument;
  updateLocal(workspace: string, update: SettingsUpdate): SettingsUpdateResult;
}
```

- [ ] Route `book config set`, `/config`, model selection, effort selection, theme selection, permission persistence, memory toggles, and BYOK provider changes through the same repository.
- [ ] Validate the complete candidate document before writing it.
- [ ] Refuse to mutate a malformed existing file; report its exact path and preserve its contents.
- [ ] Write through a sibling temporary file and rename it atomically.
- [ ] Preserve file permissions where practical.
- [ ] Derive supported top-level keys from one schema-backed registry instead of maintaining arrays in CLI and TUI files.
- [ ] Return structured diagnostics for:
  - invalid JSON;
  - invalid known-field values;
  - unknown fields;
  - deprecated fields;
  - unresolved `{env:VAR}` secrets.
- [ ] Decide and document unknown-field compatibility behavior. At minimum, unknown fields must never disappear silently.
- [ ] Replace generic array concatenation with explicit field policies, for example:
  - permission rules: merge or replace according to a documented policy;
  - hooks: append by scope unless an explicit reset is requested;
  - additional directories: merge with normalization and deduplication;
  - sandbox lists: explicit policy per field;
  - future arrays: replace by default unless registered otherwise.
- [ ] Update README configuration precedence language so scalar override and collection merge behavior are both accurate.
- [ ] Make user-home paths injectable so user/project/local precedence has real tests rather than vacuous placeholders.

### Acceptance Criteria

- Saving `maxTurns="oops"` fails without modifying the file.
- A malformed local settings file is byte-for-byte unchanged after any attempted update.
- CLI and TUI accept and reject the same keys and values.
- Unknown keys produce a visible diagnostic.
- User, project, local, and ad-hoc precedence is tested with injected paths.
- Settings updates survive interruption without leaving partial JSON.

### Migration Notes

- Keep existing exported persistence helpers as adapters temporarily if needed.
- Remove direct settings writes only after all callers use the repository.
- Do not change permission precedence accidentally while changing merge mechanics.

---

## Phase 2: Public Runtime Contracts

### Phase 2A: SDK Event Streaming and Sessions

#### Work

- [ ] Stop parsing Book's own stream-json stdout inside `query()`.
- [ ] Introduce a typed async event queue or callback-to-async-iterator bridge.
- [ ] Emit `system`, `session`, `text`, `tool_use`, `tool_result`, `user_question`, `error`, `result`, and `done` directly from the application runtime.
- [ ] Ensure the first text/tool event is observable before the agent run completes.
- [ ] Add `signal?: AbortSignal` to SDK options and propagate cancellation through provider calls, tools, compaction, hooks, and MCP requests.
- [ ] Wire an actual session store when persistence is enabled.
- [ ] Implement documented session creation, resume, and returned session identity.
- [ ] Route SDK model overrides through the same model/provider resolution used by CLI and TUI.
- [ ] Decide whether invalid SDK options throw before iteration or emit a typed error, then document and test the choice.
- [ ] Replace the stale SDK source examples that use the wrong function signature.
- [ ] Keep the generated public declaration surface small and independent of internal Zod schema types where practical.

#### Contract Tests

- [ ] Text is yielded before the mocked provider sends `done`.
- [ ] Consumer cancellation aborts provider and tool work.
- [ ] A created session emits its generated id and can be resumed.
- [ ] `persistSession: false` performs no session writes.
- [ ] Provider-prefixed model selection resolves credentials and metadata correctly.
- [ ] MCP connections close when the consumer stops iteration early.

#### Acceptance Criteria

- SDK behavior matches README examples.
- `sdk.ts` has at least 80% line and 75% branch coverage.
- The roadmap no longer labels the SDK missing before README calls it stable.

### Phase 2B: Stream-JSON Framing

#### Work

- [ ] Make `createStreamParser()` the single owner of newline buffering.
- [ ] Use it for headless stdin and any stdout/event bridging that remains.
- [ ] Parse zero, one, or many complete records from every arbitrary chunk.
- [ ] Define behavior for a final unterminated line, oversized lines, invalid JSON, and unknown event types.
- [ ] Bound buffered input to prevent unbounded memory growth.

#### Acceptance Criteria

- Fragmented and coalesced input chunks behave identically to one-record-per-chunk input.
- Invalid lines produce an observable diagnostic or documented skip event.
- `stream-json.ts` is covered by direct unit tests.

### Phase 2C: MCP Transport Safety

#### Work

- [ ] Validate MCP config with a schema before spawning processes.
- [ ] Add configurable initialization and request timeouts.
- [ ] Accept `AbortSignal` for connect and tool-call requests.
- [ ] Reject every pending request on child `error`, `exit`, `close`, stdin failure, timeout, abort, or explicit disconnect.
- [ ] Remove settled requests and timers exactly once.
- [ ] Connect independent servers concurrently with bounded concurrency or `Promise.allSettled`.
- [ ] Isolate one failed server from healthy servers.
- [ ] Capture bounded stderr context for diagnostics instead of discarding it completely.
- [ ] Source client version from the package/build version constant.
- [ ] Add a small fixture MCP stdio server for deterministic protocol tests.

#### Acceptance Criteria

- A silent server fails within the configured initialization timeout.
- A normally exiting server rejects pending calls immediately.
- Disconnect leaves no pending promises, child processes, or timers.
- One failed server does not delay or remove tools from healthy servers.
- `mcp.ts` replacement modules have at least 85% line and 75% branch coverage.

---

## Phase 3: Trustworthy Test and CI Pipeline

### Work

- [ ] Run pure unit tests in parallel.
- [ ] Run PTY/TUI integration tests separately with `maxWorkers: 1` only for that job.
- [ ] Add Windows CI for PTY, path, shell, settings, and packaging coverage.
- [ ] Keep Ubuntu CI for sandbox, shell, and general runtime coverage.
- [ ] Add Node 24 to CI while `engines.node` remains `>=20`.
- [ ] Add a minimal macOS smoke job when budget permits, especially for TUI startup and package execution.
- [ ] Make PTY child-process stderr part of test failure or a narrowly asserted platform exception.
- [ ] Replace `/exit`'s `expect(true).toBe(true)` with an actual process-exit assertion.
- [ ] Replace precedence tests that do not execute their claimed behavior.
- [ ] Remove live API secrets from required pull-request tests.
- [ ] Use a deterministic mock provider for all required provider/agent tests.
- [ ] Put live-provider smoke tests in a manual or scheduled workflow with explicit cost limits.
- [ ] Change lint to fail on warnings after the current warning backlog is removed.
- [ ] Enable type-aware TypeScript ESLint rules, beginning with unhandled promises and unsafe argument/return patterns.
- [ ] Add coverage thresholds in stages:
  - initial global floor near the measured baseline;
  - higher thresholds for settings, SDK, MCP, command dispatcher, and new application modules;
  - changed-file or ratcheting policy so coverage cannot decline silently.
- [ ] Add production and development dependency audit reporting.

### Target Pipeline

```text
fast checks
  format -> lint -> typecheck -> architecture -> unit tests

platform checks
  ubuntu integration -> windows PTY/integration -> package smoke

optional checks
  coverage -> benchmark -> live-provider smoke
```

### Acceptance Criteria

- Required CI does not depend on repository secrets.
- Windows tests complete without untracked helper crashes.
- Lint reports zero warnings.
- Unit-test feedback is materially faster than the current approximately 96-second sequential run.
- Coverage thresholds fail when critical modules regress.

---

## Phase 4: Command Registry and Thin TUI Dispatch

### Problem

Command metadata lives in `commands/builtins.ts`, but execution lives in a long conditional inside `App`. Several branches use prefix matching, and settings/help metadata is duplicated.

### Work

- [ ] Define a single command contract:

```ts
interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  argumentHint?: string;
  visibility?: 'normal' | 'hidden';
  availability?: CommandAvailability;
  execute(context: CommandExecutionContext, args: string): Promise<CommandEffect>;
}
```

- [ ] Parse input once into an exact command name and raw argument string.
- [ ] Resolve aliases explicitly rather than with `startsWith` checks.
- [ ] Represent UI changes as typed effects such as:
  - add local message;
  - open modal;
  - start/resume/clear session;
  - submit agent prompt;
  - exit;
  - write/export artifact.
- [ ] Keep filesystem, git, memory, settings, and session work in injected services rather than inside the React component.
- [ ] Make autocomplete, help, system-prompt command listing, and dispatch consume the same registry.
- [ ] Define collision policy between built-in and custom commands.
- [ ] Add contract tests that iterate every registered command and verify metadata, aliases, and handler availability.
- [ ] Move `/config`, `/memory`, `/review`, `/security-review`, `/export`, `/feedback`, and `/release-notes` first because they currently pull many domain imports into `App`.

### Acceptance Criteria

- `/modeling`, `/helpful`, and similar custom commands are not captured by built-ins.
- Adding a built-in command does not require editing `tui/app.tsx`.
- No command name exists in metadata without an executable handler unless explicitly marked host-only.
- `App` owns modal rendering and effect application, not command business rules.
- Command behavior has direct tests without rendering the full TUI.

---

## Phase 5: Shared AgentSession Application Service

### Problem

TUI `useAgent`, headless execution, and SDK each coordinate overlapping lifecycle concerns. `useAgent` currently combines React state, session persistence, agent-loop callbacks, compaction, permissions, provider configuration, memory, and settings mutation.

### Work

- [ ] Define an `AgentSession` application API independent of React and stdout:

```ts
interface AgentSession {
  getSnapshot(): AgentSessionSnapshot;
  events(): AsyncIterable<AgentEvent>;
  send(input: UserInput): Promise<SendResult>;
  compact(request?: CompactRequest): Promise<CompactResult>;
  clear(options?: ClearOptions): Promise<void>;
  resume(selector: SessionSelector): Promise<void>;
  answerPermission(result: PermissionResult): void;
  answerPlan(result: PlanApprovalResult): void;
  answerQuestion(result: UserQuestionResponse): void;
  cancel(reason?: string): void;
  dispose(): Promise<void>;
}
```

- [ ] Move session lifecycle, persistence, compaction orchestration, retry state, pending approvals, and agent-loop callback translation into the application service.
- [ ] Keep React-specific state projection in a smaller hook that subscribes to snapshots/events.
- [ ] Make headless mode consume events and encode them as text/json/stream-json.
- [ ] Make SDK expose the same events directly.
- [ ] Preserve session generation guards and idempotent settlement behavior.
- [ ] Model state transitions explicitly, either with a reducer or a small documented state machine.
- [ ] Ensure cleanup handles cancellation, pending questions, background shells, MCP connections, hooks, and session end exactly once.

### Migration Sequence

1. Extract event types and callback translation without moving persistence.
2. Move pending permission/plan/question settlement.
3. Move send and cancellation lifecycle.
4. Move compaction lifecycle.
5. Move session start/resume/clear/end.
6. Switch headless and SDK to the service.
7. Reduce `useAgent` to React subscription and UI actions.

### Acceptance Criteria

- TUI, headless, and SDK produce equivalent event sequences for the same mock-provider fixture.
- Lifecycle behavior is tested without Ink.
- React unmount does not leak pending requests, timers, or processes.
- Host-specific modules no longer duplicate compaction or session rules.
- `useAgent` no longer imports settings-loader, session store internals, provider model schema, or tool registry construction directly.

---

## Phase 6: Runtime State and Dependency Boundaries

### Phase 6A: Break Cycles and Restore Layering

#### Work

- [ ] Break `registry -> task-tool -> subagent -> registry` by injecting a registry factory or tool catalog into Task/subagent execution.
- [ ] Move input expansion from `tui/` into an application or shared input module.
- [ ] Keep TUI imports one-way: TUI may import application/core modules; non-TUI modules may not import TUI.
- [ ] Separate registry mechanics from default tool composition:

```text
tools/registry-core.ts      Registry class and execution mechanics
tools/default-catalog.ts    Default tool composition
tools/task-tool.ts          Task definition with injected subagent factory
```

- [ ] Make the architecture check fail with no permanent exceptions.

#### Acceptance Criteria

- Runtime and type import graphs contain no cycles.
- TUI is a verified leaf layer.
- Task/subagent recursion remains supported and has explicit depth/cancellation tests.

### Phase 6B: Separate Configuration From Runtime State

#### Work

- [ ] Split `AgentConfig` into immutable resolved configuration and mutable `SessionRuntime`.
- [ ] Move tasks, background shells, file-observation ledger, cancellation, trace identity, and other session-owned resources into runtime state.
- [ ] Avoid mutating configuration objects passed by callers.
- [ ] Define ownership and cleanup for every mutable map, timer, child process, and abort controller.
- [ ] Pass a narrow execution context to tools instead of the full configuration object where possible.

#### Acceptance Criteria

- A resolved configuration object can be frozen in tests without breaking execution.
- Two sessions created from the same configuration cannot share tasks, shells, or file observations accidentally.
- Runtime disposal deterministically cleans every owned resource.

### Phase 6C: Split the Shared Type Hub

#### Work

- [ ] Split `types.ts` by stable domain boundaries: agent, messages, tools, providers, sessions, UI display records, and headless options.
- [ ] Keep a temporary type-only barrel for compatibility.
- [ ] Move `ThemeTokens` and `DEFAULT_THEME` into the theme domain.
- [ ] Prevent core types from importing concrete stores such as `memory-store.ts`.
- [ ] Keep public SDK types in a deliberate public module rather than exporting internal application types accidentally.

#### Acceptance Criteria

- No single type module is the dependency target of most of the repository.
- Public declaration generation no longer expands internal Zod schemas unnecessarily.
- Type moves do not create runtime imports.

---

## Phase 7: Provider Port and Shared Transport

### Work

- [ ] Define a provider interface injected into agent and compaction execution:

```ts
interface Provider {
  stream(
    request: ProviderRequest,
    options: ProviderStreamOptions,
  ): AsyncIterable<ProviderStreamEvent>;
}
```

- [ ] Move provider selection and configuration resolution to a provider factory outside the agent loop.
- [ ] Add a deterministic mock provider used by agent, headless, SDK, subagent, and compaction contract tests.
- [ ] Extract shared HTTP behavior from Anthropic and OpenAI adapters:
  - abort-signal composition;
  - request timeout;
  - retry classification;
  - Retry-After handling;
  - jitter/backoff;
  - total retry budget;
  - stalled-stream detection;
  - bounded safe error extraction.
- [ ] Keep provider-specific request conversion and SSE event interpretation inside each adapter.
- [ ] Ensure shared retry tests run once, plus adapter-specific request/response tests.
- [ ] Define capability metadata for prompt caching, thinking/effort, tools, structured output, and usage accounting.

### Acceptance Criteria

- `agent/loop.ts` and compaction code do not import concrete providers.
- Adding a provider requires a new adapter and factory registration, not agent-loop edits.
- Anthropic and OpenAI use the same retry/timeout/stall implementation.
- Provider tests do not require global `fetch` mutation outside adapter-level tests.

---

## Phase 8: Responsive Runtime and Release Hygiene

### Phase 8A: Remove Blocking UI Work

#### Work

- [ ] Replace `execSync` Git polling with `execFile`/async process execution.
- [ ] Run one bounded status operation per interval and skip overlapping polls.
- [ ] Cancel polling on workspace change and unmount.
- [ ] Move shell input expansion off the React input callback path while preserving cancellation and visible progress.
- [ ] Avoid synchronous filesystem walks during render; cache discovery results and refresh through explicit events.
- [ ] Add latency budgets to existing UI benchmarks for large transcripts, diffs, and markdown.

#### Acceptance Criteria

- A slow Git command cannot freeze input handling.
- Polling never overlaps and never leaves child processes after unmount.
- Common input submission remains responsive while mentions or shell expansion run.

### Phase 8B: Version and Package Discipline

#### Work

- [ ] Source CLI and MCP version from package/build metadata.
- [ ] Add a release check that verifies package version, lockfile version, changelog entry, and Git tag consistency.
- [ ] Add `npm pack --dry-run` and installed-package CLI/SDK smoke tests to CI.
- [ ] Decide whether source maps belong in the distributed package and document the choice.
- [ ] Add a `packageManager` field and document the supported npm/Corepack workflow.
- [ ] Add automated dependency update tooling with grouped, scheduled updates.
- [ ] Review the low-severity esbuild advisory and update the owning toolchain when compatible.
- [ ] Add a release workflow or documented release checklist with rollback steps.

#### Acceptance Criteria

- Package, CLI `--version`, MCP handshake, changelog, and release tag report the same version.
- A packed installation can execute both CLI and SDK smoke examples.
- Supported Node/npm versions are explicit and tested.

---

## Cross-Cutting Test Strategy

### Test Layers

| Layer | Purpose | Examples |
| --- | --- | --- |
| Pure unit | Algorithms and state transitions | command parsing, merge policies, event reducers |
| Contract | Stable public/internal boundaries | Provider, SettingsRepository, AgentSession, MCP transport |
| Integration | Multiple real modules with fake external systems | SDK session resume, headless stream framing, subagent Task |
| PTY/system | Terminal and packaging behavior | startup, resize, exit, keyboard input, installed binary |
| Live smoke | External provider compatibility | scheduled/manual Anthropic and OpenAI calls |

### Required Fixtures

- deterministic mock provider with scripted text, tool, retry, stall, and usage events;
- fixture MCP stdio process with success, delay, malformed output, normal exit, and crash modes;
- injectable filesystem/home/settings paths;
- controllable clock and timers for retry, polling, and lifecycle tests;
- in-memory or temporary session store fixture;
- event collector that compares TUI/headless/SDK application behavior.

### Coverage Policy

Do not chase aggregate coverage by testing trivial render branches. Prioritize failure boundaries and high-churn coordination modules.

Initial targets after relevant phases:

| Surface | Line target | Branch target |
| --- | ---: | ---: |
| Settings repository/service | 90% | 85% |
| SDK interface | 80% | 75% |
| MCP transport | 85% | 75% |
| Command dispatcher | 90% | 85% |
| AgentSession | 85% | 75% |
| Provider shared transport | 90% | 85% |

Coverage exclusions must be narrow and justified in code review.

---

## Delivery Rules

### Pull Request Size

- Prefer one contract or migration seam per pull request.
- Keep mechanical moves separate from behavioral changes when possible.
- A pull request that changes more than one host must explain why the shared contract could not land first.
- Do not combine hotspot refactors with unrelated visual or product changes.

### Compatibility Adapters

Temporary adapters are allowed when they:

- are named and documented as transitional;
- have an owner and removal phase;
- preserve observable behavior;
- do not become a second source of truth.

### Rollback

Each phase should be independently revertible. New application services may ship behind internal construction switches during migration, but public behavior must not depend on two implementations for an extended period.

---

## Success Metrics

Track these over the implementation period:

| Metric | Target |
| --- | --- |
| Lint warnings | 0 |
| Runtime import cycles | 0 |
| Non-TUI imports from `tui/` | 0 |
| Required CI platforms | Ubuntu and Windows; macOS smoke when budget permits |
| Required live API secrets | 0 |
| Invalid settings writes | 0; rejected before mutation |
| Unbounded MCP requests | 0 |
| SDK buffered-event bridge | Removed |
| Command prefix collisions | 0 |
| New command changes to `tui/app.tsx` | 0 |
| New provider changes to `agent/loop.ts` | 0 |
| Shared mutable runtime objects stored in `AgentConfig` | 0 |
| Unit-test feedback time | Substantially below the current sequential suite |

Qualitative success is equally important:

- contributors can locate the owner of a behavior quickly;
- tests describe contracts rather than implementation accidents;
- errors identify the failing boundary and recovery action;
- feature work touches fewer unrelated modules over time;
- documentation and runtime behavior do not contradict each other.

---

## Implementation Tracking Ledger

Update this table as pull requests land.

| Phase | Status | Pull requests | Verification record | Notes |
| --- | --- | --- | --- | --- |
| 0 - Contract freeze | Not started | | | |
| 1 - Settings safety | Not started | | | |
| 2 - SDK/stream/MCP | Not started | | | |
| 3 - CI trust | Not started | | | |
| 4 - Command registry | Not started | | | |
| 5 - AgentSession | Not started | | | |
| 6 - Boundaries/runtime/types | Not started | | | |
| 7 - Provider port | Not started | | | |
| 8 - Performance/release | Not started | | | |

## Definition of Done

This maintainability program is complete when:

- [ ] settings writes are validated, atomic, shared by all hosts, and unable to destroy malformed files;
- [ ] SDK events stream directly and documented persistence/resume behavior is tested;
- [ ] stream-json handles arbitrary chunk boundaries;
- [ ] MCP requests are timeout-, abort-, exit-, and disconnect-safe;
- [ ] required tests are deterministic without live credentials;
- [ ] Windows and Ubuntu CI are trustworthy;
- [ ] lint has zero warnings and architecture violations fail CI;
- [ ] slash commands use one exact-match registry;
- [ ] TUI, headless, and SDK share one AgentSession lifecycle;
- [ ] runtime state is separate from immutable configuration;
- [ ] runtime and type import graphs are cycle-free;
- [ ] TUI is an enforced leaf layer;
- [ ] providers implement an injected port and share transport reliability code;
- [ ] blocking process work is removed from interactive render/input paths;
- [ ] release version metadata is consistent and automatically checked;
- [ ] README, roadmap, and implementation agree on which product surfaces are stable.

