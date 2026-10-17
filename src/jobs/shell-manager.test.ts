import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIT_BASH_EVAL_SCRIPT, shellExecution } from '../shell-selection.js';
import { posixBash, windowsGitBash, windowsMsysSh } from '../test/real-shells.js';
import { removeWhenReleased } from '../test/remove-when-released.js';
import type { BackgroundShellStore } from '../types/runtime.js';
import { persistentJobPaths } from './persistent-store.js';
import { isProcessAlive } from './process-tree.js';
import { DEFAULT_RUNNER_START_BUDGET_MS, ShellJobManager } from './shell-manager.js';
import { PROVIDER_KEY_MARKER, redactSecrets } from '../provider-secrets.js';

/** Every runner this file spawns, so a test can find the one a failed start must have killed. */
const spawnedProcesses = vi.hoisted(() => [] as { args: readonly string[]; pid?: number }[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawnedProcesses.push({ args: Array.isArray(args[1]) ? args[1] : [], pid: child.pid });
      return child;
    }) as typeof actual.spawn,
  };
});

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
 * transitions past the interactive-host defaults (the 10s start and 5s stop defaults). The transitions are
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
    // and production gives up waiting after 5 s. Asserted everywhere but a Windows CI runner, where
    // the contended host pushes the stop transition past that budget (see `ciBudgets`).
    const finishedAt = manager.get(started.id)?.finishedAt ?? Number.POSITIVE_INFINITY;
    if (!(process.platform === 'win32' && process.env.CI)) {
      expect(finishedAt - stopRequestedAt).toBeLessThan(PRODUCTION_STOP_BUDGET_MS);
    }
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

  // The pid reported for a persistent job is its supervisor's. A signal sent to it used to stop only
  // the supervisor, and the command ran on without its lifeline.
  it.skipIf(process.platform === 'win32')(
    'stops the whole job when its reported pid is signalled',
    async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
      const persistentRoot = join(directory, 'jobs');
      const script = join(directory, 'worker.cjs');
      const pidPath = join(directory, 'worker.pid');
      writeFileSync(
        script,
        `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      // The trailing `; true` keeps the shell from exec-ing into the worker, so they are two processes.
      const command = `${shellQuote(process.execPath)} ${shellQuote(script)}; true`;
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
      await waitFor(() => existsSync(pidPath), 'worker pid file', 30_000);
      const workerPid = Number(readFileSync(pidPath, 'utf8'));
      const reportedPid = manager.get(started.id)?.pid;
      expect(reportedPid).toBeDefined();

      process.kill(reportedPid!, 'SIGTERM');
      await waitFor(() => !isProcessAlive(workerPid), 'the worker to end', 10_000);
    },
    60_000,
  );

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

  // `dispose()` used to `kill()` the direct child only. On Windows that child is the `cmd.exe`
  // wrapper, so the worker it started kept running with the console still attached; on POSIX the
  // session shell leads its own process group, and a SIGTERM to the wrapper left the group alive.
  // Either way a session background command outlived Book (#314), which is exactly what session
  // lifetime promises it will not do.
  it('ends a session shell’s whole process tree on dispose', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-session-shell-'));
    const pidPath = join(directory, 'grandchild.pid');
    // A grandchild that sleeps forever and writes its own pid, so its survival is observable
    // after the wrapper and the worker behind it are both gone.
    const script = join(directory, 'grandchild.cjs');
    writeFileSync(
      script,
      `const { spawn } = require('child_process');
const grandchild = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(
        `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
      )}], { stdio: 'ignore' });
grandchild.unref();
console.log('tree-started');
setInterval(() => {}, 1000);\n`,
    );
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
    managers.push(manager);
    await manager.start({
      command,
      effectiveCommand: command,
      workdir: directory,
      env: process.env,
      sandboxed: false,
    });
    await waitFor(() => existsSync(pidPath), 'grandchild pid file');
    const grandchildPid = Number(readFileSync(pidPath, 'utf8'));
    expect(isProcessAlive(grandchildPid)).toBe(true);

    manager.dispose();
    managers = [];

    // A direct kill of the wrapper leaves the grandchild running, so this is the assertion that
    // failed before: taskkill /T on Windows, and the process group on POSIX.
    await waitFor(
      () => {
        try {
          process.kill(grandchildPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      'the grandchild to be ended by dispose()',
      5_000,
    );
  }, 30_000);

  it('ends a session process that never reported a pid', () => {
    // No pid is no tree to walk, so the tree teardown has nothing to address and resolves without
    // touching anything. The process itself is still running, and leaving it behind is the one
    // outcome dispose cannot accept.
    const kill = vi.fn();
    const store = { nextId: 1, shells: new Map() };
    const manager = new ShellJobManager(store);
    store.shells.set('shell-pidless', {
      id: 'shell-pidless',
      command: 'started somewhere else',
      effectiveCommand: 'started somewhere else',
      workdir: '.',
      process: { killed: false, kill } as unknown as ChildProcess,
      status: 'running',
      output: '',
      readOffset: 0,
      truncatedBytes: 0,
      startedAt: 1,
    });

    manager.dispose();

    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('leaves a persistent job running after dispose', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
    const persistentRoot = join(directory, 'jobs');
    const script = join(directory, 'survivor.cjs');
    const pidPath = join(directory, 'survivor.pid');
    writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
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
    await waitFor(() => existsSync(pidPath), 'persistent worker pid file', 30_000);
    const workerPid = Number(readFileSync(pidPath, 'utf8'));

    manager.dispose();
    managers = [];
    // A persistent job is explicitly a job that survives Book, so dispose must not reach it.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(isProcessAlive(workerPid)).toBe(true);

    // Re-attach and stop it so the temp tree is not left behind running.
    const next = new ShellJobManager(
      { nextId: 1, shells: new Map() },
      { persistentRoot, ...ciBudgets },
    );
    managers.push(next);
    next.configureWorkspace(directory);
    expect(await next.stop(started.id)).toBe(true);
  }, 60_000);
});

// #523: Git Bash on Windows receives its command in `exec.env` rather than in argv, so every place
// that spawns an `exec` must hand that env to the command. Real bash runs the same fixed script.
describe.skipIf(!posixBash)('ShellJobManager and exec.env (#523)', () => {
  const command = 'echo "delivered [${BOOK_BASH_COMMAND+LEAK}]"';
  const exec = () => ({
    file: posixBash!,
    args: ['-c', GIT_BASH_EVAL_SCRIPT],
    env: { BOOK_BASH_COMMAND: command },
  });

  it('hands exec.env to a session background command', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-session-exec-env-'));
    const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
    managers.push(manager);
    const started = await manager.start({
      command,
      effectiveCommand: command,
      exec: exec(),
      workdir: directory,
      env: process.env,
      sandboxed: false,
    });
    await waitFor(() => manager.get(started.id)?.status === 'exited', 'session job exit');
    expect(manager.readTail(started.id)).toContain('delivered []');
    expect(manager.get(started.id)?.exitCode).toBe(0);
  });

  it('hands exec.env to a persistent command through the spec and supervisor', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-persistent-exec-env-'));
    const persistentRoot = join(directory, 'jobs');
    const manager = new ShellJobManager(
      { nextId: 1, shells: new Map() },
      { persistentRoot, ...ciBudgets },
    );
    managers.push(manager);
    manager.configureWorkspace(directory);
    const started = await manager.start({
      command,
      effectiveCommand: command,
      exec: exec(),
      workdir: directory,
      env: process.env,
      envOverrides: {},
      sandboxed: false,
      lifetime: 'persistent',
      workspace: directory,
    });
    await waitFor(
      () => manager.get(started.id)?.status === 'exited',
      'persistent job exit',
      30_000,
    );
    expect(manager.readTail(started.id)).toContain('delivered []');
    expect(manager.get(started.id)?.exitCode).toBe(0);
  }, 60_000);
});

// #523 on the one platform that uses the env delivery: the real Git Bash runs the real
// `shellExecution` exec in a session job and a persistent job. `echo'1;echo'2` has no space, tab or
// `"`, so in argv the MSYS runtime would strip its quotes and bash would report two missing commands,
// `echo1` and `echo2`; delivered intact it is one command named `echo1;echo2`. The equally
// space-free `env>env.txt` then records the command's environment, which must not hold the variable.
describe.skipIf(!windowsGitBash)(
  'ShellJobManager runs Git Bash commands intact on Windows (#523)',
  () => {
    const command = "echo'1;echo'2;env>env.txt";
    const ACTIVE = ['starting', 'running', 'stopping'];

    function gitBashExec() {
      const exec = shellExecution(windowsGitBash!, command, 'win32')!;
      expect(exec.env).toEqual({ BOOK_BASH_COMMAND: command });
      return exec;
    }

    async function expectIntact(manager: ShellJobManager, id: string): Promise<void> {
      await waitFor(
        () => !ACTIVE.includes(manager.get(id)?.status ?? 'starting'),
        'Git Bash job exit',
        30_000,
      );
      const output = manager.readTail(id) ?? '';
      expect(output.match(/command not found/g)?.length ?? 0, output).toBe(1);
      expect(output).toContain('echo1;echo2: command not found');
      expect(manager.get(id)?.status).toBe('exited');
      const environment = readFileSync(join(directory, 'env.txt'), 'utf8');
      expect(environment).toMatch(/^PATH=/m);
      expect(environment).not.toMatch(/^BOOK_BASH_COMMAND=/m);
    }

    it('in a session background job', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-session-git-bash-'));
      const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
      managers.push(manager);
      const started = await manager.start({
        command,
        effectiveCommand: command,
        exec: gitBashExec(),
        workdir: directory,
        env: process.env,
        sandboxed: false,
      });
      await expectIntact(manager, started.id);
    }, 60_000);

    it('in a persistent job, through the spec and the supervisor', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-persistent-git-bash-'));
      const persistentRoot = join(directory, 'jobs');
      const manager = new ShellJobManager(
        { nextId: 1, shells: new Map() },
        { persistentRoot, ...ciBudgets },
      );
      managers.push(manager);
      manager.configureWorkspace(directory);
      const started = await manager.start({
        command,
        effectiveCommand: command,
        exec: gitBashExec(),
        workdir: directory,
        env: process.env,
        envOverrides: {},
        sandboxed: false,
        lifetime: 'persistent',
        workspace: directory,
      });
      await expectIntact(manager, started.id);
    }, 60_000);
  },
);

// #532: Git's `usr\bin\sh.exe` is on the MSYS runtime too, so a background job gets the same
// delivery. sh may word a missing command as `not found` rather than `command not found`.
describe.skipIf(!windowsMsysSh)(
  'ShellJobManager runs MSYS sh commands intact on Windows (#532)',
  () => {
    it('in a session background job', async () => {
      const command = "echo'1;echo'2;env>env.txt";
      const exec = shellExecution(windowsMsysSh!, command, 'win32')!;
      expect(exec.env).toEqual({ BOOK_BASH_COMMAND: command });
      directory = mkdtempSync(join(tmpdir(), 'book-session-msys-sh-'));
      const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
      managers.push(manager);
      const started = await manager.start({
        command,
        effectiveCommand: command,
        exec,
        workdir: directory,
        env: process.env,
        sandboxed: false,
      });
      await waitFor(
        () =>
          !['starting', 'running', 'stopping'].includes(
            manager.get(started.id)?.status ?? 'starting',
          ),
        'MSYS sh job exit',
        30_000,
      );
      const output = manager.readTail(started.id) ?? '';
      expect(output.match(/not found/g)?.length ?? 0, output).toBe(1);
      expect(output).toContain('echo1;echo2');
      const environment = readFileSync(join(directory, 'env.txt'), 'utf8');
      expect(environment).toMatch(/^PATH=/m);
      expect(environment).not.toMatch(/^BOOK_BASH_COMMAND=/m);
    }, 60_000);
  },
);

// #411: a chunk limit that fell inside a provider key left half of it in each of two reads, and
// neither half matches an exact-value redactor. The read now ends before the key (or after it, when
// the key opens the chunk), and `readOffset`/`remaining` follow the adjusted cut.
describe('ShellJobManager.readOutput with secrets', () => {
  const KEY = 'sk-live-0123456789abcdef';

  /** Every read until the job's output is drained. */
  function drain(manager: ShellJobManager, id: string, limit: number): string[] {
    const reads: string[] = [];
    for (let i = 0; i < 100; i++) {
      const read = manager.readOutput(id, limit, [KEY]);
      if (!read || read.output === '(no new output)') break;
      reads.push(read.output);
      if (read.remaining === 0) break;
    }
    return reads;
  }

  function expectNoKeyPart(reads: string[]): void {
    for (const read of reads) {
      expect(read).not.toContain(KEY);
      // No 8-character window of the key survives in any read.
      for (let at = 0; at + 8 <= KEY.length; at++) {
        expect(read).not.toContain(KEY.slice(at, at + 8));
      }
    }
  }

  it('never ends a read inside the key of an in-memory job', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-secret-chunks-'));
    const script = join(directory, 'emit.cjs');
    writeFileSync(
      script,
      `process.stdout.write('a'.repeat(30) + ${JSON.stringify(KEY)} + 'b'.repeat(30));\n`,
    );
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
    managers.push(manager);
    const started = await manager.start({
      command,
      effectiveCommand: command,
      workdir: directory,
      env: process.env,
      envOverrides: {},
      sandboxed: false,
      workspace: directory,
    });
    await waitFor(
      () => (manager.readTail(started.id) ?? '').endsWith('b'.repeat(30)),
      'job output',
    );
    // A finished job returns everything; a running one holds its unterminated last line back.
    await waitFor(
      () => !['running', 'starting'].includes(manager.get(started.id)?.status ?? ''),
      'job exit',
    );

    // 40 falls 10 characters into the key: the read stops where the key starts.
    const first = manager.readOutput(started.id, 40, [KEY]);
    expect(first?.output).toBe('a'.repeat(30));
    expect(first?.remaining).toBe(KEY.length + 30);
    expect(manager.get(started.id)?.readOffset).toBe(30);

    // A limit smaller than the key, with the key opening the chunk: the read takes the whole key.
    const second = manager.readOutput(started.id, 5, [KEY]);
    expect(second?.output).toBe(KEY);
    expect(second?.remaining).toBe(30);
    expect(manager.readOutput(started.id, 5, [KEY])?.output).toBe('b'.repeat(5));
  });

  it('reads a key whole across every limit, in memory', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-secret-chunks-'));
    const script = join(directory, 'emit.cjs');
    writeFileSync(
      script,
      `process.stdout.write('a'.repeat(30) + ${JSON.stringify(KEY)} + 'b'.repeat(30));\n`,
    );
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
    const manager = new ShellJobManager(store);
    managers.push(manager);
    const started = await manager.start({
      command,
      effectiveCommand: command,
      workdir: directory,
      env: process.env,
      envOverrides: {},
      sandboxed: false,
      workspace: directory,
    });
    await waitFor(
      () => (manager.readTail(started.id) ?? '').endsWith('b'.repeat(30)),
      'job output',
    );
    // A finished job returns everything; a running one holds its unterminated last line back.
    await waitFor(
      () => !['running', 'starting'].includes(manager.get(started.id)?.status ?? ''),
      'job exit',
    );
    // Rewind the cursor each time so every limit is tried against the same output.
    const full = 'a'.repeat(30) + KEY + 'b'.repeat(30);
    for (let limit = 1; limit <= full.length; limit++) {
      store.shells.get(started.id)!.readOffset = 0;
      const reads = drain(manager, started.id, limit);
      expect(reads.join('')).toBe(full);
      expect(reads.some((read) => read.includes(KEY))).toBe(true);
      // Each read either holds the key whole or none of it.
      for (const read of reads) {
        if (!read.includes(KEY)) expectNoKeyPart([read]);
      }
    }
  });

  it('never ends a read inside the key of a persistent job log', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-secret-chunks-persistent-'));
    const persistentRoot = join(directory, 'jobs');
    const script = join(directory, 'emit.cjs');
    writeFileSync(
      script,
      `process.stdout.write('a'.repeat(30) + ${JSON.stringify(KEY)} + 'b'.repeat(30) + '\\n');\nsetInterval(() => {}, 1000);\n`,
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
    await waitFor(
      () => (manager.readTail(started.id) ?? '').endsWith('b'.repeat(30) + '\n'),
      'persistent shell output',
      30_000,
    );

    const first = manager.readOutput(started.id, 40, [KEY]);
    expect(first?.output).toBe('a'.repeat(30));
    expect(first?.remaining).toBe(KEY.length + 31);
    const second = manager.readOutput(started.id, 5, [KEY]);
    expect(second?.output).toBe(KEY);
    expect(second?.remaining).toBe(31);
  }, 60_000);
});

// #411 review fixes: the front of a window (a tail, a trimmed buffer) and the end of a read of a job
// that is still writing can each split a key, and neither half then matches an exact-value redactor.
describe('ShellJobManager and keys split at the edge of a window', () => {
  const KEY = 'sk-live-0123456789abcdef';
  const HALF = KEY.slice(0, 12);
  const MAX_BUFFER = 5 * 1024 * 1024;

  function expectNoPartialKey(text: string): void {
    if (text.includes(KEY)) return;
    for (let at = 0; at + 8 <= KEY.length; at++) {
      expect(text).not.toContain(KEY.slice(at, at + 8));
    }
  }

  async function startNode(
    manager: ShellJobManager,
    source: string,
    options: { persistent?: boolean } = {},
  ) {
    const script = join(directory, `job-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(script, source);
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    return manager.start({
      command,
      effectiveCommand: command,
      workdir: directory,
      env: process.env,
      envOverrides: {},
      sandboxed: false,
      workspace: directory,
      ...(options.persistent ? { lifetime: 'persistent' as const } : {}),
    });
  }

  const isRunning = (manager: ShellJobManager, id: string) =>
    manager.get(id)?.status === 'running' || manager.get(id)?.status === 'starting';

  describe('readTail', () => {
    const source = `process.stdout.write('a'.repeat(10) + ${JSON.stringify(KEY)} + 'b'.repeat(10));\n`;

    it('returns a key that straddles the front edge whole', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-secret-tail-'));
      const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
      managers.push(manager);
      const started = await startNode(manager, source);
      await waitFor(() => (manager.readTail(started.id) ?? '').endsWith('b'.repeat(10)), 'output');

      // 30 characters from the end is 14 characters into the key.
      const plain = manager.readTail(started.id, 30);
      expect(plain).toHaveLength(30);
      expect(plain).not.toContain(KEY);

      const tail = manager.readTail(started.id, 30, [KEY]);
      expect(tail).toBe(KEY + 'b'.repeat(10));
      // What the completion message carries after redaction: the marker, and no part of the key.
      const redacted = redactSecrets(tail ?? '', [KEY]);
      expect(redacted).toBe(`${PROVIDER_KEY_MARKER}${'b'.repeat(10)}`);
      expectNoPartialKey(redacted);
      // A clean edge is untouched.
      expect(manager.readTail(started.id, 10, [KEY])).toBe('b'.repeat(10));
    });

    it('does the same for a persistent job log', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-secret-tail-persistent-'));
      const manager = new ShellJobManager(
        { nextId: 1, shells: new Map() },
        { persistentRoot: join(directory, 'jobs'), ...ciBudgets },
      );
      managers.push(manager);
      manager.configureWorkspace(directory);
      const started = await startNode(manager, `${source}setInterval(() => {}, 1000);\n`, {
        persistent: true,
      });
      await waitFor(
        () => (manager.readTail(started.id) ?? '').endsWith('b'.repeat(10)),
        'persistent output',
        30_000,
      );

      expect(manager.readTail(started.id, 30, [KEY])).toBe(KEY + 'b'.repeat(10));
    }, 60_000);
  });

  describe('the background buffer trim', () => {
    it('leaves no fragment of a key at the front of the buffer', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-secret-trim-'));
      const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
      const manager = new ShellJobManager(store);
      managers.push(manager);
      manager.setProviderSecrets([KEY]);
      // The key sits 100 characters in; the buffer ends up 112 characters over its cap, so a plain
      // trim would cut 12 characters into it.
      const tail = MAX_BUFFER - 12;
      const started = await startNode(
        manager,
        `process.stdout.write('a'.repeat(100) + ${JSON.stringify(KEY)} + 'b'.repeat(${tail}));\n`,
      );
      await waitFor(() => !isRunning(manager, started.id), 'job exit', 20_000);

      const shell = store.shells.get(started.id)!;
      expect(shell.output.slice(0, 64)).toMatch(/^(sk-live-0123456789abcdef)?b+/);
      expectNoPartialKey(shell.output.slice(0, 64));
      // Every character is either kept or counted as truncated.
      expect(shell.truncatedBytes + shell.output.length).toBe(100 + KEY.length + tail);
      expect(shell.readOffset).toBe(0);
    }, 60_000);
  });

  describe('a job that is still writing', () => {
    function twoStageSource(go: string, firstWrite: string, secondWrite: string): string {
      return [
        `const fs = require('fs');`,
        `process.stdout.write(${JSON.stringify(firstWrite)});`,
        `const timer = setInterval(() => {`,
        `  if (!fs.existsSync(${JSON.stringify(go)})) return;`,
        `  clearInterval(timer);`,
        `  process.stdout.write(${JSON.stringify(secondWrite)});`,
        `  setTimeout(() => process.exit(0), 50);`,
        `}, 20);`,
      ].join('\n');
    }

    /** A job that prints `text` and keeps running. */
    const idleSource = (text: string) =>
      `process.stdout.write(${JSON.stringify(text)});\nsetInterval(() => {}, 1000);\n`;

    async function exerciseTwoReads(manager: ShellJobManager, persistent: boolean): Promise<void> {
      const go = join(directory, 'go');
      // Half the key is written with no line break after it.
      const started = await startNode(
        manager,
        twoStageSource(go, `head-\n${HALF}`, `${KEY.slice(12)}-tail\n`),
        { persistent },
      );
      await waitFor(
        () => (manager.readTail(started.id) ?? '').endsWith(HALF),
        'half a key',
        30_000,
      );

      const first = manager.readOutput(started.id, undefined, [KEY]);
      expect(first?.output).toBe('head-\n');
      expect(first?.output).not.toContain(HALF);
      expect(first?.remaining).toBe(0);
      // Nothing more until the line is terminated: the half key is not returned.
      expect(manager.readOutput(started.id, undefined, [KEY])?.output).toBe('(no new output)');

      writeFileSync(go, '');
      await waitFor(() => !isRunning(manager, started.id), 'job exit', 30_000);
      const second = manager.readOutput(started.id, undefined, [KEY]);
      expect(second?.output).toBe(`${KEY}-tail\n`);
      expect(redactSecrets(second?.output ?? '', [KEY])).toBe(`${PROVIDER_KEY_MARKER}-tail\n`);
      expect(manager.readOutput(started.id, undefined, [KEY])?.output).toBe('(no new output)');
    }

    it('holds back an unterminated line until it ends (in memory)', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-secret-running-'));
      const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
      managers.push(manager);
      await exerciseTwoReads(manager, false);
    });

    it('holds back an unterminated line until it ends (persistent)', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-secret-running-persistent-'));
      const manager = new ShellJobManager(
        { nextId: 1, shells: new Map() },
        { persistentRoot: join(directory, 'jobs'), ...ciBudgets },
      );
      managers.push(manager);
      manager.configureWorkspace(directory);
      await exerciseTwoReads(manager, true);
    }, 90_000);

    it('stops a read after the last line break, whatever the trailing text is', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-secret-lines-'));
      const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
      managers.push(manager);
      const started = await startNode(manager, idleSource('one\ntwo\r\nthree'));
      await waitFor(() => (manager.readTail(started.id) ?? '').endsWith('three'), 'output');

      const read = manager.readOutput(started.id, undefined, [KEY]);
      expect(read?.output).toBe('one\ntwo\r\n');
      expect(read?.remaining).toBe(0);
      expect(manager.readOutput(started.id, undefined, [KEY])?.output).toBe('(no new output)');
    });

    it('decides the same for a trailing fragment that matches a key prefix and one that does not', async () => {
      // A read must not tell a caller whether the key starts with what it printed.
      const observe = async (fragment: string) => {
        directory = mkdtempSync(join(tmpdir(), 'book-secret-oracle-'));
        const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
        managers.push(manager);
        const started = await startNode(manager, idleSource(`line\n${fragment}`));
        await waitFor(() => (manager.readTail(started.id) ?? '').endsWith(fragment), 'output');
        const withLine = manager.readOutput(started.id, undefined, [KEY]);
        const fragmentOnly = manager.readOutput(started.id, undefined, [KEY]);
        return { withLine, fragmentOnly };
      };

      const matching = await observe(KEY.slice(0, 5));
      const other = await observe('zzzzz');

      expect(matching.withLine?.output).toBe('line\n');
      expect(other.withLine?.output).toBe(matching.withLine?.output);
      expect(other.withLine?.remaining).toBe(matching.withLine?.remaining);
      expect(matching.fragmentOnly?.output).toBe('(no new output)');
      expect(other.fragmentOnly?.output).toBe(matching.fragmentOnly?.output);
      expect(other.fragmentOnly?.remaining).toBe(matching.fragmentOnly?.remaining);
    });

    it('reports no new output while all that is unread is an unterminated line', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-secret-running-only-'));
      const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
      managers.push(manager);
      const started = await startNode(manager, idleSource(HALF));
      await waitFor(() => (manager.readTail(started.id) ?? '') === HALF, 'half a key');

      const read = manager.readOutput(started.id, undefined, [KEY]);
      expect(read?.output).toBe('(no new output)');
      expect(read?.remaining).toBe(0);
      expect(manager.get(started.id)?.readOffset).toBe(0);
      // With no secrets there is nothing to protect, so nothing is held back.
      expect(manager.readOutput(started.id)?.output).toBe(HALF);
    });

    it('still returns an over-long line with no line break, up to the cap', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-secret-longline-'));
      const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
      managers.push(manager);
      const started = await startNode(manager, idleSource('a'.repeat(3000)));
      await waitFor(() => (manager.readTail(started.id, 4000) ?? '').length === 3000, 'output');

      const first = manager.readOutput(started.id, undefined, [KEY]);
      expect(first?.output).toBe('a'.repeat(1024));
      expect(first?.remaining).toBe(3000 - 1024);
      const second = manager.readOutput(started.id, undefined, [KEY]);
      expect(second?.output).toBe('a'.repeat(1024));
    });

    it('returns a finished job’s trailing text in full', async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-secret-finished-'));
      const manager = new ShellJobManager({ nextId: 1, shells: new Map() });
      managers.push(manager);
      const started = await startNode(
        manager,
        `process.stdout.write('done ' + ${JSON.stringify(HALF)});\n`,
      );
      await waitFor(() => !isRunning(manager, started.id), 'job exit');

      const read = manager.readOutput(started.id, undefined, [KEY]);
      expect(read?.output).toBe(`done ${HALF}`);
      expect(read?.remaining).toBe(0);
    });
  });
});

// A persistent start waits for the detached runner (node), which starts its supervisor (node), which
// starts the command. A loaded Windows runner took over the old 3s budget (#495). These tests drive
// the budget's clock by hand, so neither needs a real multi-second wait.
describe('ShellJobManager persistent start budget', () => {
  function idleCommand(): string {
    const script = join(directory, 'idle.cjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    return `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  }

  it('is ten seconds', () => {
    expect(DEFAULT_RUNNER_START_BUDGET_MS).toBe(10_000);
  });

  it('starts a job whose runner takes longer than three seconds under the default budget', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
    const persistentRoot = join(directory, 'jobs');
    const command = idleCommand();
    // 0, 2000, 4000, then held: by the third reading the old 3s budget is spent, as if the runner
    // had taken about 4s. The hold is bounded in real time. Once it ends the clock runs a thousand
    // times fast, so the start, and the stop in `afterEach`, end inside the timeouts even when the
    // runner never starts, instead of hanging on a clock that never reaches its deadline.
    const HOLD_REAL_MS = 20_000;
    const createdAt = performance.now();
    let readings = 0;
    const clock = {
      monotonicNowMs: () => {
        const reading = readings++;
        const real = performance.now() - createdAt;
        if (real < HOLD_REAL_MS) return Math.min(reading * 2_000, 4_000);
        return 4_000 + (real - HOLD_REAL_MS) * 1_000;
      },
      wallNowMs: () => Date.now(),
    };
    const manager = new ShellJobManager(
      { nextId: 1, shells: new Map() },
      { persistentRoot, runnerStopBudgetMs: 30_000, clock },
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

    expect(readings).toBeGreaterThanOrEqual(3);
    // `start()` only returns once the runner has reported, and an idle command is still running.
    expect(started.status).toBe('running');
    expect(manager.get(started.id)).toBeDefined();
  }, 30_000);

  it('kills the runner, forgets the job and throws when a start outlasts the default budget', async () => {
    directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
    const persistentRoot = join(directory, 'jobs');
    const command = idleCommand();
    let readings = 0;
    const clock = {
      // The first reading opens the budget; the next is already past it.
      monotonicNowMs: () => (readings++ === 0 ? 0 : DEFAULT_RUNNER_START_BUDGET_MS + 1_000),
      wallNowMs: () => Date.now(),
    };
    const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
    const manager = new ShellJobManager(store, { persistentRoot, clock });
    managers.push(manager);
    manager.configureWorkspace(directory);
    const specs = persistentJobPaths(directory, persistentRoot).specs;
    spawnedProcesses.length = 0;

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
    ).rejects.toThrow(`did not start within ${DEFAULT_RUNNER_START_BUDGET_MS}ms`);

    await expectRunnerKilledAndJobForgotten(manager, store, specs);
  }, 30_000);

  /** What a start that gave up must leave behind: no runner, no job, no spec file. */
  async function expectRunnerKilledAndJobForgotten(
    manager: ShellJobManager,
    store: BackgroundShellStore,
    specs: string,
  ): Promise<void> {
    const runner = spawnedProcesses.find((entry) => entry.args.at(-1)?.startsWith(specs));
    expect(runner?.pid).toBeDefined();
    await waitFor(() => !isProcessAlive(runner!.pid!), 'the runner to be killed', 10_000);
    expect(store.shells.size).toBe(0);
    expect(manager.list()).toEqual([]);
    expect(existsSync(specs) ? readdirSync(specs) : []).toEqual([]);
  }

  /**
   * A start that `cancel` interrupts inside the poll loop, with no real time in play: the clock
   * never moves, so only the cancellation can end the start.
   */
  async function startCancelledBy(
    cancel: (manager: ShellJobManager, controller: AbortController) => void,
  ) {
    directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
    const persistentRoot = join(directory, 'jobs');
    const command = idleCommand();
    const controller = new AbortController();
    let readings = 0;
    const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
    const clock = {
      // Reading 1 opens the budget, reading 2 is the first test of the loop.
      monotonicNowMs: () => {
        if (readings++ === 1) cancel(manager, controller);
        return 0;
      },
      wallNowMs: () => Date.now(),
    };
    const manager = new ShellJobManager(store, { persistentRoot, clock });
    managers.push(manager);
    manager.configureWorkspace(directory);
    const specs = persistentJobPaths(directory, persistentRoot).specs;
    spawnedProcesses.length = 0;

    const outcome = await manager
      .start({
        command,
        effectiveCommand: command,
        workdir: directory,
        env: process.env,
        envOverrides: {},
        sandboxed: false,
        lifetime: 'persistent',
        workspace: directory,
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
    return { manager, store, specs, outcome };
  }

  it('stops waiting for the runner when the start is aborted, and forgets the job', async () => {
    const { manager, store, specs, outcome } = await startCancelledBy((_manager, controller) =>
      controller.abort(),
    );

    expect(outcome?.message).toMatch(/cancelled/);
    expect(outcome?.message).not.toMatch(/did not start within/);
    await expectRunnerKilledAndJobForgotten(manager, store, specs);
  }, 30_000);

  it('stops waiting for the runner when the manager is disposed, and forgets the job', async () => {
    const { manager, store, specs, outcome } = await startCancelledBy((disposing) =>
      disposing.dispose(),
    );

    expect(outcome?.message).toMatch(/disposed/);
    expect(outcome?.message).not.toMatch(/did not start within/);
    await expectRunnerKilledAndJobForgotten(manager, store, specs);
  }, 30_000);
});
