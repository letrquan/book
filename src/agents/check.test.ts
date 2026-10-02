import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkTools } from './check.js';
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
        expect(`${result.structuredError?.message ?? ''}`.toLowerCase()).toMatch(
          /read-only file system/,
        );
        expect(existsSync(join(dir, '.book', 'x'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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
