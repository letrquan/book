import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';
import type { PlanRecordData } from '../../types/sessions.js';

// What the scripted loop reports through onTodos on every run, and a gate the
// test can hold a run open on.
const loopScript = vi.hoisted(() => ({
  todos: null as unknown[] | null,
  gate: null as Promise<void> | null,
}));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      _message: string,
      history: unknown[],
      callbacks: { onTodos?: (todos: unknown[]) => void },
    ) => {
      // The real loop hands a copy (src/agent/loop.ts): the runtime mutates its
      // array in place, so a consumer keyed on identity would see nothing.
      if (loopScript.todos) callbacks.onTodos?.(loopScript.todos.slice());
      // Held after the report, the way a real turn is still working after its
      // last tool call came back.
      if (loopScript.gate) await loopScript.gate;
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

function fixture(plan?: PlanRecordData) {
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
      plan,
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

/** Hold the next scripted run open until the returned release is called. */
function holdRun() {
  let release!: () => void;
  loopScript.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async release() {
      loopScript.gate = null;
      release();
      await tick();
    },
  };
}

afterEach(() => {
  loopScript.todos = null;
  loopScript.gate = null;
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

  it('shows the plan a resumed session persisted, before any prompt', async () => {
    // Ctrl+T reads agentTodos, and a session resumed with a plan on disk has one
    // the moment it opens -- not only after the first tool call reports it back.
    const restored = [
      { content: 'Fix the parser', status: 'completed' },
      { content: 'Add the regression test', status: 'completed' },
      { content: 'Re-run the suite', status: 'in_progress' },
      { content: 'Cut the release', status: 'pending' },
      { content: 'Announce it', status: 'pending' },
      { content: 'Update the changelog', status: 'pending' },
      { content: 'Tell the user', status: 'pending' },
    ];
    const { config, session } = fixture({ version: 1, todos: restored, tasks: [] });
    render(<Harness config={config} session={session} />);
    await tick();
    expect(latest!.agentTodos).toEqual(restored);
  });

  it('does not credit the first prompt for a plan it merely restored', async () => {
    // The loop reports the plan after every tool call, not just after TodoWrite.
    // A prompt that touches nothing reports the restored plan on its first tool
    // call, and that is not the agent writing a plan.
    const restored = [
      { content: 'Fix the parser', status: 'in_progress' },
      { content: 'Add the regression test', status: 'pending' },
    ];
    const { config, session } = fixture({ version: 1, todos: restored, tasks: [] });
    render(<Harness config={config} session={session} />);
    await tick();

    loopScript.todos = restored;
    await latest!.send('carry on with the parser');
    await tick();
    expect(latest!.agentTodos).toEqual(restored);
    expect(latest!.agentPlanCurrent).toBe(false);
  });

  it("keeps the running turn's plan when a send is rejected as in flight", async () => {
    // A managed-agent completion and a background shell both retry their send
    // while a turn is running. The retry never starts a turn, so it must not
    // clear the turn's plan or move the baseline out from under it.
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    const held = holdRun();
    loopScript.todos = plan;
    const running = latest!.send('plan the fix');
    await tick();
    expect(latest!.agentPlanCurrent).toBe(true);

    const rejected = await latest!.send('and now the shell finished');
    expect(rejected.status).toBe('rejected');
    await tick();
    expect(latest!.agentPlanCurrent).toBe(true);
    expect(latest!.agentTodos).toEqual(plan);

    await held.release();
    await running;
    await tick();
    // The baseline the turn rejected a send against is still the one it started
    // from, so the plan it is working through still counts as its own.
    expect(latest!.agentPlanCurrent).toBe(true);
  });

  it('does not churn the plan state when a turn re-reports an unchanged plan', async () => {
    // The loop reports the plan after every tool call. A 200-tool turn must not
    // re-render the app 200 times for a plan that never moved.
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    loopScript.todos = plan;
    await latest!.send('plan the fix');
    await tick();
    const first = latest!.agentTodos;

    await latest!.send('keep going');
    await tick();
    expect(latest!.agentTodos).toBe(first);
  });
});
