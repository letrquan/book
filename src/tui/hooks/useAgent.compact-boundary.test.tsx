import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';

/**
 * Where a compaction's transcript row lands (#266). The row marks the point the
 * conversation was compacted, so it belongs before any turn whose request was
 * sent after it: the reply to an overflow-recovery retry, or a turn whose
 * preflight gate compacted. It used to be appended after that turn's streaming
 * placeholder, and the reply then streamed into the placeholder above it.
 */

type Step =
  | { turnStart: number }
  | { text: string }
  | { reasoning: string }
  | { compact: 'sync' | 'recovery' }
  | { commit: true }
  | { wait: true };

const loopState = vi.hoisted(() => ({ steps: [] as unknown[] }));

function compactedResult(id: string) {
  return {
    status: 'compacted',
    trigger: 'auto',
    replacementHistory: [
      {
        id: `checkpoint-${id}`,
        role: 'assistant',
        content: 'compact summary',
        kind: 'checkpoint',
        includeInContext: true,
        timestamp: 1,
      },
    ],
    summary: 'compact summary',
    compactId: id,
    generation: 1,
    checkpoint: {
      version: 2,
      generation: 1,
      state: { summary: 'compact summary', status: 'active' },
      constraints: [],
      files: [],
      episodes: [],
      openThreads: [],
      statistics: { summarizedMessages: 1, retainedMessages: 0, preTokens: 100, postTokens: 10 },
    },
    checkpointVersion: 2,
    summarizedCount: 1,
    retainedCount: 0,
    preContextTokens: 100,
    postContextTokens: 10,
    preMessageCount: 2,
    strategy: 'single-pass',
    modelCalls: 1,
  };
}

vi.mock('../../agent/compact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/compact.js')>();
  let count = 0;
  return {
    ...actual,
    // The host's pre-turn check never fires; only the scripted loop compacts.
    shouldCompact: () => false,
    runCompact: vi.fn(async () => compactedResult(`compact-${++count}`)),
    runPostCompactHooks: vi.fn(async () => {}),
    applyCompactResult: vi.fn((result: unknown) => result),
    judgeCompaction: vi.fn(async () => ({
      verdict: 'accepted',
      missing: [],
      modelCalls: 0,
      deltaMessages: 0,
    })),
    judgedResult: vi.fn((result: unknown) => result),
  };
});

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      _message: string,
      history: unknown[],
      callbacks: {
        onText: (content: string) => void;
        onReasoning?: (content: string) => void;
        onTurnStart: (turn: number) => void;
        onCompact?: (history: unknown[], usage: unknown, hints?: unknown) => Promise<unknown>;
        prepareCompact?: (snapshot: unknown[], usage: unknown, hints?: unknown) => Promise<unknown>;
        commitCompact?: (
          prepared: unknown,
          history: unknown[],
          hints?: unknown,
        ) => Promise<unknown>;
      },
    ) => {
      const usage = { promptTokens: 90, completionTokens: 10, totalTokens: 100, contextTokens: 90 };
      for (const step of loopState.steps as Step[]) {
        if ('turnStart' in step) callbacks.onTurnStart(step.turnStart);
        else if ('text' in step) callbacks.onText(step.text);
        else if ('reasoning' in step) callbacks.onReasoning?.(step.reasoning);
        else if ('wait' in step) await new Promise((resolve) => setTimeout(resolve, 60));
        else if ('compact' in step) {
          await callbacks.onCompact?.(
            history,
            usage,
            step.compact === 'recovery' ? { recovery: true } : undefined,
          );
        } else {
          const prepared = await callbacks.prepareCompact?.(history, usage);
          await callbacks.commitCompact?.(prepared, history);
        }
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
const originalBookHome = process.env.BOOK_HOME;

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
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-compact-boundary-'));
  roots.push(root);
  // User preferences persist to the user-global layer, which resolves through
  // BOOK_HOME; pin it so the test never writes the developer's own settings.
  process.env.BOOK_HOME = join(root, 'home');
  const workspace = join(root, 'workspace');
  const timeline = new SessionStore(join(root, 'sessions'));
  const sessionId = timeline.create({ cwd: workspace });
  const loaded = timeline.load(sessionId);
  return {
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
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/** The index of the message holding `text`, which must exist. */
function indexOf(text: string): number {
  const index = latest!.messages.findIndex((message) => message.content.includes(text));
  expect(index, `no message holds ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
  return index;
}

async function run(steps: Step[]): Promise<void> {
  // Every scripted run starts with the provider round trip a real request takes.
  loopState.steps = [{ wait: true }, ...steps];
  const { config, session } = fixture();
  render(<Harness config={config} session={session} />);
  await tick();
  await latest!.send('go');
  await tick();
}

afterEach(() => {
  cleanup();
  if (originalBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = originalBookHome;
  latest = undefined;
  loopState.steps = [];
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the compaction row', () => {
  it('lands before the reply an overflow-recovery retry streams (#266)', async () => {
    await run([{ compact: 'recovery' }, { text: 'retried answer' }]);

    expect(latest!.compactBoundaries).toHaveLength(1);
    expect(latest!.compactBoundaries[0]!.transcriptOrdinal).toBe(indexOf('retried answer'));
  });

  it('lands before a turn whose preflight gate compacted, after the turn before it (#266)', async () => {
    await run([
      { text: 'first turn' },
      { wait: true },
      { turnStart: 2 },
      // The request is built between the turn start and the gate, so the new
      // turn's placeholder has rendered by the time it compacts.
      { wait: true },
      { compact: 'sync' },
      { text: 'second turn' },
    ]);

    expect(latest!.compactBoundaries).toHaveLength(1);
    expect(indexOf('first turn')).toBeLessThan(indexOf('second turn'));
    expect(latest!.compactBoundaries[0]!.transcriptOrdinal).toBe(indexOf('second turn'));
  });

  it('lands after a turn that had streamed before it compacted, even text not yet flushed', async () => {
    // The mid-loop safety net compacts after a turn's output. Text still in
    // the streaming buffer is that turn's, so the row goes after it.
    await run([{ text: 'before compact' }, { compact: 'sync' }, { text: ' and after' }]);

    expect(latest!.compactBoundaries).toHaveLength(1);
    const ordinal = latest!.compactBoundaries[0]!.transcriptOrdinal;
    expect(ordinal).toBe(indexOf('before compact') + 1);
    // What the turn streams after the compaction is a message of its own, below the row.
    expect(indexOf(' and after')).toBe(ordinal);
  });

  it('puts a continuation re-sent after the turn compacted below the row (#266)', async () => {
    // An output-cap continuation or a transport re-issue retries the same turn:
    // no new turn starts, and its preflight gate can compact before it streams.
    await run([
      { text: 'partial answer' },
      { wait: true },
      { compact: 'sync' },
      { text: 'continued answer' },
    ]);

    expect(latest!.compactBoundaries).toHaveLength(1);
    const ordinal = latest!.compactBoundaries[0]!.transcriptOrdinal;
    expect(ordinal).toBe(indexOf('partial answer') + 1);
    expect(indexOf('continued answer')).toBe(ordinal);
    expect(latest!.messages[indexOf('partial answer')]!.content).not.toContain('continued');
  });

  it('counts a turn that has only reasoned as having output (#266)', async () => {
    await run([
      { reasoning: 'thinking it over' },
      { wait: true },
      { compact: 'sync' },
      { turnStart: 2 },
      { text: 'next turn' },
    ]);

    const reasoned = latest!.messages.findIndex((message) =>
      message.reasoningContent?.includes('thinking it over'),
    );
    expect(reasoned).toBeGreaterThanOrEqual(0);
    expect(latest!.compactBoundaries).toHaveLength(1);
    expect(latest!.compactBoundaries[0]!.transcriptOrdinal).toBe(reasoned + 1);
  });

  it('lands after the turn a deferred compaction committed behind (#266)', async () => {
    // A deferred commit at the top of the loop, before the next turn starts:
    // the streaming message is the finished turn's, which the row follows.
    await run([
      { text: 'turn one' },
      { wait: true },
      { commit: true },
      { turnStart: 2 },
      { text: 'turn two' },
    ]);

    expect(latest!.compactBoundaries).toHaveLength(1);
    expect(latest!.compactBoundaries[0]!.transcriptOrdinal).toBe(indexOf('turn one') + 1);
    expect(latest!.compactBoundaries[0]!.transcriptOrdinal).toBeLessThanOrEqual(
      indexOf('turn two'),
    );
  });

  it('lands before the turn a deferred compaction committed at, at its preflight gate', async () => {
    await run([
      { text: 'turn one' },
      { wait: true },
      { turnStart: 2 },
      { wait: true },
      { commit: true },
      { text: 'turn two' },
    ]);

    expect(latest!.compactBoundaries).toHaveLength(1);
    expect(latest!.compactBoundaries[0]!.transcriptOrdinal).toBe(indexOf('turn two'));
  });
});
