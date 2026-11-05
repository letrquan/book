import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHooks } from '../hooks.js';
import type { Provider } from '../provider/index.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { toolSuccess } from '../tools/result.js';
import { runAgentLoop } from './loop.js';

// The scan a `Bash(pattern)` hook narrows with reads the session shell only on Windows, so what
// it does cannot be seen from here. What can be is that the loop hands the shell over on both paths.
vi.mock('../hooks.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../hooks.js')>();
  return { ...original, runHooks: vi.fn(original.runHooks) };
});

isolateBookHome();

describe('the session shell, from the loop to a tool hook (#687)', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'book-hook-shell-'));
    vi.mocked(runHooks).mockClear();
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it('reaches PreToolUse and PostToolUse', async () => {
    const gitBash = {
      kind: 'bash',
      file: 'C:/Program Files/Git/bin/bash.exe',
      msys: true,
      label: 'Git Bash',
      source: 'setting',
    } as const;
    const config = defaultConfig({ workspace, maxTurns: 2 });
    config.shell = gitBash;
    const hook = { command: 'exit 0', matcher: 'Bash(rm *)', env: {} };
    config.settings.hooks.PreToolUse = [hook];
    config.settings.hooks.PostToolUse = [hook];

    const registry = createDefaultRegistry();
    registry.register({
      ...registry.getTool('Bash')!,
      execute: async () => toolSuccess('ran'),
    });
    let turn = 0;
    const provider = {
      id: 'scripted',
      stream: async function* () {
        if (turn++ === 0) {
          const call = { id: 'bash-1', name: 'Bash', arguments: { command: 'ls' } };
          yield { type: 'tool_call', toolCall: call };
        } else yield { type: 'text', content: 'done' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    await runAgentLoop(
      config,
      registry,
      'go',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: async () => 'allow',
      },
      'bypassPermissions',
      { provider, isNewSession: false },
    );

    const shellFor = (event: string) =>
      vi.mocked(runHooks).mock.calls.find(([, called]) => called === event)?.[2].shell;
    expect(shellFor('PreToolUse')).toEqual(gitBash);
    expect(shellFor('PostToolUse')).toEqual(gitBash);
  });
});
