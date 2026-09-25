import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestClock } from '../clock.js';
import { renameWithContentionRetry, writeJsonAtomic } from './persistent-store.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation failed, rename`), { code });
}

/** A clock that moves only when the retry loop sleeps, so every budget is exact. */
function sleepingClock() {
  const clock = createTestClock();
  const sleeps: number[] = [];
  return {
    clock,
    sleeps,
    sleep: (milliseconds: number) => {
      sleeps.push(milliseconds);
      clock.advanceMonotonic(milliseconds);
    },
  };
}

describe('renameWithContentionRetry', () => {
  it('retries a Windows rename while the target is in use, then succeeds', () => {
    const time = sleepingClock();
    const failures = ['EPERM', 'EACCES', 'EBUSY'];
    let calls = 0;

    renameWithContentionRetry('from', 'to', {
      platform: 'win32',
      budgetMs: 1_000,
      clock: time.clock,
      sleep: time.sleep,
      rename: () => {
        calls += 1;
        const code = failures[calls - 1];
        if (code) throw errnoError(code);
      },
    });

    expect(calls).toBe(4);
    expect(time.sleeps).toEqual([10, 10, 10]);
  });

  it('rethrows the contention error once the budget is spent', () => {
    const time = sleepingClock();
    let calls = 0;

    expect(() =>
      renameWithContentionRetry('from', 'to', {
        platform: 'win32',
        budgetMs: 100,
        clock: time.clock,
        sleep: time.sleep,
        rename: () => {
          calls += 1;
          throw errnoError('EPERM');
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'EPERM' }));

    expect(time.sleeps.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(100);
    expect(calls).toBe(11);
  });

  it('rethrows any other error on the first attempt', () => {
    const time = sleepingClock();
    let calls = 0;

    expect(() =>
      renameWithContentionRetry('from', 'to', {
        platform: 'win32',
        budgetMs: 1_000,
        clock: time.clock,
        sleep: time.sleep,
        rename: () => {
          calls += 1;
          throw errnoError('ENOENT');
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'ENOENT' }));

    expect(calls).toBe(1);
    expect(time.sleeps).toEqual([]);
  });

  it('does not retry off Windows, where a reader cannot fail a rename', () => {
    const time = sleepingClock();
    let calls = 0;

    expect(() =>
      renameWithContentionRetry('from', 'to', {
        platform: 'linux',
        budgetMs: 1_000,
        clock: time.clock,
        sleep: time.sleep,
        rename: () => {
          calls += 1;
          throw errnoError('EPERM');
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'EPERM' }));

    expect(calls).toBe(1);
    expect(time.sleeps).toEqual([]);
  });
});

describe('writeJsonAtomic', () => {
  it('leaves no temp file beside the target when the rename fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'book-persistent-store-'));
    temporaryRoots.push(directory);
    // A non-empty directory where the record belongs fails the rename on every platform.
    const target = join(directory, 'record.json');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');

    expect(() => writeJsonAtomic(target, { status: 'running' })).toThrow();

    expect(readdirSync(directory)).toEqual(['record.json']);
  });
});
