import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rename as renameAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtomicJsonWriter } from './atomic-json.js';

let directory = '';

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = '';
});

function fixture() {
  directory = mkdtempSync(join(tmpdir(), 'book-atomic-json-'));
  const target = join(directory, 'record.json');
  writeFileSync(target, '{"version":"old"}\n');
  return { target };
}

function contention(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('AtomicJsonWriter', () => {
  it('fsyncs a complete temp and atomically replaces the target', () => {
    const { target } = fixture();
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
    });

    const result = writer.write(target, { version: 'new' });

    expect(result.status).toBe('ok');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ version: 'new' });
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries %s rename contention and succeeds', (code) => {
    const { target } = fixture();
    let now = 0;
    let attempts = 0;
    const realRename: typeof renameSync = (source, destination) => {
      if (++attempts < 3) throw contention(code);
      return renameSync(source, destination);
    };
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      now: () => now,
      sleep: (milliseconds) => {
        now += milliseconds;
      },
      fs: { renameSync: realRename },
    });

    const result = writer.write(target, { version: code });

    expect(result.status).toBe('ok');
    expect(attempts).toBe(3);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ version: code });
  });

  it('returns busy after the shared deadline while preserving the old target and complete temp', () => {
    const { target } = fixture();
    let now = 0;
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      now: () => now,
      sleep: (milliseconds) => {
        now += milliseconds;
      },
      fs: {
        renameSync: () => {
          throw contention('EPERM');
        },
      },
    });

    const result = writer.write(target, { version: 'pending' });

    expect(result.status).toBe('busy');
    expect(result.elapsedMs).toBe(500);
    expect(readFileSync(target, 'utf8')).toBe('{"version":"old"}\n');
    expect(result.status === 'busy' && existsSync(result.tempPath!)).toBe(true);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it('removes an incomplete temp when fsync fails', () => {
    const { target } = fixture();
    let fsyncCalls = 0;
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      fs: {
        fsyncSync: () => {
          fsyncCalls++;
          if (fsyncCalls === 2) throw contention('ENOSPC');
        },
      },
    });

    const result = writer.write(target, { version: 'new' });

    expect(result).toMatchObject({
      status: 'unavailable',
      operation: 'fsync',
      errorCode: 'ENOSPC',
    });
    expect(readFileSync(target, 'utf8')).toBe('{"version":"old"}\n');
    expect(existsSync(`${target}.lock`)).toBe(false);
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['ENOSPC', 'EDQUOT', 'EROFS'])('returns unavailable for permanent %s errors', (code) => {
    const { target } = fixture();
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      fs: {
        renameSync: () => {
          throw contention(code);
        },
      },
    });

    const result = writer.write(target, { version: 'pending' });

    expect(result).toMatchObject({
      status: 'unavailable',
      operation: 'rename',
      errorCode: code,
    });
    expect(readFileSync(target, 'utf8')).toBe('{"version":"old"}\n');
  });

  it('creates unique temp names for writes in the same millisecond', () => {
    const { target } = fixture();
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      now: () => 0,
      deadlineMs: 0,
      fs: {
        renameSync: () => {
          throw contention('EPERM');
        },
      },
    });

    const first = writer.write(target, { revision: 1 });
    const second = writer.write(target, { revision: 2 });

    expect(first.status).toBe('busy');
    expect(second.status).toBe('busy');
    expect(first.status === 'busy' && second.status === 'busy' && first.tempPath).not.toBe(
      second.status === 'busy' ? second.tempPath : undefined,
    );
  });

  it('reclaims a verified stale lock but leaves a live lock alone until released', () => {
    const { target } = fixture();
    const lock = `${target}.lock`;
    writeFileSync(
      lock,
      JSON.stringify({
        schemaVersion: 1,
        instanceId: '22222222-2222-4222-8222-222222222222',
        pid: 22,
        hostname: 'test-host',
        createdAt: 0,
      }),
    );
    utimesSync(lock, new Date(0), new Date(0));
    const reclaimed = vi.fn();
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      now: () => 60_000,
      isLockOwnerAlive: () => false,
      onStaleLock: reclaimed,
    });

    expect(writer.write(target, { version: 'new' }).status).toBe('ok');
    expect(reclaimed).toHaveBeenCalledWith(target);
  });

  it('waits for a live lock and succeeds after the owner releases it', () => {
    const { target } = fixture();
    const lock = `${target}.lock`;
    writeFileSync(
      lock,
      JSON.stringify({
        schemaVersion: 1,
        instanceId: '22222222-2222-4222-8222-222222222222',
        pid: 22,
        hostname: 'test-host',
        createdAt: 0,
      }),
    );
    let now = 0;
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      now: () => now,
      isLockOwnerAlive: () => true,
      sleep: (milliseconds) => {
        now += milliseconds;
        if (now >= 15 && existsSync(lock)) rmSync(lock);
      },
    });

    expect(writer.write(target, { version: 'new' }).status).toBe('ok');
    expect(now).toBeGreaterThanOrEqual(15);
  });

  it('releases the lock before an awaited asynchronous write resolves', async () => {
    // The rename is what makes the target readable, and the lock it held is released after that
    // rename rather than before it — which a caller that awaits the write must not be able to see
    // between the two. A directory listing taken the moment the promise resolves is a listing of a
    // writer that has finished with it: the lock gone and no temp file left, on every path the
    // result can be produced by, not only the successful one sampled here.
    const { target } = fixture();
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
    });

    const result = await writer.writeAsync(target, { version: 'new' });

    expect(result.status).toBe('ok');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ version: 'new' });
    expect(readdirSync(directory)).toEqual(['record.json']);
  });

  it('returns attempts === 1 for an uncontended write and writeAsync', async () => {
    const { target } = fixture();
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
    });

    const syncResult = writer.write(target, { version: 'sync' });
    expect(syncResult.status).toBe('ok');
    expect(syncResult.attempts).toBe(1);

    const asyncResult = await writer.writeAsync(target, { version: 'async' });
    expect(asyncResult.status).toBe('ok');
    expect(asyncResult.attempts).toBe(1);
  });

  it('returns attempts === 2 when rename hits one contention error then succeeds', () => {
    const { target } = fixture();
    let renameCalls = 0;
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      fs: {
        renameSync: (source, destination) => {
          renameCalls++;
          if (renameCalls === 1) throw contention('EBUSY');
          return renameSync(source, destination);
        },
      },
    });

    const result = writer.write(target, { version: 'retried' });
    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(2);
    expect(renameCalls).toBe(2);
  });

  it('requests back-off ladder [10, 20] across two rename contentions after a clean lock', () => {
    const { target } = fixture();
    const requestedSleeps: number[] = [];
    let renameCalls = 0;
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      now: () => 0,
      sleep: (milliseconds) => {
        requestedSleeps.push(milliseconds);
      },
      fs: {
        renameSync: (source, destination) => {
          renameCalls++;
          if (renameCalls <= 2) throw contention('EBUSY');
          return renameSync(source, destination);
        },
      },
    });

    const result = writer.write(target, { version: 'retried' });
    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(3);
    expect(requestedSleeps).toEqual([10, 20]);
    expect(renameCalls).toBe(3);
  });

  it('requests back-off ladder [5] and reports attempts === 2 on one lock contention from a live owner', () => {
    const { target } = fixture();
    const lock = `${target}.lock`;
    writeFileSync(
      lock,
      JSON.stringify({
        schemaVersion: 1,
        instanceId: '22222222-2222-4222-8222-222222222222',
        pid: 22,
        hostname: 'test-host',
        createdAt: 0,
      }),
    );
    const requestedSleeps: number[] = [];
    let now = 0;
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      now: () => now,
      isLockOwnerAlive: () => true,
      sleep: (milliseconds) => {
        requestedSleeps.push(milliseconds);
        now += milliseconds;
        if (existsSync(lock)) rmSync(lock);
      },
    });

    const result = writer.write(target, { version: 'new' });
    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(2);
    expect(requestedSleeps).toEqual([5]);
  });

  it('returns attempts === 2 when writeAsync rename hits one contention error then succeeds', async () => {
    const { target } = fixture();
    let renameCalls = 0;
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      fsAsync: {
        rename: async (source, destination) => {
          renameCalls++;
          if (renameCalls === 1) throw contention('EBUSY');
          return renameAsync(source, destination);
        },
      },
    });

    const result = await writer.writeAsync(target, { version: 'retried' });
    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(2);
    expect(renameCalls).toBe(2);
  });

  it('reports attempts === 1 after reclaiming a stale lock for write and writeAsync', async () => {
    const { target } = fixture();
    const lock = `${target}.lock`;
    const makeStaleLock = () => {
      writeFileSync(
        lock,
        JSON.stringify({
          schemaVersion: 1,
          instanceId: '22222222-2222-4222-8222-222222222222',
          pid: 22,
          hostname: 'test-host',
          createdAt: 0,
        }),
      );
      utimesSync(lock, new Date(0), new Date(0));
    };

    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      now: () => 60_000,
      isLockOwnerAlive: () => false,
    });

    makeStaleLock();
    const syncResult = writer.write(target, { version: 'sync' });
    expect(syncResult.status).toBe('ok');
    expect(syncResult.attempts).toBe(1);

    makeStaleLock();
    const asyncResult = await writer.writeAsync(target, { version: 'async' });
    expect(asyncResult.status).toBe('ok');
    expect(asyncResult.attempts).toBe(1);
  });

  it('returns status cancelled and attempts === 2 when canCommit returns false on the second rename attempt', async () => {
    const { target } = fixture();
    let renameCalls = 0;
    let canCommitCalls = 0;
    const writer = new AtomicJsonWriter({
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 10,
      hostname: 'test-host',
      fsAsync: {
        rename: async (source, destination) => {
          renameCalls++;
          if (renameCalls === 1) throw contention('EBUSY');
          return renameAsync(source, destination);
        },
      },
    });

    const result = await writer.writeAsync(
      target,
      { version: 'cancelled' },
      {
        canCommit: () => {
          canCommitCalls++;
          return canCommitCalls === 1;
        },
      },
    );

    expect(result.status).toBe('cancelled');
    expect(result.attempts).toBe(2);
    expect(renameCalls).toBe(1);
  });
});
