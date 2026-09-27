import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { persistentEnvironmentOverrides, shellTools } from './shell.js';
import { createDefaultRegistry } from './registry.js';
import { getPrimaryArg } from './primary-arg.js';
import { ShellJobManager } from '../jobs/shell-manager.js';
import { SessionRuntime } from '../session/runtime.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from '../settings.js';
import type { BackgroundShellStore, ResolvedShell } from '../types/runtime.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';

let dir: string;
let contexts: ToolContext[] = [];

/**
 * The shell these tests run commands under, pinned rather than resolved.
 *
 * `sessionShell` falls back to the ambient environment when a context carries
 * no shell, which would make these assertions depend on how the test runner was
 * launched — a Git Bash terminal and a PowerShell one would exercise different
 * interpreters and different quoting. The Bash *tool* is what is under test
 * here (backgrounding, deadlines, output capture), not shell selection, so the
 * platform default is pinned and `shell-selection.test.ts` covers the ladder,
 * including real PowerShell and Git Bash execution.
 */
const TEST_SHELL: ResolvedShell =
  process.platform === 'win32'
    ? { kind: 'cmd', label: 'cmd.exe', source: 'fallback' }
    : { kind: 'sh', label: '/bin/sh', source: 'detected' };

function ctx(): ToolContext {
  const c: ToolContext = { workspaceRoot: dir, env: {}, shell: TEST_SHELL };
  contexts.push(c);
  return c;
}

/**
 * A context with overrides, applied in place.
 *
 * `{ ...ctx() }` is the trap: the shell manager caches itself on the context object it is given, so
 * a copy gets a manager of its own and the `afterEach` — which walks the registered contexts — has
 * no record of the shell. A command left running then keeps the temp directory open, and on Windows
 * the cleanup fails with EPERM instead of quietly leaving a process behind.
 */
function ctxWith(overrides: Partial<ToolContext>): ToolContext {
  return Object.assign(ctx(), overrides);
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

/**
 * Wait for a pid to stop existing. `kill(pid, 0)` still succeeds for a zombie that has exited but
 * not yet been reaped, so this waits for the pid to go rather than asserting instantly.
 */
async function waitForPidGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} is still running after ${timeoutMs}ms`);
}

/**
 * A context whose shell manager has already been disposed, so a foreground command that reaches
 * its timeout cannot be moved to the background and is killed exactly as it was before #302.
 *
 * The refusal is a real one, not a mock: the session is ending, the manager is gone, and there
 * is nowhere to hand the process to.
 */
function ctxWithUnusableShellManager(): ToolContext {
  const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
  const c = ctxWith({ workspaceRoot: process.cwd(), backgroundShells: store });
  c.shellManager = new ShellJobManager(store);
  c.shellManager.dispose();
  return c;
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
    const c = ctxWith({ workspaceRoot: process.cwd(), signal: controller.signal });
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

  // A timed-out command now moves to the background where it can be watched (#302), so the kill
  // path is reached only when there is nowhere to hand it to. The tree still has to be ended on
  // that path, or the command outlives the session that was supposed to own it.
  it('terminates the foreground process tree when the move to the background is refused', async () => {
    const c = ctxWithUnusableShellManager();
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
    const c = ctxWithUnusableShellManager();
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
    const c = ctxWith({ workspaceRoot: process.cwd(), env: { BOOK_TOOL_TIMEOUT_MS: '30000' } });
    const command = nodeCommand('over-ceiling.cjs', `console.log('never-runs');\n`);

    const result = await bash.execute({ command, timeout: 600_000 }, c);

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/exceeds the 30000ms limit/);
    expect(result.content).not.toContain('never-runs');
  });

  it('honors the operator BOOK_TOOL_TIMEOUT_MS override', async () => {
    const c = {
      ...ctxWithUnusableShellManager(),
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
    const c = { ...ctxWithUnusableShellManager(), env: { BOOK_TOOL_TIMEOUT_MS: '2000' } };
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
    const c: ToolContext = {
      workspaceRoot: dir,
      env: {},
      backgroundShells: store,
      shell: TEST_SHELL,
    };
    contexts.push(c);

    await bashOutput.execute({ shell_id: 'shell_29' }, c);

    expect(store.shells.size).toBe(20);
    expect(store.shells.has('shell_0')).toBe(false);
    expect(store.shells.has('shell_29')).toBe(true);
  });

  it('shares configured background shell state across contexts', async () => {
    const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
    const first: ToolContext = {
      workspaceRoot: dir,
      env: {},
      backgroundShells: store,
      shell: TEST_SHELL,
    };
    const second: ToolContext = {
      workspaceRoot: dir,
      env: {},
      backgroundShells: store,
      shell: TEST_SHELL,
    };
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

  // Session lifetime promises a command ends with Book. Disposing the runtime used to abort the
  // controllers and then `child.kill()` every tracked child in the same tick — on Windows that
  // killed the shell wrapper before `taskkill /T` could walk the tree, so the tree was orphaned
  // rather than ended (#314).
  it('ends a foreground command’s whole tree when the session runtime is disposed', async () => {
    // Through the registry, which is how the agent loop calls a tool: it owns the abort
    // controller the runtime disposes, so the call really is in flight when the dispose lands.
    const registry = createDefaultRegistry();
    const runtime = new SessionRuntime();
    const c = ctxWith({ workspaceRoot: process.cwd(), runtime });
    const pidPath = join(dir, 'foreground-grandchild.pid');
    const command = nodeCommand(
      'foreground-tree.cjs',
      `const { spawn } = require('child_process');
const grandchild = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(
        `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
      )}], { stdio: 'ignore' });
grandchild.unref();
console.log('tree-started');
setInterval(() => {}, 1000);\n`,
    );

    const pending = registry.execute({ id: 'bash-tree', name: 'Bash', arguments: { command } }, c);
    const startedAt = Date.now();
    while (!existsSync(pidPath)) {
      if (Date.now() - startedAt > 10_000) throw new Error('grandchild never started');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const grandchildPid = Number(readFileSync(pidPath, 'utf8'));

    // `dispose()` starts the teardown and returns; the tree is walked outside the tick, so the
    // grandchild is polled for rather than awaited. The pending call is a second witness: the
    // foreground teardown promise is resolved before that result comes back.
    runtime.dispose();
    const result = await pending;

    expect(result.structuredError?.message).toMatch(/cancel/i);
    await waitForPidGone(grandchildPid);
  }, 30_000);
});

/**
 * A foreground command that reaches its timeout used to be killed and reported `timed_out`, which
 * left the model with no result at all and a re-run of the whole gate. It now moves to the
 * background, where the rest of the run is one BashOutput away (#302).
 */
describe('Bash foreground timeout', () => {
  /** Prints `before`, outlives the deadline, then prints `after` and exits 0. */
  function slowCommand(name = 'adopted.cjs'): string {
    return nodeCommand(
      name,
      `console.log('before');
setTimeout(() => { console.log('after'); process.exit(0); }, 1500);\n`,
    );
  }

  it('moves a timed-out command to the background instead of killing it', async () => {
    const c = ctxWith({ workspaceRoot: process.cwd() });

    const result = await bash.execute({ command: slowCommand(), timeout: 300 }, c);

    expect(result.status).toBe('success');
    const shellId = shellIdFrom(result);
    expect(result.content).toContain('before');
    expect(result.content).toContain(shellId);
    expect(result.content).toMatch(/still running after 300ms/i);
    expect(result.content).toMatch(/not killed/i);
    expect(result.content).toMatch(new RegExp(`BashOutput with shell_id="${shellId}"`));
    expect(result.content).toMatch(new RegExp(`KillShell with shell_id="${shellId}"`));
    // Structured data has to say this is a background job, or a host that renders the result as
    // a plain command output would read it as a command that finished.
    expect(result.data).toMatchObject({ backgrounded: true, shell: { id: shellId } });
  });

  it('returns only what the command printed after the move, with its exit status', async () => {
    const c = ctxWith({ workspaceRoot: process.cwd() });
    const started = await bash.execute(
      { command: slowCommand('adopted-wait.cjs'), timeout: 300 },
      c,
    );
    const shellId = shellIdFrom(started);

    // `before` was already in the foreground result; the adopted buffer starts past it.
    const firstRead = await bashOutput.execute({ shell_id: shellId, wait_ms: 5_000 }, c);

    expect(firstRead.status).toBe('success');
    expect(firstRead.content).not.toContain('before');
    expect(firstRead.content).toContain('after');
    expect(firstRead.content).toMatch(/exit=0/);
  });

  it('seeds the adopted shell buffer with what the command had already printed', async () => {
    const c = ctxWith({ workspaceRoot: process.cwd() });
    const started = await bash.execute(
      { command: slowCommand('adopted-seed.cjs'), timeout: 300 },
      c,
    );
    const shellId = shellIdFrom(started);

    const quiet = await bashOutput.execute({ shell_id: shellId }, c);

    expect(quiet.content).toContain('(no new output)');
  });

  it('seeds the buffer with raw output in arrival order, not labelled streams', async () => {
    // The buffer a `BashOutput` reads is the command's own output, and the two streams are
    // interleaved as they arrived. `--- stdout ---` headers are a presentation of one report, and
    // they would sit in the middle of everything the model reads next.
    const c = ctxWith({ workspaceRoot: process.cwd() });
    const command = nodeCommand(
      'adopted-order.cjs',
      `process.stderr.write('err-first\\n');
setTimeout(() => console.log('out-second'), 50);
setTimeout(() => process.exit(0), 1500);\n`,
    );

    const started = await bash.execute({ command, timeout: 600 }, c);
    const record = c.backgroundShells?.shells.get(shellIdFrom(started));

    expect(record?.output).toContain('err-first');
    expect(record?.output).toContain('out-second');
    expect(record?.output).not.toContain('--- stdout ---');
    expect(record?.output).not.toContain('--- stderr ---');
    expect(record?.output.indexOf('err-first')).toBeLessThan(record!.output.indexOf('out-second'));
  });

  it('does not say a command was killed when it was moved to the background', async () => {
    // A silent command has no output, and the placeholder that stands in for a killed command's
    // silence says it was killed — directly above the line saying it was not.
    const c = ctxWith({ workspaceRoot: process.cwd() });
    const command = nodeCommand('adopted-silent.cjs', `setInterval(() => {}, 1000);\n`);

    const result = await bash.execute({ command, timeout: 300 }, c);

    expect(result.status).toBe('success');
    expect(result.content).toContain('(no output yet)');
    expect(result.content).not.toMatch(/no output was captured/);
    expect(result.content).toMatch(/not killed/i);
  });

  it('carries the job reference in its data, not a second copy of the output', async () => {
    // `cloneRecord` keeps the shell's whole buffer, and a long-running command's buffer is
    // megabytes. Everything a host needs to point `BashOutput` at the job fits in a few fields,
    // and the output is already in the message above it.
    const c = ctxWith({ workspaceRoot: process.cwd() });
    const command = nodeCommand(
      'adopted-heavy.cjs',
      `console.log('x'.repeat(200_000));
setTimeout(() => process.exit(0), 1500);\n`,
    );

    const result = await bash.execute({ command, timeout: 600 }, c);

    expect(result.status).toBe('success');
    expect(result.data).toMatchObject({ backgrounded: true, shell: { id: shellIdFrom(result) } });
    expect(JSON.stringify(result.data).length).toBeLessThan(2_000);
  });

  it('leaves nothing of this call attached to the command it adopted', async () => {
    // The manager is the reader from here on. A listener left on the process keeps this call's
    // closure — and the text it captured — alive for as long as the command runs. What remains on
    // the process is the manager's own set: one reader per stream, one of each lifecycle event.
    const c = ctxWith({ workspaceRoot: process.cwd() });
    const started = await bash.execute({ command: slowCommand(), timeout: 300 }, c);
    const record = c.backgroundShells?.shells.get(shellIdFrom(started));
    const proc = record?.process as ChildProcess;

    expect(proc.listenerCount('close')).toBe(1);
    expect(proc.listenerCount('error')).toBe(1);
    expect(proc.stdout?.listenerCount('data')).toBe(1);
    expect(proc.stderr?.listenerCount('data')).toBe(1);
  });

  it('gives the adopted shell the default background lifetime and notify policy', async () => {
    const c = ctxWith({ workspaceRoot: process.cwd() });
    const started = await bash.execute(
      { command: slowCommand('adopted-lifetime.cjs'), timeout: 300 },
      c,
    );
    const record = c.backgroundShells?.shells.get(shellIdFrom(started));

    expect(record?.lifetime).toBe('session');
    expect(record?.notify).toBe('ui');
    expect(record?.timeoutMs).toBeUndefined();
    expect(record?.status).toBe('running');
  });

  it('adopts into the session runtime, which outlives the call', async () => {
    const runtime = new SessionRuntime();
    const c = ctxWith({ workspaceRoot: process.cwd(), runtime });

    const result = await bash.execute({ command: slowCommand(), timeout: 300 }, c);

    expect(result.status).toBe('success');
    expect(result.content).toMatch(/moved to background shell shell_\d+/);
    runtime.dispose();
  });

  /**
   * A Task subagent and a managed agent each own a runtime that is disposed when their run ends, and
   * disposing a runtime ends every session shell it holds. Adopting into one therefore hands a
   * command to a manager that is torn down at the end of the same run — after the model has been
   * told the command is running in the background and was not killed. The move is refused there and
   * the old kill-and-`timed_out` result stands.
   */
  it('kills the command instead of adopting it into a run that is about to end', async () => {
    const transientRuntime = new SessionRuntime({ ownsSessionShells: false });
    const c = ctxWith({ workspaceRoot: process.cwd(), runtime: transientRuntime });
    const marker = join(dir, 'transient-runtime-survived.txt');
    const command = nodeCommand(
      'adopted-transient.cjs',
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1500);
setInterval(() => {}, 1000);\n`,
    );

    const result = await bash.execute({ command, timeout: 300 }, c);

    expect(result.status).toBe('timed_out');
    expect(result.structuredError?.code).toBe('tool_timeout');
    expect(result.content).not.toMatch(/moved to background shell/);
    expect(c.backgroundShells?.shells.size ?? 0).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(existsSync(marker)).toBe(false);
    transientRuntime.dispose();
  }, 15_000);

  it('keeps the adopted shell a session shell, so it ends with Book', async () => {
    const c = ctxWith({ workspaceRoot: process.cwd() });
    const started = await bash.execute(
      { command: slowCommand('adopted-dispose.cjs'), timeout: 300 },
      c,
    );
    const shellId = shellIdFrom(started);
    const adoptedPid = c.backgroundShells?.shells.get(shellId)?.pid;
    expect(adoptedPid).toBeDefined();

    (c.shellManager as ShellJobManager).dispose();

    expect(c.backgroundShells?.shells.has(shellId)).toBe(false);
    // Session lifetime is a promise the record alone cannot keep: the process has to be gone. The
    // teardown runs outside the tick dispose returns in, so it is polled for rather than awaited.
    await waitForPidGone(adoptedPid!);
  }, 15_000);

  it('stops the adopted shell’s whole tree on KillShell', async () => {
    const c = ctxWith({ workspaceRoot: process.cwd() });
    const pidPath = join(dir, 'adopted-grandchild.pid');
    const command = nodeCommand(
      'adopted-tree.cjs',
      `const { spawn } = require('child_process');
const grandchild = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(
        `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
      )}], { stdio: 'ignore' });
grandchild.unref();
setInterval(() => {}, 1000);\n`,
    );
    const started = await bash.execute({ command, timeout: 300 }, c);
    const shellId = shellIdFrom(started);
    const start = Date.now();
    while (!existsSync(pidPath)) {
      if (Date.now() - start > 10_000) throw new Error('grandchild never started');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const grandchildPid = Number(readFileSync(pidPath, 'utf8'));

    const killed = await killShell.execute({ shell_id: shellId }, c);

    expect(killed.status).toBe('success');
    expect(killed.content).toContain(`Killed shell ${shellId}`);
    await waitForPidGone(grandchildPid);
  }, 30_000);

  it('does not let the registry backstop fire during the move', async () => {
    // The registry arms its timer before `execute` is reached and adds
    // SELF_TIMEOUT_GRACE_MS on top of a tool that declares its own deadline, so it has to stay
    // behind the detach — a contentless `tool_timeout` here would lose the shell id entirely.
    const registry = createDefaultRegistry();
    const c = ctxWith({ workspaceRoot: process.cwd() });

    const result = await registry.execute(
      {
        id: 'bash-bg',
        name: 'Bash',
        arguments: { command: slowCommand('adopted-registry.cjs'), timeout: 300 },
      },
      c,
    );

    expect(result.status).toBe('success');
    expect(result.content).toMatch(/moved to background shell shell_\d+/);
    // The backstop's own report is a contentless `Tool timeout` failure; seeing neither the code
    // nor the text is what proves the tool's own result is the one that came back.
    expect(result.structuredError).toBeUndefined();
    expect(result.content).not.toMatch(/Tool timeout/);
  });

  it('still cancels rather than backgrounding when the call is aborted', async () => {
    const controller = new AbortController();
    const c = ctxWith({ workspaceRoot: process.cwd(), signal: controller.signal });
    const command = nodeCommand('adopted-cancel.cjs', `setInterval(() => {}, 1000);\n`);
    const pending = bash.execute({ command, timeout: 2_000 }, c);

    setTimeout(() => controller.abort('stop foreground shell'), 100);
    const result = await pending;

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/cancelled/i);
    expect(result.content).not.toMatch(/moved to background shell/);
    expect(c.backgroundShells?.shells.size ?? 0).toBe(0);
  });

  it('kills the command as before when no shell manager can take it', async () => {
    // A disposed shell manager is the realistic refusal: the session is ending and there is
    // nowhere to hand the command to, so the model gets the old kill-and-timed_out result.
    const c = ctxWithUnusableShellManager();
    const marker = join(dir, 'refused-timeout-survived.txt');
    const command = nodeCommand(
      'adopted-refused.cjs',
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1500);
setInterval(() => {}, 1000);\n`,
    );

    const result = await bash.execute({ command, timeout: 300 }, c);

    expect(result.status).toBe('timed_out');
    expect(result.structuredError?.code).toBe('tool_timeout');
    expect(result.structuredError?.message).toMatch(/killed after 300ms/i);
    expect(result.content).not.toMatch(/moved to background shell/);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(existsSync(marker)).toBe(false);
  }, 15_000);
});

/**
 * `BashOutput` returned at once, so waiting on a long gate cost a whole turn per poll (#313).
 * `wait_ms` trades one turn for a wait.
 */
describe('BashOutput wait_ms', () => {
  it('returns as soon as a shell finishes, well inside the wait it was given', async () => {
    const c = ctx();
    const command = nodeCommand(
      'wait-exits.cjs',
      `setTimeout(() => { console.log('finished'); process.exit(0); }, 300);\n`,
    );
    const started = await bash.execute({ command, run_in_background: true }, c);
    const shellId = shellIdFrom(started);

    const began = Date.now();
    const result = await bashOutput.execute({ shell_id: shellId, wait_ms: 5_000 }, c);
    const elapsed = Date.now() - began;

    expect(result.status).toBe('success');
    expect(result.content).toContain('finished');
    expect(result.content).toMatch(/exit=0/);
    expect(elapsed).toBeLessThan(4_000);
  });

  it('returns after the wait, saying it is still running, when the shell has not finished', async () => {
    const c = ctx();
    const command = nodeCommand('wait-silent.cjs', `setInterval(() => {}, 1000);\n`);
    const started = await bash.execute({ command, run_in_background: true }, c);
    const shellId = shellIdFrom(started);

    const began = Date.now();
    const result = await bashOutput.execute({ shell_id: shellId, wait_ms: 400 }, c);
    const elapsed = Date.now() - began;

    expect(result.status).toBe('success');
    expect(result.content).toContain('(no new output)');
    // The wait was the caller's own decision, so advice to pass it is advice the model just took
    // and found wanting; what it needs here is how much longer the command has been running.
    expect(result.content).toMatch(/still running/i);
    expect(result.content).toMatch(/after waiting 400ms/);
    expect(result.content).not.toMatch(/instead of polling/);
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('advises a wait when the call asked for none', async () => {
    const c = ctx();
    const command = nodeCommand('wait-unasked.cjs', `setInterval(() => {}, 1000);\n`);
    const started = await bash.execute({ command, run_in_background: true }, c);
    const shellId = shellIdFrom(started);

    const result = await bashOutput.execute({ shell_id: shellId }, c);

    expect(result.content).toContain('(no new output)');
    expect(result.content).toMatch(/call BashOutput with wait_ms/i);
  });

  it('stops waiting and leaves the shell running when the call is aborted', async () => {
    const controller = new AbortController();
    const c = ctxWith({ signal: controller.signal });
    const command = nodeCommand(
      'wait-abort.cjs',
      `console.log('alive-still'); setInterval(() => {}, 1000);\n`,
    );
    const started = await bash.execute({ command, run_in_background: true }, c);
    const shellId = shellIdFrom(started);
    await waitForOutput(c, shellId, /alive-still/);

    const began = Date.now();
    setTimeout(() => controller.abort('stop waiting'), 150);
    const result = await bashOutput.execute({ shell_id: shellId, wait_ms: 30_000 }, c);
    const elapsed = Date.now() - began;

    expect(elapsed).toBeLessThan(5_000);
    // Nothing was killed: the shell is still there to be waited on again.
    expect(c.backgroundShells?.shells.get(shellId)?.status).toBe('running');
    expect(result.status).toBe('success');
  }, 20_000);

  it('refuses a wait over the limit in force here', async () => {
    const c = ctxWith({ env: { BOOK_TOOL_TIMEOUT_MS: '30000' } });
    const command = nodeCommand('wait-ceiling.cjs', `setInterval(() => {}, 1000);\n`);
    const started = await bash.execute({ command, run_in_background: true }, c);
    const shellId = shellIdFrom(started);

    const result = await bashOutput.execute({ shell_id: shellId, wait_ms: 600_000 }, c);

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/exceeds the 30000ms limit/);
  });

  it('waits out a persistent job until it exits', async () => {
    const c = ctxWith({ workspaceRoot: dir });
    // Pinned under the temp dir rather than <BOOK_HOME>/jobs: this test starts a detached runner
    // and writes its record files.
    const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
    c.backgroundShells = store;
    c.shellManager = new ShellJobManager(store, { persistentRoot: join(dir, 'jobs') });
    const command = nodeCommand(
      'wait-persistent.cjs',
      `setTimeout(() => { console.log('persistent-done'); process.exit(0); }, 400);\n`,
    );
    const started = await bash.execute(
      { command, run_in_background: true, lifetime: 'persistent' },
      c,
    );
    // A persistent job's id is a UUID rather than the sequential `shell_N`, so it is read from
    // the record the tool returned rather than scraped out of the message.
    const shellId = (started.data as { id?: string } | undefined)?.id;
    expect(
      shellId,
      `persistent start failed: ${started.content || started.structuredError?.message}`,
    ).toBeDefined();

    const began = Date.now();
    const result = await bashOutput.execute({ shell_id: shellId!, wait_ms: 20_000 }, c);

    expect(result.status).toBe('success');
    expect(result.content).toContain('persistent-done');
    expect(result.content).toMatch(/exit=0/);
    expect(Date.now() - began).toBeLessThan(15_000);
  }, 60_000);
});

/**
 * Book defaults NODE_ENV=production for its own renderer, and every command used to inherit it,
 * so `npm install` in a project dropped devDependencies. `runtime-env.ts` marks the default it
 * invents; a command handed that marked environment must not see it.
 */
describe('Bash child environment', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.BOOK_DEFAULTED_NODE_ENV = '1';
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  const reportEnv = (name: string): string =>
    nodeCommand(
      name,
      `console.log(JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? null, marker: process.env.BOOK_DEFAULTED_NODE_ENV ?? null }));\n`,
    );

  it('does not hand a foreground command the NODE_ENV Book defaulted', async () => {
    const c = ctxWith({ workspaceRoot: process.cwd() });

    const result = await bash.execute({ command: reportEnv('fg-node-env.cjs') }, c);

    expect(result.status).toBe('success');
    expect(result.content).toContain('"nodeEnv":null');
    expect(result.content).toContain('"marker":null');
  });

  it('does not hand a background command the NODE_ENV Book defaulted', async () => {
    const c = ctx();

    const start = await bash.execute(
      { command: reportEnv('bg-node-env.cjs'), run_in_background: true },
      c,
    );
    const output = await waitForOutput(c, shellIdFrom(start), /nodeEnv/);

    expect(output.content).toContain('"nodeEnv":null');
    expect(output.content).toContain('"marker":null');
  });

  it('passes a NODE_ENV the user set before Book started', async () => {
    delete process.env.BOOK_DEFAULTED_NODE_ENV;
    process.env.NODE_ENV = 'development';
    const c = ctxWith({ workspaceRoot: process.cwd() });

    const result = await bash.execute({ command: reportEnv('fg-user-node-env.cjs') }, c);

    expect(result.status).toBe('success');
    expect(result.content).toContain('"nodeEnv":"development"');
  });

  it('passes a NODE_ENV the context sets explicitly', async () => {
    const c = ctxWith({ workspaceRoot: process.cwd(), env: { NODE_ENV: 'test' } });

    const result = await bash.execute({ command: reportEnv('fg-ctx-node-env.cjs') }, c);

    expect(result.status).toBe('success');
    expect(result.content).toContain('"nodeEnv":"test"');
  });
});

describe('sandbox.allowUnsandboxedCommands', () => {
  function sandboxCtx(overrides: Partial<ResolvedSettings['sandbox']>): ToolContext {
    const c: ToolContext = {
      workspaceRoot: dir,
      env: {},
      sandbox: { ...structuredClone(DEFAULT_SETTINGS.sandbox), ...overrides },
      shell: TEST_SHELL,
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
