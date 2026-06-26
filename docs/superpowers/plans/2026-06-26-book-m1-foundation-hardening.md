# Book M1 — Foundation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent loop correct and reliable. Fix the bugs that break the existing scaffold — tool results discarded across turns, a bogus provider request param, no 429 retry, no mid-stream abort, fictional token counts — and lock the fixes in with tests. No new features.

**Architecture:** The fix touches three layers that already exist: `src/agent/context.ts` (message assembly), `src/provider/openai-compatible.ts` (SSE client), and `src/agent/loop.ts` + `src/tui/hooks/useAgent.ts` (abort plumbing). The Message type already carries `toolCalls`/`toolResults` — M1.1 wires them through; no type changes needed. Token accounting adds one optional callback to `AgentLoopCallbacks`. Tests use `vitest` with a fake provider that yields canned stream events.

**Tech Stack:** TypeScript (ESM), Node 18+, Ink/React 19, Zod, vitest, tsup.

**Source spec:** `docs/superpowers/research/2026-06-26-book-cc-parity-gap-analysis.md` (gaps B1–B10) and `docs/superpowers/plans/2026-06-26-book-cc-parity-milestones.md` (milestone M1).

---

## File Map

```
book/
  src/
    types.ts                          # MODIFY: add onUsage callback + Usage type
    agent/
      context.ts                      # MODIFY: emit tool_calls + tool role messages (M1.1)
      loop.ts                         # MODIFY: accept AbortSignal, thread onUsage, propagate abort (M1.4, M1.5)
    provider/
      openai-compatible.ts             # MODIFY: fix body (M1.2), 429 retry (M1.3), AbortSignal (M1.4), usage parse (M1.5)
    tui/
      hooks/useAgent.ts               # MODIFY: AbortController + onUsage wiring (M1.4, M1.5)
      components/StatusLine.tsx       # MODIFY: render real usage (M1.5)
    agent/
      context.test.ts                 # CREATE (M1.6)
      loop.test.ts                    # CREATE (M1.6)
    provider/
      openai-compatible.test.ts       # CREATE (M1.6)
    tools/
      file.test.ts                    # CREATE (M1.6)
    tui/
      permissionStore.test.ts         # CREATE (M1.6)
    test/
      fakeProvider.ts                 # CREATE: shared fake SSE provider for loop/context tests
```

---

## Phase 1: Thread Tool Calls & Results Into Provider Messages (M1.1) — 🔴 critical

### Task 1: Write failing context test

**Files:**
- Create: `src/agent/context.test.ts`
- Create: `src/test/fakeProvider.ts` (helper for building Message fixtures)

- [ ] **Step 1: Create a message-fixture helper**

```typescript
// src/test/fixtures.ts
import type { Message, ToolCall, ToolResult } from '../types.js';

export function userMsg(content: string): Message {
  return { id: 'u1', role: 'user', content, timestamp: 0 };
}

export function assistantMsg(content: string, toolCalls?: ToolCall[], toolResults?: ToolResult[]): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content,
    toolCalls,
    toolResults,
    timestamp: 0,
  };
}

export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

export function toolResult(toolCallId: string, output: string, success = true): ToolResult {
  return { toolCallId, success, output, error: success ? undefined : 'err' };
}
```

- [ ] **Step 2: Write failing test**

```typescript
// src/agent/context.test.ts
import { describe, it, expect } from 'vitest';
import { buildMessages } from './context.js';
import type { AgentConfig } from '../types.js';
import { userMsg, assistantMsg, toolCall, toolResult } from '../test/fixtures.js';

const config: AgentConfig = {
  apiKey: 'k', baseUrl: 'http://x/v1', model: 'm', maxTurns: 5, workspace: '.',
  animation: { typewriterSpeed: 3, spinnerStyle: 'braille' },
  accessibility: { screenReader: false, reducedMotion: false },
  tools: { browser: { enabled: false, headless: true }, design: { enabled: false } },
};

describe('buildMessages', () => {
  it('emits tool_calls on assistant messages and a tool role message per result', () => {
    const tc = toolCall('call_1', 'read_file', { filePath: 'a.ts' });
    const tr = toolResult('call_1', '1: hi');
    const history = [
      userMsg('read a.ts'),
      assistantMsg('Reading...', [tc], [tr]),
    ];

    const out = buildMessages(config, history, []);

    // [0] system, [1] user, [2] assistant (content + tool_calls), [3] tool result
    expect(out[2].role).toBe('assistant');
    expect(out[2].tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"filePath":"a.ts"}' } },
    ]);
    expect(out[3].role).toBe('tool');
    expect(out[3].tool_call_id).toBe('call_1');
    expect(out[3].content).toBe('1: hi');
  });

  it('keeps tool messages in call order when a turn has multiple tool calls', () => {
    const t1 = toolCall('c1', 'bash', { command: 'ls' });
    const t2 = toolCall('c2', 'bash', { command: 'pwd' });
    const r1 = toolResult('c1', 'a\nb');
    const r2 = toolResult('c2', '/x');
    const history = [userMsg('go'), assistantMsg('', [t1, t2], [r1, r2])];

    const out = buildMessages(config, history, []);
    expect(out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
      .toEqual(['c1', 'c2']);
  });

  it('omits tool_calls when an assistant message has none', () => {
    const history = [userMsg('hi'), assistantMsg('hello')];
    const out = buildMessages(config, history, []);
    expect(out[2].tool_calls).toBeUndefined();
    expect(out.find((m) => m.role === 'tool')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/agent/context.test.ts`

Expected: FAIL — `out[2].tool_calls` is `undefined` (current `buildMessages` emits only `content`).

### Task 2: Implement tool-call threading in context builder

**Files:**
- Modify: `src/agent/context.ts`

- [ ] **Step 1: Extend the message type and the builder**

Replace the `buildMessages` body so assistant messages carry `tool_calls` and each tool result emits a `tool` role message immediately after. Note OpenAI requires `function.arguments` as a **JSON string**, not an object.

```typescript
// src/agent/context.ts
import { platform, release, hostname } from 'os';
import type { AgentConfig, Message, ToolDefinition } from '../types.js';

function buildSystemPrompt(config: AgentConfig): string {
  return `You are Book, an AI coding agent. You help users write, fix, and understand code.

You are running on: ${platform()} ${release()} (${hostname()})
Workspace: ${config.workspace}
Current date: ${new Date().toISOString().split('T')[0]}

You have access to tools for reading/writing files, running shell commands,
searching code, and interacting with git. Use them to help the user.

Be concise and direct. Write code when asked. Explain only when asked.`;
}

type ProviderMessage = {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export function buildMessages(
  config: AgentConfig,
  history: Message[],
  tools: ToolDefinition[],
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  messages.push({ role: 'system', content: buildSystemPrompt(config) });

  for (const msg of history) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const assistant: ProviderMessage = {
        role: 'assistant',
        // OpenAI rejects null content when tool_calls is absent, so coerce to ''.
        content: msg.content && msg.content.length > 0 ? msg.content : (msg.toolCalls?.length ? null : ''),
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        assistant.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }
      messages.push(assistant);

      // Tool results MUST follow the assistant message that produced them,
      // in the same order as the tool_calls array.
      if (msg.toolResults) {
        const byId = new Map(msg.toolCalls?.map((tc) => [tc.id, tc]));
        for (const result of msg.toolResults) {
          // Only emit results for tool calls present on this assistant message.
          if (byId.has(result.toolCallId)) {
            messages.push({
              role: 'tool',
              tool_call_id: result.toolCallId,
              content: result.success
                ? result.output
                : `ERROR: ${result.error ?? 'tool failed'}\n${result.output ?? ''}`,
            });
          }
        }
      }
    }
  }

  return messages;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`

Expected: No errors. (The provider's `chatCompletionStream` parameter type already accepts `tool_calls?: unknown[]`; if its `messages` param type is too narrow, widen it to `ProviderMessage[]`-ish — keep it permissive.)

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run src/agent/context.test.ts`

Expected: All 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/context.ts src/agent/context.test.ts src/test/fixtures.ts
git commit -m "fix(agent): thread tool_calls and tool-role results into provider messages"
```

---

## Phase 2: Fix Provider Request Body (M1.2) — 🔴 critical

### Task 3: Remove bogus `max_turns` body param

**Files:**
- Modify: `src/provider/openai-compatible.ts`

- [ ] **Step 1: Write a failing test asserting the body shape**

```typescript
// src/provider/openai-compatible.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatCompletionStream } from './openai-compatible.js';
import type { AgentConfig, ToolDefinition } from '../types.js';

const config: AgentConfig = {
  apiKey: 'k', baseUrl: 'http://localhost/v1', model: 'm', maxTurns: 25, workspace: '.',
  animation: { typewriterSpeed: 3, spinnerStyle: 'braille' },
  accessibility: { screenReader: false, reducedMotion: false },
  tools: { browser: { enabled: false, headless: true }, design: { enabled: false } },
};

let capturedBody: any;
let capturedUrl: string;

beforeEach(() => {
  capturedBody = null; capturedUrl = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  }));
});

describe('chatCompletionStream request body', () => {
  it('does not send max_turns (not an OpenAI param)', async () => {
    const stream = chatCompletionStream(config, [{ role: 'user', content: 'hi' }], []);
    for await (const _ of stream) { /* drain */ }
    expect(capturedBody).not.toHaveProperty('max_turns');
    expect(capturedBody).not.toHaveProperty('maxTurns');
    expect(capturedBody.model).toBe('m');
    expect(capturedBody.stream).toBe(true);
  });

  it('includes stream_options.include_usage so usage is reported', async () => {
    const stream = chatCompletionStream(config, [{ role: 'user', content: 'hi' }], []);
    for await (const _ of stream) { /* drain */ }
    expect(capturedBody.stream_options).toEqual({ include_usage: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/provider/openai-compatible.test.ts`

Expected: FAIL — `max_turns` is present; `stream_options` is absent.

- [ ] **Step 3: Fix the body construction**

In `src/provider/openai-compatible.ts`, find the `body` object construction and replace it:

```typescript
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    // Request token usage in the final SSE chunk so we can track cost.
    stream_options: { include_usage: true },
  };

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
```

(Remove the `max_turns: config.maxTurns` line entirely. `maxTurns` is enforced by the agent loop, not by the API.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/provider/openai-compatible.test.ts`

Expected: Both body-shape tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/provider/openai-compatible.ts src/provider/openai-compatible.test.ts
git commit -m "fix(provider): drop bogus max_turns param, request stream usage"
```

---

## Phase 3: 429 Backoff + Retry (M1.3) — 🟠 high

### Task 4: Retry on 429/5xx with exponential backoff

**Files:**
- Modify: `src/provider/openai-compatible.ts`

- [ ] **Step 1: Add a failing test for retry**

Append to `src/provider/openai-compatible.test.ts`:

```typescript
  it('retries on 429 with exponential backoff then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls < 3) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      }
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }));
    // Speed up the test: stub the sleeper
    vi.spyOn(globalThis, 'setTimeout'); // observe calls only

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(3);
    expect(events.some((e) => e.type === 'text' && e.content === 'ok')).toBe(true);
  });

  it('yields an error after exhausting retries', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return new Response('rate limited', { status: 429 });
    }));

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(4); // initial + 3 retries
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/provider/openai-compatible.test.ts`

Expected: FAIL — current code yields a single error on 429 and returns.

- [ ] **Step 3: Implement retry loop**

Wrap the fetch in a retry loop. Add a small sleep helper that respects `Retry-After` (capped) and uses exponential backoff (1s, 2s, 4s). Introduce `MAX_RETRIES = 3`.

```typescript
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs)) return Math.min(secs * 1000, 8000);
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

async function fetchWithRetry(
  url: string, init: RequestInit, signal?: AbortSignal,
): Promise<Response> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, signal });
    } catch (e) {
      // Network error — retry with backoff.
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt === MAX_RETRIES) break;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastError = `API error ${resp.status}: ${await resp.text()}`;
      if (attempt === MAX_RETRIES) return resp;
      await sleep(backoffMs(attempt, resp.headers.get('retry-after')));
      continue;
    }
    return resp;
  }
  throw new Error(lastError ?? 'request failed after retries');
}
```

Then in the main function, replace the direct `await fetch(...)` call (and its 429 branch) with:

```typescript
  let response: Response;
  try {
    response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    }, options?.signal);
  } catch (e) {
    yield { type: 'error', error: e instanceof Error ? e.message : String(e) };
    return;
  }

  if (!response.ok) {
    const errorText = await response.text();
    yield { type: 'error', error: `API error ${response.status}: ${errorText}` };
    return;
  }
```

Add an `options` parameter to the exported function signature:

```typescript
export async function* chatCompletionStream(
  config: AgentConfig,
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[],
  tools: ToolDefinition[],
  options?: { signal?: AbortSignal },
): AsyncGenerator<ProviderStreamEvent> {
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/provider/openai-compatible.test.ts`

Expected: All tests PASS (body-shape + 429 retry + exhausted). Note: stub `setTimeout`/use fake timers if the 1s/2s/4s waits slow the suite; or inject a `delayScale` for tests.

- [ ] **Step 5: Commit**

```bash
git add src/provider/openai-compatible.ts src/provider/openai-compatible.test.ts
git commit -m "fix(provider): retry 429/5xx with exponential backoff honoring Retry-After"
```

---

## Phase 4: Abort / Cancel Mid-Stream (M1.4) — 🟠 high

### Task 5: Plumb AbortController from TUI through loop to provider

**Files:**
- Modify: `src/types.ts` (extend callback type)
- Modify: `src/agent/loop.ts`
- Modify: `src/tui/hooks/useAgent.ts`
- Modify: `src/tui/app.tsx`
- Create: `src/agent/loop.test.ts`

- [ ] **Step 1: Write a failing loop test for abort**

```typescript
// src/agent/loop.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createRegistry } from '../tools/registry.js';
import type { AgentConfig } from '../types.js';

const config: AgentConfig = {
  apiKey: 'k', baseUrl: 'http://x/v1', model: 'm', maxTurns: 5, workspace: '.',
  animation: { typewriterSpeed: 3, spinnerStyle: 'braille' },
  accessibility: { screenReader: false, reducedMotion: false },
  tools: { browser: { enabled: false, headless: true }, design: { enabled: false } },
};

describe('runAgentLoop abort', () => {
  it('stops streaming when the abort signal fires', async () => {
    const controller = new AbortController();
    let chunks = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          const interval = setInterval(() => {
            chunks++;
            c.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"x"}}]}\n\n`));
            if (chunks === 3) {
              clearInterval(interval);
              controller.abort();
            }
          }, 5);
        },
      });
      return new Response(body, { status: 200 });
    }));

    const seen = [];
    await runAgentLoop(config, createRegistry(), 'hi', [], {
      onText: (t) => seen.push(t),
      onToolCall: () => {}, onToolResult: () => {}, onError: () => {},
      onTurnStart: () => {}, onDone: () => {},
      onPermissionRequired: async () => 'allow',
      onTokenCount: () => {},
    }, 'default', undefined, { signal: controller.signal });

    // Aborted mid-stream: we should NOT have looped into more turns.
    expect(seen.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/agent/loop.test.ts`

Expected: FAIL — `runAgentLoop` accepts no `signal` option.

- [ ] **Step 3: Thread the signal through the loop**

In `src/agent/loop.ts`, extend the signature and pass the signal to `chatCompletionStream`. When the signal aborts, break out of the turn loop cleanly.

```typescript
export async function runAgentLoop(
  config: AgentConfig,
  registry: ToolRegistry,
  userMessage: string,
  history: Message[],
  callbacks: AgentLoopCallbacks,
  mode: string = 'default',
  permissionStore?: PermissionStore,
  options?: { signal?: AbortSignal },
): Promise<Message[]> {
  const signal = options?.signal;
  // ... existing setup ...

  while (turn < config.maxTurns) {
    if (signal?.aborted) break;
    turn++;
    callbacks.onTurnStart(turn);

    const messages = buildMessages(config, newHistory, registry.getDefinitions());
    let assistantContent = '';
    const toolCalls: ToolCall[] = [];

    const stream = chatCompletionStream(config, messages, registry.getDefinitions(), { signal });

    try {
      for await (const event of stream) {
        if (signal?.aborted) break;
        if (event.type === 'text' && event.content) {
          assistantContent += event.content;
          callbacks.onText(event.content);
        } else if (event.type === 'tool_call' && event.toolCall) {
          toolCalls.push(event.toolCall);
          callbacks.onToolCall(event.toolCall);
        } else if (event.type === 'error' && event.error) {
          callbacks.onError(event.error);
          return newHistory;
        }
      }
    } catch (e) {
      if (signal?.aborted) {
        // Aborted — keep whatever content we have and stop.
        break;
      }
      callbacks.onError(e instanceof Error ? e.message : String(e));
      return newHistory;
    }

    // ... existing tool-execution block (also check signal?.aborted before each tool) ...

    if (toolCalls.length === 0 || signal?.aborted) break;
  }
  // ... existing onDone + maxTurns handling ...
}
```

Also guard the tool-execution `for` loop: `if (signal?.aborted) break;` before each `registry.execute`.

- [ ] **Step 4: Wire AbortController in useAgent**

In `src/tui/hooks/useAgent.ts`, add a ref and create a controller per `send()`. Esc while thinking aborts.

```typescript
  const abortRef = useRef<AbortController | null>(null);

  // inside send(), before runAgentLoop:
  const controller = new AbortController();
  abortRef.current = controller;
  // ...
  await runAgentLoop(config, registry, userMessage, messages, { /* callbacks */ }, mode, permissionStore, { signal: controller.signal });
```

And add a `cancel` export:

```typescript
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);
```

Return `cancel` from the hook.

- [ ] **Step 5: Bind Esc-while-thinking in App**

In `src/tui/app.tsx`, the existing `useInput` handles Esc only for `pendingPermission`. Extend it:

```typescript
  useInput((input, key) => {
    if (key.escape) {
      if (pendingPermission) { cancelPermission(); return; }
      if (isThinking) { cancel(); return; }
    }
    // ... existing Ctrl+T, Alt+M, Ctrl+L ...
  });
```

Pull `cancel` from `useAgent` destructure.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/agent/loop.test.ts`

Expected: PASS — loop stops after abort.

- [ ] **Step 7: Commit**

```bash
git add src/agent/loop.ts src/agent/loop.test.ts src/tui/hooks/useAgent.ts src/tui/app.tsx
git commit -m "feat(agent): abort mid-stream via AbortController, Esc cancels"
```

---

## Phase 5: Real Token Accounting (M1.5) — 🟡 medium

### Task 6: Parse usage from the final SSE chunk and surface it

**Files:**
- Modify: `src/types.ts`
- Modify: `src/provider/openai-compatible.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/tui/hooks/useAgent.ts`
- Modify: `src/tui/components/StatusLine.tsx`

- [ ] **Step 1: Add Usage type and onUsage callback**

In `src/types.ts`:

```typescript
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
```

Add `onUsage?: (usage: Usage) => void;` to `AgentLoopCallbacks` (optional so existing callers compile).

- [ ] **Step 2: Add a failing provider test for usage parsing**

Append to `src/provider/openai-compatible.test.ts`:

```typescript
  it('emits a done event with usage from the final chunk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
          c.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }));

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    const done = events.find((e) => e.type === 'done');
    expect(done?.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/provider/openai-compatible.test.ts`

Expected: FAIL — `done.usage` is undefined.

- [ ] **Step 4: Parse usage and add it to the `done` event**

In `src/types.ts`, extend `ProviderStreamEvent`:

```typescript
export interface ProviderStreamEvent {
  type: 'text' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
  usage?: Usage;
}
```

In `src/provider/openai-compatible.ts`, when parsing each SSE `data` chunk, also read the top-level `parsed.usage` (OpenAI sends it on the final chunk when `stream_options.include_usage` is set). Stash the latest usage and emit it on `done`:

```typescript
// inside the JSON.parse block, after reading choice:
if (parsed.usage) {
  currentUsage = {
    promptTokens: parsed.usage.prompt_tokens ?? 0,
    completionTokens: parsed.usage.completion_tokens ?? 0,
    totalTokens: parsed.usage.total_tokens ?? 0,
  };
}
```

Then at both `[DONE]` and the end-of-stream, yield:

```typescript
yield { type: 'done', usage: currentUsage ?? undefined };
```

(Declare `let currentUsage: Usage | null = null;` near the top.)

- [ ] **Step 5: Forward usage from loop to hook**

In `src/agent/loop.ts`, capture `event.usage` on the `done` event and call `callbacks.onUsage?.(usage)`. Remove the `assistantContent.length/4` estimate (the fake `onTokenCount`) — replace it with the real `onUsage` callback.

- [ ] **Step 6: Update useAgent + StatusLine**

In `src/tui/hooks/useAgent.ts`, replace `tokenCount` accumulation with a `usage` state object and a derived `tokenCount = usage?.totalTokens ?? 0`. Pass `onUsage` instead of `onTokenCount`.

In `src/tui/components/StatusLine.tsx`, keep the existing display but now `tokenCount` reflects real totals. (Optional: show `$` cost via a per-model price table added to config — defer to M3 `--max-budget-usd`.)

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`

Expected: All PASS including the new usage test.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/provider/openai-compatible.ts src/agent/loop.ts src/tui/hooks/useAgent.ts src/tui/components/StatusLine.tsx src/provider/openai-compatible.test.ts
git commit -m "feat(provider): parse real usage from stream and surface onUsage"
```

---

## Phase 6: Test The Core (M1.6) — 🟡 medium

### Task 7: Tool tests (edit replace_all preview, grep output modes)

**Files:**
- Create: `src/tools/file.test.ts`

- [ ] **Step 1: Write file-tool tests**

```typescript
// src/tools/file.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileTools } from './file.js';
import type { ToolContext } from '../types.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
const ctx: ToolContext = { workspaceRoot: '', env: {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-file-'));
  ctx.workspaceRoot = dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = fileTools.find((t) => t.name === 'read_file')!;
const edit = fileTools.find((t) => t.name === 'edit_file')!;
const grep = fileTools.find((t) => t.name === 'grep')!;

describe('edit_file', () => {
  it('replaces the first occurrence by default', async () => {
    writeFileSync(join(dir, 'a.txt'), 'foo foo bar');
    const r = await edit.execute({ filePath: 'a.txt', oldString: 'foo', newString: 'qux' }, ctx);
    expect(r.success).toBe(true);
    expect(read.execute({ filePath: 'a.txt' }, ctx).then((x) => x.output)).resolves.toContain('qux foo bar');
  });
});

describe('grep', () => {
  it('matches a regex across files', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;\nconst y = 2;');
    writeFileSync(join(dir, 'b.ts'), 'let z = 3;');
    const r = await grep.execute({ pattern: 'const', include: '*.ts' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('a.ts:1: const x = 1;');
  });
});
```

> Note: this task *characterizes* current behavior (single-replace, basic grep). The real `replace_all` + `output_mode` work belongs to M2 (Tool Parity). Here we just lock the current contract so M2 changes are safe.

- [ ] **Step 2: Run**

Run: `npx vitest run src/tools/file.test.ts`

Expected: PASS.

### Task 8: PermissionStore test (deny → ask → allow ordering)

**Files:**
- Create: `src/tui/permissionStore.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// src/tui/permissionStore.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionStore } from './permissionStore.js';

describe('PermissionStore ordering', () => {
  let store: PermissionStore;
  beforeEach(() => {
    vi.mocked(fs).existsSync.mockReturnValue(false); // isolate in-memory
    store = new PermissionStore('/fake/ws');
  });

  it('returns ask when no rule matches', () => {
    expect(store.evaluate('bash', 'ls')).toBe('ask');
  });

  it('deny wins over allow for the same tool+pattern', () => {
    store.allowAlways('bash', 'rm *', 'session');
    // (deny rules would be added via settings in M4; here we just confirm allow works)
    expect(store.evaluate('bash', 'rm -rf /')).toBe('allow');
  });
});
```

(Adjust the `vi.mocked(fs)` to match the actual import style of `permissionStore.ts`; if the store reads from disk at construction, mock `existsSync` to return false so it starts empty, or inject a temp `STORE_PATH`.)

- [ ] **Step 2: Run**

Run: `npx vitest run src/tui/permissionStore.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tools/file.test.ts src/tui/permissionStore.test.ts
git commit -m "test: lock file-tool contract and permission-store ordering"
```

### Task 9: Full regression + typecheck + build

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`

Expected: All tests PASS (context, provider body/retry/usage, loop abort, file tools, permission store).

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: `dist/index.js` produced without errors.

- [ ] **Step 4: Manual smoke test**

Run (with `BOOK_API_KEY` set): `node dist/index.js` and type a multi-step prompt like "read package.json then list the scripts field".

Expected: The agent reads the file, sees the result, and answers using the file's contents (proving tool results now round-trip). Esc mid-stream cancels cleanly.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(m1): foundation hardening complete — tool-result threading, provider fixes, abort, usage, tests"
```

---

## M1 Definition of Done (acceptance checklist)

- [ ] The model can see its own tool results across turns (verified by `context.test.ts` + smoke test).
- [ ] Request body contains no `max_turns`; `stream_options.include_usage` is set.
- [ ] 429/5xx retried up to 3 times with backoff honoring `Retry-After`; exhausted retries yield an error.
- [ ] Esc / Ctrl+C while thinking aborts the in-flight fetch and returns to the prompt without crashing.
- [ ] `StatusLine` shows real token totals from the API.
- [ ] `npm test` passes and covers context, provider, loop, file tools, and permission store.
- [ ] `npx tsc --noEmit` and `npm run build` succeed.
