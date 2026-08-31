import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundShellStore } from '../types/runtime.js';
import {
  persistentJobPaths,
  writeJsonAtomic,
  type PersistentShellSpec,
  type PersistentShellState,
} from './persistent-store.js';
import { windowsTaskkillPath } from './process-tree.js';
import { ShellJobManager, terminateWindowsProcessTree } from './shell-manager.js';

let directory: string;

function state(
  id: string,
  status: PersistentShellState['status'],
  paths: ReturnType<typeof persistentJobPaths>,
  overrides: Partial<PersistentShellState> = {},
): PersistentShellState {
  return {
    version: 1,
    revision: 1,
    id,
    command: 'node worker.cjs',
    title: id,
    workdir: directory,
    status,
    notify: 'ui',
    sandboxed: false,
    runnerPid: 2_147_483_647,
    tokenHash: 'hash',
    startedAt: Date.now() - 2_000,
    heartbeatAt: Date.now(),
    outputPath: join(paths.logs, `${id}.log`),
    controlPath: join(paths.controls, `${id}.json`),
    completionSequence: status === 'running' ? 0 : 1,
    completionDeliveredSequence: 0,
    completionAcknowledgedSequence: 0,
    ...overrides,
  };
}

function spec(id: string, paths: ReturnType<typeof persistentJobPaths>): PersistentShellSpec {
  return {
    version: 1,
    id,
    command: 'node worker.cjs',
    effectiveCommand: 'node worker.cjs',
    title: id,
    workdir: directory,
    env: {},
    sandboxed: false,
    notify: 'ui',
    token: 'token',
    tokenHash: 'hash',
    recordPath: join(paths.records, `${id}.json`),
    controlPath: join(paths.controls, `${id}.json`),
    outputPath: join(paths.logs, `${id}.log`),
    maxLogBytes: 100,
  };
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('ShellJobManager persistent state recovery', () => {
  it('returns model completions only for their originating session', () => {
    const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
    for (const parentSessionId of ['session-a', 'session-b']) {
      const id = `shell_${parentSessionId}`;
      store.shells.set(id, {
        id,
        command: 'done',
        effectiveCommand: 'done',
        workdir: process.cwd(),
        status: 'exited',
        notify: 'agent',
        parentSessionId,
        output: '',
        readOffset: 0,
        truncatedBytes: 0,
        startedAt: 1,
        finishedAt: 2,
        completionSequence: 1,
        completionDeliveredSequence: 0,
      });
    }
    const manager = new ShellJobManager(store);

    expect(manager.listPendingAgentCompletions('session-b').map((job) => job.id)).toEqual([
      'shell_session-b',
    ]);
  });

  it('marks a dead runner with a stale heartbeat as lost', () => {
    directory = mkdtempSync(join(tmpdir(), 'book-shell-state-'));
    const root = join(directory, 'jobs');
    const paths = persistentJobPaths(directory, root);
    const id = 'shell_stale';
    const record = state(id, 'running', paths, {
      heartbeatAt: Date.now() - 30_000,
    });
    writeJsonAtomic(join(paths.records, `${id}.json`), record);
    writeJsonAtomic(join(paths.specs, `${id}.json`), spec(id, paths));
    writeJsonAtomic(join(paths.controls, `${id}.json`), { token: 'token', action: 'stop' });
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(join(paths.logs, `${id}.log`), 'old output');

    const manager = new ShellJobManager({ nextId: 1, shells: new Map() }, { persistentRoot: root });
    manager.configureWorkspace(directory);

    expect(manager.get(id)?.status).toBe('lost');
    expect(existsSync(join(paths.records, `${id}.json`))).toBe(true);
    expect(existsSync(join(paths.specs, `${id}.json`))).toBe(false);
    expect(existsSync(join(paths.controls, `${id}.json`))).toBe(false);
    manager.dispose();
  });

  it('resets the read offset when a persistent log shrinks', () => {
    directory = mkdtempSync(join(tmpdir(), 'book-shell-output-'));
    const outputPath = join(directory, 'output.log');
    writeFileSync(outputPath, 'new');
    const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
    store.shells.set('shell_output', {
      id: 'shell_output',
      command: 'cat',
      effectiveCommand: 'cat',
      workdir: directory,
      status: 'running',
      lifetime: 'persistent',
      output: '',
      readOffset: 10,
      truncatedBytes: 0,
      startedAt: Date.now(),
      persistentOutputPath: outputPath,
    });
    const manager = new ShellJobManager(store);

    const result = manager.readOutput('shell_output');
    expect(result?.output).toBe('new');
    expect(result?.shell.truncatedBytes).toBe(7);
  });

  it('removes persistent files when terminal retention prunes a record', () => {
    directory = mkdtempSync(join(tmpdir(), 'book-shell-retention-'));
    const root = join(directory, 'jobs');
    const paths = persistentJobPaths(directory, root);
    const id = 'shell_old';
    const record = state(id, 'exited', paths, {
      startedAt: Date.now() - 1_000_000,
      finishedAt: Date.now() - 16 * 60_000,
    });
    writeJsonAtomic(join(paths.records, `${id}.json`), record);
    writeJsonAtomic(join(paths.specs, `${id}.json`), spec(id, paths));
    writeJsonAtomic(join(paths.controls, `${id}.json`), { token: 'token' });
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(join(paths.logs, `${id}.log`), 'old output');

    const manager = new ShellJobManager({ nextId: 1, shells: new Map() }, { persistentRoot: root });
    manager.configureWorkspace(directory);
    expect(manager.list()).toEqual([]);
    expect(existsSync(join(paths.records, `${id}.json`))).toBe(false);
    expect(existsSync(join(paths.logs, `${id}.log`))).toBe(false);
    manager.dispose();
  });

  it('falls back to killing the direct child when taskkill fails', async () => {
    const kill = vi.fn();
    const processLike = { kill } as never;
    await terminateWindowsProcessTree(processLike, 123, 'SIGTERM', async () => false);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('resolves taskkill executable path for Windows process tree termination', () => {
    const resolved = windowsTaskkillPath();
    if (process.platform === 'win32') {
      expect(resolved).toMatch(/System32[\\/]taskkill\.exe$/i);
      expect(existsSync(resolved)).toBe(true);
    } else {
      expect(resolved).toBe('taskkill');
    }
  });
});
