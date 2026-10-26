import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkHopChain,
  countOwnHops,
  DropReceiptCoalescer,
  DropReportLimiter,
  IngressGuard,
  INGRESS_LIMITS,
  isHopLoop,
  isHopRunaway,
} from './ingress-guard.js';

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function admitMany(guard: IngressGuard, senderKey: string, count: number, queued = 0) {
  return Array.from({ length: count }, (_, i) =>
    guard.admit({ senderKey, body: `message ${i}`, queued }),
  );
}

describe('IngressGuard', () => {
  it("copies Claude Code's limits", () => {
    expect(INGRESS_LIMITS).toEqual({
      bucketCapacity: 30,
      refillPerSecond: 0.5,
      dedupWindowMs: 30_000,
      maxSelfHops: 10,
      maxChainLength: 28,
      maxTrackedSenders: 256,
      maxQueuedPeerMessages: 50,
    });
  });

  it('admits a burst of 30, then rate-limits the sender', () => {
    const time = clock();
    const guard = new IngressGuard(time.now);
    expect(admitMany(guard, 'a', 30).every((verdict) => verdict.admitted)).toBe(true);
    expect(guard.admit({ senderKey: 'a', body: 'one more', queued: 0 })).toEqual({
      admitted: false,
      reason: 'rate-limited',
    });
    // Another sender has a bucket of its own.
    expect(guard.admit({ senderKey: 'b', body: 'hello', queued: 0 })).toEqual({ admitted: true });
  });

  it('refills at half a token a second', () => {
    const time = clock();
    const guard = new IngressGuard(time.now);
    admitMany(guard, 'a', 30);
    time.advance(1_999);
    expect(guard.admit({ senderKey: 'a', body: 'early', queued: 0 }).admitted).toBe(false);
    time.advance(1);
    expect(guard.admit({ senderKey: 'a', body: 'on time', queued: 0 }).admitted).toBe(true);
    expect(guard.admit({ senderKey: 'a', body: 'again', queued: 0 }).admitted).toBe(false);
    time.advance(120_000);
    expect(admitMany(guard, 'a', 31).filter((verdict) => verdict.admitted)).toHaveLength(30);
  });

  it("drops a body identical to the sender's previous one within 30 s, at no token's cost", () => {
    const time = clock();
    const guard = new IngressGuard(time.now);
    expect(guard.admit({ senderKey: 'a', body: 'same', queued: 0 }).admitted).toBe(true);
    for (let i = 0; i < 40; i++) {
      expect(guard.admit({ senderKey: 'a', body: 'same', queued: 0 })).toEqual({
        admitted: false,
        reason: 'duplicate',
      });
    }
    // The duplicates took nothing from the bucket.
    expect(admitMany(guard, 'a', 29).every((verdict) => verdict.admitted)).toBe(true);
    // Another sender may say the same thing.
    expect(guard.admit({ senderKey: 'b', body: 'same', queued: 0 }).admitted).toBe(true);
  });

  it('admits the same body again once the window has passed', () => {
    const time = clock();
    const guard = new IngressGuard(time.now);
    guard.admit({ senderKey: 'a', body: 'same', queued: 0 });
    time.advance(29_999);
    expect(guard.admit({ senderKey: 'a', body: 'same', queued: 0 }).admitted).toBe(false);
    time.advance(1);
    expect(guard.admit({ senderKey: 'a', body: 'same', queued: 0 }).admitted).toBe(true);
  });

  it('drops a message once 50 wait undelivered, without spending a token', () => {
    const guard = new IngressGuard(clock().now);
    expect(guard.admit({ senderKey: 'a', body: 'x', queued: 49 }).admitted).toBe(true);
    expect(guard.admit({ senderKey: 'a', body: 'y', queued: 50 })).toEqual({
      admitted: false,
      reason: 'queue-full',
    });
    expect(admitMany(guard, 'a', 29).every((verdict) => verdict.admitted)).toBe(true);
  });

  it('tracks 256 senders, forgetting the least recently seen first', () => {
    const guard = new IngressGuard(clock().now);
    admitMany(guard, 'first', 30);
    for (let i = 0; i < 255; i++) guard.admit({ senderKey: `s${i}`, body: 'x', queued: 0 });
    expect(guard.trackedSenderCount).toBe(256);
    // Seen again, so `s0` is now the least recent.
    expect(guard.admit({ senderKey: 'first', body: 'still limited', queued: 0 }).admitted).toBe(
      false,
    );
    guard.admit({ senderKey: 'new', body: 'x', queued: 0 });
    expect(guard.trackedSenderCount).toBe(256);
    expect(guard.admit({ senderKey: 'first', body: 'still limited', queued: 0 }).admitted).toBe(
      false,
    );
  });

  it('checks a relay chain before anything else', () => {
    const guard = new IngressGuard(clock().now);
    const own = new Set(['own']);
    expect(
      guard.admit({
        senderKey: 'a',
        body: 'x',
        queued: 0,
        hopChain: Array(10).fill('own'),
        ownTokens: own,
      }),
    ).toEqual({ admitted: false, reason: 'hop-loop' });
    expect(
      guard.admit({ senderKey: 'a', body: 'x', queued: 0, hopChain: Array(29).fill('h') }),
    ).toEqual({ admitted: false, reason: 'hop-runaway' });
  });
});

describe('hop functions', () => {
  const own = new Set(['aaaaaaaaaaaaaaaaaaaaaaaa']);
  const other = 'bbbbbbbbbbbbbbbbbbbbbbbb';

  it('counts only this session’s own hops', () => {
    expect(countOwnHops([other, ...own, other, ...own], own)).toBe(2);
    expect(countOwnHops([other], new Set())).toBe(0);
  });

  it('calls a loop at 10 own hops', () => {
    const nine = [...Array(9).fill([...own][0]), other];
    expect(isHopLoop(nine, own)).toBe(false);
    expect(isHopLoop([...nine, [...own][0]], own)).toBe(true);
  });

  it('calls a runaway past 28 hops', () => {
    expect(isHopRunaway(Array(28).fill(other))).toBe(false);
    expect(isHopRunaway(Array(29).fill(other))).toBe(true);
  });

  it('judges runaway before loop, and nothing without a chain', () => {
    expect(checkHopChain(Array(29).fill([...own][0]), own)).toBe('hop-runaway');
    expect(checkHopChain(Array(10).fill([...own][0]), own)).toBe('hop-loop');
    expect(checkHopChain([other], own)).toBeUndefined();
    expect(checkHopChain(undefined, own)).toBeUndefined();
  });
});

describe('DropReportLimiter', () => {
  it('reports a sender and reason once a minute, counting the rest into the next report', () => {
    const time = clock();
    const limiter = new DropReportLimiter(time.now);
    expect(limiter.report('a', 'rate-limited')).toEqual({
      from: 'a',
      reason: 'rate-limited',
      suppressed: 0,
    });
    for (let i = 0; i < 5; i++) expect(limiter.report('a', 'rate-limited')).toBeUndefined();
    // Another reason from the same sender is its own report.
    expect(limiter.report('a', 'duplicate')).toMatchObject({ suppressed: 0 });
    time.advance(60_000);
    expect(limiter.report('a', 'rate-limited')).toEqual({
      from: 'a',
      reason: 'rate-limited',
      suppressed: 5,
    });
  });

  it('makes at most 20 reports a minute in all', () => {
    const time = clock();
    const limiter = new DropReportLimiter(time.now);
    const made = Array.from({ length: 25 }, (_, i) => limiter.report(`s${i}`, 'duplicate'));
    expect(made.filter(Boolean)).toHaveLength(20);
    time.advance(60_000);
    // The five over the limit are counted into the first report after it.
    expect(limiter.report('late', 'duplicate')).toMatchObject({ suppressed: 5 });
    expect(limiter.report('later', 'duplicate')).toMatchObject({ suppressed: 0 });
  });
});

describe('DropReceiptCoalescer', () => {
  afterEach(() => vi.useRealTimers());

  it('receipts the first drop at once and batches the rest for 5 s', () => {
    vi.useFakeTimers();
    const coalescer = new DropReceiptCoalescer();
    const sent: string[][] = [];
    coalescer.note('a', 'm1', (ids) => sent.push(['first', ...ids]));
    expect(sent).toEqual([['first']]);
    coalescer.note('a', 'm2', (ids) => sent.push(['batch-1', ...ids]));
    coalescer.note('a', 'm3', (ids) => sent.push(['batch-2', ...ids]));
    vi.advanceTimersByTime(4_999);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    // One receipt, through the latest drop's sender, naming every id the batch held.
    expect(sent).toEqual([['first'], ['batch-2', 'm2', 'm3']]);
    coalescer.dispose();
  });

  it('caps the ids a batch names at 256', () => {
    vi.useFakeTimers();
    const coalescer = new DropReceiptCoalescer();
    let batch: string[] = [];
    coalescer.note('a', 'first', () => undefined);
    for (let i = 0; i < 300; i++) coalescer.note('a', `m${i}`, (ids) => (batch = ids));
    vi.advanceTimersByTime(5_000);
    expect(batch).toHaveLength(256);
    coalescer.dispose();
  });

  it('sends at most 40 receipts a minute in all', () => {
    vi.useFakeTimers();
    const coalescer = new DropReceiptCoalescer();
    let sent = 0;
    for (let i = 0; i < 50; i++) coalescer.note(`s${i}`, `m${i}`, () => sent++);
    expect(sent).toBe(40);
    coalescer.dispose();
  });

  it('sends nothing after dispose', () => {
    vi.useFakeTimers();
    const coalescer = new DropReceiptCoalescer();
    const sent: string[][] = [];
    coalescer.note('a', 'm1', (ids) => sent.push(ids));
    coalescer.note('a', 'm2', (ids) => sent.push(ids));
    coalescer.dispose();
    vi.advanceTimersByTime(10_000);
    coalescer.note('a', 'm3', (ids) => sent.push(ids));
    expect(sent).toEqual([[]]);
  });
});
