import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundShellStore } from '../types/runtime.js';
import { persistentJobPaths } from './persistent-store.js';
import { ShellJobManager } from './shell-manager.js';

let directory: string;
let managers: ShellJobManager[] = [];

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

/** A worker that records its own pid and then refuses to die from SIGTERM. */
function resistantWorker(pidPath: string): string {
  return `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`;
}

async function waitForWorkerToDisappear(workerPid: number): Promise<void> {
  // kill(pid, 0) still succeeds for a zombie that has exited but has not yet been reaped by its
  // parent, so assert the pid disappears within a short bound rather than instantly. The bound
  // stays tight on purpose: a tree that genuinely survives SIGKILL still fails here.
  await waitFor(
    () => {
      try {
        process.kill(workerPid, 0);
        return false;
      } catch {
        return true;
      }
    },
    'SIGTERM-resistant worker process to disappear',
    2_000,
  );
}

afterEach(async () => {
  for (const manager of managers) {
    for (const shell of manager.list()) {
      if (
        shell.status === 'running' ||
        shell.status === 'starting' ||
        shell.status === 'stopping'
      ) {
        await manager.stop(shell.id).catch(() => false);
      }
    }
    manager.dispose();
  }
  managers = [];
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (directory) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('ShellJobManager persistent jobs', () => {
  it('reattaches after manager disposal and cleans files after stop and dismiss', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
    const persistentRoot = join(directory, 'jobs');
    const script = join(directory, 'persistent.cjs');
    writeFileSync(script, `console.log('persistent-ready');\nsetInterval(() => {}, 1000);\n`);
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    // Contended windows-latest runners push the detached runner's start and
    // stop transitions past the interactive-host defaults (3s/5s); the
    // transitions are eventual, so the test observes with wide windows.
    const ciBudgets = { runnerStartBudgetMs: 30_000, runnerStopBudgetMs: 30_000 };
    const firstStore: BackgroundShellStore = { nextId: 1, shells: new Map() };
    const first = new ShellJobManager(firstStore, { persistentRoot, ...ciBudgets });
    managers.push(first);
    first.configureWorkspace(directory);

    const started = await first.start({
      command,
      effectiveCommand: command,
      workdir: directory,
      env: process.env,
      envOverrides: {},
      sandboxed: false,
      lifetime: 'persistent',
      workspace: directory,
    });
    // Output flows through two cold node spawns (detached runner, then the
    // worker) plus log-file writes; contended Windows CI runners push that
    // chain past the helper's 5s default. The property is eventual, not
    // latency-bound, so the window is wide on purpose.
    await waitFor(
      () => first.readTail(started.id)?.includes('persistent-ready') === true,
      'persistent shell output',
      30_000,
    );

    first.dispose();
    managers = [];

    const secondStore: BackgroundShellStore = { nextId: 1, shells: new Map() };
    const second = new ShellJobManager(secondStore, { persistentRoot, ...ciBudgets });
    managers.push(second);
    second.configureWorkspace(directory);
    expect(second.get(started.id)?.status).toBe('running');

    expect(await second.stop(started.id)).toBe(true);
    expect(second.get(started.id)?.status).toBe('killed');

    const paths = persistentJobPaths(directory, persistentRoot);
    expect(existsSync(join(paths.records, `${started.id}.json`))).toBe(true);
    expect(existsSync(join(paths.specs, `${started.id}.json`))).toBe(false);
    second.dismiss(started.id);
    expect(second.get(started.id)).toBeUndefined();
    expect(existsSync(join(paths.records, `${started.id}.json`))).toBe(false);
    expect(existsSync(join(paths.specs, `${started.id}.json`))).toBe(false);
    expect(existsSync(join(paths.logs, `${started.id}.log`))).toBe(false);
  }, 60_000);

  // On POSIX, `sh -c` forks the worker into the process group, so the direct child exits from
  // SIGTERM while a worker that ignores SIGTERM survives in the same process group until escalated
  // to SIGKILL. On Windows, `process.on('SIGTERM')` is inert and there is no process group, but the
  // direct child is the `cmd.exe` wrapper; terminating only the direct child would close the
  // wrapper while the grandchild worker continues running. On both platforms, assert the worker
  // process actually exits before recording the job as killed.
  it('waits for a SIGTERM-resistant process tree before recording the job as killed', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
    const persistentRoot = join(directory, 'jobs');
    const script = join(directory, 'resistant.cjs');
    const pidPath = join(directory, 'worker.pid');
    writeFileSync(script, resistantWorker(pidPath));
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    const manager = new ShellJobManager({ nextId: 1, shells: new Map() }, { persistentRoot });
    managers.push(manager);
    manager.configureWorkspace(directory);
    const started = await manager.start({
      command,
      effectiveCommand: command,
      workdir: directory,
      env: process.env,
      envOverrides: {},
      sandboxed: false,
      lifetime: 'persistent',
      workspace: directory,
    });
    await waitFor(() => existsSync(pidPath), 'worker pid file');
    const workerPid = Number(readFileSync(pidPath, 'utf8'));

    expect(await manager.stop(started.id)).toBe(true);
    expect(manager.get(started.id)?.status).toBe('killed');
    await waitForWorkerToDisappear(workerPid);
  }, 15_000);
});

describe('ShellJobManager session jobs', () => {
  // On POSIX, `sh -c` forks the worker into the process group, so the direct child exits from
  // SIGTERM while a worker that ignores SIGTERM survives in the same process group.
  // On Windows, `process.on('SIGTERM')` is inert and there is no process group, but the direct child
  // is the `cmd.exe` wrapper; terminating only the direct child would close the wrapper while the
  // worker continues running. On both platforms, the job must wait for the worker to exit.
  it('waits for a SIGTERM-resistant process tree before recording the job as killed', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-session-shell-'));
    const script = join(directory, 'resistant.cjs');
    const pidPath = join(directory, 'worker.pid');
    writeFileSync(script, resistantWorker(pidPath));
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
    managers.push(manager);
    const started = await manager.start({
      command,
      effectiveCommand: command,
      workdir: directory,
      env: process.env,
      sandboxed: false,
    });
    await waitFor(() => existsSync(pidPath), 'worker pid file');
    const workerPid = Number(readFileSync(pidPath, 'utf8'));

    expect(await manager.stop(started.id)).toBe(true);
    expect(manager.get(started.id)?.status).toBe('killed');
    await waitForWorkerToDisappear(workerPid);
  }, 15_000);
});
