import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from './runtime.js';

describe('SessionRuntime', () => {
  it('isolates mutable state between sessions', () => {
    const first = new SessionRuntime();
    const second = new SessionRuntime();

    first.tasks.push({
      id: '1',
      subject: 'first',
      description: '',
      activeForm: 'working',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      createdAt: 1,
      updatedAt: 1,
    });
    first.fileObservationLedger.set('workspace:file', {
      path: 'file',
      workspaceId: 'workspace',
      sha256: 'hash',
      byteSize: 1,
      operation: 'mention',
      sourceRef: 'user-1',
      timestamp: 1,
    });

    expect(second.tasks).toEqual([]);
    expect(second.fileObservationLedger.size).toBe(0);
    expect(second.traceId).not.toBe(first.traceId);
  });

  it('disposes registered controllers, timers, children, and background shells once', () => {
    vi.useFakeTimers();
    try {
      const runtime = new SessionRuntime();
      const controller = runtime.trackAbortController(new AbortController());
      const timer = runtime.trackTimer(setTimeout(() => {}, 1000));
      const kill = vi.fn();
      const child = { killed: false, kill } as unknown as ChildProcess;
      runtime.trackChildProcess(child);
      runtime.backgroundShells.shells.set('shell-1', {
        id: 'shell-1',
        command: 'long-running',
        effectiveCommand: 'long-running',
        workdir: '.',
        process: child,
        status: 'running',
        output: '',
        readOffset: 0,
        truncatedBytes: 0,
        startedAt: 1,
        timer,
      });

      runtime.dispose('test');
      runtime.dispose('test-again');

      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('test');
      expect(kill).toHaveBeenCalledTimes(1);
      expect(runtime.backgroundShells.shells.size).toBe(0);
      expect(runtime.isDisposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
