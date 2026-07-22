# Codebase Maintainability Execution Plan

- **Date:** 2026-07-22
- **Status:** Complete
- **Source:** `plans/long-term-maintainability-plan.md`
- **Objective:** Turn the long-term maintainability roadmap into a sequence of small,
  independently releasable pull requests.

## Current Progress

**Last updated:** 2026-07-22

All planned pull requests and milestone exit gates are implemented. The original baseline and
delivery guidance remain below as historical context; the tables in this section are the final
requirement-by-requirement audit.

### Delivery Status

| Planned work | Status | Current result |
| --- | --- | --- |
| PR 1: Test taxonomy and aggregate scripts | Complete | Unit, contract, and integration suites have explicit configs; `npm test` remains the aggregate; pure unit tests run with four workers while process-heavy tiers remain isolated. |
| PR 2: Architecture checks | Complete | Cycle, layer, entry-point, removed type-hub, and blocking child-process rules fail on fixtures and pass with no exception ledger. |
| PR 3: Characterization fixtures | Complete | Deterministic scripted-provider, MCP stdio, temporary session/settings, event-collector, SDK, headless, and PTY fixtures run without network credentials or user-home state. |
| PR 4: Settings repository core | Complete | Settings writes use schema validation, distinct malformed/absent states, cloned mutations, atomic sibling replacement, structured diagnostics, malformed-file preservation, and secret redaction. |
| PR 5: Settings merge policies | Complete | Array policies, normalized/deduplicated directories, documented permission/hook accumulation, default replacement, and injectable resolution paths are directly tested. |
| PR 6: Migrate all writers | Complete | CLI, TUI, BYOK removal, permission migration, and preference writes use the repository; CLI and TUI settings help share schema-backed metadata. |
| PR 7: Stream-JSON framing | Complete | One bounded parser owns fragmentation, CRLF, multiple/final records, shape validation, invalid JSON, and oversized-line diagnostics for headless input. |
| PR 8: MCP connection safety | Complete | Validation, concurrent initialization, timeout/abort handling, bounded stderr, exactly-once settlement, child exit, and process/timer/listener cleanup are covered across success and failure modes. |
| PR 9: SDK runtime event bridge | Complete | SDK events stream live from shared runtime events, use real or ephemeral session identity correctly, and propagate cancellation through provider, tool, hook, compaction, lifecycle, managed-agent, and MCP paths. |
| PR 10: Deterministic required checks | Complete | Required CI uses Ubuntu and Windows on Node 20 and 24 without provider secrets; exact settings, PTY exit, and visible TUI behavior assertions replace vacuous checks. |
| PR 11: Quality ratchet | Complete | Lint has zero warnings with type-aware promise/unsafe-boundary rules, global and critical-module coverage floors are enforced, and production/development audits are part of CI/release checks. |
| PR 12: Exact command contract | Complete | One typed exact-match registry owns names, aliases, collisions, availability, help/autocomplete metadata, and execution. |
| PR 13: Prompt/report handlers | Complete | Prompt/report commands execute outside React and return typed effects. |
| PR 14: Settings/session/UI handlers | Complete | All remaining built-ins, including task/agent/diff/reload/usage/cost/context behavior, execute through typed handlers/effects; `App` contains no command-name business logic. |
| Milestone 5: Shared `AgentSession` | Complete | TUI, headless, and SDK share lifecycle, send, persistence, interaction settlement, cancellation, compaction, and session transitions; React retains projection and UI actions only. |
| PR 15: Break boundary violations | Complete | Shared input modules, split registry composition, injected catalogs, and a leaf TUI remove all architecture exceptions and cycles. |
| PR 16: Configuration/runtime ownership | Complete | Resolved configuration is deeply frozen; `SessionRuntime` owns per-session tasks, shells, observations, discovery state, abort controllers, timers, trace identity, child processes, and disposal. |
| PR 17: Provider port and reliability | Complete | Agent and compaction paths consume an injected `Provider`; adapters share retry classification, `Retry-After`, jitter, total budgets, request timeouts, stalled-stream handling, abort composition, and bounded error extraction. |
| PR 18: Type-hub split | Complete | Domain types live under `src/types/`; every caller migrated, `src/types.ts` was removed, and architecture checks forbid its return. |
| PR 19: Responsive interactive work | Complete | Git polling and shell resolution are asynchronous/cancellable, discovery is performed before React render, synchronous child-process APIs are forbidden in production, and UI latency budgets are enforced. |
| PR 20: Package and version checks | Complete | One version source feeds CLI/MCP, consistency checks cover package/lock/changelog/tag surfaces, packed CLI/SDK smoke tests pass, npm metadata and Dependabot are configured, and release/rollback steps are documented. |

### Current Verification

- `npm run check` passes formatting, zero-warning lint, typecheck, architecture checks, 1,100 unit
  tests, and 20 contract tests.
- `npm test` passes after the build: 1,100 unit tests, 20 contract tests, and 49 integration tests;
  4 platform/fixture cases are intentionally skipped.
- `npm run test:coverage` passes 1,120 tests and every global/critical-module threshold. The measured
  aggregate is 70.25% statements, 64.03% branches, 71.11% functions, and 72.49% lines.
- `npm run bench:ui` passes the explicit budgets: markdown 18.75/75 ms, large transcript
  126.93/750 ms, diff 44.31/175 ms, and input submission 1.08/75 ms.
- `npm run release:check` passes version consistency, audit, package installation, installed CLI,
  and installed SDK smoke checks. `npm run audit:prod` reports zero vulnerabilities; the full audit
  meets the high-severity gate with one known low-severity development-only `esbuild` advisory.
- `git diff --check` passes, the architecture graph has no exceptions or cycles, `src/types.ts` is
  absent, and production source contains no synchronous child-process API.
- Local verification was performed on Windows with Node 24.18.0 and npm 11.16.0. The checked-in CI
  matrix covers Ubuntu/Windows and Node 20/24 without secrets; this record does not claim a remote
  GitHub Actions run occurred locally.

### Definition of Done Audit

| Requirement | Result | Evidence |
| --- | --- | --- |
| Settings changes are validated, atomic, shared, and non-destructive | Met | `settings-repository` owns production writes; malformed, invalid, failure, precedence, metadata, and redaction cases are tested. |
| Stream framing and MCP process behavior are bounded and directly tested | Met | Bounded stream parsing and the full MCP timeout/abort/exit/crash/listener/process cleanup matrix pass. |
| SDK events stream live with cancellation and real session persistence | Met | The SDK consumes raw shared events through an async queue and cancellation tests span every owned runtime path. |
| Required CI is deterministic on Ubuntu and Windows without secrets | Met | CI matrices both operating systems and Node 20/24; required jobs contain no provider credential references and use offline fixtures. |
| Command metadata and execution have one exact-match registry | Met | Registry contract tests cover unique names, aliases, metadata, collision policy, availability, and handlers. |
| TUI, headless, and SDK share one `AgentSession` lifecycle | Met | Lifecycle, send, persistence, interactions, compaction, cancellation, and session transitions are owned below host layers. |
| Runtime state is separate from immutable configuration | Met | Resolved config is deeply frozen and mutable resources have one per-session `SessionRuntime` owner/disposal path. |
| Dependency rules are enforced with no exceptions or cycles | Met | Architecture checks pass with no ledger; TUI is a leaf and the removed compatibility type hub is forbidden. |
| Providers implement an injected port with one shared reliability layer | Met | Provider port/factory tests and shared reliability tests cover both adapters and compaction/agent injection. |
| Interactive code performs no blocking process work | Met | Git polling, shell resolution, and rewind Git identity avoid synchronous processes; the architecture gate forbids `execSync`, `execFileSync`, and `spawnSync` in production. |
| Package, CLI, MCP, changelog, and release tags agree on version | Met | `version:check`, package smoke, installed CLI/SDK smoke, and the release checklist pass; tag validation is enforced when HEAD is tagged. |

### Completion Evidence

No temporary adapter introduced by this plan, architecture exception, or planned follow-up remains.
Future maintenance should use the established gates rather than extend this plan's milestone
sequence.

## Executive Direction

The long-term plan has the right target architecture and risk areas. The main improvement needed
is execution order: correctness fixes, test seams, and application contracts must land before broad
folder or type reorganizations.

Use this priority order:

1. Prevent destructive or unbounded behavior.
2. Make public runtime contracts testable and deterministic.
3. Remove business logic from host layers.
4. Enforce dependency direction and runtime ownership.
5. Consolidate providers, performance work, and release checks.

Do not treat file length reduction as a goal by itself. A refactor is successful when a behavior has
one owner, a direct test, and fewer consumers that know its implementation details.

## Original Confirmed Baseline

The following findings describe the tree when this plan was authored:

- `npm run typecheck` passes.
- `npm run lint` passes with 40 warnings.
- `npm test` builds successfully but did not complete within 180 seconds on local Windows/Node 24;
  repeated `node-pty` helper processes failed with `AttachConsole failed`.
- `src/tui/app.tsx` is about 1,700 lines and still owns slash-command business logic.
- `src/tui/hooks/useAgent.ts` is about 1,700 lines and owns React state plus agent/session lifecycle.
- CLI and TUI settings writes are separate, non-atomic, and can replace malformed JSON with `{}`.
- `src/sdk.ts` buffers headless stream events until `runHeadless()` completes and has no direct tests.
- `src/mcp.ts` has no request timeout, abort contract, or complete pending-request cleanup.
- `src/headless.ts` imports `src/tui/input-expansion.ts`.
- The registry/subagent dependency cycle is still present.
- Vitest is globally restricted to `maxWorkers: 1`.
- CI runs only on Ubuntu with Node 20 and 22 and supplies a live API secret to the required test job.
- Git status polling and shell input expansion use synchronous child-process calls.

These findings make settings safety, MCP safety, SDK streaming, and test trust the first delivery
block. The large TUI and agent-session refactors should start only after those contracts are green.

## Delivery Rules

- Every behavioral pull request starts with a regression or contract test and finishes green.
- Never merge intentionally failing tests; use `test.todo` only when it names a later milestone and
  cannot create a false impression of coverage.
- Keep mechanical file moves separate from behavioral changes.
- Preserve temporary adapters only while callers migrate; record their removal pull request.
- Keep `npm test` as the full aggregate command while adding narrower developer commands.
- Avoid creating the full target directory tree up front. Add a module when its first stable contract
  is ready.
- Use one owner for event emission, settings mutation, command resolution, session lifecycle, and
  provider transport.

## Milestone 0: Establish Trustworthy Guardrails

**Purpose:** Make the later changes safe to review without changing product behavior.

### Pull Request 1: Test taxonomy and aggregate scripts

- Add `test:unit`, `test:contract`, and `test:integration` scripts.
- Keep `npm test` running all three categories after the build.
- Run pure unit tests in parallel; isolate PTY/process integration tests with one worker.
- Classify tests by explicit filename or include patterns instead of broad timing assumptions.
- Add `npm run check` for format, lint, typecheck, architecture checks, and unit/contract tests.

**Proof:** The aggregate suite runs the same or greater test set, and unit feedback becomes faster.

### Pull Request 2: Architecture checks with a temporary exception ledger

- Add an import graph check for cycles and layer violations.
- Enforce that non-TUI code cannot import `tui/`.
- Enforce that implementation modules cannot import CLI/SDK entry points.
- Record only the current known exceptions:
  - `headless.ts -> tui/input-expansion.ts`;
  - the registry/task/subagent cycle.
- Make new violations fail immediately.

**Proof:** Both known violations are reported and a fixture violation fails the check.

### Pull Request 3: Characterization fixtures

- Add a deterministic scripted provider fixture.
- Add an MCP stdio fixture with success, silence, delay, malformed output, exit, and crash modes.
- Add injectable settings/home paths and a temporary session-store fixture.
- Add a small async event collector/queue test helper.

**Exit gate:** Later contract tests require no network credentials or user-home state.

## Milestone 1: Make Settings Mutation Safe

**Purpose:** Eliminate the only confirmed path that can silently destroy user configuration.

### Pull Request 4: Settings repository core

- Introduce `src/settings-repository.ts` as the single mutation owner.
- Read absent, valid, malformed, and non-object documents as distinct results.
- Apply dot-path changes to a cloned candidate document.
- Validate the complete candidate with `bookSettingsSchema` before writing.
- Write to a sibling temporary file, flush/close it, and rename atomically.
- Never modify a malformed source file.
- Derive supported top-level keys from the schema or one schema-backed registry.
- Return structured diagnostics containing the file path and validation issue path.

**Required tests:** invalid `maxTurns`, malformed JSON preservation, unknown key behavior, write
failure, atomic replacement, and secret redaction.

### Pull Request 5: Explicit settings merge policies

- Replace generic array concatenation with a field policy table.
- Normalize and deduplicate `additionalDirectories`.
- Preserve documented permission and hook precedence.
- Default future arrays to replacement unless explicitly registered.
- Make user-home and settings source paths injectable in resolution tests.

**Required tests:** user/project/local/ad-hoc precedence for both scalar and collection fields.

### Pull Request 6: Migrate all writers

- Route `book config set` through the repository.
- Adapt `src/tui/persist.ts` to the repository and then remove duplicate parsing/writing logic.
- Migrate theme, model, effort, permissions, memory, and BYOK provider persistence.
- Make CLI and TUI help consume the same key metadata.
- Update README precedence and failure behavior.

**Exit gate:** No production file outside the repository performs a settings JSON write.

## Milestone 2: Harden Runtime I/O Contracts

**Purpose:** Prevent hangs and make headless/SDK behavior trustworthy before larger orchestration
work.

### Pull Request 7: Stream-JSON framing

- Make `createStreamParser()` the only newline-buffer owner.
- Use it for headless stdin.
- Support fragmented chunks, multiple lines per chunk, CRLF, and final unterminated records.
- Add a configurable maximum buffered line size.
- Return or emit explicit invalid-JSON, invalid-shape, and oversized-line diagnostics.
- Validate event types instead of accepting any object with a `type` property.

**Exit gate:** Arbitrary chunking produces the same events as one-record-per-chunk input.

### Pull Request 8: MCP connection safety

- Split config parsing from process/JSON-RPC connection management.
- Validate config before spawning.
- Add initialization and request timeouts plus `AbortSignal` support.
- Settle every pending request exactly once on response, timeout, abort, stdin failure, child error,
  exit, close, or explicit disconnect.
- Capture bounded stderr context for diagnostics.
- Connect independent servers concurrently with `Promise.allSettled`.
- Keep healthy server tools when another server fails.
- Source client version from package/build metadata.

**Exit gate:** Silent and exited fixtures fail within a bound, and disconnect leaves no process,
promise, timer, or listener leak.

### Pull Request 9: Direct runtime event bridge for SDK

- Add one typed runtime event callback beneath output encoding.
- Make headless text/json/stream-json formats encode those events instead of owning them.
- Bridge callbacks to an async queue in `query()` and yield while execution is still running.
- Stop parsing Book's own stdout inside the SDK.
- Propagate `AbortSignal` through SDK, headless, provider, tool, compaction, hook, and MCP paths.
- Pass a real session store when SDK persistence is enabled.
- Test session creation, resume, returned identity, disabled persistence, early iterator cancellation,
  and model/provider resolution.
- Correct the stale SDK source example signature.

This event contract should be deliberately compatible with the later `AgentSession` service so the
SDK fix does not become throwaway work.

**Exit gate:** The first text/tool event is observable before provider completion, and stopping the
consumer cancels all owned work.

## Milestone 3: Make CI a Release Signal

### Pull Request 10: Deterministic required checks

- Remove live provider credentials from required pull-request tests.
- Move live-provider smoke tests to a manual or scheduled workflow with cost limits.
- Add Windows CI for PTY, paths, shells, settings, and package smoke tests.
- Keep Ubuntu for sandbox and general runtime coverage.
- Add Node 24 while retaining the supported minimum Node 20 job.
- Replace vacuous process-exit and settings-precedence assertions.
- Treat unexpected PTY helper stderr as a failure or a narrowly documented platform expectation.

### Pull Request 11: Quality ratchet

- Remove the current 40 lint warnings, then enable `--max-warnings 0`.
- Enable type-aware rules incrementally, starting with floating promises and unsafe boundaries.
- Set a global coverage floor near the measured baseline.
- Set higher per-module thresholds for settings, stream parsing, MCP, SDK, command dispatch, and new
  application modules.
- Add production and development dependency audit reporting.

**Exit gate:** Required CI is green on Ubuntu and Windows without repository secrets.

## Milestone 4: Replace Slash-Command Branching

**Purpose:** Remove command business logic from React without changing the visible TUI.

### Pull Request 12: Exact parser and registry contract

- Parse slash input once into exact command name and raw arguments.
- Resolve aliases explicitly; never use prefix matching for command identity.
- Define `CommandDefinition`, execution context, availability, and typed effects.
- Make autocomplete, help, system-prompt metadata, and execution use the same registry.
- Define built-in/custom collision policy.
- Add a registry-wide contract test for unique names, aliases, metadata, and executable handlers.

### Pull Requests 13-14: Incremental handler migration

- First migrate prompt/report commands: `/review`, `/security-review`, `/release-notes`, `/feedback`,
  `/export`, and `/init`.
- Then migrate settings/session/UI commands: `/config`, `/memory`, `/model`, `/effort`, `/clear`,
  `/resume`, `/compact`, and `/rewind`.
- Keep `App` responsible only for modal rendering and applying typed UI effects.

**Exit gate:** Adding a built-in command does not require editing `src/tui/app.tsx`, and prefix
collisions such as `/modeling` and `/helpful` are impossible.

## Milestone 5: Extract the Shared AgentSession Service

**Purpose:** Give TUI, headless, and SDK one lifecycle implementation.

Deliver this as several pull requests in the following order:

1. Extract stable `AgentEvent`, snapshot, and reducer/state-transition types from the runtime event
   bridge.
2. Move pending permission, plan, and user-question settlement with idempotency tests.
3. Move send, cancellation, and cleanup ownership.
4. Move compaction orchestration and boundary persistence.
5. Move session create/resume/clear/end lifecycle.
6. Switch headless and SDK to `AgentSession`.
7. Reduce `useAgent` to React subscription, snapshot projection, and UI actions.

Use a deterministic mock provider to assert equivalent event sequences across hosts. Do not migrate
all hosts in one pull request.

**Exit gate:** Lifecycle tests run without Ink, cleanup is exactly-once, and `useAgent` no longer
constructs provider, registry, settings, or session-store internals.

## Milestone 6: Restore Dependency and Runtime Ownership

### Pull Request 15: Break known boundary violations

- Move input expansion from `tui/` to a shared/application input module.
- Split registry mechanics from default tool composition.
- Inject a tool catalog or registry factory into Task/subagent execution.
- Remove all architecture-check exceptions.

### Pull Request 16: Separate resolved configuration from session runtime

- Keep resolved configuration immutable and freeze it in tests.
- Move tasks, background shells, file observations, abort controllers, trace identity, timers, and
  child processes into `SessionRuntime`.
- Define one owner and disposal path for each mutable resource.
- Pass narrow tool execution contexts instead of full `AgentConfig` where practical.

### Pull Request 17: Introduce provider port and shared transport

- Inject a `Provider` into agent and compaction execution.
- Move provider selection to a factory outside the agent loop.
- Consolidate timeout, retry classification, `Retry-After`, jitter, total budget, stalled streams,
  abort composition, and safe error extraction.
- Keep request conversion and provider-specific stream interpretation in adapters.

### Pull Request 18: Split the type hub last

- Split `src/types.ts` only after the application, runtime, and provider contracts are stable.
- Use domain modules for messages, tools, providers, sessions, runtime, and public SDK types.
- Keep a temporary type-only compatibility barrel, then remove it after callers migrate.

Splitting types last avoids high-churn mechanical edits while contracts are still changing.

**Exit gate:** No import cycles, TUI is a leaf, configuration can be frozen, two sessions cannot
share mutable resources, and agent/compaction modules do not import concrete providers.

## Milestone 7: Responsiveness and Release Discipline

### Pull Request 19: Remove blocking interactive work

- Replace synchronous Git polling with cancellable async process execution.
- Skip overlapping polls and terminate owned work on unmount/workspace change.
- Move shell expansion away from the React input callback and show bounded progress.
- Cache filesystem discovery outside render paths.
- Add benchmark budgets for large transcripts, diffs, markdown, and input submission.

### Pull Request 20: Package and version checks

- Create one generated/build-time version source for CLI and MCP.
- Verify package, lockfile, changelog, Git tag, CLI version, and MCP version consistency.
- Add `npm pack --dry-run` plus installed CLI and SDK smoke tests.
- Add `packageManager`, supported npm guidance, dependency update automation, and a documented
  release/rollback checklist.

**Exit gate:** A packed installation works on supported Node versions, and all release surfaces
report the same version.

## Recommended First Six Pull Requests

Start with this exact sequence:

1. Test taxonomy, deterministic fixtures, and `npm run check`.
2. Architecture checks with the two known temporary exceptions.
3. Settings repository with validation and atomic writes.
4. Migrate CLI/TUI settings writers and document merge behavior.
5. Stream-JSON framing and diagnostics.
6. MCP timeout, abort, exit, and disconnect safety.

This sequence delivers visible risk reduction before changing the two largest coordinators. The SDK
streaming pull request should follow immediately after MCP because its cancellation contract owns MCP
cleanup.

## Progress Metrics

Track outcomes rather than raw file size:

| Metric | Target |
| --- | --- |
| Invalid or destructive settings writes | 0 |
| Unbounded MCP requests | 0 |
| Required live API secrets | 0 |
| Lint warnings | 0 |
| Runtime/type import cycles | 0 |
| Non-TUI imports from `tui/` | 0 |
| Built-in command edits required in `App` | 0 |
| Provider additions requiring agent-loop edits | 0 |
| Shared mutable state stored in resolved config | 0 |
| Required CI platforms | Ubuntu and Windows |
| Critical contract coverage | Per-module thresholds enforced |

For every milestone, record the pull request, verification command, measured result, compatibility
adapter introduced, and planned adapter-removal pull request.

## Definition of Done

The improvement program is complete when:

- settings changes are validated, atomic, shared, and non-destructive;
- stream framing and MCP process behavior are bounded and directly tested;
- SDK events stream live with cancellation and real session persistence;
- required CI is deterministic on Ubuntu and Windows without secrets;
- command metadata and execution have one exact-match registry;
- TUI, headless, and SDK share one `AgentSession` lifecycle;
- runtime state is separate from immutable configuration;
- dependency rules are enforced with no exceptions or cycles;
- providers implement an injected port with one shared reliability layer;
- interactive code performs no blocking process work;
- package, CLI, MCP, changelog, and release tags agree on version.
