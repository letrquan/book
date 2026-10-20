import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBuiltinCommandRegistry,
  type BuiltinCommandContext,
} from '../../commands/builtins.js';
import type { CommandContext } from '../../types/commands.js';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';

/**
 * What the TUI expands in the text it sends. A `!` line runs only in text the user typed, and the
 * repository's text (a project command's body, or the REVIEW.md that `/security-review` carries)
 * inlines only files git has committed, unchanged.
 */

const loop = vi.hoisted(() => ({
  prompts: [] as string[],
  typed: [] as Array<string | undefined>,
}));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (
      _config: unknown,
      _registry: unknown,
      prompt: string,
      history: unknown,
      _callbacks: unknown,
      _mode: unknown,
      options?: { typedText?: string },
    ) => {
      loop.prompts.push(prompt);
      loop.typed.push(options?.typedText);
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

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Book Test',
      '-c',
      'user.email=book@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const REVIEW = [
  'Calibrate severity for this repository.',
  '!echo review-line > review-line.txt',
  'See @.env and @.book/settings.local.json and @STYLE.md when reviewing.',
  '',
].join('\n');

/** A repository with REVIEW.md and STYLE.md committed, and local files git ignores. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-repo-text-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'STYLE.md'), 'COMMITTED-STYLE\n');
  writeFileSync(join(workspace, '.gitignore'), '.env\n.book/settings.local.json\n');
  writeFileSync(join(workspace, 'REVIEW.md'), REVIEW);
  git(workspace, 'init', '-q');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-q', '-m', 'init');
  mkdirSync(join(workspace, '.book'), { recursive: true });
  writeFileSync(
    join(workspace, '.book', 'settings.local.json'),
    '{"provider":{"x":{"apiKey":"sk-FAKE-LOCAL-KEY"}}}\n',
  );
  writeFileSync(join(workspace, '.env'), 'API_TOKEN=FAKE-ENV-SECRET\n');

  const timeline = new SessionStore(join(root, 'sessions'));
  const sessionId = timeline.create({ cwd: workspace });
  const loaded = timeline.load(sessionId);
  return {
    workspace,
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

function lastPrompt(): string {
  return loop.prompts.at(-1) ?? '';
}

function commandContext(source: 'user' | 'project', body: string): CommandContext {
  return {
    command: { name: 'check', description: 'Check', body, source },
    resolvedBody: body,
    allowedTools: ['Read'],
  };
}

afterEach(() => {
  cleanup();
  latest = undefined;
  loop.prompts = [];
  loop.typed = [];
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('REVIEW.md in the /security-review prompt', () => {
  it('runs no line of it and inlines only the committed files it mentions', async () => {
    const { workspace, config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();
    const effect = createBuiltinCommandRegistry().execute('security-review', '', {
      workspace,
    } as BuiltinCommandContext);
    if (effect?.type !== 'send-prompt') throw new Error('expected a prompt');

    // As the app sends a built-in command's prompt.
    await latest!.send(
      effect.prompt,
      effect.context,
      undefined,
      '/security-review',
      effect.projectCommand,
    );

    const prompt = lastPrompt();
    expect(prompt).toContain('Calibrate severity for this repository.');
    expect(prompt).toContain('!echo review-line > review-line.txt');
    expect(existsSync(join(workspace, 'review-line.txt'))).toBe(false);
    expect(prompt).not.toContain('FAKE-ENV-SECRET');
    expect(prompt).not.toContain('sk-FAKE-LOCAL-KEY');
    expect(prompt).toContain('COMMITTED-STYLE');
    const stored = session.timelineStore.load(session.sessionId);
    expect(stored.transcript.map((message) => message.content)).toEqual(
      expect.arrayContaining(
        ['.env', '.book/settings.local.json'].map(
          (path) =>
            `⚠  Left @${path} as written: a project command inlines only files committed to git, and git does not track it.`,
        ),
      ),
    );
  });
});

describe('a rewind to a turn', () => {
  it("puts back the command line the user typed for a command's body", async () => {
    const { workspace, config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();
    const effect = createBuiltinCommandRegistry().execute('security-review', '', {
      workspace,
    } as BuiltinCommandContext);
    if (effect?.type !== 'send-prompt') throw new Error('expected a prompt');

    await latest!.send('Explain the build');
    await tick();
    await latest!.send(
      effect.prompt,
      effect.context,
      undefined,
      '/security-review',
      effect.projectCommand,
    );
    await tick();

    expect(latest!.getRewindTargets().map((target) => target.prompt)).toEqual([
      '/security-review',
      'Explain the build',
    ]);
    const target = latest!.getRewindTargets()[0]!;
    const rewound = await latest!.rewind(target.id, 'conversation');
    expect(rewound).toMatchObject({ ok: true, restoredPrompt: '/security-review' });
  });
});

/**
 * Records a turn as a session file holds one: its checkpoint when it has one (print mode writes
 * none), then the user event.
 */
function recordTurn(
  timeline: SessionStore,
  sessionId: string,
  turn: {
    id: string;
    prompt: string;
    content: string;
    derived?: boolean;
    promptTyped?: boolean;
    checkpoint?: boolean;
  },
): void {
  if (turn.checkpoint !== false) {
    timeline.append(sessionId, {
      type: 'turn_checkpoint',
      eventId: `checkpoint-${turn.id}`,
      timestamp: Date.now(),
      data: {
        version: 1,
        checkpointId: `checkpoint-${turn.id}`,
        userEventId: turn.id,
        prompt: turn.prompt,
        ...(turn.promptTyped ? { promptTyped: true } : {}),
        checkpoint: { codeUnavailableReason: 'not captured' },
      },
    });
  }
  timeline.append(sessionId, {
    type: 'user',
    eventId: turn.id,
    timestamp: Date.now(),
    data: {
      id: turn.id,
      content: turn.content,
      derivedContent: turn.derived,
      kind: 'conversation',
    },
  });
}

describe('a rewind to a resumed turn', () => {
  it('puts back only a prompt recorded as typed', async () => {
    const { config, session } = fixture();
    const timeline = session.timelineStore;
    const body = 'Run this:\n!echo legacy-line > legacy-line.txt\nwith $probe';
    recordTurn(timeline, session.sessionId, {
      id: 'typed-turn',
      prompt: 'Explain the build',
      content: 'Explain the build',
      promptTyped: true,
    });
    // A command's turn checkpointed before the typed line was recorded: its prompt is the body.
    recordTurn(timeline, session.sessionId, {
      id: 'checkpointed-body',
      prompt: body,
      content: body,
    });
    // A print-mode command's turn, which has no checkpoint.
    recordTurn(timeline, session.sessionId, {
      id: 'print-mode-body',
      prompt: body,
      content: body,
      derived: true,
      checkpoint: false,
    });
    const loaded = timeline.load(session.sessionId);
    render(
      <Harness
        config={config}
        session={{
          ...session,
          source: 'resume' as const,
          persisted: true,
          created: false,
          history: loaded.contextHistory,
          transcript: loaded.transcript,
          contextHistory: loaded.contextHistory,
          compactBoundaries: loaded.compactBoundaries,
          rewindTargets: loaded.rewindTargets,
          activeEventIds: loaded.activeEventIds,
        }}
      />,
    );
    await tick();

    const targets = latest!.getRewindTargets();
    expect(targets.map((target) => target.prompt)).toEqual([body, body, 'Explain the build']);
    for (const target of targets.slice(0, 2)) {
      expect(await latest!.rewind(target.id, 'conversation')).toEqual({ ok: true });
      await tick();
    }
    expect(await latest!.rewind(targets[2]!.id, 'conversation')).toMatchObject({
      ok: true,
      restoredPrompt: 'Explain the build',
    });
  });
});

describe('a `!` line in the text the TUI sends', () => {
  it('runs in text the user typed', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('Output:\n!echo typed-line');

    expect(lastPrompt()).toContain('typed-line');
    expect(lastPrompt()).not.toContain('!echo');
  });

  it("stays text in the body of the user's own command, with or without a context", async () => {
    const { workspace, config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();
    // Its shell substitution has already run, and what it printed is in the body.
    const body = 'Output:\n!echo user-command-line > user-command-line.txt';

    await latest!.send(body, commandContext('user', body), undefined, '/check');
    expect(lastPrompt()).toBe(body);
    await latest!.send(body, undefined, undefined, '/check', false);
    expect(lastPrompt()).toBe(body);

    expect(existsSync(join(workspace, 'user-command-line.txt'))).toBe(false);
  });

  it("stays text in a built-in command's prompt, even one not marked as the repository's", async () => {
    const { workspace, config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();
    const body = 'Output:\n!echo builtin-line > builtin-line.txt';

    await latest!.send(body, commandContext('project', body), undefined, '/check');

    expect(lastPrompt()).toBe(body);
    expect(existsSync(join(workspace, 'builtin-line.txt'))).toBe(false);
  });
});

// Only what the user typed invokes a skill by `$name` (the loop scans `typedText` alone): their
// text, or the command line that ran a command, never the body or prompt the command sent.
describe('the typed text the TUI hands the loop', () => {
  it('is the text the user typed', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('$probe check the parser');

    expect(loop.typed.at(-1)).toBe('$probe check the parser');
  });

  it("is the command line, not a project command's body", async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();
    const body = 'Check with $probe';

    await latest!.send(body, commandContext('project', body), undefined, '/check', true);
    expect(loop.typed.at(-1)).toBe('/check');
    await latest!.send(body, commandContext('user', body), undefined, '/check $other');
    expect(loop.typed.at(-1)).toBe('/check $other');
  });

  it('is the command line, not the REVIEW.md /security-review carries', async () => {
    const { workspace, config, session } = fixture();
    writeFileSync(join(workspace, 'REVIEW.md'), 'Review with $probe.\n');
    render(<Harness config={config} session={session} />);
    await tick();
    const effect = createBuiltinCommandRegistry().execute('security-review', '', {
      workspace,
    } as BuiltinCommandContext);
    if (effect?.type !== 'send-prompt') throw new Error('expected a prompt');

    await latest!.send(
      effect.prompt,
      effect.context,
      undefined,
      '/security-review',
      effect.projectCommand,
    );

    expect(lastPrompt()).toContain('Review with $probe.');
    expect(loop.typed.at(-1)).toBe('/security-review');
  });

  it("is the /goal line, not the goal's kickoff prompt", async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    latest!.setGoal('$probe passes');
    await tick();

    expect(loop.typed.at(-1)).toBe('/goal $probe passes');
    expect(latest!.getRewindTargets()[0]?.prompt).toBe('/goal $probe passes');
  });

  it("is absent for a managed agent's completion notice", async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.sendAgentCompletions([
      {
        deliveryId: 'agent-1:1',
        sequence: 1,
        completion: {
          agentId: 'agent-1',
          displayName: 'Atlas',
          profile: 'explorer',
          status: 'completed',
          resolvedModel: 'test/model',
          isolation: 'workspace-readonly',
          summary: 'Use $probe next',
          summaryCharacters: 15,
          summaryTruncated: false,
          errorCharacters: 0,
          errorTruncated: false,
          evidenceIds: [],
          createdAt: 10,
          startedAt: 20,
          updatedAt: 80,
          finishedAt: 80,
        },
      },
    ]);

    expect(loop.prompts.at(-1)).toContain('$probe');
    expect(loop.typed.at(-1)).toBeUndefined();
    // Nor does a rewind to it put the notice back in the composer to be sent as typed text.
    await tick();
    const target = latest!.getRewindTargets()[0]!;
    expect(target.prompt).toBe('Atlas completed: Use $probe next');
    expect(await latest!.rewind(target.id, 'conversation')).toEqual({ ok: true });
  });
});
