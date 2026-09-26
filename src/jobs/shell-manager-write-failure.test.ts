import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Record writes from the TUI's own process retry a contended rename for only 100 ms, so on
// Windows they can still throw. These tests make chosen writes fail the way such a write does.
const failing = vi.hoisted(() => ({ paths: new Set<string>() }));

vi.mock('./persistent-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./persistent-store.js')>();
  return {
    ...actual,
    writeJsonAtomic: (...args: Parameters<typeof actual.writeJsonAtomic>) => {
      const [path] = args;
      if (failing.paths.has(path)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${path}'`), {
          code: 'EPERM',
        });
      }
      actual.writeJsonAtomic(...args);
    },
  };
});

import {
  persistentJobPaths,
  writeJsonAtomic,
  type PersistentShellSpec,
  type PersistentShellState,
} from './persistent-store.js';
import { ShellJobManager } from './shell-manager.js';

/** A pid no process has: `process.kill(pid, 0)` fails for it. */
const DEAD_PID = 2_147_483_647;

let directory: string | undefined;
let manager: ShellJobManager | undefined;

afterEach(() => {
  vi.useRealTimers();
  failing.paths.clear();
  manager?.dispose();
  manager = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function setup(id: string, overrides: Partial<PersistentShellState>) {
  directory = mkdtempSync(join(tmpdir(), 'book-shell-write-failure-'));
  const root = join(directory, 'jobs');
  const paths = persistentJobPaths(directory, root);
  mkdirSync(paths.logs, { recursive: true });
  const recordPath = join(paths.records, `${id}.json`);
  const controlPath = join(paths.controls, `${id}.json`);
  const specPath = join(paths.specs, `${id}.json`);
  const state: PersistentShellState = {
    version: 1,
    revision: 1,
    id,
    command: 'node worker.cjs',
    title: id,
    workdir: directory,
    status: 'running',
    notify: 'ui',
    sandboxed: false,
    runnerPid: DEAD_PID,
    tokenHash: 'hash',
    startedAt: Date.now() - 20_000,
    heartbeatAt: Date.now(),
    outputPath: join(paths.logs, `${id}.log`),
    controlPath,
    completionSequence: 0,
    completionDeliveredSequence: 0,
    completionAcknowledgedSequence: 0,
    ...overrides,
  };
  const spec: PersistentShellSpec = {
    version: 1,
    id,
    command: state.command,
    effectiveCommand: state.command,
    title: id,
    workdir: directory,
    env: {},
    sandboxed: false,
    notify: 'ui',
    token: 'token',
    tokenHash: 'hash',
    recordPath,
    controlPath,
    outputPath: state.outputPath,
    maxLogBytes: 100,
  };
  writeJsonAtomic(recordPath, state);
  writeJsonAtomic(specPath, spec);
  manager = new ShellJobManager({ nextId: 1, shells: new Map() }, { persistentRoot: root });
  return { manager, recordPath, controlPath, specPath };
}

describe('ShellJobManager record writes that fail', () => {
  it('keeps the monitor alive when a lost record cannot be written, and writes it later', () => {
    vi.useFakeTimers();
    const id = 'shell_stale';
    // Nine seconds without a heartbeat is still fresh; the monitor finds it stale a moment later.
    const { manager, recordPath, specPath } = setup(id, { heartbeatAt: Date.now() - 9_000 });
    manager.configureWorkspace(directory!);
    expect(manager.get(id)?.status).toBe('running');

    failing.paths.add(recordPath);
    // The monitor's 500 ms timer now finds the dead runner stale and cannot record it as lost.
    expect(() => vi.advanceTimersByTime(1_500)).not.toThrow();
    expect(manager.get(id)?.status).toBe('lost');
    expect(existsSync(specPath)).toBe(true);

    failing.paths.delete(recordPath);
    vi.advanceTimersByTime(500);
    const written = JSON.parse(readFileSync(recordPath, 'utf8')) as PersistentShellState;
    expect(written.status).toBe('lost');
    expect(existsSync(specPath)).toBe(false);
  });

  it('keeps an acknowledgement in memory when its record cannot be written', () => {
    const id = 'shell_done';
    const { manager, recordPath } = setup(id, {
      status: 'exited',
      exitCode: 0,
      finishedAt: Date.now() - 1_000,
      completionSequence: 1,
    });
    manager.configureWorkspace(directory!);
    expect(manager.listPendingUiCompletions().map((job) => job.id)).toEqual([id]);

    failing.paths.add(recordPath);
    expect(() => manager.acknowledgeCompletion(id)).not.toThrow();
    expect(manager.listPendingUiCompletions()).toEqual([]);
  });

  it('leaves a job running when its stop request cannot be written', async () => {
    const id = 'shell_live';
    // A live runner pid keeps the record from being judged lost.
    const { manager, controlPath } = setup(id, { runnerPid: process.pid });
    manager.configureWorkspace(directory!);
    expect(manager.get(id)?.status).toBe('running');

    failing.paths.add(controlPath);
    await expect(manager.stop(id)).rejects.toThrow(/Could not request the stop of shell_live/);
    expect(manager.get(id)?.status).toBe('running');
  });
});
