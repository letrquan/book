/**
 * `query()` leaves no empty session behind when it ends before recording a prompt (#444).
 * `runHeadless` is replaced: what is under test is what `query()` does once the run is over.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeadlessOptions } from './types/public-sdk.js';
import { createSessionFixture, type SessionFixture } from './test/session-fixture.js';

vi.mock('./mcp.js', () => ({
  connectMcpServers: vi.fn(async () => ({ connections: [], tools: [] })),
  disconnectMcpServers: vi.fn(),
}));

vi.mock('./headless.js', () => ({
  runHeadless: vi.fn(async (_config: unknown, _registry: unknown, options: HeadlessOptions) => {
    if (options.prompt === 'record it') {
      options.sessionStore?.append(options.sessionId!, {
        type: 'user',
        timestamp: Date.now(),
        data: { content: 'record it' },
      });
    }
    if (options.prompt === 'explode') throw new Error('failed before the prompt was recorded');
    return {
      messages: [],
      usage: null,
      sessionId: options.sessionId,
      outcome: { status: 'completed', reason: 'normal_completion', partialOutput: false },
      answer: '',
    };
  }),
}));

import { query } from './sdk.js';
import { disconnectMcpServers } from './mcp.js';

let fixture: SessionFixture;
let previousApiKey: string | undefined;
let previousBookHome: string | undefined;

beforeEach(() => {
  fixture = createSessionFixture('book-sdk-cleanup-');
  previousApiKey = process.env.BOOK_API_KEY;
  previousBookHome = process.env.BOOK_HOME;
  process.env.BOOK_API_KEY = 'test-key';
  // `query()` writes a run record under BOOK_HOME whatever the session settings.
  process.env.BOOK_HOME = join(fixture.root, 'home');
});

afterEach(() => {
  fixture.cleanup();
  if (previousApiKey === undefined) delete process.env.BOOK_API_KEY;
  else process.env.BOOK_API_KEY = previousApiKey;
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
});

async function run(prompt: string, extra: { sessionId?: string } = {}) {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of query(prompt, {
    workspace: fixture.root,
    noSettings: true,
    sessionStore: fixture.store,
    ...extra,
  })) {
    events.push(event as unknown as Record<string, unknown>);
  }
  const session = events.find((event) => event.type === 'session');
  return { events, sessionId: session?.sessionId as string };
}

function indexed(id: string): boolean {
  const path = join(fixture.root, 'session-index.json');
  if (!existsSync(path)) return false;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { sessions?: Record<string, unknown> };
  return id in (parsed.sessions ?? {});
}

describe('query() — untouched sessions', () => {
  it('removes the session of a query that recorded nothing, file and index entry', async () => {
    const { sessionId } = await run('say nothing');

    expect(sessionId).toBeTruthy();
    expect(existsSync(join(fixture.root, `${sessionId}.jsonl`))).toBe(false);
    expect(indexed(sessionId)).toBe(false);
    expect(fixture.store.findById(sessionId)).toBeUndefined();
  });

  it('removes it when the run throws before the prompt was recorded', async () => {
    const { events, sessionId } = await run('explode');

    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(existsSync(join(fixture.root, `${sessionId}.jsonl`))).toBe(false);
    expect(indexed(sessionId)).toBe(false);
  });

  it('keeps the session of a query that recorded its prompt', async () => {
    const { sessionId } = await run('record it');

    expect(existsSync(join(fixture.root, `${sessionId}.jsonl`))).toBe(true);
    expect(fixture.store.findById(sessionId)).toBeDefined();
  });

  it('never removes a session the caller resumed by id', async () => {
    const id = fixture.store.create({ cwd: fixture.root });

    await run('say nothing', { sessionId: id });

    expect(existsSync(join(fixture.root, `${id}.jsonl`))).toBe(true);
  });

  it('removes it even when the background run rejects, and the rejection still propagates', async () => {
    vi.mocked(disconnectMcpServers).mockRejectedValueOnce(new Error('mcp disconnect failed'));
    const iterator = query('say nothing', {
      workspace: fixture.root,
      noSettings: true,
      sessionStore: fixture.store,
    });
    expect((await iterator.next()).value).toMatchObject({ type: 'system' });
    const session = (await iterator.next()).value as { sessionId: string };
    expect(existsSync(join(fixture.root, `${session.sessionId}.jsonl`))).toBe(true);

    // The consumer stops here; the run's cleanup throws while the generator unwinds.
    await expect(iterator.return(undefined)).rejects.toThrow('mcp disconnect failed');

    expect(existsSync(join(fixture.root, `${session.sessionId}.jsonl`))).toBe(false);
    expect(indexed(session.sessionId)).toBe(false);
  });
});
