import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentManager } from '../../agents/manager.js';
import type {
  AgentActivity,
  AgentCompletionNotification,
  AgentRecord,
  AgentRuntimeEvent,
  AgentSummary,
} from '../../agents/types.js';
import { projectAgentSummary } from '../../agents/projections.js';
import type { UserQuestionResponse } from '../../types/tools.js';

export type ManagedAgentSurface = 'main' | 'tasks' | 'detail';

export interface QueuedAgentCompletion {
  id: string;
  notification: AgentCompletionNotification;
}

export interface ManagedAgentState {
  summaries: AgentSummary[];
  records: Map<string, AgentRecord>;
  activities: Map<string, AgentActivity[]>;
  liveText: Map<string, string>;
  selectedAgentId?: string;
  surface: ManagedAgentSurface;
  pendingPermissions: AgentRuntimeEvent[];
  pendingQuestions: Array<{
    agentId: string;
    request: NonNullable<AgentRecord['pendingQuestion']>;
  }>;
  pendingCompletions: QueuedAgentCompletion[];
  setSurface: (surface: ManagedAgentSurface) => void;
  selectAgent: (agentId?: string) => void;
  send: (message: string) => Promise<void>;
  stopOrDismiss: (agentId?: string) => Promise<void>;
  resolvePermission: (requestId: string, response: 'allow' | 'deny' | 'always') => Promise<void>;
  resolveQuestion: (agentId: string, response: UserQuestionResponse) => Promise<void>;
  acknowledgeCompletions: (ids: string[]) => Promise<void>;
  refresh: () => Promise<void>;
}

function upsertSummary(current: AgentSummary[], next: AgentSummary): AgentSummary[] {
  const filtered = current.filter((summary) => summary.agentId !== next.agentId);
  return [next, ...filtered].sort((left, right) => {
    const leftDone = ['completed', 'failed', 'stopped', 'interrupted'].includes(left.status);
    const rightDone = ['completed', 'failed', 'stopped', 'interrupted'].includes(right.status);
    if (leftDone !== rightDone) return leftDone ? 1 : -1;
    return right.updatedAt - left.updatedAt;
  });
}

export function useManagedAgents(manager: AgentManager): ManagedAgentState {
  const [summaries, setSummaries] = useState<AgentSummary[]>([]);
  const [records, setRecords] = useState<Map<string, AgentRecord>>(() => new Map());
  const [activities, setActivities] = useState<Map<string, AgentActivity[]>>(() => new Map());
  const [liveText, setLiveText] = useState<Map<string, string>>(() => new Map());
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [surface, setSurface] = useState<ManagedAgentSurface>('main');
  const [pendingCompletions, setPendingCompletions] = useState<QueuedAgentCompletion[]>([]);
  const seenCompletions = useRef(new Set<string>());
  const deferredDismissals = useRef(new Set<string>());

  const enqueueCompletion = useCallback((notification: AgentCompletionNotification) => {
    const id = notification.deliveryId;
    if (seenCompletions.current.has(id)) return;
    seenCompletions.current.add(id);
    setPendingCompletions((current) => [...current, { id, notification }]);
  }, []);

  const refresh = useCallback(async () => {
    const pendingPromise =
      typeof manager.listPendingCompletions === 'function'
        ? manager.listPendingCompletions()
        : Promise.resolve([]);
    const [nextRecords, nextCompletions] = await Promise.all([manager.list(), pendingPromise]);
    setRecords(new Map(nextRecords.map((record) => [record.id, record])));
    setSummaries(
      nextRecords
        .filter((record) => {
          const terminal = ['completed', 'failed', 'stopped', 'interrupted'].includes(
            record.status,
          );
          return (
            !terminal ||
            deferredDismissals.current.has(record.id) ||
            (record.completionSequence ?? 0) > (record.completionDeliveredSequence ?? 0)
          );
        })
        .map(projectAgentSummary)
        .sort((left, right) => {
          const leftDone = ['completed', 'failed', 'stopped', 'interrupted'].includes(left.status);
          const rightDone = ['completed', 'failed', 'stopped', 'interrupted'].includes(
            right.status,
          );
          if (leftDone !== rightDone) return leftDone ? 1 : -1;
          return right.updatedAt - left.updatedAt;
        }),
    );
    for (const notification of nextCompletions) enqueueCompletion(notification);
  }, [enqueueCompletion, manager]);

  useEffect(() => {
    setSummaries([]);
    setRecords(new Map());
    setActivities(new Map());
    setLiveText(new Map());
    setSelectedAgentId(undefined);
    setSurface('main');
    setPendingCompletions([]);
    seenCompletions.current.clear();
    deferredDismissals.current.clear();
    void refresh().catch(() => {});
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === 'agent_status') {
          setSummaries((current) => upsertSummary(current, event.agent));
          return;
        }
        if (event.type === 'agent_activity') {
          setActivities((current) => {
            const next = new Map(current);
            const agentActivities = [...(next.get(event.agentId) ?? [])];
            const index = agentActivities.findIndex(
              (activity) => activity.id === event.activity.id,
            );
            if (index >= 0) agentActivities[index] = event.activity;
            else agentActivities.push(event.activity);
            next.set(event.agentId, agentActivities);
            return next;
          });
          setRecords((current) => {
            const record = current.get(event.agentId);
            if (!record) return current;
            return new Map(current).set(event.agentId, {
              ...record,
              currentActivity: event.activity,
              updatedAt: Math.max(
                record.updatedAt,
                event.activity.finishedAt ?? event.activity.startedAt,
              ),
            });
          });
          setSummaries((current) => {
            const summary = current.find((candidate) => candidate.agentId === event.agentId);
            if (!summary) return current;
            return upsertSummary(current, {
              ...summary,
              currentActivity: event.activity,
              updatedAt: Math.max(
                summary.updatedAt,
                event.activity.finishedAt ?? event.activity.startedAt,
              ),
            });
          });
          return;
        }
        if (event.type === 'agent_update' || event.type === 'agent_start') {
          setRecords((current) => new Map(current).set(event.agent.id, event.agent));
          setSummaries((current) => upsertSummary(current, projectAgentSummary(event.agent)));
          return;
        }
        if (event.type === 'agent_result') {
          setRecords((current) => new Map(current).set(event.agent.id, event.agent));
          setSummaries((current) => upsertSummary(current, projectAgentSummary(event.agent)));
          return;
        }
        if (event.type === 'agent_completion') {
          enqueueCompletion(event.notification);
          return;
        }
        if (event.type === 'agent_message') {
          setRecords((current) => {
            const record = current.get(event.agentId);
            if (!record || record.transcript.some((message) => message.id === event.message.id)) {
              return current;
            }
            return new Map(current).set(event.agentId, {
              ...record,
              transcript: [...record.transcript, event.message],
            });
          });
          return;
        }
        if (event.type === 'agent_text_delta') {
          setLiveText((current) => {
            const next = new Map(current);
            next.set(event.agentId, `${next.get(event.agentId) ?? ''}${event.text}`.slice(-12000));
            return next;
          });
        }
      },
      { snapshot: true },
    );
    manager.setInteractivePermissions(true);
    return () => {
      unsubscribe();
      manager.setInteractivePermissions(false);
    };
  }, [enqueueCompletion, manager, refresh]);

  const pendingPermissions = useMemo(
    () =>
      Array.from(records.values())
        .filter((record) => record.pendingPermission)
        .sort(
          (left, right) =>
            (left.pendingPermission?.createdAt ?? 0) - (right.pendingPermission?.createdAt ?? 0),
        )
        .map((record) => ({
          type: 'agent_permission' as const,
          agentId: record.id,
          request: record.pendingPermission!,
        })),
    [records],
  );
  const pendingQuestions = useMemo(
    () =>
      Array.from(records.values())
        .filter((record) => record.pendingQuestion)
        .sort((left, right) => {
          const age =
            (left.pendingQuestionCreatedAt ?? left.updatedAt) -
            (right.pendingQuestionCreatedAt ?? right.updatedAt);
          return age || left.id.localeCompare(right.id);
        })
        .map((record) => ({ agentId: record.id, request: record.pendingQuestion! })),
    [records],
  );

  const send = useCallback(
    async (message: string) => {
      if (!selectedAgentId) return;
      deferredDismissals.current.delete(selectedAgentId);
      const next = await manager.send(selectedAgentId, message);
      setRecords((current) => new Map(current).set(next.id, next));
      setSummaries((current) => upsertSummary(current, projectAgentSummary(next)));
    },
    [manager, selectedAgentId],
  );

  const stopOrDismiss = useCallback(
    async (agentId?: string) => {
      const targetAgentId = agentId ?? selectedAgentId;
      if (!targetAgentId) return;
      const record = await manager.get(targetAgentId);
      if (!record) return;
      if (['completed', 'failed', 'stopped', 'interrupted'].includes(record.status)) {
        const completionPending =
          (record.completionSequence ?? 0) > (record.completionDeliveredSequence ?? 0);
        if (!completionPending) await manager.dismiss(targetAgentId);
        setRecords((current) => {
          const next = new Map(current);
          if (!completionPending) next.delete(targetAgentId);
          return next;
        });
        setSummaries((current) => current.filter((summary) => summary.agentId !== targetAgentId));
        setSelectedAgentId((current) => (current === targetAgentId ? undefined : current));
        return;
      }
      const next = await manager.stop(targetAgentId);
      setRecords((current) => new Map(current).set(next.id, next));
      setSummaries((current) => current.filter((summary) => summary.agentId !== targetAgentId));
      setSelectedAgentId((current) => (current === targetAgentId ? undefined : current));
    },
    [manager, selectedAgentId],
  );

  const resolvePermission = useCallback(
    async (requestId: string, response: 'allow' | 'deny' | 'always') => {
      const request = pendingPermissions.find(
        (event) => event.type === 'agent_permission' && event.request.id === requestId,
      );
      if (!request || request.type !== 'agent_permission') return;
      const next = await manager.resolvePermission(request.agentId, requestId, response);
      setRecords((current) => new Map(current).set(next.id, next));
    },
    [manager, pendingPermissions],
  );

  const resolveQuestion = useCallback(
    async (agentId: string, response: UserQuestionResponse) => {
      const next = await manager.resolveQuestion(agentId, response);
      setRecords((current) => new Map(current).set(next.id, next));
    },
    [manager],
  );

  const acknowledgeCompletions = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const acknowledged = new Set(ids);
      const items = pendingCompletions.filter((item) => acknowledged.has(item.id));
      if (typeof manager.acknowledgeCompletion === 'function') {
        await Promise.all(
          items.map((item) => manager.acknowledgeCompletion(item.notification.deliveryId)),
        );
      }
      const completedAgentIds = new Set(items.map((item) => item.notification.completion.agentId));
      const heldAgentIds = new Set<string>();
      if (
        surface === 'detail' &&
        selectedAgentId !== undefined &&
        completedAgentIds.has(selectedAgentId)
      ) {
        heldAgentIds.add(selectedAgentId);
        deferredDismissals.current.add(selectedAgentId);
      }
      setSummaries((current) =>
        current.filter(
          (summary) => !completedAgentIds.has(summary.agentId) || heldAgentIds.has(summary.agentId),
        ),
      );
      setSelectedAgentId((current) =>
        current && completedAgentIds.has(current) && !heldAgentIds.has(current)
          ? undefined
          : current,
      );
      setPendingCompletions((current) => current.filter((item) => !acknowledged.has(item.id)));
    },
    [manager, pendingCompletions, selectedAgentId, surface],
  );

  const changeSurface = useCallback((nextSurface: ManagedAgentSurface) => {
    if (nextSurface === 'main' && deferredDismissals.current.size > 0) {
      const dismissed = new Set(deferredDismissals.current);
      deferredDismissals.current.clear();
      setSummaries((current) => current.filter((summary) => !dismissed.has(summary.agentId)));
      setSelectedAgentId((current) => (current && dismissed.has(current) ? undefined : current));
    }
    setSurface(nextSurface);
  }, []);

  return {
    summaries,
    records,
    activities,
    liveText,
    selectedAgentId,
    surface,
    pendingPermissions,
    pendingQuestions,
    pendingCompletions,
    setSurface: changeSurface,
    selectAgent: setSelectedAgentId,
    send,
    stopOrDismiss,
    resolvePermission,
    resolveQuestion,
    acknowledgeCompletions,
    refresh,
  };
}
