import { describe, expect, it } from 'vitest';
import type { execFile as ExecFile } from 'child_process';
import type { ToolContext } from '../types.js';
import { runGit } from './git.js';

const ctx: ToolContext = { workspaceRoot: '/workspace', env: { TEST_ENV: 'yes' } };
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

type ExecInvocation = {
  file: string;
  args: readonly string[];
  options: { cwd?: string; timeout?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv };
  callback: ExecCallback;
};

function fakeExecFile(implementation: (invocation: ExecInvocation) => void): typeof ExecFile {
  return ((
    file: string,
    args: readonly string[],
    options: ExecInvocation['options'],
    callback: ExecCallback,
  ) => {
    implementation({ file, args, options, callback });
    return {};
  }) as typeof ExecFile;
}

describe('runGit', () => {
  it('passes fixed argument arrays without a shell string', async () => {
    const calls: ExecInvocation[] = [];
    const execute = fakeExecFile((invocation) => {
      calls.push(invocation);
      invocation.callback(null, ' M src/app.ts\n', '');
    });

    const result = await runGit(['status', '--short'], ctx, execute);

    expect(result).toEqual({ success: true, output: ' M src/app.ts\n' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: 'git',
      args: ['status', '--short'],
      options: {
        cwd: '/workspace',
        timeout: 30_000,
        env: expect.objectContaining({ TEST_ENV: 'yes' }),
      },
    });
  });

  it('maps no output and stderr failures consistently', async () => {
    const callbacks = [
      (callback: ExecCallback) => callback(null, '', ''),
      (callback: ExecCallback) => callback(new Error('exit 1'), '', 'fatal: bad repository'),
    ];
    const execute = fakeExecFile(({ callback }) => callbacks.shift()!(callback));

    await expect(runGit(['status'], ctx, execute)).resolves.toEqual({
      success: true,
      output: '(no output)',
    });
    await expect(runGit(['status'], ctx, execute)).resolves.toEqual({
      success: false,
      output: '',
      error: 'fatal: bad repository',
    });
  });

  it('keeps the event loop responsive while git is running', async () => {
    const execute = fakeExecFile(({ callback }) => {
      setTimeout(() => callback(null, 'done', ''), 20);
    });

    let timerFired = false;
    const pending = runGit(['status'], ctx, execute);
    setTimeout(() => {
      timerFired = true;
    }, 0);

    await expect(pending).resolves.toMatchObject({ success: true });
    expect(timerFired).toBe(true);
  });

  it('reports cancellation from the active attempt signal', async () => {
    const controller = new AbortController();
    const execute = fakeExecFile(({ options, callback }) => {
      options.signal?.addEventListener('abort', () => callback(new Error('AbortError'), '', ''), {
        once: true,
      });
    });

    const pending = runGit(['status'], { ...ctx, signal: controller.signal }, execute);
    controller.abort();

    await expect(pending).resolves.toEqual({
      success: false,
      output: '',
      error: 'CANCELLED: Git command was cancelled',
    });
  });

  it('does not invoke a shell process', async () => {
    const calls: ExecInvocation[] = [];
    const execute = fakeExecFile((invocation) => {
      calls.push(invocation);
      invocation.callback(null, 'ok', '');
    });
    await runGit(['commit', '-m', 'message with spaces'], ctx, execute);

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('git');
    expect(calls[0].args).toEqual(['commit', '-m', 'message with spaces']);
  });
});
