import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';

/**
 * Local messages are how host-orchestrated work reports back — `/review` runs
 * for minutes in background agents and its whole report arrives this way. These
 * cover what happens when that output lands mid-turn, which used to discard it.
 */

// Holds a turn open so a local message can be produced while one is in flight.
const turnGate = vi.hoisted(() => ({ release: () => {}, promise: Promise.resolve() }));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (_config: unknown, _registry: unknown, _message: string, history) => {
    await turnGate.promise;
    return history;
  }),
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-local-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const timeline = new SessionStore(join(root, 'sessions'));
  const sessionId = timeline.create({ cwd: workspace });
  const loaded = timeline.load(sessionId);
  return {
    config: defaultConfig({ workspace }),
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
      timelineStore: timeline,
    },
  };
}

function openTurnGate(): void {
  turnGate.promise = new Promise<void>((resolve) => {
    turnGate.release = resolve;
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function localContents(): string[] {
  return (latest?.messages ?? [])
    .filter((message) => (message as { kind?: string }).kind === 'local')
    .map((message) => message.content);
}

afterEach(() => {
  turnGate.release();
  turnGate.promise = Promise.resolve();
  cleanup();
  latest = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('addLocalMessage while a turn is in flight', () => {
  it('replays a message produced mid-turn instead of discarding it', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    openTurnGate();
    const sending = latest!.send('start a turn');
    await waitFor(() => latest!.isThinking);

    latest!.addLocalMessage('Verdict: recommend');
    await tick();
    // Still withheld: appending here would clobber the streaming turn.
    expect(localContents()).toEqual([]);

    turnGate.release();
    await sending;
    await waitFor(() => localContents().length > 0);

    expect(localContents()).toEqual(['Verdict: recommend']);
  });

  it('replays several deferred messages in the order they were produced', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    openTurnGate();
    const sending = latest!.send('start a turn');
    await waitFor(() => latest!.isThinking);

    // A review emits its start line, then its report, then its fix summary.
    latest!.addLocalMessage('Reviewing 3 files');
    latest!.addLocalMessage('Verdict: recommend');
    latest!.addLocalMessage('Applied 1 of 1 verified fixes.');
    turnGate.release();
    await sending;
    await waitFor(() => localContents().length >= 3);

    expect(localContents()).toEqual([
      'Reviewing 3 files',
      'Verdict: recommend',
      'Applied 1 of 1 verified fixes.',
    ]);
  });

  it('appends immediately when no turn is running', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    latest!.addLocalMessage('Review complete: no changes.');
    await tick();

    expect(localContents()).toEqual(['Review complete: no changes.']);
  });

  it('persists a deferred message to the timeline once it lands', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    openTurnGate();
    const sending = latest!.send('start a turn');
    await waitFor(() => latest!.isThinking);
    latest!.addLocalMessage('Verdict: blocking');
    turnGate.release();
    await sending;
    await waitFor(() => localContents().length > 0);

    const stored = session.timelineStore.load(session.sessionId);
    expect(stored.transcript.map((message) => message.content)).toContain('Verdict: blocking');
  });
});
