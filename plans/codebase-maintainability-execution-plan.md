# Codebase Maintainability Execution Plan

- **Date:** 2026-07-21
- **Status:** In progress
- **Source:** `plans/long-term-maintainability-plan.md`
- **Objective:** Turn the long-term maintainability roadmap into a sequence of small,
  independently releasable pull requests.

## Current Progress

**Last updated:** 2026-07-21

The first risk-reduction tranche is implemented. The broader application/runtime restructuring is
not complete and should continue as separate changes rather than being collapsed into one patch.

### Delivery Status

| Planned work | Status | Current result |
| --- | --- | --- |
| PR 1: Test taxonomy and aggregate scripts | Partial | Added unit, contract, and integration configs; `npm test` remains the aggregate; `npm run check` is available. Process-heavy tests run with one worker, and the Windows/Node 24 integration tier now completes without ConPTY helper failures. The unit suite also remains on one worker because parallel TUI tests were flaky. |
| PR 2: Architecture checks | Complete | Added cycle/layer/entry-point checks and a failing fixture test. The non-TUI import from `tui/` and the registry/agent-manager/task cycle are removed; no exception ledger remains. |
| PR 3: Characterization fixtures | Complete | Added reusable MCP stdio, scripted-provider, temporary `SessionStore`, and async event collector fixtures. Contract coverage is offline and deterministic across SDK, headless, MCP, and PTY paths. |
| PR 4: Settings repository core | Complete | Added schema-backed key metadata, distinct document read states, cloned dot-path mutations, complete validation, atomic sibling-file replacement, structured diagnostics, malformed-file preservation, and secret-redacted mutation metadata. |
| PR 5: Settings merge policies | Complete | Added explicit array policies, normalized/deduplicated `additionalDirectories`, permission/hook accumulation, replacement for unregistered arrays, and injectable resolution paths. |
| PR 6: Migrate all writers | Partial | CLI config writes, TUI persistence, BYOK provider removal, permission migration, and preference writes use the repository. CLI/TUI help metadata is not fully unified. |
| PR 7: Stream-JSON framing | Complete | One bounded parser now handles fragmentation, multiple records, CRLF, unterminated records, invalid JSON, invalid shapes, and oversized lines; headless stdin uses it. |
| PR 8: MCP connection safety | Substantially complete | Config validation, concurrent connection attempts, initialization/request timeouts, abort support, bounded stderr, version metadata, and exactly-once pending settlement are implemented. Contract tests now cover the full process-mode matrix, mixed healthy/unhealthy servers, timeout/abort/disconnect pending cleanup, bounded stderr, and child exit after disconnect. Explicit active-handle/listener accounting across failed initialization remains. |
| PR 9: SDK runtime event bridge | Substantially complete | Headless exposes a direct event callback; SDK events stream through an async queue before completion, cancellation is propagated, and real/ephemeral session identity is covered. Broader cancellation tests across every hook/tool/compaction path remain. |
| PRs 10-11: CI and quality ratchet | Partial | Settings precedence CLI assertions are now exact and offline. CI matrix, secret-free required checks, the remaining vacuous process assertions, coverage floors, dependency audits, type-aware lint rules, and zero-warning enforcement remain. |
| PR 12: Exact command contract | Complete | Built-ins use one typed registry for exact names, explicit aliases, availability checks, collision policy, metadata, and execution. Registry-wide tests enforce unique names, aliases, metadata, and handlers. |
| PR 13: Prompt/report handler migration | Complete | `/review`, `/security-review`, `/release-notes`, `/feedback`, `/export`, and `/init` execute outside `src/tui/app.tsx` and return typed prompt or local-message effects. |
| PR 14: Settings/session/UI handler migration | Complete | Session lifecycle, modal, panel, config, memory, model, effort, and theme commands execute through typed handlers/effects. Config help uses schema-backed key metadata, and shared effort policy no longer lives under `tui/`. |
| Milestone 5: Shared `AgentSession` | Partial | Added a stable public `AgentEvent` contract plus immutable session snapshot/reducer types. A session-domain interaction controller now owns permission, plan-approval, and queued user-question promises with idempotent settlement; `useAgent` only subscribes to resolver-free interaction snapshots. Send, cancellation, cleanup, and host lifecycle ownership remain split. |
| PR 15: Break boundary violations | Complete | Input expansion and file-mention discovery live in `src/input/`. Registry mechanics are split from default tool composition, manager/capability code depends on the core, and all architecture exceptions are removed. |
| PRs 16-20 | Not started | Session runtime ownership, provider port/transport, type-hub split, non-blocking interaction work, and package/release checks remain. |

### Current Verification

- `npm run check` passes: formatting, lint, typecheck, architecture checks, 1,052 unit tests,
  and 20 contract tests.
- `npm run build` passes.
- Lint still reports 33 warnings; warning elimination and `--max-warnings 0` remain PR 11 work.
- `npm run test:integration` passes on Windows/Node 24: 6 files, 48 tests passed, 4 skipped, in
  about 53 seconds. The TUI harness now awaits PTY exit, reports bounded startup/assertion
  diagnostics, separates text and Enter writes for ConPTY, avoids node-pty's racing
  `AttachConsole` cleanup helper, and isolates workspace/home/session state.
- Settings CLI integration now asserts exact resolved values through `book config get` without
  starting the agent runtime or making provider requests. The config subcommand honors root
  `--settings` and `--no-settings` flags.
- Architecture checks enforce all known boundaries with no cycle or layer exceptions.

### Next Recommended Sequence

1. Move send, cancellation, and cleanup ownership into `AgentSession`.
2. Move compaction orchestration and boundary persistence behind the session contract.

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
