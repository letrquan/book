import { useEffect, useRef, useState } from 'react';
import { humanReceiptLine, modelReceiptNotice } from '../../messaging/delivery.js';
import { heldMessageLine, HoldRowLimiter, settledMessageLine } from '../../messaging/hold.js';
import {
  idleNoticeHumanLine,
  idleNoticeModelText,
  type PeerNoticeSender,
} from '../../messaging/idle-notify.js';
import { stricterClass } from '../../messaging/receive-policy.js';
import type { PeerDeliveryBatch, SessionMessaging } from '../../messaging/session-messaging.js';
import type { PeerPermissionClass } from '../../types/messaging.js';

/** How long a delivery the session could not start waits before it is tried again. */
const RETRY_MS = 1_000;
/** Notices one turn tells the model at most; the rest wait for the next. */
const MAX_NOTICES_PER_TURN = 10;

/**
 * How a host notice turn shows and runs: its transcript row, the class a peer's words pin, the
 * relay chain it continues, and whether it may still start when the send gets that far.
 */
export interface PeerNoticeOptions {
  display?: string;
  peerTurnClass?: PeerPermissionClass;
  relayChain?: readonly string[];
  stillDeliverable?: () => boolean;
}

/** A notice waiting for its turn: its text, and, for one in a peer's words, who sent it. */
interface PendingNotice {
  context: string;
  display?: string;
  relayChain?: readonly string[];
  sender?: PeerNoticeSender;
}

/**
 * The turn the waiting notices make now: the oldest {@link MAX_NOTICES_PER_TURN}, as one turn. A
 * notice in a peer's words is judged again here, since the mode or the settings may have changed
 * while it waited: one the receive policy no longer accepts is left out (its row is all the user
 * gets), and the turn runs in the strictest class among the rest. The turn continues the longest
 * relay among them, so a model re-subscribing from many notices at once counts one hop, not one
 * branch each. `turn` is undefined when nothing is left to tell the model.
 */
function noticeTurn(
  pending: readonly PendingNotice[],
  messaging: SessionMessaging,
): { taken: number; turn?: { context: string; options: PeerNoticeOptions } } {
  const taken = pending.slice(0, MAX_NOTICES_PER_TURN);
  const told: PendingNotice[] = [];
  let peerTurnClass: PeerPermissionClass | undefined;
  for (const notice of taken) {
    if (!notice.sender) {
      told.push(notice);
      continue;
    }
    const turnClass = messaging.noticeTurnClass(notice.sender);
    if (turnClass === undefined) continue;
    told.push(notice);
    peerTurnClass = stricterClass(peerTurnClass, turnClass);
  }
  if (told.length === 0) return { taken: taken.length };
  let relayChain: readonly string[] | undefined;
  for (const notice of told) {
    if (notice.relayChain && notice.relayChain.length >= (relayChain?.length ?? 0)) {
      relayChain = notice.relayChain;
    }
  }
  const displays = new Set(told.map((notice) => notice.display));
  const display = displays.size === 1 ? told[0]!.display : 'Cross-session notices.';
  const senders = told.flatMap((notice) => (notice.sender ? [notice.sender] : []));
  return {
    taken: taken.length,
    turn: {
      context: told.map((notice) => notice.context).join('\n\n'),
      options: {
        ...(display !== undefined ? { display } : {}),
        ...(peerTurnClass !== undefined ? { peerTurnClass } : {}),
        ...(relayChain !== undefined ? { relayChain } : {}),
        // Judged once more when the turn starts: a pre-turn compaction takes a while.
        ...(senders.length > 0
          ? {
              stillDeliverable: () =>
                senders.every((sender) => messaging.noticeTurnClass(sender) !== undefined),
            }
          : {}),
      },
    },
  };
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
 * for the model too when the receive policy would accept a message from that session, then and
 * again when its turn starts; waiting notices are told together, one turn for many. The host work
 * that will start a turn — this hook's own notices, and the `pendingWork` the TUI names — is
 * reported to the runtime, which answers other sessions' idle subscriptions only while there is
 * none and the session's record says it is idle.
 */
export function usePeerMessageDelivery(options: {
  messaging?: SessionMessaging;
  blocked: boolean;
  /** Work that will start a turn of its own: queued follow-ups, completions waiting to be delivered. */
  pendingWork: boolean;
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
            ...(event.notice.chain !== undefined ? { relayChain: event.notice.chain } : {}),
            ...(event.notice.sender !== undefined ? { sender: event.notice.sender } : {}),
          });
        }
      }
      setTick((current) => current + 1);
    });
  }, [messaging]);

  useEffect(() => {
    const current = latest.current;
    if (!current.messaging || current.blocked || inFlight.current || retryTimer.current) return;
    const batch = current.messaging.prepareDelivery();
    if (!batch && notices.current.length === 0) return;
    const told = batch ? undefined : noticeTurn(notices.current, current.messaging);
    if (told && !told.turn) {
      // Every notice taken is one the policy no longer accepts: nothing to start a turn for.
      notices.current.splice(0, told.taken);
      setTick((value) => value + 1);
      return;
    }
    inFlight.current = true;
    const work = batch
      ? current.deliver(batch)
      : current.notify(told!.turn!.context, told!.turn!.options).then((accepted) => {
          if (accepted) notices.current.splice(0, told!.taken);
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

  // After the delivery above, which may just have started a turn. Being blocked is not host work:
  // the user looking at an agent's surface, or editing a queued input, starts nothing. Queued and
  // held peer messages the runtime counts itself.
  useEffect(() => {
    latest.current.messaging?.setHostWork(
      latest.current.pendingWork ||
        inFlight.current ||
        retryTimer.current !== undefined ||
        notices.current.length > 0,
    );
  }, [options.pendingWork, messaging, tick]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    };
  }, []);
}
