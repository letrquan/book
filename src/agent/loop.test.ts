import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { createDefaultRegistry, createRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { ToolResult, UserQuestionRequest } from '../types/tools.js';
import { askUserQuestionTools } from '../tools/ask-user-question.js';
import { toolSuccess } from '../tools/result.js';
import { readToolUseRecords } from '../tool-telemetry.js';
import { SessionRuntime } from '../session/runtime.js';
import type { Provider } from '../provider/index.js';
import type { CompactResult } from '../types/sessions.js';

function compactedForRetry(): Extract<CompactResult, { status: 'compacted' }> {
  return {
    status: 'compacted',
    trigger: 'auto',
    replacementHistory: [
      {
        id: 'checkpoint-retry',
        role: 'assistant',
        content: 'compact summary',
        kind: 'checkpoint',
        includeInContext: true,
        timestamp: 2,
      },
    ],
    summary: 'compact summary',
    compactId: 'compact-retry',
    generation: 1,
    checkpoint: {
      version: 2,
      generation: 1,
      state: { summary: 'compact summary', status: 'active' },
      constraints: [],
      files: [],
      episodes: [],
      openThreads: [],
      statistics: { summarizedMessages: 1, retainedMessages: 0, preTokens: 100, postTokens: 10 },
    },
    checkpointVersion: 2,
    summarizedCount: 1,
    retainedCount: 0,
    postContextTokens: 10,
    preMessageCount: 2,
    strategy: 'single-pass',
    modelCalls: 1,
  };
}

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
function noopCallbacks(overrides: Partial<AgentLoopCallbacks> = {}): AgentLoopCallbacks {
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
  it('continues the active turn after between-turn auto compaction', async () => {
    let providerCalls = 0;
    const seenMessageContents: string[][] = [];
    const provider: Provider = {
      id: 'scripted',
      stream: async function* (_config, messages) {
        providerCalls++;
        seenMessageContents.push(messages.map((message) => String(message.content)));
        if (providerCalls === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'echo-1', name: 'Echo', arguments: { value: 'ok' } },
          };
          yield {
            type: 'done',
            usage: {
              promptTokens: 90_000,
              completionTokens: 100,
              totalTokens: 90_100,
              contextTokens: 90_000,
            },
          };
          return;
        }
        yield { type: 'text', content: 'continued after compact' };
        yield { type: 'done' };
      },
    };
    const registry = createRegistry();
    registry.register({
      name: 'Echo',
      description: 'Return the provided value',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      execute: async (args) => toolSuccess(String(args.value ?? '')),
    });
    const compact = vi.fn(async () => compactedForRetry());

    const result = await runAgentLoop(
      defaultConfig({
        maxTurns: 2,
        maxTokens: 4_000,
        autoCompactEnabled: true,
        modelInfo: { contextWindow: 100_000 },
      }),
      registry,
      'hello',
      [],
      noopCallbacks({ onCompact: compact }),
      'default',
      { provider, isNewSession: false },
    );

    expect(compact).toHaveBeenCalledOnce();
    expect(providerCalls).toBe(2);
    expect(seenMessageContents[1]).toContain('compact summary');
    expect(result.at(-1)?.content).toBe('continued after compact');
  });

  it('compacts and retries once when the provider rejects an oversized context', async () => {
    let providerCalls = 0;
    const seenMessageContents: string[][] = [];
    const provider: Provider = {
      id: 'scripted',
      stream: async function* (_config, messages) {
        providerCalls++;
        seenMessageContents.push(messages.map((message) => String(message.content)));
        if (providerCalls === 1) {
          yield { type: 'error', error: 'API Error: 413 request entity too large' };
          return;
        }
        yield { type: 'text', content: 'recovered' };
        yield { type: 'done' };
      },
    };
    const compact = vi.fn(async () => compactedForRetry());
    const onError = vi.fn();
    let turnStarts = 0;

    const result = await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      createRegistry(),
      'hello',
      [],
      noopCallbacks({
        onError,
        onCompact: compact,
        onTurnStart: () => {
          turnStarts++;
        },
      }),
      'default',
      { provider, isNewSession: false },
    );

    expect(providerCalls).toBe(2);
    expect(compact).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(turnStarts).toBe(1);
    expect(seenMessageContents[1]).toContain('compact summary');
    expect(result.at(-1)?.content).toBe('recovered');
  });

  it('does not compact again after a second context overflow on the same turn', async () => {
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        yield { type: 'error', error: 'maximum context length exceeded' };
      },
    };
    const compact = vi.fn(async () => compactedForRetry());
    const onError = vi.fn();

    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      createRegistry(),
      'hello',
      [],
      noopCallbacks({ onCompact: compact, onError }),
      'default',
      { provider, isNewSession: false },
    );

    expect(compact).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('maximum context length exceeded');
  });

  it('uses an injected provider port without resolving a concrete adapter', async () => {
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        yield { type: 'text', content: 'from port' };
        yield { type: 'done' };
      },
    };

    const result = await runAgentLoop(
      config,
      createRegistry(),
      'hello',
      [],
      noopCallbacks(),
      'default',
      {
        provider,
        isNewSession: false,
      },
    );

    expect(result.at(-1)?.content).toBe('from port');
  });

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
      execute: async (args) => toolSuccess(String(args.value)),
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
        onToolResult: (toolResult: ToolResult) =>
          turns[turns.length - 1].results.push(`${toolResult.toolCallId}:${toolResult.content}`),
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

  it('uses a permission mode changed by the host during the active loop', async () => {
    let providerTurn = 0;
    let activeMode: 'default' | 'auto' = 'default';
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        providerTurn++;
        if (providerTurn === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'switch_1', name: 'SwitchMode', arguments: {} },
          };
        } else if (providerTurn === 2) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'echo_1', name: 'Echo', arguments: { value: 'ok' } },
          };
        } else {
          yield { type: 'text', content: 'done' };
        }
        yield { type: 'done' };
      },
    };
    const registry = createRegistry();
    registry.register({
      name: 'SwitchMode',
      description: 'Switch the host permission mode',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        activeMode = 'auto';
        return toolSuccess('switched');
      },
    });
    registry.register({
      name: 'Echo',
      description: 'Echo value',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      execute: async (args) => toolSuccess(String(args.value)),
    });
    let permissionPrompts = 0;

    await runAgentLoop(
      defaultConfig({ maxTurns: 4 }),
      registry,
      'change mode',
      [],
      noopCallbacks({
        getMode: () => activeMode,
        onPermissionRequired: async () => {
          permissionPrompts++;
          return 'allow';
        },
      }),
      'default',
      { provider, isNewSession: false },
    );

    expect(permissionPrompts).toBe(1);
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
    expect(results[0].structuredError?.message).toMatch(/CANCELLED/);
    expect(nestedResults).toHaveLength(1);
    expect(history.at(-1)?.toolResults?.[0].structuredError?.message).toMatch(/CANCELLED/);
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
  it('clips a newly produced oversized tool result before the next provider request', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-loop-context-'));
    let providerTurn = 0;
    let secondRequestToolContent = '';
    const provider: Provider = {
      id: 'scripted',
      stream: async function* (_config, messages) {
        providerTurn++;
        if (providerTurn === 1) {
          yield { type: 'tool_call', toolCall: { id: 'big_1', name: 'Big', arguments: {} } };
        } else {
          secondRequestToolContent = String(messages.at(-1)?.content ?? '');
          yield { type: 'text', content: 'recovered' };
        }
        yield { type: 'done' };
      },
    };
    const registry = createRegistry();
    registry.register({
      name: 'Big',
      description: 'Return a large result',
      parameters: { type: 'object', properties: {} },
      execute: async () => toolSuccess('x'.repeat(100_000)),
    });

    try {
      const result = await runAgentLoop(
        defaultConfig({
          workspace,
          maxTurns: 2,
          maxTokens: 4_000,
          autoCompactEnabled: false,
          modelInfo: { contextWindow: 16_000 },
        }),
        registry,
        'inspect',
        [],
        noopCallbacks(),
        'auto',
        { provider, isNewSession: false, toolOutputRoot: join(workspace, 'tool-output') },
      );

      expect(providerTurn).toBe(2);
      expect(secondRequestToolContent.length).toBeLessThan(10_000);
      expect(result.at(-1)?.content).toBe('recovered');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reserves the complete requested output budget during preflight', async () => {
    let providerToolContent = '';
    const provider: Provider = {
      id: 'scripted',
      stream: async function* (_config, messages) {
        providerToolContent = String(messages.find((message) => message.role === 'tool')?.content);
        yield { type: 'text', content: 'ok' };
        yield { type: 'done' };
      },
    };
    const history = [
      {
        id: 'budget-user',
        role: 'user' as const,
        content: 'inspect',
        includeInContext: true,
        timestamp: 0,
      },
      {
        id: 'budget-assistant',
        role: 'assistant' as const,
        content: '',
        includeInContext: true,
        toolCalls: [{ id: 'budget-tool', name: 'Read', arguments: {} }],
        toolResults: [toolSuccess('z'.repeat(80_000), { toolCallId: 'budget-tool' })],
        timestamp: 0,
      },
    ];

    await runAgentLoop(
      defaultConfig({
        maxTurns: 1,
        maxTokens: 80_000,
        autoCompactEnabled: false,
        modelInfo: { contextWindow: 100_000, maxOutputTokens: 80_000 },
      }),
      createRegistry(),
      'continue',
      history,
      noopCallbacks(),
      'auto',
      { provider, isNewSession: false },
    );

    expect(providerToolContent.length).toBeLessThan(10_000);
  });

  it('recovers once from a router context error without persisting the error as an answer', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-loop-overflow-'));
    let providerTurn = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        providerTurn++;
        if (providerTurn === 1) {
          yield {
            type: 'text',
            content: '[Error] Your input exceeds the context window of this model.',
          };
        } else {
          yield { type: 'text', content: 'answer after reduction' };
        }
        yield { type: 'done' };
      },
    };
    const largeHistory = [
      {
        id: 'old-user',
        role: 'user' as const,
        content: 'inspect',
        includeInContext: true,
        timestamp: 0,
      },
      {
        id: 'old-assistant',
        role: 'assistant' as const,
        content: '',
        includeInContext: true,
        toolCalls: [{ id: 'old-tool', name: 'Read', arguments: {} }],
        toolResults: [toolSuccess('y'.repeat(20_000), { toolCallId: 'old-tool' })],
        timestamp: 0,
      },
    ];
    const errors: string[] = [];
    const streamedText: string[] = [];
    try {
      const result = await runAgentLoop(
        defaultConfig({
          workspace,
          maxTurns: 2,
          maxTokens: 4_000,
          autoCompactEnabled: false,
          modelInfo: { contextWindow: 100_000 },
        }),
        createRegistry(),
        'continue',
        largeHistory,
        noopCallbacks({
          onError: (error) => errors.push(error),
          onText: (text) => streamedText.push(text),
        }),
        'auto',
        { provider, isNewSession: false },
      );

      expect(providerTurn).toBe(2);
      expect(errors).toEqual([]);
      expect(streamedText).toEqual(['answer after reduction']);
      expect(result.at(-1)?.content).toBe('answer after reduction');
      expect(result.some((message) => message.content.includes('[Error]'))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
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
        onToolResult: (r: ToolResult) =>
          results.push(`${r.toolCallId}:${r.structuredError?.message}`),
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
  it('passes retry.toolRetries to prepared tool execution', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'Read',
      description: 'Read',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
      idempotent: true,
      execute: async () => toolSuccess('read'),
    });
    const origExecutePrepared = registry.executePrepared;
    const executeCalls: number[] = [];
    registry.executePrepared = async (prepared, ctx, maxRetries) => {
      executeCalls.push(maxRetries ?? -1);
      return origExecutePrepared(prepared, ctx, maxRetries);
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runAgentLoop concurrent tool execution', () => {
  it('overlaps parallel-safe calls, preserves result order, and honors serial barriers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'parallel-a', name: 'ParallelA', arguments: '{}' },
              { id: 'parallel-b', name: 'ParallelB', arguments: '{}' },
              { id: 'serial-c', name: 'SerialC', arguments: '{}' },
              { id: 'parallel-d', name: 'ParallelD', arguments: '{}' },
            ]),
            { status: 200 },
          ),
      ),
    );
    const registry = createRegistry();
    const waveRelease = deferred();
    const bothStarted = deferred();
    const events: string[] = [];
    let firstWaveStarted = 0;
    const parallel = (name: string) => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      policy: { concurrency: 'parallel' as const },
      execute: async () => {
        events.push(`start:${name}`);
        if (name === 'ParallelA' || name === 'ParallelB') {
          firstWaveStarted++;
          if (firstWaveStarted === 2) bothStarted.resolve();
          await waveRelease.promise;
        }
        events.push(`end:${name}`);
        return toolSuccess(name);
      },
    });
    registry.register(parallel('ParallelA'));
    registry.register(parallel('ParallelB'));
    registry.register({
      name: 'SerialC',
      description: 'SerialC',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        events.push('start:SerialC', 'end:SerialC');
        return toolSuccess('SerialC');
      },
    });
    registry.register(parallel('ParallelD'));
    const results: ToolResult[] = [];

    const run = runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'run tools',
      [],
      noopCallbacks({ onToolResult: (result) => results.push(result) }),
      'bypassPermissions',
    );
    await bothStarted.promise;
    expect(events).toEqual(expect.arrayContaining(['start:ParallelA', 'start:ParallelB']));
    expect(events.some((event) => event.startsWith('end:'))).toBe(false);
    waveRelease.resolve();
    await run;

    const firstWaveEnd = Math.max(events.indexOf('end:ParallelA'), events.indexOf('end:ParallelB'));
    expect(events.indexOf('start:SerialC')).toBeGreaterThan(firstWaveEnd);
    expect(events.indexOf('start:ParallelD')).toBeGreaterThan(events.indexOf('end:SerialC'));
    expect(results.map((result) => result.toolCallId)).toEqual([
      'parallel-a',
      'parallel-b',
      'serial-c',
      'parallel-d',
    ]);
  });

  it('publishes reverse-completing siblings in provider order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'slow-first', name: 'SlowFirst', arguments: '{}' },
              { id: 'fast-second', name: 'FastSecond', arguments: '{}' },
            ]),
            { status: 200 },
          ),
      ),
    );
    const registry = createRegistry();
    const slowRelease = deferred();
    const fastFinished = deferred();
    registry.register({
      name: 'SlowFirst',
      description: 'SlowFirst',
      parameters: { type: 'object', properties: {} },
      policy: { concurrency: 'parallel' },
      execute: async () => {
        await slowRelease.promise;
        return toolSuccess('slow');
      },
    });
    registry.register({
      name: 'FastSecond',
      description: 'FastSecond',
      parameters: { type: 'object', properties: {} },
      policy: { concurrency: 'parallel' },
      execute: async () => {
        fastFinished.resolve();
        return toolSuccess('fast');
      },
    });
    const results: ToolResult[] = [];
    const run = runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'run tools',
      [],
      noopCallbacks({ onToolResult: (result) => results.push(result) }),
      'bypassPermissions',
    );

    await fastFinished.promise;
    expect(results).toEqual([]);
    slowRelease.resolve();
    await run;
    expect(results.map((result) => result.toolCallId)).toEqual(['slow-first', 'fast-second']);
  });

  it('keeps successful siblings when another parallel call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'failed', name: 'FailingRead', arguments: '{}' },
              { id: 'succeeded', name: 'SuccessfulRead', arguments: '{}' },
            ]),
            { status: 200 },
          ),
      ),
    );
    const registry = createRegistry();
    registry.register({
      name: 'FailingRead',
      description: 'FailingRead',
      parameters: { type: 'object', properties: {} },
      policy: { concurrency: 'parallel' },
      execute: async () => {
        throw new Error('read failed');
      },
    });
    registry.register({
      name: 'SuccessfulRead',
      description: 'SuccessfulRead',
      parameters: { type: 'object', properties: {} },
      policy: { concurrency: 'parallel' },
      execute: async () => toolSuccess('kept'),
    });
    const results: ToolResult[] = [];

    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'run tools',
      [],
      noopCallbacks({ onToolResult: (result) => results.push(result) }),
      'bypassPermissions',
    );

    expect(results.map((result) => result.status)).toEqual(['error', 'success']);
    expect(results[1].content).toBe('kept');
  });

  it('rejects duplicate tool-call IDs before executing any sibling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'duplicate', name: 'FirstRead', arguments: '{}' },
              { id: 'duplicate', name: 'SecondRead', arguments: '{}' },
            ]),
            { status: 200 },
          ),
      ),
    );
    const registry = createRegistry();
    const execute = vi.fn(async () => toolSuccess('unexpected'));
    for (const name of ['FirstRead', 'SecondRead']) {
      registry.register({
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
        policy: { concurrency: 'parallel' },
        execute,
      });
    }
    const results: ToolResult[] = [];

    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'run tools',
      [],
      noopCallbacks({ onToolResult: (result) => results.push(result) }),
      'bypassPermissions',
    );

    expect(execute).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(
      results.every((result) => result.structuredError?.code === 'duplicate_tool_call_id'),
    ).toBe(true);
  });

  it('serializes permission preparation and gives parallel calls distinct trace IDs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([
              { id: 'first', name: 'PermissionReadA', arguments: '{}' },
              { id: 'second', name: 'PermissionReadB', arguments: '{}' },
            ]),
            { status: 200 },
          ),
      ),
    );
    const registry = createRegistry();
    const traceIds: string[] = [];
    for (const name of ['PermissionReadA', 'PermissionReadB']) {
      registry.register({
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
        policy: { concurrency: 'parallel' },
        execute: async (_args, context) => {
          traceIds.push(context.currentToolTraceId ?? '');
          return toolSuccess(name);
        },
      });
    }
    const permissionResolvers: Array<(result: 'allow') => void> = [];
    let activePrompts = 0;
    let maxActivePrompts = 0;
    const run = runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'run tools',
      [],
      noopCallbacks({
        onPermissionRequired: () => {
          activePrompts++;
          maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
          return new Promise((resolve) => {
            permissionResolvers.push((result) => {
              activePrompts--;
              resolve(result);
            });
          });
        },
      }),
      'default',
    );

    await vi.waitFor(() => expect(permissionResolvers).toHaveLength(1));
    permissionResolvers[0]('allow');
    await vi.waitFor(() => expect(permissionResolvers).toHaveLength(2));
    permissionResolvers[1]('allow');
    await run;

    expect(maxActivePrompts).toBe(1);
    expect(traceIds).toHaveLength(2);
    expect(traceIds[0]).not.toBe(traceIds[1]);
    expect(traceIds.every(Boolean)).toBe(true);
  });
});

describe('runAgentLoop accept-edits mode', () => {
  for (const toolName of ['ApplyPatch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
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
          return toolSuccess('ok');
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

  it('enforces hard-deny rules for ApplyPatch in accept-edits mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(toolCallStream([{ id: 'patch_1', name: 'ApplyPatch', arguments: '{}' }]), {
            status: 200,
          }),
      ),
    );
    const registry = createRegistry();
    let executed = false;
    registry.register({
      name: 'ApplyPatch',
      description: 'Apply patch',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        executed = true;
        return toolSuccess('ok');
      },
    });
    const cfg = defaultConfig({ maxTurns: 1 });
    cfg.settings.permissions.deny = ['ApplyPatch'];

    await runAgentLoop(cfg, registry, 'edit', [], noopCallbacks(), 'accept-edits');

    expect(executed).toBe(false);
  });
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
            toolCallStream([{ id: 'ask_1', name: 'AskUserQuestion', arguments: argumentsJson }]),
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
    expect(results[0]).toMatchObject({ status: 'success' });
    expect(results[0].content).toContain('Which database?: SQLite');
  });

  it('blocks questions in dontAsk mode before invoking the host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            toolCallStream([{ id: 'ask_1', name: 'AskUserQuestion', arguments: argumentsJson }]),
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
    expect(results[0].structuredError?.message).toMatch(/disabled in dontAsk/);
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
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
      execute: async () => {
        executed = true;
        return toolSuccess('read ok');
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
    expect(results[0]).toMatchObject({ status: 'success', content: 'read ok' });
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
        return toolSuccess('wrote');
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
    expect(results[0].status).toBe('blocked');
    expect(results[0].structuredError?.message).toMatch(/not allowed in plan mode/);
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
        return toolSuccess('entered');
      },
    });
    let writeExecuted = false;
    registry.register({
      name: 'Write',
      description: 'Write',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        writeExecuted = true;
        return toolSuccess('wrote');
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
    expect(results.map((r) => r.status)).toEqual(['success', 'blocked']);
    expect(results[1].structuredError?.message).toMatch(/not allowed in plan mode/);
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
      parameters: {
        type: 'object',
        properties: { plan: { type: 'string' } },
        required: ['plan'],
      },
      execute: async (_args, ctx) => {
        ctx.previousMode = 'default';
        ctx.pendingPlanApproval = { plan: 'Do it.' };
        return toolSuccess('submitted');
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
    expect(results[0]).toMatchObject({ status: 'success' });
    expect(results[0].content).toMatch(/Plan approved/);
  });

  it('hands off to a fresh context and stops the turn when approval is approve-fresh', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          toolCallStream([{ id: 'exit_1', name: 'ExitPlanMode', arguments: '{"plan":"Do it."}' }]),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const registry = createRegistry();
    registry.register({
      name: 'ExitPlanMode',
      description: 'Exit plan mode',
      parameters: {
        type: 'object',
        properties: { plan: { type: 'string' } },
        required: ['plan'],
      },
      execute: async (_args, ctx) => {
        ctx.previousMode = 'default';
        ctx.pendingPlanApproval = { plan: 'Do it.' };
        return toolSuccess('submitted');
      },
    });

    const modes: string[] = [];
    const handoffs: Array<{ plan: string; mode: string }> = [];
    const results: ToolResult[] = [];
    let approvalCalls = 0;
    // maxTurns:5 so a non-handoff approval WOULD re-invoke the model; the handoff
    // must stop after the first turn instead.
    await runAgentLoop(
      defaultConfig({ maxTurns: 5 }),
      registry,
      'plan',
      [],
      noopCallbacks({
        onModeChange: (newMode: string) => modes.push(newMode),
        onPlanApprovalRequired: async () => {
          approvalCalls++;
          return 'approve-fresh';
        },
        onPlanHandoff: (handoff) => handoffs.push(handoff),
        onToolResult: (result: ToolResult) => results.push(result),
      }),
      'plan',
    );

    expect(approvalCalls).toBe(1);
    // The turn ended after ExitPlanMode; the model was not called again in stale context.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handoffs).toEqual([{ plan: 'Do it.', mode: 'default' }]);
    expect(modes).toEqual(['default']);
    expect(results[0]).toMatchObject({ status: 'success' });
    expect(results[0].content).toMatch(/Handing off to a fresh context/);
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
      parameters: {
        type: 'object',
        properties: { plan: { type: 'string' } },
        required: ['plan'],
      },
      execute: async (_args, ctx) => {
        ctx.previousMode = 'default';
        ctx.pendingPlanApproval = { plan: 'Do it.' };
        return toolSuccess('submitted');
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
    expect(results[0].status).toBe('blocked');
    expect(results[0].structuredError?.message).toMatch(/Plan was not approved/);
  });

  it('returns plan adjustment feedback to the agent and stays in plan mode', async () => {
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
      parameters: {
        type: 'object',
        properties: { plan: { type: 'string' } },
        required: ['plan'],
      },
      execute: async (_args, ctx) => {
        ctx.previousMode = 'default';
        ctx.pendingPlanApproval = { plan: 'Do it.' };
        return toolSuccess('submitted');
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
        onPlanApprovalRequired: async () => ({
          decision: 'revise',
          feedback: 'Keep the migration backward compatible.',
        }),
        onToolResult: (result: ToolResult) => results.push(result),
      }),
      'plan',
    );

    expect(modes).toEqual([]);
    expect(results[0].status).toBe('blocked');
    expect(results[0].structuredError?.message).toContain('The user requested changes to the plan');
    expect(results[0].structuredError?.message).toContain(
      'Keep the migration backward compatible.',
    );
    expect(results[0].structuredError?.message).toContain('call ExitPlanMode again');
  });
});

describe('runAgentLoop alias-normalized permission enforcement', () => {
  it('applies path-scoped deny rules to alias-spelled ApplyPatch calls and does not count the block as a failure', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-alias-perm-'));
    try {
      writeFileSync(join(workspace, 'secret.txt'), 'top secret\n');
      const patchText =
        '*** Begin Patch\n*** Update File: secret.txt\n@@\n-top secret\n+leaked\n*** End Patch';
      const provider: Provider = {
        id: 'scripted',
        stream: async function* () {
          yield {
            type: 'tool_call' as const,
            toolCall: { id: 'alias-1', name: 'ApplyPatch', arguments: { input: patchText } },
          };
          yield { type: 'done' as const };
        },
      };
      const config = defaultConfig({ maxTurns: 1, workspace });
      config.settings.permissions.deny = ['ApplyPatch(secret.txt)'];
      const runtime = new SessionRuntime();

      const history = await runAgentLoop(
        config,
        createDefaultRegistry(),
        'apply the patch',
        [],
        noopCallbacks(),
        'default',
        { provider, isNewSession: false, runtime },
      );

      const result = history.at(-1)?.toolResults?.[0];
      expect(result?.status).toBe('blocked');
      expect(result?.structuredError?.code).toBe('permission_denied');
      expect(readFileSync(join(workspace, 'secret.txt'), 'utf-8')).toBe('top secret\n');
      // A user/policy block is not a tool failure in the reliability counters.
      expect(runtime.toolCallStats.get('ApplyPatch')?.calls).toBe(1);
      expect(runtime.toolCallStats.get('ApplyPatch')?.failures).toEqual({});
      runtime.dispose();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('runAgentLoop tool-call statistics', () => {
  it('records per-tool call and failure counters on the session runtime', async () => {
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        yield {
          type: 'tool_call' as const,
          toolCall: { id: 'stat-1', name: 'Echo', arguments: { value: 'ok' } },
        };
        yield {
          type: 'tool_call' as const,
          toolCall: { id: 'stat-2', name: 'Echo', arguments: { unexpected: true } },
        };
        yield { type: 'done' as const };
      },
    };
    const registry = createRegistry();
    registry.register({
      name: 'Echo',
      description: 'Return the provided value',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      execute: async (args) => toolSuccess(String(args.value ?? '')),
    });
    const runtime = new SessionRuntime();

    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      registry,
      'hello',
      [],
      noopCallbacks(),
      'default',
      { provider, isNewSession: false, runtime },
    );

    const echo = runtime.toolCallStats.get('Echo');
    expect(echo?.calls).toBe(2);
    expect(echo?.failures.invalid_arguments).toBe(1);
    runtime.dispose();
  });

  it('persists a tool-use telemetry record per call with final-status failure semantics', async () => {
    const telemetryRoot = mkdtempSync(join(tmpdir(), 'book-loop-tel-'));
    try {
      const provider: Provider = {
        id: 'scripted',
        stream: async function* () {
          yield {
            type: 'tool_call' as const,
            toolCall: { id: 'tel-1', name: 'Echo', arguments: { value: 'ok' } },
          };
          yield {
            type: 'tool_call' as const,
            toolCall: { id: 'tel-2', name: 'Echo', arguments: { unexpected: true } },
          };
          yield { type: 'done' as const };
        },
      };
      const registry = createRegistry();
      registry.register({
        name: 'Echo',
        description: 'Return the provided value',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        execute: async (args) => toolSuccess(String(args.value ?? '')),
      });
      const runtime = new SessionRuntime();

      await runAgentLoop(
        defaultConfig({ maxTurns: 1, model: 'test-model' }),
        registry,
        'hello',
        [],
        noopCallbacks(),
        'default',
        { provider, isNewSession: false, runtime, toolTelemetryRoot: telemetryRoot },
      );

      // Telemetry is written fire-and-forget; poll until the append settles.
      let records = await readToolUseRecords(telemetryRoot);
      for (let attempt = 0; attempt < 40 && records.length < 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        records = await readToolUseRecords(telemetryRoot);
      }
      expect(records).toHaveLength(2);
      expect(records.every((r) => r.tool === 'Echo' && r.session === runtime.traceId)).toBe(true);
      expect(records.every((r) => r.model === 'test-model')).toBe(true);
      const ok = records.find((r) => r.status === 'success');
      const failed = records.find((r) => r.isFailure);
      expect(ok?.isFailure).toBe(false);
      expect(failed?.status).toBe('error');
      expect(failed?.errorCode).toBe('invalid_arguments');
      runtime.dispose();
    } finally {
      rmSync(telemetryRoot, { recursive: true, force: true });
    }
  });

  it('does not persist telemetry when observability.toolTelemetry is disabled', async () => {
    const telemetryRoot = mkdtempSync(join(tmpdir(), 'book-loop-tel-off-'));
    try {
      const provider: Provider = {
        id: 'scripted',
        stream: async function* () {
          yield {
            type: 'tool_call' as const,
            toolCall: { id: 'off-1', name: 'Echo', arguments: { value: 'ok' } },
          };
          yield { type: 'done' as const };
        },
      };
      const registry = createRegistry();
      registry.register({
        name: 'Echo',
        description: 'Return the provided value',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        execute: async (args) => toolSuccess(String(args.value ?? '')),
      });
      const config = defaultConfig({ maxTurns: 1 });
      config.settings.observability.toolTelemetry = false;
      const runtime = new SessionRuntime();

      await runAgentLoop(config, registry, 'hello', [], noopCallbacks(), 'default', {
        provider,
        isNewSession: false,
        runtime,
        toolTelemetryRoot: telemetryRoot,
      });

      expect(await readToolUseRecords(telemetryRoot)).toEqual([]);
      runtime.dispose();
    } finally {
      rmSync(telemetryRoot, { recursive: true, force: true });
    }
  });
});
