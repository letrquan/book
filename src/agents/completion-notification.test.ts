import { describe, expect, it } from 'vitest';
import { buildAgentCompletionMessage } from './completion-notification.js';

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
    expect(result.contextMessage).not.toContain('parent-1');
    expect(result.display).toMatchObject({
      agentId: 'agent-1',
      displayName: 'Atlas',
      durationMs: 60,
    });
  });
});
