import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkTools } from './check.js';
import { toolResultModelContent } from '../tools/result.js';
import { defaultConfig } from '../test/fixtures.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { sandboxBackendAvailable } from '../sandbox.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolContext, ToolResult } from '../types/tools.js';

const Check = checkTools.find((tool) => tool.name === 'Check')!;

function contextWith(checks: Record<string, string>, checkTimeoutMs?: number): ToolContext {
  const config: AgentConfig = defaultConfig();
  config.settings.agents.checks = checks;
  if (checkTimeoutMs !== undefined) config.settings.agents.checkTimeoutMs = checkTimeoutMs;
  // Only the fields Check reads; a full ToolContext is not needed to exercise it.
  return {
    workspaceRoot: process.cwd(),
    env: {},
    agentConfig: config,
  } as unknown as ToolContext;
}

function run(ctx: ToolContext, name: string): Promise<ToolResult> {
  return Check.execute({ name }, ctx) as Promise<ToolResult>;
}

describe('Check', () => {
  it('reports a passing command as success', async () => {
    const result = await run(contextWith({ ok: `node -e "console.log('passed')"` }), 'ok');
    expect(result.status).toBe('success');
  });

  it('reports a non-zero exit as a plain failure', async () => {
    const result = await run(
      contextWith({ boom: `node -e "console.error('assertion failed'); process.exit(3)"` }),
      'boom',
    );
    expect(result.status).not.toBe('success');
    expect(result.structuredError?.code).toBe('tool_error');
  });

  it('records the exit code of a failing check for the transcript', async () => {
    const result = await run(contextWith({ boom: 'exit 3' }), 'boom');
    expect(result.status).not.toBe('success');
    expect(result.structuredError?.details).toEqual({ exitCode: 3 });
  });

  // Issue 473: a runner prints its failing assertions on stdout while npm warns on stderr, and the
  // failure used to keep only stderr.
  const STDOUT_LINE = 'FAIL test/a.test.js > expected 1, got 2';
  const STDERR_LINE = 'npm warn config something';
  const stdoutAndStderrCheck = `node -e "console.log('${STDOUT_LINE}'); console.error('${STDERR_LINE}'); process.exit(1)"`;

  it('reports a failing check the way a failed Bash does: stderr message, stdout content', async () => {
    const result = await run(contextWith({ both: stdoutAndStderrCheck }), 'both');

    expect(result.status).not.toBe('success');
    expect(result.structuredError?.message).toContain(STDERR_LINE);
    expect(result.structuredError?.message).not.toContain(STDOUT_LINE);
    expect(result.content).toContain(STDOUT_LINE);
    expect(result.content).not.toContain(STDERR_LINE);
    expect(result.structuredError?.details).toEqual({ exitCode: 1 });
  });

  it('reports `Exit code: N` and keeps stdout as content when a failing check wrote no stderr', async () => {
    const result = await run(
      contextWith({ quiet: `node -e "console.log('${STDOUT_LINE}'); process.exit(1)"` }),
      'quiet',
    );

    expect(result.status).not.toBe('success');
    expect(result.structuredError?.message).toBe('Exit code: 1');
    expect(result.content).toContain(STDOUT_LINE);
    expect(result.structuredError?.details).toEqual({ exitCode: 1 });
    const modelText = toolResultModelContent(result);
    expect(modelText.split(STDOUT_LINE)).toHaveLength(2);
  });

  it('does not treat whitespace-only stderr as stderr', async () => {
    const result = await run(
      contextWith({
        blank: `node -e "console.log('${STDOUT_LINE}'); process.stderr.write('\\n'); process.exit(1)"`,
      }),
      'blank',
    );

    expect(result.status).not.toBe('success');
    expect(result.structuredError?.message).toBe('Exit code: 1');
    expect(result.content).toContain(STDOUT_LINE);
    expect(result.structuredError?.details).toEqual({ exitCode: 1 });
  });

  it('hands the model both streams of a failing check that wrote stdout and stderr', async () => {
    const result = await run(contextWith({ both: stdoutAndStderrCheck }), 'both');

    // The text the agent loop sends as the tool message (agent/context.ts).
    const modelText = toolResultModelContent(result);

    expect(modelText).toContain(STDOUT_LINE);
    expect(modelText).toContain(STDERR_LINE);
  });

  it('reports the shell’s stderr for a command that does not exist', async () => {
    const ctx = contextWith({ missing: 'book-no-such-command-473' });
    const result = await run(ctx, 'missing');

    expect(result.status).not.toBe('success');
    // The shell reports the missing command on stderr, so it is a numeric exit: POSIX sh
    // exits 127, Windows cmd.exe exits 1.
    expect(result.structuredError?.details).toEqual({
      exitCode: process.platform === 'win32' ? 1 : 127,
    });
    expect(result.structuredError?.message).toContain('book-no-such-command-473');
    expect(result.structuredError?.message).not.toMatch(/^Exit code:/);
  });

  it('distinguishes a timeout from a failing check', async () => {
    // The bug this guards: exec kills the child with SIGTERM on timeout, and
    // reporting that as an ordinary failure tells the agent its suite failed when
    // the suite never finished — so it "fixes" code that was passing. On a large
    // repository `npm test` exceeds the old hardcoded 120s ceiling every time.
    const result = await run(
      contextWith({ slow: `node -e "setTimeout(() => {}, 10000)"` }, 1_000),
      'slow',
    );
    expect(result.status).not.toBe('success');
    expect(result.structuredError?.code).toBe('check_timed_out');
    expect(result.structuredError?.retryable).toBe(true);
    expect(result.structuredError?.message).toContain('did not fail');
    expect(result.structuredError?.details).toMatchObject({ timeoutMs: 1_000 });
    expect(result.structuredError?.details).not.toHaveProperty('exitCode');
  });

  it('keeps both streams of a timed-out check', async () => {
    const result = await run(
      contextWith(
        {
          hang: `node -e "console.log('${STDOUT_LINE}'); console.error('${STDERR_LINE}'); setTimeout(() => {}, 10000)"`,
        },
        1_000,
      ),
      'hang',
    );

    expect(result.structuredError?.code).toBe('check_timed_out');
    expect(result.content).toContain(STDOUT_LINE);
    expect(result.content).toContain(STDERR_LINE);
  });

  it('honors a raised agents.checkTimeoutMs', async () => {
    const result = await run(
      contextWith({ brief: `node -e "setTimeout(() => console.log('done'), 200)"` }, 30_000),
      'brief',
    );
    expect(result.status).toBe('success');
  });

  it('still rejects an unknown check name', async () => {
    const result = await run(contextWith({ ok: 'node -e ""' }), 'nope');
    expect(result.status).not.toBe('success');
    expect(result.structuredError?.message).toContain('Unknown check');
  });
});

/**
 * A check command is a project-supplied command with the project's own
 * workspace root as its cwd, so it is exactly what the sandbox is for. It used
 * to run through `exec` with no sandbox and no `allowUnsandboxedCommands`
 * check, which made "the sandbox is on and unsandboxed commands are refused"
 * a promise `Check` quietly did not keep (#373).
 */
describe('Check and the sandbox', () => {
  const SANDBOX_ENABLED = {
    ...DEFAULT_SETTINGS.sandbox,
    enabled: true,
    allowUnsandboxedCommands: false,
  };

  it('runs a sandboxed check through the wrapper the session provides', async () => {
    const ctx = contextWith({ wrapped: 'echo hello' });
    ctx.sandbox = SANDBOX_ENABLED;
    const calls: Array<{ file: string; args: string[] }> = [];
    ctx.runtime = {
      sandbox: () => ({
        wrap: (command: string) => {
          calls.push({ file: 'fake-wrapper', args: [command] });
          // Node stands in for the wrapper binary: what matters is that the
          // wrapped argv was spawned, not that `echo` ran inside bubblewrap.
          return { file: process.execPath, args: ['-e', 'console.log("wrapped ok")'] };
        },
        describe: () => 'fake wrapper',
      }),
    } as unknown as ToolContext['runtime'];

    const result = await run(ctx, 'wrapped');

    expect(result.status).toBe('success');
    // Marked the way a sandboxed Bash command is marked, so a transcript says
    // which of the two things ran.
    expect(result.content).toContain('[sandboxed]');
    expect(result.content).toContain('wrapped ok');
    expect(calls).toEqual([{ file: 'fake-wrapper', args: ['echo hello'] }]);
  });

  it('refuses the check when it would run unsandboxed and unsandboxed commands are refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-check-refused-'));
    const sideEffect = join(dir, 'must-not-appear.txt');
    try {
      const ctx = contextWith({
        escaping: `node -e "require('fs').writeFileSync(${JSON.stringify(sideEffect)}, 'x')"`,
      });
      ctx.workspaceRoot = dir;
      ctx.sandbox = SANDBOX_ENABLED;
      // A session runtime with no usable backend is exactly what
      // `failIfUnavailable: false` tolerates on a machine without bubblewrap.
      ctx.runtime = { sandbox: () => null } as unknown as ToolContext['runtime'];

      const result = await run(ctx, 'escaping');

      expect(result.status).not.toBe('success');
      expect(result.structuredError?.message).toContain('unsandboxed');
      expect(result.structuredError?.message).toContain('allowUnsandboxedCommands');
      // Refused means the command never ran.
      expect(existsSync(sideEffect)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the backend is missing and failIfUnavailable is set', async () => {
    const ctx = contextWith({ ok: 'node -e ""' });
    ctx.sandbox = { ...SANDBOX_ENABLED, failIfUnavailable: true };
    ctx.runtime = { sandbox: () => null } as unknown as ToolContext['runtime'];

    const result = await run(ctx, 'ok');

    expect(result.status).not.toBe('success');
    expect(result.structuredError?.message).toContain('failIfUnavailable');
  });

  it('runs an excluded check unsandboxed when unsandboxed commands are allowed', async () => {
    const ctx = contextWith({ excluded: 'echo ran' });
    ctx.sandbox = {
      ...SANDBOX_ENABLED,
      allowUnsandboxedCommands: true,
      excludedCommands: ['echo ran'],
    };

    const result = await run(ctx, 'excluded');

    expect(result.status).toBe('success');
    expect(result.content).toContain('ran');
    expect(result.content).not.toContain('[sandboxed]');
  });

  it('leaves an unsandboxed check running as it always has when the sandbox is off', async () => {
    const ctx = contextWith({ plain: 'echo plain' });
    ctx.sandbox = { ...DEFAULT_SETTINGS.sandbox, enabled: false };

    const result = await run(ctx, 'plain');

    expect(result.status).toBe('success');
    expect(result.content).toContain('plain');
    expect(result.content).not.toContain('[sandboxed]');
  });

  it.skipIf(!sandboxBackendAvailable())(
    'cannot write a workspace control file from a sandboxed check',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'book-check-sandbox-'));
      try {
        // A shell redirection, not `node`: the namespace binds `/bin` but not
        // wherever this machine's node happens to live, and what is under test
        // is the read-only mount.
        const ctx = contextWith({ escaping: `printf pwned > .book/x` });
        ctx.workspaceRoot = dir;
        ctx.sandbox = SANDBOX_ENABLED;

        const result = await run(ctx, 'escaping');

        expect(result.status).not.toBe('success');
        // EROFS under bubblewrap, EPERM under Seatbelt.
        expect(`${result.structuredError?.message ?? ''}`.toLowerCase()).toMatch(
          process.platform === 'darwin' ? /operation not permitted/ : /read-only file system/,
        );
        expect(existsSync(join(dir, '.book', 'x'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!sandboxBackendAvailable())(
    'explains the read-only git directory when a sandboxed check cannot write it',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'book-check-git-config-'));
      try {
        execFileSync('git', ['init', '--quiet'], { cwd: dir });
        // A configured check is a project-supplied command, and `git remote add`
        // is one a repository's own checks reach for. Read-only inside the
        // namespace, it fails in words that name no cause.
        const ctx = contextWith({ remote: 'git remote add origin https://example.test/repo.git' });
        ctx.workspaceRoot = dir;
        ctx.sandbox = SANDBOX_ENABLED;

        const result = await run(ctx, 'remote');

        expect(result.status).not.toBe('success');
        expect(result.structuredError?.message).toContain(
          "the repository's git directory is read-only inside the sandbox",
        );
        expect(result.structuredError?.message).toContain(
          'sandbox.filesystem.allowGitWrites is off',
        );

        // With allowGitWrites: true, git may write but .git/config is read-only:
        const ctxOptOut = contextWith({
          remote: 'git remote add origin https://example.test/repo.git',
        });
        ctxOptOut.workspaceRoot = dir;
        ctxOptOut.sandbox = {
          ...SANDBOX_ENABLED,
          filesystem: { ...SANDBOX_ENABLED.filesystem, allowGitWrites: true },
        };
        const optOutResult = await run(ctxOptOut, 'remote');
        expect(optOutResult.status).not.toBe('success');
        expect(optOutResult.structuredError?.message).toContain(
          '.git/config is read-only inside the sandbox',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('explains the read-only git directory when the config error is on stdout', async () => {
    // A fake wrapper stands in for bubblewrap: what is under test is that the note scans both
    // streams, not that git ran inside a namespace.
    const ctx = contextWith({ remote: 'git remote add origin https://example.test/repo.git' });
    ctx.sandbox = {
      ...SANDBOX_ENABLED,
      filesystem: { ...SANDBOX_ENABLED.filesystem, allowGitWrites: false },
    };
    ctx.runtime = {
      sandbox: () => ({
        wrap: () => ({
          file: process.execPath,
          args: [
            '-e',
            "console.log('error: could not lock config file .git/config: Read-only file system'); console.error('fatal: unrelated stderr'); process.exit(1)",
          ],
        }),
        describe: () => 'fake wrapper',
      }),
    } as unknown as ToolContext['runtime'];

    const result = await run(ctx, 'remote');

    expect(result.status).not.toBe('success');
    expect(result.structuredError?.message).toContain('fatal: unrelated stderr');
    expect(result.structuredError?.message).toContain(
      "the repository's git directory is read-only inside the sandbox",
    );
  });

  it('leaves a check failure that was not about the config alone', async () => {
    const ctx = contextWith({ boom: `node -e "console.error('suite failed'); process.exit(1)"` });
    ctx.sandbox = { ...DEFAULT_SETTINGS.sandbox, enabled: true, allowUnsandboxedCommands: true };

    const result = await run(ctx, 'boom');

    expect(result.status).not.toBe('success');
    expect(`${result.structuredError?.message ?? ''}`).not.toContain(
      'read-only inside the sandbox',
    );
  });
});

/**
 * Book defaults NODE_ENV=production for its own renderer. A check command is a project-supplied
 * command, so it must not inherit a default nobody asked for.
 */
describe('Check child environment', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.BOOK_DEFAULTED_NODE_ENV = '1';
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  const reportEnv = (): string =>
    `node -e "console.log(JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? null, marker: process.env.BOOK_DEFAULTED_NODE_ENV ?? null }))"`;

  it('does not hand a check the NODE_ENV Book defaulted', async () => {
    const result = await run(contextWith({ env: reportEnv() }), 'env');

    expect(result.status).toBe('success');
    expect(result.content).toContain('"nodeEnv":null');
    expect(result.content).toContain('"marker":null');
  });

  it('passes a NODE_ENV the context sets explicitly', async () => {
    const ctx = contextWith({ env: reportEnv() });
    ctx.env = { NODE_ENV: 'test' };

    const result = await run(ctx, 'env');

    expect(result.content).toContain('"nodeEnv":"test"');
  });
});
