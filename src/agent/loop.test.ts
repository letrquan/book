import { describe, it, expect, vi } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import type { ToolResult, UserQuestionRequest } from '../types.js';
import { askUserQuestionTools } from '../tools/ask-user-question.js';

const config = defaultConfig();

// Helper: create a stream that yields text then done.
function textStream(content: string): ReadableStream {
  return new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`));
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
              c.enqueue(
                enc.encode('data: {"choices":[{"delta":{"content":"I will read it."}}]}\n\n'),
              );
              c.enqueue(
                enc.encode(
                  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool_1","function":{"name":"Echo","arguments":"{\\"value\\":\\"abc\\"}"}}]}}]}\n\n',
                ),
              );
            } else {
              c.enqueue(
                enc.encode('data: {"choices":[{"delta":{"content":"Tool said abc."}}]}\n\n'),
              );
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
        onTurnStart: (turn: number) => {
          turns[turn - 1] = { texts: [], calls: [], results: [] };
        },
        onText: (t: string) => turns[turns.length - 1].texts.push(t),
        onToolCall: (call: { id: string }) => turns[turns.length - 1].calls.push(call.id),
        onToolResult: (toolResult: { toolCallId: string; output: string }) =>
          turns[turns.length - 1].results.push(`${toolResult.toolCallId}:${toolResult.output}`),
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
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
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

  it('publishes terminal results for streamed tool calls when aborted before execution', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          new ReadableStream({
            start(c) {
              const encoder = new TextEncoder();
              c.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"cancelled-tool","function":{"name":"Read","arguments":"{}"}}]}}]}\n\n',
                ),
              );
              c.enqueue(encoder.encode('data: [DONE]\n\n'));
              c.close();
            },
          }),
          { status: 200 },
        );
      }),
    );

    const results: ToolResult[] = [];
    const nestedResults: ToolResult[] = [];
    const history = await runAgentLoop(
      config,
      createRegistry(),
      'hi',
      [],
      noopCallbacks({
        onToolCall: () => controller.abort(),
        onToolResult: (result: ToolResult) => results.push(result),
      }),
      'default',
      {
        signal: controller.signal,
        parentToolTraceId: 'parent-task',
        nestedToolObserver: {
          onToolCall: () => {},
          onToolResult: (_traceId, result) => nestedResults.push(result),
        },
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0].error).toMatch(/CANCELLED/);
    expect(nestedResults).toHaveLength(1);
    expect(history.at(-1)?.toolResults?.[0].error).toMatch(/CANCELLED/);
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
      retry: {
        maxAttempts: 0,
        baseDelayMs: 0,
        maxDelayMs: 10,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
        streamStallTimeoutMs: 0,
        toolRetries: 0,
        watchdog: false,
      },
    });

    await runAgentLoop(
      cfg,
      createRegistry(),
      'hi',
      [],
      noopCallbacks({
        onError: (err: string) => {
          errorMsg = err;
        },
        onDone: () => {
          doneCalled = true;
        },
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
        onError: (err: string) => {
          errorMsg = err;
        },
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
        onToolResult: (r: { toolCallId: string; error?: string }) =>
          results.push(`${r.toolCallId}:${r.error}`),
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
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 10,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
        streamStallTimeoutMs: 0,
        toolRetries: 0,
        watchdog: false,
      },
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
          new ReadableStream({
            start() {
              /* never resolves */
            },
          }),
          { status: 200 },
        );
      }),
    );

    let stallCalled = false;
    let errorMsg = '';
    const cfg = defaultConfig({
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 10,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
        streamStallTimeoutMs: 50,
        toolRetries: 0,
        watchdog: false,
      },
    });

    await runAgentLoop(
      cfg,
      createRegistry(),
      'hi',
      [],
      noopCallbacks({
        onStreamStall: () => {
          stallCalled = true;
        },
        onError: (err: string) => {
          errorMsg = err;
        },
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
      retry: {
        maxAttempts: 0,
        baseDelayMs: 0,
        maxDelayMs: 10,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
        streamStallTimeoutMs: 0,
        toolRetries: 0,
        watchdog: false,
      },
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
        onDone: () => {
          doneCalled = true;
        },
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
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 10,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
        streamStallTimeoutMs: 0,
        toolRetries: 2,
        watchdog: false,
      },
    });

    await runAgentLoop(cfg, registry, 'hi', [], noopCallbacks());

    // At least one tool call should have received toolRetries=2.
    expect(executeCalls.some((c) => c === 2)).toBe(true);
  });
});

function toolCallStream(
  calls: Array<{ id: string; name: string; arguments: string }>,
): ReadableStream {
  return new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      const toolCalls = calls
        .map(
          (call, index) =>
            `{"index":${index},"id":"${call.id}","function":{"name":"${call.name}","arguments":"${call.arguments.replace(/"/g, '\\\"')}"}}`,
        )
        .join(',');
      c.enqueue(enc.encode(`data: {"choices":[{"delta":{"tool_calls":[${toolCalls}]}}]}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

describe('runAgentLoop accept-edits mode', () => {
  for (const toolName of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    it(`auto-allows ${toolName} without prompting`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(toolCallStream([{ id: 'edit_1', name: toolName, arguments: '{}' }]), {
              status: 200,
            }),
        ),
      );
      const registry = createRegistry();
      let executed = false;
      registry.register({
        name: toolName,
        description: toolName,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          executed = true;
          return { toolCallId: '', success: true, output: 'ok' };
        },
      });
      let prompted = false;

      await runAgentLoop(
        defaultConfig({ maxTurns: 1 }),
        registry,
        'edit',
        [],
        noopCallbacks({
          onPermissionRequired: async () => {
            prompted = true;
            return 'deny';
          },
        }),
        'accept-edits',
      );

      expect(prompted).toBe(false);
      expect(executed).toBe(true);
    });
  }
});

describe('runAgentLoop AskUserQuestion', () => {
  const argumentsJson = JSON.stringify({
    questions: [
      {
        question: 'Which database?',
        header: 'Database',
        options: [
          { label: 'SQLite', description: 'Local file database' },
          { label: 'Postgres', description: 'Network database' },
        ],
        multiSelect: false,
      },
    ],
  });

  it('asks without a permission prompt and returns the answer as the tool result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'ask_1', name: 'AskUserQuestion', arguments: argumentsJson },
            ]),
            { status: 200 },
          ),
      ),
    );
    const registry = createRegistry();
    registry.registerAll(askUserQuestionTools);
    const results: ToolResult[] = [];
    const prompted = vi.fn();

    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'choose',
      [],
      noopCallbacks({
        onPermissionRequired: prompted,
        onUserQuestionRequired: async (request: UserQuestionRequest) => ({
          action: 'answer',
          answers: { [request.questions[0].question]: 'SQLite' },
        }),
        onToolResult: (result: ToolResult) => results.push(result),
      }),
      'default',
    );

    expect(prompted).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ success: true });
    expect(results[0].output).toContain('Which database?: SQLite');
  });

  it('blocks questions in dontAsk mode before invoking the host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'ask_1', name: 'AskUserQuestion', arguments: argumentsJson },
            ]),
            { status: 200 },
          ),
      ),
    );
    const registry = createRegistry();
    registry.registerAll(askUserQuestionTools);
    const handler = vi.fn();
    const results: ToolResult[] = [];

    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'choose',
      [],
      noopCallbacks({
        onUserQuestionRequired: handler,
        onToolResult: (result: ToolResult) => results.push(result),
      }),
      'dontAsk',
    );

    expect(handler).not.toHaveBeenCalled();
    expect(results[0].error).toMatch(/disabled in dontAsk/);
  });
});

describe('runAgentLoop plan mode', () => {
  it('auto-allows read-only tools without prompting in plan mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([{ id: 'read_1', name: 'Read', arguments: '{"filePath":"x"}' }]),
            {
              status: 200,
            },
          ),
      ),
    );

    const registry = createRegistry();
    let executed = false;
    registry.register({
      name: 'Read',
      description: 'Read',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        executed = true;
        return { toolCallId: '', success: true, output: 'read ok' };
      },
    });

    let prompted = false;
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'plan',
      [],
      noopCallbacks({
        onPermissionRequired: async () => {
          prompted = true;
          return 'deny';
        },
        onToolResult: (result: ToolResult) => results.push(result),
      }),
      'plan',
    );

    expect(prompted).toBe(false);
    expect(executed).toBe(true);
    expect(results[0]).toMatchObject({ success: true, output: 'read ok' });
  });

  it('blocks mutating tools before execution in plan mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'write_1', name: 'Write', arguments: '{"filePath":"x","content":"y"}' },
            ]),
            { status: 200 },
          ),
      ),
    );

    const registry = createRegistry();
    let executed = false;
    registry.register({
      name: 'Write',
      description: 'Write',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        executed = true;
        return { toolCallId: '', success: true, output: 'wrote' };
      },
    });

    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'plan',
      [],
      noopCallbacks({ onToolResult: (result: ToolResult) => results.push(result) }),
      'plan',
    );

    expect(executed).toBe(false);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/not allowed in plan mode/);
  });

  it('EnterPlanMode changes mode and blocks later mutating calls in the same turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'enter_1', name: 'EnterPlanMode', arguments: '{}' },
              { id: 'write_1', name: 'Write', arguments: '{"filePath":"x","content":"y"}' },
            ]),
            { status: 200 },
          ),
      ),
    );

    const registry = createRegistry();
    registry.register({
      name: 'EnterPlanMode',
      description: 'Enter plan mode',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => {
        ctx.previousMode = ctx.currentMode;
        ctx.currentMode = 'plan';
        return { toolCallId: '', success: true, output: 'entered' };
      },
    });
    let writeExecuted = false;
    registry.register({
      name: 'Write',
      description: 'Write',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        writeExecuted = true;
        return { toolCallId: '', success: true, output: 'wrote' };
      },
    });

    const modes: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'plan',
      [],
      noopCallbacks({
        onModeChange: (newMode: string) => modes.push(newMode),
        onToolResult: (result: ToolResult) => results.push(result),
      }),
      'default',
    );

    expect(modes).toEqual(['plan']);
    expect(writeExecuted).toBe(false);
    expect(results.map((r) => r.success)).toEqual([true, false]);
    expect(results[1].error).toMatch(/not allowed in plan mode/);
  });

  it('ExitPlanMode requests approval and restores the previous mode when approved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'exit_1', name: 'ExitPlanMode', arguments: '{"plan":"Do it."}' },
            ]),
            { status: 200 },
          ),
      ),
    );

    const registry = createRegistry();
    registry.register({
      name: 'ExitPlanMode',
      description: 'Exit plan mode',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => {
        ctx.previousMode = 'default';
        ctx.pendingPlanApproval = { plan: 'Do it.' };
        return { toolCallId: '', success: true, output: 'submitted' };
      },
    });

    const modes: string[] = [];
    const plans: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'plan',
      [],
      noopCallbacks({
        onModeChange: (newMode: string) => modes.push(newMode),
        onPlanApprovalRequired: async (plan: string) => {
          plans.push(plan);
          return 'approve';
        },
        onToolResult: (result: ToolResult) => results.push(result),
      }),
      'plan',
    );

    expect(plans).toEqual(['Do it.']);
    expect(modes).toEqual(['default']);
    expect(results[0]).toMatchObject({ success: true });
    expect(results[0].output).toMatch(/Plan approved/);
  });

  it('ExitPlanMode keeps plan mode when approval is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'exit_1', name: 'ExitPlanMode', arguments: '{"plan":"Do it."}' },
            ]),
            { status: 200 },
          ),
      ),
    );

    const registry = createRegistry();
    registry.register({
      name: 'ExitPlanMode',
      description: 'Exit plan mode',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => {
        ctx.previousMode = 'default';
        ctx.pendingPlanApproval = { plan: 'Do it.' };
        return { toolCallId: '', success: true, output: 'submitted' };
      },
    });

    const modes: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'plan',
      [],
      noopCallbacks({
        onModeChange: (newMode: string) => modes.push(newMode),
        onPlanApprovalRequired: async () => 'reject',
        onToolResult: (result: ToolResult) => results.push(result),
      }),
      'plan',
    );

    expect(modes).toEqual([]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/Plan was not approved/);
  });
});
