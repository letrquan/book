import { useEffect, useRef, useState } from 'react';
import { humanReceiptLine, modelReceiptNotice } from '../../messaging/delivery.js';
import type { PeerDeliveryBatch, SessionMessaging } from '../../messaging/session-messaging.js';

/** How long a delivery the session could not start waits before it is tried again. */
const RETRY_MS = 1_000;

/**
 * Cross-session messaging in the TUI (#620): deliver the messages other sessions sent, and tell
 * the human and the model what came of the ones this session sent.
 *
 * Both wait for the session to be idle — nothing running, nothing asked, the user's own queued
 * follow-ups sent first — and start a turn of their own then, as a managed agent's completion
 * does. A message never interrupts a turn (draining at a tool round comes later, #620 PR 7).
 * A receipt's line for the human is written when the batch arrives; its notice for the model
 * waits its turn like a message.
 */
export function usePeerMessageDelivery(options: {
  messaging?: SessionMessaging;
  blocked: boolean;
  deliver: (batch: PeerDeliveryBatch) => Promise<boolean>;
  notify: (notice: string) => Promise<boolean>;
  warn: (line: string) => void;
}): void {
  const [tick, setTick] = useState(0);
  const latest = useRef(options);
  latest.current = options;
  const notices = useRef<string[]>([]);
  const inFlight = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const { messaging } = options;

  useEffect(() => {
    if (!messaging) return;
    return messaging.subscribe((event) => {
      if (event.type === 'receipts') {
        for (const receipt of event.receipts) latest.current.warn(humanReceiptLine(receipt));
        const notice = event.receipts
          .map(modelReceiptNotice)
          .filter((line): line is string => line !== undefined);
        if (notice.length > 0) notices.current.push(notice.join('\n'));
      }
      setTick((current) => current + 1);
    });
  }, [messaging]);

  useEffect(() => {
    const current = latest.current;
    if (!current.messaging || current.blocked || inFlight.current || retryTimer.current) return;
    const notice = notices.current[0];
    const batch = current.messaging.prepareDelivery();
    if (!batch && notice === undefined) return;
    inFlight.current = true;
    const work = batch
      ? current.deliver(batch)
      : current.notify(notice!).then((accepted) => {
          if (accepted) notices.current.shift();
          return accepted;
        });
    void work
      .catch(() => false)
      .then((accepted) => {
        inFlight.current = false;
        if (!mounted.current) return;
        if (accepted) {
          setTick((value) => value + 1);
          return;
        }
        retryTimer.current = setTimeout(() => {
          retryTimer.current = undefined;
          if (mounted.current) setTick((value) => value + 1);
        }, RETRY_MS);
      });
  }, [options.blocked, messaging, tick]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    };
  }, []);
}
