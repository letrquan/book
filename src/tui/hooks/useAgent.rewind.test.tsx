import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RewindSnapshotStoreInterface, TurnCheckpointRecordData } from '../../types.js';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';

const callOrder = vi.hoisted(() => [] as string[]);

vi.mock('../../agent/compact.js', () => ({
  resolveContextLimit: () => 100,
  shouldCompact: () => true,
  usagePressureTokens: () => 1,
  runCompact: vi.fn(async () => {
    callOrder.push('compact');
    return { status: 'skipped', reason: 'small', message: 'small' } as const;
  }),
  runPostCompactHooks: vi.fn(async () => {}),
}));

vi.mock('../input-expansion.js', () => ({
  expandAtMentions: (value: string) => {
    callOrder.push('expand-at');
    return value;
  },
  expandShellCommands: (value: string) => {
    callOrder.push('expand-shell');
    return value;
  },
  collectAtMentionObservations: () => [],
}));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      _message: string,
      history: unknown[],
      callbacks: { onDone: () => void },
    ) => {
      callbacks.onDone();
      return history;
    },
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-rewind-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const timeline = new SessionStore(join(root, 'sessions'));
  const sessionId = timeline.create({ cwd: workspace });
  return {
    root,
    workspace,
    timeline,
    sessionId,
    config: defaultConfig({ workspace, autoCompactEnabled: true }),
  };
}

function snapshotStore(
  overrides: Partial<RewindSnapshotStoreInterface> = {},
): RewindSnapshotStoreInterface {
  return {
    capture: () => ({
      ok: true,
      manifest: {
        version: 1,
        id: 'snapshot-id',
        workspace: '',
        createdAt: Date.now(),
        ignorePatterns: [],
        entries: [],
        logicalBytes: 0,
      },
    }),
    getCurrentGitHead: () => undefined,
    getManifest: (id) =>
      id === 'snapshot-id'
        ? {
            version: 1,
            id,
            workspace: '',
            createdAt: Date.now(),
            ignorePatterns: [],
            entries: [],
            logicalBytes: 0,
          }
        : undefined,
    getAvailability: () => ({ available: true }),
    restore: () => ({ ok: true, safetySnapshotId: 'safety-id' }),
    rollback: () => ({ ok: true }),
    discardManifest: () => {},
    cleanup: () => ({ manifests: 0, blobs: 0 }),
    ...overrides,
  };
}

function bootstrap(timeline: SessionStore, sessionId: string) {
  const loaded = timeline.load(sessionId);
  return {
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
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

afterEach(() => {
  cleanup();
  latest = undefined;
  callOrder.length = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('useAgent rewind integration', () => {
  it('renders the submitted message while an asynchronous snapshot is still pending', async () => {
    const { config, timeline, sessionId } = fixture();
    let finishCapture!: () => void;
    const capturePending = new Promise<ReturnType<RewindSnapshotStoreInterface['capture']>>(
      (resolve) => {
        finishCapture = () =>
          resolve({
            ok: true,
            manifest: {
              version: 1,
              id: 'snapshot-id',
              workspace: '',
              createdAt: Date.now(),
              ignorePatterns: [],
              entries: [],
              logicalBytes: 0,
            },
          });
      },
    );
    const snapshots = snapshotStore({ captureAsync: () => capturePending });
    render(
      <Harness
        config={config}
        session={{ ...bootstrap(timeline, sessionId), snapshotStore: snapshots }}
      />,
    );
    await tick();

    const sendPending = latest!.send('hello');
    await tick();

    expect(latest!.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello'],
      ['assistant', ''],
    ]);
    expect(latest!.isThinking).toBe(true);
    expect(
      timeline
        .readRecords(sessionId)
        .filter((record) => record.type === 'turn_checkpoint' || record.type === 'user'),
    ).toHaveLength(0);

    finishCapture();
    await sendPending;
  });

  it('captures after pre-turn compaction and before @/! expansion', async () => {
    const { config, timeline, sessionId } = fixture();
    const append = timeline.append.bind(timeline);
    vi.spyOn(timeline, 'append').mockImplementation((id, record) => {
      callOrder.push(record.type);
      append(id, record);
    });
    const snapshots = snapshotStore({
      capture: () => {
        callOrder.push('capture');
        return {
          ok: true,
          manifest: {
            version: 1,
            id: 'snapshot-id',
            workspace: '',
            createdAt: Date.now(),
            ignorePatterns: [],
            entries: [],
            logicalBytes: 0,
          },
        };
      },
    });
    render(
      <Harness
        config={config}
        session={{ ...bootstrap(timeline, sessionId), snapshotStore: snapshots }}
      />,
    );
    await tick();

    await latest!.send('@file !command');

    expect(callOrder.indexOf('compact')).toBeLessThan(callOrder.indexOf('capture'));
    expect(callOrder.indexOf('capture')).toBeLessThan(callOrder.indexOf('turn_checkpoint'));
    expect(callOrder.indexOf('turn_checkpoint')).toBeLessThan(callOrder.indexOf('expand-at'));
    expect(callOrder.indexOf('expand-at')).toBeLessThan(callOrder.indexOf('expand-shell'));
    expect(timeline.readRecords(sessionId).map((record) => record.type)).toContain(
      'turn_checkpoint',
    );
  });

  it('rewinds conversation state in the same session and returns the displayed prompt', async () => {
    const { config, timeline, sessionId } = fixture();
    timeline.append(sessionId, {
      type: 'turn_checkpoint',
      eventId: 'cp1',
      timestamp: Date.now(),
      data: {
        version: 1,
        checkpointId: 'cp1',
        userEventId: 'u1',
        prompt: 'displayed prompt',
        checkpoint: { codeUnavailableReason: 'capture failed' },
      } satisfies TurnCheckpointRecordData,
    });
    timeline.append(sessionId, {
      type: 'user',
      eventId: 'u1',
      timestamp: Date.now(),
      data: { id: 'u1', content: 'displayed prompt', kind: 'conversation' },
    });
    timeline.append(sessionId, {
      type: 'assistant',
      eventId: 'a1',
      timestamp: Date.now(),
      data: { id: 'a1', content: 'answer', complete: true, kind: 'conversation' },
    });
    render(
      <Harness
        config={config}
        session={{ ...bootstrap(timeline, sessionId), snapshotStore: snapshotStore() }}
      />,
    );
    await tick();

    const result = await latest!.rewind('cp1', 'conversation');
    await tick();

    expect(result).toEqual({ ok: true, restoredPrompt: 'displayed prompt' });
    expect(latest!.sessionId).toBe(sessionId);
    expect(latest!.messages).toEqual([]);
    expect(latest!.usage).toBeNull();
    expect(latest!.agentTodos).toEqual([]);
  });

  it('rolls files back when appending the rewind record fails', async () => {
    const { config, timeline, sessionId } = fixture();
    timeline.append(sessionId, {
      type: 'turn_checkpoint',
      eventId: 'cp1',
      timestamp: Date.now(),
      data: {
        version: 1,
        checkpointId: 'cp1',
        userEventId: 'u1',
        prompt: 'prompt',
        checkpoint: { snapshotId: 'snapshot-id' },
      } satisfies TurnCheckpointRecordData,
    });
    timeline.append(sessionId, {
      type: 'user',
      eventId: 'u1',
      timestamp: Date.now(),
      data: { id: 'u1', content: 'prompt', kind: 'conversation' },
    });
    const append = timeline.append.bind(timeline);
    vi.spyOn(timeline, 'append').mockImplementation((id, record) => {
      if (record.type === 'rewind') throw new Error('disk full');
      append(id, record);
    });
    let filesRestored = true;
    const rollback = vi.fn(() => {
      filesRestored = false;
      return { ok: true as const };
    });
    const snapshots = snapshotStore({
      restore: () => {
        filesRestored = true;
        return { ok: true, safetySnapshotId: 'safety-id' };
      },
      rollback,
    });
    render(
      <Harness
        config={config}
        session={{ ...bootstrap(timeline, sessionId), snapshotStore: snapshots }}
      />,
    );
    await tick();

    const result = await latest!.rewind('cp1', 'code');

    expect(result).toEqual({ ok: false, error: 'disk full' });
    expect(rollback).toHaveBeenCalledWith('safety-id');
    expect(filesRestored).toBe(false);
    expect(timeline.readRecords(sessionId).some((record) => record.type === 'rewind')).toBe(false);
  });
});
