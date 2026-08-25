import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RewindSnapshotStoreInterface,
  TurnCheckpointRecordData,
} from '../../types/sessions.js';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';

const callOrder = vi.hoisted(() => [] as string[]);
const compactMockState = vi.hoisted(() => ({
  result: undefined as unknown,
  results: [] as unknown[],
}));
const agentLoopState = vi.hoisted(() => ({
  nextError: null as Error | null,
  compactDuringRun: false,
}));

vi.mock('../../agent/compact.js', () => ({
  resolveContextLimit: () => 100,
  shouldCompact: () => true,
  usagePressureTokens: () => 1,
  runCompact: vi.fn(async () => {
    callOrder.push('compact');
    return (
      compactMockState.results.shift() ??
      compactMockState.result ?? { status: 'skipped', reason: 'small', message: 'small' }
    );
  }),
  runPostCompactHooks: vi.fn(async () => {}),
}));

vi.mock('../../input/input-expansion.js', () => ({
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
      callbacks: {
        onText: (content: string) => void;
        onTurnStart: (turn: number) => void;
        onCompact?: (history: unknown[], usage: unknown) => Promise<unknown>;
      },
    ) => {
      const error = agentLoopState.nextError;
      agentLoopState.nextError = null;
      if (error) throw error;
      if (agentLoopState.compactDuringRun) {
        agentLoopState.compactDuringRun = false;
        callbacks.onTurnStart(1);
        callbacks.onText('before compact');
        await callbacks.onCompact?.(history, {
          promptTokens: 90,
          completionTokens: 10,
          totalTokens: 100,
          contextTokens: 90,
        });
        callbacks.onTurnStart(2);
        callbacks.onText('continued after compact');
      }
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
  agentLoopState.nextError = null;
  agentLoopState.compactDuringRun = false;
  compactMockState.result = undefined;
  compactMockState.results.length = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('useAgent rewind integration', () => {
  it('names a new session from its first recorded prompt', async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    await latest!.send('fix session labels instead of showing ids');
    await tick();

    expect(latest!.sessionName).toBe('Fix session labels instead of showing ids');
    expect(timeline.load(sessionId).meta.name).toBe('Fix session labels instead of showing ids');
  });

  it('persists and applies a compact reducer model without switching the active model', async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    const result = latest!.setCompactModel('router/gemini-flash');
    await tick();

    expect(result).toEqual({ ok: true });
    expect(latest!.liveConfig.model).toBe(config.model);
    expect(latest!.liveConfig.compactModel).toBe('router/gemini-flash');
    expect(latest!.liveConfig.settings.compactModel).toBe('router/gemini-flash');
    expect(readFileSync(join(config.workspace, '.book', 'settings.local.json'), 'utf8')).toContain(
      'router/gemini-flash',
    );
  });

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
    await tick();

    expect(latest!.isThinking).toBe(false);
  });

  it('projects terminal session failures into the host UI', async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    agentLoopState.nextError = new Error('provider failed');
    await latest!.send('hello');
    await tick();

    expect(latest!.isThinking).toBe(false);
    // Reported as a transcript row rather than the transient banner: the banner
    // is cleared by the next send, and a run that stopped has to stay explained
    // after a resume. Only one of the two renders it, or one failure reads as two.
    expect(
      latest!.messages
        .filter((message) => (message as { kind?: string }).kind === 'local')
        .map((message) => message.content),
    ).toEqual(['✕ provider failed']);
    expect(latest!.error).toBeNull();
  });

  it('keeps streaming after auto compaction during an active run', async () => {
    const { config, timeline, sessionId } = fixture();
    compactMockState.results.push(
      { status: 'skipped', reason: 'small', message: 'small' },
      {
        status: 'compacted',
        trigger: 'auto',
        replacementHistory: [
          {
            id: 'checkpoint-1',
            role: 'assistant',
            content: 'compact summary',
            kind: 'checkpoint',
            includeInContext: true,
            timestamp: 1,
          },
        ],
        summary: 'compact summary',
        compactId: 'compact-1',
        generation: 1,
        checkpoint: {
          version: 2,
          generation: 1,
          state: { summary: 'compact summary', status: 'active' },
          constraints: [],
          files: [],
          episodes: [],
          openThreads: [],
          statistics: {
            summarizedMessages: 1,
            retainedMessages: 0,
            preTokens: 100,
            postTokens: 10,
          },
        },
        checkpointVersion: 2,
        summarizedCount: 1,
        retainedCount: 0,
        preContextTokens: 100,
        postContextTokens: 10,
        preMessageCount: 2,
        strategy: 'single-pass',
        modelCalls: 1,
      },
    );
    agentLoopState.compactDuringRun = true;
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    await latest!.send('keep going');
    await tick();

    expect(latest!.messages.map((message) => message.content)).toContain('before compact');
    expect(latest!.messages.map((message) => message.content)).toContain('continued after compact');
    expect(latest!.compactBoundaries).toHaveLength(1);
    expect(latest!.compactUi).toMatchObject({ phase: 'diff', trigger: 'auto' });
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
    const attachment = {
      id: 'image-1',
      sha256: '1'.repeat(64),
      storageKey: `${'1'.repeat(64)}.png`,
      mediaType: 'image/png' as const,
      byteSize: 3,
    };
    timeline.append(sessionId, {
      type: 'turn_checkpoint',
      eventId: 'cp1',
      timestamp: Date.now(),
      data: {
        version: 1,
        checkpointId: 'cp1',
        userEventId: 'u1',
        prompt: 'displayed prompt',
        attachments: [attachment],
        checkpoint: { codeUnavailableReason: 'capture failed' },
      } satisfies TurnCheckpointRecordData,
    });
    timeline.append(sessionId, {
      type: 'user',
      eventId: 'u1',
      timestamp: Date.now(),
      data: {
        id: 'u1',
        content: 'displayed prompt',
        kind: 'conversation',
        attachments: [attachment],
      },
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

    expect(result).toEqual({
      ok: true,
      restoredPrompt: 'displayed prompt',
      restoredAttachments: [attachment],
    });
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
