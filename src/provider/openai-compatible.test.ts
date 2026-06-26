import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatCompletionStream } from './openai-compatible.js';
import type { AgentConfig } from '../types.js';

const config: AgentConfig = {
  apiKey: 'k',
  baseUrl: 'http://localhost/v1',
  model: 'm',
  maxTurns: 25,
  workspace: '.',
  animation: { typewriterSpeed: 3, spinnerStyle: 'braille' },
  accessibility: { screenReader: false, reducedMotion: false },
  tools: { browser: { enabled: false, headless: true }, design: { enabled: false } },
};

let capturedBody: any;

beforeEach(() => {
  capturedBody = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
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
  it('does not send max_turns (not an OpenAI param)', async () => {
    const stream = chatCompletionStream(config, [{ role: 'user', content: 'hi' }], []);
    for await (const _ of stream) {
      /* drain */
    }
    expect(capturedBody).not.toHaveProperty('max_turns');
    expect(capturedBody).not.toHaveProperty('maxTurns');
    expect(capturedBody.model).toBe('m');
    expect(capturedBody.stream).toBe(true);
  });

  it('includes stream_options.include_usage so usage is reported', async () => {
    const stream = chatCompletionStream(config, [{ role: 'user', content: 'hi' }], []);
    for await (const _ of stream) {
      /* drain */
    }
    expect(capturedBody.stream_options).toEqual({ include_usage: true });
  });
});

describe('chatCompletionStream retry', () => {
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
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(
              enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
            );
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(
      config,
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
      events.push(e);
    }
    expect(calls).toBe(3);
    expect(events.some((e) => e.type === 'text' && e.content === 'ok')).toBe(true);
  });

  it('yields an error after exhausting retries', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('rate limited', { status: 429 });
      }),
    );

    const events = [];
    for await (const e of chatCompletionStream(
      config,
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
      events.push(e);
    }
    expect(calls).toBe(4); // initial + 3 retries
    expect(events.some((e) => e.type === 'error')).toBe(true);
  }, 15000); // real backoff 1s+2s+4s = 7s
});

describe('chatCompletionStream usage', () => {
  it('emits a done event with usage from the final chunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(
              enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
            );
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
    for await (const e of chatCompletionStream(
      config,
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
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
