import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunStatusWriter,
  cleanupRunStatus,
  clearRunStatus,
  freeDiskBytes,
  readRunStatus,
  runStatusDir,
  runStatusPath,
} from './run-status.js';

const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-status-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writer(dir: string, budgetUsd?: number): RunStatusWriter {
  return new RunStatusWriter({
    sessionId: 'session-1',
    runId: 'run-1',
    workspace: dir,
    budgetUsd,
    startedAt: 1_000,
    home: dir,
  });
}

describe('the run status file', () => {
  it('exists as soon as the run starts, not only when it ends', () => {
    // The gap this closes: with the default `--output-format text` headless writes
    // nothing at all until termination, so an unattended run is opaque for its
    // entire life. The only other on-disk signal is the transcript's mtime, which
    // advances identically for a healthy run and a wedged one.
    const dir = home();
    const w = writer(dir, 50);
    const record = readRunStatus('session-1', dir);
    expect(record).toMatchObject({ sessionId: 'session-1', turn: 0, budgetUsd: 50 });
    expect(record?.pid).toBe(process.pid);
    expect(w.snapshot().startedAt).toBe(1_000);
  });

  it('carries what a supervisor needs to decide whether a run is stuck', () => {
    const dir = home();
    const w = writer(dir);
    w.update(
      {
        turn: 7,
        lastTool: 'Bash',
        currentTodo: 'migrate the call sites',
        openTodos: 3,
        costUsd: 1.25,
      },
      5_000,
    );
    expect(readRunStatus('session-1', dir)).toMatchObject({
      turn: 7,
      lastTool: 'Bash',
      currentTodo: 'migrate the call sites',
      openTodos: 3,
      costUsd: 1.25,
      elapsedMs: 4_000,
    });
  });

  it('distinguishes a finished run from a dead one', () => {
    const dir = home();
    const w = writer(dir);
    w.update({ turn: 2, openTodos: 0, costUsd: 0.5 }, 3_000);
    w.update(
      {
        turn: 2,
        openTodos: 0,
        costUsd: 0.5,
        terminal: { status: 'completed', reason: 'objective_complete' },
      },
      4_000,
    );
    const finished = readRunStatus('session-1', dir);
    expect(finished?.terminal).toMatchObject({ reason: 'objective_complete' });
    expect(finished?.crash).toBeUndefined();

    // A crash after a clean terminal is not a crash.
    w.recordCrash('boom', 5_000);
    expect(readRunStatus('session-1', dir)?.crash).toBeUndefined();
  });

  it('leaves a record when the process dies without a terminal outcome', () => {
    // When a long run dies today, nothing durable says why: no crash file, no
    // terminal outcome, and a stack trace on a stderr the operator may have
    // redirected days ago.
    const dir = home();
    const w = writer(dir);
    w.update({ turn: 11, openTodos: 2, costUsd: 3 }, 9_000);
    w.recordCrash('ECONNRESET', 10_000);
    const record = readRunStatus('session-1', dir);
    expect(record?.crash).toMatchObject({ message: 'ECONNRESET', at: 10_000 });
    // The last known position survives, so the crash is diagnosable.
    expect(record).toMatchObject({ turn: 11, openTodos: 2 });
  });

  it('never lets a reader see a torn record', () => {
    // Written to a temp file and renamed. A reader either sees the previous
    // record or this one, never half of either.
    const dir = home();
    const w = writer(dir);
    for (let i = 1; i <= 40; i++) {
      w.update({ turn: i, openTodos: 1, costUsd: i / 100 }, 1_000 + i);
      const parsed = readRunStatus('session-1', dir);
      expect(parsed?.turn).toBe(i);
    }
  });

  it('survives an unreadable or corrupt file rather than taking the run down', () => {
    const dir = home();
    writer(dir);
    writeFileSync(runStatusPath('session-1', dir), '{ not json');
    expect(readRunStatus('session-1', dir)).toBeUndefined();
    expect(readRunStatus('no-such-session', dir)).toBeUndefined();
    clearRunStatus('session-1', dir);
    expect(readRunStatus('session-1', dir)).toBeUndefined();
  });

  it('reports free disk space, which nothing else in the codebase could', () => {
    // M4's escalation set names "disk below floor" as an alarm, and there was no
    // primitive anywhere to build that sensor on: at least six audit findings end
    // at "the failure lands as ENOSPC" and every one of those writers is
    // synchronous on the main thread.
    const free = freeDiskBytes(home());
    if (free !== undefined) {
      expect(free).toBeGreaterThan(0);
      expect(Number.isFinite(free)).toBe(true);
    }
    // Never throws, whatever the platform reports.
    expect(() => freeDiskBytes(join(home(), 'definitely', 'missing'))).not.toThrow();
  });

  it('keeps the file bounded no matter how long the run goes', () => {
    // Deliberately a rewritten record rather than an append-only log: this is a
    // week-long run's status file, and the point of the audit item is that
    // nothing on disk should grow without bound.
    const dir = home();
    const w = writer(dir);
    for (let i = 0; i < 500; i++) {
      w.update({ turn: i, lastTool: 'Read', openTodos: 4, costUsd: i }, 2_000 + i);
    }
    const bytes = readFileSync(runStatusPath('session-1', dir), 'utf8').length;
    expect(bytes).toBeLessThan(2_000);
  });
});

describe('run record retention (#422)', () => {
  const DAY = 86_400_000;

  it('removes the records last written before the cutoff, and only those', () => {
    const dir = home();
    const now = Date.now();
    const written = (sessionId: string, ageDays: number) => {
      const w = new RunStatusWriter({
        sessionId,
        runId: sessionId,
        workspace: dir,
        startedAt: 1,
        home: dir,
      });
      // Finished runs: age alone decides, whatever pid the record carries.
      w.update(
        {
          turn: 1,
          openTodos: 0,
          costUsd: 0,
          terminal: { status: 'completed', reason: 'normal_completion' },
        },
        2,
      );
      const at = new Date(now - ageDays * DAY);
      utimesSync(runStatusPath(sessionId, dir), at, at);
    };
    written('stale', 31);
    written('older', 400);
    written('recent', 29);

    expect(cleanupRunStatus(30, dir, now)).toBe(2);
    expect(existsSync(runStatusPath('stale', dir))).toBe(false);
    expect(existsSync(runStatusPath('older', dir))).toBe(false);
    expect(readRunStatus('recent', dir)?.sessionId).toBe('recent');
  });

  it('keeps a record its run is still writing, however old the run', () => {
    const dir = home();
    const w = writer(dir);
    w.update({ turn: 1, openTodos: 0, costUsd: 0 }, 1_000 + 90 * DAY);
    expect(cleanupRunStatus(30, dir)).toBe(0);
    expect(readRunStatus('session-1', dir)?.turn).toBe(1);
  });

  const old = (path: string, ageDays = 31) => {
    const at = new Date(Date.now() - ageDays * DAY);
    utimesSync(path, at, at);
  };
  const record = (dir: string, name: string, body: unknown): string => {
    mkdirSync(runStatusDir(dir), { recursive: true });
    const path = join(runStatusDir(dir), name);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    old(path);
    return path;
  };
  const deadPid = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', '']);
      const pid = child.pid;
      child.on('error', reject);
      child.on('exit', () => resolve(pid as number));
    });

  it('keeps an old record whose run is still alive and has not finished', () => {
    const dir = home();
    const path = record(dir, 'live.json', { version: 1, pid: process.pid });
    expect(cleanupRunStatus(30, dir)).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('removes an old record whose process is dead', async () => {
    const dir = home();
    const path = record(dir, 'dead.json', { version: 1, pid: await deadPid() });
    expect(cleanupRunStatus(30, dir)).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('removes an old record with a live pid once it has a terminal or crash outcome', () => {
    const dir = home();
    const done = record(dir, 'done.json', {
      version: 1,
      pid: process.pid,
      terminal: { status: 'completed', reason: 'normal_completion' },
    });
    const crashed = record(dir, 'crashed.json', {
      version: 1,
      pid: process.pid,
      crash: { message: 'boom', at: 1 },
    });
    expect(cleanupRunStatus(30, dir)).toBe(2);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(crashed)).toBe(false);
  });

  it('removes an old record that does not parse or has no usable pid', () => {
    const dir = home();
    const paths = [
      record(dir, 'torn.json', '{"pid": '),
      record(dir, 'nopid.json', { version: 1 }),
      record(dir, 'zero.json', { version: 1, pid: 0 }),
      record(dir, 'negative.json', { version: 1, pid: -1 }),
      record(dir, 'fraction.json', { version: 1, pid: 1.5 }),
      record(dir, 'text.json', { version: 1, pid: String(process.pid) }),
    ];
    expect(cleanupRunStatus(30, dir)).toBe(paths.length);
    for (const path of paths) expect(existsSync(path)).toBe(false);
  });

  it('sweeps only run-record files, and one bad entry does not stop the rest', () => {
    const dir = home();
    const runs = runStatusDir(dir);
    const notes = record(dir, 'notes.txt', 'keep me');
    const subdir = join(runs, 'nested.json');
    mkdirSync(subdir);
    old(subdir);
    // Leftover of an interrupted atomic write: `<target>.<pid>.tmp`.
    const temp = record(dir, 'session-1.json.4242.tmp', '{');
    const stale = record(dir, 'stale.json', { version: 1, pid: 0 });

    expect(cleanupRunStatus(30, dir)).toBe(2);
    expect(existsSync(notes)).toBe(true);
    expect(existsSync(subdir)).toBe(true);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(stale)).toBe(false);
  });

  it('is a no-op when no run has ever written a record', () => {
    expect(cleanupRunStatus(30, home())).toBe(0);
    expect(cleanupRunStatus(30, join(home(), 'missing'))).toBe(0);
  });
});
