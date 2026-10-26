/**
 * The sender's half of the rate limit: a mirror of each receiver's bucket for this sender
 * (`ingress-guard.ts`), so a send that would certainly be dropped is refused here, with
 * `sender_paced`, instead of being sent into the drop. A send that never reached the receiver
 * (a transport failure) gives its token back, because the receiver never took one.
 */

import { INGRESS_LIMITS, refillBucket, touchLru } from './ingress-guard.js';

interface TargetBucket {
  tokens: number;
  lastRefill: number;
}

export class SendPacer {
  private readonly targets = new Map<string, TargetBucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Take a token for a send to `target`, or false when the receiver's bucket would be empty. */
  take(target: string): boolean {
    const bucket = this.refilled(target);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Give back the token a send took, when the send never reached the receiver. */
  refund(target: string): void {
    const bucket = this.targets.get(target);
    if (!bucket) return;
    bucket.tokens = Math.min(INGRESS_LIMITS.bucketCapacity, bucket.tokens + 1);
  }

  /** The tokens left for `target` now; for tests and diagnostics. */
  available(target: string): number {
    return this.refilled(target).tokens;
  }

  private refilled(target: string): TargetBucket {
    const now = this.now();
    const bucket = touchLru(this.targets, target, INGRESS_LIMITS.maxTrackedSenders, () => ({
      tokens: INGRESS_LIMITS.bucketCapacity,
      lastRefill: now,
    }));
    bucket.tokens = refillBucket(
      bucket.tokens,
      bucket.lastRefill,
      now,
      INGRESS_LIMITS.bucketCapacity,
      INGRESS_LIMITS.refillPerSecond,
    );
    bucket.lastRefill = now;
    return bucket;
  }
}
