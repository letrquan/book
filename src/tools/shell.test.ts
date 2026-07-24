import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { shellTools } from './shell.js';
import { getPrimaryArg } from './primary-arg.js';
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
  rmSync(dir, { recursive: true, force: true });
});

describe('Bash shell tools', () => {
  it('keeps foreground Bash behavior', async () => {
    const c = ctx();
    const command = nodeCommand('foreground.cjs', `console.log('foreground-ok');\n`);

    const result = await bash.execute({ command }, c);

    expect(result.status).toBe('success');
    expect(result.content).toContain('foreground-ok');
    expect(c.backgroundShells).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'cancels a foreground Bash process through the tool signal',
    async () => {
      const controller = new AbortController();
      const c = { ...ctx(), workspaceRoot: process.cwd(), signal: controller.signal };
      const marker = join(dir, 'cancelled-process-survived.txt');
      const command = nodeCommand(
        'cancel-foreground.cjs',
        `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 250);\nsetInterval(() => {}, 1000);\n`,
      );
      const startedAt = Date.now();
      const pending = bash.execute({ command }, c);

      setTimeout(() => controller.abort('stop foreground shell'), 50);
      const result = await pending;

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(result.status).toBe('error');
      expect(result.structuredError?.message).toMatch(/cancel/i);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(existsSync(marker)).toBe(false);
    },
  );

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

  it('times out background shells only when timeout is explicitly supplied', async () => {
    const c = ctx();
    const command = nodeCommand(
      'timeout.cjs',
      `console.log('timeout-ready');\nsetInterval(() => {}, 1000);\n`,
    );
    const start = await bash.execute({ command, run_in_background: true, timeout: 50 }, c);
    const shellId = shellIdFrom(start);
    await waitForOutput(c, shellId, /timeout-ready/);

    const terminal = await waitForOutput(c, shellId, /Shell shell_\d+: timed_out/);

    expect(terminal.status).toBe('success');
    expect(c.backgroundShells?.shells.get(shellId)?.status).toBe('timed_out');
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
