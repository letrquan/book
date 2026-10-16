import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';
import type { ActiveGoal, GoalStatusEvent } from '../../types/goal.js';
import type { GoalRecordData } from '../../types/sessions.js';

// What the loop is handed on a run, as far as a goal is concerned.
interface ScriptedRun {
  runtime: { activeGoal?: ActiveGoal } | undefined;
  callbacks: {
    onGoalStatus?: (event: GoalStatusEvent) => void;
    onPlanHandoff?: (handoff: { plan: string; mode: string }) => void;
  };
}

// What the scripted loop does on each run, and how many runs it has had.
const loopScript = vi.hoisted(() => ({
  runs: 0,
  onRun: null as ((run: ScriptedRun) => void) | null,
}));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      _message: string,
      history: unknown[],
      callbacks: ScriptedRun['callbacks'],
      _mode: string,
      options?: { runtime?: ScriptedRun['runtime'] },
    ) => {
      loopScript.runs++;
      loopScript.onRun?.({ runtime: options?.runtime, callbacks });
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

/** The record a session keeps for a goal that is still unmet, as `/resume` reads it back. */
function goalRecord(setAt: number): GoalRecordData {
  return {
    version: 1,
    goal: {
      condition: 'ship the release',
      iterations: 2,
      setAt,
      origin: 'user',
      outputTokens: 400,
    },
  };
}

function fixture(goal?: GoalRecordData) {
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-goal-'));
  roots.push(root);
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
      goal,
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

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** A mounted hook with `/goal every test passes` already set and its first run finished. */
async function mountWithGoal() {
  const { config, session, timeline } = fixture();
  render(<Harness config={config} session={session} />);
  await tick();
  latest!.setGoal('every test passes');
  await tick();
  return { sessionId: session.sessionId, config, timeline };
}

/**
 * The evaluator's ruling at the stop gate, as src/agent/loop.ts applies it: the goal comes
 * off the runtime first, and only then is the host told.
 */
function rule(state: 'met' | 'failed') {
  return ({ runtime, callbacks }: ScriptedRun) => {
    const goal = runtime!.activeGoal!;
    runtime!.activeGoal = undefined;
    callbacks.onGoalStatus?.({
      state,
      condition: goal.condition,
      reason: 'the suite is green',
      iterations: 1,
      durationMs: 4_000,
      tokens: 120,
    });
  };
}

afterEach(() => {
  loopScript.runs = 0;
  loopScript.onRun = null;
  cleanup();
  latest = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('useAgent activeGoal', () => {
  it('is empty until /goal sets one, then names it with when it was set', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();
    expect(latest!.activeGoal).toBeUndefined();

    latest!.setGoal('every test passes');
    await tick();
    const goal = latest!.runtime.activeGoal!;
    expect(latest!.activeGoal).toEqual({ condition: 'every test passes', setAt: goal.setAt });
  });

  it('names a fresh session after the goal condition, not the "Goal set:" line (#443)', async () => {
    const { config, session, timeline } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    latest!.setGoal('`npm test` exits 0 and the output is shown');
    await waitFor(() => timeline.load(session.sessionId).meta.name !== undefined);
    await tick();

    const expected = '`npm test` exits 0 and the output is shown';
    expect(timeline.load(session.sessionId).meta.name).toBe(expected);
    expect(latest!.sessionName).toBe(expected);
    // The transcript still shows the goal line the user typed.
    expect(latest!.messages.find((m) => m.role === 'user')?.content).toContain('Goal set:');
  });

  it('keeps the existing session name when /goal is set mid-session (#443)', async () => {
    const { config, session, timeline } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('fix the login bug');
    await tick();
    expect(timeline.load(session.sessionId).meta.name).toBe('Fix the login bug');

    latest!.setGoal('every test passes');
    await tick();
    await tick();

    expect(timeline.load(session.sessionId).meta.name).toBe('Fix the login bug');
    expect(latest!.sessionName).toBe('Fix the login bug');
    expect(loopScript.runs).toBe(2);
  });

  it.each(['met', 'failed'] as const)(
    'drops the goal when the loop reports it %s',
    async (state) => {
      await mountWithGoal();
      expect(latest!.activeGoal?.condition).toBe('every test passes');

      loopScript.onRun = rule(state);
      await latest!.send('run the suite');
      await tick();

      // The scripted ruling landed on the runtime, and the status line follows it.
      expect(latest!.runtime.activeGoal).toBeUndefined();
      expect(latest!.activeGoal).toBeUndefined();
    },
  );

  it('keeps the same state through a verdict of not yet', async () => {
    await mountWithGoal();
    const shown = latest!.activeGoal;

    loopScript.onRun = ({ runtime, callbacks }) => {
      // An unmet check rewrites the runtime's goal (src/agent/loop.ts) but not what it says.
      const goal = runtime!.activeGoal!;
      runtime!.activeGoal = { ...goal, iterations: 1, lastReason: 'two tests still fail' };
      callbacks.onGoalStatus?.({
        state: 'unmet',
        condition: goal.condition,
        reason: 'two tests still fail',
        iterations: 1,
      });
    };
    await latest!.send('keep going');
    await tick();

    expect(latest!.runtime.activeGoal?.iterations).toBe(1);
    // The same object: nothing new to render for a goal that reads exactly as before.
    expect(latest!.activeGoal).toBe(shown);
  });

  it('drops the goal on /goal clear', async () => {
    await mountWithGoal();
    expect(latest!.activeGoal).toBeDefined();

    latest!.clearGoal();
    await tick();
    expect(latest!.activeGoal).toBeUndefined();
  });

  it('shows the goal a resumed session restored, with the time it was originally set', async () => {
    const setAt = Date.now() - 90_000;
    const { config, session } = fixture(goalRecord(setAt));
    render(<Harness config={config} session={session} />);
    await tick();
    expect(latest!.activeGoal).toEqual({ condition: 'ship the release', setAt });
  });

  it('shows the goal of a conversation resumed mid-session, with its original start', async () => {
    const setAt = Date.now() - 600_000;
    const { config, session, timeline } = fixture();
    const otherId = timeline.create({ cwd: config.workspace });
    timeline.append(otherId, { type: 'goal', timestamp: Date.now(), data: goalRecord(setAt) });
    render(<Harness config={config} session={session} />);
    await tick();
    expect(latest!.activeGoal).toBeUndefined();

    await latest!.resumeConversation(otherId);
    await tick();
    expect(latest!.sessionId).toBe(otherId);
    expect(latest!.activeGoal).toEqual({ condition: 'ship the release', setAt });
  });

  it('leaves the goal behind when a conversation without one is resumed', async () => {
    const { config, timeline } = await mountWithGoal();
    const otherId = timeline.create({ cwd: config.workspace });
    expect(latest!.activeGoal).toBeDefined();

    await latest!.resumeConversation(otherId);
    await tick();
    expect(latest!.sessionId).toBe(otherId);
    expect(latest!.activeGoal).toBeUndefined();
  });

  it('drops the goal when a new conversation starts', async () => {
    const { sessionId } = await mountWithGoal();
    expect(latest!.activeGoal).toBeDefined();

    await latest!.startNewConversation();
    await tick();
    expect(latest!.sessionId).not.toBe(sessionId);
    expect(latest!.activeGoal).toBeUndefined();
  });

  it('follows a goal into the fresh conversation a plan handoff starts', async () => {
    const { sessionId } = await mountWithGoal();
    const shown = latest!.activeGoal;
    expect(shown).toBeDefined();

    let handedOff = false;
    loopScript.onRun = ({ callbacks }) => {
      if (handedOff) return;
      handedOff = true;
      callbacks.onPlanHandoff?.({ plan: 'Refactor the parser.', mode: 'default' });
    };
    const runsBefore = loopScript.runs;
    await latest!.send('please plan this');
    // The planning turn, then the reseeded implementation turn in a new session.
    await waitFor(() => latest!.sessionId !== sessionId && loopScript.runs >= runsBefore + 2);
    await tick();

    // Same condition, same start: the goal keeps its progress across the handoff.
    expect(latest!.activeGoal).toEqual(shown);
  });
});
