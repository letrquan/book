import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import type { AgentConfig } from './types/runtime.js';

// Pin Book's home: a run writes its liveness file under it, and the real one is the
// developer's own ~/.book.
const previousBookHome = process.env.BOOK_HOME;
let bookHome: string;

beforeEach(() => {
  bookHome = mkdtempSync(join(tmpdir(), 'book-home-'));
  process.env.BOOK_HOME = bookHome;
});

afterEach(() => {
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
  rmSync(bookHome, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** A stream that delivers some text and then drops the connection. */
function droppedStream(): Response {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial ' } }] })}\n\n`,
        ),
      );
      c.error(new TypeError('terminated'));
    },
  });
  return new Response(body, { status: 200 });
}

function textDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function config(retry: Partial<AgentConfig['retry']> = {}): AgentConfig {
  // The home doubles as the workspace, so nothing lands in the repository either.
  const base = defaultConfig({ baseUrl: 'http://localhost/v1', workspace: bookHome });
  return { ...base, retry: { ...base.retry, ...retry } };
}

interface RetryRecord {
  type: 'retry';
  phase: string;
  attempt: number;
  max: number | null;
  delay_ms: number;
  reason?: string;
}

async function retryRecords(runConfig: AgentConfig): Promise<RetryRecord[]> {
  const writes: string[] = [];
  await runHeadless(runConfig, createDefaultRegistry(), {
    prompt: 'go',
    inputFormat: 'text',
    outputFormat: 'stream-json',
    history: [],
    mode: 'bypassPermissions',
    stdout: {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    },
  });
  return writes
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string })
    .filter((record): record is RetryRecord => record.type === 'retry');
}

describe('runHeadless — the stream-json retry record (#244)', () => {
  it('reports an HTTP-level retry inside one request as phase transport', async () => {
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        if (request === 1) return new Response('busy', { status: 503 });
        return sse([textDelta('ok')]);
      }),
    );

    const records = await retryRecords(config({ maxAttempts: 3 }));

    expect(records).toEqual([
      { type: 'retry', phase: 'transport', attempt: 1, max: 3, delay_ms: expect.any(Number) },
    ]);
  });

  it('reports a re-sent turn as phase reissue, with the reason it was re-sent', async () => {
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        if (request === 1) return droppedStream();
        return sse([textDelta('ok')]);
      }),
    );

    const records = await retryRecords(config({ streamReissueAttempts: 2 }));

    expect(records).toEqual([
      {
        type: 'retry',
        phase: 'reissue',
        attempt: 1,
        max: 2,
        delay_ms: expect.any(Number),
        reason: 'provider_error',
      },
    ]);
  });

  it('reports max null when the watchdog retries without a limit', async () => {
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        if (request === 1) return new Response('rate limited', { status: 429 });
        return sse([textDelta('ok')]);
      }),
    );

    const records = await retryRecords(config({ watchdog: true, maxAttempts: 3 }));

    expect(records).toEqual([
      { type: 'retry', phase: 'watchdog', attempt: 1, max: null, delay_ms: expect.any(Number) },
    ]);
  });

  it('reports a watchdog retry of a 503 as unbounded too', async () => {
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        if (request === 1) return new Response('busy', { status: 503 });
        return sse([textDelta('ok')]);
      }),
    );

    const records = await retryRecords(config({ watchdog: true, maxAttempts: 3 }));

    expect(records).toEqual([
      { type: 'retry', phase: 'watchdog', attempt: 1, max: null, delay_ms: expect.any(Number) },
    ]);
  });

  it('reports an output-cap continuation as phase continue, not as a re-sent turn', async () => {
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        if (request === 1) {
          return sse([
            textDelta('First half '),
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
          ]);
        }
        return sse([textDelta('second half')]);
      }),
    );

    const records = await retryRecords(config({ outputCapContinuations: 2 }));

    expect(records).toEqual([
      { type: 'retry', phase: 'continue', attempt: 1, max: 2, delay_ms: 0, reason: 'output_cap' },
    ]);
  });
});
