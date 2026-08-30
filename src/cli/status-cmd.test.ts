import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../session/store.js';
import {
  buildRunStatus,
  buildSessionStatus,
  renderSessionStatus,
  runStatusCommand,
} from './status-cmd.js';
import { RUN_STATUS_VERSION, writeRunStatus, type RunStatusRecord } from '../run-status.js';
import type { LoadedSession, SessionMeta, SessionRecord } from '../types/sessions.js';

const dirs: string[] = [];

function store(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'book-status-'));
  dirs.push(dir);
  return new SessionStore(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userRecord(content: string, kind = 'conversation'): SessionRecord {
  return {
    type: 'user',
    eventId: `u-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    data: { content, kind, includeInContext: true },
  };
}

function capture(): { write: (t: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { write: (t) => void chunks.push(t), text: () => chunks.join('') };
}

describe('book status', () => {
  it('reports the byte-exact original objective, not a summary', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('migrate every call site off framework X'));
    s.append(id, {
      type: 'assistant',
      eventId: 'a-1',
      timestamp: Date.now(),
      data: { id: 'a-1', complete: true, content: 'working' },
    });

    const status = buildSessionStatus(s.findById(id)!, s.load(id));
    expect(status.objective).toBe('migrate every call site off framework X');
  });

  it('ignores host-authored user turns when identifying the objective', () => {
    // Continuation and work-state messages are user-role but nobody asked for
    // them; treating one as the objective would misreport what the run is doing.
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('[continuation] You stopped without finishing.'));
    s.append(id, userRecord('[work-state] Current plan, restated by the host.'));
    s.append(id, userRecord('the real objective'));

    expect(buildSessionStatus(s.findById(id)!, s.load(id)).objective).toBe('the real objective');
  });

  it('sums spend across the session and prices it as an upper bound', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('do the work'));
    for (const promptTokens of [1_000, 2_000]) {
      s.append(id, {
        type: 'usage',
        timestamp: Date.now(),
        data: {
          version: 1,
          usage: { promptTokens, completionTokens: 100, totalTokens: promptTokens + 100 },
          responseModel: 'claude-sonnet-5',
        },
      });
    }

    const status = buildSessionStatus(s.findById(id)!, s.load(id));
    expect(status.usage).toMatchObject({ promptTokens: 3_000, completionTokens: 200 });
    // (3000*3 + 200*15) / 1e6
    expect(status.costUsd).toBeCloseTo(0.012, 6);
  });

  it('says so rather than guessing when a model cannot be priced', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, {
      type: 'usage',
      timestamp: Date.now(),
      data: {
        version: 1,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        responseModel: 'some-local-model',
      },
    });

    const status = buildSessionStatus(s.findById(id)!, s.load(id));
    expect(status.costUsd).toBeNull();
    expect(renderSessionStatus(status)).toContain('pricing unknown');
  });

  it('reports the restored plan and the compaction generation', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('long job'));
    s.append(id, {
      type: 'plan',
      timestamp: Date.now(),
      data: {
        version: 1,
        todos: [
          { content: 'done bit', status: 'completed' },
          { content: 'open bit', status: 'in_progress' },
        ],
      },
    });

    const status = buildSessionStatus(s.findById(id)!, s.load(id));
    expect(status.plan?.todos).toHaveLength(2);

    const rendered = renderSessionStatus(status);
    expect(rendered).toContain('1 open todo(s)');
    expect(rendered).toContain('open bit');
    expect(rendered).not.toContain('done bit');
    expect(rendered).toContain('never compacted');
  });

  it('exits non-zero and explains when no session matches', () => {
    const out = capture();
    const code = runStatusCommand({
      workspace: join(tmpdir(), 'book-status-empty'),
      store: store(),
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('No session has run');
  });

  it('emits machine-readable JSON on request', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('an objective'));

    const out = capture();
    const code = runStatusCommand({
      session: id,
      workspace: process.cwd(),
      json: true,
      store: s,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toMatchObject({ sessionId: id, objective: 'an objective' });
  });
});

/**
 * The liveness half. `src/run-status.ts` wrote a per-turn record to
 * `<BOOK_HOME>/runs/<session-id>.json` that nothing read, so a print run that
 * finished the work and one that died at turn 16 were indistinguishable from
 * outside — 32 such records on disk with no way to view them.
 */
describe('book status run record', () => {
  function record(overrides: Partial<RunStatusRecord> = {}): RunStatusRecord {
    return {
      version: RUN_STATUS_VERSION,
      sessionId: 'sess',
      runId: 'run-1',
      pid: process.pid,
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      turn: 16,
      elapsedMs: 224_000,
      openTodos: 2,
      costUsd: 1.25,
      ...overrides,
    } as RunStatusRecord;
  }

  it('reports a live process as running, on the turn it reached', () => {
    // process.pid is alive by definition, which is what makes this assertable.
    const status = buildRunStatus(record({ lastTool: 'Edit', currentTodo: 'wire the loader' }));

    expect(status.liveness).toBe('running');
    expect(status.processAlive).toBe(true);
    expect(status.turn).toBe(16);
    expect(status.lastTool).toBe('Edit');
  });

  it('distinguishes a clean finish from a death with no outcome', () => {
    const finished = buildRunStatus(
      record({ terminal: { status: 'completed', reason: 'objective_complete' } }),
    );
    expect(finished.liveness).toBe('completed');

    // A pid that cannot exist: no outcome and no process is the case the record
    // exists for, and the one that used to look identical to silence.
    const dead = buildRunStatus(record({ pid: 2 ** 31 - 1 }));
    expect(dead.liveness).toBe('died');
    expect(dead.processAlive).toBe(false);
  });

  it('reports a crash separately from a terminal outcome', () => {
    const status = buildRunStatus(
      record({ pid: 2 ** 31 - 1, crash: { message: 'socket hang up', at: Date.now() } }),
    );

    expect(status.liveness).toBe('crashed');
  });

  it('renders the stall the issue was filed about', () => {
    const now = Date.now();
    const status = buildSessionStatus(
      { id: 'sess', cwd: '/w', createdAt: now, updatedAt: now } as SessionMeta,
      { transcript: [], contextHistory: [], compactBoundaries: [] } as unknown as LoadedSession,
      record({
        terminal: {
          status: 'timed_out',
          reason: 'stream_stall',
          message: 'Stream stalled: no data received for 20000ms',
        },
      }),
    );

    const output = renderSessionStatus(status, now);
    expect(output).toContain('Run: finished — timed_out (stream_stall)');
    expect(output).toContain('Stream stalled: no data received for 20000ms');
    expect(output).toContain('turn 16');
  });

  it('names a live process that has stopped reaching turn boundaries', () => {
    const now = Date.now();
    const status = buildSessionStatus(
      { id: 'sess', cwd: '/w', createdAt: now, updatedAt: now } as SessionMeta,
      { transcript: [], contextHistory: [], compactBoundaries: [] } as unknown as LoadedSession,
      record({ updatedAt: now - 60 * 60_000 }),
    );

    // Alive but silent for an hour is the wedged case: the transcript mtime
    // advances the same way for a healthy run and one stuck on a prompt.
    expect(renderSessionStatus(status, now)).toContain('may be wedged');
  });

  it('says nothing about a run when no session ever wrote a record', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('do the thing'));

    const status = buildSessionStatus(s.findById(id)!, s.load(id));

    expect(status.run).toBeUndefined();
    expect(renderSessionStatus(status)).not.toContain('Run:');
  });

  it('reads the record from BOOK_HOME through the command itself', () => {
    const home = mkdtempSync(join(tmpdir(), 'book-status-home-'));
    dirs.push(home);
    const s = new SessionStore(join(home, 'sessions'));
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('do the thing'));
    writeRunStatus({ ...record({ sessionId: id }), sessionId: id }, home);

    const out = capture();
    const code = runStatusCommand({ workspace: process.cwd(), store: s, home, stdout: out });

    expect(code).toBe(0);
    expect(out.text()).toContain('Run: running');
    expect(out.text()).toContain('turn 16');
  });

  it('carries the record into --json for a supervisor script', () => {
    const home = mkdtempSync(join(tmpdir(), 'book-status-home-'));
    dirs.push(home);
    const s = new SessionStore(join(home, 'sessions'));
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('do the thing'));
    writeRunStatus({ ...record({ sessionId: id }), sessionId: id }, home);

    const out = capture();
    runStatusCommand({ workspace: process.cwd(), store: s, home, json: true, stdout: out });

    const parsed = JSON.parse(out.text());
    expect(parsed.run).toMatchObject({ liveness: 'running', turn: 16, pid: process.pid });
  });
});
