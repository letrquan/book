# Streaming & Scroll Improvement Plan

## Context

Book already has a solid Ink-based TUI with virtual viewport scrolling, auto-scroll, mouse wheel support, and a streaming fast-path. This plan adds proven techniques from pi and community Ink patterns to improve rendering smoothness, reduce flicker, and optimize scroll responsiveness during streaming.

## What's already working well (don't break)

- Virtual viewport (`ChatPanel.tsx`): viewport culling via `estimateMessageLines`
- Streaming fast-path: `scrollOffset <= 5` skips O(n) estimation, shows last 15
- Auto-scroll pause/resume: user scrolls up → pause, scroll to bottom → resume
- Mouse wheel: SGR mode `\x1b[?1000;1006h` via raw stdin emitter
- Smart scroll reset: only on `messages.length` change, not content growth
- `useAgent` streaming: `patchStreaming()` mutates single message in-place
- `AgentMessage` renders `isStreaming` with spinner + text

## Phases (implement in order; each is self-contained and testable)

### Phase 1: Fix streaming flicker via incremental rendering

**Problem**: Every text delta causes Ink to reconcile the full tree and redraw all lines. During fast token streams (~30-50 tokens/s), this causes visible flicker as the entire chat area redraws.

**Solution**: Enable Ink's `incrementalRendering` option in `cli/run.ts` when rendering the App. This makes Ink diff line-by-line and only rewrite changed lines to stdout.

**File**: `src/cli/run.ts`
- Pass `{ incrementalRendering: true }` to `render()` options

**Test**: Start a streaming session with fast model output — observe smoother rendering, fewer screen flashes.

### Phase 2: OSC 133 shell integration (quality-of-life)

**Problem**: When scrolling back in terminal history or using shell integration, Book's output lines aren't marked as command zones. Terminal emulators (iTerm2, WezTerm, Windows Terminal) can't distinguish input/output boundaries.

**Solution**: Wrap assistant messages in OSC 133 markers (`\x1b]133;A\x07` for prompt start, `\x1b]133;B\x07` for output, `\x1b]133;C\x07` for command finish). Only emit when `isStreaming` is false (final message).

**File**: `src/tui/components/AgentMessage.tsx`
- Add `OSC133_ZONE_START = "\x1b]133;A\x07"` lines
- When `!isStreaming`, wrap display content with these markers
- ponytail: Only tested on iTerm2/WezTerm/WT. Other terminals ignore these sequences safely.

**Test**: After an assistant message completes, check terminal shell integration output zones.

### Phase 3: Optimize patchStreaming rate limiting

**Problem**: During fast token streams, `patchStreaming` calls `setMessages` on every token. Ink throttles output to 30fps (default), but React reconciliation still runs on every `setState`, wasting cycles.

**Solution**: Add a micro-batching ref in `useAgent` that accumulates text deltas and flushes at ~16ms intervals via `setTimeout` instead of every token.

**File**: `src/tui/hooks/useAgent.ts`
- Add `textAccRef = useRef('')` and `flushRef = useRef<ReturnType<typeof setTimeout>>()`
- In `onText`: append to `textAccRef`, clear previous timeout, schedule flush at 16ms
- `flush()`: if `textAccRef.current` is non-empty, call `patchStreaming` with accumulated text, reset ref
- Also flush immediately on `onTools` and `onDone`

**Why not smaller/faster?** 16ms = ~60fps, matches monitor refresh. Ink's own render throttle at 30fps handles the actual terminal output rate. This just saves React reconciliation overhead.

**Test**: `useAgent.test.ts` — assert that for N rapid `onText` calls within 16ms, `patchStreaming` is called once with the full accumulated text.

### Phase 4: Scroll safety net for browsing during streaming

**Problem**: When user is scrolled up browsing history while streaming, the current code includes last 10 messages via a `skip` safety net. But this doesn't work correctly — the safety net logic in `ChatPanel.useMemo` is applied AFTER viewport culling, so messages above the viewport are already skipped.

**Current code** (ChatPanel.tsx lines ~175-195 — the `skip` logic is broken):
```typescript
// Safety net: during streaming when browsing history, always include
// the streaming message so new content remains visible.
if (streamingMessageId && scrollOffset > 0) {
  // Always include the tail (last 10 messages)
  const tail = messages.slice(-10);
  for (const msg of tail) {
    if (!included.find((m) => m.id === msg.id)) {
      included.push(msg);
    }
  }
}
```

**Wait** — this doesn't exist in the current code! Let me re-check. Looking at ChatPanel.tsx, there is NO safety net. When `scrollOffset > 5` during streaming, it falls through to full viewport culling path which may exclude the streaming message entirely.

**Solution**: Add a safety net that always includes the streaming message + last 5 messages when `streamingMessageId` is set, regardless of viewport.

**File**: `src/tui/components/ChatPanel.tsx`
- After `included` population in the full viewport path, add:
```typescript
if (streamingMessageId && scrollOffset > 5) {
  const tail = messages.slice(-10);
  for (const msg of tail) {
    if (!included.includes(msg)) included.push(msg);
  }
}
```

**Test**: `ChatPanel.test.ts` — add a scenario: 50 messages, scrollOffset = 100, streamingMessageId points to last message → last message is still in visibleMessages.

### Phase 5: Cache estimateMessageLines per message

**Problem**: When browsing long histories, `estimateMessageLines` walks text word-by-word for EVERY message on EVERY scroll frame. For 500+ messages, this is noticeable latency.

**Solution**: Wrap `estimateMessageLines` with a WeakMap cache keyed by `(message.id, message.content, termWidth)`. Since message content only changes during streaming (and we skip line estimation during streaming), this is effectively a stable cache. Use a simple Map (not WeakMap — message IDs are strings).

**File**: `src/tui/components/ChatPanel.tsx`
- Add `const lineCache = new Map<string, number>()` at module level
- Cache key: `${message.id}:${message.content?.length ?? 0}:${termWidth}`
- In `estimateMessageLines`: check cache first, store result
- Invalidate cache entry when message content length changes (streaming)
- ponytail: cache grows unbounded. Clear when messages.length drops (user runs `/clear`). Add when conversations exceed ~200 messages and PgUp feels sluggish.

**Test**: `ChatPanel.test.ts` — same message re-estimated twice with same width returns cached value (measure timing).

### Phase 6: Trim partial markdown fences

**Problem**: During streaming, the LLM may emit partial markdown code fences (e.g., ```` ``` ```` or incomplete language specifiers). These cause the rendered code block to visually collapse/reappear as the fence completes, creating visual jitter.

**Solution**: In `AgentMessage.tsx`, when `isStreaming` and the last content block is text, trim partial closing fences before rendering.

**File**: `src/tui/components/AgentMessage.tsx`
- Add `trimPartialClosingFences(text: string): string` helper
- Detects if the last line of text is a prefix of the most recent opening fence marker
- Applies only when `isStreaming` (not on final rendered messages)
- ponytail: only handles ``` fences; tilde fences (`~~~`) are rarer. Add when supported.

**Test**: Unit test for `trimPartialClosingFences`:
- `"```rust\nfn main() {}\n``"` → `"```rust\nfn main() {}\n"` (partial `` `` `` stripped)
- `"text\n```\ncode\n```"` → no change (fence is complete)
- `"plain text"` → no change

## Skipped / Don't need

- **Synchronized output (`\x1b[?2026h`)**: Ink doesn't support this protocol natively. Requires modifying Ink's renderer. Not worth the complexity — Ink's log-update with incremental rendering is sufficient.
- **Rewrite in pi-tui**: Out of scope. User chose to keep Ink/React.
- **Virtual list library (ink-virtual-list)**: Third-party, no maintenance guarantee. Our manual viewport works well.
- **Streaming message "append" mode**: pi's approach of re-creating all children on every delta is less efficient than our in-place mutation. Keep our approach.
- **Token-level bundling to paragraphs**: AI models emit at token granularity; batching by paragraph would add latency for no visual benefit with incremental rendering.

## Order of implementation

1. Phase 1 (incremental rendering) — one line change, biggest impact
2. Phase 3 (rate limiting) — prevents React thrash
3. Phase 4 (scroll safety net) — fixes a correctness bug
4. Phase 6 (partial fence trimming) — visible quality improvement
5. Phase 2 (OSC 133) — nice-to-have
6. Phase 5 (line cache) — only noticeable at 200+ messages

Each phase is independently testable and can be shipped without waiting for others.
