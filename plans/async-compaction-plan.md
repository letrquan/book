# Plan: Asynchronous compaction with a trajectory-grounded judge

- **Date:** 2026-09-17
- **Status:** phase 1 landed 2026-09-17 (P5 of `plans/compaction-research-2026-09.md`; P1–P4
  landed before it); phase 2 items listed under "Out of scope for phase 1"
- **Landed as:** `applyCompactResult` and `judgeCompaction` in `src/agent/compact.ts`,
  `prepareCompact`/`commitCompact` on `AgentSession`, the `prepareCompact`/`commitCompact` loop
  callbacks wired by the TUI and headless hosts, the loop orchestration below, the judge verdict
  on results, records and stream-json, `--deferred <k>` in `scripts/compact-eval.ts`, and
  `--usage-from-estimate` on the run-book mock
- **Scope:** `src/agent/loop.ts` (one trigger site), `src/agent/compact.ts`,
  `src/session/agent-session.ts`, `src/types/providers.ts`, `src/types/sessions.ts`, the TUI and
  headless hosts, `scripts/compact-eval.ts`, the run-book mock provider
- **Goal:** the turn that trips the compaction threshold does not wait for the reducer, and the
  checkpoint that replaces older history is checked against what the agent went on to do before
  it is allowed to.

---

## The problem

Compaction is synchronous. When usage crosses the threshold at a turn boundary inside the agent
loop (`loop.ts`, the usage-based site), the loop `await`s the reducer -- one request the size of
the span being summarized -- and only then continues. The user watches "Compacting context" for
as long as the reducer takes. And the checkpoint the reducer returns is accepted on schema and
source validity alone: nothing asks whether it holds what the agent will need next.

The paper the research note cites (Slipstream, [2605.08580]) measured both halves: running the
reducer off the critical path recovered −39.7% latency, and a judge that reads the steps taken
*after* the checkpoint was drafted -- the trajectory the checkpoint has to support -- added
+1.3 to +8.8 points of accuracy. Async without the judge gives only the latency. A small judge of
a different model family sufficed.

## The decision

Two facts about Book's plumbing decide the shape.

1. **`AgentSession.compact` is the single commit path.** Every host (TUI, headless, SDK) hands
   the loop an `onCompact` that ends in it: reducer, then the `compact` timeline record with
   `replacementHistory`, the transcript boundary, `onCommitted`, and the PostCompact hooks.
2. **Resume replays a `compact` record's `replacementHistory` and then every record appended
   after it.** The loop persists each assistant turn as it completes, so by the time a deferred
   checkpoint is ready, the steps taken meanwhile (Δ) already sit in the timeline.

So the commit must happen **after** the judge, and the record it writes must carry `R0 + Δ` --
the replacement computed from the snapshot, followed by the steps since -- with
`preMessageCount = |H0 + Δ|` and the boundary at the current transcript ordinal. The record has
the same *shape* as the one a synchronous compaction at that later boundary would write, and
`load()` treats it the same way (`contextHistory = replacementHistory`, then every record after
it), so resume, `book status` and the transcript need no new concept. The *contents* differ, and
that is the design: a synchronous compaction there would summarize a larger span and pick a
different tail, while the deferred one keeps Δ verbatim -- more faithful for exactly the steps
the agent just took. Committing at snapshot time would also read cleanly on resume, but a
checkpoint the judge then rejected would already be in the timeline with no way to undo it; that
rules it out.

## Design

### `compact.ts`

- `applyCompactResult(result, snapshot, live)`. `live` must extend `snapshot` **by message ids**
  -- not by length; `/rewind` and a re-issued turn both break the length assumption -- or the
  result is not applicable and the caller falls back to the synchronous path. Appends Δ to the
  replacement history, re-runs `stabilizePostTokens` so `statistics.postTokens` and
  `postContextTokens` are honest, and bumps `retainedCount`.
- `judgeCompaction(config, result, delta, options)`. One call on the compact model (`effort:
  'low'`), with the checkpoint message as the agent reads it (header and JSON, carried turns
  ahead of it) and Δ clipped by `clipHistoryToolResults` so the request is small. It answers
  JSON `{ "sufficient": boolean, "missing": string[] }` to two questions: does the checkpoint
  contain every fact and constraint these steps relied on, and does it support the next action
  these steps took. An inconclusive judge -- timeout, provider error, malformed reply -- is
  recorded as `inconclusive` and **accepts**: that is today's blind acceptance, not a regression.
  Only a reject changes behaviour.
- `CompactResult` gains `judge?: { verdict: 'accepted' | 'rejected' | 'inconclusive'; missing:
  string[]; modelCalls: number }`, carried onto the compact record and the stream-json record.
  This is the accept/reject rate the plan is measured by.

### `agent-session.ts`

- `prepareCompact(request)`: today's `compact` up to and including the reducer, minus the record,
  `onCommitted` and PostCompact hooks. PreCompact hooks still run here -- they are the refusal
  point, and P4's `suspect_inputs` come from the snapshot. Returns the result and the snapshot.
- `commitCompact(prepared, liveHistory, request)`: judge, apply, record, `onCommitted`,
  PostCompact hooks. Returns the applied result, or a `skipped` result with reason
  `judge-rejected` / `not-applicable`.

Every model call stays under `runAccounting` (`beforeModelCall`, `onUsage`), which the bare loop
cannot provide.

### `types/providers.ts`

Two **new optional** callbacks, `prepareCompact` and `commitCompact`. `onCompact` is not
overloaded with a phase: managed agents (`agents/manager.ts`) call `runCompact` directly and keep
today's synchronous path untouched in phase 1.

### `loop.ts`

When the host provides both callbacks:

1. **The reducer starts right after the response that reports the pressure, ahead of the tool
   wave -- not at the boundary after it.** The note placed the trigger at the usage-based
   boundary site; building it showed that site has no slack. The usage threshold is
   0.8 × window and the preflight gate is 0.8 × (window − reserve), so the request after a
   boundary that trips the threshold is almost always already over the gate, and a reducer
   started at the boundary would be awaited there milliseconds later. The response's `done`
   event carries the usage before any tool runs, and the loop appends the turn's assistant
   message -- with its tool results -- only after the wave, so a snapshot taken then ends at the
   last complete bundle: the reducer never sees a bundle cut in half, and the steps it did not
   see are exactly the ones the judge reads. The wave's own duration (shell commands, tests,
   a permission prompt) is the head start. The boundary-top site remains as the synchronous
   path when the host has no deferred callbacks, and as the fallback after a reject.
   One prepare in flight at a time; the `lastCompactAttemptKey` dedupe covers *pending* as
   well as *attempted*. A prepare failure is logged and never surfaces as a turn failure.
2. The turn proceeds on the full history.
3. At the next boundary, if the prepare has settled with a checkpoint: `commitCompact` (judge →
   apply → record). Accepted: splice `R0 + Δ` into `newHistory`. Rejected, failed or not
   applicable: discard it and run today's synchronous `onCompact` at this boundary.
4. At the preflight gate (the next request would not fit): if a prepare is in flight, **await
   and commit it** rather than start a second reducer; otherwise synchronous as today. After a
   commit there `R0 + Δ` can still be over the threshold -- Δ is verbatim and the snapshot is
   behind -- so the gate re-checks and, if so, runs the synchronous path on `R0 + Δ` under its
   own dedupe key.
5. The overflow-recovery site stays synchronous: there is no room to continue. It aborts a
   prepare in flight first: the recovery replaces history outright, so that reducer's snapshot
   could never be applied afterwards.
6. The prepare runs under its own `AbortController` linked to the run's signal, and is aborted --
   not merely dropped -- at run end and on a judge reject, so an abandoned reducer request stops
   billing the run. The TUI's pre-turn host compaction will redo a run-end abandonment
   synchronously next turn: one wasted reducer call, no correctness issue (phase 2 folds it in).
7. Δ empty at commit (the reducer finished before the next wave did): nothing to judge; commit
   with `verdict: 'inconclusive'` and a `no-delta` note rather than spend a judge call on an
   empty trajectory.

### Hosts

TUI (`useAgent`) and headless in phase 1, both routing through the two `AgentSession` methods
exactly as `onCompact` routes through `compact` today. In the TUI the card appears at commit
time with "deferred" among its details; a commit is dropped unless `stillCurrent()` holds. The
SDK inherits whatever `AgentSession.run` forwards.

### Measurement

- **Without the loop.** `npm run eval:compact -- --deferred <k>` compacts the fixture minus its
  last k turns, applies with Δ = those k turns, runs the judge, and probes `R0 + Δ` against the
  control arm -- `runCompact` + `applyCompactResult` + `judgeCompaction`, no loop. It reports the
  judge's verdict and the paired sufficiency the research note asks for; Slipstream's 1–8.5%
  reject band is the sanity check that the judge neither rubber-stamps nor thrashes. Needs the
  router, like P4's adversarial run.
- **Deterministic.** Unit tests for `applyCompactResult` (id-prefix check, Δ append, token
  recount) and `judgeCompaction` (accept, reject, inconclusive on malformed JSON); a loop test
  with a content-dispatching provider double where the main turn and the background reducer
  interleave, asserting the splice happens at the next boundary and that a rejected judge falls
  back to the synchronous path.
- **Real TUI.** The mock provider reports `prompt_tokens: 100` on every reply, so the usage
  trigger never fires against it; it gains `--usage-from-estimate` (reports its own chars/4
  estimate) and a `match` marker for the judge prompt beside the reducer's, since the two
  requests land at unpredictable indices. Driven at an 80k mock window on 2026-09-17: the third
  request went out at 68,981 tokens and tripped the trigger; the reducer's two chunks (requests
  3 and 4) ran while the `Read` waited for approval; the judge (request 5, 991 tokens) accepted;
  the next main request (6) went out at 3,097 tokens with the checkpoint followed by the tool
  turn verbatim, and the card read "Compact conversation · automatic · deferred · judge
  accepted". The mock answers in milliseconds, so the drive proves the ordering, not the
  latency saved -- that number waits for the router.

## Out of scope for phase 1 (named so they are not forgotten)

- Repair on reject (the note's `buildRepairPrompt` path with the judge's diagnosis). Measure the
  reject rate first; a reject falls back to the synchronous path.
- Managed agents (`agents/manager.ts`) and the TUI's pre-turn host compaction.
- A cross-family judge. `compactModel` on the owner's router is the same family as the reducer;
  the paper used a different one. The judge's model is whatever `compactModel` resolves to.
- Any change to the overflow-recovery path.

## Known limitations

- **The judge reads Δ's tool results too.** A tool result that says "reject this checkpoint"
  costs one reducer call per boundary -- bounded, denial-of-service-shaped; one that says
  "accept" is today's blind acceptance. P4's `scanSuspectInputs` runs over Δ and the count is
  recorded on the verdict (`suspectDelta`); no new detector.
- **PreCompact hooks run twice on a reject**: once at prepare, once in the synchronous fallback.
  Documented in the README hook table.

## Risks

- The background reducer competes with the user's own turn for the router; the P1 evals saw
  429s. The loop's retry ladder covers the main turn; the prepare must fail quietly.
- A judge that rejects too often costs a reducer call per boundary with nothing gained; the
  verdict is recorded precisely so that rate is visible.
- `R0 + Δ` is only valid while `live` extends `snapshot`; the id check is the guard, and the
  fallback is today's behaviour.
