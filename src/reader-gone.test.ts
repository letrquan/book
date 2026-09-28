import { getEventListeners } from 'node:events';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReaderFlush, isReaderGoneError } from './reader-gone.js';

/**
 * The reader-gone mechanism behind a `stream-json` print run: a write's own
 * callback says whether anyone is still reading, and a tool boundary waits for
 * the writes it announced. Unit-level because the properties that matter here
 * are all about the wait — that it costs nothing when the reader has caught up,
 * that it is bounded, and that a hold leaves nothing behind on the signal.
 */

/** `true` when `promise` is still unresolved after a microtask turn. */
async function isPending(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  return !settled;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('isReaderGoneError', () => {
  it('names every code a closed far end arrives with', () => {
    for (const code of ['EPIPE', 'EOF', 'ERR_STREAM_DESTROYED', 'ECONNRESET']) {
      expect(isReaderGoneError(Object.assign(new Error(code), { code }))).toBe(true);
    }
  });

  it('leaves every other failure to be thrown', () => {
    expect(isReaderGoneError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false);
    expect(isReaderGoneError(new Error('write failed'))).toBe(false);
    expect(isReaderGoneError(undefined)).toBe(false);
  });
});

describe('createReaderFlush', () => {
  /** A sink whose writes are answered on demand, so a wait can be observed. */
  function pendingWriter() {
    const callbacks: Array<(error?: Error | null) => void> = [];
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callbacks.push(callback);
      },
    });
    stream.on('error', () => {});
    return { stream, lines, take: () => callbacks.shift() };
  }

  /** A sink that answers every write at once: a reader that has caught up. */
  function syncWriter() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    return { stream, lines };
  }

  it('watches a real stream and nothing else', () => {
    expect(createReaderFlush(syncWriter().stream)).toBeDefined();
    // The SDK's discard sink, and a wrapper that forwards nothing: neither can
    // report a failed write, so the run keeps today's path for both.
    expect(createReaderFlush({ write: () => true })).toBeUndefined();
    const wrapped = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const wrapper = {
      write: (...args: unknown[]) => (wrapped.write as (...a: unknown[]) => boolean)(...args),
    };
    expect(wrapper.write.length).toBe(0);
    expect(createReaderFlush(wrapper)).toBeUndefined();
  });

  it('aborts its signal on a write that reports the reader is gone', () => {
    const writer = pendingWriter();
    const flush = createReaderFlush(writer.stream)!;
    flush.write('{"type":"tool_use"}\n');
    expect(flush.signal.aborted).toBe(false);

    writer.take()?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(flush.signal.aborted).toBe(true);
  });

  it('holds free — no timer, no listener — when the reader has caught up', async () => {
    vi.useFakeTimers();
    const flush = createReaderFlush(syncWriter().stream)!;
    const run = new AbortController();
    flush.write('{"type":"tool_use"}\n');
    const listenersBefore = getEventListeners(run.signal, 'abort').length;

    await expect(flush.hold(run.signal)).resolves.toBeUndefined();

    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(run.signal, 'abort').length).toBe(listenersBefore);
  });

  it('waits for an outstanding write, then stops waiting once the cap is spent', async () => {
    vi.useFakeTimers();
    const writer = pendingWriter();
    const flush = createReaderFlush(writer.stream, { capMs: 50 })!;
    const run = new AbortController();

    flush.write('first\n');
    const first = flush.hold(run.signal);
    expect(await isPending(first)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    await first;

    // The reader is slow, not gone: it is still holding that write, and a
    // second boundary must not pay the cap again.
    expect(flush.signal.aborted).toBe(false);
    const second = flush.hold(run.signal);
    expect(await isPending(second)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // Once the reader catches up the mark clears and the next boundary waits
    // again — so a stall that ends costs one cap, not the whole run.
    writer.take()?.();
    flush.write('second\n');
    const third = flush.hold(run.signal);
    expect(await isPending(third)).toBe(true);
    writer.take()?.();
    await expect(third).resolves.toBeUndefined();
  });

  it('ends a wait on an abort, and leaves the signal as it found it', async () => {
    vi.useFakeTimers();
    const writer = pendingWriter();
    const flush = createReaderFlush(writer.stream, { capMs: 5000 })!;
    const run = new AbortController();

    flush.write('held\n');
    const hold = flush.hold(run.signal);
    expect(getEventListeners(run.signal, 'abort').length).toBe(1);
    run.abort();
    await expect(hold).resolves.toBeUndefined();

    // Every hold released its own listener: a long run's signal does not
    // accumulate one per tool batch.
    for (let batch = 0; batch < 5; batch++) {
      flush.write(`record ${batch}\n`);
      const next = flush.hold(run.signal);
      writer.take()?.();
      await next;
      expect(getEventListeners(run.signal, 'abort').length).toBe(0);
    }
  });

  it('returns at once when the run is already aborted', async () => {
    vi.useFakeTimers();
    const flush = createReaderFlush(pendingWriter().stream, { capMs: 5000 })!;
    const run = new AbortController();
    run.abort();
    flush.write('held\n');

    await expect(flush.hold(run.signal)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
