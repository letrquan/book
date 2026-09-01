import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { persistentEnvironmentOverrides, shellTools } from './shell.js';
import { createDefaultRegistry } from './registry.js';
import { getPrimaryArg } from './primary-arg.js';
import { SessionRuntime } from '../session/runtime.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from '../settings.js';
import type { BackgroundShellStore } from '../types/runtime.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';

let dir: string;
let contexts: ToolContext[] = [];

function ctx(): ToolContext {
  const c: ToolContext = { workspaceRoot: dir, env: {} };
  contexts.push(c);
  return c;
}

function tool(name: string): ToolDefinition {
  const found = shellTools.find((t) => t.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

const bash = tool('Bash');
const bashOutput = tool('BashOutput');
const killShell = tool('KillShell');
const dismissShell = tool('DismissShell');

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function nodeCommand(name: string, source: string): string {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, source);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function shellIdFrom(result: ToolResult): string {
  const match = result.content.match(/shell_\d+/);
  if (!match) throw new Error(`No shell ID in output: ${result.content}`);
  return match[0];
}

async function waitForOutput(
  c: ToolContext,
  shellId: string,
  pattern: RegExp,
  timeoutMs = 5_000,
): Promise<ToolResult> {
  const start = Date.now();
  let last: ToolResult | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await bashOutput.execute({ shell_id: shellId }, c);
    if (last.content.match(pattern)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}; last output: ${last?.content}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-shell-'));
  contexts = [];
});

afterEach(async () => {
  for (const c of contexts) {
    for (const shell of c.backgroundShells?.shells.values() ?? []) {
      if (shell.status === 'running') {
        await killShell.execute({ shell_id: shell.id }, c);
      }
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('Bash shell tools', () => {
  it('persists only explicit non-sensitive environment overrides', () => {
    const inheritedSecret = process.env.OPENAI_API_KEY;
    const context: ToolContext = {
      workspaceRoot: dir,
      env: {
        ...process.env,
        OPENAI_API_KEY: inheritedSecret ?? 'inherited-secret',
      } as Record<string, string>,
      envOverrides: {
        BOOK_COLOR: 'always',
        OPENAI_API_KEY: 'explicit-secret',
        SERVICE_TOKEN: 'explicit-token',
      },
    };

    expect(persistentEnvironmentOverrides(context)).toEqual({ BOOK_COLOR: 'always' });
  });

  it('keeps foreground Bash behavior', async () => {
    const c = ctx();
    const command = nodeCommand('foreground.cjs', `console.log('foreground-ok');\n`);

    const result = await bash.execute({ command }, c);

    expect(result.status).toBe('success');
    expect(result.content).toContain('foreground-ok');
    expect(c.backgroundShells).toBeUndefined();
  });

  it('cancels a foreground Bash process through the tool signal', async () => {
    const controller = new AbortController();
    const c = { ...ctx(), workspaceRoot: process.cwd(), signal: controller.signal };
    const marker = join(dir, 'cancelled-process-survived.txt');
    const command = nodeCommand(
      'cancel-foreground.cjs',
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1500);\nsetInterval(() => {}, 1000);\n`,
    );
    const startedAt = Date.now();
    const pending = bash.execute({ command }, c);

    setTimeout(() => controller.abort('stop foreground shell'), 50);
    const result = await pending;

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/cancel/i);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(existsSync(marker)).toBe(false);
  });

  it('terminates the foreground process tree after a timeout', async () => {
    const c = { ...ctx(), workspaceRoot: process.cwd() };
    const marker = join(dir, 'timed-out-process-survived.txt');
    const command = nodeCommand(
      'timeout-foreground.cjs',
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1500);\nsetInterval(() => {}, 1000);\n`,
    );

    const result = await bash.execute({ command, timeout: 50 }, c);

    expect(result.status).toBe('timed_out');
    expect(result.structuredError?.code).toBe('tool_timeout');
    expect(result.structuredError?.message).toMatch(/killed after 50ms/i);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(existsSync(marker)).toBe(false);
  });

  it('hands back what a killed command printed, and says it was killed not failed', async () => {
    const c = { ...ctx(), workspaceRoot: process.cwd() };
    // Prints on both streams and then hangs forever. The 2s deadline is
    // generous on purpose: the point is the output that survives the kill, so
    // the child must have finished starting up well before the timer fires.
    const command = nodeCommand(
      'timeout-output.cjs',
      `console.log('ran-3-of-9-suites');\nconsole.error('still-compiling');\nsetInterval(() => {}, 1000);\n`,
    );

    const result = await bash.execute({ command, timeout: 2_000 }, c);

    expect(result.status).toBe('timed_out');
    // Labelled, not concatenated: the two streams are written on independent
    // schedules, so gluing them together invents a sequence.
    expect(result.content).toMatch(/--- stdout ---[\s\S]*ran-3-of-9-suites/);
    expect(result.content).toMatch(/--- stderr ---[\s\S]*still-compiling/);
    // A killed command and a failed one call for different next moves, so the
    // message has to distinguish them and the remediation channel names the
    // way out -- that is the field the model-facing `Fix:` line renders from.
    expect(result.structuredError?.message).toMatch(/still running, it did not fail/i);
    expect(result.structuredError?.remediation).toMatch(/run_in_background/);
  });

  // The schema's static maximum is validated upstream, but an operator's lower
  // BOOK_TOOL_TIMEOUT_MS is not in the schema, so a value inside the published
  // range can still be over the limit in force. Shrinking it quietly is the
  // failure this whole change set out to remove.
  it('refuses a timeout over the operator limit instead of quietly shrinking it', async () => {
    const c = { ...ctx(), workspaceRoot: process.cwd(), env: { BOOK_TOOL_TIMEOUT_MS: '30000' } };
    const command = nodeCommand('over-ceiling.cjs', `console.log('never-runs');\n`);

    const result = await bash.execute({ command, timeout: 600_000 }, c);

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/exceeds the 30000ms limit/);
    expect(result.content).not.toContain('never-runs');
  });

  it('honors the operator BOOK_TOOL_TIMEOUT_MS override', async () => {
    const c = {
      ...ctx(),
      workspaceRoot: process.cwd(),
      env: { BOOK_TOOL_TIMEOUT_MS: '50' },
    };
    const command = nodeCommand('env-timeout.cjs', `setInterval(() => {}, 1000);\n`);

    const startedAt = Date.now();
    const result = await bash.execute({ command }, c);

    expect(result.status).toBe('timed_out');
    expect(result.structuredError?.message).toMatch(/killed after 50ms/i);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('reports its own timeout through the registry instead of the contentless one', async () => {
    // The registry runs a deadline of its own over every call. Both used to be
    // 120s, and the registry arms its timer first, so its contentless
    // `tool_timeout` always replaced the shell's report — output and all.
    const registry = createDefaultRegistry();
    const c = { ...ctx(), workspaceRoot: process.cwd(), env: { BOOK_TOOL_TIMEOUT_MS: '2000' } };
    const command = nodeCommand(
      'registry-timeout.cjs',
      `console.log('progress-before-the-kill');\nsetInterval(() => {}, 1000);\n`,
    );

    const result = await registry.execute(
      { id: 'bash-1', name: 'Bash', arguments: { command } },
      c,
    );

    expect(result.status).toBe('timed_out');
    expect(result.content).toContain('progress-before-the-kill');
    expect(result.structuredError?.message).toMatch(/killed after 2000ms/i);
    expect(result.structuredError?.message).not.toMatch(/Tool timeout/);
  });

  it('starts a background shell and returns a shell ID quickly', async () => {
    const c = ctx();
    const command = nodeCommand(
      'background.cjs',
      `console.log('ready');\nsetInterval(() => {}, 1000);\n`,
    );

    const startedAt = Date.now();
    const result = await bash.execute({ command, run_in_background: true }, c);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.status).toBe('success');
    expect(result.content).toMatch(/Started background shell shell_\d+/);
    expect(result.content).toMatch(/BashOutput/);
    expect(c.backgroundShells?.shells.get(shellIdFrom(result))?.status).toBe('running');
  });

  it('reads background shell output incrementally and reports terminal status', async () => {
    const c = ctx();
    const command = nodeCommand(
      'output.cjs',
      `console.log('once');\nsetTimeout(() => process.exit(0), 50);\n`,
    );
    const start = await bash.execute({ command, run_in_background: true }, c);
    const shellId = shellIdFrom(start);

    const first = await waitForOutput(c, shellId, /once/);
    expect(first.status).toBe('success');
    expect(first.content).toContain('once');

    const terminal = await waitForOutput(
      c,
      shellId,
      /Shell shell_\d+: exited|Shell shell_\d+: failed/,
    );
    expect(terminal.status).toBe('success');
    expect(terminal.content).toMatch(/Shell shell_\d+: exited pid=\d+ exit=0/);

    const empty = await bashOutput.execute({ shell_id: shellId }, c);
    expect(empty.status).toBe('success');
    expect(empty.content).toContain('(no new output)');
  });

  it('kills a running background shell after the process exits', async () => {
    const c = ctx();
    const command = nodeCommand(
      'long-running.cjs',
      `console.log('ready-to-kill');\nsetInterval(() => {}, 1000);\n`,
    );
    const start = await bash.execute({ command, run_in_background: true }, c);
    const shellId = shellIdFrom(start);
    await waitForOutput(c, shellId, /ready-to-kill/);

    const killed = await killShell.execute({ shell_id: shellId }, c);
    const output = await bashOutput.execute({ shell_id: shellId }, c);

    expect(killed.status).toBe('success');
    expect(killed.content).toContain(`Killed shell ${shellId}`);
    expect(c.backgroundShells?.shells.get(shellId)?.status).toBe('killed');
    expect(c.backgroundShells?.shells.get(shellId)?.finishedAt).toBeDefined();
    expect(output.content).toMatch(/Shell shell_\d+: killed/);
  });

  it('fails clearly for unknown shell IDs', async () => {
    const c = ctx();

    const output = await bashOutput.execute({ shell_id: 'shell_missing' }, c);
    const killed = await killShell.execute({ shell_id: 'shell_missing' }, c);

    expect(output.status).toBe('error');
    expect(output.structuredError?.message).toMatch(/not found/i);
    expect(killed.status).toBe('error');
    expect(killed.structuredError?.message).toMatch(/not found/i);
  });

  it('dismisses completed shell records and their retained output', async () => {
    const c = ctx();
    const command = nodeCommand('dismiss.cjs', `console.log('done');\n`);
    const start = await bash.execute({ command, run_in_background: true }, c);
    const shellId = shellIdFrom(start);
    await waitForOutput(c, shellId, /Shell shell_\d+: exited|Shell shell_\d+: failed/);

    const dismissed = await dismissShell.execute({ shell_id: shellId }, c);

    expect(dismissed.status).toBe('success');
    expect(c.backgroundShells?.shells.has(shellId)).toBe(false);
  });

  it('prunes old terminal records to the retained-shell cap', async () => {
    const store: BackgroundShellStore = { nextId: 30, shells: new Map() };
    const now = Date.now();
    for (let index = 0; index < 30; index++) {
      store.shells.set(`shell_${index}`, {
        id: `shell_${index}`,
        command: 'done',
        effectiveCommand: 'done',
        workdir: dir,
        status: 'exited',
        output: 'retained',
        readOffset: 0,
        truncatedBytes: 0,
        startedAt: index,
        finishedAt: now + index,
      });
    }
    const c: ToolContext = { workspaceRoot: dir, env: {}, backgroundShells: store };
    contexts.push(c);

    await bashOutput.execute({ shell_id: 'shell_29' }, c);

    expect(store.shells.size).toBe(20);
    expect(store.shells.has('shell_0')).toBe(false);
    expect(store.shells.has('shell_29')).toBe(true);
  });

  it('shares configured background shell state across contexts', async () => {
    const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
    const first: ToolContext = { workspaceRoot: dir, env: {}, backgroundShells: store };
    const second: ToolContext = { workspaceRoot: dir, env: {}, backgroundShells: store };
    contexts.push(first, second);
    const command = nodeCommand('shared.cjs', `console.log('shared-ready');\n`);

    const start = await bash.execute({ command, run_in_background: true }, first);
    const shellId = shellIdFrom(start);
    const output = await waitForOutput(second, shellId, /shared-ready/);

    expect(output.status).toBe('success');
    expect(output.content).toContain('shared-ready');
  });

  it('times out background shells only when max_runtime_ms is explicitly supplied', async () => {
    const c = ctx();
    // The interval keeps the process alive forever, so reaching `timed_out`
    // proves the explicit deadline fired — a natural exit would read
    // `exited`/`failed` and fail the wait below. Deliberately no wait for the
    // child's own output first: the 50ms deadline may terminate the process
    // before node finishes starting up, so any output-before-timeout gate
    // races the very deadline under test.
    const command = nodeCommand('timeout.cjs', `setInterval(() => {}, 1000);\n`);
    const start = await bash.execute({ command, run_in_background: true, max_runtime_ms: 50 }, c);
    const shellId = shellIdFrom(start);

    const terminal = await waitForOutput(c, shellId, /Shell shell_\d+: timed_out/);

    expect(terminal.status).toBe('success');
    expect(c.backgroundShells?.shells.get(shellId)?.status).toBe('timed_out');
  });

  // `timeout` is the foreground deadline the Bash schema publishes, and the
  // schema says so. It used to double as a legacy alias for max_runtime_ms,
  // which was harmless only while the model could not see the argument: now
  // that it can, honouring it here would put a kill timer on the very job the
  // model backgrounded to escape one.
  // setTimeout rewrites anything past the 32-bit ceiling to 1ms, so an
  // unguarded 30-day runtime killed the job moments after it started and told
  // the model its deadline had fired.
  it('clamps a background runtime that a timer could not hold', async () => {
    const c = ctx();
    const command = nodeCommand('bg-overflow.cjs', `setInterval(() => {}, 1000);\n`);

    const start = await bash.execute(
      { command, run_in_background: true, max_runtime_ms: 30 * 24 * 60 * 60 * 1000 },
      c,
    );
    const shellId = shellIdFrom(start);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(c.backgroundShells?.shells.get(shellId)?.status).toBe('running');
  });

  it('does not let the foreground timeout become a background deadline', async () => {
    const c = ctx();
    const command = nodeCommand('bg-no-timeout.cjs', `setInterval(() => {}, 1000);\n`);

    const start = await bash.execute({ command, run_in_background: true, timeout: 50 }, c);
    const shellId = shellIdFrom(start);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(c.backgroundShells?.shells.get(shellId)?.status).toBe('running');
  });

  it('returns spawn failures instead of a usable shell ID', async () => {
    const c: ToolContext = { workspaceRoot: join(dir, 'missing'), env: {} };
    contexts.push(c);

    const result = await bash.execute(
      { command: 'node -e "console.log(1)"', run_in_background: true },
      c,
    );

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/ENOENT|no such file|directory/i);
    expect(c.backgroundShells?.shells.size ?? 0).toBe(0);
  });

  it('uses shell IDs as primary args', () => {
    expect(getPrimaryArg({ shell_id: 'shell_7' })).toBe('shell_7');
    expect(getPrimaryArg({ shellId: 'shell_8' })).toBe('shell_8');
  });
});

describe('sandbox.allowUnsandboxedCommands', () => {
  function sandboxCtx(overrides: Partial<ResolvedSettings['sandbox']>): ToolContext {
    const c: ToolContext = {
      workspaceRoot: dir,
      env: {},
      sandbox: { ...structuredClone(DEFAULT_SETTINGS.sandbox), ...overrides },
    };
    contexts.push(c);
    return c;
  }

  /** A command whose only observable effect is a file, so "did it run?" is testable. */
  function sideEffectCommand(name: string): { command: string; marker: string } {
    const marker = join(dir, name);
    return {
      command: nodeCommand(
        `${name}.cjs`,
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`,
      ),
      marker,
    };
  }

  it('refuses a command when sandboxing is disabled, and the command does not run', async () => {
    const c = sandboxCtx({ enabled: false, allowUnsandboxedCommands: false });
    const { command, marker } = sideEffectCommand('refused-disabled');

    const result = await bash.execute({ command }, c);

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toContain('sandbox.allowUnsandboxedCommands');
    expect(result.structuredError?.message).toContain('sandbox.enabled is false');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a command excluded from the sandbox, and the command does not run', async () => {
    const { command, marker } = sideEffectCommand('refused-excluded');
    const c = sandboxCtx({
      enabled: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [command],
    });

    const result = await bash.execute({ command }, c);

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toContain('sandbox.allowUnsandboxedCommands');
    expect(result.structuredError?.message).toContain('sandbox.excludedCommands');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a command when the bubblewrap backend is unavailable', async () => {
    const { command, marker } = sideEffectCommand('refused-unavailable');
    const c = sandboxCtx({ enabled: true, allowUnsandboxedCommands: false });
    const runtime = new SessionRuntime();
    // The one branch that cannot be produced by settings alone: this host has
    // bwrap installed, so the real probe would succeed.
    vi.spyOn(runtime, 'sandbox').mockReturnValue(null);
    c.runtime = runtime;

    const result = await bash.execute({ command }, c);

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toContain('sandbox.allowUnsandboxedCommands');
    expect(result.structuredError?.message).toContain('bubblewrap');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses background commands too, and starts no shell', async () => {
    const c = sandboxCtx({ enabled: false, allowUnsandboxedCommands: false });
    const { command } = sideEffectCommand('refused-background');

    const result = await bash.execute({ command, run_in_background: true }, c);

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toContain('sandbox.allowUnsandboxedCommands');
    expect(c.backgroundShells?.shells.size ?? 0).toBe(0);
  });

  it('leaves behavior unchanged under the default allowUnsandboxedCommands: true', async () => {
    expect(DEFAULT_SETTINGS.sandbox.allowUnsandboxedCommands).toBe(true);
    const c = sandboxCtx({ enabled: false });
    const { command, marker } = sideEffectCommand('allowed-default');

    const result = await bash.execute({ command }, c);

    expect(result.status).toBe('success');
    expect(existsSync(marker)).toBe(true);
  });

  it('leaves behavior unchanged when no sandbox settings are attached to the context', async () => {
    const c = ctx();
    const { command, marker } = sideEffectCommand('allowed-no-settings');

    const result = await bash.execute({ command }, c);

    expect(result.status).toBe('success');
    expect(existsSync(marker)).toBe(true);
  });

  it('still runs excluded commands when unsandboxed commands are allowed', async () => {
    const { command, marker } = sideEffectCommand('allowed-excluded');
    const c = sandboxCtx({ enabled: true, excludedCommands: [command] });

    const result = await bash.execute({ command }, c);

    expect(result.status).toBe('success');
    expect(existsSync(marker)).toBe(true);
  });
});
