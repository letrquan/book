import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';
import { createTerminalOutcome } from '../../types/terminal.js';
import type { AgentTerminalOutcome } from '../../types/terminal.js';
import type { AgentLoopCallbacks } from '../../types/providers.js';

/**
 * A provider failure mid-run used to leave no trace anywhere: the loop skips
 * `onAssistantMessageComplete` on its error path, and that callback is the only
 * writer to the session store. The run simply stopped, which is indistinguishable
 * from a model that decided it was done.
 */

const scripted = vi.hoisted(() => ({
  error: null as string | null,
  outcome: null as AgentTerminalOutcome | null,
}));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      _message: string,
      history: unknown[],
      callbacks: AgentLoopCallbacks,
    ) => {
      if (scripted.error) callbacks.onError(scripted.error);
      if (scripted.outcome) callbacks.onTerminal?.(scripted.outcome);
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
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-stream-error-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const timeline = new SessionStore(join(root, 'sessions'));
  const sessionId = timeline.create({ cwd: workspace });
  const loaded = timeline.load(sessionId);
  return {
    timeline,
    sessionId,
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

function localContents(): string[] {
  return (latest?.messages ?? [])
    .filter((message) => (message as { kind?: string }).kind === 'local')
    .map((message) => message.content);
}

afterEach(() => {
  scripted.error = null;
  scripted.outcome = null;
  cleanup();
  latest = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a run that ends badly', () => {
  it('is reported in the transcript rather than stopping silently', async () => {
    scripted.error = 'Provider stream ended before its terminal event.';
    scripted.outcome = createTerminalOutcome('interrupted', 'transport_interrupted', {
      partialOutput: false,
      message: 'Provider stream ended before its terminal event.',
    });
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('review the diff');
    await tick();

    expect(localContents()).toEqual(['✕ Provider stream ended before its terminal event.']);
  });

  it('shows the failure once, not as a banner and a row at the same time', async () => {
    // The terminal snapshot sets the transient banner synchronously during the
    // send; the durable transcript row is written in the teardown just after.
    // Both rendering the same sentence reads as two separate failures.
    scripted.outcome = createTerminalOutcome('failed', 'protocol_error', {
      partialOutput: false,
      message: 'The provider returned an empty response after one retry.',
    });
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('review the diff');
    await tick();

    expect(localContents()).toHaveLength(1);
    expect(latest!.error).toBeNull();
  });

  it('survives a reload, so a resumed session still shows why it stopped', async () => {
    scripted.outcome = createTerminalOutcome('failed', 'protocol_error', {
      partialOutput: false,
      message: 'The provider returned an empty response after one retry.',
    });
    const { config, session, timeline, sessionId } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('review the diff');
    await tick();

    const reloaded = timeline.load(sessionId);
    expect(
      reloaded.transcript.filter((message) => (message as { kind?: string }).kind === 'local'),
    ).toHaveLength(1);
  });

  it('leaves a clean turn alone', async () => {
    scripted.outcome = createTerminalOutcome('completed', 'normal_completion', {
      partialOutput: false,
    });
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('review the diff');
    await tick();

    expect(localContents()).toEqual([]);
  });

  it('stays quiet for a problem the run recovered from', async () => {
    // A skill that fails to activate reports through `onError` and the turn then
    // carries on and completes. Keying the notice off the error event stamped a
    // failure onto the end of a turn that succeeded, and persisted it, so it came
    // back on every resume.
    scripted.error = 'Skill "deploy" could not be activated.';
    scripted.outcome = createTerminalOutcome('completed', 'normal_completion', {
      partialOutput: false,
    });
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('use the deploy skill');
    await tick();

    expect(localContents()).toEqual([]);
  });

  it('stays quiet when the user cancelled the turn', async () => {
    scripted.outcome = createTerminalOutcome('cancelled', 'user_cancelled', {
      partialOutput: true,
      message: 'Agent execution was interrupted.',
    });
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('review the diff');
    await tick();

    expect(localContents()).toEqual([]);
  });

  it('does not replay a previous turn failure onto the next turn', async () => {
    scripted.outcome = createTerminalOutcome('failed', 'protocol_error', {
      partialOutput: false,
      message: 'The provider returned an empty response after one retry.',
    });
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('first');
    await tick();

    scripted.outcome = createTerminalOutcome('completed', 'normal_completion', {
      partialOutput: false,
    });
    await latest!.send('second');
    await tick();

    expect(localContents()).toHaveLength(1);
  });
});
