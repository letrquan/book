import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { isolateBookHome } from '../../test/isolated-book-home.js';
import { SessionStore } from '../../session/store.js';
import { toolFailure } from '../../tools/result.js';
import type { Message } from '../../types/messages.js';
import type { ToolCall, ToolResult } from '../../types/tools.js';

/**
 * Esc while a tool runs (#669): when the run settles as cancelled, no row of it may go on saying
 * `Running…`. A call whose result never reached the transcript reads as interrupted; a call whose
 * result did arrive keeps it.
 */

const loopState = vi.hoisted(() => ({
  runs: 0,
  /** The cancelled result the loop reports before it returns; none when unset. */
  reported: undefined as ToolResult | undefined,
}));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      _message: string,
      history: Message[],
      callbacks: { onToolCall(call: ToolCall): void; onToolResult(result: ToolResult): void },
      _mode: unknown,
      options: { signal?: AbortSignal },
    ) => {
      loopState.runs++;
      // The model calls a command, which is still running when the user presses Esc.
      callbacks.onToolCall({ id: 'call-1', name: 'Bash', arguments: { command: 'sleep 10' } });
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      if (loopState.reported) callbacks.onToolResult(loopState.reported);
      return history;
    },
  ),
}));

vi.mock('../../session/lifecycle.js', () => ({
  runSessionStart: vi.fn(async () => {}),
  runSessionEnd: vi.fn(async () => {}),
}));

import { useAgent } from './useAgent.js';

isolateBookHome('book-use-agent-cancelled-tools-home-');

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
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-cancel-'));
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

function commandRow(): Message | undefined {
  return latest!.messages.find((message) => message.toolCalls?.some((c) => c.id === 'call-1'));
}

afterEach(() => {
  cleanup();
  latest = undefined;
  loopState.runs = 0;
  loopState.reported = undefined;
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('tool rows of a cancelled run (#669)', () => {
  it('settles a call that never reported back as interrupted', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const running = latest!.send('start the run');
    await waitFor(() => loopState.runs === 1 && commandRow() !== undefined);
    expect(commandRow()?.toolResults ?? []).toEqual([]);

    latest!.cancel();
    const result = await running;

    expect(result.status).toBe('cancelled');
    await waitFor(() => (commandRow()?.toolResults?.length ?? 0) > 0);
    const [settled] = commandRow()!.toolResults!;
    expect(settled).toMatchObject({ toolCallId: 'call-1', status: 'cancelled' });
    expect(settled!.structuredError?.message).toBe('CANCELLED: Agent execution was interrupted');
  });

  it('keeps the result a cancelled call did report', async () => {
    loopState.reported = toolFailure('Command cancelled', {
      toolCallId: 'call-1',
      code: 'cancelled',
      status: 'cancelled',
    });
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const running = latest!.send('start the run');
    await waitFor(() => loopState.runs === 1 && commandRow() !== undefined);
    latest!.cancel();
    await running;

    await waitFor(() => (commandRow()?.toolResults?.length ?? 0) > 0);
    expect(commandRow()!.toolResults!.map((r) => r.structuredError?.message)).toEqual([
      'Command cancelled',
    ]);
  });
});
