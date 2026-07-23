import { setTimeout as wait } from 'node:timers/promises';
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentManager } from '../../agents/manager.js';
import type {
  AgentCompletionNotification,
  AgentRecord,
  AgentRuntimeEvent,
} from '../../agents/types.js';
import type { UserQuestionRequest } from '../../types/tools.js';
import { projectAgentSummary } from '../../agents/projections.js';
import { useManagedAgents, type ManagedAgentState } from './useManagedAgents.js';

afterEach(cleanup);

function question(id: string): UserQuestionRequest {
  return {
    id,
    source: { kind: 'subagent', agentPath: [id] },
    questions: [
      {
        question: `${id}?`,
        header: id,
        options: [{ label: 'Yes', description: 'Continue' }],
        multiSelect: false,
      },
    ],
  };
}

function record(id: string, pendingQuestionCreatedAt: number): AgentRecord {
  return {
    id,
    profile: 'explorer',
    displayName: id,
    profileDescription: 'Explore',
    purpose: id,
    resolvedModel: 'test/model',
    isolation: 'workspace-readonly',
    name: 'explorer',
    role: 'explorer',
    description: 'Explore',
    status: 'waiting_input',
    applicationStatus: 'not_applied',
    prompt: id,
    referencedEvidenceIds: [],
    transcript: [],
    pendingMessages: [],
    pendingQuestion: question(`question-${id}`),
    pendingQuestionCreatedAt,
    createdAt: pendingQuestionCreatedAt,
    updatedAt: pendingQuestionCreatedAt + 100,
  };
}

function completionNotification(
  agentId = 'older',
  status: AgentCompletionNotification['completion']['status'] = 'completed',
  parentSessionId = 'session-1',
): AgentCompletionNotification {
  return {
    deliveryId: `${agentId}:1`,
    sequence: 1,
    parentSessionId,
    completion: {
      agentId,
      displayName: agentId,
      profile: 'explorer',
      status,
      resolvedModel: 'test/model',
      isolation: 'workspace-readonly',
      summary: 'Finished the scan',
      evidenceIds: [],
      createdAt: 10,
      startedAt: 11,
      updatedAt: 30,
      finishedAt: 30,
    },
  };
}

describe('useManagedAgents', () => {
  it('orders pending questions by request age and only unsubscribes on unmount', async () => {
    const records = [record('newer', 20), record('older', 10)];
    let listener: ((event: AgentRuntimeEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const manager = {
      list: vi.fn(async () => records),
      listProfiles: vi.fn(async () => []),
      listPendingCompletions: vi.fn(async () => [completionNotification()]),
      acknowledgeCompletion: vi.fn(async () => {}),
      subscribe: vi.fn((next: (event: AgentRuntimeEvent) => void) => {
        listener = next;
        return unsubscribe;
      }),
      setInteractivePermissions: vi.fn(),
      dispose: vi.fn(),
    } as unknown as AgentManager;
    let latest: ManagedAgentState | undefined;
    function Harness() {
      latest = useManagedAgents(manager);
      return <Text>{latest.pendingQuestions.map((item) => item.agentId).join(',')}</Text>;
    }

    const view = render(<Harness />);
    await vi.waitFor(() => expect(latest?.pendingQuestions).toHaveLength(2));
    expect(latest?.pendingQuestions.map((item) => item.agentId)).toEqual(['older', 'newer']);
    expect(latest?.pendingCompletions).toHaveLength(1);

    listener?.({
      type: 'agent_text_delta',
      agentId: 'older',
      text: 'live',
    });
    await wait(0);
    expect(latest?.liveText.get('older')).toBe('live');

    listener?.({
      type: 'agent_activity',
      agentId: 'older',
      activity: {
        id: 'read-1',
        kind: 'tool',
        label: 'Using Read',
        toolName: 'Read',
        status: 'running',
        startedAt: 25,
      },
    });
    await wait(0);
    expect(latest?.activities.get('older')?.[0]?.toolName).toBe('Read');
    expect(
      latest?.summaries.find((summary) => summary.agentId === 'older')?.currentActivity?.label,
    ).toBe('Using Read');

    listener?.({
      type: 'agent_result',
      agent: {
        ...record('older', 10),
        status: 'completed',
        pendingQuestion: undefined,
        result: 'Finished',
        finishedAt: 40,
        updatedAt: 40,
      },
    });
    await wait(0);
    expect(latest?.summaries.map((summary) => summary.agentId)).toEqual(['newer', 'older']);

    listener?.({
      type: 'agent_result',
      agent: {
        ...record('newer', 20),
        status: 'failed',
        pendingQuestion: undefined,
        error: 'Failed',
        finishedAt: 50,
        updatedAt: 50,
      },
    });
    await wait(0);
    expect(latest?.summaries.map((summary) => summary.agentId)).toEqual(['newer', 'older']);

    listener?.({
      type: 'agent_completion',
      notification: completionNotification('newer', 'failed'),
    });
    await wait(0);

    const completion = {
      type: 'agent_completion' as const,
      notification: completionNotification(),
    };
    listener?.(completion);
    listener?.(completion);
    await wait(0);
    expect(latest?.pendingCompletions).toHaveLength(2);
    expect(latest?.pendingCompletions[0]?.notification).toEqual(completion.notification);

    latest?.selectAgent('older');
    latest?.setSurface('detail');
    await wait(0);
    await latest?.acknowledgeCompletions(latest.pendingCompletions.map((item) => item.id));
    await wait(0);
    expect(latest?.pendingCompletions).toEqual([]);
    expect(latest?.summaries.map((summary) => summary.agentId)).toEqual(['older']);
    expect(latest?.selectedAgentId).toBe('older');
    expect(latest?.surface).toBe('detail');
    expect(manager.acknowledgeCompletion).toHaveBeenCalledWith('older:1');
    expect(manager.acknowledgeCompletion).toHaveBeenCalledWith('newer:1');

    latest?.setSurface('main');
    await wait(0);
    expect(latest?.summaries).toEqual([]);
    expect(latest?.selectedAgentId).toBeUndefined();
    expect(latest?.surface).toBe('main');

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(manager.setInteractivePermissions).toHaveBeenLastCalledWith(false);
    expect(manager.dispose).not.toHaveBeenCalled();
  });

  it('does not restore terminal rows whose parent report was already delivered', async () => {
    const delivered = {
      ...record('done', 10),
      status: 'completed' as const,
      pendingQuestion: undefined,
      result: 'Finished',
      completionSequence: 1,
      completionDeliveredSequence: 1,
      finishedAt: 30,
    };
    const manager = {
      list: vi.fn(async () => [delivered]),
      listPendingCompletions: vi.fn(async () => []),
      subscribe: vi.fn(() => vi.fn()),
      setInteractivePermissions: vi.fn(),
    } as unknown as AgentManager;
    let latest: ManagedAgentState | undefined;
    function Harness() {
      latest = useManagedAgents(manager);
      return <Text>{latest.summaries.length}</Text>;
    }

    const view = render(<Harness />);
    await vi.waitFor(() => expect(manager.list).toHaveBeenCalled());
    expect(latest?.summaries).toEqual([]);
    view.unmount();
  });

  it('shows only agents and completions owned by the active session', async () => {
    const current = {
      ...record('current', 20),
      parentSessionId: 'current-session',
      status: 'completed' as const,
      pendingQuestion: undefined,
      completionSequence: 1,
      completionDeliveredSequence: 0,
      finishedAt: 40,
    };
    const stale = {
      ...record('stale', 10),
      parentSessionId: 'stale-session',
      status: 'interrupted' as const,
      pendingQuestion: undefined,
      completionSequence: 1,
      completionDeliveredSequence: 0,
      finishedAt: 30,
    };
    let listener: ((event: AgentRuntimeEvent) => void) | undefined;
    const manager = {
      list: vi.fn(async () => [stale, current]),
      listPendingCompletions: vi.fn(async () => [
        completionNotification('stale', 'interrupted', 'stale-session'),
        completionNotification('current', 'completed', 'current-session'),
      ]),
      subscribe: vi.fn((next: (event: AgentRuntimeEvent) => void) => {
        listener = next;
        return vi.fn();
      }),
      setInteractivePermissions: vi.fn(),
    } as unknown as AgentManager;
    let latest: ManagedAgentState | undefined;
    function Harness({ sessionId }: { sessionId: string }) {
      latest = useManagedAgents(manager, sessionId);
      return <Text>{latest.summaries.map((summary) => summary.agentId).join(',')}</Text>;
    }

    const view = render(<Harness sessionId="current-session" />);
    await vi.waitFor(() =>
      expect(latest?.summaries.map((item) => item.agentId)).toEqual(['current']),
    );
    expect(Array.from(latest?.records.keys() ?? [])).toEqual(['current']);
    expect(latest?.pendingCompletions.map((item) => item.notification.completion.agentId)).toEqual([
      'current',
    ]);

    listener?.({
      type: 'agent_status',
      agent: projectAgentSummary(stale),
      parentSessionId: stale.parentSessionId,
    });
    listener?.({ type: 'agent_update', agent: stale });
    await wait(0);
    expect(latest?.summaries.map((item) => item.agentId)).toEqual(['current']);

    view.rerender(<Harness sessionId="stale-session" />);
    await vi.waitFor(() =>
      expect(latest?.summaries.map((item) => item.agentId)).toEqual(['stale']),
    );
    expect(Array.from(latest?.records.keys() ?? [])).toEqual(['stale']);
    expect(latest?.pendingCompletions.map((item) => item.notification.completion.agentId)).toEqual([
      'stale',
    ]);
    view.unmount();
  });

  it('returns to main and clears the selected child when the session manager changes', async () => {
    const firstUnsubscribe = vi.fn();
    const firstManager = {
      list: vi.fn(async () => [record('old-child', 10)]),
      listPendingCompletions: vi.fn(async () => []),
      subscribe: vi.fn(() => firstUnsubscribe),
      setInteractivePermissions: vi.fn(),
    } as unknown as AgentManager;
    const secondManager = {
      list: vi.fn(async () => []),
      listPendingCompletions: vi.fn(async () => []),
      subscribe: vi.fn(() => vi.fn()),
      setInteractivePermissions: vi.fn(),
    } as unknown as AgentManager;
    let latest: ManagedAgentState | undefined;
    function Harness({ manager }: { manager: AgentManager }) {
      latest = useManagedAgents(manager);
      return <Text>{latest.surface}</Text>;
    }

    const view = render(<Harness manager={firstManager} />);
    await vi.waitFor(() => expect(latest?.summaries).toHaveLength(1));
    latest?.selectAgent('old-child');
    latest?.setSurface('detail');
    await vi.waitFor(() => expect(latest?.surface).toBe('detail'));

    view.rerender(<Harness manager={secondManager} />);
    await vi.waitFor(() => expect(latest?.surface).toBe('main'));
    expect(latest?.selectedAgentId).toBeUndefined();
    expect(latest?.records.size).toBe(0);
    expect(firstUnsubscribe).toHaveBeenCalledOnce();
  });
});
