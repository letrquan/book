import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundShellStore } from '../types/runtime.js';
import { persistentJobPaths } from './persistent-store.js';
import { isProcessAlive } from './process-tree.js';
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

/**
 * Contended windows-latest runners push the detached runner's start and stop
 * transitions past the interactive-host defaults (3s/5s). The transitions are
 * eventual, so every persistent test observes them through these wide windows:
 * a ceiling, not a wait, and a green run never gets near it.
 */
const ciBudgets = { runnerStartBudgetMs: 30_000, runnerStopBudgetMs: 30_000 };

/** `ShellJobManager`'s default `runnerStopBudgetMs`: how long a real stop may take. */
const PRODUCTION_STOP_BUDGET_MS = 5_000;

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
  if (directory) await removeWhenReleased(directory);
}, 60_000);

/**
 * Remove a test directory once Windows lets go of it. The detached runner exits a moment after it
 * publishes the terminal record, and until it and the killed worker have been torn down, and any
 * scanner has closed their files, Windows refuses the removal with EBUSY or EPERM. Node 24's
 * native `rmSync` reports that as EPERM on the first attempt whatever `maxRetries` says, so the
 * retry lives here. It polls for the release rather than guessing how long teardown takes.
 */
async function removeWhenReleased(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('ShellJobManager persistent jobs', () => {
  it('reattaches after manager disposal and cleans files after stop and dismiss', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
    const persistentRoot = join(directory, 'jobs');
    const script = join(directory, 'persistent.cjs');
    writeFileSync(script, `console.log('persistent-ready');\nsetInterval(() => {}, 1000);\n`);
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
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
    const manager = new ShellJobManager(
      { nextId: 1, shells: new Map() },
      { persistentRoot, ...ciBudgets },
    );
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
    // Two cold node spawns (the detached runner, then the worker) stand between start and the
    // pid file, so this gets the same wide window as the persistent output wait above.
    await waitFor(() => existsSync(pidPath), 'worker pid file', 30_000);
    const workerPid = Number(readFileSync(pidPath, 'utf8'));

    const stopRequestedAt = Date.now();
    expect(await manager.stop(started.id)).toBe(true);
    expect(manager.get(started.id)?.status).toBe('killed');
    // The manager's own stop budget is widened for contended CI runners, so it cannot notice a
    // stop slower than production's. The runner stamps `finishedAt` when it has stopped the tree,
    // and production gives up waiting after 5 s.
    const finishedAt = manager.get(started.id)?.finishedAt ?? Number.POSITIVE_INFINITY;
    expect(finishedAt - stopRequestedAt).toBeLessThan(PRODUCTION_STOP_BUDGET_MS);
    await waitForWorkerToDisappear(workerPid);
  }, 60_000);

  // The runner is the only thing that stops its command. When it died any other way than through
  // a stop request, the command kept running with nothing left to stop it (#267).
  it('ends the command when its runner dies', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
    const persistentRoot = join(directory, 'jobs');
    const script = join(directory, 'resistant.cjs');
    const pidPath = join(directory, 'worker.pid');
    writeFileSync(script, resistantWorker(pidPath));
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    // Not registered in `managers`: its runner is killed below, so the shared cleanup's stop
    // request would wait out the whole budget for a runner that no longer exists.
    const manager = new ShellJobManager(
      { nextId: 1, shells: new Map() },
      { persistentRoot, ...ciBudgets },
    );
    manager.configureWorkspace(directory);
    let workerPid: number | undefined;
    try {
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
      await waitFor(() => existsSync(pidPath), 'worker pid file', 30_000);
      workerPid = Number(readFileSync(pidPath, 'utf8'));
      const runnerPid = manager.get(started.id)?.runnerPid;
      expect(runnerPid).toBeDefined();

      // Kill the runner alone, the way a crash or Task Manager would, not its process tree.
      process.kill(runnerPid!, 'SIGKILL');
      await waitFor(() => !isProcessAlive(workerPid), 'the orphaned command to end', 15_000);
    } finally {
      manager.dispose();
      if (workerPid !== undefined && isProcessAlive(workerPid)) process.kill(workerPid, 'SIGKILL');
    }
  }, 60_000);

  it('refuses to run a command whose job record cannot be written, and says why', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
    const persistentRoot = join(directory, 'jobs');
    const script = join(directory, 'worker.cjs');
    const pidPath = join(directory, 'worker.pid');
    writeFileSync(script, resistantWorker(pidPath));
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    const manager = new ShellJobManager(
      { nextId: 1, shells: new Map() },
      { persistentRoot, ...ciBudgets },
    );
    managers.push(manager);
    manager.configureWorkspace(directory);
    // A file where the records directory should be makes every record write fail, on any platform.
    const paths = persistentJobPaths(directory, persistentRoot);
    rmSync(paths.records, { recursive: true, force: true });
    writeFileSync(paths.records, 'not a directory');

    const startedAt = Date.now();
    await expect(
      manager.start({
        command,
        effectiveCommand: command,
        workdir: directory,
        env: process.env,
        envOverrides: {},
        sandboxed: false,
        lifetime: 'persistent',
        workspace: directory,
      }),
    ).rejects.toThrow(/could not write its job record/);
    // The runner said why and exited; the manager did not wait out its start budget.
    expect(Date.now() - startedAt).toBeLessThan(ciBudgets.runnerStartBudgetMs);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(existsSync(pidPath)).toBe(false);
  }, 60_000);

  // On Windows a rename over a file that another process has open fails with EPERM, and the
  // manager polls a job record while the runner rewrites it every second. The runner used to die
  // from the first such heartbeat, leaving the job recorded as running until the manager called it
  // lost. The reader below holds the record open far more than any manager does, which turns a
  // rare CI crash into a certain one.
  it.skipIf(process.platform !== 'win32')(
    'keeps the runner alive while another process keeps reading its record',
    async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
      const persistentRoot = join(directory, 'jobs');
      const script = join(directory, 'idle.cjs');
      // Exits on its own once the test's own 60s budget is spent: a runner that dies cannot leak
      // it past the test, and a slow run cannot see it exit before the stop.
      writeFileSync(
        script,
        'setInterval(() => {}, 1000);\nsetTimeout(() => process.exit(0), 60_000);\n',
      );
      const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
      const manager = new ShellJobManager(
        { nextId: 1, shells: new Map() },
        { persistentRoot, ...ciBudgets },
      );
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
      const recordPath = join(
        persistentJobPaths(directory, persistentRoot).records,
        `${started.id}.json`,
      );

      // Four seconds of reads span at least three heartbeats.
      const reader = spawn(
        process.execPath,
        [
          '-e',
          `const fs = require('fs'); const end = Date.now() + 4000; let reads = 0; while (Date.now() < end) { try { fs.readFileSync(${JSON.stringify(recordPath)}); reads++; } catch {} } process.exit(reads > 0 ? 0 : 3);`,
        ],
        { stdio: 'ignore' },
      );
      // A reader that failed to start, or never managed a read, would leave nothing tested.
      const readerExit = await new Promise<number | null | Error>((resolve) => {
        reader.once('error', resolve);
        reader.once('exit', resolve);
      });
      expect(readerExit).toBe(0);

      const runnerPid = manager.get(started.id)?.runnerPid;
      expect(runnerPid).toBeDefined();
      expect(isProcessAlive(runnerPid)).toBe(true);
      expect(await manager.stop(started.id)).toBe(true);
      expect(manager.get(started.id)?.status).toBe('killed');
    },
    60_000,
  );

  // A record write the runner cannot make is not the command's output. The notes used to go into
  // the job's log, which the model reads through BashOutput; the record now counts them (#267).
  it.skipIf(process.platform !== 'win32')(
    'keeps record-write failures out of the command log',
    async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
      const persistentRoot = join(directory, 'jobs');
      const script = join(directory, 'idle.cjs');
      writeFileSync(
        script,
        'setInterval(() => {}, 1000);\nsetTimeout(() => process.exit(0), 60_000);\n',
      );
      const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
      const manager = new ShellJobManager(
        { nextId: 1, shells: new Map() },
        { persistentRoot, ...ciBudgets },
      );
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
      const paths = persistentJobPaths(directory, persistentRoot);
      const recordPath = join(paths.records, `${started.id}.json`);
      const logPath = join(paths.logs, `${started.id}.log`);

      // An open handle makes every rename over the record fail on Windows for three seconds.
      const holder = spawn(
        process.execPath,
        [
          '-e',
          `const fs = require('fs'); const fd = fs.openSync(${JSON.stringify(recordPath)}, 'r'); setTimeout(() => fs.closeSync(fd), 3000);`,
        ],
        { stdio: 'ignore' },
      );
      const holderExit = await new Promise<number | null | Error>((resolve) => {
        holder.once('error', resolve);
        holder.once('exit', resolve);
      });
      expect(holderExit).toBe(0);

      const readRecord = () =>
        JSON.parse(readFileSync(recordPath, 'utf8')) as {
          recordWriteFailures?: number;
          lastRecordWriteError?: string;
        };
      await waitFor(
        () => (readRecord().recordWriteFailures ?? 0) > 0,
        'a record that counts the failed writes',
        10_000,
      );
      expect(readRecord().lastRecordWriteError).toMatch(
        /heartbeat write failed \((EPERM|EACCES|EBUSY)\)/,
      );
      expect(readFileSync(logPath, 'utf8')).not.toContain('[runner');
      expect(await manager.stop(started.id)).toBe(true);
    },
    60_000,
  );
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
