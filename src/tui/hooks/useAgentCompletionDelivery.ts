import { useEffect, useRef } from 'react';
import type { AgentCompletionNotification } from '../../agents/types.js';
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
  const latest = useRef(options);
  const drain = useRef<() => void>(() => {});
  latest.current = options;

  drain.current = () => {
    const current = latest.current;
    if (!mounted.current || current.blocked || deliveryInFlight.current) return;
    const pending = current.pending.filter(
      (item) =>
        item.notification.parentSessionId === current.parentSessionId &&
        !deliveredIds.current.has(item.id),
    );
    if (pending.length === 0) return;

    deliveryInFlight.current = true;
    let accepted = false;
    void current
      .deliver(pending.map((item) => item.notification))
      .then(async (nextAccepted) => {
        accepted = nextAccepted;
        if (!accepted || !mounted.current) return;
        const ids = pending.map((item) => item.id);
        await current.acknowledge(ids);
        if (!mounted.current) return;
        for (const id of ids) deliveredIds.current.add(id);
      })
      .catch(() => {
        accepted = false;
      })
      .finally(() => {
        deliveryInFlight.current = false;
        if (accepted) queueMicrotask(() => drain.current());
      });
  };

  useEffect(() => {
    drain.current();
  }, [options.blocked, options.parentSessionId, options.pending]);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
}
