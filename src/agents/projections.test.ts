import { describe, expect, it } from 'vitest';
import { projectAgentCompletion, projectAgentSummary } from './projections.js';
import type { AgentRecord } from './types.js';

const record = {
  id: 'agent-1',
  name: 'explorer',
  role: 'explorer',
  description: 'Explore',
  status: 'completed',
  applicationStatus: 'not_applied',
  prompt: 'Trace auth',
  result: 'Found it',
  referencedEvidenceIds: ['input-evidence'],
  producedEvidenceIds: ['published-evidence'],
  transcript: [
    { id: 'secret', role: 'assistant', content: 'raw', includeInContext: true, timestamp: 1 },
  ],
  pendingMessages: [],
  createdAt: 1,
  updatedAt: 2,
} as AgentRecord;

describe('managed-agent projections', () => {
  it('omits transcript and prompt from parent-facing output', () => {
    const summary = projectAgentSummary(record);
    const completion = projectAgentCompletion(record);
    expect(summary).not.toHaveProperty('transcript');
    expect(completion).not.toHaveProperty('prompt');
    expect(completion.evidenceIds).toEqual(['published-evidence']);
    expect(summary.finishedAt).toBe(record.updatedAt);
  });

  it('bounds completion text before it enters the parent mailbox', () => {
    const completion = projectAgentCompletion({ ...record, result: 'x'.repeat(3000) });
    expect(completion.summary?.length).toBe(2000);
    expect(completion.summary?.endsWith('...')).toBe(true);
  });
});
