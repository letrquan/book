import { describe, expect, it, vi } from 'vitest';
import { wrapAgentLoopCallbacks } from './observer.js';
import type {
  HarnessObserver,
  HarnessObserverEnqueueResult,
  HarnessObserverFlushResult,
} from './contracts.js';
import type { AgentLoopCallbacks } from '../types/providers.js';

function callbacks(overrides: Partial<AgentLoopCallbacks> = {}): AgentLoopCallbacks {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired: async () => 'deny',
    ...overrides,
  };
}

function observer(overrides: Partial<HarnessObserver> = {}): HarnessObserver {
  return {
    policy: {
      maxQueueSize: 10,
      maxQueueBytes: 10000,
      overflow: 'drop-newest',
      flushTimeoutMs: 100,
      closeTimeoutMs: 100,
    },
    enqueue: vi.fn((_event): HarnessObserverEnqueueResult => 'accepted'),
    flush: vi.fn(async (): Promise<HarnessObserverFlushResult> => ({
      flushed: true,
      status: 'flushed',
      droppedEventCount: 0,
    })),
    close: vi.fn(async (): Promise<HarnessObserverFlushResult> => ({
      flushed: true,
      status: 'closed',
      droppedEventCount: 0,
    })),
    ...overrides,
  };
}

describe('bounded harness observer callback adapter', () => {
  it('forwards the original callback before enqueueing a bounded event', () => {
    const order: string[] = [];
    const target = observer({
      enqueue: vi.fn((_event): HarnessObserverEnqueueResult => {
        order.push('observer');
        return 'accepted';
      }),
    });
    const wrapped = wrapAgentLoopCallbacks(
      callbacks({ onTurnStart: () => order.push('callback') }),
      { observer: target, runId: 'run-observer-1' },
    );
    wrapped.onTurnStart(3);
    expect(order).toEqual(['callback', 'observer']);
    expect(target.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_started' }));
  });

  it('never lets observer enqueue failures change callback behavior', async () => {
    const target = observer({
      enqueue: vi.fn((_event): HarnessObserverEnqueueResult => {
        throw new Error('disk full');
      }),
    });
    const onError = vi.fn();
    const wrapped = wrapAgentLoopCallbacks(callbacks({ onError }), {
      observer: target,
      runId: 'run-observer-2',
    });
    expect(() => wrapped.onError('provider failed')).not.toThrow();
    expect(onError).toHaveBeenCalledWith('provider failed');
  });

  it('records callback-owned facts without duplicating actual starts or permission decisions', async () => {
    const target = observer();
    const wrapped = wrapAgentLoopCallbacks(callbacks(), {
      observer: target,
      runId: 'run-observer-3',
    });
    wrapped.onUsage?.(
      { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      { provider: 'p', requestedModel: 'm' },
    );
    wrapped.onRetry?.('transport', 1, 3, 20);
    wrapped.onStreamStall?.(10);
    wrapped.onToolCall({ id: 'tool-1', name: 'Read', arguments: { filePath: 'secret.txt' } });
    wrapped.onToolResult({
      version: 2,
      toolCallId: 'tool-1',
      status: 'success',
      content: 'full file secret',
    });
    wrapped.onToolResult({
      version: 2,
      toolCallId: 'tool-2',
      status: 'error',
      content: 'ENOENT: no such file /etc/passwd',
      metrics: { durationMs: 12, retryAttempt: 2 },
    });
    await wrapped.onPermissionRequired?.({ id: 'tool-1', name: 'Read', arguments: {} });
    const rawEvents = vi.mocked(target.enqueue).mock.calls.map(([value]) => value);
    const events = rawEvents.map((value) => JSON.stringify(value));
    expect(events.join('\n')).not.toContain('full file secret');
    expect(events.join('\n')).not.toContain('secret.txt');
    expect(events.join('\n')).not.toContain('/etc/passwd');
    expect(
      rawEvents.find(
        (value) =>
          value.type === 'tool_finished' &&
          (value.attributes as Record<string, unknown>)?.toolCallId === 'tool-2',
      )?.attributes,
    ).toMatchObject({ status: 'error', durationMs: 12, retryAttempt: 2 });
    expect(rawEvents.filter((value) => value.type === 'tool_started')).toHaveLength(0);
    expect(rawEvents.filter((value) => value.type === 'permission_resolved')).toHaveLength(0);
  });

  it('records managed-agent starts as explicit child handoffs with run linkage', () => {
    const target = observer();
    const forwarded: string[] = [];
    const wrapped = wrapAgentLoopCallbacks(
      callbacks({ onAgentEvent: (event) => forwarded.push(event.type) }),
      { observer: target, runId: 'root-agent-1' },
    );
    wrapped.onAgentEvent?.({
      type: 'agent_start',
      agent: {
        id: 'agent-7',
        name: 'explorer',
        runId: 'child-run-7',
        rootRunId: 'root-agent-1',
        parentRunId: 'root-agent-1',
      } as never,
    });
    wrapped.onAgentEvent?.({ type: 'agent_text_delta', agentId: 'agent-7', text: 'private' });
    expect(forwarded).toEqual(['agent_start', 'agent_text_delta']);
    const calls = vi.mocked(target.enqueue).mock.calls.map(([value]) => value);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: 'subagent_handoff_created',
      attributes: {
        agentId: 'agent-7',
        agentName: 'explorer',
        childRunId: 'child-run-7',
        rootRunId: 'root-agent-1',
        parentRunId: 'root-agent-1',
        child: true,
      },
    });
    expect(JSON.stringify(calls[0])).not.toContain('private');
  });
});
