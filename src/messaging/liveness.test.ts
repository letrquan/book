import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createLivenessProbe,
  isRecordProcessLive,
  parseProcStatStartTime,
  type LivenessProbe,
} from './liveness.js';

/** A `/proc/<pid>/stat` line with `comm` as the command name and `start` in field 22. */
function statLine(comm: string, start: string): string {
  // Fields 3..21, then 22 (starttime), then a few of the fields after it.
  const middle = ['S', '1', '100', '100', '0', '-1', '4194560', '1', '0', '0', '0', '5', '3'];
  const tail = ['0', '0', '20', '0', '1', '0'];
  return `4242 (${comm}) ${[...middle, ...tail, start, '12345', '678', '18446744073709551615'].join(' ')}`;
}

describe('parseProcStatStartTime', () => {
  it('reads field 22', () => {
    expect(parseProcStatStartTime(statLine('node', '987654'))).toBe('987654');
  });

  it('counts fields from the last parenthesis, so a command name with `) (` cannot shift them', () => {
    expect(parseProcStatStartTime(statLine('evil) (S 1 2 3', '555'))).toBe('555');
    expect(parseProcStatStartTime(statLine('a b c', '556'))).toBe('556');
    expect(parseProcStatStartTime(statLine(')', '557'))).toBe('557');
  });

  it('is undefined for a line that is not a stat line', () => {
    expect(parseProcStatStartTime('')).toBeUndefined();
    expect(parseProcStatStartTime('4242 node S 1')).toBeUndefined();
    expect(parseProcStatStartTime('4242 (node) S 1 2')).toBeUndefined();
    expect(parseProcStatStartTime(statLine('node', 'x1'))).toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'linux')('the Linux probe', () => {
  const probe = createLivenessProbe('linux');

  it("reads this process's start token from /proc", async () => {
    const expected = parseProcStatStartTime(readFileSync('/proc/self/stat', 'utf8'));
    expect(expected).toMatch(/^\d+$/);
    expect(await probe.startToken(process.pid)).toBe(expected);
  });

  it('has no token for a pid that does not exist', async () => {
    expect(await probe.startToken(2 ** 30)).toBeUndefined();
  });

  it('names the pid domain as linux:<machine id>:pid:[<inode>]', async () => {
    const domain = await probe.pidDomain();
    expect(domain).toMatch(/^linux:[^:]+:pid:\[\d+\]$/);
    expect(await probe.pidDomain()).toBe(domain);
  });
});

describe.skipIf(process.platform !== 'darwin')('the macOS probe', () => {
  it("reads this process's start time from ps", async () => {
    const probe = createLivenessProbe('darwin');
    expect(await probe.startToken(process.pid)).toMatch(/\d{4}$/);
    expect(await probe.startToken(2 ** 30)).toBeUndefined();
  });
});

describe('createLivenessProbe on a platform without start tokens', () => {
  it('judges by the pid alone and has no pid domain', async () => {
    const probe = createLivenessProbe('win32');
    expect(probe.isAlive(process.pid)).toBe(true);
    expect(await probe.startToken(process.pid)).toBeUndefined();
    expect(await probe.pidDomain()).toBeUndefined();
  });
});

describe('isRecordProcessLive', () => {
  function probe(alive: boolean, token: string | undefined): LivenessProbe {
    return {
      isAlive: () => alive,
      startToken: async () => token,
      pidDomain: async () => undefined,
    };
  }

  it('is live while the pid is alive and the start token matches', async () => {
    expect(await isRecordProcessLive({ pid: 7, procStart: '100' }, probe(true, '100'))).toBe(true);
  });

  it('is dead when the pid is gone', async () => {
    expect(await isRecordProcessLive({ pid: 7, procStart: '100' }, probe(false, '100'))).toBe(
      false,
    );
  });

  it('is dead when the pid was reused by a process that started later', async () => {
    expect(await isRecordProcessLive({ pid: 7, procStart: '100' }, probe(true, '200'))).toBe(false);
  });

  it('is judged by the pid when the record or the platform has no token', async () => {
    expect(await isRecordProcessLive({ pid: 7 }, probe(true, '200'))).toBe(true);
    expect(await isRecordProcessLive({ pid: 7, procStart: '100' }, probe(true, undefined))).toBe(
      true,
    );
  });
});
