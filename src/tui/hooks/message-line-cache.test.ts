import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getCachedLineEstimate, clearLineCache } from './message-line-cache.js';
import type { Message } from '../../types.js';

function msg(
  id: string,
  content: string,
  toolCalls?: Message['toolCalls'],
  toolResults?: Message['toolResults'],
): Message {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: 1,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolResults !== undefined ? { toolResults } : {}),
  };
}

function mockCompute(msg: Message, termWidth: number): number {
  return (msg.content?.length ?? 0) + termWidth;
}

beforeEach(() => {
  clearLineCache();
});

afterEach(() => {
  clearLineCache();
});

describe('message-line-cache', () => {
  it('returns cached value on hit without calling computeFn', () => {
    const computeFn = vi.fn(mockCompute);
    const m = msg('m1', 'hello');

    const first = getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);

    const second = getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1); // still 1
    expect(second).toBe(first);
  });

  it('recomputes on content change', () => {
    const computeFn = vi.fn(mockCompute);
    const m = msg('m1', 'hello');

    getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);

    const m2 = { ...m, content: 'hello world' };
    getCachedLineEstimate(m2, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(2);
  });

  it('recomputes on toolCalls length change', () => {
    const computeFn = vi.fn(mockCompute);
    const m = msg('m1', 'hello', []);

    getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);

    const m2 = {
      ...m,
      toolCalls: [{ id: 'tc1', name: 'Read', arguments: {} }],
    };
    getCachedLineEstimate(m2, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(2);
  });

  it('recomputes on toolResults length change', () => {
    const computeFn = vi.fn(mockCompute);
    const m = msg('m1', 'hello', undefined, []);

    getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);

    const m2 = {
      ...m,
      toolResults: [{ toolCallId: 'tc1', success: true, output: 'ok' }],
    };
    getCachedLineEstimate(m2, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(2);
  });

  it('recomputes on termWidth change', () => {
    const computeFn = vi.fn(mockCompute);
    const m = msg('m1', 'hello');

    getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);

    getCachedLineEstimate(m, 40, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(2);
  });

  it('clearLineCache empties the cache', () => {
    const computeFn = vi.fn(mockCompute);
    const m = msg('m1', 'hello');

    getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);

    clearLineCache();

    getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(2);
  });

  it('different message IDs have independent cache entries', () => {
    const computeFn = vi.fn(mockCompute);
    const m1 = msg('m1', 'hello');
    const m2 = msg('m2', 'hello');

    getCachedLineEstimate(m1, 80, computeFn);
    getCachedLineEstimate(m2, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(2);

    // Both should now be cached
    getCachedLineEstimate(m1, 80, computeFn);
    getCachedLineEstimate(m2, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(2);
  });

  it('handles undefined toolCalls and toolResults', () => {
    const computeFn = vi.fn(mockCompute);
    const m = msg('m1', 'hello'); // no toolCalls/toolResults

    getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);

    // Same message (undefined arrays treated as 0 length)
    getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);
  });

  it('handles empty content', () => {
    const computeFn = vi.fn(mockCompute);
    const m = msg('m1', '');

    getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);

    getCachedLineEstimate(m, 80, computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);
  });
});
