import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';

// Records the prompt runAgentLoop is invoked with, per turn.
const loopCalls = vi.hoisted(() => [] as string[]);
// FIFO of plans to hand off: each loop call shifts one and, if present, simulates
// the loop firing a fresh-context plan handoff (approve-fresh) then stopping the turn.
const handoffState = vi.hoisted(() => ({ plansToFire: [] as string[] }));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      message: string,
      history: unknown[],
      callbacks: { onPlanHandoff?: (handoff: { plan: string; mode: string }) => void },
    ) => {
      loopCalls.push(message);
      const plan = handoffState.plansToFire.shift();
      if (plan) callbacks.onPlanHandoff?.({ plan, mode: 'default' });
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
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-handoff-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const timeline = new SessionStore(join(root, 'sessions'));
  const sessionId = timeline.create({ cwd: workspace });
  return { root, workspace, timeline, sessionId, config: defaultConfig({ workspace }) };
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

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

afterEach(() => {
  cleanup();
  latest = undefined;
  loopCalls.length = 0;
  handoffState.plansToFire.length = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('useAgent plan handoff', () => {
  it('does not cycle into bypass mode when bypass is disabled', async () => {
    const { config, timeline, sessionId } = fixture();
    config.settings.disableBypassPermissionsMode = true;
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    const visited = new Set<string>([latest!.mode]);
    for (let index = 0; index < 6; index++) {
      latest!.cycleMode();
      await tick();
      visited.add(latest!.mode);
    }

    expect(visited).not.toContain('bypassPermissions');
    expect(latest!.mode).toBe('auto');
  });

  it('starts a fresh session seeded with the approved plan on approve-fresh', async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    handoffState.plansToFire = ['Refactor the parser and add tests.'];

    await latest!.send('please plan this');
    await waitFor(() => loopCalls.length >= 2 && latest!.sessionId !== sessionId);

    // A brand-new conversation was started for the implementation.
    expect(latest!.sessionId).not.toBe(sessionId);
    // The model ran twice: the planning turn, then the reseeded implementation turn.
    expect(loopCalls).toHaveLength(2);
    // The reseeded turn received the approved plan as its context (not a summary).
    expect(loopCalls[1]).toContain('Refactor the parser and add tests.');
    expect(loopCalls[1]).toContain('<approved-plan>');
    // The transcript shows a short handoff line, not the whole plan re-pasted.
    const userMessages = latest!.messages.filter((message) => message.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe('Implementing the approved plan with a fresh context.');
  });

  it('does not reseed for a normal approval (no handoff)', async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    // No handoff fired; a normal send must not start a new conversation.
    await latest!.send('just do it here');
    await tick();
    await tick();

    expect(latest!.sessionId).toBe(sessionId);
    expect(loopCalls).toHaveLength(1);
  });

  it('does not drop a second handoff raised during the first reseed', async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    // Planning turn hands off PLAN_1; the PLAN_1 implementation re-plans and hands
    // off PLAN_2; the PLAN_2 implementation runs clean.
    handoffState.plansToFire = ['PLAN_1', 'PLAN_2'];

    await latest!.send('please plan this');
    await waitFor(() => loopCalls.length >= 3 && latest!.sessionId !== sessionId);

    // Three loop runs: planning, PLAN_1 impl (which re-plans), PLAN_2 impl.
    expect(loopCalls).toHaveLength(3);
    expect(loopCalls[1]).toContain('PLAN_1');
    expect(loopCalls[2]).toContain('PLAN_2');
    expect(latest!.sessionId).not.toBe(sessionId);
  });
});

// #524: a prompt-body command names the session after what the user typed, and a plan handoff,
// which the user typed nothing for, takes the planning session's name.
describe('useAgent session naming', () => {
  const initBody = 'You are initializing this project. Create or refine CLAUDE.md.';

  it('names the session after the typed command line, not the prompt body', async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    await latest!.send(initBody, undefined, undefined, '/init');
    await waitFor(() => latest!.sessionName !== undefined);

    expect(latest!.sessionName).toBe('Init');
    const loaded = timeline.load(sessionId);
    expect(loaded.meta.name).toBe('Init');
    // The transcript still shows the body the model ran.
    expect(loaded.transcript.find((message) => message.role === 'user')?.content).toBe(initBody);
  });

  it('names it "Deploy staging" for a custom command with arguments', async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    await latest!.send(
      'Roll out to the staging environment.',
      undefined,
      undefined,
      '/deploy staging',
    );
    await waitFor(() => latest!.sessionName !== undefined);

    expect(latest!.sessionName).toBe('Deploy staging');
  });

  it('keeps the name after the index is rebuilt from the JSONL', async () => {
    const { root, config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();
    await latest!.send(initBody, undefined, undefined, '/init');
    await waitFor(() => latest!.sessionName !== undefined);

    rmSync(join(root, 'sessions', 'session-index.json'), { force: true });

    expect(
      new SessionStore(join(root, 'sessions')).list().map((meta) => [meta.id, meta.name]),
    ).toEqual([[sessionId, 'Init']]);
  });

  it('keeps the existing name when a prompt-body command runs mid-session', async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();
    await latest!.send('review the parser');
    await waitFor(() => latest!.sessionName !== undefined);

    await latest!.send(initBody, undefined, undefined, '/init');

    expect(latest!.sessionName).toBe('Review the parser');
    expect(timeline.load(sessionId).meta.name).toBe('Review the parser');
  });

  it('still names the session after an ordinary prompt', async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();

    await latest!.send('fix the flaky login test');
    await waitFor(() => latest!.sessionName !== undefined);

    expect(latest!.sessionName).toBe('Fix the flaky login test');
  });

  it("gives the plan handoff's fresh session the planning session's name", async () => {
    const { config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();
    handoffState.plansToFire = ['Refactor the parser and add tests.'];

    await latest!.send('please plan this');
    await waitFor(() => loopCalls.length >= 2 && latest!.sessionId !== sessionId);
    await waitFor(() => latest!.sessionName !== undefined);

    const freshId = latest!.sessionId;
    expect(freshId).not.toBe(sessionId);
    // Not "Implementing the approved plan with a fresh context".
    expect(latest!.sessionName).toBe('Please plan this');
    expect(timeline.load(freshId).meta.name).toBe('Please plan this');
    expect(timeline.load(sessionId).meta.name).toBe('Please plan this');
  });

  it('carries a truncated planning name verbatim, and records it', async () => {
    const { root, config, timeline, sessionId } = fixture();
    render(<Harness config={config} session={bootstrap(timeline, sessionId)} />);
    await tick();
    handoffState.plansToFire = ['Refactor the parser and add tests.'];

    // Long enough that the planning session's own name is clipped to end in `...`.
    await latest!.send(
      'Refactor the provider discovery so that a refresh keeps every override the user set',
    );
    await waitFor(() => loopCalls.length >= 2 && latest!.sessionId !== sessionId);
    await waitFor(() => latest!.sessionName !== undefined);

    const planningName = timeline.load(sessionId).meta.name!;
    expect(planningName.endsWith('...')).toBe(true);
    const freshId = latest!.sessionId;
    expect(latest!.sessionName).toBe(planningName);
    // Recorded in the new session's meta: it survives a reload and an index rebuild.
    expect(timeline.load(freshId).meta.name).toBe(planningName);
    expect(new SessionStore(join(root, 'sessions')).load(freshId).meta.name).toBe(planningName);
    rmSync(join(root, 'sessions', 'session-index.json'), { force: true });
    const rebuilt = new SessionStore(join(root, 'sessions'));
    expect(rebuilt.list().find((meta) => meta.id === freshId)?.name).toBe(planningName);
  });
});
