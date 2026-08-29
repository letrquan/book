import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from './store.js';
import { resolveSessionBootstrap } from './resolve.js';
import { normalizePersistedTodos } from '../tools/todo.js';
import { renderSessionState } from '../agent/session-state.js';
import { SessionRuntime } from './runtime.js';
import { RunAccounting } from './run-accounting.js';
import type { PlanRecordData, SessionRecord } from '../types/sessions.js';
import type { AgentTask } from '../types/runtime.js';

const dirs: string[] = [];

function store(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'book-plan-'));
  dirs.push(dir);
  return new SessionStore(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function planRecord(data: PlanRecordData): SessionRecord {
  return { type: 'plan', timestamp: Date.now(), data };
}

describe('plan persistence across a restart', () => {
  it('restores the newest plan record, not the first', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });

    s.append(id, planRecord({ version: 1, todos: [{ content: 'draft', status: 'pending' }] }));
    s.append(
      id,
      planRecord({
        version: 1,
        todos: [
          { content: 'draft', status: 'completed' },
          { content: 'ship', status: 'in_progress', activeForm: 'Shipping' },
        ],
      }),
    );

    // Each write is a whole-plan snapshot, so replaying to the end must yield the
    // newest one rather than merging or keeping the earliest.
    expect(s.load(id).plan?.todos).toEqual([
      { content: 'draft', status: 'completed' },
      { content: 'ship', status: 'in_progress', activeForm: 'Shipping' },
    ]);
  });

  it('carries the task graph, including dependency edges', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    const tasks = [
      { id: 't1', title: 'migrate', status: 'in_progress' },
      { id: 't2', title: 'verify', status: 'pending', blockedBy: ['t1'] },
    ] as unknown as AgentTask[];

    s.append(id, planRecord({ version: 1, tasks }));

    expect(s.load(id).plan?.tasks).toEqual(tasks);
  });

  it('reaches a resumed session through resolveSession', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, planRecord({ version: 1, todos: [{ content: 'keep me', status: 'pending' }] }));

    const bootstrap = resolveSessionBootstrap(s, { cwd: process.cwd(), sessionId: id });

    expect(bootstrap.plan?.todos).toEqual([{ content: 'keep me', status: 'pending' }]);
  });

  it('leaves plan undefined for a session that never wrote one', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });

    // Absent is meaningfully different from empty: it is what lets a resumed run
    // tell "no plan yet" from "the plan did not survive the restart".
    expect(s.load(id).plan).toBeUndefined();
  });

  it('ignores a malformed record rather than clearing a good one', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, planRecord({ version: 1, todos: [{ content: 'good', status: 'pending' }] }));
    s.append(id, { type: 'plan', timestamp: Date.now(), data: { version: 99 } });

    expect(s.load(id).plan?.todos).toEqual([{ content: 'good', status: 'pending' }]);
  });

  it('survives a fork', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, planRecord({ version: 1, todos: [{ content: 'forked', status: 'pending' }] }));

    const forked = s.fork(id, { cwd: process.cwd() });

    expect(s.load(forked).plan?.todos).toEqual([{ content: 'forked', status: 'pending' }]);
  });
});

describe('normalizePersistedTodos', () => {
  it('drops malformed entries without losing the rest of the plan', () => {
    const restored = normalizePersistedTodos([
      { content: 'valid', status: 'pending' },
      { content: '', status: 'pending' },
      { content: 'bad status', status: 'archived' },
      { content: 'also valid', status: 'completed', activeForm: 42 },
    ]);

    expect(restored).toEqual([
      { content: 'valid', status: 'pending', activeForm: undefined },
      { content: 'also valid', status: 'completed', activeForm: undefined },
    ]);
  });

  it('returns an empty list for absent input', () => {
    expect(normalizePersistedTodos(undefined)).toEqual([]);
  });
});

describe('SessionRuntime todo ownership', () => {
  it('exposes a mutable array a tool can seed and update in place', () => {
    // The binding is readonly but the array is not: TodoWrite mutates it in place
    // so the runtime, the session-state render, and the persistence writer all
    // observe one list. Reassignment would silently fork them.
    const runtime = new SessionRuntime({ todos: [{ content: 'seeded', status: 'pending' }] });
    expect(runtime.todos).toHaveLength(1);

    const bound = runtime.todos;
    bound.length = 0;
    bound.push({ content: 'replaced', status: 'in_progress' });

    expect(runtime.todos).toEqual([{ content: 'replaced', status: 'in_progress' }]);
  });
});

describe('plan-lost diagnostic', () => {
  it('says so when a resumed session has prior work but no plan', () => {
    const rendered = renderSessionState({ workspace: '/w', planUnrestored: true });
    expect(rendered).toContain('No task list was restored');
  });

  it('stays quiet once a plan is present', () => {
    const rendered = renderSessionState({
      workspace: '/w',
      planUnrestored: true,
      todos: [{ content: 'restored', status: 'pending' }],
    });
    expect(rendered).not.toContain('No task list was restored');
    expect(rendered).toContain('restored');
  });

  it('stays quiet on a fresh session', () => {
    expect(renderSessionState({ workspace: '/w' })).not.toContain('No task list was restored');
  });
});

describe('carried spend across a restart', () => {
  it('sums usage records so a budget bounds the objective, not the process', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    for (const promptTokens of [1_000, 2_000, 3_000]) {
      s.append(id, {
        type: 'usage',
        timestamp: Date.now(),
        data: {
          version: 1,
          usage: {
            promptTokens,
            completionTokens: 100,
            totalTokens: promptTokens + 100,
            cacheReadInputTokens: 500,
          },
          responseModel: 'claude-sonnet-5',
        },
      });
    }

    const loaded = s.load(id);
    expect(loaded.carriedUsage).toMatchObject({
      promptTokens: 6_000,
      completionTokens: 300,
      cacheReadInputTokens: 1_500,
    });
    expect(loaded.carriedModels).toEqual(['claude-sonnet-5']);
  });

  it('leaves carried usage undefined for a session that spent nothing', () => {
    const s = store();
    expect(s.load(s.create({ cwd: process.cwd() })).carriedUsage).toBeUndefined();
  });

  it('seeds the budget so a restart cannot reset the cap', () => {
    const accounting = new RunAccounting();
    const context = {
      runId: 'run-1',
      rootRunId: 'root-1',
      source: 'user' as const,
      startedAt: 0,
    } as unknown as Parameters<RunAccounting['startRoot']>[0];

    accounting.startRoot(context, 1);
    accounting.seedRoot('root-1', {
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      costUsd: 0.99,
    });

    expect(accounting.snapshotRoot('root-1')).toMatchObject({ costUsd: 0.99 });
    expect(accounting.checkBeforeModelCall('root-1', 'claude-sonnet-5')).toMatchObject({
      allowed: true,
    });

    // One more real charge crosses the restored floor.
    accounting.record(
      context,
      { promptTokens: 10_000, completionTokens: 1_000, totalTokens: 11_000 },
      { provider: 'anthropic', requestedModel: 'claude-sonnet-5' },
    );
    expect(accounting.checkBeforeModelCall('root-1', 'claude-sonnet-5')).toMatchObject({
      allowed: false,
      status: 'exceeded',
    });
  });

  it('refuses to treat an unpriceable restored total as zero spend', () => {
    // This used to report `estimated`, which the budget gate permits — while
    // `makeSnapshot`'s `carried?.costUsd ?? 0` turned the unknown amount into a $0
    // baseline. Together they re-armed the cap from zero on every restart and every
    // submitted prompt, so N restarts authorised N x the budget: precisely the
    // failure the objective-scoped carry exists to prevent. "We know spend happened
    // but not how much" has to fail closed, and only ever bites a run that actually
    // asked for a ceiling — `checkBeforeModelCall` returns early without one.
    const accounting = new RunAccounting();
    accounting.seedRoot('root-2', { usage: null, costUsd: null });
    expect(accounting.snapshotRoot('root-2')).toMatchObject({ costStatus: 'unknown' });
  });
});
