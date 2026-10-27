import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { isolateBookHome } from '../../test/isolated-book-home.js';
import { SessionStore } from '../../session/store.js';
import type { PeerDeliveryBatch, SessionMessaging } from '../../messaging/session-messaging.js';

/**
 * Delivering another session's message (#620) as a turn: its messages leave the inbox, and its
 * sender hears `delivered`, only once the turn's user message is recorded. A send cancelled
 * before then — in the pre-turn compaction, say — leaves them queued.
 */

const loopState = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; resumedFromRunId?: string; peerTurnClass?: string }>,
  usage: undefined as unknown,
}));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      message: string,
      history: unknown[],
      callbacks: { onUsage?: (usage: unknown) => void },
      _mode: unknown,
      options: { runContext?: { resumedFromRunId?: string }; peerTurnClass?: string },
    ) => {
      loopState.calls.push({
        message,
        resumedFromRunId: options?.runContext?.resumedFromRunId,
        ...(options?.peerTurnClass ? { peerTurnClass: options.peerTurnClass } : {}),
      });
      if (loopState.usage) callbacks.onUsage?.(loopState.usage);
      return history;
    },
  ),
}));

vi.mock('../../agent/compact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/compact.js')>();
  return {
    ...actual,
    // The pre-turn compaction runs until the send is cancelled.
    runCompact: vi.fn(
      (_config: unknown, _history: unknown, options: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          const done = () =>
            resolve({ status: 'skipped', reason: 'aborted', message: 'Compaction cancelled.' });
          if (options?.signal?.aborted) done();
          options?.signal?.addEventListener('abort', done);
          setTimeout(done, 3_000).unref();
        }),
    ),
  };
});

vi.mock('../../session/lifecycle.js', () => ({
  runSessionStart: vi.fn(async () => {}),
  runSessionEnd: vi.fn(async () => {}),
}));

import { lastTurnReply, useAgent } from './useAgent.js';
import type { Message } from '../../types/messages.js';

isolateBookHome('book-use-agent-peer-delivery-home-');

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

function fakeMessaging() {
  return {
    setPermissionMode: vi.fn(),
    setInbound: vi.fn(),
    setTurnTextSource: vi.fn(),
    continueRelay: vi.fn(),
    beginTurn: vi.fn(),
    commitDelivery: vi.fn(),
    stillDeliverable: vi.fn(() => true),
    available: () => true,
    list: async () => ({ peers: [] }),
    resolve: async () => ({ ok: false, problem: 'not_found', candidates: [] }),
    send: async () => ({ status: 'unavailable' }),
  };
}

function fixture(messaging: ReturnType<typeof fakeMessaging>) {
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-peer-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const timeline = new SessionStore(join(root, 'sessions'));
  const sessionId = timeline.create({ cwd: workspace });
  const loaded = timeline.load(sessionId);
  return {
    timeline,
    config: defaultConfig({ workspace, autoCompactEnabled: true }),
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
      messaging: messaging as unknown as SessionMessaging,
    },
  };
}

const batch: PeerDeliveryBatch = {
  count: 1,
  delivered: [],
  withheld: [],
  turnClass: 'prompting',
  turn: {
    display: 'Message from peer-b [a1b2c3]:\nrun the tests',
    context: 'Another Book session sent a message:\n<cross-session-message>…',
    peerMessages: [{ attributed: true, fromName: 'peer-b', body: 'run the tests', receivedAt: 1 }],
  },
};

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

afterEach(() => {
  cleanup();
  latest = undefined;
  loopState.calls = [];
  loopState.usage = undefined;
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('peer-message delivery in the TUI', () => {
  it('leaves the messages queued when the pre-turn compaction is cancelled', async () => {
    const messaging = fakeMessaging();
    const { config, session } = fixture(messaging);
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // A first turn reports a context at the compaction gate, so the next send compacts first.
    loopState.usage = {
      promptTokens: 9e8,
      completionTokens: 1,
      totalTokens: 9e8,
      contextTokens: 9e8,
    };
    await latest!.send('fill the context');
    loopState.usage = undefined;
    expect(messaging.beginTurn).toHaveBeenCalledTimes(1);

    const delivering = latest!.sendPeerMessages(batch);
    await waitFor(() => latest!.isCompacting);
    latest!.cancel();
    expect(await delivering).toBe(false);
    expect(messaging.commitDelivery).not.toHaveBeenCalled();
    expect(loopState.calls).toHaveLength(1);

    // Tried again, the turn starts, and only then are the messages taken.
    expect(await latest!.sendPeerMessages(batch)).toBe(true);
    expect(messaging.commitDelivery).toHaveBeenCalledTimes(1);
    expect(messaging.commitDelivery).toHaveBeenCalledWith(batch);
    // A peer turn is not a turn the user started: its relay chain is not cleared.
    expect(messaging.beginTurn).toHaveBeenCalledTimes(1);
  });

  it("hands the turn's permission class to the loop, which pins it; other turns have none", async () => {
    const messaging = fakeMessaging();
    const { config, session } = fixture(messaging);
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await latest!.sendPeerMessages({ ...batch, turnClass: 'bypass' })).toBe(true);
    await latest!.send('the user types');
    expect(loopState.calls.map((call) => call.peerTurnClass)).toEqual(['bypass', undefined]);
  });

  it("keeps a peer turn's pin on the turns that carry its work on, until the user's next turn", async () => {
    const messaging = fakeMessaging();
    const { config, session } = fixture(messaging);
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // A peer turn pinned to prompting starts a background shell; its completion is a turn of its
    // own, which must not run unasked in the bypass session.
    expect(await latest!.sendPeerMessages({ ...batch, turnClass: 'prompting' })).toBe(true);
    const shell = {
      id: 'bg-1',
      title: 'tests',
      command: 'npm test',
      status: 'completed',
      exitCode: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    } as unknown as Parameters<NonNullable<typeof latest>['sendBackgroundShellCompletion']>[0];
    expect(await latest!.sendBackgroundShellCompletion(shell)).toBe(true);
    expect(await latest!.sendPeerDeliveryNotice('[Cross-session delivery notice] …')).toBe(true);
    // A bypass-class peer turn after it cannot loosen the standing pin.
    expect(await latest!.sendPeerMessages({ ...batch, turnClass: 'bypass' })).toBe(true);
    await latest!.send('the user types');
    expect(await latest!.sendBackgroundShellCompletion(shell)).toBe(true);
    expect(loopState.calls.map((call) => call.peerTurnClass)).toEqual([
      'prompting',
      'prompting',
      'prompting',
      'prompting',
      undefined,
      undefined,
    ]);
  });

  it('pins the completion of a background job a pinned turn started, after the user typed too', async () => {
    const messaging = fakeMessaging();
    const { config, session } = fixture(messaging);
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const shell = {
      id: 'bg-peer',
      title: 'peer job',
      command: 'npm test',
      status: 'completed',
      exitCode: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    } as unknown as Parameters<NonNullable<typeof latest>['sendBackgroundShellCompletion']>[0];
    // The peer turn starts the job: it is listed only once that run has gone.
    const list = vi
      .spyOn(latest!.runtime.shellManager, 'list')
      .mockReturnValueOnce([])
      .mockReturnValue([shell]);
    expect(await latest!.sendPeerMessages({ ...batch, turnClass: 'prompting' })).toBe(true);
    list.mockReturnValue([shell]);
    // The user's own turn clears the session's pin, but not the pin on the work the peer started.
    await latest!.send('the user types');
    expect(await latest!.sendBackgroundShellCompletion(shell)).toBe(true);
    expect(loopState.calls.map((call) => call.peerTurnClass)).toEqual([
      'prompting',
      undefined,
      'prompting',
    ]);
  });

  it('does not start a peer turn whose sender no longer matches the mode', async () => {
    const messaging = fakeMessaging();
    const { config, session } = fixture(messaging);
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The user switched modes while the turn was being prepared.
    messaging.stillDeliverable.mockReturnValue(false);
    expect(await latest!.sendPeerMessages(batch)).toBe(false);
    expect(messaging.commitDelivery).not.toHaveBeenCalled();
    expect(loopState.calls).toHaveLength(0);
  });

  it('keeps the relay chain through a notification turn; only a turn the user starts resets it', async () => {
    const messaging = fakeMessaging();
    const { config, session } = fixture(messaging);
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await latest!.sendPeerMessages(batch);
    expect(await latest!.sendPeerDeliveryNotice('[Cross-session delivery notice] …')).toBe(true);
    // A background job the peer turn started finishes: its completion turn keeps the chain too.
    await latest!.sendBackgroundShellCompletion({
      id: 'shell-1',
      command: 'sleep 5',
      effectiveCommand: 'sleep 5',
      workdir: config.workspace,
      status: 'exited',
      output: '',
      readOffset: 0,
      truncatedBytes: 0,
      exitCode: 0,
      startedAt: Date.now() - 5_000,
      finishedAt: Date.now(),
    } as Parameters<NonNullable<typeof latest>['sendBackgroundShellCompletion']>[0]);
    expect(loopState.calls).toHaveLength(3);
    expect(messaging.beginTurn).not.toHaveBeenCalled();
    await latest!.send('my own prompt');
    expect(messaging.beginTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a resumed run's linkage for the user's next prompt, not a peer turn", async () => {
    const messaging = fakeMessaging();
    const { config, session, timeline } = fixture(messaging);
    const earlier = timeline.create({ cwd: config.workspace });
    timeline.append(earlier, {
      type: 'user',
      eventId: 'earlier-user',
      timestamp: 1,
      data: { id: 'earlier-user', content: 'the earlier prompt' },
    });
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await latest!.resumeConversation(earlier);

    await latest!.sendPeerMessages(batch);
    await latest!.send('my next prompt');
    expect(loopState.calls.map((call) => call.resumedFromRunId)).toEqual([
      undefined,
      'earlier-user',
    ]);
  });
});

describe('idle notices in the TUI (#620 PR 6)', () => {
  it('runs an idle notice under its own row, in the class a message from the notifier would', async () => {
    const messaging = fakeMessaging();
    const { config, session } = fixture(messaging);
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      await latest!.sendPeerDeliveryNotice('[Cross-session idle notice] peer-b [a1b2c3] is idle', {
        display: 'Cross-session idle notice.',
        peerTurnClass: 'prompting',
        relayChain: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
      }),
    ).toBe(true);
    // The model reads the notice; the row is what the transcript shows.
    expect(loopState.calls).toMatchObject([
      {
        message: '[Cross-session idle notice] peer-b [a1b2c3] is idle',
        peerTurnClass: 'prompting',
      },
    ]);
    // A host turn: the relay chain is kept, and continued with the subscription's.
    expect(messaging.beginTurn).not.toHaveBeenCalled();
    expect(messaging.continueRelay).toHaveBeenCalledWith(['aaaaaaaaaaaaaaaaaaaaaaaa']);
  });

  it("gives the runtime this session's last reply for the notices it sends", async () => {
    const messaging = fakeMessaging();
    const { config, session } = fixture(messaging);
    render(<Harness config={config} session={session} />);
    await waitFor(() => messaging.setTurnTextSource.mock.calls.length > 0);
    const source = messaging.setTurnTextSource.mock.calls[0]![0] as () => string | undefined;
    expect(source()).toBeUndefined();
  });

  it("reads only the model's own reply in the newest turn, never a row the host added", () => {
    const message = (role: Message['role'], content: string, kind?: Message['kind']): Message => ({
      id: content,
      role,
      content,
      timestamp: 0,
      includeInContext: kind !== 'local',
      ...(kind !== undefined ? { kind } : {}),
    });
    const turn = [message('user', 'run the build'), message('assistant', 'The build is green.')];
    expect(lastTurnReply(turn)).toBe('The build is green.');
    // A held peer message's row, /cost output, a notice row and a checkpoint come after it.
    expect(
      lastTurnReply([
        ...turn,
        message(
          'assistant',
          '⚠ Held peer message — from peer-c [c0ffee]; preview: «secret plan»',
          'local',
        ),
        message('user', '/cost', 'local'),
        message('assistant', 'Total cost: $0.42', 'local'),
        message('assistant', '◦ Cross-session idle notice: peer-d is idle.', 'local'),
        message('assistant', 'Summary of the conversation so far', 'checkpoint'),
      ]),
    ).toBe('The build is green.');
    // A newest turn with no text of the model's says nothing, rather than an older turn's reply.
    expect(
      lastTurnReply([...turn, message('user', 'and now?'), message('assistant', '  ')]),
    ).toBeUndefined();
    expect(lastTurnReply([message('assistant', 'only a row', 'local')])).toBeUndefined();
  });
});
