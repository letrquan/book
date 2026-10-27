import { useEffect, useRef, useState } from 'react';
import { humanReceiptLine, modelReceiptNotice } from '../../messaging/delivery.js';
import { heldMessageLine, HoldRowLimiter, settledMessageLine } from '../../messaging/hold.js';
import { idleNoticeHumanLine, idleNoticeModelText } from '../../messaging/idle-notify.js';
import type { PeerDeliveryBatch, SessionMessaging } from '../../messaging/session-messaging.js';
import type { PeerPermissionClass } from '../../types/messaging.js';

/** How long a delivery the session could not start waits before it is tried again. */
const RETRY_MS = 1_000;

/** How a host notice turn shows and runs: its transcript row, and the class a peer's words pin. */
export interface PeerNoticeOptions {
  display?: string;
  peerTurnClass?: PeerPermissionClass;
}

interface PendingNotice extends PeerNoticeOptions {
  context: string;
}

/**
 * Cross-session messaging in the TUI (#620): deliver the messages other sessions sent, and tell
 * the human and the model what came of the ones this session sent.
 *
 * Both wait for the session to be idle — nothing running, nothing asked, the user's own queued
 * follow-ups sent first — and start a turn of their own then, as a managed agent's completion
 * does. A message never interrupts a turn (draining at a tool round comes later, #620 PR 7).
 * A receipt's line for the human is written when the batch arrives; its notice for the model
 * waits its turn like a message. A message the receive policy holds, and how a held one ends, are
 * rows for the human only: a held message never reaches the model until it is released (PR 5).
 *
 * An idle notice about a session this one subscribed to (PR 6) is a row for the human, and a turn
 * for the model too when the receive policy would accept a message from that session. The same idleness — nothing running, asked, queued or about to be delivered — is what
 * this session reports to the runtime, which answers the subscriptions other sessions made to it.
 */
export function usePeerMessageDelivery(options: {
  messaging?: SessionMessaging;
  blocked: boolean;
  deliver: (batch: PeerDeliveryBatch) => Promise<boolean>;
  notify: (notice: string, options?: PeerNoticeOptions) => Promise<boolean>;
  warn: (line: string) => void;
}): void {
  const [tick, setTick] = useState(0);
  const latest = useRef(options);
  latest.current = options;
  const notices = useRef<PendingNotice[]>([]);
  const holdRows = useRef(new HoldRowLimiter());
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
        if (notice.length > 0) notices.current.push({ context: notice.join('\n') });
      } else if (event.type === 'held' || event.type === 'hold-settled') {
        const row = holdRows.current.admit(
          event.type === 'held'
            ? heldMessageLine(event.held, event.count)
            : settledMessageLine(event.held, event.outcome, event.by),
        );
        if (row !== undefined) latest.current.warn(row);
      } else if (event.type === 'idle-notice') {
        // The human always gets the row; the model gets its turn only when the policy accepts the
        // notifier. A host turn's own row is not shown, as for a delivery notice.
        latest.current.warn(idleNoticeHumanLine(event.notice));
        if (event.notice.toModel) {
          notices.current.push({
            context: idleNoticeModelText(event.notice),
            display: 'Cross-session idle notice.',
            ...(event.notice.turnClass !== undefined
              ? { peerTurnClass: event.notice.turnClass }
              : {}),
          });
        }
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
      : current
          .notify(notice!.context, {
            ...(notice!.display !== undefined ? { display: notice!.display } : {}),
            ...(notice!.peerTurnClass !== undefined
              ? { peerTurnClass: notice!.peerTurnClass }
              : {}),
          })
          .then((accepted) => {
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

  // After the delivery above, which may just have started a turn: idle only when nothing runs,
  // nothing is asked or queued, and no delivery or notice is under way or waiting to be retried.
  // Queued and held peer messages the runtime counts itself.
  useEffect(() => {
    latest.current.messaging?.setIdle(
      !latest.current.blocked &&
        !inFlight.current &&
        !retryTimer.current &&
        notices.current.length === 0,
    );
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
