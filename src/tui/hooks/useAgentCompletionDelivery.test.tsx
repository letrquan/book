import { setTimeout as wait } from 'node:timers/promises';
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCompletionNotification } from '../../agents/types.js';
import type { QueuedAgentCompletion } from './useManagedAgents.js';
import { useAgentCompletionDelivery } from './useAgentCompletionDelivery.js';

afterEach(cleanup);

function queued(id: string): QueuedAgentCompletion {
  return {
    id,
    notification: {
      deliveryId: id,
      sequence: 1,
      parentSessionId: 'parent',
      completion: {
        agentId: id,
        displayName: id,
        profile: 'explorer',
        status: 'completed',
        resolvedModel: 'test/model',
        isolation: 'workspace-readonly',
        summary: `${id} done`,
        evidenceIds: [],
        createdAt: 1,
        updatedAt: 2,
      },
    },
  };
}

describe('useAgentCompletionDelivery', () => {
  it('waits while blocked, coalesces pending completions, and acknowledges once', async () => {
    let blocked = true;
    const pending = [queued('a'), queued('b')];
    const deliver = vi.fn(async (_notifications: AgentCompletionNotification[]) => true);
    const acknowledge = vi.fn(async (_ids: string[]) => {});
    function Harness() {
      useAgentCompletionDelivery({
        pending,
        parentSessionId: 'parent',
        blocked,
        deliver,
        acknowledge,
      });
      return <Text>delivery</Text>;
    }

    const view = render(<Harness />);
    await wait(0);
    expect(deliver).not.toHaveBeenCalled();

    blocked = false;
    view.rerender(<Harness />);
    await wait(0);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0][0]).toHaveLength(2);
    expect(acknowledge).toHaveBeenCalledWith(['a', 'b']);

    view.rerender(<Harness />);
    await wait(0);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('keeps completions pending when the parent continuation fails', async () => {
    const pending = [queued('a')];
    const deliver = vi.fn(async () => false);
    const acknowledge = vi.fn(async () => {});
    function Harness() {
      useAgentCompletionDelivery({
        pending,
        parentSessionId: 'parent',
        blocked: false,
        deliver,
        acknowledge,
      });
      return <Text>delivery</Text>;
    }

    render(<Harness />);
    await wait(0);
    expect(deliver).toHaveBeenCalledOnce();
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
