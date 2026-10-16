import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';
import type { Message } from '../../types/messages.js';

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (_config: unknown, _registry: unknown, _message: string, h: unknown[]) => h,
  ),
}));

vi.mock('../../session/lifecycle.js', () => ({
  runSessionStart: vi.fn(async () => {}),
  runSessionEnd: vi.fn(async () => {}),
}));

import { useAgent } from './useAgent.js';

const roots: string[] = [];
let latest: ReturnType<typeof useAgent> | undefined;

function Harness({
  config,
  session,
}: {
  config: Parameters<typeof useAgent>[0];
  session: Parameters<typeof useAgent>[1];
}) {
  latest = useAgent(config, session);
  return null;
}

function userMessage(id: string, content: string): Message {
  return { id, role: 'user', content, includeInContext: true, timestamp: 1 };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-shell-ids-'));
  roots.push(root);
  // User preferences persist to the user-global layer, which resolves through BOOK_HOME.
  vi.stubEnv('BOOK_HOME', join(root, 'home'));
  const workspace = join(root, 'workspace');
  const timeline = new SessionStore(join(root, 'sessions'));
  const sessionId = timeline.create({ cwd: workspace });
  const loaded = timeline.load(sessionId);
  return {
    config: defaultConfig({ workspace }),
    timeline,
    session: {
      sessionId,
      history: loaded.contextHistory,
      transcript: loaded.transcript,
      contextHistory: loaded.contextHistory,
      compactBoundaries: loaded.compactBoundaries,
      rewindTargets: loaded.rewindTargets,
      activeEventIds: loaded.activeEventIds,
      source: 'startup' as const,
      persisted: false,
      created: true,
      store: timeline,
      timelineStore: timeline,
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
  latest = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('useAgent background shell ids (#449)', () => {
  it('numbers a --resume launch past the ids in its transcript and context history', async () => {
    const { config, session } = fixture();
    // The transcript keeps the id a compaction dropped from the context history.
    const launch = {
      ...session,
      source: 'resume' as const,
      transcript: [userMessage('u1', 'Background shell `lint` (shell_3) exited.')],
      contextHistory: [userMessage('u2', 'shell_1 and shell_2 were started.')],
    };
    render(<Harness config={config} session={launch} />);
    await tick();

    expect(latest!.runtime.backgroundShells.nextId).toBe(4);
  });

  it('numbers a conversation resumed mid-session past the ids it names', async () => {
    const { config, session, timeline } = fixture();
    const otherId = timeline.create({ cwd: config.workspace });
    timeline.append(otherId, {
      type: 'user',
      eventId: 'user-1',
      timestamp: 1,
      data: {
        id: 'user-1',
        content: 'Background shell `T` (shell_5) exited.',
        kind: 'conversation',
      },
    });
    render(<Harness config={config} session={session} />);
    await tick();
    expect(latest!.runtime.backgroundShells.nextId).toBe(1);

    await latest!.resumeConversation(otherId);
    await tick();

    expect(latest!.sessionId).toBe(otherId);
    expect(latest!.runtime.backgroundShells.nextId).toBe(6);
  });
});
