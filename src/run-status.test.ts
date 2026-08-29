import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunStatusWriter,
  clearRunStatus,
  freeDiskBytes,
  readRunStatus,
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
