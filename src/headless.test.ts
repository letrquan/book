import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import type { AgentConfig } from './types.js';

const config: AgentConfig = {
  apiKey: 'k',
  baseUrl: 'http://localhost/v1',
  model: 'm',
  maxTurns: 5,
  maxTokens: 128000,
  autoCompactEnabled: false,
  workspace: '.',
  animation: { typewriterSpeed: 3, spinnerStyle: 'braille' },
  accessibility: { screenReader: false, reducedMotion: false },
};

beforeEach(() => {
  // Fake provider: yields one text chunk then [DONE] with usage.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(
            enc.encode('data: {"choices":[{"delta":{"content":"Hello!"}}]}\n\n'),
          );
          c.enqueue(
            enc.encode(
              'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
            ),
          );
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }),
  );
});

describe('runHeadless — text output', () => {
  it('prints the final assistant text to stdout', async () => {
    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout,
    });
    expect(writes.join('')).toContain('Hello!');
  });
});

describe('runHeadless — json output', () => {
  it('emits one JSON object with messages and usage', async () => {
    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
    });
    const out = writes.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.result).toBeDefined();
    expect(parsed.result.usage.totalTokens).toBe(7);
    expect(parsed.result.messages.length).toBeGreaterThan(0);
  });
});

describe('runHeadless — stream-json output', () => {
  it('emits system, assistant, result events as newline-delimited JSON', async () => {
    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
    });
    const lines = writes.join('').split('\n').filter(Boolean);
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types[0]).toBe('system');
    expect(types).toContain('assistant');
    expect(types[types.length - 1]).toBe('result');
  });
});

describe('runHeadless — stream-json input', () => {
  it('reads newline-delimited user messages from stdin', async () => {
    const { Readable } = await import('stream');
    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    const stdin = Readable.from([
      JSON.stringify({ type: 'user', content: 'first' }) + '\n',
      JSON.stringify({ type: 'user', content: 'second' }) + '\n',
    ]);
    await runHeadless(config, createDefaultRegistry(), {
      inputFormat: 'stream-json',
      outputFormat: 'json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
      stdin,
    });
    const parsed = JSON.parse(writes.join('').trim());
    // Two prompts -> at least two assistant messages in history.
    const assistantCount = parsed.result.messages.filter(
      (m: { role: string }) => m.role === 'assistant',
    ).length;
    expect(assistantCount).toBeGreaterThanOrEqual(2);
  });
});

describe('runHeadless — json-schema', () => {
  it('returns validated JSON matching the schema', async () => {
    // Provider yields JSON content.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(
              enc.encode(
                'data: {"choices":[{"delta":{"content":"{\\"name\\":\\"book\\"}"}}]}\n\n',
              ),
            );
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'return json',
      inputFormat: 'text',
      outputFormat: 'json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
      jsonSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });
    const parsed = JSON.parse(writes.join('').trim());
    expect(parsed.result.structured).toEqual({ name: 'book' });
  });
});
