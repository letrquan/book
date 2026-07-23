import { describe, expect, it } from 'vitest';
import {
  buildAgentCompletionMessage,
  takeAgentCompletionBatch,
} from './completion-notification.js';
import type { AgentCompletionNotification } from './types.js';

function notification(id: string, summary: string): AgentCompletionNotification {
  return {
    deliveryId: `${id}:1`,
    sequence: 1,
    completion: {
      agentId: id,
      displayName: id,
      profile: 'explorer',
      status: 'completed',
      resolvedModel: 'test/model',
      isolation: 'workspace-readonly',
      summary,
      evidenceIds: [],
      createdAt: 1,
      updatedAt: 2,
    },
  };
}

describe('buildAgentCompletionMessage', () => {
  it('separates compact provider context from the host-facing notification', () => {
    const result = buildAgentCompletionMessage({
      deliveryId: 'agent-1:1',
      sequence: 1,
      parentSessionId: 'parent-1',
      completion: {
        agentId: 'agent-1',
        displayName: 'Atlas',
        profile: 'explorer',
        status: 'completed',
        resolvedModel: 'test/model',
        isolation: 'workspace-readonly',
        summary: 'Found three lifecycle gaps',
        summaryCharacters: 61_000,
        summaryTruncated: true,
        errorCharacters: 0,
        errorTruncated: false,
        evidenceIds: ['evidence-1'],
        createdAt: 10,
        startedAt: 20,
        updatedAt: 80,
        finishedAt: 80,
      },
    });

    expect(result.displayMessage).toBe('Atlas completed: Found three lifecycle gaps');
    expect(result.contextMessage).toContain('<subagent_notification>');
    expect(result.contextMessage).toContain('"agent_id":"agent-1"');
    expect(result.contextMessage).toContain('"delivery_id":"agent-1:1"');
    expect(result.contextMessage).toContain('"summary_characters":61000');
    expect(result.contextMessage).toContain('"summary_truncated":true');
    expect(result.contextMessage).toContain('"error_characters":0');
    expect(result.contextMessage).toContain('"error_truncated":false');
    expect(result.contextMessage).not.toContain('parent-1');
    expect(result.display).toMatchObject({
      deliveryId: 'agent-1:1',
      sequence: 1,
      agentId: 'agent-1',
      displayName: 'Atlas',
      durationMs: 60,
    });
  });

  it('keeps completion batches within the aggregate context budget', () => {
    const notifications = [
      notification('a', 'x'.repeat(40_000)),
      notification('b', 'y'.repeat(40_000)),
    ];
    expect(takeAgentCompletionBatch(notifications)).toEqual([notifications[0]]);
    expect(takeAgentCompletionBatch(notifications, 100_000)).toHaveLength(2);
  });
});
