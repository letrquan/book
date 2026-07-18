import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const compactMocks = vi.hoisted(() => ({ runCompact: vi.fn() }));

vi.mock('./agent/compact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent/compact.js')>();
  return { ...actual, runCompact: compactMocks.runCompact };
});

import { runHeadless } from './headless.js';
import { SessionStore } from './session/store.js';
import { defaultConfig } from './test/fixtures.js';
import { createDefaultRegistry } from './tools/registry.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-compact-headless-'));
  tempDirs.push(dir);
  return dir;
}

function response(): Response {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[],"usage":{"prompt_tokens":90,"completion_tokens":10,"total_tokens":100}}\n\n',
        ),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  compactMocks.runCompact.mockReset();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('headless compact metadata', () => {
  it('emits and persists degraded boundary details', async () => {
    const checkpoint = {
      version: 2 as const,
      generation: 1,
      state: { summary: 'Reduced fidelity', status: 'unknown' as const },
      constraints: [],
      files: [],
      episodes: [],
      openThreads: [],
      statistics: { summarizedMessages: 2, retainedMessages: 0, preTokens: 100, postTokens: 20 },
      coverage: {
        status: 'degraded' as const,
        reasons: ['pass-limit' as const],
        processedMessages: 1,
        omittedMessages: 1,
        partiallyProcessedMessages: 0,
      },
    };
    compactMocks.runCompact.mockResolvedValue({
      status: 'compacted',
      trigger: 'auto',
      replacementHistory: [
        {
          id: 'checkpoint-1',
          role: 'user',
          content: JSON.stringify(checkpoint),
          includeInContext: true,
          kind: 'checkpoint',
          timestamp: 1,
        },
      ],
      checkpoint,
      checkpointVersion: 2,
      compactId: 'compact-1',
      generation: 1,
      summary: 'Reduced fidelity',
      summarizedCount: 2,
      retainedCount: 0,
      preContextTokens: 100,
      postContextTokens: 20,
      preMessageCount: 2,
      strategy: 'multi-pass',
      modelCalls: 15,
      degraded: true,
      warning: 'Compaction omitted older coverage. Exact history remains searchable.',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response()),
    );

    const writes: string[] = [];
    const store = new SessionStore(makeTempDir());
    const result = await runHeadless(
      defaultConfig({ modelInfo: { contextWindow: 100 }, autoCompactEnabled: true }),
      createDefaultRegistry(),
      {
        inputFormat: 'stream-json',
        outputFormat: 'stream-json',
        history: [],
        mode: 'bypassPermissions',
        stdin: Readable.from([
          `${JSON.stringify({ type: 'user', content: 'first' })}\n`,
          `${JSON.stringify({ type: 'user', content: 'second' })}\n`,
        ]),
        stdout: {
          write: (value: string) => {
            writes.push(value);
            return true;
          },
        },
        sessionStore: store,
      },
    );

    const events = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(events.find((event) => event.subtype === 'compact_boundary')).toMatchObject({
      strategy: 'multi-pass',
      model_calls: 15,
      degraded: true,
      coverage_status: 'degraded',
      warning: 'Compaction omitted older coverage. Exact history remains searchable.',
    });
    const compactRecords = store
      .readRecords(result.sessionId!)
      .filter((record) => record.type === 'compact');
    expect(compactRecords).toHaveLength(1);
    const compactRecord = compactRecords[0];
    expect(compactRecord?.data).toMatchObject({
      strategy: 'multi-pass',
      modelCalls: 15,
      degraded: true,
    });
  });
});
