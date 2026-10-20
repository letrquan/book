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
 * What the TUI expands in the text it sends. A `!` line runs only in text the user typed or in
 * their own command's body, and the repository's text (a project command's body, or the
 * REVIEW.md that `/security-review` carries) inlines only files git has committed, unchanged.
 */

const loop = vi.hoisted(() => ({ prompts: [] as string[] }));

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(
    async (_config: unknown, _registry: unknown, prompt: string, history: unknown) => {
      loop.prompts.push(prompt);
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

describe('a `!` line in the text the TUI sends', () => {
  it('runs in text the user typed', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();

    await latest!.send('Output:\n!echo typed-line');

    expect(lastPrompt()).toContain('typed-line');
    expect(lastPrompt()).not.toContain('!echo');
  });

  it("runs in the body of the user's own command", async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);
    await tick();
    const body = 'Output:\n!echo user-command-line';

    await latest!.send(body, commandContext('user', body), undefined, '/check');

    expect(lastPrompt()).toContain('user-command-line');
    expect(lastPrompt()).not.toContain('!echo');
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
