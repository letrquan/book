# Prototype: lead/sidekick latency and TUI rendering

**Date:** 2026-09-12 · **Branch:** `claude/devin-fusion-muse-research-05lnut`
**Follows:** [`devin-cli-and-muse-code.md`](./devin-cli-and-muse-code.md) §6, open questions 2 and 3.

The research left two unknowns blocking a lead/sidekick design: _what latency does the two-agent
split add_, and _how does a paused-lead / working-sidekick state render in a transcript_. Nobody
publishes either. This prototype measures the first and builds the second, against the real TUI.

> **Method.** Model time is held constant and injected, so every number below is **harness** cost, not
> model cost. TUI evidence is replayed frames from the real CLI in a PTY (`.claude/skills/run-book`
> driver + mock provider), not a stripped log. No credentials were available in this environment, so
> the "build by running Book" half of the `run-book` mandate could not run — the source edits are
> hand-written, and the verification half (real TUI, real tools, scripted model) is intact.

---

## 1. Headline: the paused lead did not exist

The research assumed the question was _how to render_ a paused lead. The first probe showed there is
usually nothing to render, because the lead never pauses.

Book has two delegation primitives and they behave completely differently:

|                                                     | `AgentSpawn` (background) | `Task` (foreground)              |
| --------------------------------------------------- | ------------------------- | -------------------------------- |
| Lead blocks on the child                            | **No**                    | Yes                              |
| Found by `ToolSearch("delegate subagent parallel")` | Yes                       | **No — zero catalog keywords**   |
| Status in the tool description                      | Current                   | **"Deprecated"**                 |
| Child's brief shown in transcript                   | No                        | No _(before this prototype)_     |
| Child's live tool activity shown                    | Yes                       | **No** _(before this prototype)_ |

So the only primitive that produces a real lead/sidekick pairing is the one that is deprecated,
undiscoverable, and rendered as a bare spinner. Tool discovery actively steers a model away from it:
`src/tools/catalog.ts` gives `AgentSpawn` the keywords `['delegate', 'subagent', 'parallel']` and
gives `Task` none, so the natural query for delegation can only ever return the non-blocking one.

### What that looks like

Background delegation, 1.8s into a 6.1s sidekick run — the lead has already emitted **two** further
turns, including a claim that the sidekick reported back:

```
  ⠹ explorer(map the auth module) · 1.8s
    Running in background · Tab to open

  Waiting on the sidekick to report back. LEAD-IDLE
  Sidekick reported. Done. LEAD-DONE          <-- printed before any report arrived
```

This is worse than a missing feature. The lead narrates a handoff that has not happened, and the
transcript presents it as fact. Nothing in the UI contradicts it.

Foreground delegation did block correctly — but rendered as this, for the entire run:

```
  ⠴ Task explorer                                              5s
```

No brief, no profile, no child activity, no indication the lead had stopped.

---

## 2. Latency: the harness is not the problem

`src/agents/delegation-latency.test.ts` measures a full `spawn → run → wait → acknowledge` cycle with
the child's model turn injected at a fixed duration, so the remainder is attributable to admission
checks, profile resolution, record persistence, isolation setup and wait plumbing.

| Case                                             | Overhead per delegation   |
| ------------------------------------------------ | ------------------------- |
| `explorer` (read-only, no worktree), median of 5 | **17 ms** (worst 51 ms)   |
| Same, 50 ms child vs 1000 ms child               | **18 ms vs 18 ms** — flat |
| `patcher` (git worktree isolation), 3 runs       | **84–134 ms**             |

Two conclusions:

1. **Handoff cost is negligible** against any real model turn (seconds). Worktree isolation costs ~5×
   more than read-only delegation and is still two orders of magnitude below one turn. The harness is
   not what makes a lead/sidekick split expensive.
2. **Overhead does not scale with the delegated work**, which is the property the pattern needs — the
   whole point is handing off long tasks.

The flatness is asserted, not just measured: the test fails if handoff cost starts tracking child
duration, and prints the absolute numbers on every run so a regression is legible rather than merely
red.

**What this does _not_ measure.** The real latency cost of foreground delegation is not overhead, it
is **serialization**: while the lead is blocked, wall-clock is strictly additive — lead turn + sidekick
turn, with no overlap. Cognition's design avoids this by having the lead _review_ rather than idle.
That is a scheduling question, not a harness-cost question, and this prototype does not answer it.
Also unmeasured: worktree overhead was probed on a trivial repository; a large one will cost more.

---

## 3. What was built

Minimal changes to make foreground delegation legible, and nothing that reverses a product decision.

**`parentToolCallId` on the spawn request and record** (`src/agents/types.ts`, `manager.ts`,
`tools/task-tool.ts`). The structural reason foreground delegation could not be rendered: `AgentSpawn`
publishes the child's id in its tool _result_, but `Task` does not settle until the child is
**finished** — so for the entire window the child is running, the transcript had no way to name it.
`Task` now stamps the link at spawn time, before it blocks.

**Trace projection for foreground delegation** (`src/tui/managed-agent-transcript.ts`). The projection
was hard-coded to `call.name === 'AgentSpawn'`. It now also links records by `parentToolCallId`, and
carries a `blocking` flag set from whether the parent call has settled.

**Paused-lead wording** (`src/tui/components/ManagedAgentActivityBlock.tsx`). "Running in background"
next to a stopped lead asserts something false. A blocking trace now reads _"Lead paused · sidekick
working"_.

**Latency probe** (`src/agents/delegation-latency.test.ts`) and projection tests
(`src/tui/managed-agent-transcript.test.tsx`).

### Before / after, same scenario, real TUI

```
before:  ⠴ Task explorer                                                            5s

after:   ⠴ explorer(SIDEKICK-BRIEF: map the auth module. Constraints:) · 5.0s
           Lead paused · sidekick working · Tab to open
```

Verified through the full lifecycle — running → running → completed, with the footer switching to
"Transcript retained" on settle — and the background path re-run to confirm it still reads "Running in
background" and still leaves the lead working.

---

## 4. What this changes about the recommendations

The research's §4.A said a lead/sidekick mode belongs on `src/agents/`. That still holds, but the
ordering was wrong. Two items move ahead of it:

1. **Decide what `Task` is.** Book deprecated foreground delegation in favour of background lifecycle
   tools — the opposite of the direction Cognition took. That may well be right, but it is currently
   an _implicit_ decision recorded only in a tool description, and it forecloses the lead/sidekick
   pattern by construction. This wants an ADR, not a keyword fix. **I deliberately did not add
   catalog keywords to `Task`**: making a deprecated tool discoverable is a product decision, not a
   prototype's to make.
2. **A lead that idles is the actual cost.** Overhead is ~17 ms; serialization is seconds. If Book
   builds this, the lead must have something to do while the sidekick works — review, planning the
   next delegation — or the pairing is strictly slower than not delegating, whatever it saves on
   tokens. This is the design question worth resolving before any pairing work starts.

The truthfulness problem in §1 is worth treating separately from the feature. A lead that claims to
have received a report it never got is a defect on the _current_ background path, independent of
whether Book ever ships a pairing mode.

---

## 5. Reproducing

```bash
npm run build

# Latency (prints the breakdown)
npx vitest run --config vitest.unit.config.ts --silent=false --reporter=verbose \
  src/agents/delegation-latency.test.ts

# TUI: paused lead. Needs a scenario whose ToolSearch query is "Task" —
# "delegate"/"subagent" cannot reach it (see §1).
node .claude/skills/run-book/driver.mjs --mock --mock-script <scenario>.json \
  --workspace /tmp/proto-ws --shots /tmp/proto-shots
```

Gotchas that cost time here, all of them documented in `.claude/skills/run-book/SKILL.md` and all of
them real: the transcript renames rows (wait for `explorer`, never `AgentSpawn`), `status:'blocked'`
renders as **`skipped`** — which is how the "no catalog keywords" finding first surfaced as a mystery
refusal — and the permission dialog needs `key enter`, not `type r`, for `Task`.
