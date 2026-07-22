import { describe, expect, it } from 'vitest';
import { AgentSessionOperations } from './agent-session-operations.js';

describe('AgentSessionOperations', () => {
  it('enforces one operation across send, compact, and rewind', () => {
    const operations = new AgentSessionOperations();
    const send = operations.tryStart('send', true);

    expect(send).not.toBeNull();
    expect(operations.activeKind).toBe('send');
    expect(operations.tryStart('compact', true)).toBeNull();
    expect(operations.tryStart('rewind')).toBeNull();
    expect(send?.release()).toBe(true);
    expect(operations.activeKind).toBeNull();
  });

  it('aborts without releasing until the operation finishes', () => {
    const operations = new AgentSessionOperations();
    const send = operations.tryStart('send', true)!;

    expect(operations.cancel()).toEqual({ kind: 'send', aborted: true });
    expect(send.signal?.aborted).toBe(true);
    expect(send.isCurrent()).toBe(true);
    expect(operations.tryStart('send', true)).toBeNull();
    expect(operations.cancel()).toEqual({ kind: 'send', aborted: false });
    expect(send.release()).toBe(true);
  });

  it('prevents a stale finally block from releasing a replacement operation', () => {
    const operations = new AgentSessionOperations();
    const stale = operations.tryStart('send', true)!;
    expect(operations.reset()).toBe('send');

    const current = operations.tryStart('send', true)!;
    expect(stale.signal?.aborted).toBe(true);
    expect(stale.release()).toBe(false);
    expect(operations.activeKind).toBe('send');
    expect(current.release()).toBe(true);
  });

  it('releases non-abortable operations only through their lease or reset', () => {
    const operations = new AgentSessionOperations();
    const rewind = operations.tryStart('rewind')!;

    expect(operations.cancel()).toEqual({ kind: 'rewind', aborted: false });
    expect(rewind.isCurrent()).toBe(true);
    expect(operations.reset()).toBe('rewind');
    expect(rewind.release()).toBe(false);
    expect(operations.activeKind).toBeNull();
  });
});
