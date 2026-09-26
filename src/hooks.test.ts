import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHooks } from './hooks.js';
import type { HookEntry, HookEvent } from './settings.js';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

let dir: string;
const ctx = (overrides: Record<string, unknown> = {}) => ({
  workspace: dir,
  event: 'PreToolUse' as HookEvent,
  toolName: 'Bash',
  toolArgs: { command: 'ls' },
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-hooks-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runHooks — empty input', () => {
  it('returns empty array when no hooks configured', async () => {
    const results = await runHooks([], 'PreToolUse', ctx());
    expect(results).toEqual([]);
  });
});

describe('runHooks — continue', () => {
  it('runs a hook that exits 0 and returns continue', async () => {
    const hook: HookEntry = {
      command:
        process.platform === 'win32'
          ? 'echo {"action":"continue"}'
          : 'echo \'{"action":"continue"}\'',
      env: {},
    };
    const results = await runHooks([hook], 'Stop', ctx({ event: 'Stop' as HookEvent }));
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('continue');
  });

  it('treats exit code 0 with non-JSON stdout as continue', async () => {
    const hook: HookEntry = {
      command: process.platform === 'win32' ? 'echo just text' : 'echo "just text"',
      env: {},
    };
    const results = await runHooks([hook], 'Stop', ctx({ event: 'Stop' as HookEvent }));
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('continue');
  });
});

describe('runHooks — block', () => {
  it('detects exit code 2 as block', async () => {
    const hook: HookEntry = {
      command:
        process.platform === 'win32'
          ? 'echo {"action":"block","message":"nope"} & exit 2'
          : 'echo \'{"action":"block","message":"nope"}\' && exit 2',
      env: {},
    };
    const results = await runHooks([hook], 'PreToolUse', ctx());
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('block');
    expect(results[0].message).toBe('nope');
  });

  it('stops after first block on blocking events (PreToolUse)', async () => {
    const hook1: HookEntry = {
      command: process.platform === 'win32' ? 'exit 2' : 'exit 2',
      env: {},
    };
    const hook2: HookEntry = {
      command: process.platform === 'win32' ? 'echo never-runs' : 'echo "never-runs"',
      env: {},
    };
    const results = await runHooks([hook1, hook2], 'PreToolUse', ctx());
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('block');
  });
});

describe('runHooks — modify', () => {
  it('returns modify action with modified prompt', async () => {
    const hook: HookEntry = {
      command:
        process.platform === 'win32'
          ? 'echo {"action":"modify","message":"new prompt"}'
          : 'echo \'{"action":"modify","message":"new prompt"}\'',
      env: {},
    };
    const results = await runHooks(
      [hook],
      'UserPromptSubmit',
      ctx({ event: 'UserPromptSubmit' as HookEvent, userPrompt: 'old', toolName: undefined }),
    );
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('modify');
    expect(results[0].modifiedPrompt).toBe('new prompt');
  });
});

describe('runHooks — timeout', () => {
  it('skips a hook that exceeds the 10s timeout', async () => {
    const hook: HookEntry = {
      command: process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30',
      env: {},
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await runHooks([hook], 'Stop', ctx({ event: 'Stop' as HookEvent }));
    warnSpy.mockRestore();
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('continue');
  }, 15000);
});

describe('runHooks — cancellation', () => {
  it('terminates an active hook and rejects with the abort reason', async () => {
    const hook: HookEntry = {
      command: `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`,
      env: {},
    };
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runHooks([hook], 'Stop', ctx({ event: 'Stop' as HookEvent }), {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(new Error('hook cancelled')), 25);

    await expect(pending).rejects.toThrow('hook cancelled');
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('does not launch hooks for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before hooks'));

    await expect(
      runHooks(
        [{ command: 'echo should-not-run', env: {} }],
        'Stop',
        ctx({ event: 'Stop' as HookEvent }),
        { signal: controller.signal },
      ),
    ).rejects.toThrow('cancelled before hooks');
  });
});

describe('runHooks — process tree', () => {
  // A hook whose own child keeps running used to outlive the hook's timeout and its cancellation:
  // `kill()` reached only the shell wrapper (cmd.exe or sh), and the grandchild kept the hook's
  // stdout pipe open, so the host process could not exit until the grandchild did (#263).
  function treeHook(pidPath: string): HookEntry {
    const parent = join(dir, 'tree-parent.cjs');
    writeFileSync(
      parent,
      [
        "const { spawn } = require('child_process');",
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
        `require('fs').writeFileSync(${JSON.stringify(pidPath)}, process.pid + ' ' + grandchild.pid);`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    return { command: `"${process.execPath}" "${parent}"`, env: {} };
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  async function waitFor(predicate: () => boolean, what: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** The hook's own process and its grandchild, once the hook has written both. */
  function readPids(pidPath: string): { parent: number; grandchild: number } | undefined {
    if (!existsSync(pidPath)) return undefined;
    const [parent, grandchild] = readFileSync(pidPath, 'utf8').split(' ').map(Number);
    return parent > 0 && grandchild > 0 ? { parent, grandchild } : undefined;
  }

  function killSurvivors(pids: { parent: number; grandchild: number } | undefined): void {
    for (const pid of pids ? [pids.parent, pids.grandchild] : []) {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }

  it('ends the whole process tree when a hook is cancelled', async () => {
    const pidPath = join(dir, 'grandchild.pid');
    const controller = new AbortController();
    const pending = runHooks([treeHook(pidPath)], 'Stop', ctx({ event: 'Stop' as HookEvent }), {
      signal: controller.signal,
    });
    await waitFor(() => readPids(pidPath) !== undefined, 'the hook pids', 10_000);
    const pids = readPids(pidPath)!;
    try {
      controller.abort(new Error('hook cancelled'));
      await expect(pending).rejects.toThrow('hook cancelled');
      await waitFor(() => !isAlive(pids.grandchild), 'the grandchild to end', 5_000);
    } finally {
      killSurvivors(pids);
    }
  }, 20_000);

  it('lets the host process exit after a timed-out hook leaves a grandchild', async () => {
    const pidPath = join(dir, 'grandchild.pid');
    const hooksModule = pathToFileURL(join(process.cwd(), 'src', 'hooks.ts')).href;
    const script = [
      `import { runHooks } from ${JSON.stringify(hooksModule)};`,
      `const results = await runHooks([${JSON.stringify(treeHook(pidPath))}], 'SessionEnd', { workspace: ${JSON.stringify(dir)}, event: 'SessionEnd' }, { timeoutMs: 1000 });`,
      "console.log('settled ' + results[0].action);",
    ].join('\n');
    const host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    host.stdout.on('data', (data) => (stdout += String(data)));
    host.stderr.resume();
    const exitCode = await new Promise<number | null | 'lingered'>((resolve) => {
      const timer = setTimeout(() => resolve('lingered'), 20_000);
      host.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const pids = readPids(pidPath);
    try {
      expect(exitCode).toBe(0);
      expect(stdout).toContain('settled continue');
      expect(pids).toBeDefined();
      await waitFor(() => !isAlive(pids!.grandchild), 'the grandchild to end', 5_000);
    } finally {
      if (exitCode === 'lingered') host.kill('SIGKILL');
      killSurvivors(pids);
    }
  }, 40_000);
});

describe('runHooks — matcher filtering', () => {
  it('runs hook when matcher matches the tool call', async () => {
    const hook: HookEntry = {
      matcher: 'Bash(ls *)',
      command:
        process.platform === 'win32'
          ? 'echo {"action":"block"} & exit 2'
          : 'echo \'{"action":"block"}\' && exit 2',
      env: {},
    };
    const results = await runHooks([hook], 'PreToolUse', ctx());
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('block');
  });

  it('skips hook when matcher does not match', async () => {
    const hook: HookEntry = {
      matcher: 'Bash(rm *)',
      command: process.platform === 'win32' ? 'exit 2' : 'exit 2',
      env: {},
    };
    const results = await runHooks([hook], 'PreToolUse', ctx({ toolArgs: { command: 'ls' } }));
    expect(results.length).toBe(0);
  });

  it('runs hook with no matcher for all tool calls', async () => {
    const hook: HookEntry = {
      command: process.platform === 'win32' ? 'exit 2' : 'exit 2',
      env: {},
    };
    const results = await runHooks([hook], 'PreToolUse', ctx());
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('block');
  });

  it('matches legacy Edit path rules against ApplyPatch targets', async () => {
    const hook: HookEntry = {
      matcher: 'Edit(src/**)',
      command: process.platform === 'win32' ? 'exit 2' : 'exit 2',
      env: {},
    };
    const results = await runHooks(
      [hook],
      'PreToolUse',
      ctx({
        toolName: 'ApplyPatch',
        toolArgs: {
          patch: '*** Begin Patch\n*** Update File: src/main.ts\n@@\n-old\n+new\n*** End Patch',
        },
      }),
    );
    expect(results[0].action).toBe('block');
  });
});

describe('runHooks — env vars', () => {
  it('passes BOOK_WORKSPACE to the hook', async () => {
    const scriptPath = join(dir, 'test-hook.sh');
    writeFileSync(
      scriptPath,
      `#!/bin/bash
if [ "$BOOK_WORKSPACE" = "${dir.replace(/\\/g, '/')}" ]; then
  echo '{"action":"continue"}'
else
  echo '{"action":"block","message":"wrong workspace"}'
  exit 2
fi`,
    );
    const hook: HookEntry = {
      command: process.platform === 'win32' ? `echo {"action":"continue"}` : `bash "${scriptPath}"`,
      env: {},
    };
    const results = await runHooks([hook], 'Stop', ctx({ event: 'Stop' as HookEvent }));
    expect(results[0].action).toBe('continue');
  });
});
