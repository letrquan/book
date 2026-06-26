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
