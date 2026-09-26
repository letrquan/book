import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHooks } from './hooks.js';
import { isProcessAlive } from './jobs/process-tree.js';
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
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
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
      await waitFor(() => !isProcessAlive(pids.grandchild), 'the grandchild to end', 5_000);
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
      await waitFor(() => !isProcessAlive(pids!.grandchild), 'the grandchild to end', 5_000);
    } finally {
      if (exitCode === 'lingered') host.kill('SIGKILL');
      killSurvivors(pids);
    }
  }, 40_000);

  it('decodes a character split across two reads', async () => {
    const script = join(dir, 'split.cjs');
    writeFileSync(
      script,
      [
        "const bytes = Buffer.from(JSON.stringify({ action: 'modify', output: 'price: €5' }));",
        "const cut = bytes.indexOf(Buffer.from('€')) + 1;",
        'process.stdout.write(bytes.subarray(0, cut));',
        'setTimeout(() => process.stdout.write(bytes.subarray(cut)), 100);',
      ].join('\n'),
    );
    const results = await runHooks(
      [{ command: `"${process.execPath}" "${script}"`, env: {} }],
      'PostToolUse',
      ctx({ event: 'PostToolUse' as HookEvent }),
    );
    expect(results[0].modifiedOutput).toBe('price: €5');
  });

  it('caps each output stream on its own', async () => {
    const script = join(dir, 'noisy.cjs');
    writeFileSync(
      script,
      [
        "process.stderr.write('x'.repeat(700 * 1024));",
        "process.stdout.write(JSON.stringify({ action: 'block', message: 'no' }));",
      ].join('\n'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const results = await runHooks(
        [{ command: `"${process.execPath}" "${script}"`, env: {} }],
        'PreToolUse',
        ctx(),
      );
      expect(results[0]).toMatchObject({ action: 'block', message: 'no' });
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the answer of a hook that exits before its timeout but leaves its pipes held', async () => {
    const pidPath = join(dir, 'background.pid');
    const background = join(dir, 'background.cjs');
    writeFileSync(
      background,
      `require('fs').writeFileSync(${JSON.stringify(pidPath)}, '0 ' + process.pid);
setInterval(() => {}, 1000);
`,
    );
    // The shell starts a process that inherits the hook's pipes, answers, and exits at once. The
    // 0.4 s timeout falls inside the 0.5 s drain that follows the exit.
    const command =
      process.platform === 'win32'
        ? `start "" /b "${process.execPath}" "${background}" & echo {"action":"block","message":"late"}`
        : `"${process.execPath}" "${background}" & echo '{"action":"block","message":"late"}'`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const results = await runHooks([{ command, env: {} }], 'PreToolUse', ctx(), {
        timeoutMs: 400,
      });
      expect(results[0]).toMatchObject({ action: 'block', message: 'late' });
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('timed out'));
    } finally {
      warn.mockRestore();
      await waitFor(() => readPids(pidPath) !== undefined, 'the background pid', 5_000).catch(
        () => undefined,
      );
      killSurvivors(readPids(pidPath));
    }
  }, 20_000);

  it('does not wait for a process the hook leaves running', async () => {
    const pidPath = join(dir, 'background.pid');
    const script = join(dir, 'leaves-one-running.cjs');
    writeFileSync(
      script,
      [
        "const { spawn } = require('child_process');",
        "const background = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
        `require('fs').writeFileSync(${JSON.stringify(pidPath)}, process.pid + ' ' + background.pid);`,
        "process.stdout.write(JSON.stringify({ action: 'block', message: 'decided' }));",
        'process.exit(0);',
      ].join('\n'),
    );
    const startedAt = Date.now();
    try {
      const results = await runHooks(
        [{ command: `"${process.execPath}" "${script}"`, env: {} }],
        'PreToolUse',
        ctx(),
      );
      expect(results[0]).toMatchObject({ action: 'block', message: 'decided' });
      // Well inside the 10 s timeout: the hook's own exit decided it.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      killSurvivors(readPids(pidPath));
    }
  }, 20_000);
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
