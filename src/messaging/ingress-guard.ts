/**
 * What stands between an authenticated peer and the session: limits on how much one sender can
 * push in, and on how much noise the drops themselves make.
 *
 * Every number is Claude Code's (§1.6 of the messaging plan), copied as is: they are tuned, and a
 * receiver that differs from Claude Code for no reason costs interop later.
 *
 * - Each sender has a token bucket of 30, refilled at 0.5 a second.
 * - A body identical to the sender's previous one within 30 s is a duplicate.
 * - At most 256 senders are tracked; the least recently seen is forgotten first.
 * - At most 50 accepted messages wait undelivered.
 * - A relay chain that already passed through this session 10 times is a loop, and one longer
 *   than 28 a runaway (pure functions here; PR 3 wires them once the envelope parses chains).
 * - Drop reports for the human: one per sender and reason a minute, 20 a minute in all, with the
 *   suppressed ones counted into the next report.
 * - Drop receipts for the sender: the first goes at once, and later ones within a minute are
 *   batched for 5 s into one receipt naming every dropped id (up to 256); 40 a minute in all.
 *
 * State is per inbox and held on explicit objects: there is no module state.
 */

import type { PeerDropReason } from '../types/messaging.js';

export const INGRESS_LIMITS = Object.freeze({
  bucketCapacity: 30,
  refillPerSecond: 0.5,
  dedupWindowMs: 30_000,
  maxSelfHops: 10,
  maxChainLength: 28,
  maxTrackedSenders: 256,
  maxQueuedPeerMessages: 50,
});

export const DROP_REPORT_LIMITS = Object.freeze({
  windowMs: 60_000,
  maxReportsPerWindow: 20,
  maxTrackedKeys: 256,
});

export const DROP_RECEIPT_LIMITS = Object.freeze({
  windowMs: 60_000,
  trailMs: 5_000,
  maxReceiptsPerWindow: 40,
  maxPendingIds: 256,
  maxTrackedSenders: 256,
});

/** What Claude Code's receivers say about each drop reason. */
export const DROP_REASON_TEXT: Readonly<Record<PeerDropReason, string>> = Object.freeze({
  'rate-limited': 'sender exceeded the peer message rate limit',
  duplicate: 'identical to the previous message from this sender',
  'hop-loop': 'message has already passed through this session (a peer messaging loop)',
  'hop-runaway': 'peer relay chain is too long (runaway forwarding)',
  'queue-full': 'this session has too many undelivered peer messages queued',
});

/** The `reason` text of a `dropped` receipt. */
export const DROPPED_RECEIPT_REASON =
  "The recipient's session dropped your message at its inbox (rate limit, duplicate, relay loop, or full queue); it was not delivered and will not be.";

/** Tokens `bucket` holds at `now`, refilled since `lastRefill` and capped. */
export function refillBucket(
  tokens: number,
  lastRefill: number,
  now: number,
  capacity: number,
  refillPerSecond: number,
): number {
  const seconds = Math.max(0, now - lastRefill) / 1000;
  return Math.min(capacity, tokens + seconds * refillPerSecond);
}

/** How many of the chain's hops are this session's own tokens. */
export function countOwnHops(chain: readonly string[], ownTokens: ReadonlySet<string>): number {
  if (ownTokens.size === 0) return 0;
  return chain.reduce((count, hop) => count + (ownTokens.has(hop) ? 1 : 0), 0);
}

/** A chain that already passed through this session {@link INGRESS_LIMITS.maxSelfHops} times. */
export function isHopLoop(
  chain: readonly string[],
  ownTokens: ReadonlySet<string>,
  maxSelfHops = INGRESS_LIMITS.maxSelfHops,
): boolean {
  return countOwnHops(chain, ownTokens) >= maxSelfHops;
}

/** A chain longer than {@link INGRESS_LIMITS.maxChainLength}. */
export function isHopRunaway(
  chain: readonly string[],
  maxChainLength = INGRESS_LIMITS.maxChainLength,
): boolean {
  return chain.length > maxChainLength;
}

/** The hop verdict for a chain: runaway first, then loop, as Claude Code checks them. */
export function checkHopChain(
  chain: readonly string[] | undefined,
  ownTokens: ReadonlySet<string>,
): PeerDropReason | undefined {
  if (chain === undefined) return undefined;
  if (isHopRunaway(chain)) return 'hop-runaway';
  if (isHopLoop(chain, ownTokens)) return 'hop-loop';
  return undefined;
}

/**
 * The entry for `key`, made most recent; a new one evicts the least recent once `max` are held.
 * A Map iterates in insertion order, so re-inserting is what moves an entry to the end.
 */
export function touchLru<K, V>(map: Map<K, V>, key: K, max: number, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) {
    map.delete(key);
    map.set(key, existing);
    return existing;
  }
  while (map.size >= Math.max(1, max)) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  const created = create();
  map.set(key, created);
  return created;
}

interface SenderState {
  tokens: number;
  lastRefill: number;
  lastBody?: string;
  lastBodyAt: number;
}

export interface AdmitInput {
  /** Who the message is from, for the per-sender limits: its reply address, or a placeholder. */
  senderKey: string;
  body: string;
  /** The relay chain the envelope carried; absent until PR 3 parses envelopes. */
  hopChain?: readonly string[];
  ownTokens?: ReadonlySet<string>;
  /** How many accepted messages are waiting now. */
  queued: number;
}

export type AdmitVerdict = { admitted: true } | { admitted: false; reason: PeerDropReason };

export class IngressGuard {
  private readonly senders = new Map<string, SenderState>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Whether to accept one message, in Claude Code's order: the relay chain, then the duplicate
   * check, then the sender's bucket (a duplicate costs no token), then the queue.
   */
  admit(input: AdmitInput): AdmitVerdict {
    const hop = checkHopChain(input.hopChain, input.ownTokens ?? new Set());
    if (hop) return { admitted: false, reason: hop };
    const now = this.now();
    const sender = touchLru(
      this.senders,
      input.senderKey,
      INGRESS_LIMITS.maxTrackedSenders,
      () => ({
        tokens: INGRESS_LIMITS.bucketCapacity,
        lastRefill: now,
        lastBodyAt: 0,
      }),
    );
    if (
      sender.lastBody !== undefined &&
      sender.lastBody === input.body &&
      now - sender.lastBodyAt < INGRESS_LIMITS.dedupWindowMs
    ) {
      return { admitted: false, reason: 'duplicate' };
    }
    sender.tokens = refillBucket(
      sender.tokens,
      sender.lastRefill,
      now,
      INGRESS_LIMITS.bucketCapacity,
      INGRESS_LIMITS.refillPerSecond,
    );
    sender.lastRefill = now;
    if (sender.tokens < 1) return { admitted: false, reason: 'rate-limited' };
    if (input.queued >= INGRESS_LIMITS.maxQueuedPeerMessages) {
      return { admitted: false, reason: 'queue-full' };
    }
    sender.tokens -= 1;
    sender.lastBody = input.body;
    sender.lastBodyAt = now;
    return { admitted: true };
  }

  get trackedSenderCount(): number {
    return this.senders.size;
  }
}

/** A drop as the human is told of it, with the reports suppressed since the last one. */
export interface DropReport {
  from: string;
  reason: PeerDropReason;
  suppressed: number;
}

/**
 * Rate limits the local reports of drops: the first drop of a sender and reason in a minute is
 * reported, later ones are counted into the next report of that pair, and no more than 20 reports
 * go out a minute in all (the ones over that are counted into the next report of any pair).
 */
export class DropReportLimiter {
  private readonly lastReport = new Map<string, { at: number; suppressed: number }>();
  private windowStart = Number.NEGATIVE_INFINITY;
  private inWindow = 0;
  private overflow = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The report to make for this drop, or undefined when it is suppressed. */
  report(from: string, reason: PeerDropReason): DropReport | undefined {
    const now = this.now();
    const key = `${from}\0${reason}`;
    const last = this.lastReport.get(key);
    if (last && now - last.at < DROP_REPORT_LIMITS.windowMs) {
      last.suppressed++;
      return undefined;
    }
    if (now - this.windowStart >= DROP_REPORT_LIMITS.windowMs) {
      this.windowStart = now;
      this.inWindow = 0;
    }
    if (this.inWindow >= DROP_REPORT_LIMITS.maxReportsPerWindow) {
      this.overflow++;
      return undefined;
    }
    this.inWindow++;
    const suppressed = (last?.suppressed ?? 0) + this.overflow;
    this.overflow = 0;
    this.lastReport.delete(key);
    this.lastReport.set(key, { at: now, suppressed: 0 });
    if (this.lastReport.size > DROP_REPORT_LIMITS.maxTrackedKeys) {
      const oldest = this.lastReport.keys().next();
      if (!oldest.done) this.lastReport.delete(oldest.value);
    }
    return { from, reason, suppressed };
  }
}

/** One receipt to send: the ids it names (empty for the immediate one, which names its own). */
export type SendDropReceipt = (droppedMsgIds: string[]) => void;

interface PendingReceipts {
  lastImmediateAt: number;
  pending: number;
  pendingIds: string[];
  send?: SendDropReceipt;
  timer?: NodeJS.Timeout;
}

/**
 * Coalesces the `dropped` receipts a flooding sender would otherwise get one per message. The
 * first drop of a sender in a minute is receipted at once; the drops after it wait 5 s and go
 * back as one receipt naming every id, so a sender that floods learns of each drop without the
 * receiver opening a connection per drop. No more than 40 receipts go out a minute in all.
 */
export class DropReceiptCoalescer {
  private readonly senders = new Map<string, PendingReceipts>();
  private windowStart = Number.NEGATIVE_INFINITY;
  private inWindow = 0;
  private disposed = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly trailMs: number = DROP_RECEIPT_LIMITS.trailMs,
  ) {}

  /**
   * Note one drop from `sender`. `send` builds and sends the receipt; the latest one passed is the
   * one a batch is sent through.
   */
  note(sender: string, msgId: string | undefined, send: SendDropReceipt): void {
    if (this.disposed) return;
    const now = this.now();
    const state = this.senders.get(sender) ?? {
      lastImmediateAt: Number.NEGATIVE_INFINITY,
      pending: 0,
      pendingIds: [],
    };
    this.senders.delete(sender);
    this.senders.set(sender, state);
    if (this.senders.size > DROP_RECEIPT_LIMITS.maxTrackedSenders) {
      const oldest = this.senders.keys().next();
      if (!oldest.done && oldest.value !== sender) {
        const evicted = this.senders.get(oldest.value);
        this.senders.delete(oldest.value);
        if (evicted) this.flush(evicted);
      }
    }
    if (now - state.lastImmediateAt >= DROP_RECEIPT_LIMITS.windowMs && state.pending === 0) {
      state.lastImmediateAt = now;
      if (this.takeSlot()) send([]);
      return;
    }
    state.pending++;
    if (msgId !== undefined && state.pendingIds.length < DROP_RECEIPT_LIMITS.maxPendingIds) {
      state.pendingIds.push(msgId);
    }
    state.send = send;
    if (state.timer === undefined) {
      state.timer = setTimeout(() => this.flush(state), this.trailMs);
      state.timer.unref?.();
    }
  }

  /** Stop: pending batches are dropped, and no timer is left running. */
  dispose(): void {
    this.disposed = true;
    for (const state of this.senders.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
    this.senders.clear();
  }

  private flush(state: PendingReceipts): void {
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    const { pending, pendingIds, send } = state;
    state.pending = 0;
    state.pendingIds = [];
    state.send = undefined;
    if (pending > 0 && send && !this.disposed && this.takeSlot()) send(pendingIds);
  }

  private takeSlot(): boolean {
    const now = this.now();
    if (now - this.windowStart >= DROP_RECEIPT_LIMITS.windowMs) {
      this.windowStart = now;
      this.inWindow = 0;
    }
    if (this.inWindow >= DROP_RECEIPT_LIMITS.maxReceiptsPerWindow) return false;
    this.inWindow++;
    return true;
  }
}
