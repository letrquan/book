import { describe, it, expect } from 'vitest';
import {
  decideContinuation,
  buildProgressWitness,
  witnessSignature,
  type ContinuationInput,
} from './continuation.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import type { AgentTask } from '../types/runtime.js';

const enabled = { ...DEFAULT_SETTINGS.continuation, enabled: true };

const witness = buildProgressWitness({
  todos: [],
  fileObservations: new Map(),
  toolCallCount: 0,
});

function input(overrides: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    settings: enabled,
    todos: [],
    tasks: [],
    consecutive: 0,
    priorWitnesses: [],
    witness,
    elapsedMs: 0,
    ...overrides,
  };
}

function task(id: string, status: AgentTask['status'], blockedBy: string[] = []): AgentTask {
  return {
    id,
    subject: `do ${id}`,
    status,
    blockedBy,
    blocks: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('decideContinuation — stopping', () => {
  it('stops when disabled, whatever is outstanding', () => {
    const decision = decideContinuation(
      input({
        settings: { ...enabled, enabled: false },
        todos: [{ content: 'unfinished', status: 'pending' }],
      }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'disabled' });
  });

  it('stops on every external end, outranking an unfinished plan', () => {
    // Each of these ended the turn for a reason that is not the model's to
    // revisit. Continuing would override a cancel, an approved handoff, a spent
    // budget, or a policy refusal.
    for (const flag of [
      'aborted',
      'handoffRequested',
      'planStopRequested',
      'budgetExhausted',
      'policyBlocked',
    ] as const) {
      const decision = decideContinuation(
        input({ todos: [{ content: 'unfinished', status: 'pending' }], [flag]: true }),
      );
      expect(decision, flag).toEqual({ kind: 'stop', reason: 'external' });
    }
  });

  it('stops at the consecutive limit', () => {
    const decision = decideContinuation(
      input({
        todos: [{ content: 'unfinished', status: 'pending' }],
        consecutive: enabled.maxConsecutive,
      }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'continuation_limit' });
  });

  it('stops at the wall-clock ceiling when one is set', () => {
    const decision = decideContinuation(
      input({
        settings: { ...enabled, maxWallClockMs: 1_000 },
        todos: [{ content: 'unfinished', status: 'pending' }],
        elapsedMs: 1_000,
      }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'wall_clock' });
  });

  it('treats 0 as no wall-clock ceiling', () => {
    const decision = decideContinuation(
      input({
        todos: [{ content: 'unfinished', status: 'pending' }],
        elapsedMs: Number.MAX_SAFE_INTEGER,
      }),
    );
    expect(decision.kind).toBe('continue');
  });

  it('stops when the objective is genuinely done', () => {
    const decision = decideContinuation(
      input({
        todos: [{ content: 'done', status: 'completed' }],
        tasks: [task('t1', 'completed')],
      }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'objective_complete' });
  });
});

describe('decideContinuation — the no-progress brake', () => {
  const signature = witnessSignature(witness);

  it('stops after the configured run of identical witnesses', () => {
    const decision = decideContinuation(
      input({
        todos: [{ content: 'unfinished', status: 'pending' }],
        priorWitnesses: [signature, signature, signature],
      }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'no_progress' });
  });

  it('keeps going while just under the limit', () => {
    const decision = decideContinuation(
      input({
        todos: [{ content: 'unfinished', status: 'pending' }],
        priorWitnesses: [signature, signature],
      }),
    );
    expect(decision.kind).toBe('continue');
  });

  it('counts only the trailing run, so intermittent progress resets it', () => {
    // A model that edits a file every third turn is working, not spinning.
    const decision = decideContinuation(
      input({
        todos: [{ content: 'unfinished', status: 'pending' }],
        priorWitnesses: [signature, signature, signature, 'different', signature],
      }),
    );
    expect(decision.kind).toBe('continue');
  });

  it('notices a changed file even when the todo list is identical', () => {
    const before = buildProgressWitness({
      todos: [{ content: 'x', status: 'pending' }],
      fileObservations: new Map([['a.ts', { sha256: 'aaa' }]]),
      toolCallCount: 5,
    });
    const after = buildProgressWitness({
      todos: [{ content: 'x', status: 'pending' }],
      fileObservations: new Map([['a.ts', { sha256: 'bbb' }]]),
      toolCallCount: 5,
    });
    expect(witnessSignature(before)).not.toBe(witnessSignature(after));
  });

  it('is insensitive to file iteration order', () => {
    const one = buildProgressWitness({
      todos: [],
      fileObservations: new Map([
        ['a.ts', { sha256: '1' }],
        ['b.ts', { sha256: '2' }],
      ]),
      toolCallCount: 0,
    });
    const two = buildProgressWitness({
      todos: [],
      fileObservations: new Map([
        ['b.ts', { sha256: '2' }],
        ['a.ts', { sha256: '1' }],
      ]),
      toolCallCount: 0,
    });
    expect(witnessSignature(one)).toBe(witnessSignature(two));
  });
});

describe('decideContinuation — continuing', () => {
  it('continues on an unfinished todo and names it', () => {
    const decision = decideContinuation(
      input({
        todos: [
          { content: 'migrate call sites', status: 'pending' },
          { content: 'already done', status: 'completed' },
        ],
      }),
    );
    expect(decision.kind).toBe('continue');
    if (decision.kind !== 'continue') return;
    expect(decision.trigger).toBe('todos');
    expect(decision.prompt).toContain('migrate call sites');
    expect(decision.prompt).not.toContain('already done');
  });

  it('continues on an actionable task when no todos remain', () => {
    const decision = decideContinuation(input({ tasks: [task('t1', 'pending')] }));
    expect(decision.kind).toBe('continue');
    if (decision.kind !== 'continue') return;
    expect(decision.trigger).toBe('tasks');
    expect(decision.prompt).toContain('do t1');
  });

  it('does not continue for a task blocked by unfinished work', () => {
    // Nothing it could legally do next, so keeping the run alive would spin.
    const decision = decideContinuation(
      input({ tasks: [task('t1', 'pending'), task('t2', 'pending', ['t1'])] }),
    );
    expect(decision.kind).toBe('continue');
    if (decision.kind !== 'continue') return;
    expect(decision.prompt).toContain('do t1');
    expect(decision.prompt).not.toContain('do t2');
  });

  it('continues while at least one open task is unblocked', () => {
    const decision = decideContinuation(
      input({ tasks: [task('t1', 'in_progress', ['ghost']), task('ghost', 'pending')] }),
    );
    // t1 is blocked by ghost, but ghost itself is actionable.
    expect(decision.kind).toBe('continue');
  });

  it('reports blocked_plan, not completion, when every open task is blocked', () => {
    // A cycle, or a blocker the model abandoned. Falling through to
    // objective_complete here would log success for a stalled plan.
    const decision = decideContinuation(
      input({ tasks: [task('t1', 'pending', ['t2']), task('t2', 'pending', ['t1'])] }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'blocked_plan' });
  });

  it('ignores deleted tasks', () => {
    const decision = decideContinuation(input({ tasks: [task('t1', 'deleted')] }));
    expect(decision).toEqual({ kind: 'stop', reason: 'objective_complete' });
  });
});
