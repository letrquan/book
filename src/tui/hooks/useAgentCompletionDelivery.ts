import { useEffect, useRef } from 'react';
import type { AgentCompletionNotification } from '../../agents/types.js';
import { takeAgentCompletionBatch } from '../../agents/completion-notification.js';
import type { QueuedAgentCompletion } from './useManagedAgents.js';

export function useAgentCompletionDelivery(options: {
  pending: QueuedAgentCompletion[];
  parentSessionId: string;
  blocked: boolean;
  deliver: (notifications: AgentCompletionNotification[]) => Promise<boolean>;
  acknowledge: (ids: string[]) => Promise<void>;
}): void {
  const deliveryInFlight = useRef(false);
  const deliveredIds = useRef(new Set<string>());
  const mounted = useRef(true);
  const retryAttempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingKey = useRef('');
  const latest = useRef(options);
  const drain = useRef<() => void>(() => {});
  latest.current = options;

  const scheduleRetry = () => {
    if (!mounted.current || retryTimer.current || retryAttempts.current >= 5) return;
    const delayMs = Math.min(1000 * 2 ** retryAttempts.current, 16_000);
    retryAttempts.current++;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = undefined;
      drain.current();
    }, delayMs);
  };

  drain.current = () => {
    const current = latest.current;
    if (!mounted.current || current.blocked || deliveryInFlight.current || retryTimer.current)
      return;
    const pending = current.pending.filter(
      (item) =>
        item.notification.parentSessionId === current.parentSessionId &&
        !deliveredIds.current.has(item.id),
    );
    if (pending.length === 0) return;

    const batchNotifications = takeAgentCompletionBatch(pending.map((item) => item.notification));
    const batchIds = new Set(batchNotifications.map((notification) => notification.deliveryId));
    const batch = pending.filter((item) => batchIds.has(item.notification.deliveryId));
    deliveryInFlight.current = true;
    let acknowledged = false;
    void current
      .deliver(batchNotifications)
      .then(async (nextAccepted) => {
        if (!nextAccepted || !mounted.current) {
          scheduleRetry();
          return;
        }
        const ids = batch.map((item) => item.id);
        try {
          await current.acknowledge(ids);
        } catch {
          scheduleRetry();
          return;
        }
        if (!mounted.current) return;
        retryAttempts.current = 0;
        for (const id of ids) deliveredIds.current.add(id);
        acknowledged = true;
      })
      .catch(() => {
        scheduleRetry();
      })
      .finally(() => {
        deliveryInFlight.current = false;
        if (acknowledged) queueMicrotask(() => drain.current());
      });
  };

  useEffect(() => {
    const nextKey = options.pending.map((item) => item.id).join('\0');
    if (nextKey !== pendingKey.current) {
      pendingKey.current = nextKey;
      retryAttempts.current = 0;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    }
    drain.current();
  }, [options.blocked, options.parentSessionId, options.pending]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    };
  }, []);
}
