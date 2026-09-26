import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';

// What the scripted loop reports through onTodos on every run.
const loopScript = vi.hoisted(() => ({ todos: null as unknown[] | null }));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      _message: string,
      history: unknown[],
      callbacks: { onTodos?: (todos: unknown[]) => void },
    ) => {
      if (loopScript.todos) callbacks.onTodos?.(loopScript.todos);
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
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-plan-'));
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

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

afterEach(() => {
  loopScript.todos = null;
  cleanup();
  latest = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('agentPlanCurrent', () => {
  const plan = [{ content: 'Fix the parser', status: 'in_progress' }];

  it('is set by a prompt that changes the plan', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();
    expect(latest!.agentPlanCurrent).toBe(false);

    loopScript.todos = plan;
    await latest!.send('plan the fix');
    await tick();
    expect(latest!.agentTodos).toEqual(plan);
    expect(latest!.agentPlanCurrent).toBe(true);
  });

  it('is cleared by a later prompt that leaves the plan as it was', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    loopScript.todos = plan;
    await latest!.send('plan the fix');
    await tick();
    expect(latest!.agentPlanCurrent).toBe(true);

    // Every tool call reports the plan again; an unchanged plan is not news.
    await latest!.send('what does foo return?');
    await tick();
    expect(latest!.agentTodos).toEqual(plan);
    expect(latest!.agentPlanCurrent).toBe(false);
  });
});
