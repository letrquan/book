import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatCompletionStream, convertTools, parseCompatibleUsage } from './openai-compatible.js';
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
  it('emits provider-native reasoning deltas separately from answer text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(
              enc.encode('data: {"choices":[{"delta":{"reasoning_content":"inspect first"}}]}\n\n'),
            );
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    for await (const event of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'reasoning', reasoning: 'inspect first' },
        { type: 'text', content: 'answer' },
      ]),
    );
  });

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

  it('replays prior reasoning as delimited assistant context', async () => {
    const stream = chatCompletionStream(
      config,
      [
        { role: 'assistant', content: 'answer', reasoningContent: 'inspect first' },
        { role: 'user', content: 'continue' },
      ],
      [],
    );
    await drain(stream);
    expect(capturedBody.messages).toEqual([
      {
        role: 'assistant',
        content: '<reasoning_context>\ninspect first\n</reasoning_context>\nanswer',
      },
      { role: 'user', content: 'continue' },
    ]);
    expect(JSON.stringify(capturedBody)).not.toContain('reasoningContent');
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

  it('sends explicit reasoning effort for compatible reasoning models', async () => {
    const stream = chatCompletionStream(
      { ...config, effort: 'low', effortExplicit: true },
      [{ role: 'user', content: 'hi' }],
      [],
    );
    await drain(stream);
    expect(capturedBody.reasoning_effort).toBe('low');
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
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('stalled'),
        errorCode: 'stream_stall',
      }),
    );
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

describe('stall tolerance while reasoning', () => {
  // A stream whose first byte arrives after `delayMs` — an endpoint that buffers
  // the whole thinking block before emitting anything.
  //
  // A stall ceiling cancels the stream, and the client that would have read the
  // answer is often gone before the delay elapses. So the timer is cancelled
  // with the stream: `start` runs inside the constructor, which means the handle
  // is always in hand by the time `cancel` can fire. Left to run, the callback
  // enqueues into a closed controller and the `ERR_INVALID_STATE` throw lands
  // inside the timer, where no test can see it — vitest calls it an unhandled
  // error and fails the run.
  function quietThenAnswer(delayMs: number): ReadableStream {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        timer = setTimeout(() => {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        }, delayMs);
      },
      cancel() {
        clearTimeout(timer);
      },
    });
  }

  const stallRetry = {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 10,
    totalBudgetMs: 0,
    requestTimeoutMs: 0,
    streamStallTimeoutMs: 50,
    thinkingStallTimeoutMs: 30_000,
    toolRetries: 0,
    watchdog: false,
    streamReissueAttempts: 0,
    outputCapContinuations: 0,
  };

  async function collect(cfg: Parameters<typeof chatCompletionStream>[0]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(quietThenAnswer(200), { status: 200 })),
    );
    const events = [];
    for await (const e of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [])) {
      events.push(e);
    }
    return events;
  }

  it('gives a requested-reasoning stream the thinking ceiling, not the chat one', async () => {
    // The chat-tuned ceiling cancels a healthy high-effort request mid-thought and
    // reports stream_stall — the most common way a high-effort run "just stops".
    const events = await collect(
      defaultConfig({ retry: stallRetry, effortExplicit: true, effort: 'high' }),
    );

    expect(
      events.find((e) => e.type === 'error' && e.errorCode === 'stream_stall'),
    ).toBeUndefined();
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  it('gives a model whose catalog entry declares an effort range the thinking ceiling', async () => {
    // No reasoning_effort is sent here; the declaration is the only evidence
    // available before the silence starts.
    const events = await collect(
      defaultConfig({ retry: stallRetry, modelInfo: { effort: { default: 'high' } } }),
    );

    expect(
      events.find((e) => e.type === 'error' && e.errorCode === 'stream_stall'),
    ).toBeUndefined();
  });

  it('keeps the chat ceiling for a model that does not reason', async () => {
    const events = await collect(
      defaultConfig({ retry: stallRetry, modelInfo: { effort: false } }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', errorCode: 'stream_stall' }),
    );
  });

  it('keeps the chat ceiling for an unknown model with no effort requested', async () => {
    const events = await collect(defaultConfig({ retry: stallRetry }));

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', errorCode: 'stream_stall' }),
    );
  });

  it('stops writing once the client has cancelled the stream', async () => {
    // A stall ceiling is a cancel: the client gives up on a quiet stream while
    // the fixture is still counting down to its first byte. Nothing may write
    // after that. A pending timer that ignores the cancel fires against a closed
    // controller, and the throw lands in the timer callback where no test can
    // catch it — vitest reports it as an unhandled error and fails the whole
    // run for a stream that was discarded on purpose.
    const stream = quietThenAnswer(20);
    await stream.cancel();
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

describe('stall ceiling chosen per stream', () => {
  // A stream that writes each chunk on its own timer, so the fixture can hold a
  // silence open for a chosen interval.
  //
  // A stall ceiling is a cancel, so the fixture is usually abandoned while its
  // timers still run. `cancel` clears them and sets `stopped`, and every write
  // checks it: `enqueue` on a closed or cancelled controller throws
  // `ERR_INVALID_STATE` inside the timer callback, where no test can catch it,
  // and vitest counts it as an unhandled error (issue 315).
  function timedStream(steps: Array<{ afterMs: number; chunk: string }>): ReadableStream {
    const enc = new TextEncoder();
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let stopped = false;
    return new ReadableStream({
      start(c) {
        for (const step of steps) {
          timers.push(
            setTimeout(() => {
              if (!stopped) c.enqueue(enc.encode(step.chunk));
            }, step.afterMs),
          );
        }
        timers.push(
          setTimeout(
            () => {
              if (!stopped) c.close();
            },
            (steps.at(-1)?.afterMs ?? 0) + 10,
          ),
        );
      },
      cancel() {
        stopped = true;
        for (const timer of timers) clearTimeout(timer);
      },
    });
  }

  function sse(delta: Record<string, unknown>): string {
    return `data: {"choices":[{"delta":${JSON.stringify(delta)}}]}\n\n`;
  }

  /** Two hundred milliseconds is three chat ceilings and a rounding error of thinking. */
  const chatCeiling = { streamStallTimeoutMs: 50, thinkingStallTimeoutMs: 2000 };
  const reasoningThenPause = () =>
    timedStream([
      { afterMs: 0, chunk: sse({ reasoning_content: 'weighing the options' }) },
      { afterMs: 200, chunk: sse({ content: 'answer' }) },
      { afterMs: 210, chunk: 'data: [DONE]\n\n' },
    ]);
  const contentThenPause = () =>
    timedStream([
      { afterMs: 0, chunk: sse({ content: 'partial' }) },
      { afterMs: 200, chunk: sse({ content: ' and the rest' }) },
      { afterMs: 210, chunk: 'data: [DONE]\n\n' },
    ]);
  const reasoningThenContentThenPause = () =>
    timedStream([
      { afterMs: 0, chunk: sse({ reasoning_content: 'weighing the options' }) },
      { afterMs: 10, chunk: sse({ content: 'answer' }) },
      { afterMs: 210, chunk: 'data: [DONE]\n\n' },
    ]);
  const reasoningThenToolCallThenPause = () =>
    timedStream([
      { afterMs: 0, chunk: sse({ reasoning_content: 'weighing the options' }) },
      {
        afterMs: 10,
        chunk: sse({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read' } }] }),
      },
      { afterMs: 210, chunk: 'data: [DONE]\n\n' },
    ]);

  async function read(cfg: Parameters<typeof chatCompletionStream>[0], stream: ReadableStream) {
    let sent: Record<string, unknown> = {};
    const ceilings: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(stream, { status: 200 });
      }),
    );
    const events = [];
    for await (const event of chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }], [], {
      onStreamStall: (countdownMs) => ceilings.push(countdownMs),
    })) {
      events.push(event);
    }
    return { events, sent, ceilings };
  }

  it('keeps a reasoning stream alive through a pause past the chat ceiling (#379)', async () => {
    // A router that serves an uncatalogued reasoning model sends no
    // `reasoning_effort`, and no catalog entry is consulted, so `reasoningEnabled`
    // is false and the whole request sat on the 20s chat ceiling: the first
    // thinking pause longer than that cancelled a healthy stream and re-asked the
    // turn. The delta that arrives before the pause is the evidence the request
    // could not carry.
    const cfg = defaultConfig({ retry: { ...defaultConfig().retry, ...chatCeiling } });
    const { events, sent, ceilings } = await read(cfg, reasoningThenPause());

    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(cfg.effort).toBeUndefined();
    expect(cfg.modelInfo).toBeUndefined();
    expect(events).toContainEqual({ type: 'reasoning', reasoning: 'weighing the options' });
    expect(events).toContainEqual({ type: 'text', content: 'answer' });
    expect(ceilings).toEqual([]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'error', errorCode: 'stream_stall' }),
    );
  });

  it('still ends a stream that never reasons after the chat ceiling', async () => {
    // The promotion is evidence-driven, not a blanket raise: a stream with no
    // reasoning in it is a chat request and the chat ceiling still bounds it.
    const cfg = defaultConfig({ retry: { ...defaultConfig().retry, ...chatCeiling } });
    const { events, ceilings } = await read(cfg, contentThenPause());

    expect(events).toContainEqual({
      type: 'error',
      error: 'Stream stalled: no data received for 50ms',
      errorCode: 'stream_stall',
    });
    // The reported ceiling is the one in force when the stall fired.
    expect(ceilings).toEqual([50]);
  });

  it('drops back to the chat ceiling once the stream starts answering (#379)', async () => {
    // The promotion buys the thinking phase only. Holding it for the rest of the
    // stream gave a hang in the answer phase — a dead socket mid-sentence, the
    // commonest fault there is — up to fifteen minutes to be noticed instead of
    // twenty seconds, and the answer phase is not thinking.
    const cfg = defaultConfig({ retry: { ...defaultConfig().retry, ...chatCeiling } });
    const { events, ceilings } = await read(cfg, reasoningThenContentThenPause());

    expect(events).toContainEqual({ type: 'reasoning', reasoning: 'weighing the options' });
    expect(events).toContainEqual({ type: 'text', content: 'answer' });
    expect(events).toContainEqual({
      type: 'error',
      error: 'Stream stalled: no data received for 50ms',
      errorCode: 'stream_stall',
    });
    expect(ceilings).toEqual([50]);
  });

  it('drops back to the chat ceiling once the stream starts calling tools (#379)', async () => {
    // A tool call is the answer phase too, and it is where a stall is most
    // expensive: the turn is waiting on a function call that is not coming.
    const cfg = defaultConfig({ retry: { ...defaultConfig().retry, ...chatCeiling } });
    const { events, ceilings } = await read(cfg, reasoningThenToolCallThenPause());

    expect(events).toContainEqual({ type: 'reasoning', reasoning: 'weighing the options' });
    // No tool_call event: the stall lands before `[DONE]`, which is where the
    // assembled call would have been emitted. What matters is the ceiling.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', errorCode: 'stream_stall' }),
    );
    expect(ceilings).toEqual([50]);
  });

  // The first-delta ceiling (#379 tail): a router that buffers the model's
  // thinking sends a role-only first chunk and then nothing for up to about
  // 80 s, so the chat ceiling cancels a healthy request before its first
  // meaningful delta. Chat 50 ms / first-delta 400 ms / thinking 2000 ms here.
  const chatCeilingPlusFirstDelta = { ...chatCeiling, firstDeltaStallTimeoutMs: 400 };

  /** A role-only delta, an empty content string, and a usage-only chunk: none of them is an answer. */
  const nonMeaningfulThenContentThenDone = () =>
    timedStream([
      { afterMs: 0, chunk: sse({ role: 'assistant' }) },
      { afterMs: 10, chunk: sse({ content: '' }) },
      {
        afterMs: 20,
        chunk:
          'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      },
      { afterMs: 200, chunk: sse({ content: 'answer' }) },
      { afterMs: 210, chunk: 'data: [DONE]\n\n' },
    ]);
  /** The first meaningful delta lands past the chat ceiling but inside the first-delta one. */
  const roleOnlyThenContentThenDone = () =>
    timedStream([
      { afterMs: 0, chunk: sse({ role: 'assistant' }) },
      { afterMs: 200, chunk: sse({ content: 'answer' }) },
      { afterMs: 210, chunk: 'data: [DONE]\n\n' },
    ]);

  it('holds an uncatalogued model past the chat ceiling until its first delta (#379)', async () => {
    // The router sends a role-only chunk, then buffers the thinking block: the
    // pause outruns the chat ceiling but not the first-delta one, so the
    // request completes instead of being cancelled as a stall.
    const cfg = defaultConfig({
      retry: { ...defaultConfig().retry, ...chatCeilingPlusFirstDelta },
    });
    const { events, ceilings, sent } = await read(cfg, nonMeaningfulThenContentThenDone());

    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(events).toContainEqual({ type: 'text', content: 'answer' });
    expect(ceilings).toEqual([]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'error', errorCode: 'stream_stall' }),
    );
  });

  it('holds a model whose catalog entry has no effort key the same way (#379)', async () => {
    // An entry like `{}` says nothing about effort: the same unknown-model
    // regime, and the same first-delta ceiling.
    const cfg = defaultConfig({
      retry: { ...defaultConfig().retry, ...chatCeilingPlusFirstDelta },
      modelInfo: {},
    });
    const { events, ceilings } = await read(cfg, roleOnlyThenContentThenDone());

    expect(events).toContainEqual({ type: 'text', content: 'answer' });
    expect(ceilings).toEqual([]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'error', errorCode: 'stream_stall' }),
    );
  });

  it('still ends an answering stream at the chat ceiling (#379)', async () => {
    // Content arrives first, so the first-delta ceiling is spent: the answer
    // phase is judged by the chat ceiling, as it always was.
    const cfg = defaultConfig({
      retry: { ...defaultConfig().retry, ...chatCeilingPlusFirstDelta },
    });
    const { events, ceilings } = await read(cfg, contentThenPause());

    expect(events).toContainEqual({
      type: 'error',
      error: 'Stream stalled: no data received for 50ms',
      errorCode: 'stream_stall',
    });
    expect(ceilings).toEqual([50]);
  });

  it('stalls at the first-delta ceiling when even it is outlasted (#379)', async () => {
    const cfg = defaultConfig({
      retry: { ...defaultConfig().retry, ...chatCeilingPlusFirstDelta },
    });
    const { events, ceilings } = await read(cfg, roleOnlyThenContentThenDoneWithLongPause());

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', errorCode: 'stream_stall' }),
    );
    // The reported ceiling is the first-delta one, not the chat one.
    expect(ceilings).toEqual([400]);
    expect(events).toContainEqual({
      type: 'error',
      error: 'Stream stalled: no data received for 400ms',
      errorCode: 'stream_stall',
    });
  });

  it('keeps the chat ceiling for a model whose entry says effort false (#379)', async () => {
    // The catalog entry is the evidence: a model that never reasons has no
    // silent thinking to protect, so the chat ceiling applies from the start.
    const cfg = defaultConfig({
      retry: { ...defaultConfig().retry, ...chatCeilingPlusFirstDelta },
      modelInfo: { effort: false },
    });
    const { events, ceilings } = await read(cfg, roleOnlyThenContentThenDone());

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', errorCode: 'stream_stall' }),
    );
    expect(ceilings).toEqual([50]);
  });

  it('ends first-delta grace on a reasoning delta and uses the thinking ceiling (#399)', async () => {
    // When thinkingStallTimeoutMs (150 ms) is lower than firstDeltaStallTimeoutMs (400 ms),
    // a reasoning delta must end the first-delta grace and set the thinking ceiling
    // (max(chat, thinking) = 150 ms), not keep the 400 ms first-delta ceiling.
    const cfg = defaultConfig({
      retry: {
        ...defaultConfig().retry,
        streamStallTimeoutMs: 60,
        thinkingStallTimeoutMs: 150,
        firstDeltaStallTimeoutMs: 400,
      },
    });
    const reasoningThenSilence = timedStream([
      { afterMs: 0, chunk: sse({ role: 'assistant' }) },
      { afterMs: 10, chunk: sse({ reasoning_content: 'thinking...' }) },
      { afterMs: 260, chunk: sse({ content: 'answer' }) },
      { afterMs: 270, chunk: 'data: [DONE]\n\n' },
    ]);
    const { events, ceilings } = await read(cfg, reasoningThenSilence);

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', errorCode: 'stream_stall' }),
    );
    expect(ceilings).toEqual([150]);
    expect(events).toContainEqual({
      type: 'error',
      error: 'Stream stalled: no data received for 150ms',
      errorCode: 'stream_stall',
    });
  });

  function roleOnlyThenContentThenDoneWithLongPause() {
    return timedStream([
      { afterMs: 0, chunk: sse({ role: 'assistant' }) },
      { afterMs: 500, chunk: sse({ content: 'answer' }) },
      { afterMs: 510, chunk: 'data: [DONE]\n\n' },
    ]);
  }
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
    expect(events).toEqual([]);
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
    expect(err?.errorCode).toBe('timeout');
  });
});

describe('chatCompletionStream terminal framing', () => {
  it('reports transport interruption when EOF arrives without completion evidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
            );
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    for await (const event of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text', content: 'partial' },
      {
        type: 'error',
        error: 'Provider stream ended before its terminal event.',
        errorCode: 'transport_interrupted',
      },
    ]);
  });

  it('accepts [DONE] without a trailing newline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"complete"}}]}\n\n'),
            );
            controller.enqueue(encoder.encode('data: [DONE]'));
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    for await (const event of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text', content: 'complete' },
      { type: 'done', usage: undefined },
    ]);
  });

  it('accepts EOF after a finish reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"id":"resp-1","model":"compat-model","choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}',
              ),
            );
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    for await (const event of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text', content: 'complete' },
      {
        type: 'done',
        usage: undefined,
        responseModel: 'compat-model',
        responseId: 'resp-1',
        finishReasons: ['stop'],
      },
    ]);
  });

  it('emits completed tool calls when EOF follows a tool_calls finish reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"filePath\\":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'),
            );
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    for await (const event of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'tool_call',
        toolCall: { id: 'call_1', name: 'Read', arguments: { filePath: 'README.md' } },
      },
      { type: 'done', usage: undefined, finishReasons: ['tool_calls'] },
    ]);
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

  it('marks arguments that never parsed with the typed unparsedArguments field', async () => {
    // The `{__raw}` sentinel is gone: `arguments` stays `{}` and the raw text and
    // the parse error ride in `unparsedArguments`, so no consumer has to sniff
    // the arguments object for a magic key.
    const raw = '{"filePath":"src/a.ts","oldString":"const re = /\\d+/;"}';
    let parseError = '';
    try {
      JSON.parse(raw);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(
              enc.encode(
                `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Edit","arguments":${JSON.stringify(raw)}}}]},"finish_reason":"tool_calls"}]}\n\n`,
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
      {
        id: 'call_1',
        name: 'Edit',
        arguments: {},
        unparsedArguments: { raw, error: parseError },
      },
    ]);
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

  it('preserves response identity and finish reason metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(
              enc.encode(
                'data: {"id":"resp-1","model":"gpt-5-2026-01","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
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
    for await (const event of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      responseId: 'resp-1',
      responseModel: 'gpt-5-2026-01',
      finishReasons: ['stop'],
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

describe('non-retryable error bodies (#244 review)', () => {
  it('reads at most 64 KB of a non-retryable error body', async () => {
    let pulled = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (pulled >= 10 * 1024 * 1024) {
                  controller.close();
                  return;
                }
                const chunk = new TextEncoder().encode('x'.repeat(16_384));
                pulled += chunk.byteLength;
                controller.enqueue(chunk);
              },
            }),
            { status: 400 },
          ),
      ),
    );
    const events = [];
    for await (const event of chatCompletionStream(config, [{ role: 'user', content: 'hi' }], [])) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: 'error', errorCode: 'bad_request' });
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 3 * 16_384);
  });
});

describe('parseCompatibleUsage', () => {
  it('maps a usage without cache tokens exactly as before', () => {
    expect(
      parseCompatibleUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
    ).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(parseCompatibleUsage(undefined)).toBeNull();
  });

  it('splits OpenAI cached_tokens out of prompt_tokens', () => {
    expect(
      parseCompatibleUsage({
        prompt_tokens: 1000,
        completion_tokens: 5,
        total_tokens: 1005,
        prompt_tokens_details: { cached_tokens: 800 },
      }),
    ).toEqual({
      promptTokens: 200,
      completionTokens: 5,
      totalTokens: 1005,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 0,
    });
  });

  it("reads 9router's cache_creation_tokens and OpenRouter's cache_write_tokens as writes", () => {
    expect(
      parseCompatibleUsage({
        prompt_tokens: 1000,
        completion_tokens: 1,
        total_tokens: 1001,
        prompt_tokens_details: { cache_creation_tokens: 700 },
      }),
    ).toMatchObject({ promptTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 700 });
    expect(
      parseCompatibleUsage({
        prompt_tokens: 1000,
        completion_tokens: 1,
        total_tokens: 1001,
        prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 600 },
      }),
    ).toMatchObject({
      promptTokens: 300,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 600,
    });
  });

  it("reads DeepSeek's prompt_cache_hit_tokens", () => {
    expect(
      parseCompatibleUsage({
        prompt_tokens: 1000,
        completion_tokens: 2,
        total_tokens: 1002,
        prompt_cache_hit_tokens: 600,
        prompt_cache_miss_tokens: 400,
      }),
    ).toMatchObject({ promptTokens: 400, cacheReadInputTokens: 600 });
    expect(
      parseCompatibleUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 600 })?.contextTokens,
    ).toBeUndefined();
  });

  it('adds Anthropic-shaped top-level cache counts on top of prompt_tokens', () => {
    expect(
      parseCompatibleUsage({
        prompt_tokens: 50,
        completion_tokens: 3,
        total_tokens: 53,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      }),
    ).toEqual({
      promptTokens: 50,
      completionTokens: 3,
      totalTokens: 53,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 100,
      contextTokens: 1050,
    });
    // Smaller than the uncached input, still on top: the source decides, not the size.
    expect(
      parseCompatibleUsage({
        prompt_tokens: 1000,
        completion_tokens: 3,
        total_tokens: 1003,
        cache_creation_input_tokens: 800,
      }),
    ).toEqual({
      promptTokens: 1000,
      completionTokens: 3,
      totalTokens: 1003,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 800,
      contextTokens: 1800,
    });
  });

  it('reads LiteLLM top-level cache writes as part of a normalised prompt_tokens', () => {
    expect(
      parseCompatibleUsage({
        prompt_tokens: 1000,
        completion_tokens: 4,
        total_tokens: 1004,
        prompt_tokens_details: { cached_tokens: 600 },
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 300,
      }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 4,
      totalTokens: 1004,
      cacheReadInputTokens: 600,
      cacheCreationInputTokens: 300,
    });
  });

  it('counts Anthropic top-level cache on top only when no OpenAI-style cache field is present', () => {
    // An empty details object says nothing about the cache: counted on top.
    expect(
      parseCompatibleUsage({
        prompt_tokens: 1000,
        completion_tokens: 2,
        total_tokens: 1002,
        prompt_tokens_details: {},
        cache_read_input_tokens: 400,
      }),
    ).toMatchObject({ promptTokens: 1000, cacheReadInputTokens: 400, contextTokens: 1400 });
    // LiteLLM's cold turn: `cached_tokens: 0` beside the write says prompt_tokens includes it.
    expect(
      parseCompatibleUsage({
        prompt_tokens: 60000,
        completion_tokens: 20,
        total_tokens: 60020,
        prompt_tokens_details: { cached_tokens: 0 },
        cache_creation_input_tokens: 58000,
      }),
    ).toEqual({
      promptTokens: 2000,
      completionTokens: 20,
      totalTokens: 60020,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 58000,
    });
  });

  it('derives total_tokens when a provider omits it', () => {
    expect(parseCompatibleUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(
      parseCompatibleUsage({
        prompt_tokens: 150000,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 150000 },
      }),
    ).toMatchObject({ promptTokens: 0, totalTokens: 150300, cacheReadInputTokens: 150000 });
  });

  it("reads Moonshot's top-level cached_tokens and DashScope's cache writes as included", () => {
    expect(
      parseCompatibleUsage({
        prompt_tokens: 1000,
        completion_tokens: 1,
        total_tokens: 1001,
        cached_tokens: 700,
      }),
    ).toEqual({
      promptTokens: 300,
      completionTokens: 1,
      totalTokens: 1001,
      cacheReadInputTokens: 700,
      cacheCreationInputTokens: 0,
    });
    expect(
      parseCompatibleUsage({
        prompt_tokens: 1000,
        completion_tokens: 1,
        total_tokens: 1001,
        prompt_tokens_details: { cache_creation_input_tokens: 900 },
      }),
    ).toMatchObject({ promptTokens: 100, cacheCreationInputTokens: 900 });
  });

  it('carries cache tokens through the stream into the done event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
            c.enqueue(
              enc.encode(
                'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":5,"total_tokens":1005,"prompt_tokens_details":{"cached_tokens":800}}}\n\n',
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
    expect(events.find((e) => e.type === 'done')?.usage).toMatchObject({
      promptTokens: 200,
      cacheReadInputTokens: 800,
    });
  });
});
