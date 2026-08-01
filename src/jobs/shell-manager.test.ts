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
    const firstStore: BackgroundShellStore = { nextId: 1, shells: new Map() };
    const first = new ShellJobManager(firstStore, { persistentRoot });
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
    await waitFor(
      () => first.readTail(started.id)?.includes('persistent-ready') === true,
      'persistent shell output',
    );

    first.dispose();
    managers = [];

    const secondStore: BackgroundShellStore = { nextId: 1, shells: new Map() };
    const second = new ShellJobManager(secondStore, { persistentRoot });
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
  }, 15_000);

  it.skipIf(process.platform === 'win32')(
    'waits for a SIGTERM-resistant process tree before recording the job as killed',
    async () => {
      directory = mkdtempSync(join(tmpdir(), 'book-persistent-shell-'));
      const persistentRoot = join(directory, 'jobs');
      const script = join(directory, 'resistant.cjs');
      const pidPath = join(directory, 'worker.pid');
      writeFileSync(
        script,
        `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`,
      );
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
      expect(() => process.kill(workerPid, 0)).toThrow();
    },
    15_000,
  );
});
