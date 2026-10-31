import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { isolateBookHome } from '../../test/isolated-book-home.js';
import { SessionStore } from '../../session/store.js';
import type { Message, SteeringInbox } from '../../types/messages.js';

/**
 * Steering from the TUI (#661): the host pushes a message into the running loop's inbox, the loop
 * reports where it delivered it, and whatever it never delivered comes back to the host when the
 * run settles so the app can put the words somewhere visible.
 */

const loopState = vi.hoisted(() => ({
  /** One entry per run the mocked loop started, resolved by the test. */
  runs: [] as Array<{
    message: string;
    steering?: { hasPending(): boolean; take(): unknown[] };
    callbacks: Record<string, unknown>;
    finish: () => void;
  }>,
}));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      message: string,
      history: Message[],
      callbacks: Record<string, unknown>,
      _mode: unknown,
      options: { steering?: { hasPending(): boolean; take(): unknown[] } },
    ) => {
      await new Promise<void>((resolve) => {
        loopState.runs.push({ message, steering: options?.steering, callbacks, finish: resolve });
      });
      return history;
    },
  ),
}));

vi.mock('../../session/lifecycle.js', () => ({
  runSessionStart: vi.fn(async () => {}),
  runSessionEnd: vi.fn(async () => {}),
}));

import { useAgent } from './useAgent.js';

isolateBookHome('book-use-agent-steering-home-');

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
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-steer-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const timeline = new SessionStore(join(root, 'sessions'));
  const sessionId = timeline.create({ cwd: workspace });
  const loaded = timeline.load(sessionId);
  return {
    timeline,
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
      store: timeline,
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  cleanup();
  latest = undefined;
  loopState.runs = [];
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('steering from the TUI', () => {
  it('offers steering only while a run the user started is going', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(latest!.canSteer).toBe(false);
    expect(await latest!.steer('too early')).toBe('not-running');

    const running = latest!.send('start');
    await waitFor(() => latest!.canSteer && loopState.runs.length === 1);
    expect(await latest!.steer('while you are at it')).toBe('steered');
    // The preview state is React state: it settles on the next render, as it would in the TUI.
    await waitFor(() => latest!.pendingSteers.length === 1);
    expect(latest!.pendingSteers.map((steer) => steer.value)).toEqual(['while you are at it']);

    loopState.runs[0]!.finish();
    await running;
    await waitFor(() => !latest!.canSteer);
    expect(latest!.canSteer).toBe(false);
    expect(latest!.pendingSteers).toEqual([]);
  });

  it('hands the loop an inbox it drains, and shows the delivered words where the model read them', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const running = latest!.send('start');
    await waitFor(() => latest!.canSteer && loopState.runs.length === 1);
    expect(await latest!.steer('check the docs too')).toBe('steered');
    const inbox = loopState.runs[0]!.steering as SteeringInbox;
    expect(inbox.hasPending()).toBe(true);
    const drained = inbox.take();
    expect(drained).toHaveLength(1);

    // The loop appends the steer mid-run and reports it through the session callback the TUI
    // subscribes to; the transcript gains a user row at that point, not only at the run's end.
    const delivered: Message = {
      id: 'steer-1',
      role: 'user',
      content: 'check the docs too',
      includeInContext: true,
      kind: 'conversation',
      steered: true,
      timestamp: Date.now(),
    };
    (loopState.runs[0]!.callbacks.onUserMessageAppended as (message: Message) => void)(delivered);
    await waitFor(() => latest!.messages.some((message) => message.id === 'steer-1'));
    const row = latest!.messages.find((message) => message.id === 'steer-1');
    expect(row?.content).toBe('check the docs too');
    expect(row?.steered).toBe(true);
    // Delivered means no longer pending, so the preview stops listing it.
    expect(latest!.pendingSteers).toEqual([]);

    loopState.runs[0]!.finish();
    await running;
  });

  it('recalls the newest pending steer so Up can edit it', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const running = latest!.send('start');
    await waitFor(() => latest!.canSteer && loopState.runs.length === 1);
    await latest!.steer('first');
    await latest!.steer('second');
    await waitFor(() => latest!.pendingSteers.length === 2);
    expect(latest!.pendingSteers.map((steer) => steer.value)).toEqual(['first', 'second']);

    expect(latest!.recallSteer()?.value).toBe('second');
    await waitFor(() => latest!.pendingSteers.length === 1);
    expect(latest!.pendingSteers.map((steer) => steer.value)).toEqual(['first']);
    // The recalled steer is out of the inbox, so the loop cannot deliver what is being edited.
    const inbox = loopState.runs[0]!.steering as SteeringInbox;
    expect(
      (inbox.take() as Array<{ displayMessage?: string }>).map((s) => s.displayMessage),
    ).toEqual(['first']);

    loopState.runs[0]!.finish();
    await running;
  });

  it('returns steers the run never delivered when it settles', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const running = latest!.send('start');
    await waitFor(() => latest!.canSteer && loopState.runs.length === 1);
    await latest!.steer('never answered');
    loopState.runs[0]!.finish();

    const result = await running;
    expect(result.status).toBe('completed');
    expect(result.pendingSteers?.map((steer) => steer.value)).toEqual(['never answered']);
  });
});
