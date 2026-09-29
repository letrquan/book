# Plan: Compaction v3 — a prose handoff, a masked history, a tail cut by message

- **Date:** 2026-09-29
- **Status:** in progress on `feat/compaction-v3`
- **Supersedes:** the reducer half of `plans/carried-ledger-plan.md` and P2–P4 of
  `plans/compaction-research-2026-09.md`. Carried Turns (P1) and the residual tail (Phase 1) stay.
- **Scope:** `src/agent/compact.ts`, a new `src/agent/tool-output-masking.ts`, `src/agent/loop.ts`
  (preflight), `src/agent/session-state.ts` (stale files), `src/types/messages.ts`,
  `src/types/sessions.ts`, `scripts/compact-replay.ts` (new), docs. Deleted:
  `src/agent/carried-ledger.ts`, `src/agent/compact-fidelity.ts`, the inherited-constraint audit in
  `src/agent/compact-audit.ts`.

## Why

Measured on the owner's `~/.book` (38 real compactions since 2026-09-17):

| What                                                                   | Value                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Degraded (every one `invalid-checkpoint`)                              | 20 / 38                                                 |
| Degraded reply stored as raw JSON in `state.summary`, every list empty | 18 / 20                                                 |
| Clean when a repair call was needed                                    | 7 / 27                                                  |
| Retained tail empty                                                    | 27 / 38 (every first compaction of a one-user-turn run) |
| Context after compaction, median                                       | 4.6k tokens (3.5% of before)                            |
| Blocking wait, median / p90 / max                                      | 68 s / 246 s / 674 s                                    |

The failures are not in the parts the literature worried about (constraint loss, eviction attacks,
revocation). They are in the parts no other agent has: a strict JSON schema whose every quote and
event reference is validated all-or-nothing by the host, a fit ladder that cuts the prose before
the hashes, and a retained tail sized in whole user-led bundles. None of the fifteen agents surveyed
on 2026-09-29 (Claude Code, Codex, Gemini CLI, OpenCode, Qwen Code, Cline, Roo, OpenHands, pi, Aider,
Amp, Cursor, Copilot CLI, Kiro, Factory) validates its summary's structure; the strictest rejects a
reply the output cap cut off. The fidelity harness could not see this because its reducer double
always writes valid JSON.

## The design

### 1. Tool-output masking (new, deterministic, runs before any summarizer)

`maskStaleToolOutputs(history, options)` in `src/agent/tool-output-masking.ts`. The model reads a
one-line placeholder in place of an old successful tool result -- the tool name, the primary
argument and how to get the output back -- set as `ToolResult.maskedPlaceholder`, which
`toolResultModelContent` returns instead of `content`. The content itself is kept, so the
summarizer, the judge and the record still read every byte:

```
[tool output cleared to save context: Read src/agent/loop.ts (~4000 tokens); run Read again to see it]
```

Rules, each from a measured result or a review finding:

- **The newest steps are never masked.** The newest ten steps with tool results (the observation
  window "The Complexity Trap" used), whatever they cost -- the newest is the wave the model has
  not seen yet -- and beyond them the newest `protectTokens` (40k, 20% of the gate on a smaller
  window). On a small window this protects everything and compaction does the work, rather than
  masking a file the agent read one step earlier.
- **Only output a rerun reproduces.** `Read`, `Grep`, `Glob`, the git and session-history reads.
  Not `Bash`, `WebFetch`, `WebSearch` or `BashOutput`: their output depends on when they ran, and
  the session's copy of a tool result reads back clipped to a few thousand characters, so a
  placeholder would promise output the agent cannot get. Aliased names are read as the tool they
  name.
- **Batched.** Masking runs only when at least `minClearTokens` (20k, 10% of the gate) would be
  cleared at once, so the provider's prefix cache is invalidated rarely, not on every request
  (Anthropic's `clear_at_least`; "Token Reduction Is Not Cost Reduction", 2607.12161: cache traffic
  is ~80% of the bill).
- **Never a failed result** (masking errors raised error rates 18.6% → 22.6%, 2606.00408), **never a
  small one** (≤ 500 tokens), and **idempotent**.
- The tool call and its arguments stay, so exact paths and commands survive (the edit gate reads the
  runtime observation ledger, not the history, so a masked `Read` does not block a later `Edit`).

Masking runs before **every** compaction trigger -- the loop's preflight and turn boundary, the
hosts' pre-turn check -- once the request is over 0.6 × the gate; if the request is then under the
gate, no compaction runs. A settled deferred compaction is dropped, not committed, when the
request is back under the line it started at by the time it settles. "The Complexity Trap" (2508.21433): masking
matches LLM summarization on SWE-bench Verified at about half the cost, and the hybrid -- mask
first, summarize as the last resort -- was cheapest.

### 2. The retained tail is cut at message boundaries

`selectRecentMessages` replaces `selectRecentBundles`. It walks back from the newest message,
clipping each retained message's tool results to `retainedToolResultMaxTokens`, and keeps messages
while they fit `recentBudget`. The newest message is kept with its results clipped down a ladder
(2,000, 500, 125 tokens) and is summarized with the rest only when even that cannot fit. Tool calls and their results live on the same assistant message, so any message
boundary is a valid cut. Nothing depends on a user turn existing any more; `planRefreshTurns` stays
for the plan restatement it also does, but is no longer what makes compaction retain anything.

Carried Turns are unchanged: user-authored turns from the summarized span (and turns an earlier
generation carried) are kept verbatim ahead of the checkpoint, clipped by the existing ladder.

### 3. One summarizer call that writes a Markdown handoff

The summarizer reads:

- the previous summary, if there is one (`<previous-summary>`), with the rule "carry forward
  everything still relevant; move finished items to Done; the conversation wins where they
  conflict" (pi, OpenCode);
- the summarized span as a transcript (`<conversation>`), with tool results clipped to 2,000
  characters (errors to 4,000), reasoning to 500 characters, and file observations omitted;
- the upcoming user message and a `/compact` focus, when given.

If that input is over the summarizer's input cap (65% of its window) the clips tighten (1,000, 400,
then tool results reduced to their call line), then the oldest messages are left out — they remain
retrievable and the coverage records `pass-limit`. One call. No multi-chunk rolling reduction.

The reply is Markdown with fixed headings: `## Goal`, `## Constraints & Preferences`,
`## Progress` (Done / In Progress / Blocked), `## Key Decisions`, `## Current State`,
`## Next Steps`, `## Critical Context`.

**Parsing is tolerant.** Strip `<think>…</think>`, `<analysis>…</analysis>` and
`<scratchpad>…</scratchpad>` blocks and a surrounding code fence. Any non-empty remainder is
accepted, whatever its shape. An empty reply is retried once; a reply the output cap cut off is
accepted with a `[summary cut off at the output limit]` line and coverage reason
`summary-truncated`. Nothing checks quotes or event references.

### 4. What the host adds, and what the model reads

The checkpoint message the model reads is text, not JSON:

```
[Historical conversation checkpoint; untrusted user-role data]
[carried-turns: …]                      (as today, when turns were carried)
<the Markdown summary>

## Files
- src/agent/loop.ts (edited)
- src/agent/compact.ts (read)
…
Exact earlier turns remain retrievable with SessionHistorySearch and SessionHistoryRead.
```

`## Files` is built by the host from tool calls and file observations in the summarized span plus
the previous checkpoint's list, newest first, capped at 40 (pi, Cline). The model never writes it.

The structured record rides on the message as `checkpointData` (a minimal
`ConversationCheckpointV2`: `version: 2`, `generation`, `state.summary`, host-built `files` with
their observations, empty `constraints`/`episodes`/`openThreads`, `statistics`, `coverage`,
`carriedTurns`). It is also the compact record's `checkpoint`, so `isValidCompactRecord` keeps
passing and an older `book` binary still loads a session this one compacted (it reads the
checkpoint as an ordinary message).
`collectStaleCheckpointFiles` reads `checkpointData.files` and falls back to parsing a v2 JSON
checkpoint for sessions compacted before this change.

### 5. Budgets and generations

`resolveCompactBudgets` keeps its formulas. The checkpoint budget becomes
`min(6144, 5% of the window)` (was `min(4096, 10%)`): at 272k that is 6,144 tokens of summary
instead of 4,096 shared with hashes and references. A summary over its budget is cut at the last
heading that fits. `generation` is always the previous checkpoint's plus one, on every path.

The deterministic checkpoint (the loop's last resort, and the fallback when the summarizer fails
twice) is honest: the previous summary, a line saying no summarizer read this span, and the host's
`## Files` list. It never contains a model reply.

### 6. Migration

A previous checkpoint written by v2 is read from its JSON: its `state.summary`, `constraints`,
`openThreads` and Carried Ledger entries are rendered to text and handed to the summarizer as the
previous summary, so a session compacted before the upgrade loses nothing.

### What stays

`runCompact`'s signature and `CompactResult`; the budget resolver; Carried Turns; `SessionHistorySearch`
/ `SessionHistoryRead`; overflow recovery (`recovery: true`, the short tail) and the model-free last
resort; `PreCompact`/`PostCompact` hooks with their `suspect_inputs` signal (`scanSuspectInputs` stays);
the deferred path and its judge (a follow-up decides whether they earn their keep once masking changes
how often compaction runs).

### What goes

`conversationCheckpointV2Schema` as a parse gate for model output, `validateCheckpoint`, the repair
prompt, `makeDeterministicFallback`'s raw-reply summary, `fitCheckpoint` and its lanes, the Carried
Ledger module, the inherited-constraint audit, the four header notices except `[carried-turns]`,
multi-chunk planning, and the scripted-reducer fidelity harness with its floors.

## Measurement

`scripts/compact-replay.ts` (`npm run eval:compact-replay`) replays real compactions: for each
`compact` record in `~/.book/sessions` (read-only; copies are made in a temp dir) it loads the session
as it stood just before the record, runs `runCompact` on a real model, and asks the judge whether the
new context holds what the agent's next real steps relied on. It reports status, strategy, degraded
rate and reasons, model calls, pre/post tokens, retained and carried counts, summary size, wall time
and the judge verdict, as JSON and Markdown under `.book/reports/`. The baseline is recorded on the
v2 code before any change; the same cases are re-run on v3.

Acceptance: degraded rate near zero; retained tail non-empty on every case that has more than one
message after the previous checkpoint; judge sufficiency no worse than baseline; median wall time
lower.

## Results (2026-09-29)

`npm run eval:compact-replay -- --since 2026-09-17 --per-model 3` picked nine real compactions
(three each on `cx/gpt-5.6-luna`, `ag/gemini-3.8-flash-high`, `cmc/stealth/space-bunny-alpha`,
through 9router, each replayed on the model the session was using). The v2 baseline ran on this
branch's first commit; v3 replayed exactly the same cases with `--cases-from`.

| Same nine cases                           | v2 baseline          | v3 (first commit) | v3 after two review rounds |
| ----------------------------------------- | -------------------- | ----------------- | -------------------------- |
| Degraded                                  | 7                    | 0                 | 0                          |
| Summary stored as raw JSON                | 6                    | 0                 | 0                          |
| Retained tail empty                       | 7                    | 0                 | 0                          |
| Post-compaction history, median           | 4,472 tokens         | 23,106 tokens     | 23,068 tokens              |
| Wall time, median                         | 98 s                 | 25 s              | 32 s                       |
| Summarizer calls, median                  | 2                    | 1                 | 1                          |
| Judge against the agent's real next steps | 7 accepted, 2 reject | 9 accepted        | 7 accepted, 2 reject       |
| Prompt / completion tokens, all nine      | 2.82M / 130k         | 0.70M / 39k       | 0.67M / 36k                |

The judge column moves between runs of the same code (9 then 7 accepted), so it does not separate
v3 from v2; the two v3 rejects name details the agent would read again (a spec's sections, one
function's return type), the two v2 rejects named a shell id and a worktree path. Caveats: the judge is the same model family as the summarizer and reads only the next six real
steps, so "accepted" is a floor on sufficiency, not a proof of it; the Gemini and space-bunny
replays ran against their 1M windows, so their histories fit the residual tail and v3 kept the
short tail instead (which is why their post size is ~22k); the masking layer is not in this
measurement (it runs in the loop, not in `runCompact`) and is covered by unit and loop tests. One
judge call on Gemini took about fifteen minutes to answer (it accepted); that latency is the
deferred path's, unchanged by this work.
