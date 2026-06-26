import { describe, it, expect, vi } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createRegistry } from '../tools/registry.js';
import type { AgentConfig } from '../types.js';

const config: AgentConfig = {
  apiKey: 'k',
  baseUrl: 'http://x/v1',
  model: 'm',
  maxTurns: 5,
  workspace: '.',
  animation: { typewriterSpeed: 3, spinnerStyle: 'braille' },
  accessibility: { screenReader: false, reducedMotion: false },
  tools: { browser: { enabled: false, headless: true }, design: { enabled: false } },
};

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
      undefined,
      { signal: controller.signal },
    );

    // Aborted mid-stream: we should NOT have looped into more turns.
    expect(seen.length).toBeLessThanOrEqual(3);
  });
});
