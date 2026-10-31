# Mid-turn input plan (steering)

Status: **decided 2026-10-31**: the owner took the recommendations in §6. Tracked in #661.

The problem: a prompt typed while Book is working waits in the follow-up queue until the whole
run ends. A run can be many minutes of tool calls. A correction such as "stop, use the other
file" therefore arrives after the agent has finished the wrong thing.

Claude Code and Codex both deliver such a message at the next tool-call boundary, inside the run
that is already going. Both also have a "send now" that cuts the current model request short.
This plan brings both to Book.

## 1. How Book handles it today

| Fact                                                                                                                                                                                                                                                                                                                                         | Where                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| While the agent is busy, Enter resolves to `queue` through `submissionMode`, and `onQueue` adds the text to the follow-up queue (at most 10).                                                                                                                                                                                                | `resolveSubmissionAction`, `src/tui/components/InputBar.tsx:344`; `enqueueFollowUp`, `src/tui/app.tsx:869`; `src/tui/queued-inputs.ts` |
| The queue is shown above the composer as "Queued follow-up inputs". Each entry is sent as a **new run** after the current run ends.                                                                                                                                                                                                          | `src/tui/components/QueuedInputPreview.tsx`                                                                                            |
| `runAgentLoop` takes one user message. A run has no input channel.                                                                                                                                                                                                                                                                           | `src/agent/loop.ts:278`                                                                                                                |
| **The loop already appends user messages mid-run**: the work-state refresh at the top of an iteration, and the continuation prompt at the end-of-turn gate. Both go to `callbacks.onUserMessageAppended`, and `AgentSession` persists them as `user` records with `derivedContent: true`. The record has no attachments and no display text. | `loop.ts:1371–1389`, `loop.ts:3862–3876`; `src/session/agent-session.ts:1607`                                                          |
| Tool results ride on the assistant `Message` (`toolResults`). The boundary between tool steps is right after `newHistory.push(assistantMessage)`, before the next iteration's `turn++`.                                                                                                                                                      | `loop.ts:3756`, `loop.ts:1352`                                                                                                         |
| **The Anthropic adapter sends a plain user message after tool results as a second, consecutive user message.** It merges plain text only into a previous plain user message, never into a `tool_result` message. The work-state refresh already produces this shape in production.                                                           | `convertMessages`, `src/provider/anthropic.ts:308–345`                                                                                 |
| The `<session-state>` block attaches to the newest user message that has none, and is memoized. A user message added mid-run therefore gets a fresh block, as the work-state refresh does.                                                                                                                                                   | `ensureSessionState`, `src/agent/context.ts:676–738`                                                                                   |
| The provider stream gets the run-wide `signal`. An abort mid-stream records the partial assistant message with cancelled tool results, then **ends the run** (`break`). There is no abort scoped to one request.                                                                                                                             | `loop.ts:1747`; `loop.ts:2541–2571`                                                                                                    |
| Everything Book does to a prompt happens once, before the run: `UserPromptSubmit` hooks, `@file` expansion, intent routing (the `intentRouted` latch), `$skill` invocation (`skillRegistry.beginRun(typedText)`).                                                                                                                            | `loop.ts:528–565`; `agent-session.ts:1084`; `loop.ts:1396`; `loop.ts:583`                                                              |
| `/rewind` targets are checkpoint records, keyed on the run's `userEventId`.                                                                                                                                                                                                                                                                  | `src/session/store.ts:580–606`                                                                                                         |
| Messages from other sessions (#620) are delivered only while the session is idle, as `peer-message` turns. Their permission class (`peerTurnClass`) applies to the whole run.                                                                                                                                                                | `src/messaging/delivery.ts:5`; `loop.ts` options                                                                                       |
| Print mode with `--input-format stream-json` reads stdin to the end before running anything. The SDK `query()` takes one prompt.                                                                                                                                                                                                             | `src/headless.ts:800–822`; `src/sdk.ts:89`                                                                                             |
| Keys: Shift+Enter and Ctrl+J insert a newline. Tab on an empty prompt cycles agent focus. Alt-modified keys are dropped in the composer. Esc cancels the run.                                                                                                                                                                                | `InputBar.tsx:663–665`, `InputBar.tsx:654`, `InputBar.tsx:529`                                                                         |
| Ink 7 can enable the kitty keyboard protocol (the `kittyKeyboard` render option, opt-in). Book's `render()` does not pass it, so in most terminals **Ctrl+Enter arrives as plain Enter**.                                                                                                                                                    | `node_modules/ink/build/render.d.ts:90`; `src/cli/run.ts:524`                                                                          |

## 2. How Claude Code 2.1.314 and Codex 0.163.0 do it

Observed in the shipped binaries on 2026-10-30. Claude Code's JavaScript was extracted from the
Bun `.bun` section, whose payload starts 8 bytes into the section. REA's JavaScript graph tools
found no module structure in the minified chunks, so the chunks were read directly. Codex was
read from strings only; its source is public and was not consulted.

### 2.1 Claude Code

- **Keys** (`chunk-36thvyma.js`, binding table near offset 247550347 of the binary):
  - `enter` is `chat:submit`;
  - `ctrl+enter` and `ctrl+x ctrl+s` are `chat:sendNow`;
  - `ctrl+x enter` is `chat:queueSubmit`.
    The `ctrl+x ctrl+s` chord exists, by inference, for terminals that cannot report Ctrl+Enter.
- **Enter while running.** The message goes into the message queue with the default priority
  `"next"` (the enqueue in `chunk-d15g4bxk.js`, `priority:Ar.priority??"next"`). The UI lists it
  under "Waiting to be delivered".
- **Delivery at the tool boundary.** In the query loop (`chunk-hnnn2zb7.js` @229877), after each
  tool step it takes `messageQueue.getCommandsByMaxPriority("next")` and builds attachments with
  `afterToolStep:!0`. Each queued prompt becomes a `queued_command` attachment
  (`getQueuedCommandAttachments`, `chunk-d15g4bxk.js` @3317365). It goes out in the very next
  request, after the tool results.
  - Prompt-submit hooks run on each delivered prompt (`ty(Pe?.promptSubmitted,Me)`).
  - Only `mode==="prompt"` entries (and task notifications) are folded this way. Slash commands
    and `!` shell commands wait.
  - The hook for a pre-fold wait (`zl`) is an empty function in this build.
- **Send now** (`eZt` and `wi`, `chunk-y6nca1tc.js`; feature name `input_low_latency_submit`)
  re-checks every 200 ms (`yi=200`) and decides:

  | State                                                          | Action                                 |
  | -------------------------------------------------------------- | -------------------------------------- |
  | a dialog is open                                               | wait                                   |
  | the turn is compacting                                         | wait                                   |
  | running tools that can move to the background (shells, agents) | move them, then deliver                |
  | running tools that cannot move                                 | wait 2 checks (`Qn=2`), then interrupt |
  | the model is sampling                                          | interrupt now                          |

  Interrupting raises the entry to priority `"now"` (`promoteToNow`). `_abortOnNowPriorityCommand`
  then aborts the in-flight request with the reason `interrupt`, and the turn goes on with the
  message. With the feature off, send-now falls back to cancelling the turn and sending
  (`Okt`/`Lkt`, `chunk-36thvyma.js` @1480860).

- **Ctrl+X Enter** passes `wait:true` into the submission. What `wait` changes was **not traced**
  (§7).

### 2.2 Codex

- **Enter is "steer".** The pending list reads "Messages to be submitted after next tool call",
  with a hint "… to interrupt and send immediately".
- **Tab queues.** That list reads "Messages to be submitted at end of turn".
- **The core** keeps an input queue (`core/src/session/input_queue.rs`). The turn loop checks
  `has_pending_input` and sets `needs_follow_up`. The app server exposes `turn/steer`, which fails
  with `ActiveTurnNotSteerable`.
- **The base prompt** says: "The user may send messages while you are working. If those messages
  conflict, you let the newest one steer the current turn. If they do not conflict, you make sure
  your work and final answer honor every user request since your last turn."

## 3. Proposed design

### 3.1 What the user sees

- **Enter while the agent works sends a steer** (D1). The text appears above the composer under
  "Sends after the current tool call". When it is delivered, it leaves that list and appears in
  the transcript as a user row, at the point the model received it.
- **Queue-to-end key** (D2): sends the message only after the run ends, as Enter does today. The
  list is labelled "Queued for when this run ends".
- **Send now** (D4): delivers the pending steers immediately, if the model is generating.
- **These stay queued for the end of the run, as today:**
  - slash commands;
  - `!` shell commands;
  - anything typed while a permission or question dialog owns the composer.
- **Editing**: Up recalls the newest pending steer, as it recalls a queued input today.
- **If the model ends the run** while a steer is pending, the run continues with the steer
  (D3).
- **If the run is cancelled** with steers undelivered, they move to the end-of-run queue in its
  paused state (D6). The existing "Queue paused" notice says what to do.

### 3.2 The loop: a steering inbox

- **New option** `runAgentLoop(..., options.steering)`. The host owns it; there is no module
  state:
  - `take(): SteeredInput[]` returns and removes what is pending;
  - `hasPending(): boolean`;
  - `requestNow(): void` (§3.3).
- **Two drain points:**
  - _After a tool step_: at the top of the next iteration, next to the work-state refresh and
    before `ensureSessionState`. Nothing is drained between tool calls of one batch.
  - _At the end-of-turn gate_ (`loop.ts:3834`): if steers are pending and the run was not
    aborted, append them and continue the same run. The continuation decision is skipped, and
    `continuationCount` resets, because the user has spoken.
- **Each steer becomes a `Message`:**
  - `role: 'user'`, `kind: 'conversation'`, `includeInContext: true`;
  - **no `derivedContent`**: these are the user's own words, for the ledger and Carried Turns;
  - a marker (`steered: true`) for transcript rendering and diagnostics;
  - the host-assigned id, attachments and display text.

  It reaches `onUserMessageAppended`. `AgentSession` persists it with its attachments and typed
  text, so a resumed session shows it.

- **What the pre-run path does to a prompt, applied to a steer** (D7):

  | Step                     | Proposal                                                                                                                                         |
  | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `UserPromptSubmit` hooks | Run at drain time. A block drops the steer with a transcript notice; a rewrite replaces it.                                                      |
  | `@file` expansion        | Run at submit time in a new `AgentSession.steer()`, through `expandUserInputDetailed`. The loop receives resolved content and file observations. |
  | Intent routing           | Run on the steer's typed text, so a URL in a correction still loads WebFetch.                                                                    |
  | `$skill` by name         | Not in v1. `beginRun` is per run, so a `$name` in a steer stays plain text. Documented.                                                          |
  | Memory capture           | Same as a typed prompt.                                                                                                                          |
  | `/rewind` target         | Not in v1. A steer writes no checkpoint, so rewinding targets the run's prompt.                                                                  |

- **Run limits**: a steer extends the same root run. Its turns count against `maxTurns` and the
  USD cap, and it mints no new root.
- **Anthropic message shape**: `convertMessages` should append a plain user message that follows
  a `tool_result` message as `text` blocks after the `tool_result` blocks, in the same message.
  That is the documented shape. It also tidies what the work-state refresh sends today. The moving
  cache marker then lands on the merged message's last block. The OpenAI chat and Responses paths
  already allow a user message after tool output; a contract test pins all three.
- **System prompt**: one kernel line, worded like Codex's. It tells the model that user messages
  can arrive between tool calls, that the newest conflicting one wins, and that the final answer
  must cover every request since the run began. This bumps `SYSTEM_PROMPT_VERSION`
  (`book-system-prompt-v8`), which costs one cache write per session (D8).
- **Cache**: a steer is appended at the tail, so the cached prefix is unchanged. Its fresh
  `<session-state>` block is the same per-turn cost the work-state refresh already pays.

### 3.3 Send now

- **A per-request abort**: `provider.stream` gets `AbortSignal.any([signal, step.signal])`, built
  fresh for each request. `requestNow()` aborts only the step controller, with the reason
  `steer`.
- **Aborting the step keeps the run going.** The step abort takes the `cancelledMessage` path at
  `loop.ts:2541`, with three changes:
  - tool calls that never started are marked `superseded_by_user`, not "Agent execution was
    interrupted";
  - unsigned partial reasoning is dropped, because Anthropic cannot replay a thinking block
    without its signature;
  - the loop drains the steers and continues instead of `break`.
- **While tools run, nothing is killed** (D5). Send-now waits for the batch to finish, which is
  where a steer lands anyway. The pending row says "after the running tool". Moving a long
  foreground Bash to the background, as Claude Code does, is a possible later step.

### 3.4 Keys (D2, D4)

| Action                       | Proposal                                                                 | Note                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steer                        | Enter while busy                                                         | Flip `resolveSubmissionAction` from `queue` to `steer` for plain prompts.                                                                                                                                  |
| Queue for the end of the run | Tab with text in the composer                                            | Codex's key. Tab on an empty prompt keeps cycling agent focus. Tab with text appears unbound in normal mode; confirm `InputBox` does not use it.                                                           |
| Send now                     | Ctrl+Enter where the terminal reports it, plus a chord that always works | Ctrl+Enter needs the kitty keyboard protocol. Enabling `kittyKeyboard` changes how every key is reported, so it is its own change with its own TUI check. The chord is Claude Code's `ctrl+x ctrl+s` (D4). |
| Esc                          | Unchanged: cancel the run                                                | Codex uses Esc to interrupt and send. Book's Esc stays a cancel, so a user's habit does not send a half-typed correction.                                                                                  |

### 3.5 Out of scope

- **Print mode and the SDK.** stream-json input is read to the end before the run starts. Live
  steering there needs a streaming reader, so it is a later PR.
- **Subagents and managed-agent children.** The detail view already sends to a child through
  `managedAgents.send`.
- **Peer messages mid-run.** A peer turn's permission class applies to the whole run. Folding a
  peer message into a run the user started would let it act under the user's mode. Idle-only
  delivery stays. The steering inbox could carry peer messages later, with its own gate.

## 4. PRs

1. **Loop inbox and delivery.** No new UI: the TUI keeps queueing until PR 2.
   - `options.steering` and `AgentSession.steer()`;
   - the two drain points, the `Message` shape and its persistence (attachments, typed text);
   - hooks, expansion and intent routing on steers;
   - the `convertMessages` merge;
   - the kernel line and the `SYSTEM_PROMPT_VERSION` bump.

   Tests use `src/test/scripted-provider`:
   - a steer taken during a tool batch is in request N+1, after the tool results, and never
     before them;
   - a steer during the final answer continues the same run;
   - a hook block drops the steer, and a hook rewrite replaces it;
   - a reload shows the steer in place;
   - cache breakpoints stay at 3.

2. **TUI steering.**
   - Enter steers; Tab queues.
   - The two-section preview; Up recalls and edits a pending steer.
   - Delivered steers render as transcript rows.
   - Cancel moves undelivered steers to the paused queue.
   - Docs: the keys and queue sections of the guide, `CHANGELOG.md`, and the README if the preview
     appears there.
   - Watched in the real TUI with the run-book PTY driver and a mock provider whose tool sleeps.
3. **Send now.**
   - The per-request abort and the step-abort path that continues the run.
   - The send-now chord, plus Ctrl+Enter under the kitty protocol if D4 enables it. The kitty
     change could also be its own PR.
   - Tests: an abort mid-stream yields the partial message, then the steer, in the next request;
     Anthropic replay stays valid after an aborted thinking block.
4. **Optional, later:** live stream-json steers in print mode, and an SDK input channel.

## 5. Verification

- **Unit**: the loop with the scripted provider, as listed under PR 1. The provider conversion of
  an assistant tool-call message, its results and a following user message is covered for
  Anthropic, OpenAI chat and the Responses API.
- **Cache**: the cached prefix bytes are identical before and after a steer, and
  `countCacheBreakpoints` stays 3.
- **TUI**, following the run-book mandate:
  1. Type during a slow tool.
  2. See the pending row.
  3. See it delivered after the tool.
  4. See the model answer it.

  Then repeat with send-now while the model streams text.

## 6. Owner decisions

Decided 2026-10-31: the owner took every recommendation, and chose Book to write the code (D9).

|     | Question                                                                                        | Decision                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Enter while the agent works: steer (Claude Code, Codex) or keep queueing?                       | Steer                                                                                                                          |
| D2  | Key that queues for the end of the run                                                          | Tab with text (Codex)                                                                                                          |
| D3  | A steer pending when the model ends the run: continue the same run, or start a new one?         | Continue the same run                                                                                                          |
| D4  | Send-now key: enable the kitty protocol for Ctrl+Enter, and which always-available chord?       | Chord first, Claude Code's `ctrl+x ctrl+s` (neither key is bound in Book's TUI today; PR 3 confirms). Kitty is its own change. |
| D5  | Send now while tools run: wait for the batch, or move a long Bash to the background or kill it? | Wait (v1)                                                                                                                      |
| D6  | Undelivered steers on cancel: paused queue, back into the composer, or dropped?                 | Paused queue                                                                                                                   |
| D7  | Hooks, `@file` expansion and intent routing on steers? `$skill` and rewind points in v1?        | Hooks, expansion and routing yes; `$skill` and rewind no                                                                       |
| D8  | Add the kernel line (bumps `SYSTEM_PROMPT_VERSION`)?                                            | Yes                                                                                                                            |
| D9  | Who codes: Claude agents or Book                                                                | Book (built by running Book, per the run-book skill)                                                                           |

## 7. Unknowns

- What Claude Code's `wait:true` (Ctrl+X Enter) changes downstream. It reaches the
  `prompt.submit` hook payload; its effect on the queue was not traced.
- The exact text Claude Code wraps a `queued_command` in for the model was not extracted.
- Codex's mechanics come from strings only. Its source (`core/src/session/input_queue.rs`) was not
  read.
- Whether `InputBox` consumes Tab when the composer has text (`InputBox.tsx:202` lists Tab among
  keys it passes over).
- How the transcript renders a user row in the middle of a streaming turn. `useAgent` never
  consumes `onUserMessageAppended` today; only `AgentSession` does.
- Whether every OpenAI-compatible server Book is used with accepts a user message directly after
  tool output. The work-state refresh suggests so, but no test pins it.
