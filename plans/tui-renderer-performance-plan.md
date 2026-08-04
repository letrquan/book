# TUI Renderer Performance Recovery Plan

Status: implemented through the guarded rollout; Windows now defaults to `safe`, other interactive
terminals default to `incremental`, and the full real-PTY soak remains pending

## Implementation Status (2026-07-29)

Completed:

- Backported Ink issue #909's one-line trailing-newline fix to Ink 6.8.0 with `patch-package` and
  install-time verification.
- Added safe, incremental, and experimental-scroll modes. Incremental is the default on
  non-Windows interactive terminals; safe is the Windows default and remains the fallback for
  non-TTY and screen-reader output.
- Added xterm.js screen replay regressions for middle-row updates, prompts, and activity rows.
- Removed direct calls to Ink's private root layout/render methods from transcript scrolling while
  preserving memoized transcript children.
- Consolidated spinner, progress, tool-duration, working-duration, and managed-agent-duration
  timers onto shared fast and slow clocks. Fast animation pauses during transcript scrolling.
- Extended `bench:ui` with terminal bytes, writes, convergence time, final-screen comparison, and
  an isolated environment with all `BOOK_DEBUG*` flags removed.

Still required for the rollout follow-up:

- Complete the full Windows ConPTY and Unix PTY scenario matrix and ten-minute interactive soaks.
- Add resize/Unicode/long-running managed-agent screen cases to the replay suite.
- Keep incremental as the non-Windows default only while those terminal correctness gates remain at
  zero errors; re-enable it by default on Windows only after ConPTY gates pass.

## Objective

Restore incremental TUI performance without reintroducing ghost rows, duplicated activity,
footer corruption, scrollback destruction, or renderer state drift.

The implementation must retain Node.js 20 support and keep a stable full-frame fallback.

## Research Findings

### Confirmed root cause

Book uses Ink 6.8.0. Its incremental renderer rewinds the terminal cursor with:

```ts
ansiEscapes.cursorUp(previousVisible - 1);
```

For a frame ending in a newline, `previousVisible` excludes the trailing empty split entry. The
cursor therefore rewinds one row too little, and later updates are written below their intended
rows. This exactly matches the duplicated input, activity, and status lines observed on Windows.

Ink issue #909 documents the same failure:

- https://github.com/vadimdemedes/ink/issues/909

Ink fixed it in commit `c32da0b3066590df08da5cef8351a7b863081c1b` by changing the rewind to:

```ts
ansiEscapes.cursorUp(previousLines.length - 1);
```

The fix shipped in Ink 7.0.0. Ink 7.1.1 is current, but Ink 7 requires Node.js 22 while Book
currently supports Node.js 20 and newer. A direct major upgrade is therefore not the immediate
repair.

### Other renderer risks

- Book's custom `DECSTBM` plus `CSI S/T` scroll renderer is not covered by a real terminal-screen
  model and corrupted the fixed footer under ConPTY.
- `TranscriptView` reaches into Ink DOM internals and calls `root.onComputeLayout()` and
  `root.onRender()`. These are not public Ink APIs and can bypass normal render scheduling.
- The current PTY tests strip ANSI bytes or inspect the append-only byte stream. They do not
  reconstruct the terminal screen, so a corrupt screen can still pass.
- The current UI benchmark measures React and Ink computation through `ink-testing-library`. It
  does not measure bytes written, terminal application time, screen convergence, flicker, or
  cursor correctness.
- Independent timers update spinners, tool durations, agent durations, elapsed time, progress,
  Git status, and temporary notices. These can generate multiple React updates per visual frame.
- Debug logging is inherited by benchmarks when `BOOK_DEBUG*` is set, materially polluting timing
  and output.

### Current safe baseline

With Ink incremental rendering disabled, the current benchmark reports:

| Workload                      | Current result | Existing budget |
| ----------------------------- | -------------: | --------------: |
| 120-message wheel update      |    4.37 ms p95 |           16 ms |
| 1000-message wheel update     |    5.09 ms p95 |           25 ms |
| 1000-message streaming update |   31.61 ms p95 |           50 ms |
| Streaming completion          |       54.45 ms |          300 ms |
| Managed-trace churn           |   76.28 ms p95 |          100 ms |
| Large transcript render       | 100.71 ms mean |          750 ms |

These numbers show that computation is currently within budget. The missing metric is terminal
output cost, which is where incremental rendering should help.

## Architecture Decision

Use Ink's incremental algorithm with the exact upstream trailing-newline fix backported to 6.8.0.
Do not make the custom terminal scroll-region renderer part of the production path.

Keep three explicit renderer modes during rollout:

| Mode                  | Behavior                                       | Purpose                 |
| --------------------- | ---------------------------------------------- | ----------------------- |
| `safe`                | Ink full-frame renderer                        | Permanent recovery path |
| `incremental`         | Ink 6.8 incremental renderer with upstream fix | Target default          |
| `experimental-scroll` | Optional research-only scroll-region renderer  | Never automatic         |

Expose the selection through `BOOK_TUI_RENDERER`, with `incremental` as the interactive default. Unknown
values must fall back to `safe`.

## Phase 1: Build a Correctness Harness

Do this before re-enabling incremental rendering.

### 1.1 Backport regression unit test

Add a direct test around Ink's `log-update` behavior:

1. Render a frame ending in `\n`.
2. Change only a middle row.
3. Assert the second write starts with `cursorUp(previousLines.length - 1)`.
4. Assert the untouched first and last rows remain intact after replay.

The test must fail against unpatched Ink 6.8.0.

### 1.2 Terminal-screen replay

Add `@xterm/headless` as a development dependency and replay raw PTY bytes into a terminal model.
Assertions must inspect the final screen buffer, not stripped or appended output.

Required scenarios:

- Tall restored transcript, followed by five seconds of idle updates.
- Input placeholder and border remain present exactly once.
- Active working indicator updates elapsed time for at least ten seconds.
- Managed-agent activity updates tools and duration without adding rows.
- Spinner runs for at least 100 frames without changing screen height.
- Wheel-up and wheel-down bursts keep the input and status footer fixed.
- PageUp, PageDown, Ctrl+U, Ctrl+D, Ctrl+Home, and Ctrl+End.
- Resize `120x40 -> 80x24 -> 120x40` during streaming and manual history browsing.
- ANSI colors, inverse text, emoji, CJK, combining marks, and wrapped Markdown.
- Output with and without a trailing newline.
- Safe and incremental renderer modes.

### 1.3 Real PTY matrix

Keep the existing node-pty tests, but add screen-buffer assertions on:

- Windows ConPTY.
- Native Unix PTY in CI.
- xterm.js-compatible replay through `@xterm/headless` on every platform.

Track emitted control sequences and fail on unexpected `CSI 3J`. Record `CSI 2J`, cursor movement,
and alternate-screen transitions for diagnostics.

## Phase 2: Apply the Minimal Upstream Backport

Use a reproducible dependency patch rather than runtime monkey-patching.

Recommended implementation:

1. Add `patch-package` as a development dependency.
2. Add `patches/ink+6.8.0.patch` containing only upstream commit `c32da0b` and its regression test
   equivalent in Book.
3. Add a `postinstall` command that applies the patch.
4. Add a verification script that reads the installed `ink/build/log-update.js` and fails if the
   expected patched expression is absent.
5. Document the upstream issue, commit, and removal condition next to the patch.

Do not bundle the experimental scroll-region renderer into this patch. The backport should remain
byte-for-byte close to upstream so it can be audited and removed later.

Acceptance gate:

- Clean `npm ci` applies the patch on Windows and Linux.
- The upstream regression test fails without the patch and passes with it.
- All terminal-screen scenarios pass in both `safe` and `incremental` modes.

## Phase 3: Remove Renderer State Bypasses

Replace direct calls to Ink internals from `TranscriptView`:

```ts
root.onComputeLayout();
root.onRender();
```

Preferred design:

1. Store scroll position in a narrow external store.
2. Subscribe only the offset layer with `useSyncExternalStore`.
3. Memoize transcript rows so a scroll commit changes layout without re-rendering Markdown and tool
   children.
4. Let Ink schedule and serialize every terminal render.

Benchmark this against the current imperative Yoga path. Keep the internal API path only if it is
measurably necessary and can be routed through one serialized render coordinator.

Acceptance gate:

- No production access to `DOMElement.onRender` or `DOMElement.onComputeLayout`.
- Scroll updates do not re-render transcript message children.
- Wheel computation remains below 16 ms p95 for 120 messages and 25 ms p95 for 1000 messages.

## Phase 4: Add a Shared UI Clock

Replace per-component intervals with shared clocks:

- Fast clock: 100 ms for visible spinners and progress.
- Slow clock: 1 second for durations and elapsed labels.
- Poll clock: 5 seconds for Git status and similar background state.

Only mounted and visible components should subscribe. Pause fast updates while scrolling, while a
modal owns the screen, and when the terminal is unfocused if focus reporting is available.

Additional rules:

- No decorative animation in the input footer.
- Reduce active spinner cadence to 10 frames per second unless measurement proves 12.5 frames per
  second is visibly better.
- Coalesce all state changes occurring in one clock tick into one React commit.
- Finished agent rows must unsubscribe from time updates.

Acceptance gate:

- Idle session with no active work emits zero render frames over 30 seconds.
- One active agent emits at most 10 visual frames per second.
- Eight active agents still produce at most one root commit per clock tick.

## Phase 5: Measure Terminal Cost, Not Only React Cost

Extend `bench:ui` into three layers:

### Compute benchmark

Keep the existing React/Ink timing benchmarks.

### Renderer benchmark

Capture stdout writes and report:

- Bytes per frame.
- Writes per frame.
- Full clears per minute.
- Cursor operations per frame.
- Event-loop delay.
- React commit count.

### Terminal convergence benchmark

Replay writes through `@xterm/headless` and measure from input event to correct final screen.

Required workloads:

- 60-second idle session.
- 20-token-per-second streaming response.
- 1000-message completed transcript.
- Eight active managed agents with duration and tool updates.
- 200-event wheel burst.
- Rapid resize sequence.

Initial performance gates:

| Metric                               |             Gate |
| ------------------------------------ | ---------------: |
| Input-to-correct-screen p95          |         <= 33 ms |
| Wheel computation p95, 120 messages  |         <= 16 ms |
| Wheel computation p95, 1000 messages |         <= 25 ms |
| Streaming computation p95            |         <= 50 ms |
| Incremental bytes versus safe mode   | >= 70% reduction |
| Incorrect final screen frames        |                0 |
| Idle renders with no active work     |                0 |

Benchmarks must force `BOOK_DEBUG`, `BOOK_DEBUG_RENDER`, `BOOK_DEBUG_FLOW`, and `BOOK_DEBUG_UI` off in
their child environment.

## Phase 6: Controlled Rollout

1. Land the harness and upstream backport with `incremental` as the interactive default.
2. Run incremental in local development and CI terminal replay.
3. Complete a ten-minute Windows ConPTY soak with streaming, agent activity, scrolling, resize, and
   prompt input.
4. Complete the equivalent Unix PTY soak.
5. Keep `incremental` as the default while correctness and performance gates remain green; revert
   with `BOOK_TUI_RENDERER=safe` if a soak exposes a terminal-specific regression.
6. Keep `BOOK_TUI_RENDERER=safe` documented as the permanent emergency fallback.
7. Log renderer mode and fallback reason only when debug logging is explicitly enabled.

Automatic fallback conditions:

- Non-TTY output.
- Screen-reader mode.
- Failed dependency-patch verification.
- Unsupported Ink version.
- Renderer invariant failure detected by a development assertion.

## Phase 7: Later Ink 7 Migration

Evaluate Node.js 22 as a separate breaking change:

1. Run the complete suite on Node 20, 22, and current LTS.
2. Audit Ink 7 input changes, especially Backspace/Delete and Escape/Meta semantics.
3. Replace local animation and measurement helpers with Ink 7 APIs only when they reduce code and
   preserve behavior.
4. Remove the Ink 6.8 patch after the minimum Node version moves to 22.

Do not combine the Node 22 migration with the renderer recovery rollout.

## Features to Keep, Rework, and Pause

### Keep

- Bounded completed-history hydration.
- Transcript virtualization and measured row cache.
- Stable completed-timeline memoization.
- Wheel input batching.
- Scroll activity gating.
- Debug-log byte caps.

### Rework

- Direct Ink root rendering from `TranscriptView`.
- Per-component timers.
- Benchmarks that ignore terminal bytes and final screen state.
- PTY assertions based only on stripped append-only output.

### Pause

- Automatic `DECSTBM` and `CSI S/T` scrolling.
- Any renderer optimization without xterm replay and real PTY coverage.
- A direct Ink 7 upgrade while Node 20 remains supported.

## Definition of Done

- No duplicated or ghost lines in a ten-minute active session.
- Input and status footer remain fixed through scroll, stream, resize, and agent updates.
- Final screen buffers match expected snapshots on ConPTY, Unix PTY, and xterm replay.
- Incremental mode reduces terminal output by at least 70% over safe mode.
- Existing computation budgets continue to pass.
- The safe renderer remains one environment variable away.
- The implementation contains no unexplained copy of proprietary renderer code; all dependency
  changes trace to public Ink source and upstream commits.
