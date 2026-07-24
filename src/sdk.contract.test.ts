import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeadlessOptions } from './types/public-sdk.js';
import { createSessionFixture, type SessionFixture } from './test/session-fixture.js';

const state = vi.hoisted(() => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release?.() };
});

vi.mock('./mcp.js', () => ({
  connectMcpServers: vi.fn(async () => ({ connections: [], tools: [] })),
  disconnectMcpServers: vi.fn(),
}));

vi.mock('./headless.js', () => ({
  runHeadless: vi.fn(async (_config: unknown, _registry: unknown, options: HeadlessOptions) => {
    options.onAgentEvent?.({ type: 'text', content: 'early' });
    if (options.prompt === 'managed events') {
      options.onAgentEvent?.({
        type: 'agent_status',
        agent: {
          agentId: 'a1',
          displayName: 'Inspect auth',
          profile: 'explorer',
          status: 'running',
          resolvedModel: 'test/model',
          isolation: 'workspace-readonly',
          createdAt: 1,
          updatedAt: 1,
        },
      });
      options.onAgentEvent?.({ type: 'agent_text_delta', agentId: 'a1', text: 'hidden' });
      options.onAgentEvent?.({
        type: 'agent_activity',
        agentId: 'a1',
        activity: {
          id: 'activity',
          kind: 'thinking',
          label: 'Thinking',
          status: 'running',
          startedAt: 1,
        },
      });
    }
    await state.gate;
    return { messages: [], usage: null, sessionId: options.sessionId };
  }),
}));

import { query } from './sdk.js';

let sessionFixture: SessionFixture | undefined;
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env.BOOK_API_KEY;
  process.env.BOOK_API_KEY = 'test-key';
});

afterEach(() => {
  sessionFixture?.cleanup();
  sessionFixture = undefined;
  if (previousApiKey === undefined) delete process.env.BOOK_API_KEY;
  else process.env.BOOK_API_KEY = previousApiKey;
});

describe('SDK runtime event bridge', () => {
  it('yields runtime events before headless execution completes and returns the session identity', async () => {
    sessionFixture = createSessionFixture('book-sdk-');
    const iterator = query('hello', {
      workspace: sessionFixture.root,
      noSettings: true,
      sessionStore: sessionFixture.store,
    });

    expect((await iterator.next()).value?.type).toBe('system');
    const session = (await iterator.next()).value;
    expect(session?.type).toBe('session');
    expect((await iterator.next()).value).toEqual({ type: 'text', content: 'early' });

    state.release();
    const result = (await iterator.next()).value;
    expect(result).toEqual(
      expect.objectContaining({
        type: 'result',
        sessionId: session?.type === 'session' ? session.sessionId : '',
      }),
    );
    expect((await iterator.next()).value).toEqual({ type: 'done' });
  });

  it('forwards managed status events but gates high-volume child text', async () => {
    sessionFixture = createSessionFixture('book-sdk-events-');
    const iterator = query('managed events', {
      workspace: sessionFixture.root,
      noSettings: true,
      sessionStore: sessionFixture.store,
    });
    const types: string[] = [];
    for await (const event of iterator) types.push(event.type);
    expect(types).toContain('agent_status');
    expect(types).toContain('agent_activity');
    expect(types).not.toContain('agent_text_delta');

    const forwarded = query('managed events', {
      workspace: sessionFixture.root,
      noSettings: true,
      sessionStore: sessionFixture.store,
      forwardSubagentText: true,
    });
    const forwardedTypes: string[] = [];
    for await (const event of forwarded) forwardedTypes.push(event.type);
    expect(forwardedTypes).toContain('agent_text_delta');
  });
});
