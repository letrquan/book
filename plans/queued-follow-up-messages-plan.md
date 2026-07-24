# Queued Follow-Up Messages

## Goal

Allow a user to press Enter with a follow-up prompt while Book is running a turn. The
prompt is shown as pending input, is not added to the transcript or provider history yet,
and is sent automatically after the current send has completed and released its operation
lease.

This document replaces the earlier queue proposal with the decisions below. The core MVP
described here is now implemented in the TUI, including FIFO dispatch, queue preview, Up recall,
edit/resubmit, Esc cancellation, capacity handling, and interrupt restoration.

## Research Findings

| Product | While busy | Queue visibility and editing | Interrupt/failure behavior | Persistence |
| --- | --- | --- | --- | --- |
| OpenAI Codex | Separates steer messages from FIFO queued follow-up inputs. | Dedicated pending-input preview above the composer; wrapped previews; edit the newest item with Alt+Up (Shift+Left fallback). | Interrupt drains queued items back into the composer in FIFO order instead of auto-running them. | TUI-local queue, separate from transcript/history. |
| Cline | Separates `delivery: "steer"` from `delivery: "queue"`; normal submissions queue when a run cannot start. | Dedicated queued-message panel with IDs, attachment counts, selection, edit, delete, and steer promotion. | Drains one item at a time; failed sends are requeued at the front and draining stops. Abort clears pending prompts. | Runtime queue, not provider transcript until dispatch. |
| OpenHands | SQL-backed pending-message FIFO, primarily protecting delivery while the conversation/WebSocket is unavailable. | Queue position is returned; pending messages are not optimistically rendered in the transcript. | Bounded queue (10); HTTP 429 when full. | Server/database persisted. |
| Claude Code | Enter queues a follow-up while Claude is working; `/btw` also supports an independent side question. | Up recalls the newest queued message into the composer so it can be edited, resubmitted, or cancelled. | Composer-owned cancellation removes the recalled queued message; outside that edit flow, Esc stops the current response/tool call while preserving work. | Pending follow-ups are transient; input history is working-directory scoped. |
| Aider | No comparable active-turn queued-prompt flow found. | Synchronous prompt flow. | N/A. | N/A. |

Sources consulted:

- OpenAI Codex: `codex-rs/tui/src/chatwidget/input_queue.rs`, `input_flow.rs`,
  `input_restore.rs`, and `bottom_pane/pending_input_preview.rs`.
- Cline: `pending-prompt-service.ts`, `local-runtime-host.ts`, and the CLI
  `queued-prompts` component/hook.
- OpenHands: `pending_message_service.py`, `pending_message_router.py`, and the
  frontend send-message hook.
- Claude Code: observed interactive queue behavior plus the documented interrupt and input
  controls at <https://code.claude.com/docs/en/interactive-mode.md>.

The useful common pattern is: keep pending input outside the conversation, preserve the
full submission metadata, drain serially, and make cancellation explicit. Codex's restore
on interrupt is safer for Book than automatically running messages after a cancelled turn;
Cline's requeue-on-dispatch-error is useful, but must be adapted to Book's persistence
boundary.

## Book Constraints and Integration Points

- `src/tui/components/InputBar.tsx` currently treats Enter while `disabled` as an interrupt
  and clears the draft. That behavior must become queue-or-block behavior.
- `src/tui/app.tsx` currently maps send, compaction, rewind, and command resolution into one
  boolean `disabled`. Queue policy needs explicit modes so only an active agent send (and,
  if later chosen, compaction) accepts queued follow-ups.
- `src/session/agent-session.ts` rejects overlapping operations and releases the send lease
  in `send()`'s `finally` block. The queue must stay in the TUI layer; do not make
  `AgentSession` own transient composer state.
- `src/tui/hooks/useAgent.ts` is the authoritative send wrapper. Its returned promise is the
  correct drain boundary. A terminal snapshot can set `isThinking` false before `send()` has
  released its lease, so an effect watching `isThinking` must not start the next queued send.
- User timeline persistence occurs in `AgentSession.recordUserMessage()` during send
  preparation. Queued entries must not call this path until dispatch.
- Existing `/tasks` is intentionally usable while the parent is busy and should remain
  immediate. Modal input suppression and managed-agent surfaces must continue to win over
  queue handling.

## Proposed UX Contract (MVP)

1. Idle: Enter sends immediately, unchanged.
2. Active agent send: the user can keep typing; Enter enqueues the draft and clears only the
   composer draft. It no longer interrupts.
3. The area above `InputBar` shows `Queued follow-up inputs (N)` with FIFO previews. Limit
   the visible preview to a few wrapped lines/items and show an overflow count so narrow
   terminals remain usable.
4. Esc/Ctrl+C remains the explicit interrupt. On interrupt, do not auto-run pending items:
   restore queued text in FIFO order into the composer and append the current draft after it,
   then clear the queue. The in-flight item, if any, is handled by the normal send result and
   is not duplicated.
5. While the agent is busy and the composer is empty, plain Up recalls the newest queued
   item into the composer for editing, matching Claude Code. The item is removed from the
   runnable queue and retained as an `editingQueuedId`. Enter resubmits it with the same ID
   at the tail of the queue; Esc cancels/removes that recalled item and clears the composer
   without interrupting the active turn. When no queued item is available, Up keeps its
   existing prompt-history behavior. Add `/queue clear` as a non-keyboard fallback.
6. Queue capacity is 10 entries. At capacity, keep the current draft and show a local
   non-transcript error; never silently drop input. Do not deduplicate identical prompts in
   v1 because repeated requests can be intentional.
7. Queue is session-scoped and in-memory. It is not written to the timeline, provider
   context, or disk. Clear it on session transition, unmount, or explicit clear; guard every
   dispatch with the session generation/session ID.
8. V1 queues conversational turns and command forms that ultimately become an agent turn.
   `/tasks` and `/queue` management stay immediate. Session-mutating commands (new/resume,
   rewind, exit, settings/modals, managed-agent controls, and other local effects) remain
   blocked while a turn is active rather than being replayed later.

## Data Model and Controller

Add a pure TUI helper, for example `src/tui/queued-inputs.ts`, with no React or session
imports:

```ts
type QueuedInputAction =
  | { type: 'text'; value: string }
  | { type: 'builtin-prompt'; prompt: string; contextMessage?: string }
  | { type: 'custom-command'; command: SlashCommand; rawArguments: string };

interface QueuedInput {
  id: string;
  sessionId: string;
  createdAt: number;
  displayText: string;
  action: QueuedInputAction;
}
```

The controller/reducer should provide `enqueue`, `peek`, `beginDispatch`, `commitDispatch`,
`returnToFront`, `remove`, `recallNewest`, `resubmitRecalled`, `cancelRecalled`, `clear`, and
`restoreText`. Keep at most one `dispatching` entry and one recalled/editing entry. Stable
IDs make previews, editing, removal commands, and logs deterministic.

The entry must retain the action metadata needed to reproduce the original submission, not
just plain text. Snapshot a custom command definition and its arguments; defer shell/body
resolution until dispatch so it does not run side effects while another turn is active.

## Submission and Drain Design

### Split submission modes

Replace the single `disabled` decision passed from `app.tsx` with an explicit policy:

- `submit`: normal Enter dispatch;
- `queue`: active send, with Enter enqueuing a queueable agent-turn action;
- `blocked`: rewind, command resolution, modal ownership, or another state where replaying
  input could target stale state.

Keep `/tasks` and `/queue` management in the immediate-command allowlist. Refactor the
existing `handleSubmit` branching enough to expose a pure classification step before any
side effect. Classification should return `immediate`, `queueable-agent-turn`, or
`blocked`, so queueing does not accidentally execute local commands or interrupt the turn.

### Authoritative serial drain

Drive draining from the promise returned by `useAgent`'s send wrapper, not from
`isThinking` or a render effect:

```text
enqueue(item)
if idle, startDrain()

startDrain:
  if already draining, modal-owned, wrong session, or no item: stop
  item = peek()
  mark item dispatching
  outcome = await dispatch(item)
  if outcome completed:
    commit/remove item
    schedule the next drain after the awaited promise returns
  if outcome cancelled/rejected before preparation:
    return item to the front and stop
  if outcome failed after preparation:
    remove item (the user message is already persisted), surface the error, and stop
```

The send API should expose enough outcome detail for this decision (at minimum completed,
cancelled/rejected-before-prepare, and failed-after-prepare). A boolean `send()` result is
not sufficient. The promise must settle only after `AgentSession.send()` has run its
`finally` and released the operation lease.

Drain again after a normal completed send, after manual compact if compaction is included in
the chosen mode, and after modal/command-resolution suppression ends. Never start two sends
concurrently. If the session generation changes while awaiting, discard the stale drain and
clear the old queue.

### Interrupt and cleanup

- When `editingQueuedId` is set, Esc is composer-owned: cancel the recalled item, clear the
  draft, and leave the active agent turn running. Outside that state, Esc interrupts as today.
- `interrupt()` aborts the active operation, then asks the queue controller to restore only
  pending (not dispatching) items into the draft in FIFO order. If Ctrl+C interrupts while a
  recalled item is being edited, append that live edited draft after the restored FIFO text.
- Add an InputBar draft-change callback or equivalent ref so App can append the live draft to
  the restored text without losing it.
- Clear the queue on `clear()`, session switch, unmount, and explicit `/queue clear`.
- Do not auto-drain after cancellation; the user must press Enter on the restored draft.

## File-Level Work Plan

1. `src/tui/queued-inputs.ts` (new): pure queue types, reducer/controller, capacity and
   restore helpers; unit-test all state transitions and invariants.
2. `src/tui/hooks/useAgent.ts`: return a structured send outcome (or a dedicated
   `sendForQueue` result) that distinguishes rejection/cancellation from post-prepare
   failure and settles after the send lease is released. Add a regression test for the
   snapshot/lease race.
3. `src/tui/components/InputBar.tsx`: replace busy Enter interruption with the explicit
   submission mode; preserve draft on blocked input; expose draft changes; add queue-aware
   placeholder and the empty-composer Up recall path. Give command/file menus first priority,
   then queued recall, then existing prompt history.
4. `src/tui/components/QueuedInputPreview.tsx` (new): render count, FIFO previews, overflow,
   and a clear/edit hint above the composer without adding records to `messages`.
5. `src/tui/app.tsx`: own the queue controller, classify submissions, wire enqueue/clear/edit,
   render the preview, split send/compact/rewind/resolution busy states, and implement the
   serial drain. Keep `/tasks` immediate and local/session-mutating actions blocked.
6. Command handling: add an immediate `/queue` command (`list`, `clear`, and optionally
   `remove <id|index>`); do not add queued actions to the built-in command registry's
   provider prompt/history.
7. Documentation: update `README.md` or `CHANGELOG.md` with the Enter/Esc behavior,
   capacity, interrupt restore semantics, and the `/queue` controls after implementation.

## Test Plan

- `src/tui/queued-inputs.test.ts`: FIFO order, stable IDs, cap/overflow, newest recall,
  resubmit/cancel, remove/clear, restore ordering, dispatch-in-flight protection, and session
  mismatch.
- `src/tui/components/InputBar.test.ts`: Enter in `queue` mode enqueues without calling
  interrupt; blocked Enter preserves the draft; `/tasks` remains immediate; empty-composer Up
  recalls the newest queue item before history; Enter resubmits it; Esc cancels it without
  interrupting; command/file menus and modal suppression still win.
- `src/tui/hooks/useAgent.test.ts` and/or `src/session/agent-session.test.ts`: structured
  outcome mapping, post-prepare failure classification, and proof that the queue callback
  runs after the send operation lease is released.
- `src/tui/app.plan-approval.test.tsx`: busy plain text queues, queue preview renders,
  queueable prompt commands defer, unsafe local commands do not replay, completion drains
  serially, failure pauses/requeues correctly, and interrupt restores FIFO text.
- `src/tui/tui-integration.test.ts`: PTY coverage for Enter while streaming, Up recall,
  edit-and-resubmit, edit-and-cancel without interrupting, Esc/Ctrl+C restore, queue cap/clear,
  and narrow-terminal preview wrapping.

Run focused Vitest tests first, then `npm run typecheck`, `npm run lint`, and the full
`npm test`/PTY suite. Do not include `.book` runtime logs or settings in commits.

## Rollout and Open Decisions

Implement behind a small TUI feature flag only if the first PTY pass exposes terminal
compatibility problems; otherwise ship directly because the queue is transient and does not
alter persisted session formats. Before coding, confirm the exact structured send outcome
shape and whether manual compaction should use `queue` or remain `blocked` (the MVP above
keeps manual compaction blocked; auto-compaction inside a send is covered automatically).
