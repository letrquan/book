import { describe, it, expect, vi } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';

const config = defaultConfig();

// Helper: create a stream that yields text then done.
function textStream(content: string): ReadableStream {
  return new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(
        enc.encode(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`),
      );
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

// Helper: noop callbacks.
function noopCallbacks(overrides: Record<string, any> = {}) {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired: async () => 'allow' as const,
    ...overrides,
  };
}

describe('runAgentLoop streaming render callbacks', () => {
  it('streams text chunks in order before onDone and returns assistant content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events: string[] = [];
    const result = await runAgentLoop(
      config,
      createRegistry(),
      'hi',
      [],
      noopCallbacks({
        onText: (t: string) => events.push(`text:${t}`),
        onDone: () => events.push('done'),
      }),
    );

    expect(events).toEqual(['text:Hel', 'text:lo', 'done']);
    expect(result.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello'],
    ]);
  });

  it('keeps tool calls and results attached to the assistant turn that produced them', async () => {
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls++;
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            if (fetchCalls === 1) {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"I will read it."}}]}\n\n'));
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool_1","function":{"name":"Echo","arguments":"{\\"value\\":\\"abc\\"}"}}]}}]}\n\n'));
            } else {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Tool said abc."}}]}\n\n'));
            }
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const registry = createRegistry();
    registry.register({
      name: 'Echo',
      description: 'Echo value',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      execute: async (args) => ({ toolCallId: '', success: true, output: String(args.value) }),
    });

    const turns: Array<{ texts: string[]; calls: string[]; results: string[] }> = [];
    const result = await runAgentLoop(
      config,
      registry,
      'read',
      [],
      noopCallbacks({
        onTurnStart: (turn: number) => { turns[turn - 1] = { texts: [], calls: [], results: [] }; },
        onText: (t: string) => turns[turns.length - 1].texts.push(t),
        onToolCall: (call: { id: string }) => turns[turns.length - 1].calls.push(call.id),
        onToolResult: (toolResult: { toolCallId: string; output: string }) => turns[turns.length - 1].results.push(`${toolResult.toolCallId}:${toolResult.output}`),
      }),
      'auto',
    );

    expect(turns).toEqual([
      { texts: ['I will read it.'], calls: ['tool_1'], results: ['tool_1:abc'] },
      { texts: ['Tool said abc.'], calls: [], results: [] },
    ]);
    const firstAssistant = result.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(firstAssistant?.toolCalls?.[0].id).toBe('tool_1');
    expect(firstAssistant?.toolResults?.[0].toolCallId).toBe('tool_1');
  });
});

describe('runAgentLoop abort', () => {
  it('stops streaming when the abort signal fires', async () => {
    const controller = new AbortController();
    let chunks = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            const interval = setInterval(() => {
              chunks++;
              c.enqueue(
                enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'),
              );
              if (chunks === 3) {
                clearInterval(interval);
                controller.abort();
              }
            }, 5);
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const seen: string[] = [];
    await runAgentLoop(
      config,
      createRegistry(),
      'hi',
      [],
      {
        onText: (t) => seen.push(t),
        onToolCall: () => {},
        onToolResult: () => {},
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: async () => 'allow',
        onTokenCount: () => {},
      },
      'default',
      { signal: controller.signal },
    );

    // Aborted mid-stream: we should NOT have looped into more turns.
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it('keeps partial assistant content in returned history after abort', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const result = await runAgentLoop(
      config,
      createRegistry(),
      'hi',
      [],
      noopCallbacks({
        onText: () => controller.abort(),
      }),
      'default',
      { signal: controller.signal },
    );

    expect(result.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'partial'],
    ]);
  });
});

describe('runAgentLoop error handling', () => {
  it('calls onError and stops loop when stream yields error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('rate limited', { status: 429 });
      }),
    );

    let errorMsg = '';
    let doneCalled = false;

    const cfg = defaultConfig({
      retry: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 10, totalBudgetMs: 0, requestTimeoutMs: 0, streamStallTimeoutMs: 0, toolRetries: 0, watchdog: false },
    });

    await runAgentLoop(
      cfg,
      createRegistry(),
      'hi',
      [],
      noopCallbacks({
        onError: (err: string) => { errorMsg = err; },
        onDone: () => { doneCalled = true; },
      }),
    );

    expect(errorMsg).toMatch(/API Error: 429/);
    // onDone should NOT be called when the loop exits via error return.
    expect(doneCalled).toBe(false);
  });

  it('calls onError when max turns reached', async () => {
    let turns = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        turns++;
        // Return a tool call each turn so the loop keeps going.
        return new Response(
          new ReadableStream({
            start(c) {
              const enc = new TextEncoder();
              c.enqueue(
                enc.encode(
                  'data: {"choices":[{"delta":{"tool_calls":[{"id":"t1","function":{"name":"Read","arguments":"{\\"filePath\\":\\"x\\"}"}}]}}]}\n\n',
                ),
              );
              c.enqueue(enc.encode('data: [DONE]\n\n'));
              c.close();
            },
          }),
          { status: 200 },
        );
      }),
    );

    let errorMsg = '';
    const cfg = defaultConfig({ maxTurns: 2 });

    await runAgentLoop(
      cfg,
      createRegistry(),
      'hi',
      [],
      noopCallbacks({
        onError: (err: string) => { errorMsg = err; },
        onPermissionRequired: async () => 'deny', // deny tools so loop keeps turning without side effects
      }),
    );

    expect(errorMsg).toMatch(/max turns/);
  });

  it('emits a skipped tool result when permission is denied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          new ReadableStream({
            start(c) {
              const enc = new TextEncoder();
              c.enqueue(
                enc.encode(
                  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"deny_1","function":{"name":"Read","arguments":"{\\"filePath\\":\\"x\\"}"}}]}}]}\n\n',
                ),
              );
              c.enqueue(enc.encode('data: [DONE]\n\n'));
              c.close();
            },
          }),
          { status: 200 },
        );
      }),
    );

    const results: string[] = [];
    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      createRegistry(),
      'hi',
      [],
      noopCallbacks({
        onPermissionRequired: async () => 'deny',
        onToolResult: (r: { toolCallId: string; error?: string }) => results.push(`${r.toolCallId}:${r.error}`),
      }),
    );

    expect(results).toEqual(['deny_1:SKIPPED: Permission denied']);
  });

  it('calls onRetry callback during transport retries', async () => {
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls++;
        if (fetchCalls < 3) {
          return new Response('err', { status: 500 });
        }
        return new Response(textStream('ok'), { status: 200 });
      }),
    );

    const retryCalls: Array<{ phase: string; attempt: number }> = [];
    const cfg = defaultConfig({
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10, totalBudgetMs: 0, requestTimeoutMs: 0, streamStallTimeoutMs: 0, toolRetries: 0, watchdog: false },
    });

    await runAgentLoop(
      cfg,
      createRegistry(),
      'hi',
      [],
      noopCallbacks({
        onRetry: (phase: string, attempt: number) => {
          retryCalls.push({ phase, attempt });
        },
      }),
    );

    expect(retryCalls.length).toBeGreaterThanOrEqual(2);
    expect(retryCalls[0].phase).toBe('transport');
  });

  it('calls onStreamStall when stream hangs and stops loop with error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // Hanging stream — will trigger stall timeout in chatCompletionStream.
        return new Response(
          new ReadableStream({ start() { /* never resolves */ } }),
          { status: 200 },
        );
      }),
    );

    let stallCalled = false;
    let errorMsg = '';
    const cfg = defaultConfig({
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10, totalBudgetMs: 0, requestTimeoutMs: 0, streamStallTimeoutMs: 50, toolRetries: 0, watchdog: false },
    });

    await runAgentLoop(
      cfg,
      createRegistry(),
      'hi',
      [],
      noopCallbacks({
        onStreamStall: () => { stallCalled = true; },
        onError: (err: string) => { errorMsg = err; },
      }),
    );

    // Stream stall callback should have fired.
    expect(stallCalled).toBe(true);
    // Loop should have ended with a stall error.
    expect(errorMsg).toMatch(/stalled/i);
  });

  it('preserves user message in history after error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('server error', { status: 500 });
      }),
    );

    const cfg = defaultConfig({
      retry: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 10, totalBudgetMs: 0, requestTimeoutMs: 0, streamStallTimeoutMs: 0, toolRetries: 0, watchdog: false },
    });

    const result = await runAgentLoop(
      cfg,
      createRegistry(),
      'my important question',
      [],
      noopCallbacks(),
    );

    // The user message should still be in history.
    const userMsg = result.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('my important question');
  });

  it('returns from loop normally on successful single-turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(textStream('hello world'), { status: 200 });
      }),
    );

    const seen: string[] = [];
    let doneCalled = false;

    const result = await runAgentLoop(
      config,
      createRegistry(),
      'greet',
      [],
      noopCallbacks({
        onText: (t: string) => seen.push(t),
        onDone: () => { doneCalled = true; },
      }),
    );

    expect(seen.join('')).toBe('hello world');
    expect(doneCalled).toBe(true);
    // Result should contain user msg + assistant response.
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

describe('runAgentLoop retry config passthrough', () => {
  it('passes retry.toolRetries to registry.execute', async () => {
    const registry = createRegistry();
    // Spy on execute to verify toolRetries is passed.
    const origExecute = registry.execute;
    const executeCalls: number[] = [];
    registry.execute = async (call, ctx, maxRetries) => {
      executeCalls.push(maxRetries ?? -1);
      return origExecute(call, ctx, maxRetries);
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          new ReadableStream({
            start(c) {
              const enc = new TextEncoder();
              c.enqueue(
                enc.encode(
                  'data: {"choices":[{"delta":{"tool_calls":[{"id":"t1","function":{"name":"Read","arguments":"{\\"filePath\\":\\"a.txt\\"}"}}]}}]}\n\n',
                ),
              );
              c.enqueue(enc.encode('data: [DONE]\n\n'));
              c.close();
            },
          }),
          { status: 200 },
        );
      }),
    );

    const cfg = defaultConfig({
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10, totalBudgetMs: 0, requestTimeoutMs: 0, streamStallTimeoutMs: 0, toolRetries: 2, watchdog: false },
    });

    await runAgentLoop(
      cfg,
      registry,
      'hi',
      [],
      noopCallbacks(),
    );

    // At least one tool call should have received toolRetries=2.
    expect(executeCalls.some((c) => c === 2)).toBe(true);
  });
});
