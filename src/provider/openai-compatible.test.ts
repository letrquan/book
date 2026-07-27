import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatCompletionStream, convertTools } from './openai-compatible.js';
import { patchTools } from '../tools/patch.js';
import { defaultConfig } from '../test/fixtures.js';

const config = defaultConfig({ maxTurns: 25, baseUrl: 'http://localhost/v1' });

let capturedBody: Record<string, unknown>;

beforeEach(() => {
  capturedBody = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }),
  );
});

describe('chatCompletionStream request body', () => {
  it('serializes image content parts as data URLs', async () => {
    const stream = chatCompletionStream(
      config,
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is shown?' },
            { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
          ],
        },
      ],
      [],
    );
    await drain(stream);
    expect(capturedBody.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is shown?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
        ],
      },
    ]);
  });

  it('does not send max_turns (not an OpenAI param)', async () => {
    const stream = chatCompletionStream(config, [{ role: 'user', content: 'hi' }], []);
    await drain(stream);
    expect(capturedBody).not.toHaveProperty('max_turns');
    expect(capturedBody).not.toHaveProperty('maxTurns');
    expect(capturedBody.model).toBe('m');
    expect(capturedBody.stream).toBe(true);
  });

  it('includes stream_options.include_usage so usage is reported', async () => {
    const stream = chatCompletionStream(config, [{ role: 'user', content: 'hi' }], []);
    await drain(stream);
    expect(capturedBody.stream_options).toEqual({ include_usage: true });
  });

  it('omits max_tokens when only the generic default is present', async () => {
    const stream = chatCompletionStream(config, [{ role: 'user', content: 'hi' }], []);
    await drain(stream);
    expect(capturedBody).not.toHaveProperty('max_tokens');
  });

  it('sends explicit max_tokens', async () => {
    const stream = chatCompletionStream(
      { ...config, maxTokens: 4096, maxTokensExplicit: true },
      [{ role: 'user', content: 'hi' }],
      [],
    );
    await drain(stream);
    expect(capturedBody.max_tokens).toBe(4096);
  });
});

// Helper: create a readable stream that yields text events then [DONE].
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

// Helper: create a stream that hangs (never resolves).
function hangingStream(): ReadableStream {
  return new ReadableStream({
    start() {
      // Never enqueue anything — simulates a stalled connection.
    },
  });
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) void event;
}

describe('chatCompletionStream retry — status codes', () => {
  it('retries on 429 then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls < 3) {
          return new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': '0' },
          });
        }
        return new Response(textStream('ok'), { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(3);
    expect(events.some((e) => e.type === 'text' && e.content === 'ok')).toBe(true);
  });

  it('retries on 500 and succeeds on 2nd attempt', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return new Response('server error', { status: 500 });
        }
        return new Response(textStream('recovered'), { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'text' && e.content === 'recovered')).toBe(true);
  });

  it('retries on 503 and succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls < 3) {
          return new Response('unavailable', { status: 503 });
        }
        return new Response(textStream('ok'), { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(3);
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  it('retries on 408 and succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return new Response('timeout', { status: 408 });
        }
        return new Response(textStream('ok'), { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  it('retries on 529 and succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls < 2) {
          return new Response('overloaded', { status: 529 });
        }
        return new Response(textStream('ok'), { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  it('does NOT retry on 400 (bad request)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('bad request', { status: 400 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(1); // no retry on 400
    expect(events.some((e) => e.type === 'error' && e.error?.includes('400'))).toBe(true);
  });

  it('does NOT retry on 401 (unauthorized)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('unauthorized', { status: 401 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === 'error' && e.error?.includes('401'))).toBe(true);
  });

  it('does NOT retry on 403 (forbidden)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('forbidden', { status: 403 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === 'error' && e.error?.includes('403'))).toBe(true);
  });

  it('does NOT retry on 404 (not found)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('not found', { status: 404 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === 'error' && e.error?.includes('404'))).toBe(true);
  });

  it('yields error after exhausting retries on persistent 500', async () => {
    const cfg = defaultConfig({
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 10,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
        streamStallTimeoutMs: 0,
        toolRetries: 0,
        watchdog: false,
      },
    });
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('server error', { status: 500 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    // initial + 2 retries = 3 total
    expect(calls).toBe(3);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('yields formatted error message on persistent 429', async () => {
    const cfg = defaultConfig({
      retry: {
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 10,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
        streamStallTimeoutMs: 0,
        toolRetries: 0,
        watchdog: false,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('rate limited', { status: 429 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    const err = events.find((e) => e.type === 'error');
    expect(err?.error).toMatch(/API Error: 429/);
    expect(err?.error).toMatch(/temporary capacity/i);
  });
});

describe('chatCompletionStream retry — network errors', () => {
  it('retries on fetch rejection (network error) then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls < 2) {
          throw new Error('ECONNREFUSED');
        }
        return new Response(textStream('ok'), { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  it('yields error after all network retries exhausted', async () => {
    const cfg = defaultConfig({
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 10,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
        streamStallTimeoutMs: 0,
        toolRetries: 0,
        watchdog: false,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(events.some((e) => e.type === 'error' && e.error?.includes('ECONNREFUSED'))).toBe(true);
  });
});

describe('chatCompletionStream retry — callbacks', () => {
  it('calls onRetry callback with attempt numbers during retry', async () => {
    const retryCalls: Array<{ attempt: number; max: number; delayMs: number }> = [];
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

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [], {
      onRetry: (attempt, max, delayMs) => {
        retryCalls.push({ attempt, max, delayMs });
      },
    })) {
      events.push(e);
    }
    expect(retryCalls.length).toBe(2); // two retry attempts
    expect(retryCalls[0].attempt).toBe(1);
    expect(retryCalls[1].attempt).toBe(2);
    expect(retryCalls[0].max).toBe(3); // default 3 from test fixture
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  it('calls onStreamStall and yields error when stream hangs', async () => {
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
    let stallFired = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(hangingStream(), { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [], {
      onStreamStall: () => {
        stallFired = true;
      },
    })) {
      events.push(e);
    }
    expect(stallFired).toBe(true);
    expect(events.some((e) => e.type === 'error' && e.error?.includes('stalled'))).toBe(true);
  });

  it('does not fire stall for streams that deliver data quickly', async () => {
    const cfg = defaultConfig({
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 10,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
        streamStallTimeoutMs: 1000,
        toolRetries: 0,
        watchdog: false,
      },
    });
    let stallFired = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(textStream('ok'), { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [], {
      onStreamStall: () => {
        stallFired = true;
      },
    })) {
      events.push(e);
    }
    expect(stallFired).toBe(false);
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });
});

describe('chatCompletionStream retry — edge cases', () => {
  it('stops retrying when user aborts via signal', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('err', { status: 500 });
      }),
    );

    const controller = new AbortController();
    controller.abort();

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [], {
      signal: controller.signal,
    })) {
      events.push(e);
    }
    expect(calls).toBe(1);
  });

  it('does not retry when maxAttempts is 0', async () => {
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
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('err', { status: 500 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    expect(calls).toBe(1); // one attempt, no retries
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('formats auth error with recovery hint', async () => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('{"error":{"message":"Invalid API key"}}', { status: 401 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    const err = events.find((e) => e.type === 'error');
    expect(err?.error).toMatch(/API Error: 401/);
    expect(err?.error).toMatch(/BOOK_API_KEY/);
    expect(err?.error).toMatch(/Invalid API key/);
  });

  it('formats overloaded error with recovery hint', async () => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('overloaded', { status: 529 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    const err = events.find((e) => e.type === 'error');
    expect(err?.error).toMatch(/API Error: 529/);
    expect(err?.error).toMatch(/at capacity/i);
  });

  it('formats server error with recovery hint', async () => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('boom', { status: 500 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    const err = events.find((e) => e.type === 'error');
    expect(err?.error).toMatch(/API Error: 500/);
    expect(err?.error).toMatch(/server-side issue/i);
  });

  it('formats timeout message', async () => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('timeout', { status: 408 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    const err = events.find((e) => e.type === 'error');
    expect(err?.error).toMatch(/timed out/i);
  });
});

describe('chatCompletionStream tool call streaming', () => {
  it('reconstructs multiple interleaved tool calls by index', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(
              enc.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"filePath\\":\\"a"}},{"index":1,"id":"call_2","function":{"name":"Grep","arguments":"{\\"pattern\\":\\"needle"}}]}}]}\n\n',
              ),
            );
            c.enqueue(
              enc.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".txt\\"}"}},{"index":1,"function":{"arguments":"\\",\\"path\\":\\"src\\"}"}}]}}]}\n\n',
              ),
            );
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }

    const calls = events.filter((e) => e.type === 'tool_call').map((e) => e.toolCall);
    expect(calls).toEqual([
      { id: 'call_1', name: 'Read', arguments: { filePath: 'a.txt' } },
      { id: 'call_2', name: 'Grep', arguments: { pattern: 'needle', path: 'src' } },
    ]);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('does not hang when an already-open stream is aborted', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(hangingStream(), { status: 200 })),
    );

    setTimeout(() => controller.abort(), 10);
    const events = [];
    for await (const e of chatCompletionStream(
      defaultConfig({
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
      }),
      [{ role: 'user', content: 'hi' }],
      [],
      { signal: controller.signal },
    )) {
      events.push(e);
    }

    expect(events).toEqual([]);
  });
});

describe('chatCompletionStream usage', () => {
  it('emits a done event with usage from the final chunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
            c.enqueue(
              enc.encode(
                'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
              ),
            );
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    const done = events.find((e) => e.type === 'done');
    expect(done?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });
});
describe('OpenAI-compatible tool contracts', () => {
  it('preserves the compact ApplyPatch string schema', () => {
    const converted = convertTools(patchTools);
    expect(converted[0].function).toMatchObject({
      name: 'ApplyPatch',
      parameters: {
        type: 'object',
        required: ['patch'],
        properties: { patch: { type: 'string' } },
      },
    });
  });

  it('preserves ApplyPatch text in streamed tool arguments', async () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const payload = JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'patch-1',
                    function: { name: 'ApplyPatch', arguments: JSON.stringify({ patch }) },
                  },
                ],
              },
            },
          ],
        });
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\ndata: [DONE]\n\n`));
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );
    const events = [];
    for await (const event of chatCompletionStream(
      config,
      [{ role: 'user', content: 'patch' }],
      patchTools,
    ))
      events.push(event);
    expect(events.find((event) => event.type === 'tool_call')?.toolCall?.arguments).toEqual({
      patch,
    });
  });
});
