import { describe, expect, it, vi } from 'vitest';
import { ToolExecutionScheduler } from './execution-scheduler.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ToolExecutionScheduler', () => {
  it('enforces the configured concurrency cap', async () => {
    const scheduler = new ToolExecutionScheduler(2);
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    let started = 0;

    const tasks = Array.from({ length: 4 }, () =>
      scheduler.run(async () => {
        started++;
        active++;
        maxActive = Math.max(maxActive, active);
        await release.promise;
        active--;
      }),
    );

    await vi.waitFor(() => expect(started).toBe(2));
    expect(maxActive).toBe(2);
    release.resolve();
    await Promise.all(tasks);
    expect(maxActive).toBe(2);
  });

  it('starts queued work in FIFO order', async () => {
    const scheduler = new ToolExecutionScheduler(1);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const tasks = gates.map((gate, index) =>
      scheduler.run(async () => {
        started.push(index);
        await gate.promise;
      }),
    );

    await vi.waitFor(() => expect(started).toEqual([0]));
    gates[0].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    gates[1].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates[2].resolve();
    await Promise.all(tasks);
  });

  it('removes an aborted waiter without consuming a permit', async () => {
    const scheduler = new ToolExecutionScheduler(1);
    const firstGate = deferred();
    const first = scheduler.run(() => firstGate.promise);
    const controller = new AbortController();
    const cancelled = scheduler.run(async () => undefined, controller.signal);
    const third = vi.fn(async () => undefined);
    const final = scheduler.run(third);

    controller.abort('cancel queued work');
    await expect(cancelled).rejects.toThrow('cancel queued work');
    expect(third).not.toHaveBeenCalled();
    firstGate.resolve();
    await Promise.all([first, final]);
    expect(third).toHaveBeenCalledOnce();
  });
});
